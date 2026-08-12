const STATUS = Object.freeze({ idle: 0, running: 1, finished: 2 });
const STATUS_NAME = Object.freeze(['idle', 'running', 'finished']);
const FLAGS = Object.freeze({ rejected: 1, accepted: 2, sector: 4, lap: 8, run: 16 });

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeSectorCheckpoints(values, checkpointCount) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new RangeError('sectorCheckpoints must contain at least the finish checkpoint');
  }
  let previous = 0;
  for (const checkpoint of values) {
    if (!Number.isInteger(checkpoint) || checkpoint <= previous || checkpoint > checkpointCount) {
      throw new RangeError('sectorCheckpoints must be strictly increasing checkpoint ordinals');
    }
    previous = checkpoint;
  }
  if (values.at(-1) !== checkpointCount) {
    throw new RangeError('sectorCheckpoints must end at checkpointCount');
  }
  return [...values];
}

export class RaceProgressSession {
  constructor({ totalLaps, checkpointCount, sectorCheckpoints, core }) {
    this.totalLaps = requirePositiveInteger(totalLaps, 'totalLaps');
    this.checkpointCount = requirePositiveInteger(checkpointCount, 'checkpointCount');
    this.sectorCheckpoints = normalizeSectorCheckpoints(sectorCheckpoints, this.checkpointCount);
    if (!core?.available || typeof core.checkpointFlags !== 'function') {
      throw new TypeError('core must provide an available race-progress capability');
    }
    this.core = core;
    this.reset();
  }

  reset() {
    this.status = STATUS.idle;
    this.runTimeExactMs = 0;
    this.lapStartedAtExactMs = 0;
    this.sectorStartedAtExactMs = 0;
    this.checkpointsPassed = 0;
    this.currentSector = 0;
    this.currentLapValid = true;
    return this.snapshot();
  }

  start() {
    this.reset();
    this.status = STATUS.running;
    return this.snapshot();
  }

  restart() {
    return this.start();
  }

  advance(deltaMs) {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError('deltaMs must be a finite non-negative number');
    }
    this.runTimeExactMs = this.core.advanceExactMs(
      this.status,
      this.runTimeExactMs,
      deltaMs,
    );
    return this.snapshot();
  }

  invalidate() {
    if (this.status !== STATUS.running || !this.currentLapValid) return false;
    this.currentLapValid = false;
    return true;
  }

  passCheckpoint(checkpointIndex) {
    if (
      !Number.isInteger(checkpointIndex)
      || checkpointIndex < 0
      || checkpointIndex >= this.checkpointCount
    ) {
      throw new RangeError(`checkpointIndex must be between 0 and ${this.checkpointCount - 1}`);
    }
    const nextSectorCheckpoint = this.sectorCheckpoints[this.currentSector]
      ?? this.checkpointCount;
    const flags = this.core.checkpointFlags(
      this.status,
      this.checkpointsPassed,
      this.totalLaps,
      this.checkpointCount,
      nextSectorCheckpoint,
      checkpointIndex,
    );
    const outcome = {
      rejected: Boolean(flags & FLAGS.rejected),
      accepted: Boolean(flags & FLAGS.accepted),
      checkpointOrdinal: null,
      sectorTimeMs: null,
      lapTimeMs: null,
      lapValid: null,
      runCompleted: Boolean(flags & FLAGS.run),
    };
    if (!outcome.accepted) return outcome;

    this.checkpointsPassed += 1;
    outcome.checkpointOrdinal = this.core.checkpointOrdinal(
      this.checkpointsPassed,
      this.checkpointCount,
    );
    if (flags & FLAGS.sector) {
      outcome.sectorTimeMs = this.core.roundDurationMs(
        this.runTimeExactMs - this.sectorStartedAtExactMs,
      );
      this.currentSector += 1;
      this.sectorStartedAtExactMs = this.runTimeExactMs;
    }
    if (flags & FLAGS.lap) {
      outcome.lapTimeMs = this.core.roundDurationMs(
        this.runTimeExactMs - this.lapStartedAtExactMs,
      );
      outcome.lapValid = this.currentLapValid;
    }
    if (flags & FLAGS.run) {
      this.status = STATUS.finished;
    } else if (flags & FLAGS.lap) {
      this.lapStartedAtExactMs = this.runTimeExactMs;
      this.sectorStartedAtExactMs = this.runTimeExactMs;
      this.currentSector = 0;
      this.currentLapValid = true;
    }
    return outcome;
  }

  snapshot() {
    const running = this.status === STATUS.running;
    return {
      status: STATUS_NAME[this.status],
      runTimeMs: this.core.roundDurationMs(this.runTimeExactMs),
      currentLapNumber: Math.min(
        Math.floor(this.checkpointsPassed / this.checkpointCount) + 1,
        this.totalLaps,
      ),
      lapTimeMs: running
        ? this.core.roundDurationMs(this.runTimeExactMs - this.lapStartedAtExactMs)
        : 0,
      currentSectorNumber: running
        ? Math.min(this.currentSector + 1, this.sectorCheckpoints.length)
        : 1,
      sectorTimeMs: running
        ? this.core.roundDurationMs(this.runTimeExactMs - this.sectorStartedAtExactMs)
        : 0,
      checkpointsPassed: this.checkpointsPassed,
      checkpointOrdinal: this.core.checkpointOrdinal(
        this.checkpointsPassed,
        this.checkpointCount,
      ),
      checkpointInLap: this.checkpointsPassed % this.checkpointCount,
      expectedCheckpointIndex: this.core.expectedCheckpointIndex(
        this.checkpointsPassed,
        this.checkpointCount,
      ),
      currentLapValid: this.currentLapValid,
    };
  }
}
