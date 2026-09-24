import assert from 'node:assert/strict';
import {
  createSteeringState,
  prepareSteeringTrial,
} from '../src/vehicle-v24/steering.js';

let checks = 0;
function close(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1e-12,
    `${label}: ${actual} != ${expected}`);
  checks += 1;
}

function atJounce(jounce) {
  return prepareSteeringTrial({
    state: createSteeringState(),
    streetRushCommand: 0,
    speed: 16,
    dt: 1 / 120,
    maximumAngle: 0.48,
    wheelbase: 2.7,
    trackWidth: 1.7,
    leftJounce: jounce,
    rightJounce: jounce,
  });
}

const baseline = atJounce(0);
for (const jounce of [-0.08, -0.05, 0, 0.05, 0.08]) {
  const trial = atJounce(jounce);
  close(trial.streetRushWheelAngles[0], baseline.streetRushWheelAngles[0],
    `left steering helper is jounce-invariant at ${jounce}`);
  close(trial.streetRushWheelAngles[1], baseline.streetRushWheelAngles[1],
    `right steering helper is jounce-invariant at ${jounce}`);
  close(trial.streetRushWheelAngles[0], -trial.oracleWheelAngles.left,
    `left oracle-to-host mapping at ${jounce}`);
  close(trial.streetRushWheelAngles[1], -trial.oracleWheelAngles.right,
    `right oracle-to-host mapping at ${jounce}`);
}

console.log(JSON.stringify({
  status: 'PASS',
  checks,
  scope: 'single-owner-jounce-toe-and-handedness',
}));
