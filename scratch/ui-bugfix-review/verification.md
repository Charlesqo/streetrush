# Bugfix verification — 2026-09-09

Current behavior follows the user's correction: permit intentional forced downshifts and make the timing board transparent.

- Six-car Rapier v24-active regression: PASS, 14,508 assertions. Natural acceleration for 20 seconds, repeated manual downshifts under throttle and coast for 10 seconds, then upshifts and return to automatic. Every car actually reached first gear at high speed and continued committing simulation steps above the old hard overspeed threshold. This is a synthetic flat-ground rig using the production vehicle runtime, not a recorded browser driving session or target-car calibration.
- LP700 reached first at 282.11 km/h and peaked at 26,359 RPM; MX-5 reached first at 141.03 km/h and peaked at 13,291 RPM. No shift rejection, RPM cap, or forced clutch opening was used to prevent overspeed.
- Full v24 regression: PASS, 9 suites / 14,843 checks. Contract, selected reference checks, host, runtime, playability, forced downshift, legacy isolation, determinism, performance. Reference parity remains partial. Performance p99 1.272 ms against the 8.333 ms step budget, zero overruns in that probe.
- Vite production build: PASS; existing large chunk warning remains. Existing WASM asset used; no WASM source change.
- Mechanical overspeed is an explicit StreetRush extension beyond the calibrated engine domain. Above that domain the existing combustion map yields zero torque, finite overrun drag and clutch reaction continue, and telemetry reports MECHANICAL_OVERRUN_EXTENSION. The component's strict default and non-finite state validation remain intact. No engine-damage model was added.
- Timing board computed background: rgba(0, 0, 0, 0), image none; ::before content none. No gradient or blurred scrim. Sky, road and fixed straight screenshots use the actual game scene and HUD through the existing DEV paused render-review mode. All after images now show transparency.

Retained checks from the previous patch (unaffected focus/recovery code):

- Input suite PASS. Chrome sound and diagnostic pointer clicks returned focus to the canvas; C then changed AT to MT. Enter activation retained button focus for keyboard navigation.
- Fullscreen request was rejected by automated Chrome (TypeError: not granted). Actual Fullscreen API success / Escape ordering remain NOT_RUN. Failure dialog close returned focus to gameplay. A 1920×1080 viewport is not a fullscreen API test.
- Synthetic local browser fault injection displayed a recoverable pause menu, disabled resume and focused restart. Restart cleared the fault. This fallback is for unexpected aborts; ordinary intentional downshift overspeed now continues running.

Review: http://127.0.0.1:5175/scratch/ui-bugfix-review/compare.html?scene=sky (local Vite server required).
