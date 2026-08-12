import assert from 'node:assert/strict';
import { FIXED_DT } from '../src/config.js';
import {
  MAX_FRAME_DT,
  MAX_PHYSICS_STEPS,
  accumulatePhysicsTime,
  clampFrameDelta,
} from '../src/physics-scheduling.js';

assert.equal(MAX_PHYSICS_STEPS, 6);
assert.equal(clampFrameDelta(-1), 0);
assert.equal(clampFrameDelta(0.05), 0.05);
assert.equal(clampFrameDelta(0.2), MAX_FRAME_DT);

function simulatedSeconds(renderFps, realSeconds = 60) {
  const renderDelta = 1 / renderFps;
  const frameCount = Math.round(realSeconds * renderFps);
  let accumulator = 0;
  let steps = 0;
  for (let frame = 0; frame < frameCount; frame += 1) {
    accumulator = accumulatePhysicsTime(accumulator, renderDelta);
    while (accumulator >= FIXED_DT) {
      accumulator -= FIXED_DT;
      steps += 1;
    }
  }
  return steps * FIXED_DT;
}

for (const fps of [60, 30, 24, 20]) {
  assert.ok(Math.abs(simulatedSeconds(fps) - 60) < 0.001, `${fps} FPS keeps race time`);
}
// Below the configured 50ms frame guard, the game intentionally caps catch-up
// rather than allowing an expensive spiral; this behavior is explicit and
// testable instead of silently losing time at the 20 FPS boundary.
assert.ok(Math.abs(simulatedSeconds(15) - 45) < 0.001);

console.log('PASS frame budget stays aligned at 60/30/24/20 FPS');
console.log('PASS below-20 FPS behavior remains explicitly capped');
