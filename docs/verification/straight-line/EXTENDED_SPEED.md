# Extended-speed, six-car follow-up

Status: **IN_PROGRESS**. The previous LP700 140 km/h PASS does not certify the
other cars or higher speeds. Preserve all earlier records.

Initial working-tree evidence: `extended-working-tree-before.txt`.
The task workspace still contains `src/vehicle-v24`.

Planned initial edit boundary (diagnostic coverage, not a new physics fix):

- `src/straight-line-diagnostic.js`: longer straight and continuous W acceleration
  for 35 s by default, then 1 s coast and normal S braking; all fixed steps retained.
- `src/main.js`: select the extended diagnostic through a development-only query.
- `src/track.js`: configurable ground extent; the normal production track keeps
  its existing 850 m half-extent, while the extended diagnostic has actual ground.
- `scripts/straight-line-recorder-plugin.mjs`: allow the longer complete record
  under a bounded local-only upload limit, still exclusive-create/no overwrite.
- `scripts/analyze-straight-line-recording.mjs`: recognize the recorded protocol
  and duration instead of treating 140 km/h as sufficient for every run.
- Verification documents and new raw JSON/CSV/summary files in this directory.

Production chain and ownership remain unchanged: keyboard event → InputController
→ main fixed-step scheduler → VehicleSystem → v24-active → Rapier → afterPhysics.
No forced velocity, wheel omega, RPM, hidden recovery or simplified test vehicle.
AMG GT3 / M5 model and wheel visuals remain out of scope.

Six cars to verify individually: `mx5`, `m3e30`, `gt3rs`, `lp700`, `amggt3`, `m5g90`.
Garage `config.speed` is only a UI statistic, not a physical limiter or authoritative
target-speed measurement. Actual achieved speed and time at throttle must be recorded.

## First 35-second production sweep (before this turn's physics experiments)

All six runs held real W keyboard events for the full recorded acceleration
period, then released W for 1 s and held S. All used the production TrackSystem
and retained every fixed step. None passed the straight-braking checks.

| Car | Maximum km/h | End reason | Maximum heading change | Raw record ID |
| --- | ---: | --- | ---: | --- |
| M5 G90 | 323.526406 | lateral safety limit | 27.133590 deg | ee3fa880-33b8-4cc4-bf51-c05644852756 |
| LP700 | 331.463505 | lateral safety limit | 168.701606 deg | 11413998-c6eb-4903-973b-7e3add4bf398 |
| MX-5 | 176.338890 | braking did not stop | 179.995359 deg | 9ced520a-c110-4b37-bf97-be132fa442ca |
| M3 E30 | 217.051432 | stopped, but spun | 140.105086 deg | 9c204d8c-2141-424f-a26f-2b157cf15667 |
| GT3 RS | 285.465973 | lateral safety limit | 125.810215 deg | 97a2fad9-75f0-471b-a184-da0a7eb06dd6 |
| AMG GT3 | 268.313978 | lateral safety limit | 128.853017 deg | 1e4d77ce-2204-47e3-90bf-7382067966a3 |

Each ID has its complete `.json`, flattened `.csv`, and `.summary.json` in this
directory. The summaries distinguish full-throttle duration, speed coverage,
and dynamics checks; analyzer exit 1 means an observed failure, not a tool error.

M5's yaw growth started with four flat-ground contacts, zero steering, zero ESC,
paired equal service-brake torque, and ABS modulation still `[1,1,1,1]`.
Later unequal ABS pressure is not the first cause of this failure.

## Rejected wheel/body-wrench experiment

Additional edit scope was recorded in `extended-brake-wrench-scope-20260831.txt`.
The experiment added tire wheel-contact torque to the separate body spin-reaction
term, without changing the tire/brake models or writing any velocity state.
It differed from the active synthetic fixture's explicit brake-reaction path;
that difference was recorded before testing, not treated as fixture parity.

Two syntax checks passed, and the small experimental accounting test printed:

```json
{"status":"PASS","checks":14,"scope":"wheel-body-wrench-accounting-only"}
```

Production M5 record `ba51fccc-cc96-4d33-9770-ee5a12961b06` nevertheless failed:
324.824713 km/h maximum, 5616 complete samples, 32.546314 deg final heading change,
37.097301 m lateral displacement, and the same safety-limit termination.
The runtime experiment was therefore reverted with a narrow patch. Its test
source is retained as `wrench-experiment-checks.mjs.txt`, not an active regression
or evidence of current production PASS. Raw experimental telemetry is retained.

The existing suspension/steering lightweight script also passed 34 assertions;
this does not certify a real high-speed stop. No old long/hanging suite was rerun.
