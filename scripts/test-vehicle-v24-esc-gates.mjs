import assert from 'node:assert/strict';

import { evaluateBrakeAssists } from '../src/vehicle-v24/powertrain.js';

const radius = 0.34;
const config = { brakeTorque: 4000, mass: 1900 };
let checks = 0;

function evaluate(overrides = {}) {
  return evaluateBrakeAssists({
    serviceBrake: 0,
    parkingBrake: 0,
    bodyLongSpeed: 20,
    oracleYawRate: 0,
    steeringCurvature: 0,
    wheelOmega: [20 / radius, 20 / radius, 20 / radius, 20 / radius],
    effectiveRadii: [radius, radius, radius, radius],
    drivenWheels: [false, false, true, true],
    groundedCount: 4,
    normalLoads: [5600, 5600, 3700, 3700],
    steerCommand: 0,
    config,
    ...overrides,
  });
}

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  checks += 1;
}

function ok(value, message) {
  assert.ok(value, message);
  checks += 1;
}

const symmetric = evaluate({ serviceBrake: 1 });
equal(symmetric.escActive, false, 'symmetric straight braking must not invent ESC yaw correction');
equal(symmetric.escBrakeAuthority, 1, 'full service brake must provide full maneuver authority');

const brakeYaw = evaluate({ serviceBrake: 1, oracleYawRate: 0.04 });
equal(brakeYaw.escActive, true, 'real high-speed heavy-brake yaw must be ESC-eligible');
equal(brakeYaw.escBrakeCapacity.filter((value) => value > 0).length, 1, 'ESC must select exactly one wheel');
equal(brakeYaw.escBrakeCapacity[3] > 0, true, 'negative yaw error must select the corrective rear wheel');
ok(Math.max(...brakeYaw.escBrakeCapacity) <= 700, 'ESC request must retain its bounded capacity');

const oppositeYaw = evaluate({ serviceBrake: 1, oracleYawRate: -0.04 });
equal(oppositeYaw.escBrakeCapacity[2] > 0, true, 'positive yaw error must select the opposite rear wheel');

equal(evaluate({ serviceBrake: 1, oracleYawRate: 0.2, bodyLongSpeed: 4.9 }).escActive, false,
  'low-speed ESC must remain disabled');
equal(evaluate({ serviceBrake: 1, oracleYawRate: 0.2, groundedCount: 2 }).escActive, false,
  'ESC must remain disabled with fewer than three grounded wheels');
equal(evaluate({ serviceBrake: 0.3, oracleYawRate: 0.2 }).escActive, false,
  'a light pedal brush must not authorize straight-line ESC');
equal(evaluate({ serviceBrake: 0, oracleYawRate: 0.2 }).escActive, false,
  'uncommanded yaw while coasting must not authorize ESC');
equal(evaluate({ serviceBrake: 1, oracleYawRate: 0.01 }).escActive, false,
  'heavy braking inside the bounded yaw deadband must not trigger ESC');

const steered = evaluate({ steerCommand: 0.5, steeringCurvature: 0.01, oracleYawRate: -0.08 });
equal(steered.escActive, true, 'the existing deliberate-steering ESC path must remain active');

console.log(JSON.stringify({
  schema: 'streetrush.vehicle-v24.esc-gates.v1',
  status: 'PASS',
  checks,
}));
