from __future__ import annotations

from dataclasses import replace
import math
import unittest

from engine_calibration_reference.engine_model import EngineCommand
from engine_calibration_reference.steering_reference_v2 import DeviceKind, SteeringCommand
from engine_calibration_reference.tire_host_contract import (
    FinalContactKinematics,
    SuspensionContactPacket,
    adapt_contact,
)
from engine_calibration_reference.accepted_tire_adapter import make_reference_model
from engine_calibration_reference.unified_vehicle_fixture import (
    SuspensionBackend,
    UnifiedDomainError,
    UnifiedVehicleCommand,
    UnifiedVehicleConfig,
    UnifiedVehicleFixture,
)


def reference_command(steer: float = 0.0) -> UnifiedVehicleCommand:
    return UnifiedVehicleCommand(
        engine=EngineCommand(0.28),
        steering=SteeringCommand(DeviceKind.GAMEPAD, steer),
    )


class TestUnifiedCrossSystemClosure(unittest.TestCase):
    def test_both_backends_execute_real_paths_and_atomic_commit(self) -> None:
        for backend in SuspensionBackend:
            system = UnifiedVehicleFixture.synthetic()
            result = None
            for _ in range(8):
                result = system.step(reference_command(0.20), 1.0 / 120.0, backend)
            assert result is not None
            self.assertTrue(result.calls.all_required_paths_executed)
            self.assertTrue(result.transaction.committed_exactly_once)
            self.assertLess(result.residual_scaled_inf, 2.0e-6)
            self.assertEqual(result.action_reaction_inf_n, 0.0)
            self.assertEqual(result.aero_action_reaction_inf_n, 0.0)
            self.assertEqual(
                tuple(a + b for a, b in zip(result.vehicle_contact_force_n, result.road_contact_reaction_n)),
                (0.0, 0.0, 0.0),
            )
            self.assertEqual(
                tuple(a + b for a, b in zip(result.aero_force_at_cg_n, result.air_reaction_force_n)),
                (0.0, 0.0, 0.0),
            )
            self.assertGreater(result.damper_dissipation_w, 0.0)
            self.assertGreater(result.arb_energy_j, 0.0)
            self.assertGreater(abs(result.front_intrinsic_mz_chassis_nm), 1.0)
            self.assertEqual(
                result.front_intrinsic_mz_chassis_nm,
                result.front_intrinsic_mz_steering_input_nm,
            )
            self.assertTrue(
                any(abs(state.sgamma) > 0.0 for state in result.state.tires)
            )
            self.assertTrue(
                all(corner.tire.__class__.__module__.endswith("accepted_tire_adapter") for corner in result.corners)
            )

    def test_dynamic_maneuvers_generate_trajectory_and_cross_corner_response(self) -> None:
        summaries = {}
        for backend in SuspensionBackend:
            system = UnifiedVehicleFixture.synthetic()
            for index in range(36):
                steer = 0.0 if index < 6 else 0.18
                result = system.step(reference_command(steer), 1.0 / 120.0, backend)
            mechanics = system.state.mechanics
            summaries[backend] = mechanics
            self.assertGreater(abs(mechanics.world_y_m), 2.0e-3)
            self.assertGreater(abs(mechanics.yaw_rate_rad_s), 5.0e-3)
            self.assertGreater(
                max(mechanics.normal_loads_n) - min(mechanics.normal_loads_n),
                100.0,
            )
            self.assertLess(result.residual_scaled_inf, 2.0e-6)
        self.assertLess(
            abs(
                summaries[SuspensionBackend.MAPPED_KC_MASSLESS].yaw_rate_rad_s
                - summaries[SuspensionBackend.DYNAMIC_UNSPRUNG].yaw_rate_rad_s
            ),
            0.01,
        )

        # A combined brake-in-turn/split-mu step is a different coupled branch,
        # not another copy of the nominal step-steer assertion.
        system = UnifiedVehicleFixture.synthetic()
        peak_load_spread = 0.0
        for index in range(36):
            braking = index >= 12
            command = UnifiedVehicleCommand(
                engine=EngineCommand(0.05),
                steering=SteeringCommand(DeviceKind.GAMEPAD, 0.12),
                wheel_external_torque_nm=(-280.0, -280.0, -360.0, -360.0) if braking else (0.0, 0.0, 0.0, 0.0),
                surface_mu_x=(1.0, 0.55, 1.0, 0.55),
                surface_mu_y=(1.0, 0.55, 1.0, 0.55),
            )
            result = system.step(command, 1.0 / 120.0, SuspensionBackend.DYNAMIC_UNSPRUNG)
            loads = result.state.mechanics.normal_loads_n
            peak_load_spread = max(peak_load_spread, max(loads) - min(loads))
        self.assertGreater(peak_load_spread, 500.0)
        self.assertGreater(abs(system.state.mechanics.yaw_rate_rad_s), 1.0e-3)

    def test_timestep_and_solver_iteration_refinement(self) -> None:
        endpoints = {}
        for hz in (60, 120, 240):
            system = UnifiedVehicleFixture.synthetic()
            dt = 1.0 / hz
            for index in range(round(0.25 * hz)):
                time_s = (index + 1) * dt
                system.step(
                    reference_command(0.16 if time_s >= 0.05 else 0.0),
                    dt,
                    SuspensionBackend.MAPPED_KC_MASSLESS,
                )
            endpoints[hz] = system.state.mechanics
        y_coarse = abs(endpoints[60].world_y_m - endpoints[120].world_y_m)
        y_fine = abs(endpoints[120].world_y_m - endpoints[240].world_y_m)
        yaw_coarse = abs(endpoints[60].yaw_rad - endpoints[120].yaw_rad)
        yaw_fine = abs(endpoints[120].yaw_rad - endpoints[240].yaw_rad)
        self.assertLess(y_fine, y_coarse)
        self.assertLess(yaw_fine, yaw_coarse)

        terminal = []
        for max_evaluations in (45, 120):
            config = replace(
                UnifiedVehicleConfig(),
                max_nonlinear_evaluations=max_evaluations,
            )
            system = UnifiedVehicleFixture.synthetic(config=config)
            for _ in range(8):
                result = system.step(
                    reference_command(0.14),
                    1.0 / 120.0,
                    SuspensionBackend.MAPPED_KC_MASSLESS,
                )
            terminal.append(system.state.mechanics)
            self.assertLess(result.residual_scaled_inf, 2.0e-6)
        self.assertAlmostEqual(terminal[0].world_y_m, terminal[1].world_y_m, delta=1.0e-12)
        self.assertAlmostEqual(terminal[0].yaw_rad, terminal[1].yaw_rad, delta=1.0e-12)

    def test_domain_failures_abort_every_owner_without_state_advance(self) -> None:
        cases = (
            (
                UnifiedVehicleCommand(engine=EngineCommand(0.3), wind_body_m_s=(0.0, -8.0, 0.0)),
                1.0 / 120.0,
            ),
            (
                UnifiedVehicleCommand(
                    engine=EngineCommand(0.3),
                    steering=SteeringCommand(DeviceKind.AI_CURVATURE, 1.0),
                ),
                0.2,
            ),
        )
        for command, dt in cases:
            system = UnifiedVehicleFixture.synthetic()
            snapshot = system.state
            with self.assertRaises(UnifiedDomainError):
                system.step(command, dt, SuspensionBackend.MAPPED_KC_MASSLESS)
            self.assertIs(system.state, snapshot)
            self.assertIs(system.engine_owner.state, snapshot.engine)
            self.assertIs(system.gearbox_owner.state, snapshot.gearbox)
            self.assertIs(system.steering_owner.state, snapshot.steering)
            self.assertIs(system.tire_owner.state, snapshot.tires)
            self.assertIs(system.mechanical_owner.state, snapshot.mechanics)
            self.assertEqual(set(system.last_transaction_audit.aborted), {
                "engine", "gearbox", "steering", "tires", "mechanics"
            })
            self.assertEqual(system.last_transaction_audit.committed, ())

    def test_normal_authorities_are_mutually_exclusive_and_replay_is_deterministic(self) -> None:
        model = make_reference_model()
        kinematics = FinalContactKinematics(15.0, 0.0, 48.0, 0.0)
        with self.assertRaises(ValueError):
            adapt_contact(
                SuspensionContactPacket(
                    "MAPPED_KC_MASSLESS",
                    "RIGID_NORMAL",
                    True,
                    kinematics,
                    solved_normal_force_n=4000.0,
                    compression_m=0.02,
                ),
                model,
                1.0 / 120.0,
            )
        with self.assertRaises(ValueError):
            adapt_contact(
                SuspensionContactPacket(
                    "DYNAMIC_UNSPRUNG",
                    "COMPLIANT_TIRE_VERTICAL",
                    True,
                    kinematics,
                    solved_normal_impulse_ns=4000.0 / 120.0,
                    compression_m=0.02,
                    compression_rate_mps=0.0,
                ),
                model,
                1.0 / 120.0,
            )

        systems = (UnifiedVehicleFixture.synthetic(), UnifiedVehicleFixture.synthetic())
        for system in systems:
            for index in range(16):
                steer = 0.14 * math.sin(2.0 * math.pi * 1.2 * (index + 1) / 120.0)
                system.step(reference_command(steer), 1.0 / 120.0, SuspensionBackend.MAPPED_KC_MASSLESS)
        self.assertEqual(systems[0].state, systems[1].state)


if __name__ == "__main__":
    unittest.main()
