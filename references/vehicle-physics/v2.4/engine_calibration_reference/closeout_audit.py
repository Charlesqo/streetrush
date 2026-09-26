"""Build the executable v2.0 Engine + Calibration close-out ledger."""

from __future__ import annotations

from dataclasses import asdict, dataclass, replace
import hashlib
import math
from pathlib import Path
import platform
from typing import Any

import numpy as np

from .calibration import (
    DataSplit,
    DatasetRegistry,
    GateResult,
    ParameterRegistry,
    ParameterStatus,
    PhenomenonAuthorityRegistry,
    RegressionTier,
    ReleaseDecision,
    RunManifest,
    analyze_identifiability,
    evaluate_release,
    finite_difference_sensitivity,
    metric_gate,
    missing_fixture_gate,
)
from .calibration_fixtures import (
    SyntheticLongitudinalData,
    build_dataset_manifests,
    build_parameter_passports,
    canonical_sha256,
    coast_acceleration_mps2,
    fit_staged_longitudinal,
    make_synthetic_longitudinal_data,
    normalized_rmse,
    wot_acceleration_mps2,
    wot_cross_owner_prediction,
)
from .engine_model import (
    DomainError,
    EngineAsset,
    EngineCommand,
    EngineMode,
    EngineModel,
    EngineOwner,
    EngineState,
    rpm_to_rad_s,
)
from .rigs import (
    ClutchSolveMode,
    CoupledDrivetrainConfig,
    CoupledDrivetrainState,
    solve_coupled_drivetrain_substep,
)
from .whole_vehicle_fixture import WholeVehicleConfig, simulate_whole_vehicle


@dataclass(frozen=True)
class CloseoutEvidence:
    gates: tuple[GateResult, ...]
    run_manifest: RunManifest
    release_decision: ReleaseDecision
    datasets: tuple[Any, ...]
    passports: tuple[Any, ...]
    numerical: dict[str, object]


def sha256_source_tree(package_root: str | Path) -> str:
    root = Path(package_root)
    digest = hashlib.sha256()
    for path in sorted(root.rglob("*.py")):
        relative = path.relative_to(root).as_posix().encode("utf-8")
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        content = path.read_bytes()
        digest.update(len(content).to_bytes(8, "big"))
        digest.update(content)
    return digest.hexdigest()


def _status_gate(
    case_id: str,
    ok: bool,
    message: str,
    tier: RegressionTier,
    reason_code: str = "",
    evidence: dict[str, float | str | list[float]] | None = None,
) -> GateResult:
    return metric_gate(
        case_id,
        0.0 if ok else 1.0,
        0.0,
        message=message,
        tier=tier,
        reason_code=reason_code,
        evidence=evidence,
    )


def _coupled_drivetrain_evidence(
    model: EngineModel, capacity_nm: float, wheel_scale: float
) -> tuple[object, float]:
    state = EngineState(rpm_to_rad_s(2000.0), EngineMode.RUNNING, 0.5)
    owner = EngineOwner(model, state)
    dt = 1.0 / 120.0
    ticket = owner.begin_substep(EngineCommand(0.5), dt)
    wheels = (state.omega_rad_s / 9.0 * wheel_scale,) * 2
    result = solve_coupled_drivetrain_substep(
        owner,
        ticket,
        CoupledDrivetrainState(state.omega_rad_s, wheels),
        CoupledDrivetrainConfig((1.2, 1.2), (4.5, 4.5), capacity_nm),
        (0.0, 0.0),
        dt,
    )
    row_error = max(
        abs(result.engine_row_residual_nms),
        *(abs(value) for value in result.wheel_row_residual_nms),
    )
    return result, float(row_error)


def _engine_refinement(model: EngineModel) -> dict[str, object]:
    finals: dict[int, float] = {}
    max_residuals: dict[int, float] = {}
    for hz in (60, 120, 240, 1920):
        state = EngineState(rpm_to_rad_s(1200.0), EngineMode.RUNNING, 1.0)
        maximum = 0.0
        for _ in range(int(0.25 * hz)):
            result = model.integrate_standalone(state, EngineCommand(1.0), 0.0, 1.0 / hz)
            state = result.state
            maximum = max(maximum, result.nonlinear_residual_nms)
        finals[hz] = state.rpm
        max_residuals[hz] = maximum
    reference = finals[1920]
    errors = {hz: abs(finals[hz] - reference) for hz in (60, 120, 240)}
    return {
        "reference_hz": 1920,
        "final_rpm": {str(key): value for key, value in finals.items()},
        "error_vs_reference_rpm": {str(key): value for key, value in errors.items()},
        "max_inner_residual_nms": {str(key): value for key, value in max_residuals.items()},
        "e240_over_e120": errors[240] / errors[120],
    }


def _whole_vehicle_evidence(model: EngineModel) -> dict[str, object]:
    config = WholeVehicleConfig()
    traces = {
        hz: simulate_whole_vehicle(model, config, 5.0, 0.5, 1.0 / hz)
        for hz in (60, 120, 240, 960)
    }
    final_speed = {hz: float(trace.speed_m_s[-1]) for hz, trace in traces.items()}
    reference = final_speed[960]
    errors = {hz: abs(final_speed[hz] - reference) for hz in (60, 120, 240)}
    primary = traces[120]
    return {
        "reference_hz": 960,
        "final_speed_mps": {str(key): value for key, value in final_speed.items()},
        "error_vs_reference_mps": {str(key): value for key, value in errors.items()},
        "e240_over_e120": errors[240] / errors[120],
        "initial_speed_mps": float(primary.speed_m_s[0]),
        "final_speed_120hz_mps": float(primary.speed_m_s[-1]),
        "final_engine_rpm_120hz": float(primary.engine_rpm[-1]),
        "max_engine_row_residual_nms": primary.max_engine_residual_nms,
        "max_wheel_row_residual_nms": primary.max_wheel_residual_nms,
        "max_chassis_row_residual_n_s": primary.max_chassis_residual_n_s,
        "max_load_path_force_error_n": primary.max_load_path_force_error_n,
        "max_load_path_moment_error_n_m": primary.max_load_path_moment_error_n_m,
        "non_domain_status_count": sum(status != "IN_DOMAIN" for status in primary.statuses),
    }


def _longitudinal_evidence(data: SyntheticLongitudinalData) -> dict[str, object]:
    fit = fit_staged_longitudinal(data)
    coast_rmse = normalized_rmse(
        coast_acceleration_mps2(data.coast_speed_mps, fit),
        data.coast_accel_mps2,
        data.accel_noise_sigma_mps2 * 0.6,
    )
    calibration_rmse = normalized_rmse(
        wot_acceleration_mps2(data.wot_speed_mps, fit),
        data.wot_accel_mps2,
        data.accel_noise_sigma_mps2,
    )
    holdout_rmse = normalized_rmse(
        wot_acceleration_mps2(data.holdout_speed_mps, fit),
        data.holdout_accel_mps2,
        data.accel_noise_sigma_mps2,
    )
    truth = data.truth
    jacobian = finite_difference_sensitivity(
        lambda p: wot_cross_owner_prediction(data.wot_speed_mps, p, truth),
        (truth.mass_kg, 1.0, 1.0),
        parameter_scales=(truth.mass_kg, 1.0, 1.0),
        output_sigma=data.accel_noise_sigma_mps2,
    )
    identifiability = analyze_identifiability(jacobian)
    condition: float | str = identifiability.condition_number
    if not math.isfinite(float(identifiability.condition_number)):
        condition = "INFINITY"
    return {
        "truth": asdict(truth),
        "staged_fit": asdict(fit),
        "normalized_rmse": {
            "coast_calibration": coast_rmse,
            "wot_calibration": calibration_rmse,
            "wot_holdout": holdout_rmse,
        },
        "wot_only_identifiability": {
            "rank": identifiability.rank,
            "parameter_count": identifiability.parameter_count,
            "condition_number": condition,
            "singular_values": list(identifiability.singular_values),
            "right_singular_vectors": [list(row) for row in identifiability.right_singular_vectors],
            "verdict": identifiability.verdict,
        },
    }


def build_closeout_evidence(package_root: str | Path | None = None) -> CloseoutEvidence:
    root = Path(package_root) if package_root is not None else Path(__file__).resolve().parent
    asset = EngineAsset.from_json(root / "data" / "synthetic_engine_asset.json")
    model = EngineModel(asset)
    data = make_synthetic_longitudinal_data()
    datasets = build_dataset_manifests(root, data)
    source_hash = sha256_source_tree(root)
    passports = build_parameter_passports(datasets, source_hash)
    gates: list[GateResult] = []

    dataset_registry = DatasetRegistry()
    dataset_ok = True
    dataset_message = "all dataset manifests validate and register once"
    try:
        for dataset in datasets:
            dataset_registry.register(dataset)
    except Exception as exc:  # converted to an explicit release gate
        dataset_ok = False
        dataset_message = f"dataset registry rejected close-out fixture: {exc}"
    gates.append(_status_gate("L0_DATASET_MANIFESTS", dataset_ok, dataset_message, RegressionTier.L0_CONFIG))

    split_rejected = False
    try:
        dataset_registry.register(
            replace(
                datasets[1],
                dataset_id="illegal_relabelled_holdout",
                split=DataSplit.HOLDOUT,
            )
        )
    except ValueError:
        split_rejected = True
    gates.append(
        _status_gate(
            "L0_DATA_SPLIT_ISOLATION",
            split_rejected,
            "same hash/lineage cannot be relabelled across calibration and holdout",
            RegressionTier.L0_CONFIG,
        )
    )

    parameter_registry = ParameterRegistry()
    passport_ok = True
    passport_message = "all provisional synthetic parameter passports are complete and uniquely owned"
    try:
        for passport in passports:
            parameter_registry.register(passport)
    except Exception as exc:
        passport_ok = False
        passport_message = f"parameter registry rejected close-out fixture: {exc}"
    gates.append(_status_gate("L0_PARAMETER_PASSPORTS", passport_ok, passport_message, RegressionTier.L0_CONFIG))

    false_validation_rejected = False
    try:
        replace(passports[0], status=ParameterStatus.VALIDATED).validate()
    except ValueError:
        false_validation_rejected = True
    gates.append(
        _status_gate(
            "L0_SYNTHETIC_NOT_VALIDATED",
            false_validation_rejected,
            "synthetic/estimated/gameplay provenance cannot be promoted to VALIDATED",
            RegressionTier.L0_CONFIG,
        )
    )

    authority = PhenomenonAuthorityRegistry()
    authority.claim("aerodynamic_drag", "Aerodynamics", "reference-point 6D wrench")
    authority.claim("rolling_mechanical_loss", "Road-load residual", "non-aero longitudinal loss")
    duplicate_authority_rejected = False
    try:
        authority.claim("aerodynamic_drag", "Road-load residual", "aggregate quadratic drag")
    except ValueError:
        duplicate_authority_rejected = True
    gates.append(
        _status_gate(
            "L0_PHENOMENON_SINGLE_OWNER",
            duplicate_authority_rejected,
            "aerodynamic drag cannot be simultaneously owned by Aero and aggregate road load",
            RegressionTier.L0_CONFIG,
        )
    )

    tangent_errors: list[float] = []
    for rpm in (775.0, 1575.0, 3125.0, 5125.0, 6875.0):
        omega = rpm_to_rad_s(rpm)
        _, tangent = asset.full_curve.sample_omega(omega)
        h = 1e-4
        finite = (
            asset.full_curve.sample_omega(omega + h)[0]
            - asset.full_curve.sample_omega(omega - h)[0]
        ) / (2.0 * h)
        tangent_errors.append(abs(tangent - finite))
    gates.append(
        metric_gate(
            "L1_PCHIP_ANALYTIC_TANGENT",
            max(tangent_errors),
            2e-6,
            message="analytic dT/domega agrees with centered finite difference",
            tier=RegressionTier.L1_INVARIANT,
            evidence={"errors": tangent_errors},
        )
    )

    closed_torque, _ = asset.net_torque(0.0, rpm_to_rad_s(3500.0))
    gates.append(
        metric_gate(
            "L1_SIGNED_NET_TORQUE_SEMANTICS",
            abs(closed_torque - (-72.0)),
            1e-10,
            message="zero-command branch is signed net crank torque with no second loss subtraction",
            tier=RegressionTier.L1_INVARIANT,
            evidence={"closed_torque_nm": closed_torque, "asset_hash": asset.content_hash()},
        )
    )

    domain_rejected = False
    try:
        asset.net_torque(1.0, rpm_to_rad_s(asset.hard_overspeed_rpm + 1.0))
    except DomainError:
        domain_rejected = True
    gates.append(
        _status_gate(
            "L1_ENGINE_DOMAIN_REJECT",
            domain_rejected,
            "engine map/domain overflow is explicit rather than silently extrapolated",
            RegressionTier.L1_INVARIANT,
        )
    )

    owner_state = EngineState(rpm_to_rad_s(2200.0), EngineMode.RUNNING, 0.2)
    owner = EngineOwner(model, owner_state)
    ticket = owner.begin_substep(EngineCommand(0.8), 1.0 / 120.0)
    sample_a = owner.evaluate(ticket, rpm_to_rad_s(2100.0))
    sample_b = owner.evaluate(ticket, rpm_to_rad_s(2500.0))
    still_unmutated = owner.state == owner_state
    owner.commit(ticket, rpm_to_rad_s(2350.0))
    duplicate_commit_rejected = False
    try:
        owner.commit(ticket, rpm_to_rad_s(2400.0))
    except RuntimeError:
        duplicate_commit_rejected = True
    gates.append(
        _status_gate(
            "L1_ENGINE_TRIAL_COMMIT_OWNERSHIP",
            still_unmutated and duplicate_commit_rejected and sample_a.free_torque_nm != sample_b.free_torque_nm,
            "frozen controller trial supports repeated predicted-speed evaluation and exactly one commit",
            RegressionTier.L1_INVARIANT,
        )
    )

    engine_refinement = _engine_refinement(model)
    max_engine_residual = max(engine_refinement["max_inner_residual_nms"].values())
    gates.append(
        metric_gate(
            "L2_ENGINE_BACKWARD_EULER_RESIDUAL",
            float(max_engine_residual),
            1e-8,
            message="scalar Engine row closes at all refinement rates",
            tier=RegressionTier.L2_COMPONENT,
        )
    )
    gates.append(
        metric_gate(
            "L2_ENGINE_TIMESTEP_REFINEMENT",
            float(engine_refinement["e240_over_e120"]),
            0.75,
            message="240 Hz error decreases relative to 120 Hz against 1920 Hz reference",
            tier=RegressionTier.L2_COMPONENT,
            evidence={"ratio": float(engine_refinement["e240_over_e120"])},
        )
    )

    inertia = 0.32
    omega0 = rpm_to_rad_s(8180.0)
    torque = 500.0
    dt = 1.0 / 60.0
    clamped = min(omega0 + torque * dt / inertia, rpm_to_rad_s(8200.0))
    impulse_error = abs(inertia * (clamped - omega0) - torque * dt)
    gates.append(
        metric_gate(
            "NEGATIVE_CONTROL_POST_STEP_RPM_CLAMP",
            impulse_error,
            1e-9,
            expected_failure=True,
            message="rejected RPM teleport loses angular impulse",
            tier=RegressionTier.L2_COMPONENT,
            reason_code="REJECTED_NONCONSERVATIVE_STATE_CLAMP",
            evidence={"angular_impulse_error_nms": impulse_error},
        )
    )

    longitudinal = _longitudinal_evidence(data)
    ident = longitudinal["wot_only_identifiability"]
    rank_deficit = int(ident["parameter_count"]) - int(ident["rank"])
    gates.append(
        metric_gate(
            "NEGATIVE_CONTROL_WOT_CROSS_OWNER_IDENTIFIABLE",
            float(rank_deficit),
            0.0,
            expected_failure=True,
            message="WOT-only mass/drive/road scaling has a rank-deficient parameter direction",
            tier=RegressionTier.L2_COMPONENT,
            reason_code="STRUCTURAL_NON_IDENTIFIABILITY",
            evidence={"rank": float(ident["rank"]), "parameter_count": float(ident["parameter_count"]), "condition_number": str(ident["condition_number"])},
        )
    )
    rmse = longitudinal["normalized_rmse"]
    gates.append(
        metric_gate(
            "L2_STAGED_COAST_CALIBRATION",
            float(rmse["coast_calibration"]),
            1.3,
            dataset_ids=("synthetic_coastdown_cal_v2_0",),
            message="mass is fixed, then road load is identified on the isolated coast fixture",
            tier=RegressionTier.L2_COMPONENT,
        )
    )
    gates.append(
        metric_gate(
            "L2_STAGED_WOT_CALIBRATION",
            float(rmse["wot_calibration"]),
            1.3,
            dataset_ids=("synthetic_wot_cal_v2_0",),
            message="drive-force scale is identified only after mass and road-load ownership freeze",
            tier=RegressionTier.L2_COMPONENT,
        )
    )

    locked, locked_error = _coupled_drivetrain_evidence(model, 1000.0, 1.0)
    gates.append(
        metric_gate(
            "L3_ENGINE_CLUTCH_WHEEL_LOCKED_ROWS",
            locked_error,
            1e-9,
            message="Engine, finite-capacity clutch mapping, and two wheel inertia rows solve together",
            tier=RegressionTier.L3_COUPLED_SYNTHETIC,
            evidence={"mode": locked.clutch_mode.value, "relative_speed_rad_s": abs(locked.clutch_relative_speed_rad_s)},
        )
    )
    slipping, slipping_error = _coupled_drivetrain_evidence(model, 15.0, 0.7)
    slip_capacity_error = abs(abs(slipping.clutch_reaction_on_engine_nm) - 15.0)
    gates.append(
        metric_gate(
            "L3_ENGINE_CLUTCH_SLIP_CAPACITY",
            max(slipping_error, slip_capacity_error),
            1e-8,
            message="accepted active set slips at declared clutch capacity without rewriting shaft states",
            tier=RegressionTier.L3_COUPLED_SYNTHETIC,
            evidence={"mode": slipping.clutch_mode.value, "relative_speed_rad_s": abs(slipping.clutch_relative_speed_rad_s)},
        )
    )

    whole_vehicle = _whole_vehicle_evidence(model)
    whole_row_error = max(
        float(whole_vehicle["max_engine_row_residual_nms"]),
        float(whole_vehicle["max_wheel_row_residual_nms"]),
        float(whole_vehicle["max_chassis_row_residual_n_s"]),
        float(whole_vehicle["max_load_path_force_error_n"]),
        float(whole_vehicle["max_load_path_moment_error_n_m"]),
    )
    gates.append(
        metric_gate(
            "L3_WHOLE_VEHICLE_CROSS_SYSTEM_ROWS",
            whole_row_error,
            1e-7,
            message="locked Engine/clutch/wheels/tire-capacity/aero/suspension-load-path/chassis fixture closes",
            tier=RegressionTier.L3_COUPLED_SYNTHETIC,
            evidence={"max_row_or_reconstruction_error": whole_row_error},
        )
    )
    gates.append(
        metric_gate(
            "L3_WHOLE_VEHICLE_DOMAIN_STATUS",
            float(whole_vehicle["non_domain_status_count"]),
            0.0,
            message="whole-vehicle structural run remains inside declared clutch/tire/map capacity domain",
            tier=RegressionTier.L3_COUPLED_SYNTHETIC,
        )
    )
    gates.append(
        metric_gate(
            "L3_WHOLE_VEHICLE_TIMESTEP_REFINEMENT",
            float(whole_vehicle["e240_over_e120"]),
            0.75,
            message="whole-vehicle final-speed error decreases with timestep refinement",
            tier=RegressionTier.L3_COUPLED_SYNTHETIC,
        )
    )

    # This is intentionally a real validation FAIL, not an xfail and not a
    # passing test that hides the failed metric.  The test harness passes only
    # when the ledger faithfully retains this failure.
    gates.append(
        metric_gate(
            "L5_SYNTHETIC_SHAPE_HOLDOUT",
            float(rmse["wot_holdout"]),
            1.3,
            dataset_ids=("synthetic_wot_holdout_v2_0",),
            message="held-out >35 m/s drive-force shape mismatch exceeds the frozen uncertainty gate",
            tier=RegressionTier.L5_SCENARIO,
            reason_code="DETECTED_MODEL_FORM_ERROR",
            evidence={"normalized_rmse": float(rmse["wot_holdout"])},
        )
    )

    gates.extend(
        (
            missing_fixture_gate(
                "L4_TARGET_ENGINE_LOW_SPEED_START_STALL",
                ("target_low_speed_combustion_starter_stall_dyno",),
                "target low-speed combustion/starter/stall measurements are unavailable",
                "instrumented starter/cranking/idle/stall dynamometer campaign with declared conditions",
                "physical start/stall fidelity remains provisional; structural controller/solver only",
            ),
            missing_fixture_gate(
                "L4_TARGET_ENGINE_NET_TORQUE_MAP",
                ("target_conditioned_net_crank_torque_map",),
                "target conditioned engine dyno map is unavailable",
                "obtain as-installed net torque data with accessory, fuel, ambient, correction and uncertainty records",
                "absolute target engine torque and part-throttle fidelity are not validated",
            ),
            missing_fixture_gate(
                "L4_TARGET_ROAD_LOAD",
                ("target_SAE_J2263_road_load_dataset",),
                "target coastdown/onboard-anemometry road-load dataset is unavailable",
                "run controlled dry-level-road coastdown/anemometry campaign and retain environment/vehicle conditions",
                "target rolling/mechanical-loss separation and total road load are not validated",
            ),
            missing_fixture_gate(
                "L4_TARGET_LATERAL_TRANSIENT",
                ("target_ISO_7401_or_ISO_22140_dataset",),
                "target standardized lateral transient measurements are unavailable",
                "acquire open-loop steering input and synchronized yaw/lateral/roll/steer channels with uncertainties",
                "whole-vehicle target lateral dynamics validation is unavailable",
            ),
            missing_fixture_gate(
                "L4_TARGET_TIRE_FLAT_TRACK",
                ("target_TIR_or_Flat_Track_dataset",),
                "target tire force/moment fixture remains unavailable",
                "obtain conditioned tire force/moment sweeps with pressure, temperature, load and surface metadata",
                "target tire constitutive fidelity remains provisional",
            ),
            missing_fixture_gate(
                "L4_TARGET_KC_AND_AEROMAP",
                ("target_KC_dataset", "target_aeromap_dataset"),
                "target suspension K&C and aerodynamic map fixtures are unavailable",
                "obtain hardpoint/K&C rig evidence and wind-tunnel/CFD map with shared coordinate/reference conventions",
                "target load path and aero-platform coupling are not validated",
            ),
        )
    )

    config_hash = canonical_sha256(
        {"engine_asset": asset.canonical_payload(), "whole_vehicle_config": asdict(WholeVehicleConfig())}
    )
    run_manifest = RunManifest(
        run_id="v2.0-executable-closeout-2026-08-27",
        baseline_version="v2.0",
        config_hash=config_hash,
        code_hash=source_hash,
        dataset_hashes={dataset.dataset_id: dataset.source_hash for dataset in datasets},
        deterministic_seed=7,
        runtime=f"Python {platform.python_version()}; NumPy {np.__version__}; {platform.platform()}",
        command="python -m engine_calibration_reference.run_v2_0_reference_audit",
    )
    release = evaluate_release(gates, run_manifest)
    numerical = {
        "engine_refinement": engine_refinement,
        "longitudinal_calibration": longitudinal,
        "coupled_drivetrain": {
            "locked": {
                "mode": locked.clutch_mode.value,
                "max_row_residual_nms": locked_error,
                "relative_speed_rad_s": locked.clutch_relative_speed_rad_s,
            },
            "slipping": {
                "mode": slipping.clutch_mode.value,
                "max_row_residual_nms": slipping_error,
                "clutch_reaction_on_engine_nm": slipping.clutch_reaction_on_engine_nm,
                "relative_speed_rad_s": slipping.clutch_relative_speed_rad_s,
            },
        },
        "whole_vehicle": whole_vehicle,
    }
    return CloseoutEvidence(tuple(gates), run_manifest, release, datasets, passports, numerical)
