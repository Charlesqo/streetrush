from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import tempfile
import unittest

import numpy as np

from engine_calibration_reference.calibration import DataSplit, SourceKind
from engine_calibration_reference.timeseries_pipeline import (
    MissingDataPolicy,
    SignalChannel,
    TimeSeriesError,
    TimeSeriesImportSpec,
    TimeSeriesProcessor,
)


def import_spec(policy: MissingDataPolicy = MissingDataPolicy.INTERPOLATE_LIMITED):
    return TimeSeriesImportSpec(
        dataset_id="synthetic_latency_fixture",
        source_uri="generated://tests/latency-fixture",
        source_kind=SourceKind.SYNTHETIC,
        split=DataSplit.CALIBRATION,
        channels=(
            SignalChannel("command", "1", "normalized driver command", 0.002),
            SignalChannel(
                "accel_m_s2",
                "m/s^2",
                "body longitudinal acceleration",
                0.01,
                latency_s=0.03,
                sensor_frame="BODY",
            ),
        ),
        frame_convention="body x forward, y left, z up",
        environment={"road": "synthetic-level"},
        lineage_root_id="synthetic-latency-lineage",
        acquisition_id="synthetic-latency-acquisition-1",
        resample_hz=50.0,
        missing_data_policy=policy,
        maximum_interpolation_gap_s=0.05 if policy is MissingDataPolicy.INTERPOLATE_LIMITED else 0.0,
    )


def write_fixture(path: Path, missing_rows: tuple[int, ...] = ()) -> None:
    lines = ["time_s,command,accel_m_s2"]
    for index in range(101):
        time = index / 100.0
        command = 0.2 + 0.5 * time
        # Recorded acceleration is a delayed linear physical signal:
        # y_record(t) = y_physical(t - 0.03).
        delayed_accel = 1.0 + 2.0 * (time - 0.03)
        accel_text = "" if index in missing_rows else f"{delayed_accel:.12f}"
        lines.append(f"{time:.2f},{command:.12f},{accel_text}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


class TestTimeSeriesPipeline(unittest.TestCase):
    def test_latency_correction_missing_interpolation_and_exact_grid(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "raw.csv"
            write_fixture(path, missing_rows=(40, 41))
            result = TimeSeriesProcessor().process(path, import_spec())

            self.assertEqual(result.source_rows, 101)
            self.assertEqual(result.retained_source_rows, 101)
            self.assertEqual(result.interpolated_samples["accel_m_s2"], 2)
            self.assertAlmostEqual(result.time_s[0], 0.0)
            self.assertAlmostEqual(result.time_s[-1], 0.96)
            self.assertTrue(np.allclose(np.diff(result.time_s), 0.02, atol=1.0e-15))
            expected = 1.0 + 2.0 * result.time_s
            self.assertTrue(np.allclose(result.channel("accel_m_s2"), expected, atol=1.0e-11))
            self.assertEqual(
                result.dataset_manifest.latency_correction_s, {"accel_m_s2": 0.03}
            )
            self.assertEqual(result.dataset_manifest.sensor_frames, {"accel_m_s2": "BODY"})

    def test_reject_and_drop_row_policies_are_explicit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "raw.csv"
            write_fixture(path, missing_rows=(40,))
            processor = TimeSeriesProcessor()
            with self.assertRaisesRegex(TimeSeriesError, "missing sample rejected"):
                processor.process(path, import_spec(MissingDataPolicy.REJECT))

            dropped = processor.process(path, import_spec(MissingDataPolicy.DROP_ROW))
            self.assertEqual(dropped.retained_source_rows, 100)
            self.assertEqual(dropped.interpolated_samples["accel_m_s2"], 0)

    def test_long_or_endpoint_gap_is_never_silently_filled(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            long_gap = root / "long.csv"
            write_fixture(long_gap, missing_rows=(40, 41, 42, 43, 44))
            with self.assertRaisesRegex(TimeSeriesError, "exceeds limit"):
                TimeSeriesProcessor().process(long_gap, import_spec())

            endpoint = root / "endpoint.csv"
            write_fixture(endpoint, missing_rows=(0,))
            with self.assertRaisesRegex(TimeSeriesError, "endpoint gap"):
                TimeSeriesProcessor().process(endpoint, import_spec())

    def test_nonmonotonic_time_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "raw.csv"
            write_fixture(path)
            rows = path.read_text(encoding="utf-8").splitlines()
            rows[20], rows[21] = rows[21], rows[20]
            path.write_text("\n".join(rows) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(TimeSeriesError, "strictly increasing"):
                TimeSeriesProcessor().process(path, import_spec())

    def test_processing_and_export_are_byte_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "raw.csv"
            write_fixture(path, missing_rows=(40, 41))
            processor = TimeSeriesProcessor()
            first = processor.process(path, import_spec())
            second = processor.process(path, import_spec())
            self.assertEqual(first.content_fingerprint, second.content_fingerprint)

            first_paths = processor.export(first, root / "first")
            second_paths = processor.export(second, root / "second")
            for left, right in zip(first_paths, second_paths):
                self.assertEqual(left.read_bytes(), right.read_bytes())
            with self.assertRaises(ValueError):
                first.time_s[0] = 99.0

    def test_latency_that_removes_common_support_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "raw.csv"
            write_fixture(path)
            spec = import_spec()
            delayed = replace(spec.channels[1], latency_s=2.0)
            with self.assertRaisesRegex(TimeSeriesError, "no common signal support"):
                TimeSeriesProcessor().process(
                    path, replace(spec, channels=(spec.channels[0], delayed))
                )


if __name__ == "__main__":
    unittest.main()

