import assert from 'node:assert/strict';
import { CARS } from '../src/config.js';
import { getLiveRaceGoal, LONGWAN_TIME_ATTACK, MIN_LIVE_GOAL_CHECKPOINTS } from '../src/race-goals.js';
import { RaceTimingSession, TimingStore, resolveMedal } from '../src/race-timing.js';

const CAR_IDS = CARS.map(({ id }) => id);
const TARGET_IDS = Object.keys(LONGWAN_TIME_ATTACK.medalTargetsMs);
assert.deepEqual([...TARGET_IDS].sort(), [...CAR_IDS].sort(), 'every car has exactly one target table');

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

function makeStore(storage) {
  return new TimingStore({
    storage,
    now: () => '2026-08-03T00:00:00.000Z',
  });
}

function makeSession(carId, storage, targets = LONGWAN_TIME_ATTACK.medalTargetsMs[carId]) {
  return new RaceTimingSession({
    trackId: LONGWAN_TIME_ATTACK.id,
    carId,
    totalLaps: 3,
    checkpointCount: 10,
    sectorCheckpoints: LONGWAN_TIME_ATTACK.sectorCheckpoints,
    medalTargetsMs: targets,
    store: makeStore(storage),
  });
}

function completeThreeLapRun(session, totalMs, { invalidateFirstLap = false } = {}) {
  session.start();
  const checkpointTimeMs = totalMs / 30;
  let completedRun = null;

  for (let lap = 0; lap < 3; lap += 1) {
    for (let checkpoint = 0; checkpoint < 10; checkpoint += 1) {
      session.advance(checkpointTimeMs);
      if (invalidateFirstLap && lap === 0 && checkpoint === 0) session.invalidate('manual-reset');
      const checkpointIndex = checkpoint === 9 ? 0 : checkpoint + 1;
      for (const event of session.passCheckpoint(checkpointIndex)) {
        if (event.type === 'run-completed') completedRun = event;
      }
    }
  }

  assert.ok(completedRun, 'three-lap helper must finish a run');
  return completedRun.summary;
}

function getLiveGoalForProjectedTime(targets, projectedMs, overrides = {}) {
  const checkpointsPassed = MIN_LIVE_GOAL_CHECKPOINTS;
  const totalCheckpoints = 30;
  const progress = checkpointsPassed / totalCheckpoints;
  return getLiveRaceGoal({
    targets,
    checkpointsPassed,
    totalCheckpoints,
    runTimeMs: projectedMs * progress,
    ...overrides,
  });
}

function assertLiveGoal({ targets, label, projectedMs, nextTarget, predictedMedal }) {
  const goal = getLiveGoalForProjectedTime(targets, projectedMs);
  assert.equal(goal.invalid, false, `${label}: live goal remains valid`);
  assert.equal(goal.medal, nextTarget, `${label}: next target tier`);
  assert.equal(goal.targetMs, targets[nextTarget], `${label}: next target time`);
  assert.ok(Math.abs(goal.projectedMs - projectedMs) < 1e-6, `${label}: projected time`);
  assert.ok(
    Math.abs(goal.deltaMs - (projectedMs - targets[nextTarget])) < 1e-6,
    `${label}: delta to next target`,
  );
  assert.equal(resolveMedal(projectedMs, targets), predictedMedal, `${label}: final predicted medal`);
}

for (const carId of CAR_IDS) {
  const targets = LONGWAN_TIME_ATTACK.medalTargetsMs[carId];
  assert.ok(targets, `${carId} has medal targets`);
  assert.ok(Object.isFrozen(targets), `${carId} targets are immutable`);
  assert.ok(targets.gold <= targets.silver && targets.silver <= targets.bronze);

  for (const { label, timeMs, medal } of [
    { label: 'faster than gold', timeMs: targets.gold - 1, medal: 'gold' },
    { label: 'exactly gold', timeMs: targets.gold, medal: 'gold' },
    { label: 'just slower than gold', timeMs: targets.gold + 1, medal: 'silver' },
    { label: 'exactly silver', timeMs: targets.silver, medal: 'silver' },
    { label: 'just slower than silver', timeMs: targets.silver + 1, medal: 'bronze' },
    { label: 'exactly bronze', timeMs: targets.bronze, medal: 'bronze' },
    { label: 'over bronze', timeMs: targets.bronze + 1, medal: null },
  ]) {
    assert.equal(resolveMedal(timeMs, targets), medal, `${carId}: ${label} resolves final medal`);
  }

  // The UI says “下一目标”: getLiveRaceGoal.medal is the next tier to chase,
  // while resolveMedal(projectedMs, targets) is the final predicted medal.
  for (const testCase of [
    { label: `${carId}: exactly gold`, projectedMs: targets.gold, nextTarget: 'gold', predictedMedal: 'gold' },
    { label: `${carId}: between gold and silver`, projectedMs: targets.gold + 1, nextTarget: 'gold', predictedMedal: 'silver' },
    { label: `${carId}: exactly silver`, projectedMs: targets.silver, nextTarget: 'gold', predictedMedal: 'silver' },
    { label: `${carId}: between silver and bronze`, projectedMs: targets.silver + 1, nextTarget: 'silver', predictedMedal: 'bronze' },
    { label: `${carId}: exactly bronze`, projectedMs: targets.bronze, nextTarget: 'silver', predictedMedal: 'bronze' },
    { label: `${carId}: over bronze`, projectedMs: targets.bronze + 1, nextTarget: 'bronze', predictedMedal: null },
  ]) {
    assertLiveGoal({ targets, ...testCase });
  }

  const cleanSummary = completeThreeLapRun(
    makeSession(carId, new MemoryStorage()),
    targets.gold,
  );
  assert.equal(cleanSummary.valid, true);
  assert.equal(cleanSummary.medal, 'gold');

  const liveTargets = {
    targets,
    totalCheckpoints: 30,
    runTimeMs: targets.gold / 30 * MIN_LIVE_GOAL_CHECKPOINTS,
  };
  assert.equal(getLiveRaceGoal({ ...liveTargets, checkpointsPassed: 0 }).projectedMs, null);
  const invalidCurrentLap = getLiveRaceGoal({
    ...liveTargets,
    checkpointsPassed: MIN_LIVE_GOAL_CHECKPOINTS,
    currentLapValid: false,
  });
  const invalidPreviousLap = getLiveRaceGoal({
    ...liveTargets,
    checkpointsPassed: MIN_LIVE_GOAL_CHECKPOINTS,
    laps: [{ valid: false }],
  });
  const invalidGoal = { invalid: true, medal: null, targetMs: null, projectedMs: null, deltaMs: null };
  assert.deepEqual(invalidCurrentLap, invalidGoal, `${carId}: current invalid lap removes live goal`);
  assert.deepEqual(invalidPreviousLap, invalidGoal, `${carId}: previous invalid lap removes live goal`);
}

const storage = new MemoryStorage();
const mx5Targets = LONGWAN_TIME_ATTACK.medalTargetsMs.mx5;
const invalid = completeThreeLapRun(makeSession('mx5', storage), mx5Targets.gold, { invalidateFirstLap: true });
assert.equal(invalid.valid, false);
assert.equal(invalid.medal, null);
assert.equal(invalid.bestRaceMs, null);

const valid = completeThreeLapRun(makeSession('mx5', storage), mx5Targets.gold);
assert.equal(valid.valid, true);
assert.equal(valid.medal, 'gold');
assert.equal(valid.newBestRace, true);

const reloaded = makeSession('mx5', storage);
assert.equal(reloaded.getRecord().bestRaceMsByLaps['3'], mx5Targets.gold);

console.log(`PASS ${CAR_IDS.length} vehicle target tables, boundaries and gold runs`);
console.log('PASS invalid runs stay unmedaled and valid PBs persist');
