//! Renderer-independent state and rules shared by native and WebAssembly targets.

pub mod replay;
pub mod scheduling;
pub mod timing;

#[cfg(target_arch = "wasm32")]
// Raw WebAssembly exports require explicit stable symbol names. Keep the lint
// exception confined to this ABI module; the workspace still denies unsafe
// blocks and unsafe attributes everywhere else.
#[allow(unsafe_code)]
mod wasm_exports;

pub use replay::{
    REPLAY_DIGEST_OFFSET_BASIS, REPLAY_FORMAT_VERSION, REPLAY_QUANTUM, canonical_f64_bits,
    quantize_replay_value, replay_digest_push_f64,
};
pub use scheduling::{
    FIXED_DT_SECONDS, FixedStepScheduler, FramePlan, MAX_FRAME_DT_SECONDS, MAX_PHYSICS_STEPS,
    SimulationResult, accumulate_physics_time, clamp_frame_delta, plan_frame,
    simulate_render_frames,
};
pub use timing::{
    CheckpointOutcome, Medal, ProgressSnapshot, RaceProgress, RaceStatus, TIMING_CONTRACT_VERSION,
    TIMING_EVENT_CHECKPOINT_ACCEPTED, TIMING_EVENT_CHECKPOINT_REJECTED, TIMING_EVENT_LAP_COMPLETED,
    TIMING_EVENT_RUN_COMPLETED, TIMING_EVENT_SECTOR_COMPLETED, TimingConfigError, TimingInputError,
    advance_race_time_exact_ms, checkpoint_ordinal, classify_checkpoint, expected_checkpoint_index,
    resolve_medal_ms, round_duration_ms,
};
