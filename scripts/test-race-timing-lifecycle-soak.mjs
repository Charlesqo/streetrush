import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { RaceTimingSession, TimingStore } from '../src/race-timing.js';
import { createJavaScriptRaceProgressCore } from '../src/race-progress-core.js';
import { loadSharedCoreCapabilities } from '../src/shared-core-owner.js';

const baselineUrl = new URL('../data/timing-lifecycle-baseline.json', import.meta.url);
const wasmBytes = await readFile(new URL('../src/generated/streetrush_core.wasm', import.meta.url));
const sharedCore = await loadSharedCoreCapabilities({
  instantiate: () => WebAssembly.instantiate(wasmBytes),
});
const fallbackCore = createJavaScriptRaceProgressCore({
  fallbackReason: { code: 'soak-fallback', message: 'deterministic fixture' },
});

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

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function generateActions(seed) {
  const random = xorshift32(seed);
  const actions = [];
  for (let run = 0; run < 12; run += 1) {
    actions.push({ type: run === 0 ? 'start' : 'restart' });
    const invalidRun = run % 3 === 1;
    const midRunRestart = run % 4 === 2;
    let didMidRunRestart = false;
    let completedCheckpoints = 0;

    while (completedCheckpoints < 6) {
      const advanceCount = 1 + (random() % 3);
      for (let index = 0; index < advanceCount; index += 1) {
        const wholeMs = 250 + (random() % 950);
        const fractional = (random() % 1000) / 1000;
        actions.push({ type: 'advance', deltaMs: wholeMs + fractional });
      }

      const expectedIndex = (completedCheckpoints + 1) % 3;
      if (random() % 4 === 0) {
        actions.push({ type: 'checkpoint', index: (expectedIndex + 1) % 3 });
      }
      if (invalidRun && completedCheckpoints === 1) {
        actions.push({ type: 'invalidate', reason: 'track-limits' });
        actions.push({ type: 'invalidate', reason: 'track-limits' });
        actions.push({ type: 'invalidate', reason: 'manual-reset' });
      }

      actions.push({ type: 'checkpoint', index: expectedIndex });
      completedCheckpoints += 1;

      if (midRunRestart && !didMidRunRestart && completedCheckpoints === 3) {
        actions.push({ type: 'restart' });
        didMidRunRestart = true;
        completedCheckpoints = 0;
      }
    }

    actions.push({ type: 'advance', deltaMs: 111.125 });
    actions.push({ type: 'checkpoint', index: random() % 3 });
    actions.push({ type: 'invalidate', reason: 'finished-noise' });
  }
  return actions;
}

function createSession(progressCore) {
  const storage = new MemoryStorage();
  const session = new RaceTimingSession({
    trackId: 'timing-lifecycle-soak-v1',
    carId: 'mx5',
    totalLaps: 2,
    checkpointCount: 3,
    sectorCheckpoints: [2, 3],
    medalTargetsMs: { gold: 9000, silver: 12000, bronze: 16000 },
    store: new TimingStore({
      storage,
      now: () => '2026-08-13T00:00:00.000Z',
    }),
    ...(progressCore ? { progressCore, progressMode: 'owner' } : {}),
  });
  return { session, storage };
}

function applyAction(session, action) {
  switch (action.type) {
    case 'start': return session.start();
    case 'restart': return session.restart();
    case 'advance': return session.advance(action.deltaMs);
    case 'invalidate': return session.invalidate(action.reason);
    case 'checkpoint': return session.passCheckpoint(action.index);
    default: throw new Error(`unknown timing soak action: ${action.type}`);
  }
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function runSeed(seed) {
  const actions = generateActions(seed);
  const legacy = createSession(null);
  const wasmOwner = createSession(sharedCore.raceProgress);
  const fallbackOwner = createSession(fallbackCore);
  const legacyResults = [];
  const eventCounts = {};

  for (const [index, action] of actions.entries()) {
    const expectedResult = applyAction(legacy.session, action);
    const expected = {
      result: expectedResult,
      snapshot: legacy.session.snapshot(),
      record: legacy.session.getRecord(),
      summary: legacy.session.getSummary(),
      storageWrites: legacy.storage.writeCount,
    };
    legacyResults.push(expected);

    for (const [owner, candidate] of [
      ['rust-wasm-owner', wasmOwner],
      ['javascript-owner', fallbackOwner],
    ]) {
      const actualResult = applyAction(candidate.session, action);
      const actual = {
        result: actualResult,
        snapshot: candidate.session.snapshot(),
        record: candidate.session.getRecord(),
        summary: candidate.session.getSummary(),
        storageWrites: candidate.storage.writeCount,
      };
      assert.deepEqual(actual, expected, `seed=${seed} action=${index} type=${action.type} owner=${owner}`);
    }

    const events = Array.isArray(expectedResult) ? expectedResult : [expectedResult];
    for (const event of events) {
      if (event?.type) eventCounts[event.type] = (eventCounts[event.type] ?? 0) + 1;
    }
  }

  const record = legacy.session.getRecord();
  return {
    seed,
    actionCount: actions.length,
    actionSha256: hashJson(actions),
    resultSha256: hashJson(legacyResults),
    eventCounts,
    completedRuns: record.completedRuns,
    validRuns: record.validRuns,
    storageWrites: legacy.storage.writeCount,
    bestLapMs: record.bestLapMs,
    bestRaceMs: record.bestRaceMsByLaps['2'] ?? null,
  };
}

const seeds = [0x71c3_0001, 0x71c3_0002, 0x71c3_0003, 0x71c3_0004];
const generated = {
  formatVersion: 1,
  generator: 'timing-lifecycle-soak-v1',
  cases: seeds.map(runSeed),
};

let baseline = null;
try {
  baseline = JSON.parse(await readFile(baselineUrl, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

if (process.argv.includes('--print-candidate')) {
  console.log(JSON.stringify(generated, null, 2));
} else if (!baseline) {
  console.error('Timing lifecycle baseline is missing. Generated candidate follows:');
  console.error(JSON.stringify(generated, null, 2));
  process.exitCode = 2;
} else {
  assert.deepEqual(generated, baseline, 'timing lifecycle baseline changed');
  const actionCount = generated.cases.reduce((total, entry) => total + entry.actionCount, 0);
  const runCount = generated.cases.reduce((total, entry) => total + entry.completedRuns, 0);
  console.log(
    `PASS timing lifecycle soak seeds=${seeds.length} actions=${actionCount} completedRuns=${runCount}`,
  );
  console.log('PASS legacy, Rust/WASM owner, and JavaScript fallback owner match every action');
}
