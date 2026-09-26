"""Deterministic calibration fixtures and provenance records for v2.0.

The numeric values in this module are synthetic structural test data.  They
exercise identifiability, split isolation, parameter ownership, and held-out
validation without claiming fidelity to a target vehicle.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
from pathlib import Path
from typing import Mapping

import numpy as np

from .calibration import (
    CalibrationStage,
    DataSplit,
    DatasetManifest,
    ParameterPassport,
    ParameterStatus,
    SourceKind,
)


@dataclass(frozen=True)
class LongitudinalTruth:
    mass_kg: float = 1420.0
    road_a_n: float = 145.0
    road_b_n_per_mps: float = 1.8
    road_c_n_per_mps2: float = 0.315
    drive_force_scale: float = 1.0


@dataclass(frozen=True)
class StagedLongitudinalFit:
    mass_kg: float
    road_a_n: float
    road_b_n_per_mps: float
    road_c_n_per_mps2: float
    drive_force_scale: float


@dataclass(frozen=True)
class SyntheticLongitudinalData:
    truth: LongitudinalTruth
    coast_speed_mps: np.ndarray
    coast_accel_mps2: np.ndarray
    wot_speed_mps: np.ndarray
    wot_accel_mps2: np.ndarray
    holdout_speed_mps: np.ndarray
    holdout_accel_mps2: np.ndarray
    accel_noise_sigma_mps2: float


def canonical_sha256(payload: object) -> str:
    encoded = json.dumps(
        payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def road_load_n(speed_mps: np.ndarray, p: LongitudinalTruth | StagedLongitudinalFit) -> np.ndarray:
    v = np.asarray(speed_mps, dtype=float)
    return p.road_a_n + p.road_b_n_per_mps * v + p.road_c_n_per_mps2 * v**2


def nominal_drive_force_n(speed_mps: np.ndarray) -> np.ndarray:
    """Smooth fixed-gear surrogate; not a second runtime drivetrain model."""
    v = np.asarray(speed_mps, dtype=float)
    return 6000.0 - 22.0 * (v - 18.0) - 1.15 * (v - 18.0) ** 2


def coast_acceleration_mps2(
    speed_mps: np.ndarray, p: LongitudinalTruth | StagedLongitudinalFit
) -> np.ndarray:
    return -road_load_n(speed_mps, p) / p.mass_kg


def wot_acceleration_mps2(
    speed_mps: np.ndarray, p: LongitudinalTruth | StagedLongitudinalFit
) -> np.ndarray:
    return (
        p.drive_force_scale * nominal_drive_force_n(speed_mps) - road_load_n(speed_mps, p)
    ) / p.mass_kg


def normalized_rmse(prediction: np.ndarray, observation: np.ndarray, sigma: float) -> float:
    delta = (np.asarray(prediction) - np.asarray(observation)) / float(sigma)
    return float(np.sqrt(np.mean(delta**2)))


def make_synthetic_longitudinal_data(
    seed: int = 7, accel_noise_sigma_mps2: float = 0.012
) -> SyntheticLongitudinalData:
    rng = np.random.default_rng(seed)
    truth = LongitudinalTruth()
    coast_v = np.linspace(12.0, 45.0, 100)
    wot_v = np.linspace(8.0, 42.0, 120)
    holdout_v = np.linspace(10.0, 46.0, 90)
    coast_a = coast_acceleration_mps2(coast_v, truth) + rng.normal(
        0.0, accel_noise_sigma_mps2 * 0.6, coast_v.shape
    )
    wot_a = wot_acceleration_mps2(wot_v, truth) + rng.normal(
        0.0, accel_noise_sigma_mps2, wot_v.shape
    )
    holdout_rng = np.random.default_rng(seed + 100)
    # Deliberate uncalibrated shape change.  It is a validation failure by
    # construction and remains a real FAIL in the result ledger.
    force_shape = np.where(holdout_v > 35.0, 0.985, 1.0)
    holdout_a = (
        nominal_drive_force_n(holdout_v) * force_shape - road_load_n(holdout_v, truth)
    ) / truth.mass_kg
    holdout_a += holdout_rng.normal(0.0, accel_noise_sigma_mps2, holdout_v.shape)
    return SyntheticLongitudinalData(
        truth,
        coast_v,
        coast_a,
        wot_v,
        wot_a,
        holdout_v,
        holdout_a,
        accel_noise_sigma_mps2,
    )


def fit_staged_longitudinal(data: SyntheticLongitudinalData) -> StagedLongitudinalFit:
    """Fit measured mass -> coast road load -> WOT drive scale in stages."""
    mass = data.truth.mass_kg  # direct synthetic measurement for this fixture
    design = np.column_stack(
        (np.ones_like(data.coast_speed_mps), data.coast_speed_mps, data.coast_speed_mps**2)
    )
    road_a, road_b, road_c = np.linalg.lstsq(
        design, -mass * data.coast_accel_mps2, rcond=None
    )[0]
    road = road_a + road_b * data.wot_speed_mps + road_c * data.wot_speed_mps**2
    drive = nominal_drive_force_n(data.wot_speed_mps)
    target_drive = mass * data.wot_accel_mps2 + road
    scale = float(np.dot(drive, target_drive) / np.dot(drive, drive))
    return StagedLongitudinalFit(
        mass,
        float(road_a),
        float(road_b),
        float(road_c),
        scale,
    )


def wot_cross_owner_prediction(
    speeds_mps: np.ndarray, parameters: np.ndarray, truth: LongitudinalTruth
) -> np.ndarray:
    """Deliberately confounded WOT-only mass/drive/road parameterization."""
    mass_kg, drive_scale, road_scale = map(float, parameters)
    road = road_scale * road_load_n(speeds_mps, truth)
    drive = drive_scale * nominal_drive_force_n(speeds_mps)
    return (drive - road) / mass_kg


def _array_payload(values: np.ndarray) -> list[float]:
    return [float(value) for value in np.asarray(values).reshape(-1)]


def build_dataset_manifests(
    package_root: str | Path, data: SyntheticLongitudinalData
) -> tuple[DatasetManifest, ...]:
    root = Path(package_root)
    engine_asset = root / "data" / "synthetic_engine_asset.json"
    engine_hash = DatasetManifest.sha256_file(engine_asset)
    code_hash = DatasetManifest.sha256_file(Path(__file__))
    coast_hash = canonical_sha256(
        {"speed_mps": _array_payload(data.coast_speed_mps), "accel_mps2": _array_payload(data.coast_accel_mps2)}
    )
    wot_hash = canonical_sha256(
        {"speed_mps": _array_payload(data.wot_speed_mps), "accel_mps2": _array_payload(data.wot_accel_mps2)}
    )
    holdout_hash = canonical_sha256(
        {"speed_mps": _array_payload(data.holdout_speed_mps), "accel_mps2": _array_payload(data.holdout_accel_mps2)}
    )
    config_hash = canonical_sha256(
        {
            "mass_kg": 1420.0,
            "wheel_radius_m": 0.33,
            "total_ratio": 9.0,
            "cd_area_m2": 0.68,
            "tire_mu": 1.8,
        }
    )
    common_environment: Mapping[str, float | str] = {
        "air_temperature_c": 20.0,
        "air_pressure_kpa": 101.325,
        "road": "synthetic_dry_level",
    }
    return (
        DatasetManifest(
            dataset_id="synthetic_engine_map_v2_0",
            source_uri="artifact://engine_calibration_reference/data/synthetic_engine_asset.json",
            source_hash=engine_hash,
            source_kind=SourceKind.SYNTHETIC.value,
            split=DataSplit.CALIBRATION,
            signals_units={"rpm": "rpm", "closed_torque": "N*m", "full_torque": "N*m"},
            frame_convention="positive crank torque accelerates positive engine omega",
            timebase="STATIC_RPM_AXIS",
            environment={"fixture": "synthetic_structure_only"},
            uncertainty_1sigma={"closed_torque": 5.0, "full_torque": 5.0},
            valid_domain={"rpm": (0.0, 7500.0), "command": (0.0, 1.0)},
            preprocessing=("JSON schema validation", "PCHIP coefficient compilation"),
            fit_code_hash=code_hash,
            processing_code_hash=code_hash,
            synthetic=True,
            lineage_root_id="engine-map-synthetic-lineage-v2",
            channel_semantics={
                "rpm": "crankshaft angular speed display coordinate",
                "closed_torque": "signed net crank torque at zero command",
                "full_torque": "signed net crank torque at full command",
            },
            missing_data_policy="REJECT_RECORD",
        ),
        DatasetManifest(
            dataset_id="synthetic_coastdown_cal_v2_0",
            source_uri="generated://v2.0/coastdown/seed-7",
            source_hash=coast_hash,
            source_kind=SourceKind.SYNTHETIC.value,
            split=DataSplit.CALIBRATION,
            signals_units={"speed": "m/s", "longitudinal_accel": "m/s^2"},
            frame_convention="ISO-like body x forward; acceleration positive forward",
            timebase="ORDERED_SPEED_GRID_NOT_TIME_SERIES",
            environment=common_environment,
            uncertainty_1sigma={"speed": 0.02, "longitudinal_accel": data.accel_noise_sigma_mps2 * 0.6},
            valid_domain={"speed": (12.0, 45.0)},
            preprocessing=("deterministic Gaussian noise seed=7",),
            fit_code_hash=code_hash,
            processing_code_hash=code_hash,
            synthetic=True,
            lineage_root_id="coastdown-cal-synthetic-lineage-v2",
            acquisition_id="synthetic-seed-7-coast",
            channel_semantics={"speed": "ground speed", "longitudinal_accel": "body longitudinal acceleration"},
            missing_data_policy="REJECT_RECORD",
        ),
        DatasetManifest(
            dataset_id="synthetic_wot_cal_v2_0",
            source_uri="generated://v2.0/wot-calibration/seed-7",
            source_hash=wot_hash,
            source_kind=SourceKind.SYNTHETIC.value,
            split=DataSplit.CALIBRATION,
            signals_units={"speed": "m/s", "longitudinal_accel": "m/s^2"},
            frame_convention="ISO-like body x forward; acceleration positive forward",
            timebase="ORDERED_SPEED_GRID_NOT_TIME_SERIES",
            environment=common_environment,
            uncertainty_1sigma={"speed": 0.02, "longitudinal_accel": data.accel_noise_sigma_mps2},
            valid_domain={"speed": (8.0, 42.0)},
            preprocessing=("deterministic Gaussian noise seed=7",),
            fit_code_hash=code_hash,
            processing_code_hash=code_hash,
            synthetic=True,
            lineage_root_id="wot-cal-synthetic-lineage-v2",
            acquisition_id="synthetic-seed-7-wot-cal",
            channel_semantics={"speed": "ground speed", "longitudinal_accel": "body longitudinal acceleration"},
            missing_data_policy="REJECT_RECORD",
        ),
        DatasetManifest(
            dataset_id="synthetic_wot_holdout_v2_0",
            source_uri="generated://v2.0/wot-holdout/seed-107",
            source_hash=holdout_hash,
            source_kind=SourceKind.SYNTHETIC.value,
            split=DataSplit.HOLDOUT,
            signals_units={"speed": "m/s", "longitudinal_accel": "m/s^2"},
            frame_convention="ISO-like body x forward; acceleration positive forward",
            timebase="ORDERED_SPEED_GRID_NOT_TIME_SERIES",
            environment=common_environment,
            uncertainty_1sigma={"speed": 0.02, "longitudinal_accel": data.accel_noise_sigma_mps2},
            valid_domain={"speed": (10.0, 46.0)},
            preprocessing=("deterministic Gaussian noise seed=107", "1.5% drive-shape mismatch above 35 m/s"),
            fit_code_hash=code_hash,
            processing_code_hash=code_hash,
            synthetic=True,
            lineage_root_id="wot-holdout-synthetic-lineage-v2",
            acquisition_id="synthetic-seed-107-wot-holdout",
            channel_semantics={"speed": "ground speed", "longitudinal_accel": "body longitudinal acceleration"},
            missing_data_policy="REJECT_RECORD",
        ),
        DatasetManifest(
            dataset_id="synthetic_whole_vehicle_config_v2_0",
            source_uri="generated://v2.0/whole-vehicle-config",
            source_hash=config_hash,
            source_kind=SourceKind.SYNTHETIC.value,
            split=DataSplit.CALIBRATION,
            signals_units={"mass": "kg", "wheel_radius": "m", "ratio": "1", "cd_area": "m^2", "tire_mu": "1"},
            frame_convention="body x forward, y left, z up; positive wheel spin drives +x",
            timebase="STATIC_CONFIGURATION",
            environment={"fixture": "synthetic_structure_only"},
            uncertainty_1sigma={"mass": 5.0, "wheel_radius": 0.002, "ratio": 0.001, "cd_area": 0.02, "tire_mu": 0.1},
            valid_domain={"speed": (0.0, 25.0)},
            fit_code_hash=code_hash,
            processing_code_hash=code_hash,
            synthetic=True,
            lineage_root_id="whole-vehicle-config-synthetic-lineage-v2",
            channel_semantics={
                "mass": "sprung plus unsprung total mass",
                "wheel_radius": "effective rolling radius in locked fixture",
                "ratio": "signed engine-to-average-driven-wheel speed ratio",
                "cd_area": "aerodynamic drag area",
                "tire_mu": "rear-axle synthetic adhesion coefficient",
            },
            missing_data_policy="REJECT_RECORD",
        ),
    )


def build_parameter_passports(
    manifests: tuple[DatasetManifest, ...], fit_code_hash: str
) -> tuple[ParameterPassport, ...]:
    hashes = {manifest.dataset_id: manifest.source_hash for manifest in manifests}
    engine_id = "synthetic_engine_map_v2_0"
    vehicle_id = "synthetic_whole_vehicle_config_v2_0"

    def passport(
        parameter_id: str,
        owner: str,
        nominal: float,
        bounds: tuple[float, float],
        units: str,
        meaning: str,
        dataset_id: str,
        uncertainty: float,
        domain: Mapping[str, tuple[float, float]],
        dependencies: tuple[str, ...] = (),
    ) -> ParameterPassport:
        return ParameterPassport(
            parameter_id=parameter_id,
            owner_system=owner,
            nominal=nominal,
            bounds=bounds,
            units=units,
            stage=CalibrationStage.FOUNDATIONS,
            asset_version="v2.0-closeout-1",
            physical_meaning=meaning,
            frame_convention="body x forward, y left, z up; positive crank/wheel spin drives +x",
            source_kind=SourceKind.SYNTHETIC,
            source_dataset_id=dataset_id,
            source_hash=hashes[dataset_id],
            fit_code_hash=fit_code_hash,
            valid_domain=domain,
            operating_conditions={"fixture": "synthetic structural audit only"},
            uncertainty_1sigma=uncertainty,
            status=ParameterStatus.PROVISIONAL,
            dependencies=dependencies,
            transforms=(),
            description="Not validated for a target vehicle.",
        )

    return (
        passport("engine.inertia", "Engine", 0.32, (0.1, 0.8), "kg*m^2", "equivalent crank/flywheel inertia", engine_id, 0.05, {"rpm": (0.0, 7500.0)}),
        passport("engine.idle_rpm", "Engine", 950.0, (600.0, 1400.0), "rpm", "idle controller target", engine_id, 50.0, {"rpm": (0.0, 7500.0)}),
        passport("engine.rev_limit_rpm", "Engine", 7000.0, (5000.0, 7400.0), "rpm", "combustion authority cut threshold", engine_id, 50.0, {"rpm": (0.0, 7500.0)}),
        passport("chassis.mass", "Chassis", 1420.0, (1200.0, 1800.0), "kg", "total vehicle mass in longitudinal fixture", vehicle_id, 5.0, {"speed": (0.0, 25.0)}),
        passport("drivetrain.total_ratio", "Drivetrain", 9.0, (2.0, 16.0), "1", "signed engine-to-average-driven-wheel speed ratio", vehicle_id, 0.001, {"speed": (0.0, 25.0)}, ("wheel.effective_radius",)),
        passport("wheel.effective_radius", "Wheel Dynamics", 0.33, (0.25, 0.45), "m", "locked-fixture effective rolling radius", vehicle_id, 0.002, {"speed": (0.0, 25.0)}),
        passport("aero.cd_area", "Aerodynamics", 0.68, (0.3, 1.2), "m^2", "reference-point drag coefficient times area", vehicle_id, 0.02, {"speed": (0.0, 25.0)}),
        passport("tire.adhesion_mu", "Tire", 1.8, (0.2, 2.2), "1", "synthetic rear-axle longitudinal capacity coefficient", vehicle_id, 0.1, {"speed": (0.0, 25.0)}),
        passport("suspension.wheelbase", "Chassis + Suspension", 2.72, (2.2, 3.4), "m", "axle separation for load-path reconstruction", vehicle_id, 0.005, {"speed": (0.0, 25.0)}),
        passport("road_load.rolling_coefficient", "Road-load residual", 0.012, (0.005, 0.03), "1", "non-aerodynamic rolling resistance in synthetic fixture", vehicle_id, 0.002, {"speed": (0.0, 25.0)}, ("chassis.mass",)),
    )


def passports_as_json(passports: tuple[ParameterPassport, ...]) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for item in passports:
        record = asdict(item)
        record["stage"] = item.stage.value
        record["source_kind"] = item.source_kind.value
        record["status"] = item.status.value
        records.append(record)
    return records


def manifests_as_json(manifests: tuple[DatasetManifest, ...]) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    for item in manifests:
        record = asdict(item)
        record["split"] = item.split.value
        records.append(record)
    return records
