import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { createJavaScriptPhysicsScheduler } from '../src/physics-scheduler-owner.js';
import { loadSharedCoreCapabilities } from '../src/shared-core-owner.js';

const wasmBytes = await readFile(new URL('../src/generated/streetrush_core.wasm', import.meta.url));
const realSource = await WebAssembly.instantiate(wasmBytes);
const realExports = realSource.instance.exports;

function sourceWith(getOverride) {
  const exports = Object.fromEntries(
    Object.keys(realExports).map((property) => {
      const override = getOverride(property);
      return [property, override === undefined ? realExports[property] : override];
    }),
  );
  return {
    instance: { exports },
  };
}

function compareSchedulers(actual, label) {
  const expected = createJavaScriptPhysicsScheduler();
  for (const [index, delta] of [0, 1 / 240, 1 / 60, 0.2, 0.049].entries()) {
    assert.deepEqual(actual.advance(delta), expected.advance(delta), `${label} frame ${index}`);
  }
}

let instantiateCount = 0;
const full = await loadSharedCoreCapabilities({
  instantiate: async () => {
    instantiateCount += 1;
    return realSource;
  },
});
assert.equal(instantiateCount, 1);
assert.equal(full.loadFallbackReason, null);
assert.equal(full.scheduler.owner, 'rust-wasm');
assert.equal(full.raceProgress.owner, 'rust-wasm');
compareSchedulers(full.scheduler, 'full shared core');

const timingMissing = await loadSharedCoreCapabilities({
  instantiate: async () => sourceWith((property) => (
    property === 'streetrush_timing_contract_version' ? null : undefined
  )),
});
assert.equal(timingMissing.scheduler.owner, 'rust-wasm');
assert.equal(timingMissing.raceProgress.owner, 'javascript');
assert.equal(timingMissing.raceProgress.fallbackReason.code, 'wasm-export-missing');
compareSchedulers(timingMissing.scheduler, 'timing-missing isolation');

const schedulerMissing = await loadSharedCoreCapabilities({
  instantiate: async () => sourceWith((property) => (
    property === 'streetrush_plan_physics_steps' ? null : undefined
  )),
});
assert.equal(schedulerMissing.scheduler.owner, 'javascript');
assert.equal(schedulerMissing.scheduler.fallbackReason.code, 'wasm-export-missing');
assert.equal(schedulerMissing.raceProgress.owner, 'rust-wasm');
compareSchedulers(schedulerMissing.scheduler, 'scheduler-missing isolation');

const schedulerMismatch = await loadSharedCoreCapabilities({
  instantiate: async () => sourceWith((property) => (
    property === 'streetrush_fixed_dt_seconds' ? () => 1 / 60 : undefined
  )),
});
assert.equal(schedulerMismatch.scheduler.owner, 'javascript');
assert.equal(schedulerMismatch.scheduler.fallbackReason.code, 'wasm-contract-mismatch');
assert.equal(schedulerMismatch.raceProgress.owner, 'rust-wasm');

const timingMismatch = await loadSharedCoreCapabilities({
  instantiate: async () => sourceWith((property) => (
    property === 'streetrush_timing_contract_version' ? () => 999 : undefined
  )),
});
assert.equal(timingMismatch.scheduler.owner, 'rust-wasm');
assert.equal(timingMismatch.raceProgress.owner, 'javascript');
assert.equal(timingMismatch.raceProgress.fallbackReason.code, 'wasm-contract-mismatch');

let fetchCount = 0;
const missingCore = await loadSharedCoreCapabilities({
  fetchImpl: async () => {
    fetchCount += 1;
    return { ok: false, status: 404 };
  },
});
assert.equal(fetchCount, 1);
assert.equal(missingCore.loadFallbackReason.code, 'wasm-fetch-failed');
assert.equal(missingCore.scheduler.owner, 'javascript');
assert.equal(missingCore.raceProgress.owner, 'javascript');
assert.deepEqual(missingCore.scheduler.fallbackReason, missingCore.loadFallbackReason);
assert.deepEqual(missingCore.raceProgress.fallbackReason, missingCore.loadFallbackReason);

instantiateCount = 0;
const timeout = await loadSharedCoreCapabilities({
  instantiate: () => {
    instantiateCount += 1;
    return new Promise(() => {});
  },
  timeoutMs: 1,
});
assert.equal(instantiateCount, 1);
assert.equal(timeout.loadFallbackReason.code, 'wasm-load-timeout');
assert.equal(timeout.scheduler.owner, 'javascript');
assert.equal(timeout.raceProgress.owner, 'javascript');

console.log('PASS shared core instantiates once and exposes scheduler plus race-progress capabilities');
console.log('PASS load, scheduler, and timing failures remain isolated with structured reasons');
