import assert from 'node:assert/strict';
import fs from 'node:fs';

import { CARS, FIXED_DT, SURFACES } from '../src/config.js';
import { VehicleV24AbortError } from '../src/vehicle-v24/index.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  runFor,
  settleVehicle,
  zeroInput,
} from './physics-harness.mjs';

let checks = 0;
const check = (condition, message) => {
  assert.ok(condition, message);
  checks += 1;
};
const vectorMagnitude = (value) => Math.hypot(value.x, value.y, value.z);
const addVector = (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const subtractVector = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const crossVector = (a, b) => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

function checkVector(actual, expected, tolerance, message) {
  check(
    vectorMagnitude(subtractVector(actual, expected)) <= tolerance,
    `${message}: ${JSON.stringify({ actual, expected })}`,
  );
}

function instrumentLegacyForcePath(vehicle) {
  const original = vehicle.fixedUpdateLegacy.bind(vehicle);
  let calls = 0;
  vehicle.fixedUpdateLegacy = (...args) => {
    calls += 1;
    return original(...args);
  };
  return () => calls;
}

const results = {
  schema: 'streetrush.vehicle-v24.runtime-acceptance.v1',
  mode: 'v24-active',
  fixedHz: Math.round(1 / FIXED_DT),
};

{
  const rig = createVehicleRig(CARS[0], { vehiclePhysicsMode: 'v24-active' });
  try {
    settleVehicle(rig, 2);
    const previousSigns = [0, 0, 0, 0];
    const signFlips = [0, 0, 0, 0];
    let minimumSignedSpeedKmh = Number.POSITIVE_INFINITY;
    const parkingInput = zeroInput({
      brake: 1,
      handbrake: 1,
      driveIntent: -1,
      directionConflict: false,
    });
    runFor(rig, 2, parkingInput, () => {
      minimumSignedSpeedKmh = Math.min(minimumSignedSpeedKmh, rig.vehicle.telemetry.signedSpeedKmh);
      rig.vehicle.wheels.forEach((wheel, index) => {
        const sign = Math.abs(wheel.omega) > 1e-7 ? Math.sign(wheel.omega) : 0;
        if (sign !== 0 && previousSigns[index] !== 0 && sign !== previousSigns[index]) signFlips[index] += 1;
        if (sign !== 0) previousSigns[index] = sign;
      });
    });
    const report = rig.vehicle.getVehiclePhysicsReport();
    check(report.status === 'COMMITTED', 'parking step did not commit');
    check(rig.vehicle.telemetry.speedKmh < 0.02, 'service plus parking brake did not hold low speed');
    check(minimumSignedSpeedKmh > -0.02, 'parking interlock allowed reverse creep');
    check(rig.vehicle.reverse === false, 'parking interlock selected reverse');
    check(rig.vehicle.telemetry.brake === 1, 'front service brake was released while parking');
    check(rig.vehicle.telemetry.handbrake === 1, 'parking brake command was not retained');
    check(report.solver.activeSet.brakes.every((state) => state === 'LOCKED'), 'all four brake active-sets must lock at rest');
    check(rig.vehicle.wheels.every((wheel) => wheel.omega === 0), 'locked wheels retained angular velocity');
    check(signFlips.every((count) => count === 0), 'low-speed braking crossed wheel-speed zero');
    results.lowSpeedParking = {
      speedKmh: rig.vehicle.telemetry.speedKmh,
      minimumSignedSpeedKmh,
      wheelOmega: rig.vehicle.wheels.map((wheel) => wheel.omega),
      brakeActiveSet: report.solver.activeSet.brakes,
      signFlips,
      reverse: rig.vehicle.reverse,
    };
  } finally {
    destroyVehicleRig(rig);
  }
}

{
  const rig = createVehicleRig(CARS[0], { vehiclePhysicsMode: 'v24-active' });
  try {
    settleVehicle(rig, 2);
    runFor(rig, 3, zeroInput({ throttle: 1, driveIntent: 1 }));
    const launchSpeedKmh = rig.vehicle.telemetry.signedSpeedKmh;
    check(launchSpeedKmh > 25, 'v2.4 launch did not establish the normal-braking test speed');
    const previousSigns = rig.vehicle.wheels.map((wheel) => Math.sign(wheel.omega));
    const signFlipsBeforeStop = [0, 0, 0, 0];
    const brakeRegimesByWheel = Array.from({ length: 4 }, () => new Set());
    let maximumAppliedServiceBrakeTorque = 0;
    let movingWheelAlwaysReceivedBrakeTorque = true;
    let brakeImpulseNeverCrossedWheelZero = true;
    let serviceCapacityStayedPositive = true;
    let parkingCapacityStayedZero = true;
    // Test the service actuator independently from GTA-style S/reverse intent.
    // A sustained reverse request may legitimately engage reverse once the car stops;
    // it must not encode the old idle-creep-dependent stopping time as an expectation.
    const serviceBrakeInput = zeroInput({ brake: 1, driveIntent: 0 });
    runFor(rig, 3, serviceBrakeInput, () => {
      const report = rig.vehicle.getVehiclePhysicsReport();
      const diagnostics = report.solver.brakeDiagnostics;
      maximumAppliedServiceBrakeTorque = Math.max(
        maximumAppliedServiceBrakeTorque,
        report.output.powertrain.serviceBrakeTorqueAppliedNm,
      );
      diagnostics.forEach((diagnostic, index) => {
        brakeRegimesByWheel[index].add(diagnostic.regime);
        serviceCapacityStayedPositive &&= diagnostic.serviceCapacity > 0;
        parkingCapacityStayedZero &&= diagnostic.parkingCapacity === 0;
        if (Math.abs(diagnostic.omegaBefore) > 1e-7) {
          movingWheelAlwaysReceivedBrakeTorque &&= diagnostic.appliedTorque > 0;
          brakeImpulseNeverCrossedWheelZero &&= diagnostic.omegaAfter === 0
            || Math.sign(diagnostic.omegaAfter) === Math.sign(diagnostic.omegaBefore);
        }
      });
      rig.vehicle.wheels.forEach((wheel, index) => {
        const sign = Math.abs(wheel.omega) > 1e-7 ? Math.sign(wheel.omega) : 0;
        if (sign !== 0 && previousSigns[index] !== 0 && sign !== previousSigns[index]) {
          signFlipsBeforeStop[index] += 1;
        }
        if (sign !== 0) previousSigns[index] = sign;
      });
    });
    const brakedSpeedKmh = rig.vehicle.telemetry.signedSpeedKmh;
    check(Math.abs(brakedSpeedKmh) < 0.05, 'independent service braking did not bring the car to rest');
    check(rig.vehicle.reverse === false, 'service braking without reverse intent selected reverse');
    check(rig.vehicle.telemetry.brake === 1, 'normal braking lost service-brake authority');
    check(signFlipsBeforeStop.every((count) => count === 0), 'normal braking flipped wheel speed before stopping');
    check(
      brakeRegimesByWheel.every((regimes) => regimes.size > 0 && !regimes.has('RELEASED')),
      'normal braking left a wheel in the RELEASED active-set',
    );
    check(serviceCapacityStayedPositive, 'normal braking did not assign service-brake capacity to every wheel');
    check(parkingCapacityStayedZero, 'normal service braking incorrectly consumed parking-brake capacity');
    check(movingWheelAlwaysReceivedBrakeTorque, 'a rotating wheel received no actual brake torque');
    check(brakeImpulseNeverCrossedWheelZero, 'brake impulse crossed wheel-speed zero instead of locking');
    check(maximumAppliedServiceBrakeTorque > 100, 'normal braking applied no material service-brake torque');

    const reverseRequest = zeroInput({ brake: 1, driveIntent: -1 });
    let reverseEngagedAt = null;
    let reverseEngagementSpeedKmh = null;
    runFor(rig, 4.5, reverseRequest, ({ elapsed }) => {
      if (rig.vehicle.reverse && reverseEngagedAt === null) {
        reverseEngagedAt = 3 + elapsed;
        reverseEngagementSpeedKmh = rig.vehicle.telemetry.signedSpeedKmh;
      }
    });
    check(reverseEngagedAt !== null, 'deliberate reverse request never engaged reverse');
    check(Math.abs(reverseEngagementSpeedKmh) < 1, 'reverse engaged before the driveline was nearly stationary');
    check(rig.vehicle.telemetry.signedSpeedKmh < -5, 'reverse engagement did not produce negative StreetRush signed speed');
    check(rig.vehicle.reverse === true, 'reverse state did not remain authoritative after engagement');
    results.brakingAndReverse = {
      launchSpeedKmh,
      speedAfterThreeSecondsBrakingKmh: brakedSpeedKmh,
      wheelSignFlipsBeforeStop: signFlipsBeforeStop,
      brakeActiveSetsByWheel: brakeRegimesByWheel.map((regimes) => [...regimes].sort()),
      maximumAppliedServiceBrakeTorque,
      reverseEngagedAtSeconds: reverseEngagedAt,
      reverseEngagementSpeedKmh,
      finalSignedSpeedKmh: rig.vehicle.telemetry.signedSpeedKmh,
    };
  } finally {
    destroyVehicleRig(rig);
  }
}

{
  const active = createVehicleRig(CARS[0], { vehiclePhysicsMode: 'v24-active' });
  try {
    active.world.step();
    const legacyCalls = instrumentLegacyForcePath(active.vehicle);
    const host = active.vehicle.vehicleV24.host;
    const originalApplyWrenchBatch = host.applyWrenchBatch.bind(host);
    let committedBatch = null;
    host.applyWrenchBatch = (batch) => {
      committedBatch = batch;
      return originalApplyWrenchBatch(batch);
    };
    active.vehicle.fixedUpdate(zeroInput(), false, FIXED_DT);
    const report = active.vehicle.getVehiclePhysicsReport();
    check(legacyCalls() === 0, 'active mode called the legacy force path');
    check(report.authority.vehicleForceState === 'V24', 'active report did not assign force authority to v2.4');
    check(report.authority.legacyForceCalls === 0, 'active report claimed a legacy force write');
    check(report.authority.v24ForceCalls === 1, 'active report did not record exactly one v2.4 force batch');
    check(report.forcesApplied === true, 'active runtime did not apply its Rapier wrench');
    check(committedBatch?.contacts.length === 4, 'active runtime did not commit one four-contact wrench batch');
    const expectedForce = committedBatch.contacts.reduce(
      (sum, contact) => addVector(sum, contact.forceWorld),
      { ...committedBatch.bodyForce },
    );
    const worldCom = active.vehicle.body.worldCom();
    const expectedTorque = committedBatch.contacts.reduce(
      (sum, contact) => addVector(
        sum,
        addVector(
          crossVector(subtractVector(contact.point, worldCom), contact.forceWorld),
          contact.momentWorld,
        ),
      ),
      { ...committedBatch.bodyTorque },
    );
    check(
      report.hostCounters.bodyForceWrites === committedBatch.contacts.length + 1,
      'active host force-write count differs from the committed batch',
    );
    check(
      report.hostCounters.bodyTorqueWrites === committedBatch.contacts.length + 1,
      'active host torque-write count differs from the committed batch',
    );
    checkVector(active.vehicle.body.userForce(), expectedForce, 2e-3, 'Rapier userForce differs from the exclusive active batch');
    checkVector(active.vehicle.body.userTorque(), expectedTorque, 2e-3, 'Rapier userTorque differs from the exclusive active batch');
    results.activeAuthority = { ...report.authority, hostCounters: report.hostCounters };
  } finally {
    destroyVehicleRig(active);
  }

  const shadow = createVehicleRig(CARS[0], { vehiclePhysicsMode: 'v24-shadow' });
  try {
    shadow.world.step();
    const legacyCalls = instrumentLegacyForcePath(shadow.vehicle);
    shadow.vehicle.fixedUpdate(zeroInput(), false, FIXED_DT);
    const report = shadow.vehicle.getVehiclePhysicsReport();
    check(legacyCalls() === 1, 'shadow mode did not retain the legacy force path');
    check(report.authority.vehicleForceState === 'LEGACY', 'shadow mode changed force authority');
    check(report.authority.legacyForceCalls === 1 && report.authority.v24ForceCalls === 0, 'shadow report indicates double force application');
    check(report.shadowComparison?.schema === 'streetrush.vehicle-v24.shadow-comparison.v1', 'shadow comparison schema is missing');
    check(Number.isFinite(report.shadowComparison?.delta?.speedKmh), 'shadow comparison is not machine-readable');
    check(JSON.parse(JSON.stringify(report.shadowComparison)).schema === report.shadowComparison.schema, 'shadow comparison is not JSON serializable');
    results.shadow = report.shadowComparison;
  } finally {
    destroyVehicleRig(shadow);
  }

  const legacy = createVehicleRig(CARS[0]);
  try {
    legacy.vehicle.fixedUpdate(zeroInput(), false, FIXED_DT);
    check(legacy.vehicle.vehiclePhysicsMode === 'legacy', 'legacy harness default changed');
    check(legacy.vehicle.vehicleV24 === null, 'legacy mode unexpectedly constructed the v2.4 runtime');
    check(legacy.vehicle.getVehiclePhysicsReport() === null, 'legacy mode emitted a v2.4 report');
  } finally {
    destroyVehicleRig(legacy);
  }

  const mainSource = fs.readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  check(/vehiclePhysicsMode:\s*['"]v24-active['"]/.test(mainSource), 'StreetRush production bootstrap is not pinned to v24-active');
}

{
  const rig = createVehicleRig(CARS[0], {
    vehiclePhysicsMode: 'v24-active',
    vehicleV24Options: {
      faultInjector: (phase) => {
        if (phase === 'after-host-apply') throw new Error('injected active host fault');
      },
    },
  });
  try {
    const legacyCalls = instrumentLegacyForcePath(rig.vehicle);
    const ownerStateBefore = rig.vehicle.vehicleV24.getStateSnapshot();
    let failure = null;
    try {
      rig.vehicle.fixedUpdate(zeroInput(), false, FIXED_DT);
    } catch (error) {
      failure = error;
    }
    check(failure instanceof VehicleV24AbortError, 'active host fault did not surface as VehicleV24AbortError');
    const report = rig.vehicle.getVehiclePhysicsReport();
    check(report?.status === 'ABORTED', 'active abort audit was not exposed by VehicleSystem');
    check(report?.transaction?.status === 'ROLLED_BACK', 'active fault did not roll back the five-owner transaction');
    check(Object.values(report.transaction.rollbackCounts).every((count) => count === 1), 'active fault did not roll back every committed owner');
    check(report?.authority?.fallbackUsed === false, 'active fault silently enabled fallback');
    check(report?.authority?.legacyForceCalls === 0 && legacyCalls() === 0, 'active fault invoked legacy physics');
    check(report?.authority?.v24ForceCalls === 0, 'rolled-back host batch was counted as applied');
    check(vectorMagnitude(rig.vehicle.body.userForce()) < 1e-12, 'active abort left Rapier force behind');
    check(vectorMagnitude(rig.vehicle.body.userTorque()) < 1e-12, 'active abort left Rapier torque behind');
    assert.deepEqual(rig.vehicle.vehicleV24.getStateSnapshot(), ownerStateBefore, 'active abort mutated owner state');
    checks += 1;
    results.activeAbort = {
      status: report.status,
      transactionStatus: report.transaction.status,
      authority: report.authority,
      rollbackCounts: report.transaction.rollbackCounts,
    };
  } finally {
    destroyVehicleRig(rig);
  }
}

{
  const rig = createVehicleRig(CARS[0], { vehiclePhysicsMode: 'v24-active' });
  try {
    const initialOwnerState = rig.vehicle.vehicleV24.getStateSnapshot();
    runFor(rig, 1.5, zeroInput({ throttle: 0.8, steer: 0.25, driveIntent: 1 }));
    check(JSON.stringify(rig.vehicle.vehicleV24.getStateSnapshot()) !== JSON.stringify(initialOwnerState), 'dynamic run did not change v2.4 owner state');
    rig.vehicle.reset(0);
    assert.deepEqual(rig.vehicle.vehicleV24.getStateSnapshot(), initialOwnerState, 'reset did not restore all v2.4 owner states');
    checks += 1;
    check(rig.vehicle.getVehiclePhysicsReport() === null, 'reset retained a stale v2.4 report');
    check(rig.vehicle.wheels.every((wheel) => wheel.omega === 0), 'reset retained v2.4 wheel speed');
    check(vectorMagnitude(rig.vehicle.body.linvel()) === 0, 'reset retained Rapier linear velocity');
    check(vectorMagnitude(rig.vehicle.body.angvel()) === 0, 'reset retained Rapier angular velocity');
    rig.vehicle.fixedUpdate(zeroInput(), false, FIXED_DT);
    check(rig.vehicle.getVehiclePhysicsReport().stepIndex === 1, 'reset did not restart the v2.4 transaction sequence');
    results.reset = { ownerStateRestored: true, nextStepIndex: 1 };
  } finally {
    destroyVehicleRig(rig);
  }
}

{
  const launchSpeeds = {};
  for (const surfaceId of ['asphalt', 'grass']) {
    const rig = createVehicleRig(CARS[0], { vehiclePhysicsMode: 'v24-active' });
    try {
      rig.vehicle.track.getSurface = (position) => ({
        id: surfaceId,
        ...SURFACES[surfaceId],
        info: rig.vehicle.track.nearestInfo(position),
      });
      settleVehicle(rig, 2);
      runFor(rig, 3, zeroInput({ throttle: 1, driveIntent: 1 }));
      const report = rig.vehicle.getVehiclePhysicsReport();
      check(report.output.surface === surfaceId, `${surfaceId} did not reach the v2.4 runtime`);
      check(report.output.wheels.every((wheel) => wheel.surface === surfaceId), `${surfaceId} was not applied at all contacts`);
      launchSpeeds[surfaceId] = rig.vehicle.telemetry.signedSpeedKmh;
    } finally {
      destroyVehicleRig(rig);
    }
  }
  check(launchSpeeds.asphalt - launchSpeeds.grass > 1, 'surface grip did not change StreetRush launch dynamics');
  results.surface = launchSpeeds;
}

{
  const allCars = [];
  for (const config of CARS) {
    const rig = createVehicleRig(config, { vehiclePhysicsMode: 'v24-active' });
    let maximumResidual = 0;
    let maximumEvaluations = 0;
    try {
      const sampleSolver = () => {
        const solver = rig.vehicle.getVehiclePhysicsReport()?.solver;
        if (!solver) return;
        maximumResidual = Math.max(maximumResidual, solver.scaledResidual);
        maximumEvaluations = Math.max(maximumEvaluations, solver.aggregateEvaluations);
      };
      runFor(rig, 2, zeroInput(), sampleSolver);
      runFor(rig, 3, zeroInput({ throttle: 1, driveIntent: 1 }), sampleSolver);
      const report = rig.vehicle.getVehiclePhysicsReport();
      check(report.status === 'COMMITTED', `${config.id} active runtime did not commit`);
      check(report.output.groundedCount === 4, `${config.id} did not retain four Rapier contacts`);
      check(rig.vehicle.telemetry.signedSpeedKmh > 20, `${config.id} did not produce runnable launch dynamics`);
      check(maximumResidual < 5e-7, `${config.id} residual margin is too close to the active abort gate`);
      check(maximumEvaluations <= report.solver.aggregateBudget, `${config.id} exceeded the aggregate evaluation budget`);
      check(report.authority.legacyForceCalls === 0 && report.authority.v24ForceCalls === 1, `${config.id} active authority is not exclusive`);
      allCars.push({
        id: config.id,
        speedKmh: rig.vehicle.telemetry.signedSpeedKmh,
        maximumResidual,
        maximumEvaluations,
      });
    } finally {
      destroyVehicleRig(rig);
    }
  }
  results.allCarsActive = allCars;
}

results.status = 'PASS';
results.checks = checks;
console.log(JSON.stringify(results));
