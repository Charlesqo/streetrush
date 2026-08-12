//! Fixed-step scheduling contract shared by the native and web runtimes.
//!
//! The initial behavior is intentionally matched to the committed JavaScript
//! baseline in `src/physics-scheduling.js`: 120 Hz simulation, a 50 ms accepted
//! render-frame delta, and a six-step catch-up budget.

/// Simulation frequency used by the current playable baseline.
pub const FIXED_HZ: u32 = 120;
/// Duration of one physics tick in seconds.
pub const FIXED_DT_SECONDS: f64 = 1.0 / FIXED_HZ as f64;
/// Largest render-frame delta accepted by the scheduler.
pub const MAX_FRAME_DT_SECONDS: f64 = 0.05;
/// Maximum number of fixed steps consumed for one render frame.
pub const MAX_PHYSICS_STEPS: u32 = 6;

/// Result of accepting one render-frame delta.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FramePlan {
    pub steps: u32,
    pub remainder_seconds: f64,
}

/// Aggregate result for a deterministic render-frame sequence.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SimulationResult {
    pub steps: u64,
    pub remainder_seconds: f64,
}

/// Stateful fixed-step accumulator used by both executable targets.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FixedStepScheduler {
    accumulator_seconds: f64,
}

impl FixedStepScheduler {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            accumulator_seconds: 0.0,
        }
    }

    #[must_use]
    pub const fn accumulator_seconds(&self) -> f64 {
        self.accumulator_seconds
    }

    pub fn reset(&mut self) {
        self.accumulator_seconds = 0.0;
    }

    pub fn advance(&mut self, delta_seconds: f64) -> FramePlan {
        let plan = plan_frame(self.accumulator_seconds, delta_seconds);
        self.accumulator_seconds = plan.remainder_seconds;
        plan
    }
}

/// Match `Math.min(MAX_FRAME_DT, Math.max(0, deltaSeconds))`, including NaN.
#[must_use]
pub fn clamp_frame_delta(delta_seconds: f64) -> f64 {
    delta_seconds.clamp(0.0, MAX_FRAME_DT_SECONDS)
}

/// Fill the accumulator while preserving the JavaScript baseline's hard cap.
#[must_use]
pub fn accumulate_physics_time(accumulator_seconds: f64, delta_seconds: f64) -> f64 {
    let total = accumulator_seconds + clamp_frame_delta(delta_seconds);
    if total.is_nan() {
        f64::NAN
    } else {
        total.min(FIXED_DT_SECONDS * f64::from(MAX_PHYSICS_STEPS))
    }
}

/// Plan the fixed steps for one render frame without mutating caller state.
#[must_use]
pub fn plan_frame(accumulator_seconds: f64, delta_seconds: f64) -> FramePlan {
    let mut remainder_seconds = accumulate_physics_time(accumulator_seconds, delta_seconds);
    let mut steps = 0;
    while remainder_seconds >= FIXED_DT_SECONDS && steps < MAX_PHYSICS_STEPS {
        remainder_seconds -= FIXED_DT_SECONDS;
        steps += 1;
    }
    FramePlan {
        steps,
        remainder_seconds,
    }
}

/// Run a constant render-frame sequence through the same stateful scheduler.
#[must_use]
pub fn simulate_render_frames(delta_seconds: f64, frame_count: u32) -> SimulationResult {
    let mut scheduler = FixedStepScheduler::new();
    let mut steps = 0_u64;
    for _ in 0..frame_count {
        steps += u64::from(scheduler.advance(delta_seconds).steps);
    }
    SimulationResult {
        steps,
        remainder_seconds: scheduler.accumulator_seconds(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPSILON: f64 = 1.0e-12;

    fn assert_near(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < EPSILON,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn constants_match_the_committed_javascript_contract() {
        assert!((FIXED_DT_SECONDS - 1.0 / 120.0).abs() < f64::EPSILON);
        assert!((MAX_FRAME_DT_SECONDS - 0.05).abs() < f64::EPSILON);
        assert_eq!(MAX_PHYSICS_STEPS, 6);
    }

    #[test]
    fn clamp_matches_javascript_boundaries() {
        assert_near(clamp_frame_delta(-1.0), 0.0);
        assert_near(clamp_frame_delta(f64::NEG_INFINITY), 0.0);
        assert_near(clamp_frame_delta(0.05), 0.05);
        assert_near(clamp_frame_delta(0.2), MAX_FRAME_DT_SECONDS);
        assert_near(clamp_frame_delta(f64::INFINITY), MAX_FRAME_DT_SECONDS);
        assert!(clamp_frame_delta(f64::NAN).is_nan());
    }

    #[test]
    fn accumulator_is_capped_to_the_per_frame_budget() {
        let cap = FIXED_DT_SECONDS * f64::from(MAX_PHYSICS_STEPS);
        assert_near(accumulate_physics_time(cap, 0.01), cap);
        assert_near(accumulate_physics_time(0.0, 1.0), cap);
        assert!(accumulate_physics_time(0.0, f64::NAN).is_nan());
    }

    #[test]
    fn frame_plan_consumes_at_most_six_steps() {
        let plan = plan_frame(0.0, 1.0);
        assert_eq!(plan.steps, 6);
        assert!(plan.remainder_seconds.abs() < EPSILON);
    }

    #[test]
    fn stateful_scheduler_preserves_substep_remainder() {
        let mut scheduler = FixedStepScheduler::new();
        let first = scheduler.advance(FIXED_DT_SECONDS * 0.75);
        let second = scheduler.advance(FIXED_DT_SECONDS * 0.75);
        assert_eq!(first.steps, 0);
        assert_eq!(second.steps, 1);
        assert!((second.remainder_seconds - FIXED_DT_SECONDS * 0.5).abs() < EPSILON);
        scheduler.reset();
        assert_near(scheduler.accumulator_seconds(), 0.0);
    }

    #[test]
    fn sixty_second_oracle_matches_the_web_baseline() {
        for (frames_per_second, expected_seconds) in [
            (60_u32, 60.0),
            (30, 60.0),
            (24, 60.0),
            (20, 60.0),
            (15, 45.0),
        ] {
            let result =
                simulate_render_frames(1.0 / f64::from(frames_per_second), frames_per_second * 60);
            let step_count = u32::try_from(result.steps).expect("one-minute step count fits u32");
            let simulated_seconds = f64::from(step_count) * FIXED_DT_SECONDS;
            assert!(
                (simulated_seconds - expected_seconds).abs() < 0.001,
                "{frames_per_second} FPS produced {simulated_seconds} seconds"
            );
        }
    }
}
