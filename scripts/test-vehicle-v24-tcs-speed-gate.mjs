import assert from 'node:assert/strict';

import { evaluateBrakeAssists } from '../src/vehicle-v24/powertrain.js';

const radius = 0.34;
const config = { brakeTorque: 4000, mass: 1900 };
let checks = 0;

function evaluate({ speed, drivenSurfaceSpeeds, driven = true }) {
  const surfaceSpeeds = drivenSurfaceSpeeds ?? [speed, speed, speed, speed];
  return evaluateBrakeAssists({
    serviceBrake: 0,
    parkingBrake: 0,
    bodyLongSpeed: speed,
    oracleYawRate: 0,
    steeringCurvature: 0,
    wheelOmega: surfaceSpeeds.map((value) => value / radius),
    effectiveRadii: [radius, radius, radius, radius],
    drivenWheels: driven ? [true, true, true, true] : [false, false, false, false],
    groundedCount: 4,
    normalLoads: [5000, 5000, 5000, 5000],
    steerCommand: 0,
    config,
  });
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  checks += 1;
}

function close(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
  checks += 1;
}

const lowSpeed = evaluate({ speed: 1, drivenSurfaceSpeeds: [4, 1, 1, 1] });
equal(lowSpeed.tcsBrakeSpeedAuthority, 0, 'standstill-region brake TCS authority must be zero');
equal(lowSpeed.tcsBrakeCapacity.every((value) => value === 0), true,
  'low-speed wheel-speed noise must not create a one-wheel TCS brake');
equal(lowSpeed.enginePositiveTorqueLimit < 1, true,
  'symmetric engine torque reduction must remain available at low speed');
equal(lowSpeed.tcsActive, true, 'engine torque reduction must still report TCS active');

const blendSpeed = 3.5;
const blendSurfaceSpeed = 5;
const blended = evaluate({
  speed: blendSpeed,
  drivenSurfaceSpeeds: [blendSurfaceSpeed, blendSpeed, blendSpeed, blendSpeed],
});
close(blended.tcsBrakeSpeedAuthority, 0.5, 1e-12, 'TCS brake speed blend');
close(
  blended.tcsBrakeCapacity[0],
  900 * ((blendSurfaceSpeed - blendSpeed) / blendSpeed - 0.12) * 0.5,
  1e-9,
  'blended single-wheel TCS capacity',
);
equal(blended.tcsBrakeCapacity.slice(1).every((value) => value === 0), true,
  'only the genuinely overspeeding driven wheel may receive brake TCS');

const highSpeed = evaluate({ speed: 10, drivenSurfaceSpeeds: [15, 10, 10, 10] });
equal(highSpeed.tcsBrakeSpeedAuthority, 1, 'observable-speed TCS brake authority must be full');
close(highSpeed.tcsBrakeCapacity[0], 900 * (0.5 - 0.12), 1e-9,
  'high-speed accepted TCS brake gain must remain unchanged');

const neutral = evaluate({ speed: 10 });
equal(neutral.tcsActive, false, 'matching wheel speed with no slip must leave TCS inactive');
equal(neutral.tcsBrakeCapacity.every((value) => value === 0), true,
  'matching wheel speed must produce no TCS brake');

console.log(JSON.stringify({
  schema: 'streetrush.vehicle-v24.tcs-speed-gate.v1',
  status: 'PASS',
  checks,
}));
