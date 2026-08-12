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
const config = {
  totalLaps: 2,
  checkpointCount: 3,
  sectorCheckpoints: [2, 3],
};
const legacy = new RaceTimingSession({
  trackId: 'progress-staging-oracle',
  carId: 'mx5',
  ...config,
  store: new TimingStore({ storage: null }),
});
const progressSessions = [
  ['WASM', new RaceProgressSession({ ...config, core: sharedCore.raceProgress })],
  ['fallback', new RaceProgressSession({
    ...config,
    core: createJavaScriptRaceProgressCore(),
  })],
];
const PROGRESS_FIELDS = [
  'status', 'runTimeMs', 'currentLapNumber', 'lapTimeMs', 'currentSectorNumber',
  'sectorTimeMs', 'checkpointsPassed', 'checkpointOrdinal', 'checkpointInLap',
  'expectedCheckpointIndex', 'currentLapValid',
];
let stageComparisons = 0;

function project(snapshot) {
  return Object.fromEntries(PROGRESS_FIELDS.map((field) => [field, snapshot[field]]));
}

function compareStage(session, expectedSnapshot, label) {
  assert.deepEqual(session.snapshot(), project(expectedSnapshot), label);
  stageComparisons += 1;
}

function start() {
  const event = legacy.start();
  for (const [owner, session] of progressSessions) {
    session.start();
    compareStage(session, event.snapshot, `${owner} start`);
  }
}

function advance(deltaMs, label) {
  const snapshot = legacy.advance(deltaMs);
  for (const [owner, session] of progressSessions) {
    session.advance(deltaMs);
    compareStage(session, snapshot, `${owner} ${label}`);
  }
}

function invalidate(reason, label) {
  const event = legacy.invalidate(reason);
  for (const [owner, session] of progressSessions) {
    assert.equal(session.invalidate(), Boolean(event), `${owner} ${label} changed`);
    compareStage(session, legacy.snapshot(), `${owner} ${label}`);
  }
}

function projectedOutcome(events) {
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

function checkpoint(index, label) {
  const events = legacy.passCheckpoint(index);
  const checkpointEvent = events.find(({ type }) => type === 'checkpoint-completed');
  const rejectedEvent = events.find(({ type }) => type === 'checkpoint-rejected');
  const sectorEvent = events.find(({ type }) => type === 'sector-completed');
  const lapEvent = events.find(({ type }) => type === 'lap-completed');
  const runEvent = events.find(({ type }) => type === 'run-completed');

  for (const [owner, session] of progressSessions) {
    const prepared = session.prepareCheckpoint(index);
    if (rejectedEvent) {
      assert.equal(prepared.rejected, true, `${owner} ${label} rejected`);
      compareStage(session, rejectedEvent.snapshot, `${owner} ${label} rejected snapshot`);
      continue;
    }

    assert.equal(prepared.accepted, true, `${owner} ${label} accepted`);
    assert.equal(
      prepared.checkpointOrdinal,
      checkpointEvent.checkpointOrdinal,
      `${owner} ${label} ordinal`,
    );
    compareStage(session, checkpointEvent.snapshot, `${owner} ${label} checkpoint snapshot`);

    const sectorTimeMs = session.commitSector();
    assert.equal(sectorTimeMs, sectorEvent?.timeMs ?? null, `${owner} ${label} sector time`);
    if (sectorEvent) compareStage(session, sectorEvent.snapshot, `${owner} ${label} sector snapshot`);

    const lap = session.commitLap();
    assert.deepEqual(
      lap,
      lapEvent ? { timeMs: lapEvent.lap.timeMs, valid: lapEvent.lap.valid } : null,
      `${owner} ${label} lap outcome`,
    );
    if (lapEvent) compareStage(session, lapEvent.snapshot, `${owner} ${label} lap snapshot`);

    const runCompleted = session.commitRun();
    assert.equal(runCompleted, Boolean(runEvent), `${owner} ${label} run outcome`);
    if (runEvent) compareStage(session, runEvent.snapshot, `${owner} ${label} run snapshot`);

    assert.deepEqual(
      session.finishCheckpoint(),
      projectedOutcome(events),
      `${owner} ${label} final outcome`,
    );
  }
}

start();
advance(250, 'wrong advance');
checkpoint(2, 'wrong checkpoint');
invalidate('track-limits', 'invalidate');

for (let lap = 0; lap < 2; lap += 1) {
  for (let checkpointIndex = 0; checkpointIndex < 3; checkpointIndex += 1) {
    advance(1000 + lap * 100 + checkpointIndex * 50, `lap ${lap} advance ${checkpointIndex}`);
    checkpoint(checkpointIndex === 2 ? 0 : checkpointIndex + 1, `lap ${lap} cp ${checkpointIndex}`);
  }
}

for (const [owner, session] of progressSessions) {
  assert.throws(() => session.commitSector(), /pending checkpoint/, `${owner} no pending sector`);
  assert.throws(() => session.finishCheckpoint(), /pending checkpoint/, `${owner} no pending finish`);
}

console.log(`PASS staged progress preserves ${stageComparisons} legacy intermediate snapshots`);
console.log('PASS WASM and fallback prepare/sector/lap/run commits preserve event ordering');
