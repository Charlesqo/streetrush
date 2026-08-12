const TIMING_CONTRACT_VERSION = 1;

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
    available: false,
    fallbackReason,
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
