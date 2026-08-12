// Official three-lap totals, in milliseconds. These are intentionally explicit
// per car so the targets remain easy to tune during track playtests instead of
// being silently coupled to display stats or physics guesses.
//
// The initial pass follows the current simulation ordering in
// docs/VEHICLE_DATA.md (MX-5 128 km/h, M3 155, M5 207, GT3 RS 216,
// LP700/AMG GT3 228 in the 60-second calibration snapshot) and the README's
// approximately 2.13 km lap. Bronze is a completion target, silver asks for a
// consistent clean run, and gold is reserved for a strong clean pace.
const LONGWAN_MEDAL_TARGETS_MS = Object.freeze({
  mx5: Object.freeze({ gold: 405_000, silver: 450_000, bronze: 525_000 }),
  m3e30: Object.freeze({ gold: 345_000, silver: 390_000, bronze: 465_000 }),
  gt3rs: Object.freeze({ gold: 255_000, silver: 300_000, bronze: 360_000 }),
  lp700: Object.freeze({ gold: 240_000, silver: 285_000, bronze: 345_000 }),
  amggt3: Object.freeze({ gold: 240_000, silver: 285_000, bronze: 345_000 }),
  m5g90: Object.freeze({ gold: 270_000, silver: 315_000, bronze: 375_000 }),
});

export const LONGWAN_TIME_ATTACK = Object.freeze({
  id: 'longwan-time-attack-v1',
  sectorCheckpoints: [3, 6, 10],
  medalTargetsMs: LONGWAN_MEDAL_TARGETS_MS,
});

export const MIN_LIVE_GOAL_CHECKPOINTS = 3;

export function getLiveRaceGoal({
  targets,
  checkpointsPassed,
  totalCheckpoints,
  runTimeMs,
  currentLapValid = true,
  laps = [],
}) {
  if (!targets) return null;
  if (!currentLapValid || laps.some((lap) => !lap.valid)) {
    return { invalid: true, medal: null, targetMs: null, projectedMs: null, deltaMs: null };
  }
  if (
    !Number.isFinite(checkpointsPassed)
    || !Number.isFinite(totalCheckpoints)
    || totalCheckpoints <= 0
    || !Number.isFinite(runTimeMs)
    || checkpointsPassed < MIN_LIVE_GOAL_CHECKPOINTS
  ) {
    return { invalid: false, medal: 'bronze', targetMs: targets.bronze, projectedMs: null, deltaMs: null };
  }

  const progress = checkpointsPassed / totalCheckpoints;
  const projectedMs = runTimeMs / progress;
  const medal = projectedMs > targets.bronze
    ? 'bronze'
    : projectedMs > targets.silver
      ? 'silver'
      : 'gold';
  return {
    invalid: false,
    medal,
    targetMs: targets[medal],
    projectedMs,
    deltaMs: projectedMs - targets[medal],
  };
}
