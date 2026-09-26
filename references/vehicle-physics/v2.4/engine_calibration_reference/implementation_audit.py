"""Build compiled assets and executable evidence for the substantive module."""

from __future__ import annotations

from dataclasses import asdict, is_dataclass, replace
from enum import Enum
import hashlib
import json
from pathlib import Path
from typing import Any, Mapping

from .asset_pipeline import EngineAssetCompiler, verify_compiled_engine_bundle
from .coupled_vehicle_solver import (
    CoupledVehicleState,
    make_consistent_state,
    solve_coupled_vehicle_substep,
)
from .engine_model import EngineCommand, EngineMode, EngineModel, EngineOwner, EngineState, rpm_to_rad_s
from .powertrain_controller import (
    GearboxCommand,
    GearboxState,
    PowertrainVehicleState,
    PowertrainVehicleSystem,
)
from .reference_assets import make_reference_gearbox_asset, make_reference_vehicle_config


MODULE_SCHEMA = "vehicle-physics-active-set-module-audit-v1"


def _jsonable(value: Any) -> Any:
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value):
        return _jsonable(asdict(value))
    if isinstance(value, Mapping):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [_jsonable(item) for item in value]
    return value


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(_jsonable(payload), sort_keys=True, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _single_step_scenario(
    model: EngineModel,
    *,
    tire_mu: float,
    clutch_capacity_nm: float,
    engine_rpm: float,
    speed_m_s: float,
    throttle: float,
) -> dict[str, object]:
    config = make_reference_vehicle_config(
        tire_mu=tire_mu, clutch_capacity_nm=clutch_capacity_nm
    )
    wheel_speed = speed_m_s / config.wheel_radii_m[0]
    engine = EngineState(rpm_to_rad_s(engine_rpm), EngineMode.RUNNING, throttle)
    state = CoupledVehicleState(engine, (wheel_speed, wheel_speed), speed_m_s)
    owner = EngineOwner(model, engine)
    dt = 1.0 / 120.0
    ticket = owner.begin_substep(EngineCommand(throttle), dt)
    result = solve_coupled_vehicle_substep(
        owner, ticket, state, config, (0.0, 0.0), dt
    )
    return {
        "engine_bound_mode": result.engine_bound_mode.value,
        "clutch_mode": result.clutch_mode.value,
        "tire_modes": [mode.value for mode in result.tire_modes],
        "engine_rpm_before": engine_rpm,
        "engine_rpm_after": result.state.engine.rpm,
        "speed_before_m_s": speed_m_s,
        "speed_after_m_s": result.state.chassis_speed_m_s,
        "clutch_impulse_nms": result.clutch_impulse_nms,
        "clutch_capacity_impulse_nms": result.clutch_capacity_impulse_nms,
        "tire_impulses_n_s": list(result.tire_impulses_n_s),
        "tire_capacity_impulses_n_s": list(result.tire_capacity_impulses_n_s),
        "scaled_residual_inf": result.scaled_residual_inf,
        "energy_identity_residual_j": result.energy.identity_residual_j,
        "physical_constraint_dissipation_j": result.energy.physical_constraint_dissipation_j,
        "candidates_examined": result.candidates_examined,
        "candidates_accepted": result.candidates_accepted,
    }


def build_implementation_evidence(package_root: str | Path) -> dict[str, object]:
    root = Path(package_root)
    raw_root = root / "data" / "raw"
    compiled_root = root / "data" / "compiled_engine_v2_0"
    compiler = EngineAssetCompiler()
    compiled = compiler.compile(
        raw_root / "synthetic_engine_map_v2_0.csv",
        raw_root / "synthetic_engine_map_v2_0.metadata.json",
        compiled_root,
    )
    verified = verify_compiled_engine_bundle(compiled_root)
    model = EngineModel(verified.asset)
    vehicle_config = make_reference_vehicle_config()
    gearbox_asset = make_reference_gearbox_asset()
    _write_json(root / "data" / "compiled_vehicle_config_v2_0.json", vehicle_config)
    _write_json(root / "data" / "compiled_gearbox_asset_v2_0.json", gearbox_asset.canonical_payload())

    scenarios = {
        "locked_high_grip": _single_step_scenario(
            model,
            tire_mu=1.5,
            clutch_capacity_nm=900.0,
            engine_rpm=3900.0,
            speed_m_s=15.0,
            throttle=0.55,
        ),
        "finite_clutch_slip": _single_step_scenario(
            model,
            tire_mu=1.5,
            clutch_capacity_nm=18.0,
            engine_rpm=3600.0,
            speed_m_s=10.0,
            throttle=0.70,
        ),
        "finite_tire_slip": _single_step_scenario(
            model,
            tire_mu=0.055,
            clutch_capacity_nm=900.0,
            engine_rpm=2100.0,
            speed_m_s=8.0,
            throttle=1.0,
        ),
    }

    initial_vehicle = make_consistent_state(
        8.0,
        vehicle_config,
        EngineState(0.0, EngineMode.RUNNING, 0.35),
        mapping=gearbox_asset.mapping_for("1"),
    )
    system = PowertrainVehicleSystem(
        model,
        gearbox_asset,
        vehicle_config,
        PowertrainVehicleState(initial_vehicle, GearboxState("1")),
    )
    shift_rows: list[dict[str, object]] = []
    for _ in range(6):
        step = system.step(
            EngineCommand(0.4), GearboxCommand("2"), (0.0, 0.0), 0.02
        )
        shift_rows.append(
            {
                "effective_gear": step.gearbox_trial.effective_gear,
                "phase_after": step.state.gearbox.phase.value,
                "average_clutch_engagement": step.gearbox_trial.average_clutch_engagement,
                "engine_rpm": step.state.vehicle.engine.rpm,
                "clutch_mode": step.vehicle_step.clutch_mode.value,
                "clutch_relative_speed_rad_s": step.vehicle_step.clutch_relative_speed_rad_s,
            }
        )
    scenarios["one_to_two_shift"] = {
        "steps": shift_rows,
        "final_gear": system.state.gearbox.selected_gear,
        "final_phase": system.state.gearbox.phase.value,
    }

    module_files = (
        "engine_model.py",
        "coupled_vehicle_solver.py",
        "powertrain_controller.py",
        "asset_pipeline.py",
        "timeseries_pipeline.py",
        "host_integration.py",
        "reference_assets.py",
    )
    payload: dict[str, object] = {
        "schema": MODULE_SCHEMA,
        "scope": "Engine + clutch/gear mapping + wheel + tire + chassis active-set integration and calibration data pipeline",
        "target_vehicle_status": "NOT_VALIDATED_NO_TARGET_GAME_OR_MEASURED_DATA",
        "synthetic_fixture_notice": "All bundled numeric assets are structural synthetic fixtures.",
        "solver_contract": {
            "unknowns": [
                "engine angular speed",
                "wheel angular speeds",
                "chassis longitudinal speed",
                "clutch impulse",
                "tire longitudinal impulses",
                "unilateral crank-stop impulse",
            ],
            "active_sets": {
                "clutch": ["NEUTRAL", "LOCKED", "SLIDING_POSITIVE", "SLIDING_NEGATIVE"],
                "tire": ["ADHERING", "SLIDING_POSITIVE", "SLIDING_NEGATIVE"],
                "engine_lower_bound": ["FREE", "STOPPED"],
            },
            "acceptance": [
                "all impulse rows close",
                "capacity inequalities hold",
                "complementarity signs hold",
                "constraint work is non-positive",
                "normal loads stay positive",
                "engine remains inside declared hard domain",
            ],
            "integration": "Backward Euler with frozen controller trials and exactly-once commit/abort",
        },
        "compiled_assets": {
            "engine_asset_content_hash": compiled.asset.content_hash(),
            "source_bundle_hash": compiled.source_bundle_hash,
            "compiler_hash": compiled.compiler_hash,
            "verified_files": list(verified.verified_files),
            "engine_directory": "data/compiled_engine_v2_0",
            "vehicle_config": "data/compiled_vehicle_config_v2_0.json",
            "gearbox_asset": "data/compiled_gearbox_asset_v2_0.json",
        },
        "module_file_hashes": {
            filename: _sha256(root / filename) for filename in module_files
        },
        "scenarios": scenarios,
        "primary_research_basis": [
            {
                "name": "NVIDIA PhysX Vehicles",
                "url": "https://nvidia-omniverse.github.io/PhysX/physx/5.6.1/docs/Vehicles.html",
                "applied": "engine/wheel rotational DOFs coupled bidirectionally through clutch, gear and differential mapping",
            },
            {
                "name": "Jolt WheeledVehicleController",
                "url": "https://github.com/jrouwe/JoltPhysics/blob/master/Jolt/Physics/Vehicle/WheeledVehicleController.cpp",
                "applied": "implicit integration for the stiff engine-clutch-wheel system and inclusion of wheel reaction torques",
            },
            {
                "name": "Project Chrono powertrain demo",
                "url": "https://github.com/projectchrono/chrono/blob/main/src/demos/core/demo_CH_powertrain.cpp",
                "applied": "finite maximum clutch torque with modulation and shaft-inertia coupling",
            },
        ],
    }
    _write_json(root / "results" / "active_set_module_audit_v2_0.json", payload)
    return payload

