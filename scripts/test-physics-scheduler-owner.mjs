import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  createJavaScriptPhysicsScheduler,
  loadPhysicsScheduler,
} from '../src/physics-scheduler-owner.js';

const wasmPath = fileURLToPath(new URL(
  '../src/generated/streetrush_core.wasm',
  import.meta.url,
));
const wasmBytes = await readFile(wasmPath);
const instantiateRealCore = () => WebAssembly.instantiate(wasmBytes);

function compareSequence(actual, expected, deltas, label) {
  for (const [index, delta] of deltas.entries()) {
    const actualPlan = actual.advance(delta);
    const expectedPlan = expected.advance(delta);
    assert.deepEqual(actualPlan, expectedPlan, `${label} frame ${index}`);
  }
}

const wasmScheduler = await loadPhysicsScheduler({ instantiate: instantiateRealCore });
assert.equal(wasmScheduler.owner, 'rust-wasm');
assert.equal(wasmScheduler.fallbackReason, null);
compareSequence(
  wasmScheduler,
  createJavaScriptPhysicsScheduler(),
  [1 / 240, 1 / 240, 1 / 60, 0.2, 1 / 1000, 0.049, 1 / 120],
  'real WASM parity',
);
wasmScheduler.reset();
assert.equal(wasmScheduler.accumulatorSeconds, 0);

const missing = await loadPhysicsScheduler({
  fetchImpl: async () => ({ ok: false, status: 404 }),
});
assert.equal(missing.owner, 'javascript');
assert.equal(missing.fallbackReason.code, 'wasm-fetch-failed');

const compileFailure = await loadPhysicsScheduler({
  instantiate: async () => {
    throw new WebAssembly.CompileError('injected invalid module');
  },
});
assert.equal(compileFailure.owner, 'javascript');
assert.equal(compileFailure.fallbackReason.code, 'wasm-instantiate-failed');

const timeout = await loadPhysicsScheduler({
  instantiate: () => new Promise(() => {}),
  timeoutMs: 1,
});
assert.equal(timeout.owner, 'javascript');
assert.equal(timeout.fallbackReason.code, 'wasm-load-timeout');

const missingExport = await loadPhysicsScheduler({
  instantiate: async () => ({ instance: { exports: {} } }),
});
assert.equal(missingExport.owner, 'javascript');
assert.equal(missingExport.fallbackReason.code, 'wasm-export-missing');

const contractMismatch = await loadPhysicsScheduler({
  instantiate: async () => ({
    instance: {
      exports: {
        streetrush_fixed_dt_seconds: () => 1 / 60,
        streetrush_max_frame_dt_seconds: () => 0.05,
        streetrush_max_physics_steps: () => 6,
        streetrush_plan_physics_steps: () => 0,
        streetrush_plan_remainder_seconds: () => 0,
      },
    },
  }),
});
assert.equal(contractMismatch.owner, 'javascript');
assert.equal(contractMismatch.fallbackReason.code, 'wasm-contract-mismatch');

for (const [label, scheduler] of [
  ['missing asset fallback', missing],
  ['compile fallback', compileFailure],
  ['timeout fallback', timeout],
  ['missing export fallback', missingExport],
  ['contract fallback', contractMismatch],
]) {
  compareSequence(
    scheduler,
    createJavaScriptPhysicsScheduler(),
    [0, -1, 1 / 60, 1 / 30, 0.5],
    label,
  );
}

console.log('PASS real Rust WASM owns fixed-step plans with frame-by-frame JS parity');
console.log('PASS fetch, timeout, instantiate, export, and contract failures deterministically fall back to JS');
