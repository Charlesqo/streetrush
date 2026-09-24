import { clamp, deepClone } from './math.js';
import { VehicleV24DomainError } from './contract.js';

export const REQUESTED_DIRECTION = Object.freeze({
  FORWARD: 'FORWARD',
  NEUTRAL: 'NEUTRAL',
  REVERSE: 'REVERSE',
});

export const SHIFT_PHASE = Object.freeze({
  STEADY: 'STEADY',
  OPENING: 'OPENING',
  NEUTRAL: 'NEUTRAL',
  CLOSING: 'CLOSING',
});

export const CLUTCH_ACTIVE_SET = Object.freeze({
  OPEN: 'OPEN',
  LOCKED: 'LOCKED',
  SLIP_POSITIVE: 'SLIP_POSITIVE',
  SLIP_NEGATIVE: 'SLIP_NEGATIVE',
});

export const BRAKE_ACTIVE_SET = Object.freeze({
  RELEASED: 'RELEASED',
  LOCKED: 'LOCKED',
  SLIP_POSITIVE: 'SLIP_POSITIVE',
  SLIP_NEGATIVE: 'SLIP_NEGATIVE',
});

const RPM_PER_RAD_S = 60 / (2 * Math.PI);
const RAD_S_PER_RPM = 1 / RPM_PER_RAD_S;
const ENGINE_INERTIA = 0.24;
const WHEEL_INERTIA = 1.25;

export function createEngineState(config) {
  return {
    omega: config.idle * RAD_S_PER_RPM,
    mode: 'RUNNING',
    loadActuated: 0,
    limiterCut: false,
  };
}

export function createGearboxState() {
  return {
    selectedGear: '1',
    phase: SHIFT_PHASE.STEADY,
    phaseElapsed: 0,
    sourceGear: null,
    targetGear: null,
    clutchEngagement: 1,
    direction: REQUESTED_DIRECTION.FORWARD,
    reverseHold: 0,
    transmissionMode: 'AT',
  };
}

function torqueCurveFactor(config, rpm) {
  if (rpm >= config.redline * 1.018) return 0;
  const rise = clamp((rpm - config.idle) / Math.max(1, config.peakRpm - config.idle), 0, 1);
  const fall = clamp((rpm - config.peakRpm) / Math.max(1, config.redline - config.peakRpm), 0, 1);
  return rpm <= config.peakRpm
    ? 0.56 + (1 - 0.56) * Math.sin(rise * Math.PI * 0.5)
    : 1 + (0.74 - 1) * fall;
}

function gearRatio(config, gearName) {
  if (gearName === 'N') return 0;
  if (gearName === 'R') return -3.25;
  const index = Number.parseInt(gearName, 10) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= config.gears.length) {
    throw new VehicleV24DomainError(`unknown v2.4 gear ${gearName}`);
  }
  return config.gears[index];
}

function startShift(state, targetGear, events) {
  if (targetGear === state.selectedGear) return state;
  events.push(`SHIFT_REQUESTED:${state.selectedGear}->${targetGear}`);
  if (state.selectedGear === 'N') {
    events.push(`GEAR_SELECTED:${targetGear}`);
    return {
      ...state,
      selectedGear: targetGear,
      phase: SHIFT_PHASE.CLOSING,
      phaseElapsed: 0,
      sourceGear: 'N',
      targetGear,
      clutchEngagement: 0,
    };
  }
  return {
    ...state,
    phase: SHIFT_PHASE.OPENING,
    phaseElapsed: 0,
    sourceGear: state.selectedGear,
    targetGear,
    clutchEngagement: 1,
  };
}

function phaseDuration(phase) {
  if (phase === SHIFT_PHASE.OPENING) return 0.05;
  if (phase === SHIFT_PHASE.NEUTRAL) return 0.03;
  if (phase === SHIFT_PHASE.CLOSING) return 0.10;
  return Infinity;
}

function phaseEngagement(phase, elapsed) {
  if (phase === SHIFT_PHASE.OPENING) return clamp(1 - elapsed / phaseDuration(phase), 0, 1);
  if (phase === SHIFT_PHASE.CLOSING) return clamp(elapsed / phaseDuration(phase), 0, 1);
  return 0;
}

function finishPhase(state, events) {
  if (state.phase === SHIFT_PHASE.OPENING) {
    events.push('CLUTCH_OPEN');
    if (state.targetGear === 'N') {
      events.push('GEAR_SELECTED:N');
      return {
        ...state,
        selectedGear: 'N', phase: SHIFT_PHASE.STEADY, phaseElapsed: 0,
        sourceGear: null, targetGear: null, clutchEngagement: 0,
      };
    }
    events.push('GEAR_SELECTED:N');
    return { ...state, selectedGear: 'N', phase: SHIFT_PHASE.NEUTRAL, phaseElapsed: 0, clutchEngagement: 0 };
  }
  if (state.phase === SHIFT_PHASE.NEUTRAL) {
    events.push(`GEAR_SELECTED:${state.targetGear}`);
    return { ...state, selectedGear: state.targetGear, phase: SHIFT_PHASE.CLOSING, phaseElapsed: 0, clutchEngagement: 0 };
  }
  if (state.phase === SHIFT_PHASE.CLOSING) {
    events.push('CLUTCH_CLOSED', `SHIFT_COMPLETED:${state.targetGear}`);
    return {
      ...state,
      selectedGear: state.targetGear,
      phase: SHIFT_PHASE.STEADY,
      phaseElapsed: 0,
      sourceGear: null,
      targetGear: null,
      clutchEngagement: state.targetGear === 'N' ? 0 : 1,
    };
  }
  return state;
}

function advanceGearbox(state, requestedGear, dt) {
  const events = [];
  let working = deepClone(state);
  if (working.phase === SHIFT_PHASE.STEADY && requestedGear && requestedGear !== working.selectedGear) {
    working = startShift(working, requestedGear, events);
  }
  let remaining = dt;
  let engagementArea = 0;
  let mappingGear = working.phase === SHIFT_PHASE.OPENING
    ? working.sourceGear
    : working.phase === SHIFT_PHASE.CLOSING
      ? working.targetGear
      : working.selectedGear;
  let internalSplits = 0;
  while (remaining > 1e-12 && working.phase !== SHIFT_PHASE.STEADY) {
    const duration = phaseDuration(working.phase);
    const available = Math.max(0, duration - working.phaseElapsed);
    const segment = Math.min(remaining, available);
    const start = phaseEngagement(working.phase, working.phaseElapsed);
    const endElapsed = working.phaseElapsed + segment;
    const end = phaseEngagement(working.phase, endElapsed);
    engagementArea += 0.5 * (start + end) * segment;
    mappingGear = working.phase === SHIFT_PHASE.OPENING
      ? working.sourceGear
      : working.phase === SHIFT_PHASE.CLOSING
        ? working.targetGear
        : 'N';
    working.phaseElapsed = endElapsed;
    working.clutchEngagement = end;
    remaining -= segment;
    if (available <= segment + 1e-12) {
      working = finishPhase(working, events);
      internalSplits += 1;
    }
  }
  if (remaining > 0) {
    const steadyEngagement = working.selectedGear === 'N' ? 0 : 1;
    engagementArea += steadyEngagement * remaining;
    mappingGear = working.selectedGear;
    working.clutchEngagement = steadyEngagement;
  }
  return {
    nextState: working,
    effectiveGear: mappingGear ?? 'N',
    averageEngagement: engagementArea / dt,
    events,
    internalSplits,
  };
}

function desiredAutomaticGear(config, state, engineRpm, throttle, speedKmh) {
  const current = Number.parseInt(state.selectedGear, 10);
  if (!Number.isInteger(current)) return state.direction === REQUESTED_DIRECTION.REVERSE ? 'R' : '1';
  const upshift = config.redline * (0.68 + (0.91 - 0.68) * throttle);
  const downshift = config.redline * (0.31 + (0.43 - 0.31) * throttle);
  if (speedKmh < 5 && current > 1) return '1';
  if (engineRpm > upshift && current < config.gears.length) return String(current + 1);
  if (engineRpm < downshift && current > 1) return String(current - 1);
  return null;
}

export function prepareDriverGearboxTrial({ state, input, signedSpeed, engineRpm, config, dt }) {
  const snapshot = deepClone(state);
  let next = deepClone(state);
  if (input.toggleTransmission) next.transmissionMode = next.transmissionMode === 'AT' ? 'MT' : 'AT';
  const hasExplicitIntent = Number.isFinite(input.driveIntent);
  const intent = hasExplicitIntent
    ? Math.sign(input.driveIntent)
    : input.throttle > 0.055
      ? 1
      : 0;
  const parkingInterlock = input.handbrake > 0.055;
  let driveThrottle = 0;
  let serviceBrake = 0;
  let transitionBlocked = false;
  const switchSpeed = 0.22;
  if (input.directionConflict) {
    next.reverseHold = 0;
    if (signedSpeed > switchSpeed) serviceBrake = input.brake;
    else if (signedSpeed < -switchSpeed) serviceBrake = input.throttle;
    else serviceBrake = next.direction === REQUESTED_DIRECTION.REVERSE ? input.throttle : input.brake;
  } else if (intent > 0) {
    next.reverseHold = 0;
    if (next.direction === REQUESTED_DIRECTION.REVERSE && signedSpeed < -switchSpeed) {
      serviceBrake = input.throttle;
      transitionBlocked = true;
    } else {
      next.direction = REQUESTED_DIRECTION.FORWARD;
      driveThrottle = input.throttle;
    }
  } else if (intent < 0) {
    if (parkingInterlock) {
      next.reverseHold = 0;
      serviceBrake = input.brake;
      transitionBlocked = true;
    } else if (next.direction === REQUESTED_DIRECTION.REVERSE) {
      next.reverseHold = 0;
      driveThrottle = input.brake;
    } else if (signedSpeed > switchSpeed) {
      next.reverseHold = 0;
      serviceBrake = input.brake;
      transitionBlocked = true;
    } else {
      serviceBrake = input.brake;
      next.reverseHold += dt;
      transitionBlocked = next.reverseHold < 0.45;
      if (!transitionBlocked) {
        next.direction = REQUESTED_DIRECTION.REVERSE;
        next.reverseHold = 0;
        serviceBrake = 0;
        driveThrottle = input.brake;
      }
    }
  } else {
    next.reverseHold = 0;
    serviceBrake = input.brake;
  }

  let requestedGear = null;
  if (next.direction === REQUESTED_DIRECTION.REVERSE) requestedGear = 'R';
  else if (state.direction === REQUESTED_DIRECTION.REVERSE && next.direction === REQUESTED_DIRECTION.FORWARD) requestedGear = '1';
  else if (next.transmissionMode === 'MT') {
    const current = Number.parseInt(next.selectedGear, 10);
    if (Number.isInteger(current) && input.shiftUp) requestedGear = String(Math.min(config.gears.length, current + 1));
    if (Number.isInteger(current) && input.shiftDown) requestedGear = String(Math.max(1, current - 1));
  } else if (next.phase === SHIFT_PHASE.STEADY && next.direction === REQUESTED_DIRECTION.FORWARD) {
    requestedGear = desiredAutomaticGear(
      config, next, engineRpm, driveThrottle, Math.abs(signedSpeed) * 3.6,
    );
  }
  const advanced = advanceGearbox(next, requestedGear, dt);
  advanced.nextState.direction = next.direction;
  advanced.nextState.reverseHold = next.reverseHold;
  advanced.nextState.transmissionMode = next.transmissionMode;
  return {
    snapshot,
    nextState: advanced.nextState,
    driveThrottle,
    serviceBrake,
    parkingBrake: clamp(input.handbrake, 0, 1),
    transitionBlocked,
    effectiveGear: advanced.effectiveGear,
    averageEngagement: advanced.averageEngagement,
    events: advanced.events,
    internalSplits: advanced.internalSplits,
  };
}

const NOMINAL_FRONT_SERVICE_BRAKE_SHARE = 0.62;
const MAXIMUM_FRONT_SERVICE_BRAKE_SHARE = 0.86;
// On uniform grip the front axle must reach ABS before the rear; otherwise the
// rear keeps less lateral reserve and the car becomes directionally unstable.
// This reserve puts the measured high-load case on the front ABS threshold,
// while MAXIMUM_FRONT_SERVICE_BRAKE_SHARE keeps the calibration bounded.
const FRONT_LOCK_SAFETY_MARGIN = 0.12;

export function distributeDriverServiceBrake({
  brakeTorque,
  mass,
  normalLoads,
  bodyLongSpeed,
  groundedCount,
}) {
  const nominalFractions = [0.31, 0.31, 0.19, 0.19];
  const resolvedTorque = Math.max(0, Number.isFinite(brakeTorque) ? brakeTorque : 0);
  const loads = Array.from({ length: 4 }, (_, index) => (
    Math.max(0, Number.isFinite(normalLoads?.[index]) ? normalLoads[index] : 0)
  ));
  const totalLoad = loads.reduce((sum, load) => sum + load, 0);
  const frontLoad = loads[0] + loads[1];
  const resolvedMass = Math.max(0, Number.isFinite(mass) ? mass : 0);
  const hasLoadAuthority = groundedCount === 4
    && totalLoad >= resolvedMass * 9.81 * 0.5
    && totalLoad > 1;
  const frontLoadShare = hasLoadAuthority ? frontLoad / totalLoad : 0.5;
  const speedRamp = clamp((Math.abs(bodyLongSpeed) - 5) / 10, 0, 1);
  const speedAuthority = speedRamp * speedRamp * (3 - 2 * speedRamp);
  const desiredFrontShare = hasLoadAuthority
    ? clamp(
      frontLoadShare + FRONT_LOCK_SAFETY_MARGIN,
      NOMINAL_FRONT_SERVICE_BRAKE_SHARE,
      MAXIMUM_FRONT_SERVICE_BRAKE_SHARE,
    )
    : NOMINAL_FRONT_SERVICE_BRAKE_SHARE;
  const frontShare = NOMINAL_FRONT_SERVICE_BRAKE_SHARE
    + (desiredFrontShare - NOMINAL_FRONT_SERVICE_BRAKE_SHARE) * speedAuthority;
  const driverFractions = [
    frontShare * 0.5,
    frontShare * 0.5,
    (1 - frontShare) * 0.5,
    (1 - frontShare) * 0.5,
  ];
  const driverBase = driverFractions.map((fraction) => resolvedTorque * fraction);
  // Driver distribution may expose more front capacity, while the old nominal
  // per-wheel limits remain available to TCS/ESC on either rear wheel.
  const serviceLimit = nominalFractions.map((fraction, index) => (
    Math.max(resolvedTorque * fraction, driverBase[index])
  ));
  return {
    frontShare,
    frontLoadShare,
    speedAuthority,
    driverBase,
    serviceLimit,
  };
}

export function evaluateBrakeAssists({
  serviceBrake,
  parkingBrake,
  bodyLongSpeed,
  oracleYawRate,
  steeringCurvature,
  wheelOmega,
  effectiveRadii,
  drivenWheels,
  groundedCount,
  normalLoads,
  steerCommand,
  config,
}) {
  const denominator = Math.max(Math.abs(bodyLongSpeed), 0.5);
  const wheelSlip = wheelOmega.map((omega, index) => (
    omega * effectiveRadii[index] - bodyLongSpeed
  ) / denominator);
  const brakeDistribution = distributeDriverServiceBrake({
    brakeTorque: config.brakeTorque,
    mass: config.mass,
    normalLoads,
    bodyLongSpeed,
    groundedCount,
  });
  const serviceBase = brakeDistribution.serviceLimit;
  const parkingBase = [0, 0, 0.72, 0.72].map((fraction) => config.brakeTorque * fraction);
  const driverService = brakeDistribution.driverBase.map(
    (capacity) => clamp(serviceBrake, 0, 1) * capacity,
  );
  const parkingCapacity = parkingBase.map((capacity) => clamp(parkingBrake, 0, 1) * capacity);
  const maxDriveSlip = Math.max(0, ...wheelSlip.filter((_, index) => drivenWheels[index]));
  const driveExcess = Math.max(0, maxDriveSlip - 0.12);
  const enginePositiveTorqueLimit = clamp(1 - 2.5 * driveExcess, 0, 1);
  // Near standstill the slip ratio denominator is intentionally bounded, so
  // tiny left/right wheel-speed differences are not trustworthy enough to
  // authorize a one-wheel brake. Keep the symmetric engine torque cut active,
  // then blend brake-based TCS in once vehicle speed makes slip observable.
  const tcsBrakeSpeedAuthority = clamp((Math.abs(bodyLongSpeed) - 2) / 3, 0, 1);
  const tcsBrake = wheelSlip.map((slip, index) => (
    drivenWheels[index]
      ? 900 * Math.max(0, slip - 0.12) * tcsBrakeSpeedAuthority
      : 0
  ));
  const desiredYaw = bodyLongSpeed * steeringCurvature;
  const yawError = desiredYaw - oracleYawRate;
  const escBrake = [0, 0, 0, 0];
  const resolvedGroundedCount = Number.isFinite(groundedCount) ? groundedCount : 4;
  const resolvedSteerCommand = Number.isFinite(steerCommand)
    ? Math.abs(steerCommand)
    : Math.abs(steeringCurvature) > 1e-6 ? 1 : 0;
  const escSpeedAuthority = clamp((Math.abs(bodyLongSpeed) - 5) / 4, 0, 1);
  const escSteerAuthority = clamp((resolvedSteerCommand - 0.08) / 0.17, 0, 1);
  // A deliberate heavy foot-brake application is also a valid ESC maneuver.
  // This lets ESC arrest real straight-line brake yaw without making ambient
  // yaw/noise eligible when the driver is coasting or only brushing the pedal.
  const escBrakeAuthority = clamp((clamp(serviceBrake, 0, 1) - 0.35) / 0.4, 0, 1);
  const escManeuverAuthority = Math.max(escSteerAuthority, escBrakeAuthority);
  const escAuthority = Math.min(escSpeedAuthority, escManeuverAuthority);
  // The accepted v2.4 controls reference uses a 0.04 rad/s ESC deadband.
  // Keep the host's quieter 0.06 threshold for steering-only operation and
  // converge to the accepted threshold only during an intentional heavy brake.
  const escYawDeadband = 0.06 - 0.02 * escBrakeAuthority;
  const escEligible = resolvedGroundedCount >= 3 && escAuthority > 0;
  if (escEligible && Math.abs(yawError) > escYawDeadband) {
    const request = Math.min(700, 600 * Math.abs(yawError)) * escAuthority;
    escBrake[yawError > 0 ? 2 : 3] = request;
  }
  const serviceRequest = serviceBase.map((maximum, index) => Math.min(
    maximum,
    driverService[index] + tcsBrake[index] + escBrake[index],
  ));
  const absModulation = wheelSlip.map((slip, index) => {
    if (serviceRequest[index] <= 0 || slip >= -0.14) return 1;
    return Math.max(0.08, 1 - 3.5 * (-0.14 - slip));
  });
  const serviceCapacity = serviceRequest.map((request, index) => request * absModulation[index]);
  const totalBrakeCapacity = serviceCapacity.map((capacity, index) => capacity + parkingCapacity[index]);
  return {
    wheelSlip,
    absModulation,
    serviceBrakeFrontShare: brakeDistribution.frontShare,
    serviceBrakeFrontLoadShare: brakeDistribution.frontLoadShare,
    serviceBrakeSpeedAuthority: brakeDistribution.speedAuthority,
    driverServiceCapacity: driverService,
    serviceRequestCapacity: serviceRequest,
    serviceCapacity,
    parkingCapacity,
    tcsBrakeCapacity: tcsBrake,
    tcsBrakeSpeedAuthority,
    escBrakeCapacity: escBrake,
    totalBrakeCapacity,
    enginePositiveTorqueLimit,
    desiredYaw,
    yawError,
    escEligible,
    escSpeedAuthority,
    escSteerAuthority,
    escBrakeAuthority,
    escManeuverAuthority,
    escYawDeadband,
    absActive: absModulation.some((value) => value < 1),
    tcsActive: enginePositiveTorqueLimit < 1 || tcsBrake.some((value) => value > 0),
    escActive: escBrake.some((value) => value > 0),
  };
}

export function idealOpenDifferentialMapping(config, gearName) {
  const ratio = gearRatio(config, gearName) * config.finalDrive;
  if (config.drivetrain === 'FWD') return [ratio * 0.5, ratio * 0.5, 0, 0];
  if (config.drivetrain === 'AWD') return [ratio * 0.25, ratio * 0.25, ratio * 0.25, ratio * 0.25];
  return [0, 0, ratio * 0.5, ratio * 0.5];
}

export function prepareEngineClutchTrial({
  engineState,
  gearboxTrial,
  wheelOmega,
  bodyLongSpeed,
  assists,
  config,
  dt,
  allowMechanicalOverrev = false,
}) {
  const snapshot = deepClone(engineState);
  if (!Number.isFinite(engineState.omega) || engineState.omega < 0) {
    throw new VehicleV24DomainError('reduced ICE shaft speed must be finite and non-negative');
  }
  const rpm = engineState.omega * RPM_PER_RAD_S;
  if (!Number.isFinite(rpm)) {
    throw new VehicleV24DomainError('engine RPM must be finite');
  }
  if (rpm > config.redline * 1.12 && !allowMechanicalOverrev) {
    throw new VehicleV24DomainError('engine speed exceeds the v2.4 hard overspeed domain', { rpm });
  }
  // StreetRush's explicitly enabled mechanical-overrun extension allows wheel-
  // driven RPM outside the calibrated engine domain. The existing torque law
  // supplies no combustion there, only bounded overrun drag. Do not clamp RPM,
  // disconnect the clutch, or reject the driver's shift to hide the overspeed.
  let limiterCut = engineState.limiterCut;
  if (!limiterCut && rpm >= config.redline) limiterCut = true;
  else if (limiterCut && rpm <= config.redline * 0.965) limiterCut = false;
  const targetLoad = limiterCut
    ? 0
    : gearboxTrial.driveThrottle * assists.enginePositiveTorqueLimit;
  const loadDecay = Math.exp(-dt / 0.055);
  const loadActuated = clamp(
    targetLoad + (engineState.loadActuated - targetLoad) * loadDecay,
    0,
    1,
  );
  const curveTorque = config.torque * torqueCurveFactor(config, rpm) * loadActuated;
  const idleTorque = rpm < config.idle
    ? Math.min(config.torque * 0.7, (config.idle - rpm) * 0.06)
    : 0;
  const overrunTorque = loadActuated < 0.02 && rpm > config.idle * 1.08
    ? -config.torque * 0.075 * Math.tanh((rpm - config.idle) / 1200)
    : 0;
  const freeTorque = curveTorque + idleTorque + overrunTorque;
  const engineFreeOmega = Math.max(0, engineState.omega + freeTorque / ENGINE_INERTIA * dt);
  const mapping = idealOpenDifferentialMapping(config, gearboxTrial.effectiveGear);
  let engagement = clamp(gearboxTrial.averageEngagement, 0, 1);
  if (gearboxTrial.effectiveGear === '1' || gearboxTrial.effectiveGear === 'R') {
    const speed = Math.abs(bodyLongSpeed);
    const ratio = Math.abs(mapping.reduce((sum, coefficient) => sum + coefficient, 0));
    const idleRoadSpeed = config.idle / RPM_PER_RAD_S * config.wheelRadius / Math.max(ratio, 1e-12);
    // With no launch request the auto-clutch opens below synchronous idle speed.
    // Otherwise tiny rolling/contact noise engages the clutch, idle torque accelerates
    // the car, and the speed-only launch map feeds that acceleration back into itself.
    // Keep the normal launch map under pedal demand and engine braking at road speed.
    const launchClutch = gearboxTrial.driveThrottle > 0
      ? clamp(speed / 3 + gearboxTrial.driveThrottle * 0.35, 0, 1)
      : clamp((speed - idleRoadSpeed) / Math.max(1, 3 - idleRoadSpeed), 0, 1);
    engagement = Math.min(engagement, launchClutch);
  }
  const clutchSideOmega = mapping.reduce((sum, coefficient, index) => (
    sum + coefficient * wheelOmega[index]
  ), 0);
  const inverseEffectiveInertia = 1 / ENGINE_INERTIA
    + mapping.reduce((sum, coefficient) => sum + coefficient * coefficient / WHEEL_INERTIA, 0);
  const lockImpulse = -(engineFreeOmega - clutchSideOmega) / Math.max(inverseEffectiveInertia, 1e-12);
  const clutchCapacity = config.torque * 2.2 * engagement * dt;
  let clutchImpulse = clamp(lockImpulse, -clutchCapacity, clutchCapacity);
  let engineStopActive = false;
  let clutchRegime;
  if (clutchCapacity <= 1e-12 || mapping.every((value) => value === 0)) {
    clutchImpulse = 0;
    clutchRegime = CLUTCH_ACTIVE_SET.OPEN;
  } else if (engineFreeOmega + clutchImpulse / ENGINE_INERTIA < 0) {
    // Engine speed is a unilateral coordinate. Solve its lower-bound impulse as part
    // of the clutch active set instead of clipping RPM after declaring a false lock.
    clutchImpulse = -engineFreeOmega * ENGINE_INERTIA;
    clutchRegime = CLUTCH_ACTIVE_SET.SLIP_POSITIVE;
    engineStopActive = true;
  } else if (Math.abs(lockImpulse) <= clutchCapacity + 1e-10) {
    clutchRegime = CLUTCH_ACTIVE_SET.LOCKED;
  } else {
    clutchRegime = lockImpulse < 0
      ? CLUTCH_ACTIVE_SET.SLIP_POSITIVE
      : CLUTCH_ACTIVE_SET.SLIP_NEGATIVE;
  }
  const wheelDriveImpulses = mapping.map((coefficient) => -coefficient * clutchImpulse);
  const predictedWheelOmega = wheelOmega.map((omega, index) => (
    omega + wheelDriveImpulses[index] / WHEEL_INERTIA
  ));
  const solvedNextOmega = engineFreeOmega + clutchImpulse / ENGINE_INERTIA;
  const nextOmega = solvedNextOmega < 0 && solvedNextOmega > -1e-10 ? 0 : solvedNextOmega;
  if (nextOmega < 0) {
    throw new VehicleV24DomainError('clutch active set produced negative engine speed', {
      nextOmega,
      clutchRegime,
      engineStopActive,
    });
  }
  const nextState = {
    omega: nextOmega,
    mode: 'RUNNING',
    loadActuated,
    limiterCut,
  };
  const postClutchSideOmega = mapping.reduce((sum, coefficient, index) => (
    sum + coefficient * predictedWheelOmega[index]
  ), 0);
  const residual = clutchRegime === CLUTCH_ACTIVE_SET.LOCKED
    ? Math.abs(nextOmega - postClutchSideOmega)
    : engineStopActive
      ? Math.max(0, -solvedNextOmega)
      : Math.max(0, Math.abs(clutchImpulse) - clutchCapacity);
  const residualScale = clutchRegime === CLUTCH_ACTIVE_SET.LOCKED
    ? Math.max(1, Math.abs(nextOmega), Math.abs(postClutchSideOmega))
    : engineStopActive
      ? Math.max(1, Math.abs(engineFreeOmega))
      : Math.max(1, clutchCapacity);
  const wheelDriveTorqueRequested = mapping.map((coefficient) => (
    // Project the actual shaft request into the same wheel-end reference as transfer.
    // Clutch transfer can differ while exchanging stored rotational energy.
    coefficient * freeTorque
  ));
  return {
    snapshot,
    nextState,
    freeTorque,
    mapTorque: curveTorque,
    idleTorque,
    overrunTorque,
    effectiveLoad: loadActuated,
    mapping,
    engagement,
    clutchImpulse,
    clutchCapacity,
    clutchRegime,
    engineStopActive,
    engineDomainStatus: Math.max(rpm, nextOmega * RPM_PER_RAD_S) > config.redline * 1.12
      ? 'MECHANICAL_OVERRUN_EXTENSION' : 'IN_DOMAIN',
    wheelDriveImpulses,
    wheelDriveTorqueRequested,
    wheelDriveTorque: wheelDriveImpulses.map((impulse) => impulse / dt),
    predictedWheelOmega,
    residual,
    residualScale,
    rpm: nextOmega * RPM_PER_RAD_S,
  };
}

export function applyBrakeActiveSet({ omega, capacityTorque, inertia = WHEEL_INERTIA, dt }) {
  if (capacityTorque <= 0 || omega === 0) {
    return {
      omega,
      appliedTorque: 0,
      impulse: 0,
      regime: capacityTorque > 0 ? BRAKE_ACTIVE_SET.LOCKED : BRAKE_ACTIVE_SET.RELEASED,
      residual: 0,
    };
  }
  const requiredImpulse = Math.abs(omega) * inertia;
  const capacityImpulse = capacityTorque * dt;
  const appliedImpulseMagnitude = Math.min(requiredImpulse, capacityImpulse);
  const signedImpulse = -Math.sign(omega) * appliedImpulseMagnitude;
  const nextOmega = omega + signedImpulse / inertia;
  return {
    omega: Math.abs(nextOmega) < 1e-12 ? 0 : nextOmega,
    appliedTorque: Math.abs(signedImpulse) / dt,
    impulse: signedImpulse,
    regime: appliedImpulseMagnitude >= requiredImpulse - 1e-12
      ? BRAKE_ACTIVE_SET.LOCKED
      : omega > 0
        ? BRAKE_ACTIVE_SET.SLIP_POSITIVE
        : BRAKE_ACTIVE_SET.SLIP_NEGATIVE,
    residual: appliedImpulseMagnitude > capacityImpulse + 1e-12
      ? appliedImpulseMagnitude - capacityImpulse
      : 0,
  };
}

export const POWERTRAIN_CONSTANTS = Object.freeze({
  engineInertia: ENGINE_INERTIA,
  wheelInertia: WHEEL_INERTIA,
  rpmPerRadS: RPM_PER_RAD_S,
  radSPerRpm: RAD_S_PER_RPM,
});
