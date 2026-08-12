import { RaceProgressSession } from './race-progress-session.js';

const RECORD_VERSION = 1;
const DEFAULT_STORAGE_PREFIX = 'street-rush.timing.v1';
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

function isFiniteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function normalizeTime(value) {
  return isFiniteNonNegative(value) ? Math.round(value) : null;
}

function normalizeCounter(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function createEmptyRecord(sectorCount) {
  return {
    version: RECORD_VERSION,
    bestLapMs: null,
    bestSectorsMs: Array(sectorCount).fill(null),
    bestRaceMsByLaps: {},
    completedRuns: 0,
    validRuns: 0,
    updatedAt: null,
  };
}

function normalizeRecord(value, sectorCount) {
  const empty = createEmptyRecord(sectorCount);
  if (!value || typeof value !== 'object' || value.version !== RECORD_VERSION) return empty;

  const bestSectorsMs = Array.from(
    { length: sectorCount },
    (_, index) => normalizeTime(value.bestSectorsMs?.[index]),
  );
  const bestRaceMsByLaps = {};
  if (value.bestRaceMsByLaps && typeof value.bestRaceMsByLaps === 'object') {
    for (const [lapCount, timeMs] of Object.entries(value.bestRaceMsByLaps)) {
      if (/^[1-9]\d*$/.test(lapCount) && normalizeTime(timeMs) !== null) {
        bestRaceMsByLaps[lapCount] = normalizeTime(timeMs);
      }
    }
  }

  return {
    version: RECORD_VERSION,
    bestLapMs: normalizeTime(value.bestLapMs),
    bestSectorsMs,
    bestRaceMsByLaps,
    completedRuns: normalizeCounter(value.completedRuns),
    validRuns: normalizeCounter(value.validRuns),
    updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
  };
}

function copyRecord(record) {
  return {
    ...record,
    bestSectorsMs: [...record.bestSectorsMs],
    bestRaceMsByLaps: { ...record.bestRaceMsByLaps },
  };
}

function requireIdentifier(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return value;
}

function defaultSectorCheckpoints(checkpointCount) {
  const sectorCount = Math.min(3, checkpointCount);
  const checkpoints = [];
  for (let sector = 1; sector <= sectorCount; sector += 1) {
    const checkpoint = sector === sectorCount
      ? checkpointCount
      : Math.max(1, Math.floor(checkpointCount * sector / sectorCount));
    if (checkpoints.at(-1) !== checkpoint) checkpoints.push(checkpoint);
  }
  return checkpoints;
}

function normalizeSectorCheckpoints(checkpoints, checkpointCount) {
  const values = checkpoints ?? defaultSectorCheckpoints(checkpointCount);
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

function normalizeMedalTargets(targets) {
  if (targets == null) return null;
  const normalized = {
    gold: normalizeTime(targets.gold),
    silver: normalizeTime(targets.silver),
    bronze: normalizeTime(targets.bronze),
  };
  if (Object.values(normalized).some((value) => value === null)) {
    throw new RangeError('medalTargetsMs must define non-negative gold, silver and bronze times');
  }
  if (!(normalized.gold <= normalized.silver && normalized.silver <= normalized.bronze)) {
    throw new RangeError('medalTargetsMs must satisfy gold <= silver <= bronze');
  }
  return normalized;
}

function roundedDuration(value) {
  return Math.max(0, Math.round(value));
}

export function formatRaceTime(timeMs) {
  if (!isFiniteNonNegative(timeMs)) return '--:--.---';
  const total = roundedDuration(timeMs);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor(total / 1000) % 60;
  const millis = total % 1000;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function formatRaceDelta(deltaMs) {
  if (!Number.isFinite(deltaMs)) return '—';
  const rounded = Math.round(deltaMs);
  if (rounded === 0) return '±0.000';
  const sign = rounded < 0 ? '−' : '+';
  return `${sign}${(Math.abs(rounded) / 1000).toFixed(3)}`;
}

export function resolveMedal(timeMs, medalTargetsMs) {
  if (!isFiniteNonNegative(timeMs) || !medalTargetsMs) return null;
  if (timeMs <= medalTargetsMs.gold) return 'gold';
  if (timeMs <= medalTargetsMs.silver) return 'silver';
  if (timeMs <= medalTargetsMs.bronze) return 'bronze';
  return null;
}

export class TimingStore {
  constructor({
    storage = safeStorage(),
    prefix = DEFAULT_STORAGE_PREFIX,
    now = () => new Date().toISOString(),
  } = {}) {
    this.storage = storage;
    this.prefix = requireIdentifier(prefix, 'prefix');
    this.now = now;
  }

  keyFor({ trackId, carId }) {
    return `${this.prefix}:${encodeURIComponent(requireIdentifier(trackId, 'trackId'))}:${encodeURIComponent(requireIdentifier(carId, 'carId'))}`;
  }

  load(identity, sectorCount) {
    const count = requirePositiveInteger(sectorCount, 'sectorCount');
    if (!this.storage) return createEmptyRecord(count);
    try {
      const raw = this.storage.getItem(this.keyFor(identity));
      return raw == null ? createEmptyRecord(count) : normalizeRecord(JSON.parse(raw), count);
    } catch {
      return createEmptyRecord(count);
    }
  }

  save(identity, record) {
    if (!this.storage) return false;
    const next = {
      ...copyRecord(record),
      version: RECORD_VERSION,
      updatedAt: this.now(),
    };
    try {
      this.storage.setItem(this.keyFor(identity), JSON.stringify(next));
      record.updatedAt = next.updatedAt;
      return true;
    } catch {
      return false;
    }
  }
}

export class RaceTimingSession {
  constructor({
    trackId,
    carId,
    totalLaps = 3,
    checkpointCount,
    sectorCheckpoints,
    medalTargetsMs = null,
    store = new TimingStore(),
    progressCore = null,
    progressMode = 'shadow',
  }) {
    this.identity = {
      trackId: requireIdentifier(trackId, 'trackId'),
      carId: requireIdentifier(carId, 'carId'),
    };
    this.totalLaps = requirePositiveInteger(totalLaps, 'totalLaps');
    this.checkpointCount = requirePositiveInteger(checkpointCount, 'checkpointCount');
    this.sectorCheckpoints = normalizeSectorCheckpoints(sectorCheckpoints, this.checkpointCount);
    this.medalTargetsMs = normalizeMedalTargets(medalTargetsMs);
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
      throw new TypeError('store must provide load() and save()');
    }
    this.store = store;
    this.record = this.store.load(this.identity, this.sectorCheckpoints.length);
    if (progressCore && progressMode !== 'shadow' && progressMode !== 'owner') {
      throw new RangeError('progressMode must be shadow or owner');
    }
    this.progressSession = progressCore
      ? new RaceProgressSession({
        totalLaps: this.totalLaps,
        checkpointCount: this.checkpointCount,
        sectorCheckpoints: this.sectorCheckpoints,
        core: progressCore,
      })
      : null;
    this.progressMode = this.progressSession ? progressMode : 'legacy';
    this.progressShadow = this.progressMode === 'shadow' ? this.progressSession : null;
    this.progressOwner = this.progressSession ? `${progressCore.owner}-${progressMode}` : 'legacy';
    this.reset();
  }

  get progressOwned() {
    return this.progressMode === 'owner';
  }

  reset() {
    this.status = 'idle';
    this.runTimeExactMs = 0;
    this.lapStartedAtExactMs = 0;
    this.sectorStartedAtExactMs = 0;
    this.checkpointsPassed = 0;
    this.currentSector = 0;
    this.currentSectorsMs = [];
    this.currentLapValid = true;
    this.currentInvalidReasons = [];
    this.laps = [];
    this.summary = null;
    this.progressSession?.reset();
    this.assertProgressShadow('reset');
    return this.snapshot();
  }

  start() {
    this.reset();
    if (this.progressOwned) {
      this.progressSession.start();
    } else {
      this.status = 'running';
      this.progressShadow?.start();
    }
    this.assertProgressShadow('start');
    return {
      type: 'run-started',
      snapshot: this.snapshot(),
    };
  }

  restart() {
    return this.start();
  }

  advance(deltaMs) {
    if (!isFiniteNonNegative(deltaMs)) {
      throw new RangeError('deltaMs must be a finite non-negative number');
    }
    if (this.progressOwned) {
      this.progressSession.advance(deltaMs);
    } else {
      if (this.status === 'running') this.runTimeExactMs += deltaMs;
      this.progressShadow?.advance(deltaMs);
    }
    this.assertProgressShadow('advance');
    return this.snapshot();
  }

  invalidate(reason = 'track-limits') {
    const running = this.progressOwned
      ? this.progressSession.snapshot().status === 'running'
      : this.status === 'running';
    if (!running) {
      if (this.progressOwned) this.progressSession.invalidate();
      const shadowChanged = this.progressShadow?.invalidate() ?? false;
      if (shadowChanged) throw new Error('race progress shadow invalidated outside a running race');
      this.assertProgressShadow('invalidate-idle');
      return null;
    }
    const normalizedReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'invalid';
    const wasValid = this.progressOwned
      ? this.progressSession.snapshot().currentLapValid
      : this.currentLapValid;
    if (this.progressOwned) {
      this.progressSession.invalidate();
    } else {
      this.currentLapValid = false;
    }
    if (!this.currentInvalidReasons.includes(normalizedReason)) {
      this.currentInvalidReasons.push(normalizedReason);
    }
    const shadowChanged = this.progressShadow?.invalidate() ?? wasValid;
    if (shadowChanged !== wasValid) {
      throw new Error(`race progress shadow invalidation mismatch: expected=${wasValid} actual=${shadowChanged}`);
    }
    this.assertProgressShadow('invalidate');
    if (!wasValid) return null;
    return {
      type: 'lap-invalidated',
      lapNumber: this.currentLapNumber,
      reason: normalizedReason,
      snapshot: this.snapshot(),
    };
  }

  passCheckpoint(checkpointIndex) {
    if (!Number.isInteger(checkpointIndex) || checkpointIndex < 0 || checkpointIndex >= this.checkpointCount) {
      throw new RangeError(`checkpointIndex must be between 0 and ${this.checkpointCount - 1}`);
    }
    if (this.progressOwned) return this.passCheckpointOwned(checkpointIndex);
    const shadowOutcome = this.progressShadow?.passCheckpoint(checkpointIndex) ?? null;
    if (this.status !== 'running') {
      this.assertCheckpointShadow([], shadowOutcome, 'checkpoint-idle');
      return [];
    }

    const expectedCheckpointIndex = this.expectedCheckpointIndex;
    if (checkpointIndex !== expectedCheckpointIndex) {
      const rejected = [{
        type: 'checkpoint-rejected',
        checkpointIndex,
        expectedCheckpointIndex,
        snapshot: this.snapshot(),
      }];
      this.assertCheckpointShadow(rejected, shadowOutcome, 'checkpoint-rejected');
      return rejected;
    }

    this.checkpointsPassed += 1;
    const checkpointOrdinal = this.checkpointOrdinal;
    const events = [{
      type: 'checkpoint-completed',
      checkpointIndex,
      checkpointOrdinal,
      lapNumber: this.currentLapNumber,
      snapshot: this.snapshot(),
    }];
    if (this.sectorCheckpoints[this.currentSector] === checkpointOrdinal) {
      events.push(this.completeSector());
    }
    if (checkpointOrdinal === this.checkpointCount) {
      events.push(...this.completeLap());
    }
    this.assertCheckpointShadow(events, shadowOutcome, 'checkpoint-accepted');
    return events;
  }

  passCheckpointOwned(checkpointIndex) {
    const prepared = this.progressSession.prepareCheckpoint(checkpointIndex);
    if (!prepared.accepted) {
      if (!prepared.rejected) return [];
      return [{
        type: 'checkpoint-rejected',
        checkpointIndex,
        expectedCheckpointIndex: this.expectedCheckpointIndex,
        snapshot: this.snapshot(),
      }];
    }

    const checkpointSnapshot = this.progressSession.snapshot();
    const events = [{
      type: 'checkpoint-completed',
      checkpointIndex,
      checkpointOrdinal: prepared.checkpointOrdinal,
      lapNumber: checkpointSnapshot.currentLapNumber,
      snapshot: this.snapshot(),
    }];

    const sectorTimeMs = this.progressSession.commitSector();
    if (sectorTimeMs !== null) {
      events.push(this.completeSectorOwned(sectorTimeMs, checkpointSnapshot));
    }

    const lapOutcome = this.progressSession.commitLap();
    if (lapOutcome) {
      events.push(this.completeLapOwned(lapOutcome, checkpointSnapshot.currentLapNumber));
    }

    const runCompleted = this.progressSession.commitRun();
    if (runCompleted) events.push(this.completeRun());
    this.progressSession.finishCheckpoint();
    return events;
  }

  completeSectorOwned(sectorTimeMs, checkpointSnapshot) {
    const sectorIndex = checkpointSnapshot.currentSectorNumber - 1;
    const bestSectorMs = this.record.bestSectorsMs[sectorIndex];
    this.currentSectorsMs.push(sectorTimeMs);
    return {
      type: 'sector-completed',
      lapNumber: checkpointSnapshot.currentLapNumber,
      sectorNumber: checkpointSnapshot.currentSectorNumber,
      timeMs: sectorTimeMs,
      deltaMs: !checkpointSnapshot.currentLapValid || bestSectorMs == null
        ? null
        : sectorTimeMs - bestSectorMs,
      valid: checkpointSnapshot.currentLapValid,
      snapshot: this.snapshot(),
    };
  }

  completeLapOwned({ timeMs, valid }, lapNumber) {
    const previousBestLapMs = this.record.bestLapMs;
    const lap = {
      number: lapNumber,
      timeMs,
      sectorsMs: [...this.currentSectorsMs],
      valid,
      invalidReasons: [...this.currentInvalidReasons],
      deltaMs: !valid || previousBestLapMs == null ? null : timeMs - previousBestLapMs,
      newBest: false,
    };

    if (lap.valid) {
      if (previousBestLapMs == null || lap.timeMs < previousBestLapMs) {
        this.record.bestLapMs = lap.timeMs;
        lap.newBest = true;
      }
      lap.sectorsMs.forEach((sectorTimeMs, index) => {
        const previous = this.record.bestSectorsMs[index];
        if (previous == null || sectorTimeMs < previous) this.record.bestSectorsMs[index] = sectorTimeMs;
      });
    }
    this.laps.push(lap);
    const finalLap = this.laps.length >= this.totalLaps;
    if (!finalLap) {
      if (lap.valid) this.store.save(this.identity, this.record);
      this.currentSectorsMs = [];
      this.currentInvalidReasons = [];
    }
    return {
      type: 'lap-completed',
      lap: {
        ...lap,
        sectorsMs: [...lap.sectorsMs],
        invalidReasons: [...lap.invalidReasons],
      },
      snapshot: this.snapshot(),
    };
  }

  assertProgressShadow(label) {
    if (!this.progressShadow) return;
    const legacy = this.snapshot();
    const expected = Object.fromEntries(PROGRESS_FIELDS.map((field) => [field, legacy[field]]));
    const actual = this.progressShadow.snapshot();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `race progress shadow mismatch after ${label}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`,
      );
    }
  }

  assertCheckpointShadow(events, shadowOutcome, label) {
    if (!this.progressShadow) return;
    const checkpoint = events.find(({ type }) => type === 'checkpoint-completed');
    const sector = events.find(({ type }) => type === 'sector-completed');
    const lap = events.find(({ type }) => type === 'lap-completed')?.lap;
    const expected = {
      rejected: events.some(({ type }) => type === 'checkpoint-rejected'),
      accepted: Boolean(checkpoint),
      checkpointOrdinal: checkpoint?.checkpointOrdinal ?? null,
      sectorTimeMs: sector?.timeMs ?? null,
      lapTimeMs: lap?.timeMs ?? null,
      lapValid: lap?.valid ?? null,
      runCompleted: events.some(({ type }) => type === 'run-completed'),
    };
    if (JSON.stringify(shadowOutcome) !== JSON.stringify(expected)) {
      throw new Error(
        `race progress shadow outcome mismatch after ${label}: expected=${JSON.stringify(expected)} actual=${JSON.stringify(shadowOutcome)}`,
      );
    }
    this.assertProgressShadow(label);
  }

  completeSector() {
    const sectorTimeMs = roundedDuration(this.runTimeExactMs - this.sectorStartedAtExactMs);
    const bestSectorMs = this.record.bestSectorsMs[this.currentSector];
    const event = {
      type: 'sector-completed',
      lapNumber: this.currentLapNumber,
      sectorNumber: this.currentSector + 1,
      timeMs: sectorTimeMs,
      deltaMs: !this.currentLapValid || bestSectorMs == null ? null : sectorTimeMs - bestSectorMs,
      valid: this.currentLapValid,
    };
    this.currentSectorsMs.push(sectorTimeMs);
    this.currentSector += 1;
    this.sectorStartedAtExactMs = this.runTimeExactMs;
    event.snapshot = this.snapshot();
    return event;
  }

  completeLap() {
    const previousBestLapMs = this.record.bestLapMs;
    const lapTimeMs = roundedDuration(this.runTimeExactMs - this.lapStartedAtExactMs);
    const lap = {
      number: this.currentLapNumber,
      timeMs: lapTimeMs,
      sectorsMs: [...this.currentSectorsMs],
      valid: this.currentLapValid,
      invalidReasons: [...this.currentInvalidReasons],
      deltaMs: !this.currentLapValid || previousBestLapMs == null ? null : lapTimeMs - previousBestLapMs,
      newBest: false,
    };

    if (lap.valid) {
      if (previousBestLapMs == null || lap.timeMs < previousBestLapMs) {
        this.record.bestLapMs = lap.timeMs;
        lap.newBest = true;
      }
      lap.sectorsMs.forEach((sectorTimeMs, index) => {
        const previous = this.record.bestSectorsMs[index];
        if (previous == null || sectorTimeMs < previous) this.record.bestSectorsMs[index] = sectorTimeMs;
      });
    }
    this.laps.push(lap);
    const lapEvent = {
      type: 'lap-completed',
      lap: {
        ...lap,
        sectorsMs: [...lap.sectorsMs],
        invalidReasons: [...lap.invalidReasons],
      },
      snapshot: null,
    };

    if (this.laps.length >= this.totalLaps) {
      lapEvent.snapshot = this.snapshot();
      return [lapEvent, this.completeRun()];
    }

    if (lap.valid) this.store.save(this.identity, this.record);
    this.lapStartedAtExactMs = this.runTimeExactMs;
    this.sectorStartedAtExactMs = this.runTimeExactMs;
    this.currentSector = 0;
    this.currentSectorsMs = [];
    this.currentLapValid = true;
    this.currentInvalidReasons = [];
    lapEvent.snapshot = this.snapshot();
    return [lapEvent];
  }

  completeRun() {
    if (!this.progressOwned) this.status = 'finished';
    const raceTimeMs = this.progressOwned
      ? this.progressSession.snapshot().runTimeMs
      : roundedDuration(this.runTimeExactMs);
    const valid = this.laps.every((lap) => lap.valid);
    const raceKey = String(this.totalLaps);
    const previousBestRaceMs = this.record.bestRaceMsByLaps[raceKey] ?? null;
    const newBestRace = valid && (previousBestRaceMs == null || raceTimeMs < previousBestRaceMs);
    if (newBestRace) this.record.bestRaceMsByLaps[raceKey] = raceTimeMs;
    this.record.completedRuns += 1;
    if (valid) this.record.validRuns += 1;

    this.summary = {
      timeMs: raceTimeMs,
      valid,
      medal: valid ? resolveMedal(raceTimeMs, this.medalTargetsMs) : null,
      deltaMs: !valid || previousBestRaceMs == null ? null : raceTimeMs - previousBestRaceMs,
      newBestRace,
      bestRaceMs: this.record.bestRaceMsByLaps[raceKey] ?? null,
      bestLapMs: this.record.bestLapMs,
      laps: this.laps.map((lap) => ({
        ...lap,
        sectorsMs: [...lap.sectorsMs],
        invalidReasons: [...lap.invalidReasons],
      })),
    };
    this.store.save(this.identity, this.record);
    return {
      type: 'run-completed',
      summary: this.getSummary(),
      snapshot: this.snapshot(),
    };
  }

  get currentLapNumber() {
    if (this.progressOwned) return this.progressSession.snapshot().currentLapNumber;
    return Math.min(this.laps.length + 1, this.totalLaps);
  }

  get expectedCheckpointIndex() {
    if (this.progressOwned) return this.progressSession.snapshot().expectedCheckpointIndex;
    return (this.checkpointsPassed + 1) % this.checkpointCount;
  }

  get checkpointOrdinal() {
    if (this.progressOwned) return this.progressSession.snapshot().checkpointOrdinal;
    const withinLap = this.checkpointsPassed % this.checkpointCount;
    if (this.checkpointsPassed === 0) return 0;
    return withinLap === 0 ? this.checkpointCount : withinLap;
  }

  getRecord() {
    return copyRecord(this.record);
  }

  getSummary() {
    if (!this.summary) return null;
    return {
      ...this.summary,
      laps: this.summary.laps.map((lap) => ({
        ...lap,
        sectorsMs: [...lap.sectorsMs],
        invalidReasons: [...lap.invalidReasons],
      })),
    };
  }

  snapshot() {
    if (this.progressOwned) {
      return {
        ...this.progressSession.snapshot(),
        totalLaps: this.totalLaps,
        invalidReasons: [...this.currentInvalidReasons],
        bestLapMs: this.record.bestLapMs,
        bestSectorsMs: [...this.record.bestSectorsMs],
        bestRaceMs: this.record.bestRaceMsByLaps[String(this.totalLaps)] ?? null,
        laps: this.laps.map((lap) => ({
          ...lap,
          sectorsMs: [...lap.sectorsMs],
          invalidReasons: [...lap.invalidReasons],
        })),
      };
    }
    const running = this.status === 'running';
    const lapTimeExactMs = running ? this.runTimeExactMs - this.lapStartedAtExactMs : 0;
    const sectorTimeExactMs = running ? this.runTimeExactMs - this.sectorStartedAtExactMs : 0;
    return {
      status: this.status,
      runTimeMs: roundedDuration(this.runTimeExactMs),
      currentLapNumber: this.currentLapNumber,
      totalLaps: this.totalLaps,
      lapTimeMs: roundedDuration(lapTimeExactMs),
      currentSectorNumber: running ? Math.min(this.currentSector + 1, this.sectorCheckpoints.length) : 1,
      sectorTimeMs: roundedDuration(sectorTimeExactMs),
      checkpointsPassed: this.checkpointsPassed,
      checkpointOrdinal: this.checkpointOrdinal,
      checkpointInLap: this.checkpointsPassed % this.checkpointCount,
      expectedCheckpointIndex: this.expectedCheckpointIndex,
      currentLapValid: this.currentLapValid,
      invalidReasons: [...this.currentInvalidReasons],
      bestLapMs: this.record.bestLapMs,
      bestSectorsMs: [...this.record.bestSectorsMs],
      bestRaceMs: this.record.bestRaceMsByLaps[String(this.totalLaps)] ?? null,
      laps: this.laps.map((lap) => ({
        ...lap,
        sectorsMs: [...lap.sectorsMs],
        invalidReasons: [...lap.invalidReasons],
      })),
    };
  }
}
