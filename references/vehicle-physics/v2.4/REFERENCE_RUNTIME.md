# Historical v2.2 reference runtime

> Provenance only. This file records the v2.1/v2.2 rerun environment; it is
> not the current v2.4 acceptance record. Use `README.md`,
> `docs/VALIDATION.md`, and `pyproject.toml` for the v2.4 entry points,
> evidence, and supported dependency ranges.

The v2.1 baseline and v2.2 final evidence were regenerated on 2026-08-27 with:

- Python 3.12.13
- NumPy 2.3.5
- SciPy 1.17.0

`requirements-reference.txt` pins the numerical libraries used for the recorded evidence. `pyproject.toml` intentionally allows a narrow compatible range so the package can also be exercised in a CI matrix rather than pretending one machine is the specification.

The v2.1 Engine active-set work remains frozen. The v2.2 evidence additionally runs the transactional unified fixture, dynamic maneuvers, 60/120/240/480 Hz refinement, solver-iteration refinement, and external Steering/Chassis/Tire subsystem regressions.

Recommended CI matrix: Python 3.11, 3.12, 3.13 with supported NumPy/SciPy combinations. Target-vehicle calibration evidence and a Rapier 6DOF host are not created by this environment file; both remain explicit SKIP boundaries.
