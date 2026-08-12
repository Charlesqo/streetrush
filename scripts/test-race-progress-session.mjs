import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { RaceTimingSession, TimingStore } from '../src/race-timing.js';
import { createJavaScriptRaceProgressCore } from '../src/race-progress-core.js';
import { RaceProgressSession } from '../src/race-progress-session.js';
import { loadSharedCoreCapabilities } from '../src/shared-core-owner.js';

const wasmBytes = await readFile(new URL('../src/generated/streetrush_core.wasm', import.meta.url));
const sharedCore = await loadSharedCoreCapabilities({
  instantiate: () => WebAssembly.instantiate(wasmBytes),
});
assert.equal(sharedCore.raceProgress.owner, 'rust-wasm');

const config = {
  totalLaps: 2,
  checkpointCount: 3,
  sectorCheckpoints: [1, 2, 3],
};
const legacy = new RaceTimingSession({
  trackId: 'progress-session-oracle',
  carId: 'mx5',
  ...config,
  medalTargetsMs: { gold: 12000, silver: 15000, bronze: 18000 },
  store: new TimingStore({ storage: null }),
});
const wasmProgress = new RaceProgressSession({ ...config, core: sharedCore.raceProgress });
const fallbackProgress = new RaceProgressSession({
  ...config,
  core: createJavaScriptRaceProgressCore({
    fallbackReason: { code: 'injected-fallback', message: 'fixture' },
  }),
});

const PROGRESS_FIELDS = [
  'status',
  'runTimeMs',
  'currentLapNumber',
  'lapTimeMs',
  'currentSectorNumber',
  'sectorTimeMs',
  'checkpointsPassed',
  'checkpointOrdinal',
  'checkpointInLap',
  'expectedCheckpointIndex',
  'currentLapValid',
];
let comparisons = 0;

function legacyProgress() {
  const snapshot = legacy.snapshot();
  return Object.fromEntries(PROGRESS_FIELDS.map((field) => [field, snapshot[field]]));
}

function compare(label) {
  assert.deepEqual(wasmProgress.snapshot(), legacyProgress(), `${label} WASM`);
  assert.deepEqual(fallbackProgress.snapshot(), legacyProgress(), `${label} fallback`);
  comparisons += 1;
}

function start(label) {
  legacy.start();
  wasmProgress.start();
  fallbackProgress.start();
  compare(label);
}

function advance(deltaMs, label) {
  legacy.advance(deltaMs);
  wasmProgress.advance(deltaMs);
  fallbackProgress.advance(deltaMs);
  compare(label);
}

function invalidate(reason, label) {
  const expected = Boolean(legacy.invalidate(reason));
  assert.equal(wasmProgress.invalidate(), expected, `${label} WASM event`);
  assert.equal(fallbackProgress.invalidate(), expected, `${label} fallback event`);
  compare(label);
}

function projectLegacyOutcome(events) {
  const checkpoint = events.find(({ type }) => type === 'checkpoint-completed');
  const sector = events.find(({ type }) => type === 'sector-completed');
  const lap = events.find(({ type }) => type === 'lap-completed')?.lap;
  return {
    rejected: events.some(({ type }) => type === 'checkpoint-rejected'),
    accepted: Boolean(checkpoint),
    checkpointOrdinal: checkpoint?.checkpointOrdinal ?? null,
    sectorTimeMs: sector?.timeMs ?? null,
    lapTimeMs: lap?.timeMs ?? null,
    lapValid: lap?.valid ?? null,
    runCompleted: events.some(({ type }) => type === 'run-completed'),
  };
}

function passCheckpoint(index, label) {
  const expected = projectLegacyOutcome(legacy.passCheckpoint(index));
  assert.deepEqual(wasmProgress.passCheckpoint(index), expected, `${label} WASM outcome`);
  assert.deepEqual(
    fallbackProgress.passCheckpoint(index),
    expected,
    `${label} fallback outcome`,
  );
  compare(label);
  return expected;
}

function completeLap(times, prefix) {
  times.forEach((deltaMs, index) => {
    advance(deltaMs, `${prefix} advance ${index + 1}`);
    passCheckpoint(index === 2 ? 0 : index + 1, `${prefix} checkpoint ${index + 1}`);
  });
}

start('invalid run start');
for (let index = 1; index <= 3; index += 1) {
  advance(1000 / 3, `fractional ${index}`);
}
passCheckpoint(2, 'out of order');
invalidate('track-limits', 'first invalidation');
invalidate('track-limits', 'duplicate invalidation');
passCheckpoint(1, 'invalid sector 1');
advance(2000.4, 'invalid sector 2 advance');
passCheckpoint(2, 'invalid sector 2');
advance(3000.4, 'invalid sector 3 advance');
passCheckpoint(0, 'invalid lap finish');
completeLap([900.2, 1900.2, 2900.2], 'valid second lap');
assert.equal(legacy.getSummary().valid, false);

start('valid restart');
completeLap([1000, 2000, 3000], 'valid lap 1');
completeLap([900, 1900, 2900], 'valid lap 2');
assert.equal(legacy.getSummary().timeMs, 11700);
assert.equal(legacy.getSummary().medal, 'gold');

advance(1000, 'finished advance ignored');
assert.deepEqual(
  passCheckpoint(0, 'finished checkpoint ignored'),
  {
    rejected: false,
    accepted: false,
    checkpointOrdinal: null,
    sectorTimeMs: null,
    lapTimeMs: null,
    lapValid: null,
    runCompleted: false,
  },
);
invalidate('finished', 'finished invalidation ignored');

assert.throws(() => wasmProgress.advance(-1), /finite non-negative/);
assert.throws(() => fallbackProgress.passCheckpoint(3), /between 0 and 2/);

console.log(`PASS RaceProgressSession WASM and JS fallback match legacy across ${comparisons} snapshots`);
console.log('PASS wrapper owns only pure progress; records, reasons, persistence, and events remain legacy-owned');
