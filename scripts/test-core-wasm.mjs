import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { FIXED_DT } from '../src/config.js';
import {
  MAX_FRAME_DT,
  MAX_PHYSICS_STEPS,
  accumulatePhysicsTime,
} from '../src/physics-scheduling.js';

const wasmPath = fileURLToPath(new URL(
  '../target/wasm32-unknown-unknown/debug/streetrush_core.wasm',
  import.meta.url,
));
const bytes = await readFile(wasmPath);
const { instance } = await WebAssembly.instantiate(bytes);
const core = instance.exports;

assert.equal(core.streetrush_fixed_dt_seconds(), FIXED_DT);
assert.equal(core.streetrush_max_frame_dt_seconds(), MAX_FRAME_DT);
assert.equal(core.streetrush_max_physics_steps(), MAX_PHYSICS_STEPS);

function runJs(deltas) {
  let accumulator = 0;
  let steps = 0;
  for (const delta of deltas) {
    accumulator = accumulatePhysicsTime(accumulator, delta);
    let frameSteps = 0;
    while (accumulator >= FIXED_DT && frameSteps < MAX_PHYSICS_STEPS) {
      accumulator -= FIXED_DT;
      frameSteps += 1;
    }
    steps += frameSteps;
  }
  return { accumulator, steps };
}

function runWasm(deltas) {
  let accumulator = 0;
  let steps = 0;
  for (const delta of deltas) {
    steps += core.streetrush_plan_physics_steps(accumulator, delta);
    accumulator = core.streetrush_plan_remainder_seconds(accumulator, delta);
  }
  return { accumulator, steps };
}

for (const renderFps of [60, 30, 24, 20, 15]) {
  const deltas = Array(renderFps * 60).fill(1 / renderFps);
  const js = runJs(deltas);
  const wasm = runWasm(deltas);
  assert.equal(wasm.steps, js.steps, `${renderFps} FPS step count`);
  assert.ok(
    Math.abs(wasm.accumulator - js.accumulator) < 1e-12,
    `${renderFps} FPS accumulator`,
  );
  assert.equal(
    core.streetrush_simulate_step_count(1 / renderFps, renderFps * 60),
    BigInt(js.steps),
    `${renderFps} FPS direct WASM oracle`,
  );
}

const irregularDeltas = [-1, 0, 1 / 240, 1 / 60, 0.2, 1 / 1000, 0.049, 1 / 120];
const irregularJs = runJs(irregularDeltas);
const irregularWasm = runWasm(irregularDeltas);
assert.equal(irregularWasm.steps, irregularJs.steps);
assert.ok(Math.abs(irregularWasm.accumulator - irregularJs.accumulator) < 1e-12);

console.log('PASS raw WASM fixed-step scheduler matches the JavaScript oracle');
