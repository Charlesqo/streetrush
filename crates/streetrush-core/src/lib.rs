//! Renderer-independent state and rules shared by native and WebAssembly targets.

pub mod replay;
pub mod scheduling;

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
