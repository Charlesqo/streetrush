# Autonomous run salvage

This directory contains the small reusable remainder from:

- `E:/Codex/autonomous_runs/multi_car_audio`
- `E:/Codex/autonomous_runs/multi_car_physics_data`

It is an archive/reference input, not production wiring. Nothing in this directory is imported by the game.

## Validation in this repository

Run `pnpm test:research-salvage`. The test maps the selection to all six game vehicles, validates the six bank/analysis/loop documents, reads all 36 WAV headers and samples, checks the prepared SHA-256 hashes and loop gates, and verifies the 21-field physics projection plus the MX-5 coil-rate boundary. The physics projection retains its original UTF-8 BOM; the reader handles it explicitly instead of rewriting the archived file.

The copied 2026-08-14 archive contained two analysis-only metadata errors: the MX-5 I4 and M5 V8 `analysis.json` files both said `cylinders: 6`, and their derived `expectedFiringFrequencyHz` values used that count. The working copy corrects them to 4 and 8 cylinders and recomputes only those firing-frequency fields. Bank manifests, WAV bytes, loop analyses, source records and claims are unchanged.

## Audio

`audio/candidates/` keeps one primary prototype bank per current vehicle:

| Vehicle | Candidate directory | Bank type |
| --- | --- | --- |
| Mazda MX-5 NA | `i4-mazda-b6-compatibility-proxy` | non-exact I4 proxy |
| BMW M3 E30 | `i4-bmw-s14b23` | S14-family candidate |
| Porsche GT3 RS | `flat6-porsche-gt3-992-dacxl` | 992-family candidate |
| Lamborghini LP700 | `v12-lamborghini-l539-dacxl` | L539-family candidate |
| Mercedes-AMG GT3 | `v8-mercedes-m159-compression-compatible-proxy` | non-exact M159 proxy |
| BMW M5 G90 | `v8-bmw-s68-compression-compatible-proxy` | non-exact S68 proxy |

Each bank has six 44.1 kHz mono PCM loops: three RPM anchors with off-load and on-load variants. The copied WAV files were independently checked for endpoint discontinuity and full-scale clipping; none was found. They remain prototype/generated audio, not exact recordings of the target vehicles.

`audio/runtime/` keeps the only substantial code not already represented by the current project's bank loader/coordinator: layered buffer playback, RPM playback-rate control, load blending, and its old Street Rush adapter. Port useful pieces into the current audio system; do not apply the old integration patch wholesale.

`audio/reference/` contains the original uncurated profile/manifest documents and schemas. The original manifest references more candidates than were copied here. Use `audio/selection.json` as the actual salvage list.

## Physics

`physics/selected-target-projection.json` contains the 21 fields that survived the source package's own projection step:

- AMG GT3: 0
- GT3 RS: 6
- LP700: 3
- M3 E30: 2
- M5 G90: 5
- MX-5 NA: 5

Most values overlap the existing game configuration or add front/rear splits and more precise rounding. The potentially useful deltas are split track widths, GT3/M5 CdA candidates, GT3/MX-5 tire and pressure details, and condition-specific M3/M5 mass alternatives.

`physics/mx5-na-spring-rate-derivation.json` estimates front and rear coil rates from workshop-manual spring geometry. These are coil-rate estimates, not wheel rates; motion ratio, seat angle, preload, bump stops, and full force curves are still absent.

The projection retains its original absolute source references. The 65 directly referenced local artifacts total about 163 MB and include whole manuals, browser screenshots, negative searches, and boundary records, so they were deliberately not duplicated here.

## Deliberately excluded

- vendored Engine Simulator trees and duplicate repositories
- old Street Rush build copies, `node_modules`, `dist`, and patch-check worktrees
- browser captures, test results, self-audits, gate logs, and generated reports
- unused alternate audio candidates
- M5 graph digitization with unresolved units/output plane
- the 1999 MX-5 dyno trace, which does not match the selected 1990 NA6 target
