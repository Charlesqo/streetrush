from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import unittest

import numpy as np

from engine_calibration_reference.calibration import (
    DataSplit,
    DatasetRegistry,
    GateStatus,
    ParameterRegistry,
    ParameterStatus,
    PhenomenonAuthorityRegistry,
    RegressionTier,
    SourceKind,
    analyze_identifiability,
    finite_difference_sensitivity,
    robust_weighted_residuals,
)
from engine_calibration_reference.calibration_fixtures import (
    build_dataset_manifests,
    build_parameter_passports,
    coast_acceleration_mps2,
    fit_staged_longitudinal,
    make_synthetic_longitudinal_data,
    normalized_rmse,
    wot_acceleration_mps2,
    wot_cross_owner_prediction,
)
from engine_calibration_reference.closeout_audit import (
    build_closeout_evidence,
    sha256_source_tree,
)


ROOT = Path(__file__).resolve().parents[1]


class TestDatasetAndParameterContracts(unittest.TestCase):
    def setUp(self) -> None:
        self.data = make_synthetic_longitudinal_data()
        self.datasets = build_dataset_manifests(ROOT, self.data)
        self.passports = build_parameter_passports(self.datasets, sha256_source_tree(ROOT))

    def test_dataset_manifests_cover_units_semantics_domain_and_provenance(self) -> None:
        registry = DatasetRegistry()
        for manifest in self.datasets:
            manifest.validate()
            registry.register(manifest)
            self.assertEqual(set(manifest.channel_semantics), set(manifest.signals_units))
            self.assertEqual(len(manifest.source_hash), 64)
            self.assertTrue(manifest.synthetic)
        self.assertEqual(set(registry.ids()), {item.dataset_id for item in self.datasets})

    def test_data_lineage_and_hash_cannot_cross_splits(self) -> None:
        registry = DatasetRegistry()
        registry.register(self.datasets[1])
        with self.assertRaises(ValueError):
            registry.register(
                replace(
                    self.datasets[1],
                    dataset_id="relabelled-as-holdout",
                    split=DataSplit.HOLDOUT,
                )
            )

    def test_parameter_passports_are_unique_provisional_and_complete(self) -> None:
        registry = ParameterRegistry()
        for passport in self.passports:
            passport.validate()
            registry.register(passport)
            self.assertIs(passport.status, ParameterStatus.PROVISIONAL)
            self.assertIs(passport.source_kind, SourceKind.SYNTHETIC)
            self.assertTrue(passport.fit_code_hash)
            self.assertTrue(passport.valid_domain)
        with self.assertRaises(ValueError):
            registry.register(self.passports[0])

    def test_synthetic_parameter_cannot_claim_validated_status(self) -> None:
        with self.assertRaises(ValueError):
            replace(self.passports[0], status=ParameterStatus.VALIDATED).validate()

    def test_aero_and_road_load_cannot_both_own_aerodynamic_drag(self) -> None:
        authority = PhenomenonAuthorityRegistry()
        authority.claim("aerodynamic_drag", "Aerodynamics", "reference-point wrench")
        with self.assertRaises(ValueError):
            authority.claim("aerodynamic_drag", "Road-load residual", "quadratic force")


class TestIdentifiabilityAndHoldout(unittest.TestCase):
    def setUp(self) -> None:
        self.data = make_synthetic_longitudinal_data()

    def test_wot_only_cross_owner_problem_is_rank_deficient(self) -> None:
        truth = self.data.truth
        jacobian = finite_difference_sensitivity(
            lambda p: wot_cross_owner_prediction(self.data.wot_speed_mps, p, truth),
            (truth.mass_kg, 1.0, 1.0),
            parameter_scales=(truth.mass_kg, 1.0, 1.0),
            output_sigma=self.data.accel_noise_sigma_mps2,
        )
        report = analyze_identifiability(jacobian)
        self.assertLess(report.rank, report.parameter_count)
        self.assertEqual(report.verdict, "NON_IDENTIFIABLE")

    def test_staged_fit_closes_calibration_but_not_injected_holdout_shape(self) -> None:
        fit = fit_staged_longitudinal(self.data)
        coast = normalized_rmse(
            coast_acceleration_mps2(self.data.coast_speed_mps, fit),
            self.data.coast_accel_mps2,
            self.data.accel_noise_sigma_mps2 * 0.6,
        )
        calibration = normalized_rmse(
            wot_acceleration_mps2(self.data.wot_speed_mps, fit),
            self.data.wot_accel_mps2,
            self.data.accel_noise_sigma_mps2,
        )
        holdout = normalized_rmse(
            wot_acceleration_mps2(self.data.holdout_speed_mps, fit),
            self.data.holdout_accel_mps2,
            self.data.accel_noise_sigma_mps2,
        )
        self.assertLess(coast, 1.3)
        self.assertLess(calibration, 1.3)
        self.assertGreater(holdout, 1.3)

    def test_robust_residual_preserves_sign_and_reduces_outlier_leverage(self) -> None:
        observation = np.zeros(3)
        prediction = np.array([-10.0, 1.0, 10.0])
        residual = robust_weighted_residuals(prediction, observation, np.ones(3), 2.5)
        self.assertLess(residual[0], 0.0)
        self.assertGreater(residual[2], 0.0)
        self.assertLess(abs(residual[2]), 10.0)
        self.assertAlmostEqual(residual[1], 1.0)


class TestCloseoutLedger(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.evidence = build_closeout_evidence(ROOT)
        cls.by_id = {gate.case_id: gate for gate in cls.evidence.gates}

    def test_mandatory_reference_tiers_close(self) -> None:
        decision = self.evidence.release_decision
        self.assertTrue(decision.reference_executable_ready)
        self.assertFalse(decision.target_vehicle_validated)
        self.assertEqual(decision.decision, "REFERENCE_READY_TARGET_NOT_VALIDATED")
        self.assertFalse(decision.blockers)

    def test_ledger_retains_real_pass_fail_xfail_and_skip(self) -> None:
        statuses = {gate.status for gate in self.evidence.gates}
        self.assertTrue(
            {GateStatus.PASS, GateStatus.FAIL, GateStatus.XFAIL, GateStatus.SKIP}.issubset(statuses)
        )
        self.assertIs(self.by_id["L5_SYNTHETIC_SHAPE_HOLDOUT"].status, GateStatus.FAIL)
        self.assertIs(
            self.by_id["NEGATIVE_CONTROL_POST_STEP_RPM_CLAMP"].status,
            GateStatus.XFAIL,
        )

    def test_every_skip_has_acquisition_and_impact_accounting(self) -> None:
        skips = [gate for gate in self.evidence.gates if gate.status is GateStatus.SKIP]
        self.assertGreaterEqual(len(skips), 4)
        for gate in skips:
            self.assertTrue(gate.acquisition_path)
            self.assertTrue(gate.impact_scope)
            self.assertTrue(gate.reason_code)

    def test_whole_vehicle_fixture_closes_cross_system_rows_and_refines(self) -> None:
        numerical = self.evidence.numerical["whole_vehicle"]
        self.assertLess(numerical["max_engine_row_residual_nms"], 1e-7)
        self.assertLess(numerical["max_wheel_row_residual_nms"], 1e-7)
        self.assertLess(numerical["max_chassis_row_residual_n_s"], 1e-7)
        self.assertEqual(numerical["non_domain_status_count"], 0)
        self.assertGreater(numerical["final_speed_120hz_mps"], numerical["initial_speed_mps"])
        self.assertLess(numerical["e240_over_e120"], 0.75)

    def test_actual_engine_clutch_wheel_modes_are_exercised(self) -> None:
        coupled = self.evidence.numerical["coupled_drivetrain"]
        self.assertEqual(coupled["locked"]["mode"], "LOCKED")
        self.assertEqual(coupled["slipping"]["mode"], "SLIPPING")
        self.assertAlmostEqual(
            abs(coupled["slipping"]["clutch_reaction_on_engine_nm"]), 15.0, places=9
        )

    def test_all_mandatory_gate_results_avoid_unexpected_failure(self) -> None:
        mandatory = {
            RegressionTier.L0_CONFIG,
            RegressionTier.L1_INVARIANT,
            RegressionTier.L2_COMPONENT,
            RegressionTier.L3_COUPLED_SYNTHETIC,
        }
        for gate in self.evidence.gates:
            if gate.tier in mandatory:
                self.assertNotIn(gate.status, (GateStatus.FAIL, GateStatus.DOMAIN_ERROR, GateStatus.XPASS))


if __name__ == "__main__":
    unittest.main()
