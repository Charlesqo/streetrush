//! Pure race-progress and timing rules shared by native and web targets.

/// Version of the scalar raw-WASM timing contract.
pub const TIMING_CONTRACT_VERSION: u32 = 1;

pub const TIMING_EVENT_CHECKPOINT_REJECTED: u32 = 1 << 0;
pub const TIMING_EVENT_CHECKPOINT_ACCEPTED: u32 = 1 << 1;
pub const TIMING_EVENT_SECTOR_COMPLETED: u32 = 1 << 2;
pub const TIMING_EVENT_LAP_COMPLETED: u32 = 1 << 3;
pub const TIMING_EVENT_RUN_COMPLETED: u32 = 1 << 4;

const FIRST_NON_CONSECUTIVE_INTEGER: f64 = 4_503_599_627_370_496.0;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum RaceStatus {
    Idle = 0,
    Running = 1,
    Finished = 2,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Medal {
    None = 0,
    Gold = 1,
    Silver = 2,
    Bronze = 3,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimingConfigError {
    ZeroLaps,
    ZeroCheckpoints,
    MissingSectorFinish,
    InvalidSectorCheckpoint,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TimingInputError {
    InvalidDelta,
    CheckpointOutOfRange,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ProgressSnapshot {
    pub status: RaceStatus,
    pub run_time_ms: f64,
    pub current_lap_number: u32,
    pub lap_time_ms: f64,
    pub current_sector_number: u32,
    pub sector_time_ms: f64,
    pub checkpoints_passed: u32,
    pub checkpoint_ordinal: u32,
    pub checkpoint_in_lap: u32,
    pub expected_checkpoint_index: u32,
    pub current_lap_valid: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CheckpointOutcome {
    pub flags: u32,
    pub checkpoint_ordinal: u32,
    pub sector_time_ms: Option<f64>,
    pub lap_time_ms: Option<f64>,
    pub lap_valid: Option<bool>,
}

impl CheckpointOutcome {
    const fn empty(flags: u32, checkpoint_ordinal: u32) -> Self {
        Self {
            flags,
            checkpoint_ordinal,
            sector_time_ms: None,
            lap_time_ms: None,
            lap_valid: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct RaceProgress {
    total_laps: u32,
    checkpoint_count: u32,
    sector_checkpoints: Vec<u32>,
    status: RaceStatus,
    run_time_exact_ms: f64,
    lap_started_at_exact_ms: f64,
    sector_started_at_exact_ms: f64,
    checkpoints_passed: u32,
    current_sector: usize,
    current_lap_valid: bool,
}

impl RaceProgress {
    /// Create an idle progress owner with generic sector boundaries.
    ///
    /// # Errors
    ///
    /// Returns [`TimingConfigError`] when laps/checkpoints are zero or sector
    /// ordinals are missing, unordered, or outside the lap.
    pub fn new(
        total_laps: u32,
        checkpoint_count: u32,
        sector_checkpoints: &[u32],
    ) -> Result<Self, TimingConfigError> {
        if total_laps == 0 {
            return Err(TimingConfigError::ZeroLaps);
        }
        if checkpoint_count == 0 {
            return Err(TimingConfigError::ZeroCheckpoints);
        }
        if sector_checkpoints.last() != Some(&checkpoint_count) {
            return Err(TimingConfigError::MissingSectorFinish);
        }
        let mut previous = 0;
        for &checkpoint in sector_checkpoints {
            if checkpoint <= previous || checkpoint > checkpoint_count {
                return Err(TimingConfigError::InvalidSectorCheckpoint);
            }
            previous = checkpoint;
        }

        Ok(Self {
            total_laps,
            checkpoint_count,
            sector_checkpoints: sector_checkpoints.to_vec(),
            status: RaceStatus::Idle,
            run_time_exact_ms: 0.0,
            lap_started_at_exact_ms: 0.0,
            sector_started_at_exact_ms: 0.0,
            checkpoints_passed: 0,
            current_sector: 0,
            current_lap_valid: true,
        })
    }

    pub fn reset(&mut self) -> ProgressSnapshot {
        self.status = RaceStatus::Idle;
        self.run_time_exact_ms = 0.0;
        self.lap_started_at_exact_ms = 0.0;
        self.sector_started_at_exact_ms = 0.0;
        self.checkpoints_passed = 0;
        self.current_sector = 0;
        self.current_lap_valid = true;
        self.snapshot()
    }

    pub fn start(&mut self) -> ProgressSnapshot {
        self.reset();
        self.status = RaceStatus::Running;
        self.snapshot()
    }

    /// Advance the exact clock while the race is running.
    ///
    /// # Errors
    ///
    /// Returns [`TimingInputError::InvalidDelta`] for a negative or non-finite
    /// delta without mutating the progress state.
    pub fn advance(&mut self, delta_ms: f64) -> Result<ProgressSnapshot, TimingInputError> {
        if !delta_ms.is_finite() || delta_ms < 0.0 {
            return Err(TimingInputError::InvalidDelta);
        }
        self.run_time_exact_ms =
            advance_race_time_exact_ms(self.status as u32, self.run_time_exact_ms, delta_ms);
        Ok(self.snapshot())
    }

    pub fn invalidate(&mut self) -> bool {
        if self.status != RaceStatus::Running || !self.current_lap_valid {
            return false;
        }
        self.current_lap_valid = false;
        true
    }

    /// Apply one zero-based checkpoint index.
    ///
    /// # Errors
    ///
    /// Returns [`TimingInputError::CheckpointOutOfRange`] when the index is not
    /// part of the configured lap, without mutating the progress state.
    pub fn pass_checkpoint(
        &mut self,
        checkpoint_index: u32,
    ) -> Result<CheckpointOutcome, TimingInputError> {
        if checkpoint_index >= self.checkpoint_count {
            return Err(TimingInputError::CheckpointOutOfRange);
        }
        if self.status != RaceStatus::Running {
            return Ok(CheckpointOutcome::empty(0, self.checkpoint_ordinal()));
        }

        let next_sector_checkpoint = self.sector_checkpoints[self.current_sector];
        let flags = classify_checkpoint(
            self.status as u32,
            self.checkpoints_passed,
            self.total_laps,
            self.checkpoint_count,
            next_sector_checkpoint,
            checkpoint_index,
        );
        if flags & TIMING_EVENT_CHECKPOINT_REJECTED != 0 {
            return Ok(CheckpointOutcome::empty(flags, self.checkpoint_ordinal()));
        }
        if flags & TIMING_EVENT_CHECKPOINT_ACCEPTED == 0 {
            return Ok(CheckpointOutcome::empty(flags, self.checkpoint_ordinal()));
        }

        self.checkpoints_passed += 1;
        let mut outcome = CheckpointOutcome::empty(flags, self.checkpoint_ordinal());
        if flags & TIMING_EVENT_SECTOR_COMPLETED != 0 {
            outcome.sector_time_ms = Some(round_duration_ms(
                self.run_time_exact_ms - self.sector_started_at_exact_ms,
            ));
            self.current_sector += 1;
            self.sector_started_at_exact_ms = self.run_time_exact_ms;
        }
        if flags & TIMING_EVENT_LAP_COMPLETED != 0 {
            outcome.lap_time_ms = Some(round_duration_ms(
                self.run_time_exact_ms - self.lap_started_at_exact_ms,
            ));
            outcome.lap_valid = Some(self.current_lap_valid);
        }
        if flags & TIMING_EVENT_RUN_COMPLETED != 0 {
            self.status = RaceStatus::Finished;
        } else if flags & TIMING_EVENT_LAP_COMPLETED != 0 {
            self.lap_started_at_exact_ms = self.run_time_exact_ms;
            self.sector_started_at_exact_ms = self.run_time_exact_ms;
            self.current_sector = 0;
            self.current_lap_valid = true;
        }
        Ok(outcome)
    }

    #[must_use]
    pub fn snapshot(&self) -> ProgressSnapshot {
        let running = self.status == RaceStatus::Running;
        ProgressSnapshot {
            status: self.status,
            run_time_ms: round_duration_ms(self.run_time_exact_ms),
            current_lap_number: (self.checkpoints_passed / self.checkpoint_count + 1)
                .min(self.total_laps),
            lap_time_ms: if running {
                round_duration_ms(self.run_time_exact_ms - self.lap_started_at_exact_ms)
            } else {
                0.0
            },
            current_sector_number: if running {
                (u32::try_from(self.current_sector).unwrap_or(u32::MAX) + 1)
                    .min(u32::try_from(self.sector_checkpoints.len()).unwrap_or(u32::MAX))
            } else {
                1
            },
            sector_time_ms: if running {
                round_duration_ms(self.run_time_exact_ms - self.sector_started_at_exact_ms)
            } else {
                0.0
            },
            checkpoints_passed: self.checkpoints_passed,
            checkpoint_ordinal: self.checkpoint_ordinal(),
            checkpoint_in_lap: self.checkpoints_passed % self.checkpoint_count,
            expected_checkpoint_index: expected_checkpoint_index(
                self.checkpoints_passed,
                self.checkpoint_count,
            ),
            current_lap_valid: self.current_lap_valid,
        }
    }

    fn checkpoint_ordinal(&self) -> u32 {
        checkpoint_ordinal(self.checkpoints_passed, self.checkpoint_count)
    }
}

/// Match `Math.max(0, Math.round(value))` for timing durations.
#[must_use]
pub fn round_duration_ms(value: f64) -> f64 {
    if value.is_nan() || value <= 0.0 {
        return 0.0;
    }
    if value.is_infinite() || value >= FIRST_NON_CONSECUTIVE_INTEGER {
        return value;
    }
    let lower = value.floor();
    if value - lower < 0.5 {
        lower
    } else {
        lower + 1.0
    }
}

#[must_use]
pub fn advance_race_time_exact_ms(status: u32, current_ms: f64, delta_ms: f64) -> f64 {
    if status == RaceStatus::Running as u32 && delta_ms.is_finite() && delta_ms >= 0.0 {
        current_ms + delta_ms
    } else {
        current_ms
    }
}

#[must_use]
pub fn expected_checkpoint_index(checkpoints_passed: u32, checkpoint_count: u32) -> u32 {
    if checkpoint_count == 0 {
        return 0;
    }
    u32::try_from((u64::from(checkpoints_passed) + 1) % u64::from(checkpoint_count)).unwrap_or(0)
}

#[must_use]
pub fn checkpoint_ordinal(checkpoints_passed: u32, checkpoint_count: u32) -> u32 {
    if checkpoints_passed == 0 || checkpoint_count == 0 {
        return 0;
    }
    let within_lap = checkpoints_passed % checkpoint_count;
    if within_lap == 0 {
        checkpoint_count
    } else {
        within_lap
    }
}

#[must_use]
pub fn classify_checkpoint(
    status: u32,
    checkpoints_passed: u32,
    total_laps: u32,
    checkpoint_count: u32,
    next_sector_checkpoint: u32,
    checkpoint_index: u32,
) -> u32 {
    if status != RaceStatus::Running as u32
        || total_laps == 0
        || checkpoint_count == 0
        || checkpoint_index >= checkpoint_count
    {
        return 0;
    }
    if checkpoint_index != expected_checkpoint_index(checkpoints_passed, checkpoint_count) {
        return TIMING_EVENT_CHECKPOINT_REJECTED;
    }

    let Some(next_passed_u32) = checkpoints_passed.checked_add(1) else {
        return 0;
    };
    let next_passed = u64::from(next_passed_u32);
    let ordinal = checkpoint_ordinal(next_passed_u32, checkpoint_count);
    let mut flags = TIMING_EVENT_CHECKPOINT_ACCEPTED;
    if next_sector_checkpoint > 0
        && next_sector_checkpoint <= checkpoint_count
        && ordinal == next_sector_checkpoint
    {
        flags |= TIMING_EVENT_SECTOR_COMPLETED;
    }
    if ordinal == checkpoint_count {
        flags |= TIMING_EVENT_LAP_COMPLETED;
        if next_passed >= u64::from(total_laps) * u64::from(checkpoint_count) {
            flags |= TIMING_EVENT_RUN_COMPLETED;
        }
    }
    flags
}

#[must_use]
pub fn resolve_medal_ms(time_ms: f64, gold_ms: f64, silver_ms: f64, bronze_ms: f64) -> Medal {
    if !time_ms.is_finite()
        || time_ms < 0.0
        || !gold_ms.is_finite()
        || !silver_ms.is_finite()
        || !bronze_ms.is_finite()
        || gold_ms < 0.0
        || gold_ms > silver_ms
        || silver_ms > bronze_ms
    {
        return Medal::None;
    }
    if time_ms <= gold_ms {
        Medal::Gold
    } else if time_ms <= silver_ms {
        Medal::Silver
    } else if time_ms <= bronze_ms {
        Medal::Bronze
    } else {
        Medal::None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_progress_configuration() {
        assert_eq!(
            RaceProgress::new(0, 3, &[1, 2, 3]),
            Err(TimingConfigError::ZeroLaps)
        );
        assert_eq!(
            RaceProgress::new(2, 0, &[1]),
            Err(TimingConfigError::ZeroCheckpoints)
        );
        assert_eq!(
            RaceProgress::new(2, 3, &[1, 2]),
            Err(TimingConfigError::MissingSectorFinish)
        );
        assert_eq!(
            RaceProgress::new(2, 3, &[2, 2, 3]),
            Err(TimingConfigError::InvalidSectorCheckpoint)
        );
    }

    #[test]
    fn matches_fractional_invalid_and_restart_progression() {
        let mut progress = RaceProgress::new(2, 3, &[1, 2, 3]).expect("valid timing config");
        progress.start();
        for _ in 0..3 {
            progress.advance(1000.0 / 3.0).expect("valid delta");
        }
        assert_eq!(
            progress.snapshot().run_time_ms.to_bits(),
            1000.0_f64.to_bits()
        );

        let rejected = progress.pass_checkpoint(2).expect("in-range checkpoint");
        assert_eq!(rejected.flags, TIMING_EVENT_CHECKPOINT_REJECTED);
        assert_eq!(progress.snapshot().checkpoints_passed, 0);
        assert!(progress.invalidate());
        assert!(!progress.invalidate());

        let first = progress.pass_checkpoint(1).expect("expected checkpoint");
        assert_eq!(first.sector_time_ms, Some(1000.0));
        progress.advance(2000.4).expect("valid delta");
        progress.pass_checkpoint(2).expect("expected checkpoint");
        progress.advance(3000.4).expect("valid delta");
        let invalid_lap = progress.pass_checkpoint(0).expect("lap finish");
        assert_eq!(invalid_lap.lap_time_ms, Some(6001.0));
        assert_eq!(invalid_lap.lap_valid, Some(false));
        assert_eq!(progress.snapshot().current_lap_number, 2);
        assert!(progress.snapshot().current_lap_valid);

        for (delta, checkpoint) in [(900.2, 1), (1900.2, 2), (2900.2, 0)] {
            progress.advance(delta).expect("valid delta");
            progress
                .pass_checkpoint(checkpoint)
                .expect("expected checkpoint");
        }
        let finished = progress.snapshot();
        assert_eq!(finished.status, RaceStatus::Finished);
        assert_eq!(finished.run_time_ms.to_bits(), 11701.0_f64.to_bits());

        let restarted = progress.start();
        assert_eq!(restarted.status, RaceStatus::Running);
        assert_eq!(restarted.run_time_ms.to_bits(), 0.0_f64.to_bits());
    }

    #[test]
    fn resolves_medal_boundaries() {
        assert_eq!(
            resolve_medal_ms(12_000.0, 12_000.0, 15_000.0, 18_000.0),
            Medal::Gold
        );
        assert_eq!(
            resolve_medal_ms(12_001.0, 12_000.0, 15_000.0, 18_000.0),
            Medal::Silver
        );
        assert_eq!(
            resolve_medal_ms(18_000.0, 12_000.0, 15_000.0, 18_000.0),
            Medal::Bronze
        );
        assert_eq!(
            resolve_medal_ms(18_001.0, 12_000.0, 15_000.0, 18_000.0),
            Medal::None
        );
    }

    #[test]
    fn rejects_invalid_inputs_without_mutating_state() {
        let mut progress = RaceProgress::new(1, 3, &[1, 2, 3]).expect("valid timing config");
        progress.start();
        let before = progress.snapshot();
        assert_eq!(progress.advance(-1.0), Err(TimingInputError::InvalidDelta));
        assert_eq!(
            progress.pass_checkpoint(3),
            Err(TimingInputError::CheckpointOutOfRange)
        );
        assert_eq!(progress.snapshot(), before);
        assert_eq!(
            classify_checkpoint(RaceStatus::Running as u32, u32::MAX, 1, 3, 1, 1),
            0
        );
    }
}
