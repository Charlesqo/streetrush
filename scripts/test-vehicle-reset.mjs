import assert from 'node:assert/strict';

import { CARS } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  runFor,
  zeroInput,
} from './physics-harness.mjs';

const telemetryNumbers = [
  'speedKmh',
  'signedSpeedKmh',
  'rpm',
  'throttle',
  'brake',
  'steer',
  'longitudinalAcceleration',
  'lateralAcceleration',
];

function dirtyResetOwnedState(vehicle) {
  vehicle.body.setTranslation({ x: 12, y: 4, z: -8 }, true);
  vehicle.body.setLinvel({ x: 7, y: -3, z: 11 }, true);
  vehicle.body.setAngvel({ x: 0.4, y: -0.7, z: 0.2 }, true);
  vehicle.steerAngle = 0.42;
  vehicle.engineLoad = 0.81;
  vehicle.engineRpm = vehicle.config.redline * 0.75;
  vehicle.reverseHold = 0.11;
  vehicle.shiftTimer = 0.09;
  vehicle.previousLongSpeed = 18;
  vehicle.smoothedLongAcceleration = -2.5;
  vehicle.stuckTimer = 3;
  vehicle.gear = Math.min(2, vehicle.config.gears.length);
  vehicle.reverse = true;

  for (const wheel of vehicle.wheels) {
    wheel.omega = 23;
    wheel.grounded = true;
    wheel.compression = 0.12;
    wheel.springForce = 999;
    wheel.hit = { stale: true };
    wheel.surface = 'gravel';
    wheel.previousVisualAngle = 11;
    wheel.visualAngle = 12;
  }

  for (const key of telemetryNumbers) vehicle.telemetry[key] = 17;
  vehicle.telemetry.gear = 2;
  vehicle.telemetry.reverse = true;
  vehicle.telemetry.surface = 'gravel';
  vehicle.telemetry.absActive = true;
  vehicle.telemetry.tcsActive = true;
  vehicle.telemetry.stabilityActive = true;
  for (const wheel of vehicle.telemetry.wheels) {
    wheel.grounded = true;
    wheel.load = 400;
    wheel.suspension = 0.1;
    wheel.slipRatio = 0.3;
    wheel.slipAngle = 0.2;
    wheel.slipPower = 120;
    wheel.surface = 'gravel';
    wheel.contactPoint.set(4, 5, 6);
  }
}

function collectResetMismatches(vehicle) {
  const mismatches = [];
  const expect = (path, actual, expected) => {
    if (!Object.is(actual, expected)) mismatches.push(`${path}: ${actual} != ${expected}`);
  };
  const expectVector = (path, actual, expected) => {
    const values = Array.isArray(actual) ? actual : [actual.x, actual.y, actual.z];
    if (values.length !== expected.length || values.some((value, index) => !Object.is(value, expected[index]))) {
      mismatches.push(`${path}: [${values.join(',')}] != [${expected.join(',')}]`);
    }
  };

  expectVector('body.linvel', vehicle.body.linvel(), [0, 0, 0]);
  expectVector('body.angvel', vehicle.body.angvel(), [0, 0, 0]);
  expect('steerAngle', vehicle.steerAngle, 0);
  expect('engineLoad', vehicle.engineLoad, 0);
  expect('engineRpm', vehicle.engineRpm, vehicle.config.idle);
  expect('reverseHold', vehicle.reverseHold, 0);
  expect('shiftTimer', vehicle.shiftTimer, 0);
  expect('previousLongSpeed', vehicle.previousLongSpeed, 0);
  expect('smoothedLongAcceleration', vehicle.smoothedLongAcceleration, 0);
  expect('stuckTimer', vehicle.stuckTimer, 0);
  expect('gear', vehicle.gear, 1);
  expect('reverse', vehicle.reverse, false);

  for (const [index, wheel] of vehicle.wheels.entries()) {
    const path = `wheels[${index}]`;
    expect(`${path}.omega`, wheel.omega, 0);
    expect(`${path}.grounded`, wheel.grounded, false);
    expect(`${path}.compression`, wheel.compression, 0);
    expect(`${path}.springForce`, wheel.springForce, 0);
    expect(`${path}.hit`, wheel.hit, null);
    expect(`${path}.surface`, wheel.surface, 'asphalt');
    expect(`${path}.previousVisualAngle`, wheel.previousVisualAngle, 0);
    expect(`${path}.visualAngle`, wheel.visualAngle, 0);
  }

  const telemetryExpected = {
    speedKmh: 0,
    signedSpeedKmh: 0,
    rpm: vehicle.config.idle,
    gear: 1,
    reverse: false,
    throttle: 0,
    brake: 0,
    steer: 0,
    longitudinalAcceleration: 0,
    lateralAcceleration: 0,
    surface: 'asphalt',
    absActive: false,
    tcsActive: false,
    stabilityActive: false,
  };
  for (const [key, expected] of Object.entries(telemetryExpected)) {
    expect(`telemetry.${key}`, vehicle.telemetry[key], expected);
  }
  for (const [index, wheel] of vehicle.telemetry.wheels.entries()) {
    const path = `telemetry.wheels[${index}]`;
    expect(`${path}.grounded`, wheel.grounded, false);
    expect(`${path}.load`, wheel.load, 0);
    expect(`${path}.suspension`, wheel.suspension, 0);
    expect(`${path}.slipRatio`, wheel.slipRatio, 0);
    expect(`${path}.slipAngle`, wheel.slipAngle, 0);
    expect(`${path}.slipPower`, wheel.slipPower, 0);
    expect(`${path}.surface`, wheel.surface, 'asphalt');
    expectVector(`${path}.contactPoint`, wheel.contactPoint, [0, 0, 0]);
  }
  return mismatches;
}

const failures = [];
for (const config of CARS) {
  const rig = createVehicleRig(config);
  try {
    runFor(rig, 0.5, zeroInput({ throttle: 0.7, steer: 0.4, driveIntent: 1 }));
    dirtyResetOwnedState(rig.vehicle);
    rig.vehicle.reset(0);
    const mismatches = collectResetMismatches(rig.vehicle);
    if (mismatches.length > 0) failures.push({ carId: config.id, mismatches });
  } finally {
    destroyVehicleRig(rig);
  }
}

const failedFields = [...new Set(
  failures.flatMap(({ mismatches }) => mismatches.map((mismatch) => mismatch.split(':', 1)[0])),
)];
assert.equal(
  failures.length,
  0,
  `vehicle reset left owned state dirty for ${failures.map(({ carId }) => carId).join(',')}; `
    + `fields=${failedFields.join(',')}`,
);
console.log(`PASS vehicle reset clears owned runtime state for ${CARS.length}/${CARS.length} cars`);
