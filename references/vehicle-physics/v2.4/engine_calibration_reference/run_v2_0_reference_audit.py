"""Run the enhanced v2.0 reference suite and write auditable artifacts."""

from __future__ import annotations

from dataclasses import asdict
from io import StringIO
import json
from pathlib import Path
import sys
import unittest

from .calibration import GateStatus, write_ledger
from .calibration_fixtures import manifests_as_json, passports_as_json
from .closeout_audit import build_closeout_evidence
from .implementation_audit import build_implementation_evidence


PACKAGE_ROOT = Path(__file__).resolve().parent
RESULTS_ROOT = PACKAGE_ROOT / "results"


def _write_json(path: Path, payload: object) -> None:
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
        encoding="utf-8",
    )


def run_unittest_suite() -> tuple[unittest.TestResult, str]:
    stream = StringIO()
    suite = unittest.defaultTestLoader.discover(str(PACKAGE_ROOT / "tests"))
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
    return result, stream.getvalue()


def main() -> int:
    RESULTS_ROOT.mkdir(parents=True, exist_ok=True)
    test_result, test_output = run_unittest_suite()
    evidence = build_closeout_evidence(PACKAGE_ROOT)
    implementation = build_implementation_evidence(PACKAGE_ROOT)
    unit_summary = {
        "tests_run": test_result.testsRun,
        "failures": len(test_result.failures),
        "errors": len(test_result.errors),
        "skipped": len(test_result.skipped),
        "expected_failures": len(test_result.expectedFailures),
        "unexpected_successes": len(test_result.unexpectedSuccesses),
        "successful": test_result.wasSuccessful(),
    }
    gate_summary = {
        status.value: sum(gate.status is status for gate in evidence.gates)
        for status in GateStatus
    }
    metadata = {
        "baseline_version": "v2.0",
        "scope": "Engine Behavior + finite-capacity coupled powertrain + Calibration/Validation executable implementation",
        "synthetic_fixture_notice": "All bundled numbers are structural synthetic data, not target-vehicle calibration.",
        "run_manifest": asdict(evidence.run_manifest),
        "unittest_summary": unit_summary,
    }
    write_ledger(
        RESULTS_ROOT / "validation_ledger_v2_0.json",
        evidence.gates,
        metadata,
        evidence.release_decision,
    )
    _write_json(
        RESULTS_ROOT / "dataset_manifests_v2_0.json",
        {"schema": "vehicle-dataset-manifests-v2", "datasets": manifests_as_json(evidence.datasets)},
    )
    _write_json(
        RESULTS_ROOT / "parameter_passports_v2_0.json",
        {"schema": "vehicle-parameter-passports-v2", "parameters": passports_as_json(evidence.passports)},
    )
    _write_json(RESULTS_ROOT / "run_manifest_v2_0.json", asdict(evidence.run_manifest))
    payload = {
        "schema": "vehicle-physics-v2.0-executable-closeout-results",
        "scope": metadata["scope"],
        "synthetic_fixture_notice": metadata["synthetic_fixture_notice"],
        "unittest": {**unit_summary, "output": test_output},
        "gate_summary": gate_summary,
        "release_decision": asdict(evidence.release_decision),
        "numerical": evidence.numerical,
        "active_set_implementation": implementation,
        "artifact_paths": {
            "ledger": "results/validation_ledger_v2_0.json",
            "dataset_manifests": "results/dataset_manifests_v2_0.json",
            "parameter_passports": "results/parameter_passports_v2_0.json",
            "run_manifest": "results/run_manifest_v2_0.json",
            "active_set_module_audit": "results/active_set_module_audit_v2_0.json",
            "compiled_engine_asset": "data/compiled_engine_v2_0/engine_asset.json",
            "compiled_vehicle_config": "data/compiled_vehicle_config_v2_0.json",
            "compiled_gearbox_asset": "data/compiled_gearbox_asset_v2_0.json",
        },
    }
    _write_json(RESULTS_ROOT / "vehicle_physics_v2_0_closeout_results.json", payload)
    print(test_output, end="")
    print(json.dumps({"gate_summary": gate_summary, "release_decision": asdict(evidence.release_decision)}, ensure_ascii=False, indent=2))
    return 0 if test_result.wasSuccessful() and evidence.release_decision.reference_executable_ready else 1


if __name__ == "__main__":
    raise SystemExit(main())
