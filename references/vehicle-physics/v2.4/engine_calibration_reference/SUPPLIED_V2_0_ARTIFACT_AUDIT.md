# Supplied v2.0 artifact audit

> Historical provenance only. The pass/fail counts below describe the supplied
> v2.0 artifact and its earlier enhanced audit; they are not v2.4 acceptance
> counts. Current evidence is recorded in the root `docs/VALIDATION.md`.

## Corrected conclusion

The result artifacts cited by `vehicle_physics_design_baseline_cn_v2.0.docx`
are in `vehicle_physics_v2_0_reference_artifacts.zip`. The earlier conclusion
that they were absent was caused by checking the DOCX package and already
expanded workspace files before checking this separate ZIP; that conclusion is
withdrawn.

- Supplied ZIP SHA-256:
  `55b165ab6eebc4862b0dfd88c184fe6ccacfabac08ab1b304ea72c82924e4ae2`
- Supplied DOCX SHA-256:
  `7ac603c65880b2c6180369c619ef57379a34d00cfed14c61d566cb851e108284`
- Original result JSON SHA-256:
  `962c85d98102f2cfafe7b300fc57a278bd19a7c8feba2639a872c03c7a261b11`

The original suite was rerun unmodified in a project-local Python 3.9
environment with NumPy 2.0.2, SciPy 1.13.1, and pytest 8.4.2. Its status was
reproduced exactly: **13 passed, 4 skipped, 2 xfailed**, return code 0.

The WOT-only fit remains structurally ill-conditioned, but its particular
parameter vector is dependency-sensitive. For example, fit A mass changed
from 998.8478 kg in the captured JSON to 1019.9429 kg on rerun, while the
normalized residual verdict remained the same. This is evidence for the
document's non-identifiability conclusion, not a reproducible calibrated mass.

## Contract gap matrix

| v2.0 contract | Supplied ZIP | Enhanced close-out |
|---|---|---|
| Signed zero/full net-crank curves, strict high-speed domain, PCHIP | Implemented | Retained; independent PCHIP and analytic tangent tests |
| Scalar implicit Engine reference step | Implemented | Retained with safeguarded Newton/bisection and residual/refinement gates |
| Explicit net/gross+loss/full-load-only semantics; reject double loss | Described only as one net-map docstring | Enforced by asset schema and tests |
| Controller prepare once, repeated `T_free(omega_trial)+tangent`, commit once | Not exposed as reusable solver contract | `EngineControlTrial`, repeated pure evaluation, owner ticket, single commit enforcement |
| OFF/CRANKING/RUNNING/STALLED, additive starter, bounded idle/limiter authority | Partial RUNNING/STALLED policy | Full reduced state machine; still synthetic and target low-speed fixture remains SKIP |
| Actual Engine-clutch-wheel reaction coupling fixture | Explicitly absent; scalar load torque only | Finite-capacity LOCKED/SLIPPING/NEUTRAL clutch with two wheel inertia rows |
| Dataset manifest and calibration/validation/holdout separation | Arrays only; no manifest or split enforcement | Full manifests, hashes, channel semantics/units/domain/uncertainty, lineage and hash split isolation |
| Parameter passport and phenomenon ownership/double-count boundary | Not implemented | Full provisional passports, unique owner registry, Aero/road-load authority rejection |
| Layered ledger and release gate with accounted SKIP | Raw pytest stdout plus numerical JSON | L0-L5 gates, run/config/code/data hashes, acquisition/impact fields, separate reference/target decision |
| Whole-vehicle synthetic cross-system validation | Not present | Engine + clutch + wheels + tire capacity + Aero wrench + suspension load path + chassis oracle |
| Honest validation outcome | Holdout mismatch is detected by a passing pytest assertion | Ledger retains the held-out metric itself as a real FAIL; 2 XFAIL and 6 SKIP remain explicit |

## Independent research checks used for the close-out

- NVIDIA PhysX publishes engine torque-curve, inertia, idle/max speed, and
  throttle-dependent damping parameters, supporting an independent engine
  rotational state and explicit torque semantics: [PhysX engine parameters](https://nvidia-omniverse.github.io/PhysX/physx/5.1.0/_build/physx/latest/struct_px_vehicle_engine_params.html).
- Project Chrono's simple map explicitly distinguishes zero-throttle and
  full-throttle engine maps: [Project Chrono EngineSimpleMap](https://api.projectchrono.org/classchrono_1_1vehicle_1_1_engine_simple_map.html).
- MathWorks' Generic Engine exposes crank inertia, optional throttle lag,
  tabulated torque, idle control, redline control, and a conserving crankshaft
  port; these are separate concerns rather than permission to clamp RPM:
  [MathWorks Generic Engine](https://www.mathworks.com/help/sdl/ref/genericengine.html).
- PCHIP is shape-preserving and C1, with continuous first derivatives and
  potentially discontinuous second derivatives: [SciPy PCHIP](https://docs.scipy.org/doc/scipy/reference/generated/scipy.interpolate.PchipInterpolator.html).
- NASA-STD-7009B distinguishes verification from validation and requires the
  validation domain to be recorded: [NASA-STD-7009B](https://standards.nasa.gov/standard/nasa/nasa-std-7009).
- ISO 22140 compares vehicle-model simulation against measured ISO 7401 test
  data. Without such target data, a synthetic suite can verify structure but
  cannot validate a real vehicle: [ISO 22140](https://www.iso.org/standard/72680.html),
  [ISO 7401](https://www.iso.org/standard/54144.html).
- SAE J2263 defines conditioned coastdown/onboard-anemometry road-load
  measurement, reinforcing why a synthetic A/B/C fit is not target road-load
  evidence: [SAE J2263](https://saemobilus.sae.org/standards/j2263_202005-road-load-measurement-using-onboard-anemometry-coastdown-techniques).

## Decision on the v2.0 prose

The architecture in Chapters 24-26 remains directionally sound, so no new
baseline version is needed. The executable-result paragraphs should be
corrected or annotated because `13 PASS / 2 XFAIL / 4 SKIP, unexpected FAIL=0`
describes only the original narrow suite. The enhanced close-out has two
separate ledgers:

- unittest: 31 tests, 0 unexpected failures, 1 expected failure, 1 skip;
- validation gates: 18 PASS, 1 real FAIL, 2 XFAIL, 6 SKIP.

The real FAIL is the deliberately held-out model-form mismatch and is evidence
that the validation harness detects failure. It does not invalidate mandatory
L0-L3 structural closure, but it must not be rewritten as a PASS. The release
decision is therefore `REFERENCE_READY_TARGET_NOT_VALIDATED`.
