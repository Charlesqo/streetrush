import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { RaceTimingSession, TimingStore } from '../src/race-timing.js';
import { createJavaScriptRaceProgressCore } from '../src/race-progress-core.js';
import { loadSharedCoreCapabilities } from '../src/shared-core-owner.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
    this.writeCount = 0;
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.writeCount += 1;
    this.values.set(key, String(value));
  }
}

const wasmBytes = await readFile(new URL('../src/generated/streetrush_core.wasm', import.meta.url));
const sharedCore = await loadSharedCoreCapabilities({
  instantiate: () => WebAssembly.instantiate(wasmBytes),
});
assert.equal(sharedCore.raceProgress.owner, 'rust-wasm');

const fallbackCore = createJavaScriptRaceProgressCore({
  fallbackReason: { code: 'injected-fallback', message: 'fixture' },
});

function createSession(progressCore) {
  const storage = new MemoryStorage();
  const session = new RaceTimingSession({
    trackId: 'timing-shadow-oracle',
    carId: 'mx5',
    totalLaps: 2,
    checkpointCount: 3,
    sectorCheckpoints: [1, 2, 3],
    medalTargetsMs: { gold: 12000, silver: 15000, bronze: 18000 },
    store: new TimingStore({
      storage,
      now: () => '2026-08-13T00:00:00.000Z',
    }),
    ...(progressCore ? { progressCore } : {}),
  });
  return { session, storage };
}

function runScenario(progressCore) {
  const { session, storage } = createSession(progressCore);
  const actions = [];
  const capture = (name, result) => {
    actions.push({ name, result, snapshot: session.snapshot(), record: session.getRecord() });
  };

  capture('start-invalid-run', session.start());
  for (let index = 1; index <= 3; index += 1) {
    capture(`fractional-${index}`, session.advance(1000 / 3));
  }
  capture('wrong-checkpoint', session.passCheckpoint(2));
  capture('invalidate-first', session.invalidate('track-limits'));
  capture('invalidate-duplicate', session.invalidate('track-limits'));
  capture('invalidate-second-reason', session.invalidate('manual-reset'));
  capture('invalid-sector-1', session.passCheckpoint(1));
  capture('invalid-advance-2', session.advance(2000.4));
  capture('invalid-sector-2', session.passCheckpoint(2));
  capture('invalid-advance-3', session.advance(3000.4));
  capture('invalid-lap-finish', session.passCheckpoint(0));

  for (const [index, deltaMs] of [900.2, 1900.2, 2900.2].entries()) {
    capture(`second-lap-advance-${index}`, session.advance(deltaMs));
    capture(`second-lap-checkpoint-${index}`, session.passCheckpoint(index === 2 ? 0 : index + 1));
  }
  capture('finished-advance', session.advance(500));
  capture('finished-checkpoint', session.passCheckpoint(0));
  capture('finished-invalidate', session.invalidate('finished'));

  capture('restart', session.restart());
  for (const [index, deltaMs] of [1000, 2000, 3000, 900, 1900, 2900].entries()) {
    capture(`valid-advance-${index}`, session.advance(deltaMs));
    capture(
      `valid-checkpoint-${index}`,
      session.passCheckpoint(index % 3 === 2 ? 0 : index % 3 + 1),
    );
  }

  return {
    progressOwner: session.progressOwner,
    actions,
    summary: session.getSummary(),
    record: session.getRecord(),
    storageWrites: storage.writeCount,
  };
}

const legacy = runScenario(null);
const wasmShadow = runScenario(sharedCore.raceProgress);
const fallbackShadow = runScenario(fallbackCore);

assert.equal(legacy.progressOwner, 'legacy');
assert.equal(wasmShadow.progressOwner, 'rust-wasm-shadow');
assert.equal(fallbackShadow.progressOwner, 'javascript-shadow');

for (const candidate of [wasmShadow, fallbackShadow]) {
  assert.deepEqual(candidate.actions, legacy.actions);
  assert.deepEqual(candidate.summary, legacy.summary);
  assert.deepEqual(candidate.record, legacy.record);
  assert.equal(candidate.storageWrites, legacy.storageWrites);
}

assert.equal(legacy.storageWrites, 3);
assert.equal(legacy.summary.timeMs, 11700);
assert.equal(legacy.summary.medal, 'gold');

console.log(`PASS injected timing shadows preserve ${legacy.actions.length} full legacy action results`);
console.log('PASS WASM and fallback shadows preserve record state, event snapshots, and save count');
