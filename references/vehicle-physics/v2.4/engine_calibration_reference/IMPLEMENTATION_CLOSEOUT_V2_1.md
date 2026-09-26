# Implementation close-out v2.1 (historical record)

> v2.4 notice: this is retained only for baseline provenance. It is not the
> active whole-vehicle host or current validation record.

> Historical scope correction (v2.2): this document records the v2.1 Engine/powertrain close-out. Its former “real upstream subsystem bridge” wording was broader than the implementation: `integrated_closeout.py` did not call Steering or the K&C/spring/damper/ARB/compliance backend and used Tire v1.7. The authoritative final integration statement is `IMPLEMENTATION_CLOSEOUT_V2_2.md`; v2.1 remains valid only for its Engine/powertrain and reduced longitudinal scope.

This correction pass keeps the useful v2.0 Engine/Calibration work and closes the implementation gaps found during independent rerun.

## Closed in code

1. **Unilateral crank-stop roundoff robustness** — exact-bound active sets tolerate only declared roundoff-scale excursions and project them to the exact domain boundary. The reverse/back-drive regression that previously errored now passes.
2. **Two-owner transaction preflight** — Engine and Gearbox both validate their commit before either canonical owner is mutated.
3. **Runtime solver split** — exhaustive active-set enumeration is retained as an offline oracle; the runtime path uses an O(1) common mode and a bounded O(N) local transition neighborhood with no hidden exponential fallback.
4. **Historical reduced upstream bridge** — accepted Tire/Chassis/Aero reference files are packaged, while the v2.1 executable path is limited to Engine/clutch/wheels/chassis, Tire v1.7 and reduced normal-load semantics. It does not execute Steering or the packaged K&C/spring/damper/ARB/compliance backend; v2.2 closes those calls.
5. **No Tire/Aero double counting** — the production powertrain seam explicitly disables the old low-order internal tire friction, aero and rolling-load paths when the accepted high-fidelity subsystem owners are connected.
6. **Validation claim correction** — the old `whole_vehicle_fixture.py` is retained only as a legacy synthetic longitudinal oracle. The v2.1 integrated fixture is explicitly reduced-planar; it does not impersonate the absent game/Rapier 6DOF host.
7. **Reproducible runtime metadata** — `pyproject.toml`, `requirements-reference.txt`, `REFERENCE_RUNTIME.md`, a rerunnable audit entry point and fresh v2.1 results are included.

## Acceptance evidence

Run:

```bash
python -m engine_calibration_reference.run_v2_1_closeout_audit
```

Authoritative generated evidence:

- `results/vehicle_physics_v2_1_closeout_results.json`
- `results/unittest_v2_1.txt`

The historical v2.0 ledgers/results are retained unchanged as historical evidence, including real FAIL/SKIP states. They are not silently rewritten to make v2.1 look cleaner.

## Remaining declared external boundaries

- Target-vehicle fidelity still requires measured Engine, tire, K&C/aero and standardized whole-vehicle datasets. Synthetic structural fixtures cannot certify a real car.
- The user-supplied artifact does not include the actual game/Rapier 6DOF host project. Therefore entity/component application of the canonical chassis wrench and contact reactions remains a host integration boundary. The standalone reference now exposes and executes the correct seam instead of pretending that host exists.
