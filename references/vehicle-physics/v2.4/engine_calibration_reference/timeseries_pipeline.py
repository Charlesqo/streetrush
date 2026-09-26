"""Strict, deterministic time-series ingestion for vehicle calibration data.

The processor makes data conditioning part of the evidence record instead of
an undocumented notebook operation.  It validates units and channel meaning,
applies one declared missing-data policy, corrects per-channel latency onto a
common physical time axis, and resamples to an exact deterministic grid.

Latency convention: a positive ``latency_s`` means the recorded sample at
timestamp ``t`` represents the physical signal at ``t - latency_s``.  The
corrected value at physical time ``t`` is therefore interpolated from the raw
channel at ``t + latency_s``.  The output is cropped to common support; no
extrapolation is permitted.
"""

from __future__ import annotations

import csv
from dataclasses import asdict, dataclass
from enum import Enum
import hashlib
import io
import json
import math
import os
from pathlib import Path
import tempfile
from types import MappingProxyType
from typing import Mapping

import numpy as np

from .calibration import DataSplit, DatasetManifest, SourceKind


class TimeSeriesError(ValueError):
    pass


class MissingDataPolicy(str, Enum):
    REJECT = "REJECT"
    DROP_ROW = "DROP_ROW"
    INTERPOLATE_LIMITED = "INTERPOLATE_LIMITED"


@dataclass(frozen=True)
class SignalChannel:
    name: str
    unit: str
    semantics: str
    uncertainty_1sigma: float
    latency_s: float = 0.0
    sensor_frame: str = ""

    def validate(self) -> None:
        if not self.name or not self.unit or not self.semantics:
            raise TimeSeriesError("signal name, unit, and semantics are required")
        if not math.isfinite(self.uncertainty_1sigma) or self.uncertainty_1sigma <= 0.0:
            raise TimeSeriesError(f"signal {self.name} uncertainty must be positive")
        if not math.isfinite(self.latency_s):
            raise TimeSeriesError(f"signal {self.name} latency must be finite")


@dataclass(frozen=True)
class TimeSeriesImportSpec:
    dataset_id: str
    source_uri: str
    source_kind: SourceKind
    split: DataSplit
    channels: tuple[SignalChannel, ...]
    frame_convention: str
    environment: Mapping[str, float | str]
    lineage_root_id: str
    acquisition_id: str
    resample_hz: float
    missing_data_policy: MissingDataPolicy = MissingDataPolicy.REJECT
    maximum_interpolation_gap_s: float = 0.0
    time_column: str = "time_s"
    time_unit: str = "s"
    time_semantics: str = "monotonic acquisition timestamp"
    time_uncertainty_1sigma_s: float = 1.0e-6
    calibration_date: str = ""
    vehicle_conditions: Mapping[str, float | str] | None = None

    def validate(self) -> None:
        required = (
            self.dataset_id,
            self.source_uri,
            self.frame_convention,
            self.lineage_root_id,
            self.acquisition_id,
            self.time_column,
            self.time_unit,
            self.time_semantics,
        )
        if any(not value for value in required):
            raise TimeSeriesError("dataset identity, time, frame, and lineage fields are required")
        if not self.channels:
            raise TimeSeriesError("at least one signal channel is required")
        for channel in self.channels:
            channel.validate()
        names = [channel.name for channel in self.channels]
        if self.time_column in names or len(set(names)) != len(names):
            raise TimeSeriesError("time and signal channel names must be unique")
        if not math.isfinite(self.resample_hz) or self.resample_hz <= 0.0:
            raise TimeSeriesError("resample rate must be finite and positive")
        if (
            not math.isfinite(self.time_uncertainty_1sigma_s)
            or self.time_uncertainty_1sigma_s <= 0.0
        ):
            raise TimeSeriesError("time uncertainty must be finite and positive")
        if not math.isfinite(self.maximum_interpolation_gap_s) or self.maximum_interpolation_gap_s < 0.0:
            raise TimeSeriesError("maximum interpolation gap cannot be negative")
        if (
            self.missing_data_policy is MissingDataPolicy.INTERPOLATE_LIMITED
            and self.maximum_interpolation_gap_s <= 0.0
        ):
            raise TimeSeriesError("limited interpolation requires a positive maximum gap")
        if not self.environment:
            raise TimeSeriesError("environment declaration cannot be empty")


@dataclass(frozen=True)
class ProcessedTimeSeries:
    time_s: np.ndarray
    signals: Mapping[str, np.ndarray]
    dataset_manifest: DatasetManifest
    source_hash: str
    processing_hash: str
    content_fingerprint: str
    source_rows: int
    retained_source_rows: int
    interpolated_samples: Mapping[str, int]

    def channel(self, name: str) -> np.ndarray:
        return self.signals[name]


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


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


def _json_manifest(manifest: DatasetManifest) -> dict[str, object]:
    payload = asdict(manifest)
    payload["split"] = manifest.split.value
    return payload


class TimeSeriesProcessor:
    def __init__(self) -> None:
        self.processing_hash = _sha256_file(Path(__file__))

    @staticmethod
    def _read_csv(
        path: Path, spec: TimeSeriesImportSpec
    ) -> tuple[np.ndarray, dict[str, np.ndarray], int, int, dict[str, int]]:
        columns = (spec.time_column,) + tuple(channel.name for channel in spec.channels)
        rows: list[list[float]] = []
        missing_masks: list[list[bool]] = []
        try:
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                reader = csv.DictReader(handle)
                if reader.fieldnames is None or tuple(reader.fieldnames) != columns:
                    raise TimeSeriesError(
                        f"CSV columns must be exactly and in order {columns}; got {reader.fieldnames}"
                    )
                for line_number, record in enumerate(reader, start=2):
                    if record[spec.time_column] is None or not record[spec.time_column].strip():
                        raise TimeSeriesError(f"row {line_number} has a missing timestamp")
                    try:
                        timestamp = float(record[spec.time_column])
                    except ValueError as exc:
                        raise TimeSeriesError(f"row {line_number} timestamp is not numeric") from exc
                    if not math.isfinite(timestamp):
                        raise TimeSeriesError(f"row {line_number} timestamp is non-finite")
                    values = [timestamp]
                    mask = [False]
                    for channel in spec.channels:
                        raw = record[channel.name]
                        missing = raw is None or not raw.strip()
                        if missing:
                            values.append(math.nan)
                            mask.append(True)
                            continue
                        try:
                            value = float(raw)
                        except ValueError as exc:
                            raise TimeSeriesError(
                                f"row {line_number} channel {channel.name} is not numeric"
                            ) from exc
                        if not math.isfinite(value):
                            raise TimeSeriesError(
                                f"row {line_number} channel {channel.name} is non-finite"
                            )
                        values.append(value)
                        mask.append(False)
                    rows.append(values)
                    missing_masks.append(mask)
        except UnicodeDecodeError as exc:
            raise TimeSeriesError("CSV must be UTF-8 encoded") from exc
        if len(rows) < 2:
            raise TimeSeriesError("time series requires at least two source rows")
        values = np.asarray(rows, dtype=float)
        missing = np.asarray(missing_masks, dtype=bool)
        source_rows = len(values)
        if np.any(np.diff(values[:, 0]) <= 0.0):
            raise TimeSeriesError("timestamps must be strictly increasing")

        if spec.missing_data_policy is MissingDataPolicy.REJECT:
            locations = np.argwhere(missing[:, 1:])
            if locations.size:
                row, column = locations[0]
                raise TimeSeriesError(
                    f"missing sample rejected at source row {row + 2}, "
                    f"channel {spec.channels[column].name}"
                )
        elif spec.missing_data_policy is MissingDataPolicy.DROP_ROW:
            keep = ~np.any(missing[:, 1:], axis=1)
            values = values[keep]
            missing = missing[keep]
            if len(values) < 2:
                raise TimeSeriesError("row dropping left fewer than two samples")

        time = values[:, 0].copy()
        interpolated: dict[str, int] = {channel.name: 0 for channel in spec.channels}
        signals: dict[str, np.ndarray] = {}
        for offset, channel in enumerate(spec.channels, start=1):
            signal = values[:, offset].copy()
            channel_missing = np.isnan(signal)
            if np.any(channel_missing):
                if spec.missing_data_policy is not MissingDataPolicy.INTERPOLATE_LIMITED:
                    raise TimeSeriesError("internal missing-data policy inconsistency")
                if channel_missing[0] or channel_missing[-1]:
                    raise TimeSeriesError(
                        f"channel {channel.name} has an endpoint gap that would require extrapolation"
                    )
                indices = np.flatnonzero(channel_missing)
                run_starts = indices[np.r_[True, np.diff(indices) > 1]]
                run_ends = indices[np.r_[np.diff(indices) > 1, True]]
                for start, end in zip(run_starts, run_ends):
                    support_gap = time[end + 1] - time[start - 1]
                    if support_gap > spec.maximum_interpolation_gap_s + 1.0e-12:
                        raise TimeSeriesError(
                            f"channel {channel.name} missing gap {support_gap:.9g}s exceeds "
                            f"limit {spec.maximum_interpolation_gap_s:.9g}s"
                        )
                valid = ~channel_missing
                signal[channel_missing] = np.interp(
                    time[channel_missing], time[valid], signal[valid]
                )
                interpolated[channel.name] = int(np.sum(channel_missing))
            signals[channel.name] = signal
        return time, signals, source_rows, len(values), interpolated

    @staticmethod
    def _common_grid(
        time: np.ndarray, channels: tuple[SignalChannel, ...], rate_hz: float
    ) -> np.ndarray:
        support_lo = max(float(time[0] - channel.latency_s) for channel in channels)
        support_hi = min(float(time[-1] - channel.latency_s) for channel in channels)
        # The acquisition time channel itself has zero latency and is part of
        # the common support contract.
        support_lo = max(support_lo, float(time[0]))
        support_hi = min(support_hi, float(time[-1]))
        if support_hi <= support_lo:
            raise TimeSeriesError("latency correction leaves no common signal support")
        tolerance = 1.0e-11
        first_tick = math.ceil((support_lo - tolerance) * rate_hz)
        last_tick = math.floor((support_hi + tolerance) * rate_hz)
        if last_tick <= first_tick:
            raise TimeSeriesError("common support is too short for two resampled points")
        ticks = np.arange(first_tick, last_tick + 1, dtype=np.int64)
        return ticks.astype(float) / rate_hz

    @staticmethod
    def _fingerprint(
        time: np.ndarray, signals: Mapping[str, np.ndarray], spec: TimeSeriesImportSpec
    ) -> str:
        digest = hashlib.sha256()
        spec_payload = {
            "dataset_id": spec.dataset_id,
            "source_uri": spec.source_uri,
            "source_kind": spec.source_kind.value,
            "split": spec.split.value,
            "resample_hz": spec.resample_hz,
            "missing_data_policy": spec.missing_data_policy.value,
            "maximum_interpolation_gap_s": spec.maximum_interpolation_gap_s,
            "channels": [asdict(channel) for channel in spec.channels],
        }
        digest.update(
            json.dumps(spec_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        )
        digest.update(np.asarray(time, dtype="<f8").tobytes(order="C"))
        for name in sorted(signals):
            digest.update(name.encode("utf-8"))
            digest.update(np.asarray(signals[name], dtype="<f8").tobytes(order="C"))
        return digest.hexdigest()

    def process(
        self, csv_path: str | Path, spec: TimeSeriesImportSpec
    ) -> ProcessedTimeSeries:
        spec.validate()
        path = Path(csv_path)
        source_hash = _sha256_file(path)
        time, raw_signals, source_rows, retained_rows, interpolated = self._read_csv(path, spec)
        grid = self._common_grid(time, spec.channels, spec.resample_hz)
        processed: dict[str, np.ndarray] = {}
        for channel in spec.channels:
            query_time = grid + channel.latency_s
            if query_time[0] < time[0] - 1.0e-12 or query_time[-1] > time[-1] + 1.0e-12:
                raise TimeSeriesError(f"latency correction for {channel.name} would extrapolate")
            values = np.interp(query_time, time, raw_signals[channel.name])
            values.setflags(write=False)
            processed[channel.name] = values
        grid.setflags(write=False)
        fingerprint = self._fingerprint(grid, processed, spec)

        units = {spec.time_column: spec.time_unit}
        units.update({channel.name: channel.unit for channel in spec.channels})
        semantics = {spec.time_column: spec.time_semantics}
        semantics.update({channel.name: channel.semantics for channel in spec.channels})
        uncertainty = {spec.time_column: spec.time_uncertainty_1sigma_s}
        uncertainty.update(
            {channel.name: channel.uncertainty_1sigma for channel in spec.channels}
        )
        sensor_frames = {
            channel.name: channel.sensor_frame
            for channel in spec.channels
            if channel.sensor_frame
        }
        latency = {
            channel.name: channel.latency_s
            for channel in spec.channels
            if channel.latency_s != 0.0
        }
        preprocessing = [
            f"missing_data_policy={spec.missing_data_policy.value}",
            f"linear_resample_hz={spec.resample_hz:.12g}",
            "common-support crop; no extrapolation",
        ]
        if spec.missing_data_policy is MissingDataPolicy.INTERPOLATE_LIMITED:
            preprocessing.append(
                f"maximum_interpolation_gap_s={spec.maximum_interpolation_gap_s:.12g}"
            )
        if latency:
            preprocessing.append("per-channel deterministic latency correction")
        manifest = DatasetManifest(
            dataset_id=spec.dataset_id,
            source_uri=spec.source_uri,
            source_hash=source_hash,
            source_kind=spec.source_kind.value,
            split=spec.split,
            signals_units=units,
            frame_convention=spec.frame_convention,
            timebase=f"UNIFORM_{spec.resample_hz:.12g}_HZ",
            environment=dict(spec.environment),
            uncertainty_1sigma=uncertainty,
            valid_domain={"time_s": (float(grid[0]), float(grid[-1]))},
            preprocessing=tuple(preprocessing),
            fit_code_hash=self.processing_hash,
            synthetic=spec.source_kind is SourceKind.SYNTHETIC,
            lineage_root_id=spec.lineage_root_id,
            acquisition_id=spec.acquisition_id,
            channel_semantics=semantics,
            sample_rate_hz=spec.resample_hz,
            sensor_frames=sensor_frames,
            vehicle_conditions=dict(spec.vehicle_conditions or {}),
            calibration_date=spec.calibration_date,
            missing_data_policy=spec.missing_data_policy.value,
            processing_code_hash=self.processing_hash,
            latency_correction_s=latency,
        )
        manifest.validate()
        return ProcessedTimeSeries(
            grid,
            MappingProxyType(processed),
            manifest,
            source_hash,
            self.processing_hash,
            fingerprint,
            source_rows,
            retained_rows,
            MappingProxyType(interpolated),
        )

    @staticmethod
    def export(series: ProcessedTimeSeries, output_dir: str | Path) -> tuple[Path, Path]:
        destination = Path(output_dir)
        csv_path = destination / "processed_timeseries.csv"
        manifest_path = destination / "dataset_manifest.json"
        stream = io.StringIO(newline="")
        names = tuple(series.signals)
        writer = csv.writer(stream, lineterminator="\n")
        writer.writerow(("time_s",) + names)
        for index, timestamp in enumerate(series.time_s):
            writer.writerow(
                (format(float(timestamp), ".17g"),)
                + tuple(format(float(series.signals[name][index]), ".17g") for name in names)
            )
        _atomic_write(csv_path, stream.getvalue().encode("utf-8"))
        manifest_payload = {
            "schema": "vehicle-processed-timeseries-v1",
            "content_fingerprint": series.content_fingerprint,
            "source_rows": series.source_rows,
            "retained_source_rows": series.retained_source_rows,
            "interpolated_samples": dict(series.interpolated_samples),
            "dataset_manifest": _json_manifest(series.dataset_manifest),
        }
        _atomic_write(
            manifest_path,
            (json.dumps(manifest_payload, sort_keys=True, indent=2) + "\n").encode("utf-8"),
        )
        return csv_path, manifest_path

