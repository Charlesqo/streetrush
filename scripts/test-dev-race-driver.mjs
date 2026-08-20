import assert from 'node:assert/strict';

import { computeDevRaceDriverInput } from '../src/dev-race-driver.js';

const base = {
  positionX: 0,
  positionZ: 0,
  forwardX: 0,
  forwardZ: 1,
  targetX: 0,
  targetZ: 20,
  trackOffset: 0,
  curvatureRadians: 0,
  speedKmh: 0,
};

const straight = computeDevRaceDriverInput(base);
assert.equal(straight.throttle, 1);
assert.equal(straight.brake, 0);
assert.ok(Math.abs(straight.steer) < 1e-12);
assert.deepEqual(
  Object.keys(straight).sort(),
  ['brake', 'driveIntent', 'handbrake', 'reset', 'shiftDown', 'shiftUp', 'steer', 'targetSpeedKmh', 'throttle', 'toggleTransmission'].sort(),
);

const right = computeDevRaceDriverInput({ ...base, targetX: 8, targetZ: 12, speedKmh: 35 });
assert.ok(right.steer > 0.2, `expected right steer, got ${right.steer}`);

const recoverCenter = computeDevRaceDriverInput({ ...base, trackOffset: 4, speedKmh: 35 });
assert.ok(recoverCenter.steer < -0.2, `expected center recovery, got ${recoverCenter.steer}`);

const corner = computeDevRaceDriverInput({ ...base, curvatureRadians: 0.42, speedKmh: 80 });
assert.ok(corner.targetSpeedKmh < 40, `expected corner speed below 40, got ${corner.targetSpeedKmh}`);
assert.ok(corner.brake > 0.5, `expected braking, got ${corner.brake}`);
assert.equal(corner.throttle, 0);

assert.throws(
  () => computeDevRaceDriverInput({ ...base, speedKmh: Number.NaN }),
  /speedKmh must be finite/,
);
assert.throws(
  () => computeDevRaceDriverInput({ ...base, targetX: 0, targetZ: 0 }),
  /target must differ from position/,
);

console.log('PASS dev race driver generates bounded physical inputs without race-state mutation');
