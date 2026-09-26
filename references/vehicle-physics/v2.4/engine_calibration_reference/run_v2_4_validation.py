"""Portable, read-only validation entry for the v2.4 standalone closeout.

The runner writes nothing inside the package.  It prints one JSON manifest to
stdout and only creates a file when ``--json-out`` is supplied explicitly.
Historical ``run_v2_*`` artifact generators are intentionally not invoked.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
from importlib.metadata import PackageNotFoundError, version
import json
import math
from pathlib import Path
import platform
import re
import subprocess
import sys
import time
import tomllib
from typing import Any, Sequence
import uuid

import numpy
import scipy


PACKAGE_DIR = Path(__file__).resolve().parent
PACKAGE_ROOT = PACKAGE_DIR.parent
IMPORT_NAME = "engine_calibration_reference"
DISTRIBUTION_NAME = "engine-calibration-reference"
SOURCE_TREE = (PACKAGE_ROOT / "pyproject.toml").is_file()

# These modules form the v2.4 standalone execution surface.  Historical
# closeout runners and superseded Tire implementations remain in the source
# archive for traceability, but validation does not import them as current API.
CURRENT_IMPORT_MODULES = (
    "accepted_tire_adapter",
    "aero_reference_v1_9",
    "asset_pipeline",
    "calibration",
    "calibration_fixtures",
    "calibration_validation_reference_v2_0",
    "chassis_suspension_reference",
    "coupled_vehicle_solver",
    "engine_behavior_reference_v2_0",
    "engine_model",
    "host_integration",
    "powertrain_controller",
    "reference_assets",
    "rigs",
    "run_v2_4_maneuver_matrix",
    "runtime_vehicle_solver",
    "steering_reference_v2",
    "steering_transaction",
    "timeseries_pipeline",
    "tire_host_contract",
    "tire_v2_reference_v1_7",
    "tire_v2_reference_v1_8",
    "unified_vehicle_fixture",
    "vehicle_controls_reference",
)
HASHED_SUFFIXES = {".py", ".md", ".toml", ".txt", ".json", ".csv"}
GENERATED_MANIFEST_NAMES = {"validation_manifest_v2_4.json"}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _source_hashes() -> dict[str, str]:
    candidates: list[Path] = []
    directories = [PACKAGE_DIR]
    if SOURCE_TREE:
        candidates.extend(
            (
                PACKAGE_ROOT / "pyproject.toml",
                PACKAGE_ROOT / "MANIFEST.in",
                PACKAGE_ROOT / "README.md",
                PACKAGE_ROOT / "REFERENCE_RUNTIME.md",
                PACKAGE_ROOT / "requirements-reference.txt",
                PACKAGE_ROOT / ".gitignore",
            )
        )
        directories.extend((PACKAGE_ROOT / "tests", PACKAGE_ROOT / "docs"))
    for directory in directories:
        if directory.exists():
            candidates.extend(
                path
                for path in directory.rglob("*")
                if path.is_file()
                and path.suffix.lower() in HASHED_SUFFIXES
                and path.name not in GENERATED_MANIFEST_NAMES
            )
    return {
        path.relative_to(PACKAGE_ROOT).as_posix(): _sha256(path)
        for path in sorted(set(candidates))
        if path.exists()
    }


def _compile_and_import() -> dict[str, Any]:
    started = time.perf_counter()
    source_files = sorted(PACKAGE_DIR.rglob("*.py"))
    for path in source_files:
        relative_name = path.relative_to(PACKAGE_ROOT).as_posix()
        compile(path.read_text(encoding="utf-8"), relative_name, "exec")

    package = importlib.import_module(IMPORT_NAME)
    imported_modules = [f"{IMPORT_NAME}.{name}" for name in CURRENT_IMPORT_MODULES]
    for module_name in imported_modules:
        importlib.import_module(module_name)
    return {
        "name": "compile_and_public_import",
        "status": "PASS",
        "exit_code": 0,
        "duration_s": time.perf_counter() - started,
        "source_file_count": len(source_files),
        "public_api_count": len(getattr(package, "__all__", ())),
        "imported_module_count": len(imported_modules),
        "imported_modules": imported_modules,
    }


def _run_suite(name: str, argv: Sequence[str], timeout_s: float) -> dict[str, Any]:
    started = time.perf_counter()
    reported_argv = [Path(argv[0]).name, *argv[1:]]
    try:
        completed = subprocess.run(
            list(argv),
            cwd=PACKAGE_ROOT,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout_s,
            check=False,
        )
        output = completed.stdout
        result: dict[str, Any] = {
            "name": name,
            "argv": reported_argv,
            "status": "PASS" if completed.returncode == 0 else "FAIL",
            "exit_code": completed.returncode,
            "duration_s": time.perf_counter() - started,
            "timed_out": False,
            "output_tail": output[-6000:],
        }
    except subprocess.TimeoutExpired as exc:
        captured = exc.stdout or ""
        if isinstance(captured, bytes):
            captured = captured.decode("utf-8", errors="replace")
        return {
            "name": name,
            "argv": reported_argv,
            "status": "TIMEOUT",
            "exit_code": 124,
            "duration_s": time.perf_counter() - started,
            "timed_out": True,
            "output_tail": captured[-6000:],
        }

    unittest_count = re.search(r"Ran (\d+) tests?", output)
    pytest_counts = re.search(r"(\d+) passed", output)
    if unittest_count:
        result["collected"] = int(unittest_count.group(1))
    elif pytest_counts:
        result["passed"] = int(pytest_counts.group(1))
    for label in ("skipped", "xfailed", "xpassed", "failed", "error", "errors"):
        match = re.search(rf"(\d+) {label}", output) or re.search(
            rf"{label}=(\d+)", output
        )
        if match:
            result[label] = int(match.group(1))
    expected_failures = re.search(r"expected failures?=(\d+)", output)
    if expected_failures:
        result["expected_failures"] = int(expected_failures.group(1))
    return result


def _distribution_version() -> str | None:
    project_file = PACKAGE_ROOT / "pyproject.toml"
    if project_file.is_file():
        project = tomllib.loads(project_file.read_text(encoding="utf-8"))
        declared = project.get("project", {}).get("version")
        if isinstance(declared, str):
            return declared
    try:
        return version(DISTRIBUTION_NAME)
    except PackageNotFoundError:
        return None


def _unavailable_check(name: str, reason: str) -> dict[str, Any]:
    return {
        "name": name,
        "status": "UNAVAILABLE",
        "exit_code": 2,
        "duration_s": 0.0,
        "timed_out": False,
        "reason": reason,
    }


def _result_details(case: dict[str, Any]) -> list[dict[str, Any]]:
    details = case.get("details", {})
    records: list[dict[str, Any]] = []
    if isinstance(details, dict) and "residual_scaled_inf" in details:
        records.append(details)
    if isinstance(details, dict):
        for step in details.get("steps", ()):
            if isinstance(step, dict) and isinstance(step.get("details"), dict):
                step_details = step["details"]
                if "residual_scaled_inf" in step_details:
                    records.append(step_details)
    return records


def _boundary_details(case: dict[str, Any]) -> dict[str, Any]:
    details = case.get("details", {})
    if not isinstance(details, dict):
        return {}
    if "exception_type" in details:
        return details
    steps = details.get("steps", ())
    if steps and isinstance(steps[-1], dict):
        nested = steps[-1].get("details", {})
        if isinstance(nested, dict):
            return nested
    return {}


def _maneuver_matrix_check(path: Path) -> dict[str, Any]:
    started = time.perf_counter()
    if not path.is_file():
        return _unavailable_check(
            "maneuver_matrix_evidence",
            f"requested matrix file is unavailable: {path.name}",
        )
    try:
        matrix = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return _unavailable_check("maneuver_matrix_evidence", str(exc))
    if not isinstance(matrix, dict):
        return _unavailable_check(
            "maneuver_matrix_evidence", "matrix JSON root must be an object"
        )

    cases = matrix.get("cases", ())
    counts = matrix.get("counts", {})
    case_count = matrix.get("case_count")
    if not isinstance(cases, list) or not isinstance(counts, dict):
        return _unavailable_check(
            "maneuver_matrix_evidence", "matrix cases/counts have an invalid shape"
        )

    expected_schema = "vehicle-physics-v2.4-maneuver-matrix-v1"
    known_statuses = ("PASS", "EXPECTED_HOST_BOUNDARY", "FAIL", "TIMEOUT")
    expected_boundaries = {
        (
            "service_brake_full",
            "MAPPED_KC_MASSLESS",
            60,
            "RigidBodyDynamicsHostRequired",
        ),
        (
            "step_driver_F_to_R_full_brake",
            "MAPPED_KC_MASSLESS",
            60,
            "RigidBodyDynamicsHostRequired",
        ),
    }
    solver_methods: set[str] = set()
    residuals: list[float] = []
    nonlinear_evaluations: list[int] = []
    solver_attempt_counts: list[int] = []
    transaction_violations: list[str] = []
    record_errors: list[str] = []
    boundaries: list[dict[str, Any]] = []
    case_records: list[dict[str, Any]] = []

    for case in cases:
        if not isinstance(case, dict):
            record_errors.append("case is not an object")
            continue
        scenario = case.get("scenario")
        backend = case.get("backend")
        hz = case.get("hz")
        case_status = case.get("status")
        identity = (
            f"{scenario}:{backend}:{hz}Hz"
        )
        if (
            not isinstance(scenario, str)
            or not isinstance(backend, str)
            or not isinstance(hz, int)
            or case_status not in known_statuses
        ):
            record_errors.append(f"{identity}: incomplete or invalid case identity/status")

        result_records = _result_details(case)
        if case_status == "PASS" and not result_records:
            record_errors.append(f"{identity}: PASS has no solver result record")
        steps = case.get("details", {}).get("steps", ()) if isinstance(
            case.get("details"), dict
        ) else ()
        if case_status == "PASS" and steps and any(
            not isinstance(step, dict) or step.get("status") != "PASS"
            for step in steps
        ):
            record_errors.append(f"{identity}: PASS contains a non-PASS driver step")

        case_residuals: list[float] = []
        for details in result_records:
            required_fields = {
                "residual_scaled_inf",
                "peak_row",
                "solver_method",
                "solver_attempts",
                "nonlinear_evaluations",
                "transaction",
            }
            missing = sorted(required_fields.difference(details))
            if missing:
                record_errors.append(f"{identity}: missing {','.join(missing)}")
                continue
            try:
                residual = float(details["residual_scaled_inf"])
            except (TypeError, ValueError):
                record_errors.append(f"{identity}: residual is not numeric")
                continue
            if not math.isfinite(residual):
                record_errors.append(f"{identity}: residual is not finite")
                continue
            residuals.append(residual)
            case_residuals.append(residual)
            if isinstance(details.get("solver_method"), str):
                solver_methods.add(details["solver_method"])
            else:
                record_errors.append(f"{identity}: solver_method is not a string")
            if isinstance(details.get("peak_row"), str):
                pass
            else:
                record_errors.append(f"{identity}: peak_row is not a string")
            if isinstance(details.get("nonlinear_evaluations"), int):
                nonlinear_evaluations.append(details["nonlinear_evaluations"])
            else:
                record_errors.append(
                    f"{identity}: nonlinear_evaluations is not an integer"
                )
            attempts = details.get("solver_attempts", ())
            if isinstance(attempts, list) and attempts:
                solver_attempt_counts.append(len(attempts))
            else:
                record_errors.append(f"{identity}: solver_attempts is empty or invalid")
            if case_status == "PASS":
                transaction = details.get("transaction")
                if not isinstance(transaction, dict) or not transaction.get(
                    "committed_exactly_once", False
                ):
                    transaction_violations.append(identity)

        case_record: dict[str, Any] = {
            "scenario": scenario,
            "backend": backend,
            "hz": hz,
            "status": case_status,
        }
        if case_residuals:
            case_record["max_residual_scaled_inf"] = max(case_residuals)

        if case_status == "EXPECTED_HOST_BOUNDARY":
            details = _boundary_details(case)
            transaction = details.get("transaction")
            boundary = {
                "scenario": scenario,
                "backend": backend,
                "hz": hz,
                "exception_type": details.get("exception_type"),
                "transaction": transaction,
            }
            boundaries.append(boundary)
            case_record["exception_type"] = details.get("exception_type")
            if (
                not isinstance(transaction, dict)
                or transaction.get("committed_exactly_once", False)
                or transaction.get("committed")
                or not (transaction.get("aborted") or transaction.get("rolled_back"))
            ):
                transaction_violations.append(identity)
        case_records.append(case_record)

    recomputed_counts = {
        status: sum(case.get("status") == status for case in cases if isinstance(case, dict))
        for status in known_statuses
    }
    actual_boundaries = {
        (
            record["scenario"],
            record["backend"],
            record["hz"],
            record["exception_type"],
        )
        for record in boundaries
    }
    unexpected_boundaries = sorted(
        actual_boundaries.difference(expected_boundaries), key=repr
    )
    missing_boundaries = sorted(
        expected_boundaries.difference(actual_boundaries), key=repr
    )
    valid = (
        matrix.get("schema") == expected_schema
        and case_count == 33
        and case_count == len(cases)
        and set(counts) == set(known_statuses)
        and counts == recomputed_counts
        and counts.get("FAIL", 0) == 0
        and counts.get("TIMEOUT", 0) == 0
        and not transaction_violations
        and not record_errors
        and not unexpected_boundaries
        and not missing_boundaries
    )
    return {
        "name": "maneuver_matrix_evidence",
        "status": "PASS" if valid else "FAIL",
        "exit_code": 0 if valid else 1,
        "duration_s": time.perf_counter() - started,
        "source_file": path.name,
        "source_sha256": _sha256(path),
        "schema": matrix.get("schema"),
        "expected_schema": expected_schema,
        "case_count": case_count,
        "counts": counts,
        "recomputed_counts": recomputed_counts,
        "solver_methods": sorted(solver_methods),
        "max_residual_scaled_inf": max(residuals, default=None),
        "max_nonlinear_evaluations": max(nonlinear_evaluations, default=None),
        "max_solver_attempt_count": max(solver_attempt_counts, default=None),
        "transaction_violations": transaction_violations,
        "record_errors": record_errors,
        "case_records": case_records,
        "expected_host_boundaries": boundaries,
        "unexpected_host_boundaries": unexpected_boundaries,
        "missing_host_boundaries": missing_boundaries,
    }


def _build_manifest(
    source_upstream: bool,
    timeout_s: float,
    maneuver_json: Path | None,
) -> dict[str, Any]:
    run_id = str(uuid.uuid4())
    started = time.perf_counter()
    started_utc = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    checks = [_compile_and_import()]
    package_tests = PACKAGE_DIR / "tests"
    if package_tests.is_dir():
        checks.append(
            _run_suite(
                "package_unittest",
                (
                    sys.executable,
                    "-m",
                    "unittest",
                    "discover",
                    "-v",
                    "-s",
                    f"{IMPORT_NAME}/tests",
                    "-p",
                    "test_*.py",
                ),
                timeout_s,
            )
        )
    else:
        checks.append(
            _unavailable_check(
                "package_unittest", "installed distribution does not contain package tests"
            )
        )
    if source_upstream:
        upstream_tests = PACKAGE_ROOT / "tests" / "upstream_reference"
        if upstream_tests.is_dir():
            checks.append(
                _run_suite(
                    "upstream_reference_pytest",
                    (
                        sys.executable,
                        "-m",
                        "pytest",
                        "-q",
                        "tests/upstream_reference",
                    ),
                    timeout_s,
                )
            )
        else:
            checks.append(
                _unavailable_check(
                    "upstream_reference_pytest",
                    "--source-upstream requires tests/upstream_reference in a source tree",
                )
            )
    if maneuver_json is not None:
        checks.append(_maneuver_matrix_check(maneuver_json.expanduser().resolve()))
    status = "PASS" if all(check["exit_code"] == 0 for check in checks) else "FAIL"
    try:
        pytest_version = version("pytest")
    except PackageNotFoundError:
        pytest_version = None
    return {
        "schema": "vehicle-physics-v2.4-validation-manifest-v2",
        "run_id": run_id,
        "delivery_label": "v2.4-standalone-closeout",
        "distribution_name": DISTRIBUTION_NAME,
        "distribution_version": _distribution_version(),
        "status": status,
        "started_at_utc": started_utc,
        "finished_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "duration_s": time.perf_counter() - started,
        "execution_context": "source_tree" if SOURCE_TREE else "installed_distribution",
        "package_root": ".",
        "source_upstream_requested": source_upstream,
        "environment": {
            "python_executable": Path(sys.executable).name,
            "python_version": platform.python_version(),
            "numpy_version": numpy.__version__,
            "scipy_version": scipy.__version__,
            "pytest_version": pytest_version,
        },
        "checks": checks,
        "declared_boundaries": {
            "world_rigid_body": "RIGID_BODY_DYNAMICS_HOST_REQUIRED",
            "low_speed_contact": "FRICTION_CONTACT_HOST_REQUIRED",
            "target_vehicle_data": "SKIP_NO_TARGET_DATA",
            "optional_models": [
                "LSD_OR_LOCKED_DIFFERENTIAL",
                "TIRE_THERMAL_AND_WEAR",
                "ACTIVE_OR_UNSTEADY_AERO",
            ],
        },
        "declared_test_outcomes": {
            "package_expected_failures": [
                {
                    "test": "test_engine_behavior_reference_v2_0.TestTrialCommitAndModes.test_naive_post_integration_rpm_clamp_conserves_angular_impulse",
                    "reason": "negative control: a naive post-integration RPM clamp does not conserve angular impulse",
                }
            ],
            "package_skips": [
                {
                    "test": "test_engine_behavior_reference_v2_0.TestTrialCommitAndModes.test_target_low_speed_start_stall_fixture",
                    "reason": "target low-speed combustion/starter/stall fixture is unavailable",
                }
            ],
            "upstream_xfails": [
                {
                    "test": "test_chassis_suspension_reference.py::test_matrix_combined_roll_lateral_additive_superposition_is_not_exact",
                    "reason": "additive K&C superposition intentionally cannot reproduce the embedded combined-load cross term",
                },
                {
                    "test": "test_tire_v2_reference_v1_7.py::test_standstill_bore_torque_not_core",
                    "reason": "the accepted handling Tire intentionally excludes standstill turn-slip, bore, and parking-torque state",
                },
            ],
            "upstream_skips": [
                {
                    "test": "test_chassis_suspension_reference.py::test_matrix_offline_hardpoint_chrono_crosscheck_requires_external_reference_fixture",
                    "reason": "no target hardpoint/Chrono reference fixture was supplied",
                },
                {
                    "test": "test_tire_v2_reference_v1_7.py::test_target_tire_measurement_fit",
                    "reason": "no target-tire measured/TIR fixture was supplied",
                },
            ],
        },
        "source_file_sha256": _source_hashes(),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-upstream",
        action="store_true",
        help="also run source-tree-only tests/upstream_reference via pytest",
    )
    parser.add_argument("--skip-upstream", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument(
        "--maneuver-json",
        type=Path,
        help="attach and verify an existing v2.4 maneuver-matrix JSON artifact",
    )
    parser.add_argument("--timeout", type=float, default=900.0)
    parser.add_argument("--json-out", type=Path)
    args = parser.parse_args(argv)
    if args.timeout <= 0.0:
        parser.error("--timeout must be positive")
    if args.source_upstream and args.skip_upstream:
        parser.error("--source-upstream and --skip-upstream are mutually exclusive")

    manifest = _build_manifest(
        args.source_upstream and not args.skip_upstream,
        args.timeout,
        args.maneuver_json,
    )
    rendered = json.dumps(manifest, indent=2, sort_keys=True)
    print(rendered)
    if args.json_out is not None:
        output_path = args.json_out.expanduser().resolve()
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(rendered + "\n", encoding="utf-8")
    return 0 if manifest["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
