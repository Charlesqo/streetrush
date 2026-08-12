//! Dependency-free raw WebAssembly ABI for the first shared-core slice.

use crate::scheduling::{
    FIXED_DT_SECONDS, MAX_FRAME_DT_SECONDS, MAX_PHYSICS_STEPS, accumulate_physics_time,
    clamp_frame_delta, plan_frame, simulate_render_frames,
};
use crate::timing::{
    TIMING_CONTRACT_VERSION, advance_race_time_exact_ms, checkpoint_ordinal, classify_checkpoint,
    expected_checkpoint_index, resolve_medal_ms, round_duration_ms,
};
use crate::{
    REPLAY_DIGEST_OFFSET_BASIS, REPLAY_FORMAT_VERSION, REPLAY_QUANTUM, canonical_f64_bits,
    quantize_replay_value, replay_digest_push_f64,
};

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_timing_contract_version() -> u32 {
    TIMING_CONTRACT_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_timing_advance_exact_ms(
    status: u32,
    current_ms: f64,
    delta_ms: f64,
) -> f64 {
    advance_race_time_exact_ms(status, current_ms, delta_ms)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_timing_round_duration_ms(value: f64) -> f64 {
    round_duration_ms(value)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_timing_expected_checkpoint_index(
    checkpoints_passed: u32,
    checkpoint_count: u32,
) -> u32 {
    expected_checkpoint_index(checkpoints_passed, checkpoint_count)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_timing_checkpoint_ordinal(
    checkpoints_passed: u32,
    checkpoint_count: u32,
) -> u32 {
    checkpoint_ordinal(checkpoints_passed, checkpoint_count)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_timing_checkpoint_flags(
    status: u32,
    checkpoints_passed: u32,
    total_laps: u32,
    checkpoint_count: u32,
    next_sector_checkpoint: u32,
    checkpoint_index: u32,
) -> u32 {
    classify_checkpoint(
        status,
        checkpoints_passed,
        total_laps,
        checkpoint_count,
        next_sector_checkpoint,
        checkpoint_index,
    )
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_timing_resolve_medal(
    time_ms: f64,
    gold_ms: f64,
    silver_ms: f64,
    bronze_ms: f64,
) -> u32 {
    resolve_medal_ms(time_ms, gold_ms, silver_ms, bronze_ms) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_replay_format_version() -> u32 {
    REPLAY_FORMAT_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_replay_quantum() -> f64 {
    REPLAY_QUANTUM
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_replay_digest_offset_basis() -> u64 {
    REPLAY_DIGEST_OFFSET_BASIS
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_replay_canonical_f64_bits(value: f64) -> u64 {
    canonical_f64_bits(value)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_quantize_replay_value(value: f64, quantum: f64) -> f64 {
    quantize_replay_value(value, quantum)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_replay_digest_push_f64(state: u64, value: f64) -> u64 {
    replay_digest_push_f64(state, value)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_fixed_dt_seconds() -> f64 {
    FIXED_DT_SECONDS
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_max_frame_dt_seconds() -> f64 {
    MAX_FRAME_DT_SECONDS
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_max_physics_steps() -> u32 {
    MAX_PHYSICS_STEPS
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_clamp_frame_delta(delta_seconds: f64) -> f64 {
    clamp_frame_delta(delta_seconds)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_accumulate_physics_time(
    accumulator_seconds: f64,
    delta_seconds: f64,
) -> f64 {
    accumulate_physics_time(accumulator_seconds, delta_seconds)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_plan_physics_steps(
    accumulator_seconds: f64,
    delta_seconds: f64,
) -> u32 {
    plan_frame(accumulator_seconds, delta_seconds).steps
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_plan_remainder_seconds(
    accumulator_seconds: f64,
    delta_seconds: f64,
) -> f64 {
    plan_frame(accumulator_seconds, delta_seconds).remainder_seconds
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_simulate_step_count(delta_seconds: f64, frame_count: u32) -> u64 {
    simulate_render_frames(delta_seconds, frame_count).steps
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_simulate_remainder_seconds(
    delta_seconds: f64,
    frame_count: u32,
) -> f64 {
    simulate_render_frames(delta_seconds, frame_count).remainder_seconds
}
