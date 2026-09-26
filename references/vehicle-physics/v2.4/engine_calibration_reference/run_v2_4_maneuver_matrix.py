"""Run the reproducible 33-case v2.4 standalone maneuver matrix."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import asdict, is_dataclass
from enum import Enum
import json
import math
from pathlib import Path
import platform
import signal
import time
from typing import Any, Callable, Iterator, Sequence
import uuid

import numpy
import scipy

from .accepted_tire_adapter import FrictionContactHostRequired
from .engine_model import EngineCommand
from .steering_reference_v2 import DeviceKind, SteeringCommand
from .unified_vehicle_fixture import (
    RigidBodyDynamicsHostRequired,
    SteeringCausality,
    SuspensionBackend,
    UnifiedVehicleCommand,
    UnifiedVehicleConfig,
    UnifiedVehicleFixture,
)
from .vehicle_controls_reference import (
    DriverCommand,
    DriverDirectionFSM,
    RequestedDirection,
)


HERTZ = (60, 120, 240)
BACKENDS = (
    SuspensionBackend.MAPPED_KC_MASSLESS,
    SuspensionBackend.DYNAMIC_UNSPRUNG,
)
CORE_SCENARIOS = ("straight_no_brake", "service_brake_0.45")
MAPPED_SCENARIOS = (
    "service_brake_full",
    "parking_brake_15mps",
    "position_steering",
    "torque_driven_steering",
    "split_mu",
    "rear_wheel_differential_external",
)


class CaseTimeout(RuntimeError):
    pass


@contextmanager
def _deadline(seconds: float) -> Iterator[None]:
    if not hasattr(signal, "setitimer"):
        yield
        return
    previous_handler = signal.getsignal(signal.SIGALRM)

    def alarm_handler(_signum: int, _frame: object) -> None:
        raise CaseTimeout(f"case exceeded {seconds:.1f}s")

    signal.signal(signal.SIGALRM, alarm_handler)
    previous_timer = signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0.0)
        signal.signal(signal.SIGALRM, previous_handler)
        if previous_timer[0] > 0.0:
            signal.setitimer(signal.ITIMER_REAL, *previous_timer)


def _jsonable(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value):
        return _jsonable(asdict(value))
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_jsonable(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return str(value)
    return value


def _command(name: str) -> UnifiedVehicleCommand:
    if name == "straight_no_brake":
        return UnifiedVehicleCommand(engine=EngineCommand(0.0))
    if name == "service_brake_0.45":
        return UnifiedVehicleCommand(engine=EngineCommand(0.0), service_brake_request=0.45)
    if name == "service_brake_full":
        return UnifiedVehicleCommand(engine=EngineCommand(0.0), service_brake_request=1.0)
    if name == "parking_brake_15mps":
        return UnifiedVehicleCommand(engine=EngineCommand(0.0), parking_brake_request=1.0)
    if name == "position_steering":
        return UnifiedVehicleCommand(
            engine=EngineCommand(0.25),
            steering=SteeringCommand(DeviceKind.GAMEPAD, 0.40),
        )
    if name == "torque_driven_steering":
        return UnifiedVehicleCommand(
            engine=EngineCommand(0.25),
            steering=SteeringCommand(DeviceKind.GAMEPAD, 0.0),
            steering_driver_torque_nm=4.0,
        )
    if name == "split_mu":
        return UnifiedVehicleCommand(
            engine=EngineCommand(0.05),
            surface_mu_x=(1.0, 0.55, 1.0, 0.55),
            surface_mu_y=(1.0, 0.55, 1.0, 0.55),
        )
    if name == "rear_wheel_differential_external":
        return UnifiedVehicleCommand(
            engine=EngineCommand(0.20),
            wheel_external_torque_nm=(0.0, 0.0, 20.0, -20.0),
        )
    raise KeyError(name)


def _fixture(name: str) -> UnifiedVehicleFixture:
    config = (
        UnifiedVehicleConfig(steering_causality=SteeringCausality.TORQUE_DRIVEN)
        if name == "torque_driven_steering"
        else UnifiedVehicleConfig()
    )
    return UnifiedVehicleFixture.synthetic(config=config)


def _transaction(audit: Any) -> dict[str, Any]:
    return {
        "committed_exactly_once": bool(audit.committed_exactly_once),
        "committed": list(audit.committed),
        "aborted": list(audit.aborted),
        "rolled_back": list(audit.rolled_back),
    }


def _result_record(result: Any) -> dict[str, Any]:
    return {
        "residual_scaled_inf": float(result.residual_scaled_inf),
        "peak_row": result.residual_row_labels[
            max(
                range(len(result.residual_scaled_components)),
                key=lambda index: abs(result.residual_scaled_components[index]),
            )
        ],
        "solver_method": result.nonlinear_solver_method,
        "solver_attempts": list(result.nonlinear_solver_attempts),
        "nonlinear_evaluations": int(result.nonlinear_evaluations),
        "clutch_regime": result.clutch_regime.value,
        "brake_regimes": [mode.value for mode in result.brake_regimes],
        "contact_regimes": [mode.value for mode in result.contact_regimes],
        "normal_loads_n": list(map(float, result.state.mechanics.normal_loads_n)),
        "contact_gaps_m": [float(corner.contact_gap_m) for corner in result.corners],
        "body_u_m_s": float(result.state.mechanics.body_u_m_s),
        "body_v_m_s": float(result.state.mechanics.body_v_m_s),
        "yaw_rate_rad_s": float(result.state.mechanics.yaw_rate_rad_s),
        "transaction": _transaction(result.transaction),
    }


def _run_action(
    fixture: UnifiedVehicleFixture,
    action: Callable[[], Any],
    timeout_s: float,
) -> tuple[str, dict[str, Any]]:
    started = time.perf_counter()
    try:
        with _deadline(timeout_s):
            output = action()
        result = getattr(output, "vehicle", output)
        details = _result_record(result)
        details["wall_time_s"] = time.perf_counter() - started
        if (
            result.residual_scaled_inf > fixture.config.residual_tolerance
            or not result.transaction.committed_exactly_once
        ):
            return "FAIL", details
        return "PASS", details
    except (RigidBodyDynamicsHostRequired, FrictionContactHostRequired) as exc:
        return "EXPECTED_HOST_BOUNDARY", {
            "exception_type": type(exc).__name__,
            "message": str(exc),
            "wall_time_s": time.perf_counter() - started,
            "transaction": _transaction(fixture.last_transaction_audit),
        }
    except CaseTimeout as exc:
        return "TIMEOUT", {
            "exception_type": type(exc).__name__,
            "message": str(exc),
            "wall_time_s": time.perf_counter() - started,
            "transaction": _transaction(fixture.last_transaction_audit),
        }
    except Exception as exc:
        return "FAIL", {
            "exception_type": type(exc).__name__,
            "message": str(exc),
            "wall_time_s": time.perf_counter() - started,
            "transaction": _transaction(fixture.last_transaction_audit),
        }


def _direct_case(name: str, backend: SuspensionBackend, hz: int, timeout_s: float) -> dict[str, Any]:
    fixture = _fixture(name)
    command = _command(name)
    dt = 1.0 / hz
    status, details = _run_action(
        fixture,
        lambda: fixture.step(command, dt, backend),
        timeout_s,
    )
    return {
        "scenario": name,
        "backend": backend.value,
        "hz": hz,
        "status": status,
        "details": details,
    }


def _driver_case(hz: int, timeout_s: float) -> dict[str, Any]:
    fixture = UnifiedVehicleFixture.synthetic()
    fsm = DriverDirectionFSM()
    command = DriverCommand(
        throttle_request=0.0,
        service_brake_request=1.0,
        requested_direction=RequestedDirection.REVERSE,
    )
    dt = 1.0 / hz
    steps: list[dict[str, Any]] = []
    status = "PASS"
    for index in range(1, 4):
        step_status, details = _run_action(
            fixture,
            lambda: fixture.step_driver(fsm, command, dt, SuspensionBackend.MAPPED_KC_MASSLESS),
            timeout_s,
        )
        details["step_index"] = index
        details["fsm_direction"] = fsm.state.selected_direction.value
        steps.append({"status": step_status, "details": details})
        if step_status != "PASS":
            status = step_status
            break
    return {
        "scenario": "step_driver_F_to_R_full_brake",
        "backend": SuspensionBackend.MAPPED_KC_MASSLESS.value,
        "hz": hz,
        "status": status,
        "details": {"steps": steps},
    }


def _markdown(manifest: dict[str, Any]) -> str:
    counts = manifest["counts"]
    lines = [
        "# v2.4 maneuver matrix",
        "",
        f"Cases: {manifest['case_count']}; "
        + ", ".join(f"{key}={value}" for key, value in counts.items()),
        "",
        "| scenario | backend | Hz | status | residual / exception |",
        "|---|---|---:|---|---|",
    ]
    for case in manifest["cases"]:
        details = case["details"]
        evidence = details.get("residual_scaled_inf")
        if evidence is None:
            evidence = details.get("exception_type")
        if evidence is None and details.get("steps"):
            last = details["steps"][-1]["details"]
            evidence = last.get("residual_scaled_inf", last.get("exception_type"))
        lines.append(
            f"| {case['scenario']} | {case['backend']} | {case['hz']} | "
            f"{case['status']} | {evidence} |"
        )
    return "\n".join(lines) + "\n"


def run_matrix(timeout_s: float) -> dict[str, Any]:
    run_id = str(uuid.uuid4())
    started = time.perf_counter()
    started_utc = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    cases: list[dict[str, Any]] = []
    for name in CORE_SCENARIOS:
        for backend in BACKENDS:
            for hz in HERTZ:
                cases.append(_direct_case(name, backend, hz, timeout_s))
    for name in MAPPED_SCENARIOS:
        for hz in HERTZ:
            cases.append(_direct_case(name, SuspensionBackend.MAPPED_KC_MASSLESS, hz, timeout_s))
    for hz in HERTZ:
        cases.append(_driver_case(hz, timeout_s))
    counts = {
        status: sum(case["status"] == status for case in cases)
        for status in ("PASS", "EXPECTED_HOST_BOUNDARY", "FAIL", "TIMEOUT")
    }
    return {
        "schema": "vehicle-physics-v2.4-maneuver-matrix-v1",
        "run_id": run_id,
        "delivery_label": "v2.4-standalone-closeout",
        "started_at_utc": started_utc,
        "finished_at_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "duration_s": time.perf_counter() - started,
        "case_timeout_s": timeout_s,
        "environment": {
            "python_version": platform.python_version(),
            "numpy_version": numpy.__version__,
            "scipy_version": scipy.__version__,
        },
        "case_count": len(cases),
        "counts": counts,
        "cases": cases,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case-timeout", type=float, default=30.0)
    parser.add_argument("--json-out", type=Path)
    parser.add_argument("--markdown-out", type=Path)
    args = parser.parse_args(argv)
    if args.case_timeout <= 0.0:
        parser.error("--case-timeout must be positive")
    manifest = _jsonable(run_matrix(args.case_timeout))
    rendered = json.dumps(manifest, indent=2, sort_keys=True)
    print(rendered)
    if args.json_out is not None:
        path = args.json_out.expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(rendered + "\n", encoding="utf-8")
    if args.markdown_out is not None:
        path = args.markdown_out.expanduser().resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_markdown(manifest), encoding="utf-8")
    return 0 if manifest["counts"]["FAIL"] == 0 and manifest["counts"]["TIMEOUT"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
