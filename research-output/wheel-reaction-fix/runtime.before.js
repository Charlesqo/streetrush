import { SURFACES } from '../config.js';
import {
  FiveOwnerState,
  VEHICLE_V24_COORDINATE_CONTRACT,
  VEHICLE_V24_VERSION,
  VehicleV24AbortError,
  assertVehicleV24StepInput,
} from './contract.js';
import {
  addVec3,
  clamp,
  deepClone,
  dotVec3,
  finiteDeep,
  scaleVec3,
  vec3,
} from './math.js';
import {
  createTireState,
  effectiveTireRadius,
  solveAcceptedTireContact,
} from './tire.js';
import {
  attachSteeringReactionContext,
  createSteeringState,
  evaluateSteeringReaction,
  prepareSteeringTrial,
} from './steering.js';
import {
  CONTACT_CLASS,
  createSuspensionState,
  solveMappedKcSuspension,
} from './suspension.js';
import {
  POWERTRAIN_CONSTANTS,
  applyBrakeActiveSet,
  createEngineState,
  createGearboxState,
  evaluateBrakeAssists,
  prepareDriverGearboxTrial,
  prepareEngineClutchTrial,
} from './powertrain.js';
import { evaluateAeroWrench } from './aero.js';
import {
  RapierVehicleV24HostAdapter,
  contactForceWorld,
  contactMomentWorld,
} from './rapier-host-adapter.js';

const RESIDUAL_TOLERANCE = 2e-6;
const AGGREGATE_EVALUATION_BUDGET = 720;

const now = () => globalThis.performance?.now?.() ?? Date.now();

function sanitizeDriverInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    steer: clamp(Number.isFinite(source.steer) ? source.steer : 0, -1, 1),
    throttle: clamp(Number.isFinite(source.throttle) ? source.throttle : 0, 0, 1),
    brake: clamp(Number.isFinite(source.brake) ? source.brake : 0, 0, 1),
    handbrake: clamp(Number.isFinite(source.handbrake) ? source.handbrake : 0, 0, 1),
    directionConflict: source.directionConflict === true,
    shiftUp: source.shiftUp === true,
    shiftDown: source.shiftDown === true,
    toggleTransmission: source.toggleTransmission === true,
    driveIntent: Number.isFinite(source.driveIntent) ? clamp(source.driveIntent, -1, 1) : undefined,
  };
}

function initialOwnerStates(config) {
  return {
    engine: createEngineState(config),
    gearbox: createGearboxState(),
    steering: createSteeringState(),
    tires: { corners: Array.from({ length: 4 }, createTireState) },
    mechanics: {
      wheelOmega: [0, 0, 0, 0],
      effectiveRadii: [config.wheelRadius, config.wheelRadius, config.wheelRadius, config.wheelRadius],
      suspension: createSuspensionState(config),
    },
  };
}

function updateContactRadius(contact, radius, config) {
  if (!contact.inContact) return { ...contact, compression: 0 };
  const suspensionLength = contact.rawToi - radius;
  return {
    ...contact,
    compression: clamp(
      config.suspension.restLength - suspensionLength,
      0,
      config.suspension.travel,
    ),
    gap: Math.max(0, suspensionLength - config.suspension.restLength),
  };
}

function sumBodyTorqueFromHubs(contacts, powertrain, brakeResults) {
  let torque = vec3();
  for (let index = 0; index < contacts.length; index += 1) {
    const contact = contacts[index];
    if (!contact.inContact) continue;
    const brakeTorqueSigned = brakeResults[index].impulse / powertrain.dt;
    const wheelActuatorTorque = powertrain.wheelDriveTorque[index] + brakeTorqueSigned;
    // Oracle +wheel-omega maps to StreetRush's physical-right axial direction.
    // Chassis reaction is therefore along the physical-left tangent.
    torque = addVec3(torque, scaleVec3(contact.lateral, wheelActuatorTorque));
  }
  return torque;
}

export class VehicleV24Runtime {
  constructor({ RAPIER, world, body, track, config, wheels, options = {} }) {
    this.config = config;
    this.options = options;
    this.host = new RapierVehicleV24HostAdapter({ RAPIER, world, body, track, config, wheels });
    this.ownerState = new FiveOwnerState(initialOwnerStates(config));
    this.stepIndex = 0;
    this.lastReport = null;
  }

  reset() {
    this.host.resetVehicleForces();
    this.ownerState.replaceAll(initialOwnerStates(this.config));
    this.stepIndex = 0;
    this.lastReport = null;
  }

  getStateSnapshot() {
    return this.ownerState.snapshot();
  }

  getLastReport() {
    return this.lastReport ? deepClone(this.lastReport) : null;
  }

  dispose() {
    this.host.dispose();
  }

  step({ input, dt, applyForces, mode }) {
    const startedAt = now();
    const activeInput = sanitizeDriverInput(input);
    assertVehicleV24StepInput({ input: activeInput, dt });
    this.stepIndex += 1;
    this.host.resetCounters();
    if (applyForces) this.host.resetVehicleForces();
    const transaction = this.ownerState.begin();
    let report;
    let solverAudit = null;
    try {
      const engineState = transaction.snapshot('engine');
      const gearboxState = transaction.snapshot('gearbox');
      const steeringState = transaction.snapshot('steering');
      const tireStates = transaction.snapshot('tires');
      const mechanicsState = transaction.snapshot('mechanics');
      const bodySample = this.host.sampleBody();
      if (!finiteDeep({
        translation: bodySample.translation,
        rotation: bodySample.rotation,
        linvel: bodySample.linvel,
        angvel: bodySample.angvel,
        worldCom: bodySample.worldCom,
        mass: bodySample.mass,
        invMass: bodySample.invMass,
        inertia: bodySample.effectiveWorldInvInertia,
        axes: bodySample.axes,
      })) throw new Error('Rapier body sample contains a non-finite value');
      const signedSpeed = dotVec3(bodySample.linvel, bodySample.axes.forward);
      const oracleYawRate = -dotVec3(bodySample.angvel, bodySample.axes.up);

      let steeringTrial = prepareSteeringTrial({
        state: steeringState,
        streetRushCommand: activeInput.steer,
        speed: Math.abs(signedSpeed),
        dt,
        maximumAngle: this.config.steer,
        wheelbase: this.config.wheelbase,
        trackWidth: this.config.trackWidth,
        leftJounce: mechanicsState.suspension.corners[0].jounce,
        rightJounce: mechanicsState.suspension.corners[1].jounce,
      });
      let contacts = mechanicsState.effectiveRadii.map((radius, index) => this.host.queryWheel({
        wheelIndex: index,
        streetRushSteerAngle: steeringTrial.streetRushWheelAngles[index],
        effectiveRadius: radius,
        bodySample,
      }));
      let suspensionTrial;
      let effectiveRadii = [...mechanicsState.effectiveRadii];
      for (let iteration = 0; iteration < 3; iteration += 1) {
        suspensionTrial = solveMappedKcSuspension({
          previousState: mechanicsState.suspension,
          contacts,
          steeringTrial,
          config: this.config,
          dt,
        });
        effectiveRadii = suspensionTrial.corners.map((corner, index) => effectiveTireRadius({
          unloadedRadius: this.config.wheelRadius,
          normalLoad: corner.normalLoad,
          omega: mechanicsState.wheelOmega[index],
        }));
        steeringTrial = prepareSteeringTrial({
          state: steeringState,
          streetRushCommand: activeInput.steer,
          speed: Math.abs(signedSpeed),
          dt,
          maximumAngle: this.config.steer,
          wheelbase: this.config.wheelbase,
          trackWidth: this.config.trackWidth,
          leftJounce: suspensionTrial.corners[0].jounce,
          rightJounce: suspensionTrial.corners[1].jounce,
        });
        contacts = contacts.map((contact, index) => {
          const withRadius = updateContactRadius(contact, effectiveRadii[index], this.config);
          const streetAngle = steeringTrial.streetRushWheelAngles[index]
            - suspensionTrial.corners[index].toe;
          return this.host.reframeContact(withRadius, streetAngle, bodySample);
        });
      }
      suspensionTrial = solveMappedKcSuspension({
        previousState: mechanicsState.suspension,
        contacts,
        steeringTrial,
        config: this.config,
        dt,
      });
      effectiveRadii = suspensionTrial.corners.map((corner, index) => effectiveTireRadius({
        unloadedRadius: this.config.wheelRadius,
        normalLoad: corner.normalLoad,
        omega: mechanicsState.wheelOmega[index],
      }));

      const gearboxTrial = prepareDriverGearboxTrial({
        state: gearboxState,
        input: activeInput,
        signedSpeed,
        engineRpm: engineState.omega * POWERTRAIN_CONSTANTS.rpmPerRadS,
        config: this.config,
        dt,
      });
      const drivenWheels = this.host.wheels.map((wheel) => wheel.driven);
      const assists = evaluateBrakeAssists({
        serviceBrake: gearboxTrial.serviceBrake,
        parkingBrake: gearboxTrial.parkingBrake,
        bodyLongSpeed: signedSpeed,
        oracleYawRate,
        steeringCurvature: steeringTrial.curvature,
        wheelOmega: mechanicsState.wheelOmega,
        effectiveRadii,
        drivenWheels,
  groundedCount: suspensionTrial.corners.filter(
    (corner) => corner.mode === CONTACT_CLASS.CONTACT,
  ).length,
  normalLoads: suspensionTrial.corners.map((corner) => corner.normalLoad),
  steerCommand: activeInput.steer,
        config: this.config,
  });
      const powertrain = prepareEngineClutchTrial({
        // User-requested gameplay policy: forced downshifts may mechanically
        // over-rev the engine. Report the extension without aborting the frame.
        allowMechanicalOverrev: true,
        engineState,
        gearboxTrial,
        wheelOmega: mechanicsState.wheelOmega,
        bodyLongSpeed: signedSpeed,
        assists,
        config: this.config,
        dt,
      });
      powertrain.dt = dt;

      const tireOutputs = [];
      let aggregateEvaluations = 0;
      for (let index = 0; index < 4; index += 1) {
        const contact = contacts[index];
        const corner = suspensionTrial.corners[index];
        const hasNormalAuthority = corner.mode === CONTACT_CLASS.CONTACT && corner.normalLoad > 0;
        const delassus = hasNormalAuthority
          ? this.host.contactDelassus(contact, effectiveRadii[index], POWERTRAIN_CONSTANTS.wheelInertia)
          : [[1, 0], [0, 1]];
        const surfaceGrip = SURFACES[contact.surface]?.grip ?? 1;
        const tire = solveAcceptedTireContact({
          previousState: tireStates.corners[index],
          inContact: hasNormalAuthority,
          normalLoad: corner.normalLoad,
          velocityX: contact.velocityX,
          velocityY: contact.velocityY,
          omega: powertrain.predictedWheelOmega[index],
          camber: corner.camber,
          muScale: this.config.tire.mu * surfaceGrip,
          dt,
          unloadedRadius: this.config.wheelRadius,
          delassus,
        });
        aggregateEvaluations += tire.solver.evaluations;
        tireOutputs.push(tire);
      }
      if (aggregateEvaluations > AGGREGATE_EVALUATION_BUDGET) {
        solverAudit = {
          scaledResidual: Math.max(...tireOutputs.map((output) => output.scaledResidual)),
          tolerance: this.options.residualTolerance ?? RESIDUAL_TOLERANCE,
          residualComponents: {
            tire: Math.max(...tireOutputs.map((output) => output.scaledResidual)),
            tireByCorner: tireOutputs.map((output) => output.scaledResidual),
          },
          aggregateEvaluations,
          aggregateBudget: AGGREGATE_EVALUATION_BUDGET,
          methods: tireOutputs.map((tire) => tire.solver.method),
          tireDiagnostics: tireOutputs.map((tire) => ({
            impulse: [...tire.impulse],
            uFree: [tire.rawSlipX, tire.rawSlipY],
            residual: tire.solver.residual ? [...tire.solver.residual] : [0, 0],
            delassus: tire.solver.delassus?.map((row) => [...row]) ?? null,
            evaluations: tire.solver.evaluations,
          })),
          activeSet: { tires: tireOutputs.map((output) => output.activeSet) },
        };
        throw new Error(`v2.4 aggregate evaluation budget exceeded: ${aggregateEvaluations}`);
      }

      const brakeResults = [];
      const wheelOmega = [];
      for (let index = 0; index < 4; index += 1) {
        const tire = tireOutputs[index];
        const omegaAfterContact = powertrain.predictedWheelOmega[index]
          + tire.wheelContactTorque / POWERTRAIN_CONSTANTS.wheelInertia * dt;
        const brake = applyBrakeActiveSet({
          omega: omegaAfterContact,
          capacityTorque: assists.totalBrakeCapacity[index],
          inertia: POWERTRAIN_CONSTANTS.wheelInertia,
          dt,
        });
        brakeResults.push(brake);
        wheelOmega.push(clamp(brake.omega, -420, 420));
      }

      const leftLoad = tireOutputs[0];
      const rightLoad = tireOutputs[1];
      const reactionContext = attachSteeringReactionContext(steeringTrial, {
        maximumAngle: this.config.steer,
        wheelbase: this.config.wheelbase,
        trackWidth: this.config.trackWidth,
        leftJounce: suspensionTrial.corners[0].jounce,
        rightJounce: suspensionTrial.corners[1].jounce,
      });
      const steeringReaction = evaluateSteeringReaction({
        trial: reactionContext,
        leftLoad: {
          forceX: leftLoad.forceX,
          forceY: leftLoad.forceY,
          momentZ: leftLoad.momentZ,
          mechanicalTrail: leftLoad.pneumaticTrail ?? 0,
        },
        rightLoad: {
          forceX: rightLoad.forceX,
          forceY: rightLoad.forceY,
          momentZ: rightLoad.momentZ,
          mechanicalTrail: rightLoad.pneumaticTrail ?? 0,
        },
        dt,
      });

      const tireResidual = Math.max(...tireOutputs.map((output) => output.scaledResidual));
      const clutchResidual = powertrain.residual / powertrain.residualScale;
      const brakeResidual = Math.max(...brakeResults.map((result) => result.residual))
        / Math.max(1, this.config.brakeTorque * dt);
      const normalResidual = suspensionTrial.complementarityResidual
        / Math.max(1, this.config.mass * 9.81);
      const scaledResidual = Math.max(tireResidual, clutchResidual, brakeResidual, normalResidual);
      const activeSet = {
        clutch: powertrain.clutchRegime,
        brakes: brakeResults.map((result) => result.regime),
        tires: tireOutputs.map((output) => output.activeSet),
        normal: suspensionTrial.corners.map((corner) => corner.mode),
      };
      solverAudit = {
        scaledResidual,
        tolerance: this.options.residualTolerance ?? RESIDUAL_TOLERANCE,
        residualComponents: {
          tire: tireResidual,
          tireByCorner: tireOutputs.map((output) => output.scaledResidual),
          clutch: clutchResidual,
          brake: brakeResidual,
          normal: normalResidual,
        },
        brakeDiagnostics: brakeResults.map((result, index) => ({
          regime: result.regime,
          omegaBefore: powertrain.predictedWheelOmega[index]
            + tireOutputs[index].wheelContactTorque / POWERTRAIN_CONSTANTS.wheelInertia * dt,
          omegaAfter: wheelOmega[index],
          impulse: result.impulse,
          appliedTorque: result.appliedTorque,
          serviceCapacity: assists.serviceCapacity[index],
          parkingCapacity: assists.parkingCapacity[index],
          totalCapacity: assists.totalBrakeCapacity[index],
        })),
        aggregateEvaluations,
        aggregateBudget: AGGREGATE_EVALUATION_BUDGET,
        methods: tireOutputs.map((tire) => tire.solver.method),
        tireDiagnostics: tireOutputs.map((tire) => ({
          impulse: [...tire.impulse],
          uFree: [tire.rawSlipX, tire.rawSlipY],
          residual: tire.solver.residual ? [...tire.solver.residual] : [0, 0],
          delassus: tire.solver.delassus?.map((row) => [...row]) ?? null,
          evaluations: tire.solver.evaluations,
        })),
        // Read-only per-step observations for the real-car straight-line recorder.
        geometryDiagnostics: contacts.map((contact, index) => ({
          wheelIndex: index,
          jounce: suspensionTrial.corners[index].jounce,
          camber: suspensionTrial.corners[index].camber,
          toe: suspensionTrial.corners[index].toe,
          steeringAngle: steeringTrial.streetRushWheelAngles[index],
          forward: deepClone(contact.forward),
          lateral: deepClone(contact.lateral),
          velocityX: contact.velocityX,
          velocityY: contact.velocityY,
        })),
        assistDiagnostics: {
          absModulation: [...assists.absModulation],
          wheelSlip: [...assists.wheelSlip],
      driverServiceCapacity: [...assists.driverServiceCapacity],
      serviceBrakeFrontShare: assists.serviceBrakeFrontShare,
      serviceBrakeFrontLoadShare: assists.serviceBrakeFrontLoadShare,
      serviceBrakeSpeedAuthority: assists.serviceBrakeSpeedAuthority,
      tcsBrakeCapacity: [...assists.tcsBrakeCapacity],
      tcsBrakeSpeedAuthority: assists.tcsBrakeSpeedAuthority,
          escBrakeCapacity: [...assists.escBrakeCapacity],
        desiredYaw: assists.desiredYaw,
        yawError: assists.yawError,
        escEligible: assists.escEligible,
        escSpeedAuthority: assists.escSpeedAuthority,
        escSteerAuthority: assists.escSteerAuthority,
        escBrakeAuthority: assists.escBrakeAuthority,
        escManeuverAuthority: assists.escManeuverAuthority,
        escYawDeadband: assists.escYawDeadband,
        },
        activeSet,
      };

      transaction.stage('engine', powertrain.nextState);
      transaction.stage('gearbox', gearboxTrial.nextState);
      transaction.stage('steering', steeringReaction.nextState);
      transaction.stage('tires', { corners: tireOutputs.map((output) => output.nextState) });
      transaction.stage('mechanics', {
        wheelOmega,
        effectiveRadii: tireOutputs.map((output) => output.effectiveRadius),
        suspension: suspensionTrial.nextState,
      });
      transaction.preflight({
        scaledResidual,
        tolerance: this.options.residualTolerance ?? RESIDUAL_TOLERANCE,
        activeSet,
      });

      const aero = evaluateAeroWrench({
        bodySample,
        axes: bodySample.axes,
        config: this.config,
        asset: this.options.aeroAsset,
      });
    const hubReactionTorque = sumBodyTorqueFromHubs(contacts, powertrain, brakeResults);
      const wrenchBatch = {
        contacts: contacts.map((contact, index) => ({
          wheelIndex: index,
          point: contact.point,
          groundBody: contact.groundBody,
          forceWorld: contactForceWorld(
            contact,
            tireOutputs[index],
            suspensionTrial.corners[index].normalLoad,
          ),
          momentWorld: contactMomentWorld(contact, tireOutputs[index]),
        })).filter((_, index) => suspensionTrial.corners[index].mode === CONTACT_CLASS.CONTACT),
        bodyForce: aero.forceWorld,
        bodyTorque: addVec3(aero.momentWorldAtCom, hubReactionTorque),
      };
      let actionReaction = [];
      const transactionAudit = transaction.commit({
        applyHost: applyForces
          ? () => { actionReaction = this.host.applyWrenchBatch(wrenchBatch); }
          : undefined,
        rollbackHost: applyForces ? () => this.host.rollbackAppliedBatch() : undefined,
        faultInjector: this.options.faultInjector,
      });

      const groundedCount = suspensionTrial.corners.filter((corner) => (
        corner.mode === CONTACT_CLASS.CONTACT
      )).length;
      const averageSurface = contacts.find((contact, index) => (
        suspensionTrial.corners[index].mode === CONTACT_CLASS.CONTACT
      ))?.surface ?? 'asphalt';
      const output = {
        signedSpeed,
        speedKmh: Math.abs(signedSpeed) * 3.6,
        engineRpm: powertrain.rpm,
        engineLoad: powertrain.effectiveLoad,
        gear: Number.parseInt(gearboxTrial.nextState.selectedGear, 10) || 1,
        reverse: gearboxTrial.nextState.direction === 'REVERSE',
  transmissionMode: gearboxTrial.nextState.transmissionMode,
  steerAngle: steeringTrial.streetRushVirtualAngle,
  steeringControlPolicy: steeringTrial.controlPolicy,
  steeringSpeedAuthority: steeringTrial.speedAuthority,
  driveIntent: Number.isFinite(activeInput.driveIntent) ? Math.sign(activeInput.driveIntent) : 0,
  throttle: gearboxTrial.driveThrottle,
        brake: gearboxTrial.serviceBrake,
        handbrake: gearboxTrial.parkingBrake,
        absActive: assists.absActive,
        tcsActive: assists.tcsActive,
        stabilityActive: assists.escActive,
        surface: averageSurface,
        groundedCount,
        wheelOmega,
        wheels: contacts.map((contact, index) => ({
          grounded: suspensionTrial.corners[index].mode === CONTACT_CLASS.CONTACT,
          load: suspensionTrial.corners[index].normalLoad,
          suspension: suspensionTrial.corners[index].compression,
          slipRatio: tireOutputs[index].observableKappa,
          slipAngle: tireOutputs[index].observableAlpha,
          slipPower: tireOutputs[index].grossContactLoss / 10000,
          surface: contact.surface,
          contactPoint: deepClone(contact.point),
          contactNormal: deepClone(contact.normal),
          groundVelocity: deepClone(contact.groundVelocity),
          regime: tireOutputs[index].regime,
        })),
  powertrain: {
    engineDomainStatus: powertrain.engineDomainStatus,
    driveTorqueRequestedNm: Math.abs(powertrain.freeTorque),
    driveTorqueAppliedNm: powertrain.wheelDriveTorque.reduce((sum, value) => sum + Math.abs(value), 0),
    wheelDriveTorqueRequestedNm: powertrain.wheelDriveTorqueRequested
      .reduce((sum, value) => sum + Math.abs(value), 0),
    wheelDriveTorqueAppliedNm: powertrain.wheelDriveTorque
      .reduce((sum, value) => sum + Math.abs(value), 0),
          serviceBrakeTorqueRequestedNm: gearboxTrial.serviceBrake * this.config.brakeTorque,
    serviceBrakeTorqueAppliedNm: brakeResults.reduce((sum, result, index) => {
      const share = assists.totalBrakeCapacity[index] > 0
        ? assists.serviceCapacity[index] / assists.totalBrakeCapacity[index]
        : 0;
      return sum + result.appliedTorque * share;
    }, 0),
    driverServiceBrakeTorqueRequestedNm: assists.driverServiceCapacity
      .reduce((sum, value) => sum + value, 0),
    driverServiceBrakeTorqueAppliedNm: brakeResults.reduce((sum, result, index) => {
      const driverCapacity = Math.min(
        assists.driverServiceCapacity[index],
        assists.serviceRequestCapacity[index],
      ) * assists.absModulation[index];
      const share = assists.totalBrakeCapacity[index] > 0
        ? driverCapacity / assists.totalBrakeCapacity[index]
        : 0;
      return sum + result.appliedTorque * share;
    }, 0),
    assistBrakeTorqueRequestedNm: assists.serviceRequestCapacity.reduce((sum, value, index) => (
      sum + Math.max(0, value - assists.driverServiceCapacity[index])
    ), 0),
    assistBrakeTorqueAppliedNm: brakeResults.reduce((sum, result, index) => {
      const driverCapacity = Math.min(
        assists.driverServiceCapacity[index],
        assists.serviceRequestCapacity[index],
      ) * assists.absModulation[index];
      const assistCapacity = Math.max(0, assists.serviceCapacity[index] - driverCapacity);
      const share = assists.totalBrakeCapacity[index] > 0
        ? assistCapacity / assists.totalBrakeCapacity[index]
        : 0;
      return sum + result.appliedTorque * share;
    }, 0),
        handbrakeTorqueRequestedNm: gearboxTrial.parkingBrake * this.config.brakeTorque * 1.44,
        handbrakeTorqueAppliedNm: brakeResults.reduce((sum, result, index) => {
          const share = assists.totalBrakeCapacity[index] > 0
            ? assists.parkingCapacity[index] / assists.totalBrakeCapacity[index]
            : 0;
          return sum + result.appliedTorque * share;
        }, 0),
      },
      };

      report = {
        schema: 'streetrush.vehicle-v24.step.v1',
        version: VEHICLE_V24_VERSION,
        mode,
        stepIndex: this.stepIndex,
        status: 'COMMITTED',
        forcesApplied: applyForces,
        authority: {
          world6Dof: 'RAPIER',
          vehicleForceState: applyForces ? 'V24' : 'LEGACY',
          legacyForceCalls: applyForces ? 0 : 1,
          v24ForceCalls: applyForces ? 1 : 0,
        },
        coordinates: VEHICLE_V24_COORDINATE_CONTRACT,
        contacts: contacts.map((contact) => ({
          inContact: contact.inContact,
          point: deepClone(contact.point),
          normal: deepClone(contact.normal),
          groundVelocity: deepClone(contact.groundVelocity),
          normalSource: contact.normalSource,
          colliderHandle: contact.collider?.handle ?? null,
        })),
        solver: deepClone(solverAudit),
        transaction: transactionAudit,
        actionReaction,
        aero: {
          backend: aero.backend,
          coefficients: aero.coefficients,
          forceBodyOracle: aero.forceBodyOracle,
          momentBodyOracle: aero.momentBodyOracle,
        },
        hostCounters: deepClone(this.host.counters),
        output: deepClone(output),
        elapsedMs: now() - startedAt,
      };
      this.lastReport = report;
      return { output, report: deepClone(report) };
    } catch (error) {
      const transactionAudit = transaction.abort(error);
      if (applyForces) this.host.rollbackAppliedBatch();
      report = {
        schema: 'streetrush.vehicle-v24.step.v1',
        version: VEHICLE_V24_VERSION,
        mode,
        stepIndex: this.stepIndex,
        status: 'ABORTED',
        forcesApplied: false,
        authority: {
          world6Dof: 'RAPIER',
          vehicleForceState: applyForces ? 'V24_ABORTED' : 'LEGACY',
          legacyForceCalls: 0,
          v24ForceCalls: 0,
          fallbackUsed: false,
        },
        transaction: transactionAudit,
        solver: solverAudit ? deepClone(solverAudit) : null,
        error: { name: error.name, message: error.message },
        elapsedMs: now() - startedAt,
      };
      this.lastReport = report;
      throw new VehicleV24AbortError(
        `StreetRush v2.4 ${mode} step aborted: ${error.message}`,
        deepClone(report),
        error,
      );
    }
  }
}
