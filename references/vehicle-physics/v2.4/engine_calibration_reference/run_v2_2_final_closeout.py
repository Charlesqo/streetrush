"""Re-run and materialize the v2.2 final cross-system close-out evidence."""

from __future__ import annotations

import argparse
from dataclasses import asdict, replace
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import platform
import re
import subprocess
import sys
from typing import Callable

import numpy as np
import scipy

from .engine_model import EngineCommand
from .steering_reference_v2 import DeviceKind, SteeringCommand
from .unified_vehicle_fixture import (
    SuspensionBackend,
    UnifiedDomainError,
    UnifiedVehicleCommand,
    UnifiedVehicleConfig,
    UnifiedVehicleFixture,
)


PACKAGE_ROOT = Path(__file__).resolve().parent
ARTIFACT_ROOT = PACKAGE_ROOT.parent
WORKSPACE_ROOT = ARTIFACT_ROOT.parent
REFERENCE_REGRESSION_ROOT = ARTIFACT_ROOT / "reference_regressions"
RESULTS_ROOT = PACKAGE_ROOT / "results"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _endpoint(system: UnifiedVehicleFixture) -> dict[str, float | list[float] | str]:
    state = system.state
    m = state.mechanics
    return {
        "body_u_m_s": m.body_u_m_s,
        "body_v_m_s": m.body_v_m_s,
        "yaw_rate_rad_s": m.yaw_rate_rad_s,
        "world_x_m": m.world_x_m,
        "world_y_m": m.world_y_m,
        "yaw_rad": m.yaw_rad,
        "engine_rpm": state.engine.rpm,
        "gear": state.gearbox.selected_gear,
        "rack_q": state.steering.rack_q,
        "normal_loads_n": list(m.normal_loads_n),
        "suspension_q_m": list(m.suspension_q_m),
    }


CommandFunction = Callable[[float, int], UnifiedVehicleCommand]


def _run_profile(
    *,
    name: str,
    backend: SuspensionBackend,
    rate_hz: int,
    duration_s: float,
    command_at: CommandFunction,
    speed_m_s: float = 15.0,
) -> dict[str, object]:
    system = UnifiedVehicleFixture.synthetic(speed_m_s=speed_m_s)
    dt = 1.0 / rate_hz
    count = int(round(duration_s * rate_hz))
    peak_yaw_rate = 0.0
    peak_load_spread = 0.0
    peak_ffb = 0.0
    peak_residual = 0.0
    peak_damper_power = 0.0
    peak_arb_energy = 0.0
    max_nfev = 0
    calls_ok = True
    transaction_ok = True
    last = None
    for index in range(count):
        time_s = (index + 1) * dt
        last = system.step(command_at(time_s, index), dt, backend)
        mechanics = last.state.mechanics
        peak_yaw_rate = max(peak_yaw_rate, abs(mechanics.yaw_rate_rad_s))
        peak_load_spread = max(
            peak_load_spread,
            max(mechanics.normal_loads_n) - min(mechanics.normal_loads_n),
        )
        peak_ffb = max(peak_ffb, abs(last.steering_reaction.ffb_torque_nm))
        peak_residual = max(peak_residual, last.residual_scaled_inf)
        peak_damper_power = max(peak_damper_power, last.damper_dissipation_w)
        peak_arb_energy = max(peak_arb_energy, last.arb_energy_j)
        max_nfev = max(max_nfev, last.nonlinear_evaluations)
        calls_ok = calls_ok and last.calls.all_required_paths_executed
        transaction_ok = transaction_ok and last.transaction.committed_exactly_once
    assert last is not None
    checks = {
        "residual_converged": peak_residual < system.config.residual_tolerance,
        "all_required_paths_called": calls_ok,
        "atomic_commit_every_step": transaction_ok,
        "contact_action_reaction": last.action_reaction_inf_n <= 1.0e-12,
        "aero_action_reaction": last.aero_action_reaction_inf_n <= 1.0e-12,
        "damper_passive": last.damper_dissipation_w >= 0.0,
        "mz_single_source_bridge": (
            last.front_intrinsic_mz_chassis_nm
            == last.front_intrinsic_mz_steering_input_nm
        ),
    }
    return {
        "name": name,
        "backend": backend.value,
        "rate_hz": rate_hz,
        "duration_s": duration_s,
        "steps": count,
        "endpoint": _endpoint(system),
        "metrics": {
            "peak_abs_yaw_rate_rad_s": peak_yaw_rate,
            "peak_normal_load_spread_n": peak_load_spread,
            "peak_abs_ffb_torque_nm": peak_ffb,
            "peak_scaled_residual_inf": peak_residual,
            "peak_damper_dissipation_w": peak_damper_power,
            "peak_arb_energy_j": peak_arb_energy,
            "max_reported_nonlinear_evaluations": max_nfev,
            "final_front_intrinsic_mz_nm": last.front_intrinsic_mz_chassis_nm,
            "final_contact_power_w": sum(corner.tire.contact_power_w for corner in last.corners),
        },
        "checks": checks,
        "status": "PASS" if all(checks.values()) else "FAIL",
    }


def run_unified_validation() -> dict[str, object]:
    maneuvers: list[dict[str, object]] = []
    for backend in SuspensionBackend:
        maneuvers.append(
            _run_profile(
                name="step_steer",
                backend=backend,
                rate_hz=120,
                duration_s=0.30,
                command_at=lambda time_s, _index: UnifiedVehicleCommand(
                    engine=EngineCommand(0.28),
                    steering=SteeringCommand(
                        DeviceKind.GAMEPAD,
                        0.0 if time_s < 0.05 else 0.18,
                    ),
                ),
            )
        )
    maneuvers.append(
        _run_profile(
            name="sine_weave",
            backend=SuspensionBackend.MAPPED_KC_MASSLESS,
            rate_hz=120,
            duration_s=0.40,
            command_at=lambda time_s, _index: UnifiedVehicleCommand(
                engine=EngineCommand(0.26),
                steering=SteeringCommand(
                    DeviceKind.GAMEPAD,
                    0.16 * math.sin(2.0 * math.pi * 1.5 * time_s),
                ),
            ),
        )
    )
    maneuvers.append(
        _run_profile(
            name="brake_in_turn_split_mu",
            backend=SuspensionBackend.DYNAMIC_UNSPRUNG,
            rate_hz=120,
            duration_s=0.30,
            command_at=lambda time_s, _index: UnifiedVehicleCommand(
                engine=EngineCommand(0.05),
                steering=SteeringCommand(DeviceKind.GAMEPAD, 0.12),
                wheel_external_torque_nm=(
                    (-280.0, -280.0, -360.0, -360.0)
                    if time_s >= 0.10
                    else (0.0, 0.0, 0.0, 0.0)
                ),
                surface_mu_x=(1.0, 0.55, 1.0, 0.55),
                surface_mu_y=(1.0, 0.55, 1.0, 0.55),
            ),
        )
    )
    maneuvers.append(
        _run_profile(
            name="single_wheel_road_input",
            backend=SuspensionBackend.DYNAMIC_UNSPRUNG,
            rate_hz=120,
            duration_s=0.25,
            command_at=lambda time_s, _index: UnifiedVehicleCommand(
                engine=EngineCommand(0.25),
                road_heights_m=(
                    0.008 * math.sin(math.pi * (time_s - 0.05) / 0.08)
                    if 0.05 < time_s < 0.13
                    else 0.0,
                    0.0,
                    0.0,
                    0.0,
                ),
            ),
        )
    )
    maneuvers.append(
        _run_profile(
            name="low_speed_final_tire_policy",
            backend=SuspensionBackend.DYNAMIC_UNSPRUNG,
            rate_hz=120,
            duration_s=0.10,
            speed_m_s=3.0,
            command_at=lambda _time_s, _index: UnifiedVehicleCommand(
                engine=EngineCommand(0.15),
                wheel_external_torque_nm=(0.0, 0.0, 40.0, 40.0),
            ),
        )
    )

    refinement: dict[str, object] = {}
    endpoints: dict[int, dict[str, object]] = {}
    for rate in (60, 120, 240, 480):
        item = _run_profile(
            name=f"dt_refinement_{rate}hz",
            backend=SuspensionBackend.MAPPED_KC_MASSLESS,
            rate_hz=rate,
            duration_s=0.25,
            command_at=lambda time_s, _index: UnifiedVehicleCommand(
                engine=EngineCommand(0.28),
                steering=SteeringCommand(
                    DeviceKind.GAMEPAD,
                    0.16 if time_s >= 0.05 else 0.0,
                ),
            ),
        )
        endpoints[rate] = item["endpoint"]  # type: ignore[assignment]
    y_differences = [
        abs(float(endpoints[a]["world_y_m"]) - float(endpoints[b]["world_y_m"]))
        for a, b in ((60, 120), (120, 240), (240, 480))
    ]
    yaw_differences = [
        abs(float(endpoints[a]["yaw_rad"]) - float(endpoints[b]["yaw_rad"]))
        for a, b in ((60, 120), (120, 240), (240, 480))
    ]
    refinement["dt"] = {
        "rates_hz": [60, 120, 240, 480],
        "endpoints": {str(rate): endpoints[rate] for rate in endpoints},
        "successive_world_y_differences_m": y_differences,
        "successive_yaw_differences_rad": yaw_differences,
        "monotone_refinement": (
            y_differences[2] < y_differences[1] < y_differences[0]
            and yaw_differences[2] < yaw_differences[1] < yaw_differences[0]
        ),
    }

    iteration_endpoints = {}
    for maximum in (45, 120):
        config = replace(UnifiedVehicleConfig(), max_nonlinear_evaluations=maximum)
        system = UnifiedVehicleFixture.synthetic(config=config)
        max_residual = 0.0
        for _ in range(8):
            result = system.step(
                UnifiedVehicleCommand(
                    engine=EngineCommand(0.28),
                    steering=SteeringCommand(DeviceKind.GAMEPAD, 0.14),
                ),
                1.0 / 120.0,
                SuspensionBackend.MAPPED_KC_MASSLESS,
            )
            max_residual = max(max_residual, result.residual_scaled_inf)
        iteration_endpoints[maximum] = {
            "endpoint": _endpoint(system),
            "peak_scaled_residual_inf": max_residual,
        }
    iteration_y_delta = abs(
        float(iteration_endpoints[45]["endpoint"]["world_y_m"])  # type: ignore[index]
        - float(iteration_endpoints[120]["endpoint"]["world_y_m"])  # type: ignore[index]
    )
    iteration_yaw_delta = abs(
        float(iteration_endpoints[45]["endpoint"]["yaw_rad"])  # type: ignore[index]
        - float(iteration_endpoints[120]["endpoint"]["yaw_rad"])  # type: ignore[index]
    )
    refinement["iteration"] = {
        "maximum_function_evaluations": [45, 120],
        "endpoints": {str(key): value for key, value in iteration_endpoints.items()},
        "world_y_delta_m": iteration_y_delta,
        "yaw_delta_rad": iteration_yaw_delta,
        "invariant_within_1e_12": iteration_y_delta <= 1.0e-12 and iteration_yaw_delta <= 1.0e-12,
    }

    failure_cases = []
    for name, command, dt in (
        (
            "aero_beta_domain",
            UnifiedVehicleCommand(engine=EngineCommand(0.3), wind_body_m_s=(0.0, -8.0, 0.0)),
            1.0 / 120.0,
        ),
        (
            "kc_steer_domain",
            UnifiedVehicleCommand(
                engine=EngineCommand(0.3),
                steering=SteeringCommand(DeviceKind.AI_CURVATURE, 1.0),
            ),
            0.2,
        ),
    ):
        system = UnifiedVehicleFixture.synthetic()
        snapshot = system.state
        exception = None
        try:
            system.step(command, dt, SuspensionBackend.MAPPED_KC_MASSLESS)
        except UnifiedDomainError as exc:
            exception = str(exc)
        state_unchanged = (
            system.state is snapshot
            and system.engine_owner.state is snapshot.engine
            and system.gearbox_owner.state is snapshot.gearbox
            and system.steering_owner.state is snapshot.steering
            and system.tire_owner.state is snapshot.tires
            and system.mechanical_owner.state is snapshot.mechanics
        )
        aborts = set(system.last_transaction_audit.aborted)
        required = {"engine", "gearbox", "steering", "tires", "mechanics"}
        failure_cases.append(
            {
                "name": name,
                "exception": exception,
                "state_identity_unchanged": state_unchanged,
                "all_owners_aborted": aborts == required,
                "owners_committed": list(system.last_transaction_audit.committed),
                "status": "PASS" if exception and state_unchanged and aborts == required else "FAIL",
            }
        )

    checks = {
        "all_maneuvers_pass": all(item["status"] == "PASS" for item in maneuvers),
        "dynamic_lateral_response_present": all(
            abs(float(item["endpoint"]["yaw_rate_rad_s"])) > 1.0e-4  # type: ignore[index]
            for item in maneuvers[:4]
        ),
        "dt_refines_monotonically": bool(refinement["dt"]["monotone_refinement"]),  # type: ignore[index]
        "iteration_refinement_invariant": bool(refinement["iteration"]["invariant_within_1e_12"]),  # type: ignore[index]
        "domain_failures_are_atomic": all(item["status"] == "PASS" for item in failure_cases),
    }
    return {
        "maneuvers": maneuvers,
        "refinement": refinement,
        "failure_cases": failure_cases,
        "checks": checks,
        "status": "PASS" if all(checks.values()) else "FAIL",
    }


def _parse_test_count(output: str) -> int | None:
    match = re.search(r"Ran\s+(\d+)\s+tests?", output)
    return int(match.group(1)) if match else None


def _run_regression(name: str, command: list[str], cwd: Path) -> dict[str, object]:
    log_path = RESULTS_ROOT / f"regression_{name}.txt"
    if not cwd.exists():
        return {
            "name": name,
            "status": "SKIP",
            "reason": "SOURCE_DIRECTORY_NOT_PRESENT",
            "cwd": str(cwd),
            "command": command,
        }
    completed = subprocess.run(
        command,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=360,
        check=False,
    )
    log_path.write_text(completed.stdout, encoding="utf-8")
    return {
        "name": name,
        "status": "PASS" if completed.returncode == 0 else "FAIL",
        "exit_code": completed.returncode,
        "test_count": _parse_test_count(completed.stdout),
        "cwd": str(cwd),
        "command": command,
        "log": str(log_path.relative_to(ARTIFACT_ROOT)),
        "log_sha256": _sha256(log_path),
    }


def run_regressions() -> dict[str, object]:
    python = sys.executable
    entries = [
        _run_regression(
            "integrated_package",
            [python, "-m", "unittest", "discover", "-v", "-s", "engine_calibration_reference/tests", "-p", "test_*.py"],
            ARTIFACT_ROOT,
        ),
        _run_regression(
            "steering_reference",
            [python, "-m", "unittest", "-v", "test_steering"],
            REFERENCE_REGRESSION_ROOT / "steering_reference",
        ),
        _run_regression(
            "chassis_suspension_reference",
            [python, "-m", "unittest", "-v", "test_chassis_suspension.py"],
            REFERENCE_REGRESSION_ROOT / "chassis_suspension_reference",
        ),
        _run_regression(
            "tire_v2_final_reference",
            [python, "-m", "unittest", "-v", "tire_v2_reference.test_tire_v2"],
            REFERENCE_REGRESSION_ROOT,
        ),
    ]
    required = {"integrated_package", "steering_reference", "chassis_suspension_reference", "tire_v2_final_reference"}
    all_required_pass = all(
        entry["status"] == "PASS" for entry in entries if entry["name"] in required
    ) and {entry["name"] for entry in entries if entry["status"] == "PASS"} >= required
    return {
        "entries": entries,
        "existing_subsystem_test_count": sum(
            int(entry["test_count"] or 0)
            for entry in entries
            if entry["name"] != "integrated_package"
        ),
        "integrated_package_test_count": next(
            (entry["test_count"] for entry in entries if entry["name"] == "integrated_package"),
            None,
        ),
        "all_required_pass": all_required_pass,
        "status": "PASS" if all_required_pass else "FAIL",
    }


def _provenance() -> dict[str, object]:
    files = {
        "unified_fixture": PACKAGE_ROOT / "unified_vehicle_fixture.py",
        "steering_transaction": PACKAGE_ROOT / "steering_transaction.py",
        "steering_accepted_copy": PACKAGE_ROOT / "steering_reference_v2.py",
        "chassis_suspension_accepted": PACKAGE_ROOT / "chassis_suspension_reference.py",
        "tire_final_model": PACKAGE_ROOT / "tire_v2_final" / "tire_model.py",
        "tire_final_adapters": PACKAGE_ROOT / "tire_v2_final" / "adapters.py",
        "aero_v1_9": PACKAGE_ROOT / "aero_reference_v1_9.py",
        "engine_model": PACKAGE_ROOT / "engine_model.py",
        "gearbox_controller": PACKAGE_ROOT / "powertrain_controller.py",
        "engine_asset": PACKAGE_ROOT / "data" / "synthetic_engine_asset.json",
    }
    hashes = {name: {"path": str(path.relative_to(ARTIFACT_ROOT)), "sha256": _sha256(path)} for name, path in files.items()}
    source_pairs = []
    for name, upstream, vendored in (
        (
            "steering",
            WORKSPACE_ROOT / "steering_reference" / "steering.py",
            PACKAGE_ROOT / "steering_reference_v2.py",
        ),
        (
            "tire_model",
            WORKSPACE_ROOT / "tire_v2_reference" / "tire_model.py",
            PACKAGE_ROOT / "tire_v2_final" / "tire_model.py",
        ),
        (
            "tire_adapters",
            WORKSPACE_ROOT / "tire_v2_reference" / "adapters.py",
            PACKAGE_ROOT / "tire_v2_final" / "adapters.py",
        ),
    ):
        if upstream.exists():
            source_pairs.append(
                {
                    "name": name,
                    "upstream": str(upstream),
                    "upstream_sha256": _sha256(upstream),
                    "vendored": str(vendored.relative_to(ARTIFACT_ROOT)),
                    "vendored_sha256": _sha256(vendored),
                    "byte_identical": _sha256(upstream) == _sha256(vendored),
                }
            )
    regression_snapshots = []
    for name, upstream_dir, snapshot_dir, filenames in (
        (
            "steering_reference",
            WORKSPACE_ROOT / "steering_reference",
            REFERENCE_REGRESSION_ROOT / "steering_reference",
            ("steering.py", "vehicle.py", "test_steering.py"),
        ),
        (
            "chassis_suspension_reference",
            WORKSPACE_ROOT / "chassis_suspension_reference",
            REFERENCE_REGRESSION_ROOT / "chassis_suspension_reference",
            ("kinematics.py", "mass_properties.py", "quarter_car.py", "test_chassis_suspension.py"),
        ),
        (
            "tire_v2_final_reference",
            WORKSPACE_ROOT / "tire_v2_reference",
            REFERENCE_REGRESSION_ROOT / "tire_v2_reference",
            ("__init__.py", "tire_model.py", "adapters.py", "coupled_solver.py", "test_tire_v2.py"),
        ),
    ):
        entries = []
        for filename in filenames:
            upstream = upstream_dir / filename
            snapshot = snapshot_dir / filename
            entries.append(
                {
                    "file": filename,
                    "upstream_sha256": _sha256(upstream) if upstream.exists() else None,
                    "snapshot_sha256": _sha256(snapshot),
                    "byte_identical": upstream.exists() and _sha256(upstream) == _sha256(snapshot),
                }
            )
        regression_snapshots.append(
            {
                "name": name,
                "snapshot_root": str(snapshot_dir.relative_to(ARTIFACT_ROOT)),
                "files": entries,
                "all_byte_identical": all(entry["byte_identical"] for entry in entries),
            }
        )
    baseline_zip = Path.home() / "Downloads" / "engine_calibration_reference_implemented_v2_1_closeout.zip"
    return {
        "files": hashes,
        "accepted_source_pairs": source_pairs,
        "regression_snapshots": regression_snapshots,
        "v2_1_baseline": {
            "path": str(baseline_zip),
            "expected_sha256": "9dc94047d983fe04e49b0f6cab6bcfe480b88bcb91828a1ef95716225634432f",
            "observed_sha256": _sha256(baseline_zip) if baseline_zip.exists() else None,
            "fresh_result": "engine_calibration_reference/results/vehicle_physics_v2_1_closeout_results.json",
            "fresh_result_sha256": _sha256(RESULTS_ROOT / "vehicle_physics_v2_1_closeout_results.json"),
            "fresh_unittest_log": "engine_calibration_reference/results/unittest_v2_1.txt",
            "fresh_unittest_log_sha256": _sha256(RESULTS_ROOT / "unittest_v2_1.txt"),
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--validation-only", action="store_true")
    parser.add_argument("--regressions-only", action="store_true")
    args = parser.parse_args(argv)
    if args.validation_only and args.regressions_only:
        parser.error("choose at most one partial mode")
    RESULTS_ROOT.mkdir(parents=True, exist_ok=True)

    validation = None if args.regressions_only else run_unified_validation()
    regressions = None if args.validation_only else run_regressions()
    if validation is not None:
        (RESULTS_ROOT / "unified_vehicle_validation_v2_2.json").write_text(
            json.dumps(validation, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    if regressions is not None:
        (RESULTS_ROOT / "subsystem_regressions_v2_2.json").write_text(
            json.dumps(regressions, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
    if validation is None or regressions is None:
        selected = validation if validation is not None else regressions
        return 0 if selected and selected["status"] == "PASS" else 1

    executable_pass = validation["status"] == "PASS" and regressions["status"] == "PASS"
    closeout = {
        "schema": "vehicle-physics-final-closeout-v2.2",
        "status": "PASS" if executable_pass else "FAIL",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "runtime": {
            "python": platform.python_version(),
            "python_executable": sys.executable,
            "platform": platform.platform(),
            "numpy": np.__version__,
            "scipy": scipy.__version__,
        },
        "baseline_policy": {
            "starting_point": "v2.1 close-out artifacts",
            "v2_1_implementation_reworked": False,
            "v2_1_regression_rerun": True,
            "new_scope": [
                "Steering-to-Tire-Mz closure",
                "accepted K&C/spring/damper/ARB/compliance execution",
                "complete Tire V2 final policy",
                "full Aero six-component wrench in reduced host",
                "dynamic maneuvers and refinement",
                "five-owner trial/preflight/commit/abort",
            ],
        },
        "validation": validation,
        "regressions": regressions,
        "provenance": _provenance(),
        "release_decision": {
            "reduced_planar_reference_executable_closeout": "PASS" if executable_pass else "FAIL",
            "whole_vehicle_6dof_executable_closeout": "NOT_ACHIEVED",
            "target_vehicle_correlation": "NOT_ACHIEVED",
            "truthful_summary": (
                "All currently available accepted subsystem contracts execute in one reduced-planar "
                "transactional fixture. Whole-vehicle 6DOF/game-host close-out is not claimable without "
                "the Rapier host and target-vehicle data."
            ),
        },
        "skips": [
            {
                "id": "SKIP_RAPIER_6DOF_HOST",
                "status": "SKIP",
                "reason": "No Rapier/game host is present; SE(3) entity/component wrench application cannot be validated.",
            },
            {
                "id": "SKIP_TARGET_VEHICLE_DATA",
                "status": "SKIP",
                "reason": "No target Engine, Flat-Trac/TIR, K&C, aero, hardpoint, spring/ARB/compliance, EPS/rack, or ISO maneuver datasets are present.",
            },
            {
                "id": "SKIP_REVERSE_QSS_AERO",
                "status": "SKIP",
                "reason": "Aero v1.9 explicitly rejects reverse flow and no accepted fallback backend exists.",
            },
            {
                "id": "SKIP_GLOBAL_TIRE_PASSIVITY_PROOF",
                "status": "SKIP",
                "reason": "The accepted empirical Tire final reference documents that closed sample cycles are tests, not a global potential/passivity proof.",
            },
        ],
    }
    closeout_path = RESULTS_ROOT / "vehicle_physics_v2_2_final_closeout_results.json"
    closeout_path.write_text(
        json.dumps(closeout, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    manifest = {
        "schema": "vehicle-physics-v2.2-run-manifest",
        "result": str(closeout_path.relative_to(ARTIFACT_ROOT)),
        "result_sha256": _sha256(closeout_path),
        "validation": "engine_calibration_reference/results/unified_vehicle_validation_v2_2.json",
        "validation_sha256": _sha256(RESULTS_ROOT / "unified_vehicle_validation_v2_2.json"),
        "regressions": "engine_calibration_reference/results/subsystem_regressions_v2_2.json",
        "regressions_sha256": _sha256(RESULTS_ROOT / "subsystem_regressions_v2_2.json"),
        "release_decision": closeout["release_decision"],
        "status": "PASS" if executable_pass else "FAIL",
    }
    (RESULTS_ROOT / "run_manifest_v2_2_final.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    return 0 if executable_pass else 1


if __name__ == "__main__":
    raise SystemExit(main())
