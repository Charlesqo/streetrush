# Production straight-line braking investigation

Status: **PASS_STRAIGHT_BRAKING_AUTOMATED** on the final-code LP700 run;
**自动验证通过，等待手感验收**. This is not completion of the game or full v2.4 parity.

The user's current car is the LP700. The diagnostic uses the production `TrackSystem`
with a flat, collinear first straight and the unchanged production vehicle runtime.
It issues DOM `keydown`/`keyup` events through the normal input controller, accelerates
under W to at least 140 km/h, coasts for 1 second, and applies S to brake. It does not
set chassis velocity, wheel omega, or RPM, and does not invoke a recovery during the
maneuver. The normal menu start/reset occurs once, before recording.

Chain: keyboard event → InputController.update → main fixed-step scheduler →
VehicleSystem.fixedUpdate → v24-active → Rapier world.step → afterPhysics.
The automated keyboard events have `isTrusted=false`; this is not hardware certification.

## Full, untruncated recordings

Every physical step is retained, including position, quaternion, velocity, angular
velocity, heading, lateral/forward displacement, complete input, vehicle output,
wheel load/omega/contact, toe/camber/jounce, brake/tire diagnostics, assists and
wheel wrenches. No decimation or final-heading-only replacement is used.

| Recording | Samples | Bytes | Maximum speed | Actual end condition |
| --- | ---: | ---: | ---: | --- |
| `19965fc5-0ce8-491e-b6aa-9540397d42f3.json` | 2927 | 26221481 | 141.9556 km/h | Recorder encountered a null report after the game's existing automatic recovery; all preceding samples were saved. |
| `c9e4882c-5e73-49ce-bed0-86fc6dc6993a.json` | 2926 | 26208173 | 141.9362 km/h | `AUTOMATIC_RESET: vehicle-stuck`, explicitly recorded after making the recorder null-safe. |
| `a9a0d75d-7a8d-43f2-921a-e5cdfb029f5c.json` | 2250 | 20406982 | 141.9558 km/h | `STOPPED`; first mirrored-corner experiment, 10/10 straight-line checks PASS. |
| `79968482-9559-4204-98a9-2fb53170895b.json` | 2252 | 20430140 | 141.9079 km/h | `STOPPED`; final active-reference side formula, 10/10 straight-line checks PASS. |

The final zero speed/heading in the second recording is a recovery, **not a successful
stop**. The run had already spun approximately 140 degrees. Root-cause analysis uses
the time history and first onset, not that final sample. No failed run is discarded.

The second, third and fourth recordings also have same-name `.csv` and `.summary.json`
files. The final CSV has **2252 time-ordered rows and 370 columns**: every fixed step
and every leaf field, not a decimated plot or just the final heading. JSON is the
authoritative full record; its SHA-256 for the final run is
`afec32c4b69eeb6806b0449ce63857eb3d80317b29e1dce92db014a5417ea638`.

## Proven fault and minimal physical correction

The canonical single-corner K&C map was applied to both sides without a side sign.
At equal jounce and zero steering, both wheels on an axle received same-sign toe and
camber. Pitch/load transfer during acceleration and braking therefore generated
uncommanded common-direction tire geometry, instead of paired left/right geometry.

The authoritative active implementation linked by the v2.4 README is
`references/vehicle-physics/v2.4/engine_calibration_reference/unified_vehicle_fixture.py`
(lines 1176–1196): `camber = side * rx`, `kc_toe = side * (rz(q, steer) - rz(0, steer))`.
The final StreetRush correction applies exactly that side/zero-jounce convention to
the current map outputs. It does not replace or change the canonical polynomial,
steering handedness, brake balance, ABS, anti-roll, tire model, velocity, wheel omega,
RPM, or recovery logic. No new backend or full-v2.4 equivalence is asserted.

The first successful experiment used the reflection helper found in
`final_cross_system_closeout.py`. That file's direct active-entry linkage was not
established, so the final code uses the explicitly active unified-fixture convention
above. Both are equivalent for this zero-steering experiment; the final code was
independently rerun and is the fourth recording, not an inferred PASS from the third.

Before the correction, the car was already about 5 m off the initial straight when
braking began. In the first recording, 0.66 s into braking, yaw exceeded 0.1 rad/s;
rear brake torques were approximately 612 and 916 Nm as the rear wheel loads became
unequal. At 1.58 s, yaw exceeded 0.5 rad/s and one rear wheel's load reached zero.
All steering and handbrake inputs were zero and all observed ESC requests were zero.
ABS/brake imbalance accompanied and amplified the developing yaw; it was not caused
by an A/D sign reversal or an ESC intervention. The later reverse/stuck recovery was
a consequence after the spin, not a successful stop.

For the pre-fix record the `noUncommandedEsc` certification check is false because the
automatic-reset terminal sample has no assist report. That missing evidence is not
evidence of an ESC activation; all available pre-reset ESC requests are zero.

## Final run: the change over time

Brake starts at t = 11.166667 s. The table is a readable excerpt only; the CSV/JSON
retain every 1/120-second step, including the intervals between these rows.

| Seconds after braking | Speed km/h | Heading change ° | Yaw rad/s | Lateral displacement m |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 139.4116 | -0.08839 | 0.000003 | 0.1642 |
| 1.0083 | 111.6643 | -0.08073 | 0.000274 | 0.2182 |
| 2.0083 | 81.3071 | -0.06059 | 0.000463 | 0.2533 |
| 3.0083 | 52.7071 | -0.03949 | 0.000189 | 0.2701 |
| 4.0083 | 28.2135 | -0.03575 | 0.000017 | 0.2773 |
| 5.0083 | 12.2023 | -0.03527 | 0.000003 | 0.2807 |
| 6.0083 | 2.4701 | -0.11895 | -0.002788 | 0.2725 |

The brake phase reached 0.392 km/h after 6.83 s; the final settled sample is
0.117 km/h. Across the **whole run**, maximum absolute heading change is 0.3075°,
maximum lateral displacement is 0.2817 m, and maximum yaw rate is 0.0343 rad/s.
During braking alone, maximum yaw rate is 0.00836 rad/s. There is no automatic reset.
These are small nonzero settling deviations, not a claim of mathematically perfect
straightness or of user-confirmed handling.

## Edit boundary for this follow-up

Only `suspension.js` changes vehicle dynamics in this follow-up:

- `src/vehicle-v24/suspension.js`: apply canonical toe/camber by side using the
  active reference's zero-jounce baseline; the root cause above.
- `src/straight-line-diagnostic.js`: straight TrackSystem configuration, UI-driven
  W/coast/S sequence and per-step recorder; observes and flags automatic recovery.
- `scripts/straight-line-recorder-plugin.mjs`: development-only same-origin,
  loopback-only recording endpoint; exclusive-create JSON files, no overwrite.
- `vite.config.js`: register that development recording endpoint.
- `src/main.js`: development-query opt-in and hooks before input/after physics;
  forward existing automatic-recovery events to the recorder.
- `src/vehicle-v24/runtime.js`: additional per-corner geometry/assist diagnostics.
- `scripts/analyze-straight-line-recording.mjs`: inspect saved records, export every
  sample/leaf to CSV and produce explicit maneuver checks and per-phase summaries.
- `scripts/test-vehicle-v24-suspension-symmetry.mjs`: 18 small symmetry assertions at
  three suspension positions plus 16 pure-JS steering seam/authority assertions at
  low/medium/high speed, alongside (not instead of) the real production test.
- `docs/verification/straight-line/`: original complete recordings and this ledger.
- `docs/V24_PLAYABILITY_STABILIZATION.md`: link this latest user-feedback investigation
  from the existing historical report; preserve the earlier records.

Existing dirty files are preserved. The earlier complete working-tree snapshot is
`../v24-playability-working-tree.txt`; it explicitly is a continuation snapshot, not
a fabricated clean pre-task baseline. A new read-only `git status --short` check after
diagnostic setup confirmed the five code paths above are still modified/untracked
alongside existing unrelated user changes. The entire working-tree diff is not
attributable to this follow-up.

## Checks executed during setup

- `node --check` on `src/straight-line-diagnostic.js`,
  `scripts/straight-line-recorder-plugin.mjs`, `src/main.js`,
  `src/vehicle-v24/runtime.js`, and `vite.config.js`: **5/5 syntax PASS**.
- After the null-report correction, `node --check src/straight-line-diagnostic.js`
  and `node --check src/main.js`: **2/2 syntax PASS**.
- A Node/Three CatmullRomCurve3 geometry check sampled the first 1120 m at 1 m
  intervals: **1121 samples**, maximum absolute x = 0, y = 0, tangent = +Z at
  both endpoints, within the existing ground bounds. This verifies the diagnostic
  lane geometry, not vehicle dynamics.
- `lsof -nP -iTCP:4173 -sTCP:LISTEN`: the direct Vite server is listening locally.
- Browser: four normal UI button starts of the same production-chain protocol;
  all reached the speed target. Two pre-fix failures are retained; the mirror
  experiment and the final active-reference run each pass 10/10 maneuver checks.
  The main agent operated the page and inspected telemetry/rendered vehicles;
  sub-agents handled read-only analysis and simple command execution.
- `node scripts/test-vehicle-v24-suspension-symmetry.mjs`: exit 0,
  **34/34 assertions PASS**: 18 across three jounce values, plus 16 steering
  sign/progressive-authority assertions at 2, 16, and 40 m/s for both directions.
  The positive host steering angles are respectively 0.452419, 0.240937, and
  0.105637 rad; opposite commands produce the equal negative angles.
- `node scripts/analyze-straight-line-recording.mjs docs/verification/straight-line/c9e4882c-5e73-49ce-bed0-86fc6dc6993a.json`:
  exit 1, **expected pre-fix FAIL**, full CSV and summary saved.
- `node scripts/analyze-straight-line-recording.mjs docs/verification/straight-line/a9a0d75d-7a8d-43f2-921a-e5cdfb029f5c.json`:
  exit 0, **10/10 maneuver checks PASS**.
- `node scripts/analyze-straight-line-recording.mjs docs/verification/straight-line/79968482-9559-4204-98a9-2fb53170895b.json`:
  exit 0, **10/10 final-code maneuver checks PASS**.
- `node scripts/test-vehicle-v24-playability.mjs` was initially reported as exit 0
  with empty stdout. The source is a top-level executable that should print its
  PASS/check-count JSON, so empty stdout alone is **NOT_VERIFIED**, not a regression
  PASS. A single bounded `spawnSync` capture then ended after **45 s** with
  `status=null`, `signal=SIGTERM`, `error.code=ETIMEDOUT`, and zero stdout/stderr
  bytes. The old 100-check suite is **TIMEOUT / NOT_VERIFIED** for this code revision.
  It was not retried again; the independent 34-check script is the lightweight local
  alternative, with its narrower scope made explicit. Raw command evidence is in
  `regression-results.json`.
- Final syntax checks cover all eight changed/new JavaScript code paths. The final
  unit script and the saved-record analyzer each pass `node --check`.
- The ordinary `git diff --check -- <eight code paths>` returned exit 2 because
  CRLF lines in the tracked `src/main.js` / `vite.config.js` were reported as trailing
  whitespace. No broad line-ending rewrite was performed. The same read-only check
  with `git -c core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol diff --check -- <eight code paths>`
  returned exit 0. This checks the tracked diff, not untracked-file semantics.

The ten maneuver gates are: 140 km/h attained under acceleration; every fixed step
retained; zero steering/handbrake; all reports committed; no recovery; normal stop;
whole-run heading within 3°; lateral displacement within 0.5 m; yaw rate within
0.1 rad/s; and complete evidence of zero ESC request. These are diagnostic gates for
this maneuver, not substituted v2.0/v2.4 normative or target-data acceptance gates.

The direct Vite command is `node_modules/.bin/vite --host 127.0.0.1 --port 4173 --strictPort`.
No dependencies were installed. Formal `pnpm dev`/full build are **NOT_RUN** in this
follow-up; prior synthetic/low-speed passes do not certify this high-speed maneuver.
The normal production-track page at `http://127.0.0.1:4173/?devtools` has been started
with the LP700 for the user. The opt-in diagnostic page is
`http://127.0.0.1:4173/?devtools&straightline&car=lp700`.
