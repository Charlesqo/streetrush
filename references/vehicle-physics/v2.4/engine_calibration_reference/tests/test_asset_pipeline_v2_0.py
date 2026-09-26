from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

from engine_calibration_reference.asset_pipeline import (
    AssetCompileError,
    EngineAssetCompiler,
    verify_compiled_engine_bundle,
)
from engine_calibration_reference.calibration import DatasetRegistry
from engine_calibration_reference.engine_model import TorqueSemantics


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "synthetic_engine_map_v2_0.csv"
METADATA = ROOT / "data" / "raw" / "synthetic_engine_map_v2_0.metadata.json"


class TestEngineAssetPipeline(unittest.TestCase):
    def test_raw_bundle_compiles_loadable_asset_manifest_passports_and_hashes(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "compiled"
            bundle = EngineAssetCompiler().compile(RAW, METADATA, output)
            verified = verify_compiled_engine_bundle(output)

            self.assertIs(bundle.asset.semantics, TorqueSemantics.NET_BRAKE_MAP)
            self.assertEqual(verified.asset.content_hash(), bundle.asset.content_hash())
            self.assertEqual(bundle.dataset_manifest.source_hash, bundle.source_bundle_hash)
            self.assertEqual(len(bundle.parameter_passports), 14)
            self.assertEqual(
                verified.verified_files,
                ("dataset_manifest.json", "engine_asset.json", "parameter_passports.json"),
            )
            for passport in bundle.parameter_passports:
                self.assertEqual(passport.source_hash, bundle.source_bundle_hash)
                self.assertEqual(passport.fit_code_hash, bundle.compiler_hash)

    def test_compile_is_byte_reproducible(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            first = Path(temporary) / "first"
            second = Path(temporary) / "second"
            compiler = EngineAssetCompiler()
            compiler.compile(RAW, METADATA, first)
            compiler.compile(RAW, METADATA, second)
            for filename in (
                "engine_asset.json",
                "dataset_manifest.json",
                "parameter_passports.json",
                "compile_manifest.json",
            ):
                self.assertEqual((first / filename).read_bytes(), (second / filename).read_bytes())

    def test_runtime_tamper_is_detected_before_asset_use(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "compiled"
            EngineAssetCompiler().compile(RAW, METADATA, output)
            asset_path = output / "engine_asset.json"
            payload = json.loads(asset_path.read_text(encoding="utf-8"))
            payload["inertia_kg_m2"] = 0.99
            asset_path.write_text(json.dumps(payload), encoding="utf-8")
            with self.assertRaisesRegex(AssetCompileError, "hash mismatch"):
                verify_compiled_engine_bundle(output)

    def test_wrong_units_missing_cells_and_nonmonotonic_rpm_are_rejected(self) -> None:
        compiler = EngineAssetCompiler()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            metadata = json.loads(METADATA.read_text(encoding="utf-8"))
            metadata["units"]["net_full_torque_nm"] = "lb*ft"
            bad_units = root / "bad_units.json"
            bad_units.write_text(json.dumps(metadata), encoding="utf-8")
            with self.assertRaisesRegex(AssetCompileError, "rpm and N\\*m"):
                compiler.compile(RAW, bad_units, root / "units-out")

            rows = RAW.read_text(encoding="utf-8").splitlines()
            rows[3] = "250,35,-15"
            rows[4] = "200,90,-24"
            nonmonotonic = root / "nonmonotonic.csv"
            nonmonotonic.write_text("\n".join(rows) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(AssetCompileError, "strictly increasing"):
                compiler.compile(nonmonotonic, METADATA, root / "rpm-out")

            rows = RAW.read_text(encoding="utf-8").splitlines()
            rows[5] = "900,,-32"
            missing = root / "missing.csv"
            missing.write_text("\n".join(rows) + "\n", encoding="utf-8")
            with self.assertRaisesRegex(AssetCompileError, "missing data"):
                compiler.compile(missing, METADATA, root / "missing-out")

    def test_same_lineage_cannot_cross_calibration_and_holdout(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            compiler = EngineAssetCompiler()
            calibration = compiler.compile(RAW, METADATA, root / "calibration")
            metadata = json.loads(METADATA.read_text(encoding="utf-8"))
            metadata["dataset_id"] = "SYNTH_ICE_NET_MAP_V2_ILLEGAL_HOLDOUT_REUSE"
            metadata["split"] = "HOLDOUT"
            holdout_sidecar = root / "holdout.json"
            holdout_sidecar.write_text(json.dumps(metadata), encoding="utf-8")
            holdout = compiler.compile(RAW, holdout_sidecar, root / "holdout")

            registry = DatasetRegistry()
            registry.register(calibration.dataset_manifest)
            with self.assertRaisesRegex(ValueError, "lineage cannot cross"):
                registry.register(holdout.dataset_manifest)


if __name__ == "__main__":
    unittest.main()

