const TIMING_CONTRACT_VERSION = 1;
const STATUS = Object.freeze({ idle: 0, running: 1, finished: 2 });
const FIRST_NON_CONSECUTIVE_INTEGER = 4_503_599_627_370_496;

function roundDurationMs(value) {
  if (Number.isNaN(value) || value <= 0) return 0;
  if (!Number.isFinite(value) || value >= FIRST_NON_CONSECUTIVE_INTEGER) return value;
  return Math.round(value);
}

function expectedCheckpointIndex(checkpointsPassed, checkpointCount) {
  if (checkpointCount === 0) return 0;
  return (checkpointsPassed + 1) % checkpointCount;
}

function checkpointOrdinal(checkpointsPassed, checkpointCount) {
  if (checkpointsPassed === 0 || checkpointCount === 0) return 0;
  const withinLap = checkpointsPassed % checkpointCount;
  return withinLap === 0 ? checkpointCount : withinLap;
}

function checkpointFlags(
  status,
  checkpointsPassed,
  totalLaps,
  checkpointCount,
  nextSectorCheckpoint,
  checkpointIndex,
) {
  if (
    status !== STATUS.running
    || totalLaps === 0
    || checkpointCount === 0
    || checkpointIndex >= checkpointCount
  ) return 0;
  if (checkpointIndex !== expectedCheckpointIndex(checkpointsPassed, checkpointCount)) return 1;
  if (checkpointsPassed === 0xffff_ffff) return 0;

  const nextPassed = checkpointsPassed + 1;
  const ordinal = checkpointOrdinal(nextPassed, checkpointCount);
  let flags = 2;
  if (
    nextSectorCheckpoint > 0
    && nextSectorCheckpoint <= checkpointCount
    && ordinal === nextSectorCheckpoint
  ) flags |= 4;
  if (ordinal === checkpointCount) {
    flags |= 8;
    if (nextPassed >= totalLaps * checkpointCount) flags |= 16;
  }
  return flags;
}

class RaceProgressLoadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RaceProgressLoadError';
    this.code = code;
  }
}

const REQUIRED_EXPORTS = [
  'streetrush_timing_contract_version',
  'streetrush_timing_advance_exact_ms',
  'streetrush_timing_round_duration_ms',
  'streetrush_timing_expected_checkpoint_index',
  'streetrush_timing_checkpoint_ordinal',
  'streetrush_timing_checkpoint_flags',
  'streetrush_timing_resolve_medal',
];

function readExports(source) {
  const exports = source?.instance?.exports ?? source?.exports;
  if (!exports || typeof exports !== 'object') {
    throw new RaceProgressLoadError(
      'wasm-export-missing',
      'WASM race-progress capability did not expose exports',
    );
  }
  for (const name of REQUIRED_EXPORTS) {
    if (typeof exports[name] !== 'function') {
      throw new RaceProgressLoadError('wasm-export-missing', `WASM export is missing: ${name}`);
    }
  }
  return exports;
}

export function createJavaScriptRaceProgressCore({ fallbackReason = null } = {}) {
  return {
    owner: 'javascript',
    available: true,
    fallbackReason,
    contractVersion: TIMING_CONTRACT_VERSION,
    advanceExactMs(status, currentMs, deltaMs) {
      return status === STATUS.running && Number.isFinite(deltaMs) && deltaMs >= 0
        ? currentMs + deltaMs
        : currentMs;
    },
    roundDurationMs,
    expectedCheckpointIndex,
    checkpointOrdinal,
    checkpointFlags,
    resolveMedal(timeMs, goldMs, silverMs, bronzeMs) {
      if (
        !Number.isFinite(timeMs)
        || timeMs < 0
        || !Number.isFinite(goldMs)
        || !Number.isFinite(silverMs)
        || !Number.isFinite(bronzeMs)
        || goldMs < 0
        || goldMs > silverMs
        || silverMs > bronzeMs
      ) return 0;
      if (timeMs <= goldMs) return 1;
      if (timeMs <= silverMs) return 2;
      if (timeMs <= bronzeMs) return 3;
      return 0;
    },
  };
}

export function createWasmRaceProgressCore(source) {
  const exports = readExports(source);
  const contractVersion = exports.streetrush_timing_contract_version();
  if (contractVersion !== TIMING_CONTRACT_VERSION) {
    throw new RaceProgressLoadError(
      'wasm-contract-mismatch',
      `WASM race-progress contract mismatch: version=${contractVersion}`,
    );
  }
  return {
    owner: 'rust-wasm',
    available: true,
    fallbackReason: null,
    contractVersion,
    advanceExactMs(status, currentMs, deltaMs) {
      return exports.streetrush_timing_advance_exact_ms(status, currentMs, deltaMs);
    },
    roundDurationMs(value) {
      return exports.streetrush_timing_round_duration_ms(value);
    },
    expectedCheckpointIndex(checkpointsPassed, checkpointCount) {
      return exports.streetrush_timing_expected_checkpoint_index(
        checkpointsPassed,
        checkpointCount,
      );
    },
    checkpointOrdinal(checkpointsPassed, checkpointCount) {
      return exports.streetrush_timing_checkpoint_ordinal(checkpointsPassed, checkpointCount);
    },
    checkpointFlags(
      status,
      checkpointsPassed,
      totalLaps,
      checkpointCount,
      nextSectorCheckpoint,
      checkpointIndex,
    ) {
      return exports.streetrush_timing_checkpoint_flags(
        status,
        checkpointsPassed,
        totalLaps,
        checkpointCount,
        nextSectorCheckpoint,
        checkpointIndex,
      );
    },
    resolveMedal(timeMs, goldMs, silverMs, bronzeMs) {
      return exports.streetrush_timing_resolve_medal(timeMs, goldMs, silverMs, bronzeMs);
    },
  };
}
