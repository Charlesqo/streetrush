import { clamp, deepClone } from './math.js';

const MINIMUM_RACK_AUTHORITY = 0.14;
const SPEED_ASSIST_REFERENCE_MPS = 16;
const RACK_PROGRESSIVE_FRACTION = 0.12;

export function createSteeringState() {
  return {
    keyboardAxis: 0,
    rackQ: 0,
    rackRate: 0,
    filteredReactionTorque: 0,
  };
}

function rackAngle(rackQ, maximumAngle) {
  const q = clamp(rackQ, -1, 1);
  const c = RACK_PROGRESSIVE_FRACTION;
  return maximumAngle * ((1 - c) * q + c * q ** 3);
}

export function steeringSpeedAuthority(speed) {
  const normalizedSpeed = Math.max(0, Number.isFinite(speed) ? speed : 0)
    / SPEED_ASSIST_REFERENCE_MPS;
  return MINIMUM_RACK_AUTHORITY
    + (1 - MINIMUM_RACK_AUTHORITY) / (1 + normalizedSpeed * normalizedSpeed);
}

function frontAngles(virtualAngle, wheelbase, trackWidth, leftJounce = 0, rightJounce = 0) {
  const curvature = Math.tan(virtualAngle) / wheelbase;
  const halfTrack = trackWidth * 0.5;
  const ackermannStrength = 0.82;
  // Jounce-dependent toe has one owner: the accepted K&C map in suspension.js.
  // The active fixture deliberately disables the steering helper's simplified
  // bump-steer when that asset is present. Applying both made braking pitch/roll
  // feed wheel steer twice and amplified tiny left/right load differences.
  const left = Math.atan2(
    wheelbase * curvature,
    1 - ackermannStrength * halfTrack * curvature,
  ) - 0.04 * Math.PI / 180;
  const right = Math.atan2(
    wheelbase * curvature,
    1 + ackermannStrength * halfTrack * curvature,
  ) + 0.04 * Math.PI / 180;
  return { left, right };
}

export function prepareSteeringTrial({
  state,
  streetRushCommand,
  speed,
  dt,
  maximumAngle,
  wheelbase,
  trackWidth,
  leftJounce = 0,
  rightJounce = 0,
}) {
  const snapshot = deepClone(state);
  // Every device enters this seam as semantic positive-left. With +Z forward and +Y
  // up, the production chase camera's screen-right is -X (not the legacy axis named
  // "right", +X). Driver-left therefore needs a POSITIVE host yaw/wheel angle.
  // This is the only device-semantic-to-rack conversion; retain the oracle-to-host
  // mechanical angle mapping below. Device deadzones/curves/slew remain in input.
  const oracleCommand = -clamp(streetRushCommand, -1, 1);
  const shapedInput = oracleCommand;
  const speedAuthority = steeringSpeedAuthority(speed);
  const targetQ = shapedInput * speedAuthority;
  const targetVirtualAngle = rackAngle(targetQ, maximumAngle);
  const targetCurvature = Math.tan(targetVirtualAngle) / wheelbase;

  const naturalFrequency = 16;
  const dampingRatio = 0.95;
  let acceleration = naturalFrequency ** 2 * (targetQ - state.rackQ)
    - 2 * dampingRatio * naturalFrequency * state.rackRate;
  acceleration = clamp(acceleration, -75, 75);
  let rackRate = clamp(state.rackRate + acceleration * dt, -5.5, 5.5);
  let rackQ = state.rackQ + rackRate * dt;
  if (rackQ >= 1) {
    rackQ = 1;
    rackRate = Math.min(0, rackRate);
  } else if (rackQ <= -1) {
    rackQ = -1;
    rackRate = Math.max(0, rackRate);
  }
  const virtualAngle = rackAngle(rackQ, maximumAngle);
  const oracleWheelAngles = frontAngles(
    virtualAngle, wheelbase, trackWidth, leftJounce, rightJounce,
  );
  const nextState = {
    ...snapshot,
    rackQ,
    rackRate,
  };
  return {
    snapshot,
    nextState,
    oracleCommand,
    shapedInput,
    speedAuthority,
    controlPolicy: 'streetrush-playability-v2-driver-view',
    targetCurvature,
    curvature: Math.tan(virtualAngle) / wheelbase,
    virtualAngle,
    // Fixed oracle-to-host coordinate mapping, not another device-input inversion.
    streetRushVirtualAngle: -virtualAngle,
    streetRushWheelAngles: [-oracleWheelAngles.left, -oracleWheelAngles.right, 0, 0],
    oracleWheelAngles,
  };
}

export function evaluateSteeringReaction({ trial, leftLoad, rightLoad, dt }) {
  const epsilon = 1e-5;
  const maximumAngle = trial.maximumAngle;
  const geometryAt = (q) => frontAngles(
    rackAngle(clamp(q, -1, 1), maximumAngle),
    trial.wheelbase,
    trial.trackWidth,
    trial.leftJounce,
    trial.rightJounce,
  );
  const lowQ = clamp(trial.nextState.rackQ - epsilon, -1, 1);
  const highQ = clamp(trial.nextState.rackQ + epsilon, -1, 1);
  const low = geometryAt(lowQ);
  const high = geometryAt(highQ);
  const denominator = Math.max(1e-12, highQ - lowQ);
  const derivatives = {
    left: (high.left - low.left) / denominator,
    right: (high.right - low.right) / denominator,
  };
  const axisTorque = (load) => load.momentZ
    - (load.mechanicalTrail ?? 0) * load.forceY
    - (load.scrubRadius ?? 0) * load.forceX;
  const rackTorque = derivatives.left * axisTorque(leftLoad)
    + derivatives.right * axisTorque(rightLoad);
  const target = clamp(rackTorque / (540 * Math.PI / 180), -10, 10);
  const decay = Math.exp(-dt / 0.035);
  const filtered = target + (trial.nextState.filteredReactionTorque - target) * decay;
  return {
    generalizedRackTorque: rackTorque,
    handwheelTorque: filtered,
    derivatives,
    nextState: { ...trial.nextState, filteredReactionTorque: filtered },
  };
}

export function attachSteeringReactionContext(trial, context) {
  return { ...trial, ...context };
}
