use std::process::ExitCode;

use streetrush_core::{
    FIXED_DT_SECONDS, REPLAY_DIGEST_OFFSET_BASIS, REPLAY_FORMAT_VERSION, REPLAY_QUANTUM,
    quantize_replay_value, replay_digest_push_f64, simulate_render_frames,
};

const REPLAY_PROBE_EXACT_DIGEST: u64 = 0x0248_d935_4f12_6505;
const REPLAY_PROBE_QUANTIZED_DIGEST: u64 = 0x0603_ecb8_7904_c881;

fn digest(values: &[f64], quantize: bool) -> u64 {
    values
        .iter()
        .fold(REPLAY_DIGEST_OFFSET_BASIS, |state, value| {
            let value = if quantize {
                quantize_replay_value(*value, REPLAY_QUANTUM)
            } else {
                *value
            };
            replay_digest_push_f64(state, value)
        })
}

fn main() -> ExitCode {
    let cases = [
        (60_u32, 60.0_f64),
        (30, 60.0),
        (24, 60.0),
        (20, 60.0),
        (15, 45.0),
    ];

    println!("render_fps,frames,physics_steps,simulated_seconds,remainder_seconds");
    let mut passed = true;
    for (render_fps, expected_seconds) in cases {
        let frames = render_fps * 60;
        let result = simulate_render_frames(1.0 / f64::from(render_fps), frames);
        let step_count = u32::try_from(result.steps).expect("one-minute step count fits u32");
        let simulated_seconds = f64::from(step_count) * FIXED_DT_SECONDS;
        println!(
            "{render_fps},{frames},{},{simulated_seconds:.9},{:.12}",
            result.steps, result.remainder_seconds
        );
        if (simulated_seconds - expected_seconds).abs() >= 0.001 {
            eprintln!(
                "FAIL {render_fps} FPS: expected {expected_seconds:.3}s, got {simulated_seconds:.9}s"
            );
            passed = false;
        }
    }

    if passed {
        println!("PASS native fixed-step scheduling oracle");
    }

    let replay_probe = [
        0.0,
        -0.0,
        1.5,
        -1.5,
        REPLAY_QUANTUM / 2.0,
        -REPLAY_QUANTUM / 2.0,
        f64::MAX,
        f64::from_bits(0x0000_0000_0000_0001),
        f64::from_bits(0x8000_0000_0000_0001),
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::from_bits(0x7ff0_0000_0000_0001),
        f64::from_bits(0xfff8_1234_5678_9abc),
    ];
    let exact_digest = digest(&replay_probe, false);
    let quantized_digest = digest(&replay_probe, true);
    println!(
        "replay_format={REPLAY_FORMAT_VERSION},exact_digest={exact_digest:016x},quantized_digest={quantized_digest:016x}"
    );
    if exact_digest != REPLAY_PROBE_EXACT_DIGEST
        || quantized_digest != REPLAY_PROBE_QUANTIZED_DIGEST
    {
        eprintln!(
            "FAIL native replay digest oracle: expected {REPLAY_PROBE_EXACT_DIGEST:016x}/{REPLAY_PROBE_QUANTIZED_DIGEST:016x}"
        );
        passed = false;
    } else {
        println!("PASS native canonical replay digest oracle");
    }

    if passed {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
