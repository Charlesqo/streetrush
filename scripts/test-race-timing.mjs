import assert from 'node:assert/strict';
import {
  RaceTimingSession,
  TimingStore,
  formatRaceDelta,
  formatRaceTime,
  resolveMedal,
} from '../src/race-timing.js';

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

function makeStore(storage = new MemoryStorage()) {
  return new TimingStore({
    storage,
    now: () => '2026-07-28T00:00:00.000Z',
  });
}

function makeSession(overrides = {}) {
  return new RaceTimingSession({
    trackId: 'longwan',
    carId: 'mx5',
    totalLaps: 2,
    checkpointCount: 3,
    sectorCheckpoints: [1, 2, 3],
    medalTargetsMs: { gold: 12000, silver: 15000, bronze: 18000 },
    store: makeStore(),
    ...overrides,
  });
}

function completeLap(session, sectorTimesMs, invalidReason = null) {
  const events = [];
  sectorTimesMs.forEach((timeMs, index) => {
    session.advance(timeMs);
    if (invalidReason && index === 0) session.invalidate(invalidReason);
    const checkpointIndex = index === sectorTimesMs.length - 1 ? 0 : index + 1;
    events.push(...session.passCheckpoint(checkpointIndex));
  });
  return events;
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

test('formats race times, deltas and medal boundaries', () => {
  assert.equal(formatRaceTime(0), '00:00.000');
  assert.equal(formatRaceTime(61123.6), '01:01.124');
  assert.equal(formatRaceTime(null), '--:--.---');
  assert.equal(formatRaceDelta(-123.6), '−0.124');
  assert.equal(formatRaceDelta(0.2), '±0.000');
  assert.equal(formatRaceDelta(1250), '+1.250');
  const targets = { gold: 10000, silver: 12000, bronze: 15000 };
  assert.equal(resolveMedal(10000, targets), 'gold');
  assert.equal(resolveMedal(11000, targets), 'silver');
  assert.equal(resolveMedal(14000, targets), 'bronze');
  assert.equal(resolveMedal(15001, targets), null);
});

test('records sectors, laps, PBs, a valid race PB and medal', () => {
  const storage = new MemoryStorage();
  const session = makeSession({ store: makeStore(storage) });
  session.start();

  completeLap(session, [1000, 2000, 3000]);
  const finalEvents = completeLap(session, [900, 1900, 2900]);
  const completed = finalEvents.find((event) => event.type === 'run-completed');
  assert.ok(completed);
  assert.equal(session.snapshot().status, 'finished');
  assert.equal(completed.summary.timeMs, 11700);
  assert.equal(completed.summary.valid, true);
  assert.equal(completed.summary.medal, 'gold');
  assert.equal(completed.summary.newBestRace, true);
  assert.equal(completed.summary.bestLapMs, 5700);
  assert.deepEqual(session.getRecord().bestSectorsMs, [900, 1900, 2900]);
  assert.equal(session.getRecord().bestRaceMsByLaps['2'], 11700);
  assert.equal(session.getRecord().completedRuns, 1);
  assert.equal(session.getRecord().validRuns, 1);
});

test('loads persisted PBs and reports deltas without mutating returned records', () => {
  const storage = new MemoryStorage();
  const first = makeSession({ store: makeStore(storage) });
  first.start();
  completeLap(first, [1000, 2000, 3000]);
  completeLap(first, [900, 1900, 2900]);

  const second = makeSession({ store: makeStore(storage) });
  assert.equal(second.snapshot().bestLapMs, 5700);
  assert.deepEqual(second.snapshot().bestSectorsMs, [900, 1900, 2900]);
  second.start();
  const events = completeLap(second, [1000, 2000, 3000]);
  const lap = events.find((event) => event.type === 'lap-completed').lap;
  assert.equal(lap.deltaMs, 300);
  assert.equal(lap.newBest, false);

  const record = second.getRecord();
  record.bestSectorsMs[0] = 1;
  assert.equal(second.getRecord().bestSectorsMs[0], 900);
});

test('keeps invalid laps out of lap, sector, race PB and medal records', () => {
  const storage = new MemoryStorage();
  const session = makeSession({ store: makeStore(storage) });
  session.start();
  const firstEvents = completeLap(session, [800, 1800, 2800], 'track-limits');
  const invalidLap = firstEvents.find((event) => event.type === 'lap-completed').lap;
  assert.equal(invalidLap.valid, false);
  assert.equal(invalidLap.deltaMs, null);
  assert.equal(firstEvents.find((event) => event.type === 'sector-completed').deltaMs, null);
  assert.deepEqual(invalidLap.invalidReasons, ['track-limits']);
  assert.equal(session.snapshot().currentLapValid, true);

  const finalEvents = completeLap(session, [1000, 2000, 3000]);
  const completed = finalEvents.find((event) => event.type === 'run-completed');
  assert.equal(completed.summary.valid, false);
  assert.equal(completed.summary.medal, null);
  assert.equal(completed.summary.deltaMs, null);
  assert.equal(completed.summary.newBestRace, false);
  assert.equal(completed.summary.bestRaceMs, null);
  assert.equal(completed.summary.bestLapMs, 6000);
  assert.deepEqual(session.getRecord().bestSectorsMs, [1000, 2000, 3000]);
  assert.equal(session.getRecord().completedRuns, 1);
  assert.equal(session.getRecord().validRuns, 0);
});

test('rejects out-of-order checkpoints and deduplicates invalidation', () => {
  const session = makeSession();
  session.start();
  session.advance(1000);
  const rejected = session.passCheckpoint(2);
  assert.equal(rejected[0].type, 'checkpoint-rejected');
  assert.equal(rejected[0].expectedCheckpointIndex, 1);
  assert.equal(session.snapshot().checkpointsPassed, 0);

  assert.equal(session.invalidate('manual-reset').type, 'lap-invalidated');
  assert.equal(session.invalidate('manual-reset'), null);
  assert.equal(session.invalidate('track-limits'), null);
  assert.deepEqual(session.snapshot().invalidReasons, ['manual-reset', 'track-limits']);
});

test('restart clears the active run but preserves saved records', () => {
  const storage = new MemoryStorage();
  const session = makeSession({ totalLaps: 1, store: makeStore(storage) });
  session.start();
  completeLap(session, [1000, 2000, 3000]);
  assert.equal(session.getRecord().bestLapMs, 6000);

  session.restart();
  assert.equal(session.snapshot().status, 'running');
  assert.equal(session.snapshot().runTimeMs, 0);
  assert.equal(session.snapshot().currentLapNumber, 1);
  assert.equal(session.snapshot().bestLapMs, 6000);
});

test('handles fractional fixed steps without per-step rounding drift', () => {
  const session = makeSession();
  session.start();
  for (let step = 0; step < 120; step += 1) session.advance(1000 / 120);
  assert.equal(session.snapshot().runTimeMs, 1000);
});

test('recovers from corrupt or unavailable storage', () => {
  const storage = new MemoryStorage();
  const store = makeStore(storage);
  const identity = { trackId: 'longwan', carId: 'mx5' };
  storage.setItem(store.keyFor(identity), '{broken');
  assert.equal(store.load(identity, 3).bestLapMs, null);

  const unavailable = new TimingStore({
    storage: {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    },
  });
  assert.equal(unavailable.load(identity, 3).bestLapMs, null);
  assert.equal(unavailable.save(identity, unavailable.load(identity, 3)), false);
});

test('validates timing configuration and tick inputs', () => {
  assert.throws(() => makeSession({ checkpointCount: 0 }), /positive integer/);
  assert.throws(() => makeSession({ sectorCheckpoints: [2] }), /end at checkpointCount/);
  assert.throws(
    () => makeSession({ medalTargetsMs: { gold: 15000, silver: 12000, bronze: 18000 } }),
    /gold <= silver <= bronze/,
  );
  const session = makeSession();
  assert.throws(() => session.advance(-1), /non-negative/);
  assert.throws(() => session.passCheckpoint(4), /between 0 and 2/);
});

let failures = 0;
for (const { name, run } of tests) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${name}`);
    console.error(error);
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${tests.length} timing tests failed`);
  process.exitCode = 1;
} else {
  console.log(`\nPASS ${tests.length} timing tests`);
}
