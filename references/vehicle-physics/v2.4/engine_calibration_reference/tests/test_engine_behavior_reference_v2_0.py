from __future__ import annotations

from dataclasses import replace
import math
import os
from pathlib import Path
import unittest

import numpy as np

from engine_calibration_reference.engine_model import (
    Curve1D,
    DomainError,
    EngineAsset,
    EngineCommand,
    EngineMode,
    EngineModel,
    EngineOwner,
    EngineState,
    InterpolationPolicy,
    TorqueSemantics,
    rad_s_to_rpm,
    rpm_to_rad_s,
)
from engine_calibration_reference.rigs import (
    ClutchSolveMode,
    CoupledDrivetrainConfig,
    CoupledDrivetrainState,
    solve_coupled_drivetrain_substep,
)


ROOT = Path(__file__).resolve().parents[1]


def load_asset() -> EngineAsset:
    return EngineAsset.from_json(ROOT / "data" / "synthetic_engine_asset.json")


class TestTorqueAsset(unittest.TestCase):
    def setUp(self) -> None:
        self.asset = load_asset()
        self.model = EngineModel(self.asset)

    def test_pchip_knots_and_analytic_tangent(self) -> None:
        curve = self.asset.full_curve
        for rpm, expected in zip(curve.rpm, curve.torque_nm):
            value, _ = curve.sample_rpm(rpm)
            self.assertAlmostEqual(value, expected, places=11)
        for rpm in (775.0, 1575.0, 3125.0, 5125.0, 6875.0):
            omega = rpm_to_rad_s(rpm)
            _, tangent = curve.sample_omega(omega)
            h = 1e-4
            plus = curve.sample_omega(omega + h)[0]
            minus = curve.sample_omega(omega - h)[0]
            finite_difference = (plus - minus) / (2.0 * h)
            self.assertAlmostEqual(tangent, finite_difference, delta=2e-6)

    def test_pchip_tangent_is_continuous_at_internal_knots(self) -> None:
        curve = self.asset.full_curve
        self.assertIs(curve.interpolation, InterpolationPolicy.PCHIP)
        for rpm in curve.rpm[2:-2]:
            epsilon = 1e-5
            left = curve.sample_rpm(rpm - epsilon)[1]
            right = curve.sample_rpm(rpm + epsilon)[1]
            self.assertAlmostEqual(left, right, delta=2e-7)

    def test_signed_net_overrun_and_no_double_loss(self) -> None:
        torque, _ = self.asset.net_torque(0.0, rpm_to_rad_s(3500.0))
        self.assertAlmostEqual(torque, -72.0, places=10)
        half, _ = self.asset.net_torque(0.5, rpm_to_rad_s(3500.0))
        self.assertAlmostEqual(half, (-72.0 + 370.0) * 0.5, places=10)

    def test_gross_plus_loss_and_full_load_only_semantics(self) -> None:
        rpm = (0.0, 1000.0, 2000.0, 7600.0)
        gross = Curve1D(rpm, (0.0, 200.0, 300.0, 0.0))
        loss = Curve1D(rpm, (0.0, 30.0, 50.0, 80.0))
        gross_asset = replace(
            self.asset,
            semantics=TorqueSemantics.GROSS_COMBUSTION_PLUS_LOSS,
            full_curve=gross,
            closed_curve=None,
            loss_curve=loss,
        )
        value, _ = gross_asset.net_torque(0.5, rpm_to_rad_s(2000.0))
        self.assertAlmostEqual(value, 100.0, places=10)
        full_only = replace(
            gross_asset,
            semantics=TorqueSemantics.FULL_LOAD_ONLY,
            closed_curve=None,
            loss_curve=None,
        )
        self.assertAlmostEqual(full_only.net_torque(1.0, rpm_to_rad_s(2000.0))[0], 300.0)
        with self.assertRaises(DomainError):
            full_only.net_torque(0.5, rpm_to_rad_s(2000.0))

    def test_domain_is_strict_and_hash_is_stable(self) -> None:
        with self.assertRaises(DomainError):
            self.asset.net_torque(1.0, rpm_to_rad_s(7500.1))
        with self.assertRaises(DomainError):
            self.asset.net_torque(1.0, -1.0)
        self.assertEqual(self.asset.content_hash(), load_asset().content_hash())


class TestTrialCommitAndModes(unittest.TestCase):
    def setUp(self) -> None:
        self.asset = load_asset()
        self.model = EngineModel(self.asset)

    def test_controller_prepare_is_frozen_and_commit_is_exactly_once(self) -> None:
        state = EngineState(rpm_to_rad_s(2200.0), EngineMode.RUNNING, 0.2)
        owner = EngineOwner(self.model, state)
        ticket = owner.begin_substep(EngineCommand(0.8), 1.0 / 120.0)
        next_controller = ticket.trial.next_controller_state
        samples = [owner.evaluate(ticket, rpm_to_rad_s(rpm)) for rpm in (2100, 2300, 2500)]
        self.assertEqual(ticket.trial.next_controller_state, next_controller)
        self.assertEqual(owner.state, state)
        self.assertNotEqual(samples[0].free_torque_nm, samples[-1].free_torque_nm)
        committed = owner.commit(ticket, rpm_to_rad_s(2350.0))
        self.assertAlmostEqual(committed.rpm, 2350.0)
        with self.assertRaises(RuntimeError):
            owner.commit(ticket, rpm_to_rad_s(2400.0))

    def test_optional_load_lag_is_frame_rate_independent(self) -> None:
        asset = replace(self.asset, torque_lag_s=0.2)
        expected = 1.0 - math.exp(-1.0 / 0.2)
        final = []
        for hz in (30, 120, 480):
            model = EngineModel(asset)
            state = EngineState(rpm_to_rad_s(2000), EngineMode.RUNNING, 0.0)
            owner = EngineOwner(model, state)
            for _ in range(hz):
                ticket = owner.begin_substep(EngineCommand(1.0), 1.0 / hz)
                owner.commit(ticket, state.omega_rad_s)
                state = owner.state
            final.append(state.load_actuated)
            self.assertAlmostEqual(state.load_actuated, expected, places=12)
        self.assertLess(max(final) - min(final), 1e-12)

    def test_idle_is_bounded_and_excess_load_stalls(self) -> None:
        moderate = EngineState(rpm_to_rad_s(900.0), EngineMode.RUNNING)
        for _ in range(240):
            moderate = self.model.integrate_standalone(
                moderate, EngineCommand(0.0), clutch_reaction_nm=35.0, dt=1.0 / 120.0
            ).state
        self.assertIs(moderate.mode, EngineMode.RUNNING)
        self.assertGreater(moderate.rpm, self.asset.stall_detect_rpm)

        excessive = EngineState(rpm_to_rad_s(900.0), EngineMode.RUNNING)
        for _ in range(240):
            excessive = self.model.integrate_standalone(
                excessive, EngineCommand(0.0), clutch_reaction_nm=220.0, dt=1.0 / 120.0
            ).state
        self.assertIs(excessive.mode, EngineMode.STALLED)
        self.assertGreaterEqual(excessive.omega_rad_s, 0.0)

    def test_starter_adds_torque_and_reaches_running_without_setting_rpm(self) -> None:
        state = EngineState(0.0, EngineMode.OFF)
        first = self.model.integrate_standalone(
            state, EngineCommand(start_request=True), 0.0, 1.0 / 240.0
        )
        self.assertIs(first.state.mode, EngineMode.CRANKING)
        self.assertGreater(first.prepared.starter_torque_nm, 0.0)
        self.assertLess(first.state.rpm, self.asset.fire_rpm)
        state = first.state
        for _ in range(480):
            state = self.model.integrate_standalone(
                state, EngineCommand(start_request=True), 0.0, 1.0 / 240.0
            ).state
            if state.mode is EngineMode.RUNNING:
                break
        self.assertIs(state.mode, EngineMode.RUNNING)

    def test_limiter_cuts_authority_but_backdrive_can_exceed_limit(self) -> None:
        state = EngineState(rpm_to_rad_s(7100.0), EngineMode.RUNNING, 1.0)
        result = self.model.integrate_standalone(
            state,
            EngineCommand(1.0),
            clutch_reaction_nm=-900.0,
            dt=1.0 / 240.0,
        )
        self.assertTrue(result.prepared.trial.next_controller_state.limiter_cut)
        self.assertLessEqual(result.prepared.free_torque_nm, 0.0)
        self.assertGreater(result.state.rpm, 7100.0)
        self.assertNotAlmostEqual(result.state.rpm, self.asset.rev_limit_rpm)

    def test_backward_euler_residual_and_timestep_refinement(self) -> None:
        reference = None
        errors = []
        finals = []
        for hz in (60, 120, 240, 1920):
            model = EngineModel(self.asset)
            state = EngineState(rpm_to_rad_s(1200.0), EngineMode.RUNNING, 1.0)
            max_residual = 0.0
            for _ in range(int(0.25 * hz)):
                step = model.integrate_standalone(state, EngineCommand(1.0), 0.0, 1.0 / hz)
                max_residual = max(max_residual, step.nonlinear_residual_nms)
                state = step.state
            self.assertLess(max_residual, 1e-8)
            finals.append(state.rpm)
        reference = finals[-1]
        errors = [abs(value - reference) for value in finals[:-1]]
        self.assertGreater(errors[0], errors[1])
        self.assertGreater(errors[1], errors[2])

    @unittest.expectedFailure
    def test_naive_post_integration_rpm_clamp_conserves_angular_impulse(self) -> None:
        inertia = 0.32
        initial = rpm_to_rad_s(8180.0)
        torque = 500.0
        dt = 1.0 / 60.0
        unclamped = initial + torque * dt / inertia
        clamped = min(unclamped, rpm_to_rad_s(8200.0))
        expected_impulse = torque * dt
        actual_impulse = inertia * (clamped - initial)
        self.assertAlmostEqual(actual_impulse, expected_impulse, places=9)

    @unittest.skipUnless(
        os.environ.get("TARGET_ENGINE_LOW_SPEED_DATA"),
        "target low-speed combustion/starter/stall fixture is not available",
    )
    def test_target_low_speed_start_stall_fixture(self) -> None:
        self.fail("external fixture adapter intentionally not bundled")


class TestCoupledDrivetrain(unittest.TestCase):
    def setUp(self) -> None:
        self.asset = load_asset()
        self.model = EngineModel(self.asset)

    def _solve(self, capacity: float, mapping=(4.5, 4.5), wheel_scale=1.0):
        engine = EngineState(rpm_to_rad_s(2000.0), EngineMode.RUNNING, 0.5)
        owner = EngineOwner(self.model, engine)
        dt = 1.0 / 120.0
        ticket = owner.begin_substep(EngineCommand(0.5), dt)
        wheels = (engine.omega_rad_s / 9.0 * wheel_scale,) * 2
        result = solve_coupled_drivetrain_substep(
            owner,
            ticket,
            CoupledDrivetrainState(engine.omega_rad_s, wheels),
            CoupledDrivetrainConfig((1.2, 1.2), mapping, capacity),
            (0.0, 0.0),
            dt,
        )
        return result

    def test_high_capacity_clutch_locks_and_rows_close(self) -> None:
        result = self._solve(1000.0)
        self.assertIs(result.clutch_mode, ClutchSolveMode.LOCKED)
        self.assertLess(abs(result.clutch_relative_speed_rad_s), 1e-10)
        self.assertLess(result.engine_row_residual_nms, 1e-9)
        self.assertLess(max(map(abs, result.wheel_row_residual_nms)), 1e-9)

    def test_low_capacity_clutch_slips_at_capacity(self) -> None:
        result = self._solve(15.0, wheel_scale=0.7)
        self.assertIs(result.clutch_mode, ClutchSolveMode.SLIPPING)
        self.assertAlmostEqual(abs(result.clutch_reaction_on_engine_nm), 15.0, places=9)
        self.assertGreater(abs(result.clutch_relative_speed_rad_s), 1.0)

    def test_neutral_mapping_does_not_rewrite_wheels(self) -> None:
        result = self._solve(1000.0, mapping=(0.0, 0.0), wheel_scale=1.4)
        self.assertIs(result.clutch_mode, ClutchSolveMode.NEUTRAL)
        initial = rpm_to_rad_s(2000.0) / 9.0 * 1.4
        for wheel in result.state.wheel_omega_rad_s:
            self.assertAlmostEqual(wheel, initial, places=12)

    def test_reverse_signed_mapping_locks_without_state_rewrite(self) -> None:
        result = self._solve(1000.0, mapping=(-4.5, -4.5), wheel_scale=-1.0)
        self.assertIs(result.clutch_mode, ClutchSolveMode.LOCKED)
        self.assertLess(abs(result.clutch_relative_speed_rad_s), 1e-10)


if __name__ == "__main__":
    unittest.main()

