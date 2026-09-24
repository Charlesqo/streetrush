import assert from 'node:assert/strict';
import {
  distributeDriverServiceBrake,
  evaluateBrakeAssists,
} from '../src/vehicle-v24/powertrain.js';

let checks = 0;
function close(actual, expected, label, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance,
    `${label}: ${actual} != ${expected}`);
  checks += 1;
}
function ok(value, label) {
  assert.ok(value, label);
  checks += 1;
}
const args = {
  brakeTorque: 5850,
  mass: 2435,
  normalLoads: [8900, 8900, 3100, 3100],
  bodyLongSpeed: 88,
  groundedCount: 4,
};

const highSpeed = distributeDriverServiceBrake(args);
close(highSpeed.frontLoadShare, 17800 / 24000, 'front load share');
close(highSpeed.frontShare, 0.86, 'front-lock safety margin reaches bounded share');
close(highSpeed.driverBase.reduce((sum, value) => sum + value, 0), 5850,
  'total pedal authority remains fixed');
close(highSpeed.driverBase[0], highSpeed.driverBase[1], 'front left/right equality');
close(highSpeed.driverBase[2], highSpeed.driverBase[3], 'rear left/right equality');
ok(highSpeed.driverBase[0] > 0.31 * 5850, 'load transfer exposes front capacity');
close(highSpeed.serviceLimit[2], 0.19 * 5850, 'rear assist authority is retained');
close(highSpeed.serviceLimit[3], 0.19 * 5850, 'rear assist authority remains symmetric');

const lowSpeed = distributeDriverServiceBrake({ ...args, bodyLongSpeed: 5 });
close(lowSpeed.frontShare, 0.62, 'low-speed fallback');
const partialGround = distributeDriverServiceBrake({ ...args, groundedCount: 3 });
close(partialGround.frontShare, 0.62, 'partial-ground fallback');
const invalidLoads = distributeDriverServiceBrake({ ...args, normalLoads: [0, 0, 0, 0] });
close(invalidLoads.frontShare, 0.62, 'invalid-load fallback');
const clamped = distributeDriverServiceBrake({
  ...args,
  normalLoads: [12000, 12000, 100, 100],
});
close(clamped.frontShare, 0.86, 'front share upper bound');

const assists = evaluateBrakeAssists({
  serviceBrake: 1,
  parkingBrake: 0,
  bodyLongSpeed: 88,
  oracleYawRate: 0,
  steeringCurvature: 0,
  wheelOmega: Array(4).fill(88 / 0.36),
  effectiveRadii: Array(4).fill(0.36),
  drivenWheels: [true, true, true, true],
  groundedCount: 4,
  normalLoads: args.normalLoads,
  steerCommand: 0,
  config: { brakeTorque: args.brakeTorque, mass: args.mass },
});
close(assists.driverServiceCapacity[0], assists.driverServiceCapacity[1],
  'evaluated front pair equality');
close(assists.driverServiceCapacity[2], assists.driverServiceCapacity[3],
  'evaluated rear pair equality');
close(assists.driverServiceCapacity.reduce((sum, value) => sum + value, 0), 5850,
  'evaluated total driver request');
ok(assists.absModulation.every((value) => value === 1), 'matching wheel speed leaves ABS inactive');
ok(assists.escBrakeCapacity.every((value) => value === 0), 'zero steering leaves ESC inactive');
ok(assists.tcsBrakeCapacity.every((value) => value === 0), 'matching wheel speed leaves TCS braking inactive');

console.log(JSON.stringify({
  status: 'PASS',
  checks,
  scope: 'load-aware-symmetric-service-brake-distribution',
}));
