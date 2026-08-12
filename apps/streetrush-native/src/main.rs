use std::process::ExitCode;

use streetrush_core::{FIXED_DT_SECONDS, simulate_render_frames};

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
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
