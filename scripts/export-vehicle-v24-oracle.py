#!/usr/bin/env python3
"""Export fixed v2.4 evidence vectors for the StreetRush JavaScript port.

The generated JSON is test data only. Python and SciPy never enter the browser
runtime. The source checkout is passed explicitly so this script cannot silently
bind to an unrelated installed package.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict, is_dataclass
from enum import Enum
import hashlib
import json
from pathlib import Path
import sys

import numpy as np


def json_value(value):
    if is_dataclass(value):
        return {key: json_value(item) for key, item in asdict(value).items()}
    if isinstance(value, Enum):
        return value.name
    if isinstance(value, np.ndarray):
        return [json_value(item) for item in value.tolist()]
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_value(item) for item in value]
    return value


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def strip_runtime_noise(case: dict) -> dict:
    details = dict(case.get("details", {}))
    details.pop("wall_time_s", None)
    return {
        "backend": case["backend"],
        "scenario": case["scenario"],
        "hz": case["hz"],
        "status": case["status"],
        "details": details,
    }


def build_vectors(reference_root: Path) -> dict:
    sys.path.insert(0, str(reference_root))
    from engine_calibration_reference.accepted_tire_adapter import (  # noqa: PLC0415
        FrictionContactHostRequired,
        TireState,
        make_reference_model,
    )
    from engine_calibration_reference.tire_host_contract import ContactInput  # noqa: PLC0415
    from engine_calibration_reference.tire_v2_reference_v1_7 import TireMode  # noqa: PLC0415
    from engine_calibration_reference.powertrain_controller import (  # noqa: PLC0415
        ideal_open_differential_mapping,
    )
    from engine_calibration_reference.steering_reference_v2 import (  # noqa: PLC0415
        DeviceKind,
        InputConfig,
        RackMap,
        SteeringCommand,
        SteeringGeometryConfig,
    )
    from engine_calibration_reference.steering_transaction import (  # noqa: PLC0415
        SteeringCanonicalState,
        SteeringTransactionalModel,
    )
    from engine_calibration_reference.vehicle_controls_reference import (  # noqa: PLC0415
        BrakeAssistConfig,
        BrakeAssistController,
    )

    tire = make_reference_model()
    tire_input = ContactInput(
        in_contact=True,
        normal_load_n=4000.0,
        velocity_x_mps=15.0,
        velocity_y_mps=1.2,
        wheel_omega_radps=52.0,
        camber_rad=0.0,
        dt_s=1.0 / 120.0,
        surface_mu_x=1.0,
        surface_mu_y=1.0,
    )
    handling = tire.step(TireState(0.0, 0.0, 0.0, TireMode.HANDLING), tire_input)
    airborne_input = ContactInput(
        in_contact=False,
        normal_load_n=0.0,
        velocity_x_mps=0.0,
        velocity_y_mps=0.0,
        wheel_omega_radps=0.0,
        camber_rad=0.0,
        dt_s=1.0 / 120.0,
    )
    airborne = tire.step(TireState(0.2, -0.1, 0.03, TireMode.HANDLING), airborne_input)
    low_speed_input = ContactInput(
        in_contact=True,
        normal_load_n=4000.0,
        velocity_x_mps=0.2,
        velocity_y_mps=0.1,
        wheel_omega_radps=0.0,
        camber_rad=0.0,
        dt_s=1.0 / 120.0,
    )
    low_speed_boundary = None
    try:
        tire.step(TireState(), low_speed_input)
    except FrictionContactHostRequired as error:
        low_speed_boundary = {"exception": type(error).__name__, "message": str(error)}
    if low_speed_boundary is None:
        raise RuntimeError("accepted Tire no longer exposes the expected low-speed host boundary")

    steering_model = SteeringTransactionalModel(
        input_config=InputConfig(wheelbase_m=2.7, max_virtual_angle_rad=0.45),
        rack_map=RackMap(max_virtual_angle_rad=0.45),
        geometry_config=SteeringGeometryConfig(wheelbase_m=2.7, front_track_m=1.6),
    )
    steering_trial = steering_model.prepare_control(
        SteeringCanonicalState(),
        SteeringCommand(DeviceKind.GAMEPAD, 0.6),
        speed_m_s=15.0,
        dt=1.0 / 120.0,
    )

    brake = BrakeAssistController(BrakeAssistConfig(
        service_capacity_nm=(3100.0, 3100.0, 1900.0, 1900.0),
        parking_capacity_nm=(0.0, 0.0, 7200.0, 7200.0),
    )).evaluate(
        service_brake_request=0.45,
        parking_brake_request=0.0,
        body_u_m_s=15.0,
        yaw_rate_rad_s=0.0,
        steering_curvature_1pm=0.02,
        wheel_omega_rad_s=(48.0, 48.0, 48.0, 48.0),
        effective_radius_m=(0.31, 0.31, 0.31, 0.31),
        driven_wheels=(False, False, True, True),
    )

    matrix_path = reference_root / "engine_calibration_reference/data/maneuver_matrix_v2_4.json"
    manifest_path = reference_root / "engine_calibration_reference/data/validation_manifest_v2_4.json"
    matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
    selected_matrix = [
        strip_runtime_noise(case)
        for case in matrix["cases"]
        if case["hz"] == 120
    ]
    maximum_residual = max(
        details.get("residual_scaled_inf", 0.0)
        for case in matrix["cases"]
        for details in (
            [case.get("details", {})]
            if "steps" not in case.get("details", {})
            else [step.get("details", {}) for step in case["details"]["steps"]]
        )
    )
    return {
        "schema": "streetrush.vehicle-v24.golden.v1",
        "source": {
            "delivery": "vehicle_physics_v2_4_standalone_closeout",
            "maneuverMatrixSha256": sha256(matrix_path),
            "validationManifestSha256": sha256(manifest_path),
            "matrixCounts": matrix["counts"],
            "maximumScaledResidual": maximum_residual,
        },
        "coordinates": {
            "oracle": {"forward": "+X", "left": "+Y", "up": "+Z", "units": "SI"},
            "streetRush": {"forward": "+Z", "right": "+X", "up": "+Y", "units": "SI"},
            "wheelOrder": ["FL", "FR", "RL", "RR"],
            "polarVectorPythonToStreetRush": [[0, -1, 0], [0, 0, 1], [1, 0, 0]],
            "axialVectorUsesDeterminantFactor": -1,
        },
        "componentVectors": {
            "tireHandling": {
                "input": json_value(tire_input),
                "previousState": json_value(TireState(0.0, 0.0, 0.0, TireMode.HANDLING)),
                "output": json_value(handling),
            },
            "tireAirborne": {
                "input": json_value(airborne_input),
                "output": json_value(airborne),
            },
            "lowSpeedHostBoundary": low_speed_boundary,
            "openDifferential": {
                "input": {"finalDriveRatio": 3.5, "sideWheels": [2, 3]},
                "mapping": list(ideal_open_differential_mapping(3.5)),
                "independentWheelOmega": [0.0, 0.0, 40.0, 60.0],
                "externalWheelTorqueNm": [0.0, 0.0, 20.0, -20.0],
            },
            "steering": {
                "input": {"kind": "GAMEPAD", "value": 0.6, "speedMps": 15.0, "dt": 1.0 / 120.0},
                "output": json_value(steering_trial.output),
                "nextState": json_value(steering_trial.next_control_state),
            },
            "brakeAssist": {
                "input": {
                    "service": 0.45,
                    "parking": 0.0,
                    "bodyUMps": 15.0,
                    "streetRushBrakeTorqueNm": 10000.0,
                },
                "output": json_value(brake),
            },
        },
        "maneuver120Hz": selected_matrix,
        "transactionContract": {
            "owners": ["engine", "gearbox", "steering", "tires", "mechanics"],
            "preflightBeforeCommit": True,
            "commitExactlyOnce": True,
            "reverseRollbackOnPostCommitFault": True,
            "residualTolerance": 2.0e-6,
            "singleSolveEvaluationBudget": 120,
            "aggregateEvaluationBudget": 720,
        },
        "errorBoundaries": [
            "FrictionContactHostRequired",
            "UnifiedDomainError",
            "RigidBodyDynamicsHostRequired",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference-root", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    root = args.reference_root.resolve()
    if not (root / "engine_calibration_reference").is_dir():
        parser.error("--reference-root does not contain engine_calibration_reference")
    payload = build_vectors(root)
    encoded = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded, encoding="utf-8")
    else:
        sys.stdout.write(encoded)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
