import assert from 'node:assert/strict';

import {
  TIRE_REGIME,
  createTireState,
  solveAcceptedTireContact,
} from '../src/vehicle-v24/tire.js';

let checks = 0;

function equal(actual, expected, message) {
  assert.equal(actual, expected, message);
  checks += 1;
}

function close(actual, expected, tolerance, message) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);
  checks += 1;
}

function solve(previousState, velocityY) {
  return solveAcceptedTireContact({
    previousState,
    inContact: true,
    normalLoad: 5000,
    velocityX: 0.04,
    velocityY,
    omega: 0,
    camber: 0,
    muScale: 1,
    dt: 1 / 120,
    unloadedRadius: 0.34,
    delassus: [[0.001, 0], [0, 0.001]],
  });
}

const first = solve(createTireState(), 0.1);
equal(first.regime, TIRE_REGIME.FRICTION_CONTACT, 'test vector must use low-speed friction contact');
equal(first.solver.frictionForceCommit, 0.5, 'fixed-step contact force commit');
close(first.impulse[0], first.solver.rawImpulse[0] * 0.5, 1e-12,
  'first longitudinal impulse must be committed consistently');
close(first.impulse[1], first.solver.rawImpulse[1] * 0.5, 1e-12,
  'first lateral impulse must be committed consistently');
close(first.forceX, first.impulse[0] / (1 / 120), 1e-12,
  'longitudinal force and committed impulse must agree');
close(first.forceY, first.impulse[1] / (1 / 120), 1e-12,
  'lateral force and committed impulse must agree');
equal(first.nextState.frictionForce.length, 2, 'committed force must be retained by the tire owner');

const second = solve(first.nextState, 0.1);
close(
  second.forceY,
  first.forceY + 0.5 * (second.solver.rawImpulse[1] / (1 / 120) - first.forceY),
  1e-9,
  'steady low-speed request must converge toward full constitutive force',
);
assert.ok(Math.abs(second.forceY) > Math.abs(first.forceY),
  'steady request must not remain permanently halved');
checks += 1;

const reversed = solve(second.nextState, -0.1);
assert.ok(Math.abs(reversed.forceY) < Math.abs(reversed.solver.rawImpulse[1] / (1 / 120)),
  'a one-frame reversal must be attenuated instead of committed in full');
checks += 1;
close(reversed.wheelContactTorque, -reversed.effectiveRadius * reversed.forceX + reversed.momentY, 1e-9,
  'wheel torque must use the committed longitudinal force');
assert.ok(reversed.forceUtilization <= 1 + 1e-12,
  'committed force must remain inside the current friction ellipse');
checks += 1;

console.log(JSON.stringify({
  schema: 'streetrush.vehicle-v24.friction-contact-relaxation.v1',
  status: 'PASS',
  checks,
}));
