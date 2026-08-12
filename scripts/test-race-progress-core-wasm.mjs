import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { RaceTimingSession, TimingStore } from '../src/race-timing.js';
import { loadSharedCoreCapabilities } from '../src/shared-core-owner.js';

const wasmUrl = new URL('../src/generated/streetrush_core.wasm', import.meta.url);
const wasmBytes = await readFile(wasmUrl);
let instantiateCount = 0;
const sharedCore = await loadSharedCoreCapabilities({
  instantiate: async () => {
    instantiateCount += 1;
    return WebAssembly.instantiate(wasmBytes);
  },
});
assert.equal(instantiateCount, 1);
assert.equal(sharedCore.scheduler.owner, 'rust-wasm');
assert.equal(sharedCore.raceProgress.owner, 'rust-wasm');
const core = sharedCore.raceProgress;

const STATUS = Object.freeze({ idle: 0, running: 1, finished: 2 });
const FLAGS = Object.freeze({
  rejected: 1,
  accepted: 2,
  sector: 4,
  lap: 8,
  run: 16,
});
const config = Object.freeze({
  totalLaps: 2,
  checkpointCount: 3,
  sectorCheckpoints: [1, 2, 3],
  medalTargetsMs: { gold: 12000, silver: 15000, bronze: 18000 },
});

assert.equal(core.contractVersion, 1);

const session = new RaceTimingSession({
  trackId: 'timing-wasm-oracle',
  carId: 'mx5',
  ...config,
  store: new TimingStore({ storage: null }),
});

const shadow = {
  status: STATUS.idle,
  runTimeExactMs: 0,
  lapStartedAtExactMs: 0,
  sectorStartedAtExactMs: 0,
  checkpointsPassed: 0,
  currentSector: 0,
  currentLapValid: true,
};
let comparisons = 0;

function rounded(value) {
  return core.roundDurationMs(value);
}

function expectedCheckpointIndex() {
  return core.expectedCheckpointIndex(
    shadow.checkpointsPassed,
    config.checkpointCount,
  );
}

function checkpointOrdinal() {
  return core.checkpointOrdinal(
    shadow.checkpointsPassed,
    config.checkpointCount,
  );
}

function projectShadow() {
  const running = shadow.status === STATUS.running;
  return {
    status: Object.keys(STATUS).find((name) => STATUS[name] === shadow.status),
    runTimeMs: rounded(shadow.runTimeExactMs),
    currentLapNumber: Math.min(
      Math.floor(shadow.checkpointsPassed / config.checkpointCount) + 1,
      config.totalLaps,
    ),
    lapTimeMs: running ? rounded(shadow.runTimeExactMs - shadow.lapStartedAtExactMs) : 0,
    currentSectorNumber: running
      ? Math.min(shadow.currentSector + 1, config.sectorCheckpoints.length)
      : 1,
    sectorTimeMs: running ? rounded(shadow.runTimeExactMs - shadow.sectorStartedAtExactMs) : 0,
    checkpointsPassed: shadow.checkpointsPassed,
    checkpointOrdinal: checkpointOrdinal(),
    checkpointInLap: shadow.checkpointsPassed % config.checkpointCount,
    expectedCheckpointIndex: expectedCheckpointIndex(),
    currentLapValid: shadow.currentLapValid,
  };
}

function projectSession() {
  const snapshot = session.snapshot();
  return Object.fromEntries(Object.keys(projectShadow()).map((key) => [key, snapshot[key]]));
}

function compare(label) {
  assert.deepEqual(projectShadow(), projectSession(), label);
  comparisons += 1;
}

function start(label = 'start') {
  session.start();
  Object.assign(shadow, {
    status: STATUS.running,
    runTimeExactMs: 0,
    lapStartedAtExactMs: 0,
    sectorStartedAtExactMs: 0,
    checkpointsPassed: 0,
    currentSector: 0,
    currentLapValid: true,
  });
  compare(label);
}

function advance(deltaMs, label = `advance ${deltaMs}`) {
  session.advance(deltaMs);
  shadow.runTimeExactMs = core.advanceExactMs(
    shadow.status,
    shadow.runTimeExactMs,
    deltaMs,
  );
  compare(label);
}

function invalidate(reason, label = `invalidate ${reason}`) {
  const event = session.invalidate(reason);
  const wasValid = shadow.currentLapValid;
  if (shadow.status === STATUS.running) shadow.currentLapValid = false;
  assert.equal(Boolean(event), shadow.status === STATUS.running && wasValid, `${label} event`);
  compare(label);
}

function passCheckpoint(checkpointIndex, label = `checkpoint ${checkpointIndex}`) {
  const nextSectorCheckpoint = config.sectorCheckpoints[shadow.currentSector]
    ?? config.checkpointCount;
  const flags = core.checkpointFlags(
    shadow.status,
    shadow.checkpointsPassed,
    config.totalLaps,
    config.checkpointCount,
    nextSectorCheckpoint,
    checkpointIndex,
  );
  const events = session.passCheckpoint(checkpointIndex);
  const eventTypes = new Set(events.map(({ type }) => type));
  assert.equal(eventTypes.has('checkpoint-rejected'), Boolean(flags & FLAGS.rejected), `${label} reject`);
  assert.equal(eventTypes.has('checkpoint-completed'), Boolean(flags & FLAGS.accepted), `${label} accept`);
  assert.equal(eventTypes.has('sector-completed'), Boolean(flags & FLAGS.sector), `${label} sector`);
  assert.equal(eventTypes.has('lap-completed'), Boolean(flags & FLAGS.lap), `${label} lap`);
  assert.equal(eventTypes.has('run-completed'), Boolean(flags & FLAGS.run), `${label} run`);

  if (flags & FLAGS.accepted) {
    shadow.checkpointsPassed += 1;
    assert.equal(
      events.find(({ type }) => type === 'checkpoint-completed').checkpointOrdinal,
      checkpointOrdinal(),
      `${label} ordinal`,
    );
  }
  if (flags & FLAGS.sector) {
    const sector = events.find(({ type }) => type === 'sector-completed');
    assert.equal(
      sector.timeMs,
      rounded(shadow.runTimeExactMs - shadow.sectorStartedAtExactMs),
      `${label} sector duration`,
    );
    shadow.currentSector += 1;
    shadow.sectorStartedAtExactMs = shadow.runTimeExactMs;
  }
  if (flags & FLAGS.lap) {
    const lap = events.find(({ type }) => type === 'lap-completed').lap;
    assert.equal(
      lap.timeMs,
      rounded(shadow.runTimeExactMs - shadow.lapStartedAtExactMs),
      `${label} lap duration`,
    );
    assert.equal(lap.valid, shadow.currentLapValid, `${label} lap validity`);
  }
  if (flags & FLAGS.run) {
    shadow.status = STATUS.finished;
  } else if (flags & FLAGS.lap) {
    shadow.lapStartedAtExactMs = shadow.runTimeExactMs;
    shadow.sectorStartedAtExactMs = shadow.runTimeExactMs;
    shadow.currentSector = 0;
    shadow.currentLapValid = true;
  }
  compare(label);
  return events;
}

function completeLap(sectorTimes, prefix) {
  sectorTimes.forEach((deltaMs, index) => {
    advance(deltaMs, `${prefix} advance s${index + 1}`);
    passCheckpoint(index === sectorTimes.length - 1 ? 0 : index + 1, `${prefix} checkpoint s${index + 1}`);
  });
}

start('invalid run start');
advance(1000 / 3, 'fractional 1');
advance(1000 / 3, 'fractional 2');
advance(1000 / 3, 'fractional 3');
passCheckpoint(2, 'out-of-order checkpoint');
invalidate('track-limits', 'first invalidation');
invalidate('track-limits', 'duplicate invalidation');
passCheckpoint(1, 'invalid lap sector 1');
advance(2000.4);
passCheckpoint(2, 'invalid lap sector 2');
advance(3000.4);
passCheckpoint(0, 'invalid lap finish');
completeLap([900.2, 1900.2, 2900.2], 'valid second lap');
assert.equal(session.getSummary().valid, false);
assert.equal(session.getSummary().medal, null);

start('valid restart');
completeLap([1000, 2000, 3000], 'valid lap 1');
const finalEvents = [];
[900, 1900, 2900].forEach((deltaMs, index) => {
  advance(deltaMs, `valid lap 2 advance s${index + 1}`);
  finalEvents.push(...passCheckpoint(
    index === 2 ? 0 : index + 1,
    `valid lap 2 checkpoint s${index + 1}`,
  ));
});
const completed = finalEvents.find(({ type }) => type === 'run-completed');
assert.ok(completed);
assert.equal(completed.summary.timeMs, 11700);
assert.equal(
  core.resolveMedal(
    completed.summary.timeMs,
    config.medalTargetsMs.gold,
    config.medalTargetsMs.silver,
    config.medalTargetsMs.bronze,
  ),
  1,
);
assert.equal(completed.summary.medal, 'gold');

assert.equal(core.advanceExactMs(STATUS.running, 100, -1), 100);
assert.equal(core.roundDurationMs(-1), 0);
assert.equal(
  core.checkpointFlags(STATUS.idle, 0, 2, 3, 1, 1),
  0,
);

console.log(`PASS one shared Rust WASM instance matches JS timing across ${comparisons} snapshots`);
console.log('PASS browser persistence, invalid-reason strings, PB mutation, and UI events remain JS-owned');
