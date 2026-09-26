from __future__ import annotations

from dataclasses import replace
import math
import unittest

from engine_calibration_reference.accepted_tire_adapter import (
    FrictionContactHostRequired,
    TireState,
    make_reference_model,
)
from engine_calibration_reference.engine_model import EngineCommand
from engine_calibration_reference.steering_reference_v2 import DeviceKind, SteeringCommand
from engine_calibration_reference.tire_host_contract import ContactInput
from engine_calibration_reference.tire_v2_reference_v1_7 import TireMode
from engine_calibration_reference.unified_vehicle_fixture import (
    BrakeRegime,
    ClutchRegime,
    ContactRegime,
    RigidBodyDynamicsHostRequired,
    SteeringCausality,
    SuspensionBackend,
    UnifiedVehicleCommand,
    UnifiedVehicleConfig,
    UnifiedDomainError,
    UnifiedSolveError,
    UnifiedVehicleFixture,
)
from engine_calibration_reference.vehicle_controls_reference import (
    BrakeAssistController,
    DriverCommand,
    DriverDirectionFSM,
    RequestedDirection,
)


class TestAcceptedTireAdapter(unittest.TestCase):
    def test_v18_empirical_state_is_not_projected_and_camber_is_instant(self) -> None:
        model = make_reference_model()
        out = model.step(
            TireState(),
            ContactInput(
                in_contact=True,
                normal_load_n=4000.0,
                velocity_x_mps=15.0,
                velocity_y_mps=-80.0,
                wheel_omega_radps=120.0,
                camber_rad=math.radians(2.0),
                dt_s=0.2,
            ),
        )
        characteristic, _ = model.params.load_map.evaluate(4000.0)
        self.assertIs(out.state_next.mode, TireMode.HANDLING)
        self.assertGreater(abs(out.state_next.sy), characteristic.sy_slide)
        self.assertNotEqual(out.state_next.sgamma, 0.0)
        self.assertFalse(out.state_was_bounded)

    def test_contact_power_uses_complete_force_and_spin_torque_ledger(self) -> None:
        model = make_reference_model()
        inp = ContactInput(
            in_contact=True,
            normal_load_n=4000.0,
            velocity_x_mps=15.0,
            velocity_y_mps=0.8,
            wheel_omega_radps=55.0,
            camber_rad=0.0,
            dt_s=1.0 / 120.0,
        )
        out = model.step(TireState(), inp)
        expected = (
            -out.force_x_n * out.raw_slip_velocity_x_mps
            - out.force_y_n * out.raw_slip_velocity_y_mps
            + out.moment_y_nm * inp.wheel_omega_radps
        )
        self.assertAlmostEqual(out.contact_power_w, expected, places=12)
        self.assertAlmostEqual(out.gross_contact_loss_proxy_w, max(0.0, -expected), places=12)

    def test_final_airborne_classification_clears_patch_state(self) -> None:
        model = make_reference_model()
        previous = TireState(0.2, -0.1, 0.03, TireMode.HANDLING)
        out = model.step(
            previous,
            ContactInput(False, 0.0, 15.0, 0.0, 45.0, 0.0, 1.0 / 120.0),
        )
        self.assertEqual(out.state_next, TireState())
        self.assertEqual((out.force_x_n, out.force_y_n, out.moment_z_nm), (0.0, 0.0, 0.0))

    def test_low_speed_requires_world_contact_response(self) -> None:
        model = make_reference_model()
        with self.assertRaises(FrictionContactHostRequired):
            model.step(
                TireState(),
                ContactInput(True, 4000.0, 0.2, 0.0, 0.1, 0.0, 1.0 / 120.0),
            )

    def test_effective_radius_is_one_same_step_host_tire_quantity(self) -> None:
        model = make_reference_model()
        loaded_radius = model.unloaded_radius_m - 0.025
        radius = model.effective_radius(4000.0, 55.0, loaded_radius)
        inp = ContactInput(
            True,
            4000.0,
            15.0,
            0.0,
            55.0,
            0.0,
            1.0 / 120.0,
            loaded_radius_m=loaded_radius,
            effective_radius_m=radius,
        )
        out = model.step(TireState(), inp)
        self.assertAlmostEqual(out.effective_radius_m, radius, places=14)
        with self.assertRaises(ValueError):
            model.step(TireState(), replace(inp, effective_radius_m=radius + 0.001))


class TestSteeringCausalityAndSpatialLoad(unittest.TestCase):
    @staticmethod
    def command(steer: float = 0.12) -> UnifiedVehicleCommand:
        return UnifiedVehicleCommand(
            engine=EngineCommand(0.25),
            steering=SteeringCommand(DeviceKind.GAMEPAD, steer),
        )

    def test_position_reaction_consumes_one_full_spatial_projection(self) -> None:
        system = UnifiedVehicleFixture.synthetic()
        result = system.step(self.command(), 1.0 / 120.0, SuspensionBackend.MAPPED_KC_MASSLESS)
        self.assertEqual(result.steering_reaction.load_source, "KC_SPATIAL_JTW_FULL_WRENCH")
        self.assertAlmostEqual(
            result.steering_reaction.road_generalized_torque_nm,
            result.steering_road_generalized_load_nm,
            places=12,
        )
        self.assertAlmostEqual(
            result.steering_reaction.intrinsic_mz_generalized_torque_nm,
            result.steering_intrinsic_mz_generalized_contribution_nm,
            places=12,
        )
        self.assertEqual(result.calls.steering_spatial_jtw, 2)
        self.assertLessEqual(result.normal_velocity_residual_inf_m_s, 2.0e-8)
        self.assertLessEqual(result.normal_complementarity_inf_n_m, 1.0e-7)
        self.assertEqual(result.contact_geometry_quality, "REDUCED_FLAT_ROAD_HEIGHT_SIGNAL")

    def test_contact_mode_rows_keep_gap_and_force_units_separate(self) -> None:
        system = UnifiedVehicleFixture.synthetic()
        modes = (
            ContactRegime.CONTACT,
            ContactRegime.CONTACT,
            ContactRegime.AIRBORNE,
            ContactRegime.AIRBORNE,
        )
        scales = system._row_scales(SuspensionBackend.MAPPED_KC_MASSLESS, modes)
        labels = system._row_labels(SuspensionBackend.MAPPED_KC_MASSLESS, modes)
        self.assertEqual(tuple(scales[13:17]), (0.03, 0.03, 4000.0, 4000.0))
        self.assertIn("rigid_contact_geometry", labels[13])
        self.assertIn("airborne_zero_normal_reaction", labels[15])

    def test_tire_consumes_final_contact_frame_point_velocity_and_wrench(self) -> None:
        result = UnifiedVehicleFixture.synthetic().step(
            self.command(0.12),
            1.0 / 120.0,
            SuspensionBackend.MAPPED_KC_MASSLESS,
        )

        def dot(a, b):
            return sum(x * y for x, y in zip(a, b))

        for corner in result.corners:
            tx = corner.contact_tangent_x_body
            ty = corner.contact_tangent_y_body
            normal = corner.contact_normal_body
            velocity = corner.contact_velocity_body_mps
            self.assertAlmostEqual(dot(tx, tx), 1.0, places=12)
            self.assertAlmostEqual(dot(ty, ty), 1.0, places=12)
            self.assertAlmostEqual(dot(normal, normal), 1.0, places=12)
            self.assertAlmostEqual(dot(tx, ty), 0.0, places=12)
            self.assertAlmostEqual(dot(tx, normal), 0.0, places=12)
            self.assertAlmostEqual(dot(ty, normal), 0.0, places=12)
            self.assertAlmostEqual(corner.contact_velocity_x_mps, dot(velocity, tx), places=12)
            self.assertAlmostEqual(corner.contact_velocity_y_mps, dot(velocity, ty), places=12)
            expected_force = tuple(
                tx[axis] * corner.tire.force_x_n
                + ty[axis] * corner.tire.force_y_n
                + normal[axis] * corner.tire.force_z_n
                for axis in range(3)
            )
            for actual, expected in zip(corner.force_body_n, expected_force):
                self.assertAlmostEqual(actual, expected, places=10)
        self.assertGreater(abs(result.corners[0].contact_tangent_x_body[1]), 1.0e-4)

    def test_legacy_trail_scrub_knobs_cannot_double_count_spatial_load(self) -> None:
        a = UnifiedVehicleFixture.synthetic(
            config=UnifiedVehicleConfig(mechanical_trail_m=0.0, scrub_radius_m=0.0)
        )
        b = UnifiedVehicleFixture.synthetic(
            config=UnifiedVehicleConfig(mechanical_trail_m=0.25, scrub_radius_m=0.15)
        )
        ra = a.step(self.command(), 1.0 / 120.0, SuspensionBackend.MAPPED_KC_MASSLESS)
        rb = b.step(self.command(), 1.0 / 120.0, SuspensionBackend.MAPPED_KC_MASSLESS)
        self.assertAlmostEqual(
            ra.steering_road_generalized_load_nm,
            rb.steering_road_generalized_load_nm,
            places=12,
        )

    def test_torque_mode_is_same_step_coupled_and_mutually_exclusive(self) -> None:
        cfg = UnifiedVehicleConfig(steering_causality=SteeringCausality.TORQUE_DRIVEN)
        system = UnifiedVehicleFixture.synthetic(config=cfg)
        command = UnifiedVehicleCommand(
            engine=EngineCommand(0.25),
            steering=SteeringCommand(DeviceKind.GAMEPAD, 0.0),
            steering_driver_torque_nm=0.3,
        )
        result = system.step(command, 1.0 / 120.0, SuspensionBackend.MAPPED_KC_MASSLESS)
        self.assertIs(result.steering_causality, SteeringCausality.TORQUE_DRIVEN)
        self.assertIsNotNone(result.torque_rack_evaluation)
        self.assertNotEqual(result.state.steering.rack_q, 0.0)
        self.assertAlmostEqual(
            result.torque_rack_evaluation.road_generalized_torque_nm,
            result.steering_road_generalized_load_nm,
            places=10,
        )
        self.assertTrue(result.transaction.committed_exactly_once)
        with self.assertRaises(ValueError):
            UnifiedVehicleFixture.synthetic(config=cfg).step(
                replace(command, steering=SteeringCommand(DeviceKind.GAMEPAD, 0.1)),
                1.0 / 120.0,
                SuspensionBackend.MAPPED_KC_MASSLESS,
            )
        with self.assertRaises(ValueError):
            UnifiedVehicleFixture.synthetic().step(
                replace(self.command(), steering_driver_torque_nm=0.2),
                1.0 / 120.0,
                SuspensionBackend.MAPPED_KC_MASSLESS,
            )


class TestBrakeAssistsAndDriverFSM(unittest.TestCase):
    def test_mapped_airborne_keeps_internal_suspension_and_zeroes_road_wrench(self) -> None:
        system = UnifiedVehicleFixture.synthetic()
        result = system.step(
            UnifiedVehicleCommand(
                engine=EngineCommand(0.0),
                road_heights_m=(-0.040, 0.0, 0.0, 0.0),
            ),
            1.0 / 120.0,
            SuspensionBackend.MAPPED_KC_MASSLESS,
        )
        airborne = result.corners[0]
        grounded_partner = result.corners[1]
        self.assertIs(airborne.contact_regime, ContactRegime.AIRBORNE)
        self.assertEqual(airborne.solved_normal_force_n, 0.0)
        self.assertEqual(airborne.tire.force_z_n, 0.0)
        self.assertGreater(airborne.contact_gap_m, 0.0)
        self.assertNotEqual(airborne.suspension_generalized_spring_n, 0.0)
        self.assertNotEqual(airborne.suspension_generalized_damper_n, 0.0)
        self.assertLess(
            airborne.suspension_generalized_arb_n
            * grounded_partner.suspension_generalized_arb_n,
            0.0,
        )
        self.assertAlmostEqual(
            result.state.mechanics.suspension_qdot_m_s[0],
            (
                result.state.mechanics.suspension_q_m[0]
                - 0.0
            ) * 120.0,
            places=10,
        )
        self.assertTrue(result.contact_active_set_events)
        self.assertTrue(result.transaction.committed_exactly_once)

    def test_assists_only_emit_capacities_and_engine_authority(self) -> None:
        controller = BrakeAssistController()
        out = controller.evaluate(
            service_brake_request=0.8,
            parking_brake_request=0.0,
            body_u_m_s=15.0,
            yaw_rate_rad_s=0.0,
            steering_curvature_1pm=0.05,
            wheel_omega_rad_s=(0.0, 45.0, 80.0, 45.0),
            effective_radius_m=(0.30, 0.30, 0.30, 0.30),
            driven_wheels=(False, False, True, True),
        )
        self.assertLess(out.abs_modulation[0], 1.0)
        self.assertLess(out.engine_positive_torque_limit, 1.0)
        self.assertGreater(out.tcs_brake_capacity_nm[2], 0.0)
        self.assertEqual(sum(value > 0.0 for value in out.esc_brake_capacity_nm), 1)
        self.assertTrue(
            all(
                applied <= limit + 1.0e-12
                for applied, limit in zip(out.service_request_capacity_nm, controller.config.service_capacity_nm)
            )
        )
        self.assertEqual(
            out.total_brake_capacity_nm,
            tuple(
                out.service_capacity_nm[index] + out.parking_capacity_nm[index]
                for index in range(4)
            ),
        )

    def test_parking_channel_bypasses_abs_and_stays_independent(self) -> None:
        controller = BrakeAssistController()
        out = controller.evaluate(
            service_brake_request=0.0,
            parking_brake_request=1.0,
            body_u_m_s=15.0,
            yaw_rate_rad_s=0.0,
            steering_curvature_1pm=0.0,
            wheel_omega_rad_s=(50.0, 50.0, 0.0, 0.0),
            effective_radius_m=(0.30, 0.30, 0.30, 0.30),
            driven_wheels=(False, False, False, False),
        )
        self.assertEqual(out.service_request_capacity_nm, (0.0, 0.0, 0.0, 0.0))
        self.assertEqual(out.service_capacity_nm, (0.0, 0.0, 0.0, 0.0))
        self.assertEqual(out.total_brake_capacity_nm, out.parking_capacity_nm)

    def test_service_brake_actual_reaction_is_solver_bounded(self) -> None:
        system = UnifiedVehicleFixture.synthetic()
        command = UnifiedVehicleCommand(
            engine=EngineCommand(0.0),
            service_brake_request=0.45,
        )
        speed_before = system.state.mechanics.body_u_m_s
        result = system.step(command, 1.0 / 120.0, SuspensionBackend.MAPPED_KC_MASSLESS)
        self.assertTrue(all(regime is not BrakeRegime.OPEN for regime in result.brake_regimes))
        self.assertTrue(
            all(abs(actual) <= capacity + 1.0e-8 for actual, capacity in zip(result.actual_brake_torque_nm, result.brake_capacity_nm))
        )
        self.assertTrue(all(margin >= -1.0e-8 for margin in result.brake_capacity_margin_nm))
        self.assertEqual(result.brake_internal_action_reaction_inf_nm, 0.0)
        self.assertLess(result.state.mechanics.body_u_m_s, speed_before + 1.0e-3)

    def test_parking_brake_releases_finite_capacity_locked_clutch(self) -> None:
        system = UnifiedVehicleFixture.synthetic()
        result = system.step(
            UnifiedVehicleCommand(
                engine=EngineCommand(0.0),
                parking_brake_request=1.0,
            ),
            1.0 / 240.0,
            SuspensionBackend.MAPPED_KC_MASSLESS,
        )
        self.assertIs(result.clutch_regime, ClutchRegime.SLIP_POSITIVE)
        self.assertAlmostEqual(result.clutch_capacity_margin_nms, 0.0, places=12)
        self.assertTrue(result.clutch_active_set_events)
        self.assertLessEqual(result.residual_scaled_inf, system.config.residual_tolerance)

    def test_reduced_platform_refuses_to_fake_missing_pitch_dynamics(self) -> None:
        system = UnifiedVehicleFixture.synthetic()
        snapshot = system.state
        with self.assertRaisesRegex(
            RigidBodyDynamicsHostRequired,
            "RIGID_BODY_DYNAMICS_HOST_REQUIRED",
        ):
            system.step(
                UnifiedVehicleCommand(
                    engine=EngineCommand(0.0),
                    service_brake_request=1.0,
                ),
                1.0 / 60.0,
                SuspensionBackend.MAPPED_KC_MASSLESS,
            )
        self.assertIs(system.state, snapshot)
        self.assertEqual(system.last_transaction_audit.committed, ())

    def test_standstill_hold_stops_at_real_contact_host_boundary(self) -> None:
        with self.assertRaises(FrictionContactHostRequired):
            UnifiedVehicleFixture.synthetic(speed_m_s=0.2).step(
                UnifiedVehicleCommand(
                    engine=EngineCommand(0.0),
                    parking_brake_request=1.0,
                ),
                1.0 / 120.0,
                SuspensionBackend.MAPPED_KC_MASSLESS,
            )

    def test_direction_change_brakes_before_reverse_and_commits_intent_only(self) -> None:
        fsm = DriverDirectionFSM()
        requested = DriverCommand(
            throttle_request=1.0,
            requested_direction=RequestedDirection.REVERSE,
        )
        moving = fsm.prepare(requested, signed_speed_m_s=8.0, dt=0.05)
        self.assertTrue(moving.transition_blocked_by_motion)
        self.assertEqual(moving.engine.throttle_request, 0.0)
        self.assertEqual(moving.service_brake_request, 1.0)
        self.assertIsNone(moving.gearbox.requested_gear)
        self.assertEqual(fsm.state.selected_direction, RequestedDirection.FORWARD)
        fsm.abort(moving)
        for _ in range(3):
            trial = fsm.prepare(requested, signed_speed_m_s=0.0, dt=0.05)
            if trial.transition_blocked_by_motion:
                self.assertEqual(trial.service_brake_request, 1.0)
                self.assertIsNone(trial.gearbox.requested_gear)
            fsm.commit(trial)
        self.assertEqual(fsm.state.selected_direction, RequestedDirection.REVERSE)
        self.assertEqual(trial.gearbox.requested_gear, "R")

    def test_neutral_is_immediate_and_same_direction_does_not_force_first_gear(self) -> None:
        fsm = DriverDirectionFSM()
        steady = fsm.prepare(DriverCommand(requested_direction=RequestedDirection.FORWARD), 12.0, 0.01)
        self.assertIsNone(steady.gearbox.requested_gear)
        fsm.abort(steady)
        neutral = fsm.prepare(DriverCommand(requested_direction=RequestedDirection.NEUTRAL), 12.0, 0.01)
        self.assertFalse(neutral.transition_blocked_by_motion)
        self.assertEqual(neutral.gearbox.requested_gear, "N")
        fsm.commit(neutral)

    def test_driver_trial_is_bound_to_vehicle_commit_and_abort(self) -> None:
        system = UnifiedVehicleFixture.synthetic()
        fsm = DriverDirectionFSM()
        before_speed = system.state.mechanics.body_u_m_s
        out = system.step_driver(
            fsm,
            DriverCommand(
                throttle_request=1.0,
                requested_direction=RequestedDirection.REVERSE,
            ),
            1.0 / 120.0,
            SuspensionBackend.MAPPED_KC_MASSLESS,
        )
        self.assertTrue(out.direction_trial.transition_blocked_by_motion)
        self.assertEqual(out.direction_state.selected_direction, RequestedDirection.FORWARD)
        self.assertIsNone(out.direction_trial.gearbox.requested_gear)
        self.assertLess(out.vehicle.state.mechanics.body_u_m_s, before_speed)
        self.assertTrue(out.vehicle.transaction.committed_exactly_once)

        system = UnifiedVehicleFixture.synthetic()
        fsm = DriverDirectionFSM()
        fsm_snapshot = fsm.state
        vehicle_snapshot = system.state
        with self.assertRaises(UnifiedDomainError):
            system.step_driver(
                fsm,
                DriverCommand(),
                1.0 / 120.0,
                SuspensionBackend.MAPPED_KC_MASSLESS,
                environment_command=UnifiedVehicleCommand(
                    engine=EngineCommand(0.0),
                    wind_body_m_s=(0.0, -8.0, 0.0),
                ),
            )
        self.assertIs(fsm.state, fsm_snapshot)
        self.assertIs(system.state, vehicle_snapshot)


class TestIdealOpenDifferential(unittest.TestCase):
    def test_mapping_is_power_conjugate_and_does_not_lock_side_speeds(self) -> None:
        system = UnifiedVehicleFixture.synthetic()
        asset = system.gearbox_owner.controller.asset
        wheel_speeds = (0.0, 0.0, 40.0, 60.0)
        mapping = asset.mapping_for("3")
        clutch_speed = asset.clutch_side_speed("3", wheel_speeds)
        self.assertAlmostEqual(clutch_speed, 3.0 * 1.35 * 0.5 * (40.0 + 60.0), places=12)
        impulse = 17.0
        wheel_impulses = asset.wheel_reaction_impulses("3", impulse)
        self.assertAlmostEqual(
            sum(speed * reaction for speed, reaction in zip(wheel_speeds, wheel_impulses))
            + clutch_speed * impulse,
            0.0,
            places=12,
        )
        self.assertEqual(mapping[:2], (0.0, 0.0))
        self.assertEqual(mapping[2], mapping[3])

        result = system.step(
            UnifiedVehicleCommand(
                engine=EngineCommand(0.2),
                wheel_external_torque_nm=(0.0, 0.0, 20.0, -20.0),
            ),
            1.0 / 120.0,
            SuspensionBackend.MAPPED_KC_MASSLESS,
        )
        self.assertGreater(
            abs(result.state.mechanics.wheel_omega_rad_s[2] - result.state.mechanics.wheel_omega_rad_s[3]),
            1.0e-7,
        )


class TestAeroWrenchAndSolverEvidence(unittest.TestCase):
    def test_aero_reference_velocity_includes_body_omega_cross_r(self) -> None:
        system = UnifiedVehicleFixture.synthetic()
        _, _, _, relative = system._aero(
            body_linear_velocity=(15.0, 0.0, 0.0),
            body_angular_velocity=(0.0, 1.0, 0.0),
            heave=0.0,
            pitch=0.0,
            roll=0.0,
            steering=0.0,
            wind_at_reference_body=(0.0, 0.0, 0.0),
        )
        reference = system.aero_map.reference.ref_point_vehicle_m
        self.assertAlmostEqual(relative[0], 15.0 + reference[2], places=12)
        self.assertAlmostEqual(relative[1], 0.0, places=12)
        self.assertAlmostEqual(relative[2], -reference[0], places=12)

    def test_road_and_air_reactions_expose_full_wrench_and_solver_provenance(self) -> None:
        result = UnifiedVehicleFixture.synthetic().step(
            UnifiedVehicleCommand(engine=EngineCommand(0.2)),
            1.0 / 120.0,
            SuspensionBackend.MAPPED_KC_MASSLESS,
        )
        self.assertEqual(result.action_reaction_inf_n, 0.0)
        self.assertEqual(result.action_reaction_moment_inf_nm, 0.0)
        self.assertEqual(result.aero_action_reaction_inf_n, 0.0)
        self.assertEqual(result.aero_action_reaction_moment_inf_nm, 0.0)
        self.assertEqual(result.aero_wrench_frame, "BODY_X_FORWARD_Y_LEFT_Z_UP_ABOUT_CG")
        self.assertIn("REDUCED_FLAT_ROAD", result.aero_ground_reference_quality)
        self.assertIn(result.nonlinear_solver_method, ("root-hybr", "least-squares-trf"))
        self.assertNotEqual(result.nonlinear_solver_status, 0)
        self.assertTrue(result.nonlinear_solver_attempts)
        self.assertLessEqual(
            result.nonlinear_evaluations,
            UnifiedVehicleConfig().max_total_nonlinear_evaluations,
        )

    def test_aggregate_nonlinear_budget_failure_does_not_commit(self) -> None:
        config = UnifiedVehicleConfig(
            max_nonlinear_evaluations=1,
            max_total_nonlinear_evaluations=1,
        )
        system = UnifiedVehicleFixture.synthetic(config=config)
        snapshot = system.state
        with self.assertRaises(UnifiedSolveError):
            system.step(
                UnifiedVehicleCommand(engine=EngineCommand(0.2)),
                1.0 / 120.0,
                SuspensionBackend.MAPPED_KC_MASSLESS,
            )
        self.assertIs(system.state, snapshot)
        self.assertEqual(system.last_transaction_audit.committed, ())

    def test_each_owner_commit_fault_rolls_back_the_five_owner_group(self) -> None:
        owner_names = ("engine", "gearbox", "steering", "tires", "mechanics")
        for fault_name in owner_names:
            with self.subTest(fault_owner=fault_name):
                system = UnifiedVehicleFixture.synthetic()
                group_snapshot = system.state
                owners = {
                    "engine": system.engine_owner,
                    "gearbox": system.gearbox_owner,
                    "steering": system.steering_owner,
                    "tires": system.tire_owner,
                    "mechanics": system.mechanical_owner,
                }
                owner_snapshots = {name: owner.state for name, owner in owners.items()}
                fault_owner = owners[fault_name]
                original_commit = fault_owner.commit

                def commit_then_fail(*args, _commit=original_commit):
                    _commit(*args)
                    raise RuntimeError("injected post-commit fault")

                fault_owner.commit = commit_then_fail
                with self.assertRaisesRegex(RuntimeError, "injected post-commit fault"):
                    system.step(
                        UnifiedVehicleCommand(engine=EngineCommand(0.2)),
                        1.0 / 120.0,
                        SuspensionBackend.MAPPED_KC_MASSLESS,
                    )
                self.assertIs(system.state, group_snapshot)
                for name, owner in owners.items():
                    self.assertIs(owner.state, owner_snapshots[name])
                self.assertIn(fault_name, system.last_transaction_audit.rolled_back)
                self.assertFalse(system.last_transaction_audit.committed_exactly_once)


if __name__ == "__main__":
    unittest.main()
