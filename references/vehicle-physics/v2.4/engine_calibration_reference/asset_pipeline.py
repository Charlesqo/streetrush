"""Deterministic raw-data -> runtime Engine asset compilation pipeline.

The runtime model must not ingest an unlabeled spreadsheet directly.  This
compiler treats the CSV and its metadata sidecar as an evidence bundle,
validates torque semantics and units, compiles a loadable :class:`EngineAsset`,
and emits provenance records whose hashes can be verified later.

Outputs contain no wall-clock timestamps or absolute machine paths, so the
same input bytes and compiler revision produce byte-identical artifacts.
"""

from __future__ import annotations

import csv
from dataclasses import asdict, dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import tempfile
from typing import Any, Mapping, Sequence

from .calibration import (
    CalibrationStage,
    DataSplit,
    DatasetManifest,
    ParameterPassport,
    ParameterStatus,
    SourceKind,
)
from .engine_model import (
    Curve1D,
    EngineAsset,
    InterpolationPolicy,
    TorqueSemantics,
)


PIPELINE_SCHEMA = "vehicle-engine-asset-compile-v1"


class AssetCompileError(ValueError):
    pass


@dataclass(frozen=True)
class CompiledEngineBundle:
    asset: EngineAsset
    dataset_manifest: DatasetManifest
    parameter_passports: tuple[ParameterPassport, ...]
    source_csv_hash: str
    metadata_hash: str
    source_bundle_hash: str
    compiler_hash: str
    asset_path: Path
    dataset_manifest_path: Path
    parameter_passports_path: Path
    compile_manifest_path: Path


@dataclass(frozen=True)
class VerifiedEngineBundle:
    asset: EngineAsset
    compile_manifest: Mapping[str, Any]
    verified_files: tuple[str, ...]


_SEMANTIC_COLUMNS: Mapping[TorqueSemantics, tuple[str, ...]] = {
    TorqueSemantics.NET_BRAKE_MAP: (
        "rpm",
        "net_full_torque_nm",
        "net_closed_torque_nm",
    ),
    TorqueSemantics.GROSS_COMBUSTION_PLUS_LOSS: (
        "rpm",
        "gross_combustion_torque_nm",
        "loss_torque_nm",
    ),
    TorqueSemantics.FULL_LOAD_ONLY: (
        "rpm",
        "full_load_torque_nm",
    ),
}


_PARAMETER_INFO: Mapping[str, tuple[str, str]] = {
    "inertia_kg_m2": ("kg*m^2", "equivalent crankshaft and flywheel inertia"),
    "idle_rpm": ("rpm", "idle controller target speed"),
    "idle_kp_nm_per_rad_s": ("N*m/(rad/s)", "idle proportional torque gain"),
    "idle_max_torque_nm": ("N*m", "maximum idle controller torque authority"),
    "stall_zero_rpm": ("rpm", "lower boundary of low-speed combustion blend"),
    "stall_detect_rpm": ("rpm", "stall timer speed threshold"),
    "stall_hold_s": ("s", "continuous low-speed time required to declare stall"),
    "fire_rpm": ("rpm", "minimum speed at which cranking may transition to running"),
    "min_crank_s": ("s", "minimum cranking duration before firing"),
    "starter_torque_nm": ("N*m", "starter torque applied while cranking"),
    "rev_limit_rpm": ("rpm", "combustion authority cut threshold"),
    "rev_resume_rpm": ("rpm", "limiter hysteresis resume threshold"),
    "hard_overspeed_rpm": ("rpm", "maximum declared mechanical model domain"),
    "torque_lag_s": ("s", "first-order command-to-load actuator time constant"),
}


def _sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _canonical_json_bytes(payload: object) -> bytes:
    return (
        json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    ).encode("utf-8")


def _pretty_json_bytes(payload: object) -> bytes:
    return (
        json.dumps(payload, sort_keys=True, indent=2, ensure_ascii=False) + "\n"
    ).encode("utf-8")


def _atomic_write(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    except Exception:
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise


def _file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _enum_json(record: object) -> dict[str, object]:
    data = asdict(record)
    for key, value in list(data.items()):
        if hasattr(value, "value"):
            data[key] = value.value
    return data


class EngineAssetCompiler:
    def __init__(self) -> None:
        self.compiler_hash = _file_hash(Path(__file__))

    @staticmethod
    def _load_metadata(path: Path) -> tuple[dict[str, Any], bytes]:
        raw = path.read_bytes()
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise AssetCompileError(f"metadata is not valid JSON: {exc}") from exc
        if not isinstance(data, dict):
            raise AssetCompileError("metadata root must be an object")
        return data, raw

    @staticmethod
    def _required_text(metadata: Mapping[str, Any], key: str) -> str:
        value = metadata.get(key)
        if not isinstance(value, str) or not value.strip():
            raise AssetCompileError(f"metadata field {key!r} must be non-empty text")
        return value

    @staticmethod
    def _validate_metadata(metadata: Mapping[str, Any]) -> tuple[TorqueSemantics, DataSplit]:
        if metadata.get("schema") != PIPELINE_SCHEMA:
            raise AssetCompileError(f"metadata schema must be {PIPELINE_SCHEMA!r}")
        for key in (
            "dataset_id",
            "source_uri",
            "source_kind",
            "split",
            "semantics",
            "frame_convention",
            "timebase",
            "lineage_root_id",
            "missing_data_policy",
        ):
            EngineAssetCompiler._required_text(metadata, key)
        try:
            semantics = TorqueSemantics(str(metadata["semantics"]))
            split = DataSplit(str(metadata["split"]))
            SourceKind(str(metadata["source_kind"]))
        except ValueError as exc:
            raise AssetCompileError(str(exc)) from exc
        units = metadata.get("units")
        expected_columns = _SEMANTIC_COLUMNS[semantics]
        if not isinstance(units, dict) or set(units) != set(expected_columns):
            raise AssetCompileError(
                f"units must cover exactly the {semantics.value} columns {expected_columns}"
            )
        if units.get("rpm") != "rpm" or any(
            units[column] != "N*m" for column in expected_columns if column != "rpm"
        ):
            raise AssetCompileError("only explicit rpm and N*m input units are accepted")
        channel_semantics = metadata.get("channel_semantics")
        if not isinstance(channel_semantics, dict) or set(channel_semantics) != set(expected_columns):
            raise AssetCompileError("channel_semantics must cover every CSV column exactly")
        uncertainty = metadata.get("uncertainty_1sigma")
        if not isinstance(uncertainty, dict) or set(uncertainty) != set(expected_columns):
            raise AssetCompileError("uncertainty_1sigma must cover every CSV column exactly")
        if any(
            not isinstance(value, (int, float))
            or not math.isfinite(float(value))
            or float(value) <= 0.0
            for value in uncertainty.values()
        ):
            raise AssetCompileError("all signal uncertainties must be finite and positive")
        interpolation = metadata.get("interpolation")
        try:
            InterpolationPolicy(str(interpolation))
        except ValueError as exc:
            raise AssetCompileError(f"invalid interpolation policy {interpolation!r}") from exc
        parameters = metadata.get("engine_parameters")
        bounds = metadata.get("parameter_bounds")
        parameter_uncertainty = metadata.get("parameter_uncertainty_1sigma")
        expected_parameters = set(_PARAMETER_INFO)
        for label, value in (
            ("engine_parameters", parameters),
            ("parameter_bounds", bounds),
            ("parameter_uncertainty_1sigma", parameter_uncertainty),
        ):
            if not isinstance(value, dict) or set(value) != expected_parameters:
                raise AssetCompileError(f"{label} must cover every Engine parameter exactly")
        for name in expected_parameters:
            nominal = parameters[name]
            interval = bounds[name]
            sigma = parameter_uncertainty[name]
            if not isinstance(nominal, (int, float)) or not math.isfinite(float(nominal)):
                raise AssetCompileError(f"parameter {name} must be finite")
            if (
                not isinstance(interval, list)
                or len(interval) != 2
                or not all(isinstance(item, (int, float)) for item in interval)
            ):
                raise AssetCompileError(f"parameter {name} bounds must be a two-number list")
            lo, hi = map(float, interval)
            if not math.isfinite(lo) or not math.isfinite(hi) or not lo <= float(nominal) <= hi:
                raise AssetCompileError(f"parameter {name} is outside its declared bounds")
            if not isinstance(sigma, (int, float)) or not math.isfinite(float(sigma)) or sigma < 0.0:
                raise AssetCompileError(f"parameter {name} uncertainty must be non-negative")
        environment = metadata.get("environment")
        if not isinstance(environment, dict) or not environment:
            raise AssetCompileError("environment must be a non-empty object")
        return semantics, split

    @staticmethod
    def _load_csv(
        path: Path, semantics: TorqueSemantics
    ) -> Mapping[str, tuple[float, ...]]:
        expected = _SEMANTIC_COLUMNS[semantics]
        try:
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                reader = csv.DictReader(handle)
                if reader.fieldnames is None or tuple(reader.fieldnames) != expected:
                    raise AssetCompileError(
                        f"CSV columns must be exactly and in order {expected}; got {reader.fieldnames}"
                    )
                values: dict[str, list[float]] = {column: [] for column in expected}
                for line_number, row in enumerate(reader, start=2):
                    if None in row or any(row[column] is None or not row[column].strip() for column in expected):
                        raise AssetCompileError(f"CSV row {line_number} contains missing data")
                    for column in expected:
                        try:
                            value = float(row[column])
                        except ValueError as exc:
                            raise AssetCompileError(
                                f"CSV row {line_number} column {column} is not numeric"
                            ) from exc
                        if not math.isfinite(value):
                            raise AssetCompileError(
                                f"CSV row {line_number} column {column} is non-finite"
                            )
                        values[column].append(value)
        except UnicodeDecodeError as exc:
            raise AssetCompileError("CSV must be UTF-8 encoded") from exc
        if len(values["rpm"]) < 2:
            raise AssetCompileError("engine map requires at least two RPM rows")
        rpm = values["rpm"]
        if rpm[0] < 0.0 or any(right <= left for left, right in zip(rpm, rpm[1:])):
            raise AssetCompileError("RPM rows must be non-negative and strictly increasing")
        return {key: tuple(item) for key, item in values.items()}

    @staticmethod
    def _make_asset(
        metadata: Mapping[str, Any],
        semantics: TorqueSemantics,
        table: Mapping[str, tuple[float, ...]],
    ) -> EngineAsset:
        rpm = table["rpm"]
        interpolation = InterpolationPolicy(str(metadata["interpolation"]))
        if semantics is TorqueSemantics.NET_BRAKE_MAP:
            full = Curve1D(rpm, table["net_full_torque_nm"], interpolation)
            closed = Curve1D(rpm, table["net_closed_torque_nm"], interpolation)
            loss = None
        elif semantics is TorqueSemantics.GROSS_COMBUSTION_PLUS_LOSS:
            full = Curve1D(rpm, table["gross_combustion_torque_nm"], interpolation)
            closed = None
            loss = Curve1D(rpm, table["loss_torque_nm"], interpolation)
            if any(value < 0.0 for value in table["loss_torque_nm"]):
                raise AssetCompileError("loss torque magnitudes cannot be negative")
        else:
            full = Curve1D(rpm, table["full_load_torque_nm"], interpolation)
            closed = None
            loss = None
        p = metadata["engine_parameters"]
        try:
            return EngineAsset(
                dataset_id=str(metadata["dataset_id"]),
                semantics=semantics,
                full_curve=full,
                closed_curve=closed,
                loss_curve=loss,
                inertia_kg_m2=float(p["inertia_kg_m2"]),
                idle_rpm=float(p["idle_rpm"]),
                idle_kp_nm_per_rad_s=float(p["idle_kp_nm_per_rad_s"]),
                idle_max_torque_nm=float(p["idle_max_torque_nm"]),
                stall_zero_rpm=float(p["stall_zero_rpm"]),
                stall_detect_rpm=float(p["stall_detect_rpm"]),
                stall_hold_s=float(p["stall_hold_s"]),
                fire_rpm=float(p["fire_rpm"]),
                min_crank_s=float(p["min_crank_s"]),
                starter_torque_nm=float(p["starter_torque_nm"]),
                rev_limit_rpm=float(p["rev_limit_rpm"]),
                rev_resume_rpm=float(p["rev_resume_rpm"]),
                hard_overspeed_rpm=float(p["hard_overspeed_rpm"]),
                torque_lag_s=float(p["torque_lag_s"]),
                environment=dict(metadata["environment"]),
                source_kind=str(metadata["source_kind"]),
                source_note=str(metadata.get("source_note", "")),
            )
        except ValueError as exc:
            raise AssetCompileError(f"compiled Engine asset is invalid: {exc}") from exc

    def _make_dataset_manifest(
        self,
        metadata: Mapping[str, Any],
        split: DataSplit,
        source_hash: str,
        rpm_domain: tuple[float, float],
    ) -> DatasetManifest:
        manifest = DatasetManifest(
            dataset_id=str(metadata["dataset_id"]),
            source_uri=str(metadata["source_uri"]),
            source_hash=source_hash,
            source_kind=str(metadata["source_kind"]),
            split=split,
            signals_units=dict(metadata["units"]),
            frame_convention=str(metadata["frame_convention"]),
            timebase=str(metadata["timebase"]),
            environment=dict(metadata["environment"]),
            uncertainty_1sigma={
                key: float(value) for key, value in metadata["uncertainty_1sigma"].items()
            },
            valid_domain={"rpm": rpm_domain, "load_request": (0.0, 1.0)},
            preprocessing=(
                "strict CSV schema and unit validation",
                f"{metadata['interpolation']} curve compilation",
                f"torque semantics={metadata['semantics']}",
            ),
            fit_code_hash=self.compiler_hash,
            synthetic=str(metadata["source_kind"]) == SourceKind.SYNTHETIC.value,
            lineage_root_id=str(metadata["lineage_root_id"]),
            acquisition_id=str(metadata.get("acquisition_id", "")),
            channel_semantics=dict(metadata["channel_semantics"]),
            calibration_date=str(metadata.get("calibration_date", "")),
            missing_data_policy=str(metadata["missing_data_policy"]),
            processing_code_hash=self.compiler_hash,
        )
        manifest.validate()
        return manifest

    def _make_passports(
        self,
        asset: EngineAsset,
        metadata: Mapping[str, Any],
        source_hash: str,
    ) -> tuple[ParameterPassport, ...]:
        source_kind = SourceKind(str(metadata["source_kind"]))
        requested_status = ParameterStatus(str(metadata.get("parameter_status", "PROVISIONAL")))
        if requested_status is ParameterStatus.VALIDATED and source_kind in (
            SourceKind.SYNTHETIC,
            SourceKind.ESTIMATED,
            SourceKind.GAMEPLAY,
        ):
            raise AssetCompileError("non-evidence source cannot produce VALIDATED passports")
        p = metadata["engine_parameters"]
        bounds = metadata["parameter_bounds"]
        uncertainty = metadata["parameter_uncertainty_1sigma"]
        rpm_domain = (float(asset.full_curve.min_rpm), float(asset.hard_overspeed_rpm))
        version = f"compiled-{source_hash[:16]}"
        passports: list[ParameterPassport] = []
        for name, (units, meaning) in _PARAMETER_INFO.items():
            passport = ParameterPassport(
                parameter_id=f"engine.{name}",
                owner_system="Engine",
                nominal=float(p[name]),
                bounds=tuple(map(float, bounds[name])),
                units=units,
                stage=CalibrationStage.FOUNDATIONS,
                asset_version=version,
                physical_meaning=meaning,
                frame_convention=str(metadata["frame_convention"]),
                source_kind=source_kind,
                source_dataset_id=asset.dataset_id,
                source_hash=source_hash,
                fit_code_hash=self.compiler_hash,
                valid_domain={"rpm": rpm_domain},
                operating_conditions=dict(metadata["environment"]),
                uncertainty_1sigma=float(uncertainty[name]),
                status=requested_status,
                description="Compiled from the declared Engine evidence bundle.",
            )
            passport.validate()
            passports.append(passport)
        return tuple(passports)

    def compile(
        self, csv_path: str | Path, metadata_path: str | Path, output_dir: str | Path
    ) -> CompiledEngineBundle:
        source_csv = Path(csv_path)
        sidecar = Path(metadata_path)
        destination = Path(output_dir)
        metadata, metadata_raw = self._load_metadata(sidecar)
        semantics, split = self._validate_metadata(metadata)
        table = self._load_csv(source_csv, semantics)
        asset = self._make_asset(metadata, semantics, table)

        csv_raw = source_csv.read_bytes()
        csv_hash = _sha256_bytes(csv_raw)
        metadata_hash = _sha256_bytes(metadata_raw)
        bundle_hash = _sha256_bytes(
            _canonical_json_bytes(
                {
                    "csv_sha256": csv_hash,
                    "metadata_sha256": metadata_hash,
                    "schema": PIPELINE_SCHEMA,
                }
            )
        )
        manifest = self._make_dataset_manifest(
            metadata,
            split,
            bundle_hash,
            (float(table["rpm"][0]), float(asset.hard_overspeed_rpm)),
        )
        passports = self._make_passports(asset, metadata, bundle_hash)

        asset_payload = dict(asset.canonical_payload())
        asset_payload["compile_provenance"] = {
            "schema": PIPELINE_SCHEMA,
            "source_csv_sha256": csv_hash,
            "metadata_sha256": metadata_hash,
            "source_bundle_sha256": bundle_hash,
            "compiler_sha256": self.compiler_hash,
            "asset_content_sha256": asset.content_hash(),
        }
        manifest_payload = _enum_json(manifest)
        passport_payload = {
            "schema": "vehicle-parameter-passports-v2",
            "parameters": [_enum_json(passport) for passport in passports],
        }
        asset_path = destination / "engine_asset.json"
        dataset_path = destination / "dataset_manifest.json"
        passports_path = destination / "parameter_passports.json"
        compile_path = destination / "compile_manifest.json"
        _atomic_write(asset_path, _pretty_json_bytes(asset_payload))
        _atomic_write(dataset_path, _pretty_json_bytes(manifest_payload))
        _atomic_write(passports_path, _pretty_json_bytes(passport_payload))

        files = {
            asset_path.name: _file_hash(asset_path),
            dataset_path.name: _file_hash(dataset_path),
            passports_path.name: _file_hash(passports_path),
        }
        compile_payload = {
            "schema": PIPELINE_SCHEMA,
            "source_files": {
                "csv_name": source_csv.name,
                "csv_sha256": csv_hash,
                "metadata_name": sidecar.name,
                "metadata_sha256": metadata_hash,
                "source_bundle_sha256": bundle_hash,
            },
            "compiler_sha256": self.compiler_hash,
            "engine_asset_content_sha256": asset.content_hash(),
            "outputs": files,
        }
        _atomic_write(compile_path, _pretty_json_bytes(compile_payload))
        return CompiledEngineBundle(
            asset,
            manifest,
            passports,
            csv_hash,
            metadata_hash,
            bundle_hash,
            self.compiler_hash,
            asset_path,
            dataset_path,
            passports_path,
            compile_path,
        )


def verify_compiled_engine_bundle(output_dir: str | Path) -> VerifiedEngineBundle:
    directory = Path(output_dir)
    compile_path = directory / "compile_manifest.json"
    try:
        compile_manifest = json.loads(compile_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        raise AssetCompileError(f"compile manifest cannot be read: {exc}") from exc
    if compile_manifest.get("schema") != PIPELINE_SCHEMA:
        raise AssetCompileError("compile manifest schema mismatch")
    outputs = compile_manifest.get("outputs")
    if not isinstance(outputs, dict) or set(outputs) != {
        "engine_asset.json",
        "dataset_manifest.json",
        "parameter_passports.json",
    }:
        raise AssetCompileError("compile manifest output inventory is incomplete")
    verified: list[str] = []
    for filename, expected_hash in sorted(outputs.items()):
        path = directory / filename
        if not path.is_file():
            raise AssetCompileError(f"compiled output {filename} is missing")
        actual_hash = _file_hash(path)
        if actual_hash != expected_hash:
            raise AssetCompileError(f"compiled output {filename} hash mismatch")
        verified.append(filename)
    asset = EngineAsset.from_json(directory / "engine_asset.json")
    if asset.content_hash() != compile_manifest.get("engine_asset_content_sha256"):
        raise AssetCompileError("runtime Engine asset content hash mismatch")
    return VerifiedEngineBundle(asset, compile_manifest, tuple(verified))

