from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import unittest

import numpy as np

from engine_calibration_reference.coupled_vehicle_solver import (
    Axle,
    ClutchMode,
    CoupledVehicleConfig,
    CoupledVehicleState,
    EngineBoundMode,
    TireMode,
    make_consistent_state,
    solve_coupled_vehicle_substep,
)
from engine_calibration_reference.runtime_vehicle_solver import solve_runtime_coupled_vehicle_substep
from engine_calibration_reference.engine_model import (
    EngineAsset,
    EngineCommand,
    EngineMode,
    EngineModel,
    EngineOwner,
    EngineState,
    rad_s_to_rpm,
    rpm_to_rad_s,
)
from engine_calibration_reference.tests.test_coupled_vehicle_solver_v2_0 import rwd_config


ROOT = Path(__file__).resolve().parents[1]


def model() -> EngineModel:
    return EngineModel(EngineAsset.from_json(ROOT / "data" / "synthetic_engine_asset.json"))


class TestCoupledVehicleStress(unittest.TestCase):
    def assert_contract(self, result) -> None:
        self.assertLess(result.scaled_residual_inf, 2.0e-8)
        self.assertLess(abs(result.engine_row_residual_nms), 2.0e-6)
        self.assertLess(max(map(abs, result.wheel_row_residual_nms)), 2.0e-6)
        self.assertLess(abs(result.chassis_row_residual_n_s), 2.0e-5)
        self.assertGreater(result.axle_loads.front_normal_n, 0.0)
        self.assertGreater(result.axle_loads.rear_normal_n, 0.0)
        self.assertGreaterEqual(result.energy.physical_constraint_dissipation_j, -2.0e-6)
        energy_scale = max(
            1.0, result.energy.energy_before_j, result.energy.energy_after_j
        )
        self.assertLess(abs(result.energy.identity_residual_j), 2.0e-9 * energy_scale)

        if result.clutch_mode is ClutchMode.LOCKED:
            self.assertLess(abs(result.clutch_relative_speed_rad_s), 3.0e-7)
            self.assertLessEqual(
                abs(result.clutch_impulse_nms),
                result.clutch_capacity_impulse_nms + 5.0e-7,
            )
        elif result.clutch_mode is not ClutchMode.NEUTRAL:
            self.assertAlmostEqual(
                abs(result.clutch_impulse_nms),
                result.clutch_capacity_impulse_nms,
                delta=5.0e-7,
            )
            self.assertLessEqual(
                result.clutch_impulse_nms * result.clutch_relative_speed_rad_s,
                2.0e-7,
            )
        for mode, impulse, capacity, slip in zip(
            result.tire_modes,
            result.tire_impulses_n_s,
            result.tire_capacity_impulses_n_s,
            result.tire_slip_speeds_m_s,
        ):
            if mode is TireMode.ADHERING:
                self.assertLess(abs(slip), 3.0e-7)
                self.assertLessEqual(abs(impulse), capacity + 5.0e-7)
            else:
                self.assertAlmostEqual(abs(impulse), capacity, delta=5.0e-6)
                self.assertGreaterEqual(impulse * slip, -2.0e-7)

    def test_seeded_random_operating_matrix(self) -> None:
        rng = np.random.default_rng(20260827)
        for case_index in range(40):
            mass = float(rng.uniform(950.0, 2200.0))
            radius = float(rng.uniform(0.27, 0.40))
            wheel_inertia = float(rng.uniform(0.7, 2.2))
            total_ratio = float(rng.uniform(5.0, 13.0))
            target_rpm = float(rng.uniform(850.0, 6200.0))
            wheel_speed = rpm_to_rad_s(target_rpm) / total_ratio
            speed = wheel_speed * radius
            engine_factor = float(rng.uniform(0.72, 1.28))
            engine_rpm = min(7300.0, max(100.0, target_rpm * engine_factor))
            wheelbase = float(rng.uniform(2.3, 3.2))
            cg_to_rear = float(rng.uniform(0.42, 0.58) * wheelbase)
            config = CoupledVehicleConfig(
                mass_kg=mass,
                wheel_inertias_kg_m2=(wheel_inertia, wheel_inertia),
                wheel_radii_m=(radius, radius),
                clutch_speed_mapping=(total_ratio / 2.0, total_ratio / 2.0),
                clutch_capacity_nm=float(rng.uniform(8.0, 1100.0)),
                tire_mu=(float(rng.uniform(0.04, 1.7)),) * 2,
                wheel_axles=(Axle.REAR, Axle.REAR),
                wheelbase_m=wheelbase,
                cg_to_rear_axle_m=cg_to_rear,
                cg_height_m=float(rng.uniform(0.25, 0.75)),
                cd_area_m2=float(rng.uniform(0.4, 1.0)),
                cl_area_m2=float(rng.uniform(0.0, 0.7)),
                aero_front_fraction=float(rng.uniform(0.35, 0.65)),
                rolling_resistance_coefficient=float(rng.uniform(0.006, 0.025)),
            )
            engine = EngineState(
                rpm_to_rad_s(engine_rpm),
                EngineMode.RUNNING,
                float(rng.uniform(0.0, 1.0)),
            )
            state = CoupledVehicleState(engine, (wheel_speed, wheel_speed), speed)
            owner = EngineOwner(model(), engine)
            dt = float(rng.choice((1.0 / 240.0, 1.0 / 120.0, 1.0 / 60.0)))
            engagement = float(rng.choice((0.0, 0.12, 0.45, 1.0)))
            throttle = float(rng.uniform(0.0, 1.0))
            wheel_torque = (
                float(rng.uniform(-350.0, 100.0)),
                float(rng.uniform(-350.0, 100.0)),
            )
            wind = float(rng.uniform(-12.0, 12.0))
            with self.subTest(case=case_index):
                ticket = owner.begin_substep(EngineCommand(throttle), dt)
                result = solve_runtime_coupled_vehicle_substep(
                    owner,
                    ticket,
                    state,
                    config,
                    wheel_torque,
                    dt,
                    clutch_engagement=engagement,
                    wind_speed_m_s=wind,
                )
                self.assert_contract(result)
                self.assertGreaterEqual(result.state.engine.omega_rad_s, 0.0)
                self.assertLessEqual(result.state.engine.rpm, 7500.0 + 1.0e-7)

    def test_reverse_motion_can_activate_unilateral_crank_stop(self) -> None:
        config = replace(
            rwd_config(mu=1.5, clutch_capacity_nm=1000.0),
            rolling_resistance_coefficient=0.0,
            cd_area_m2=0.0,
        )
        speed = -5.0
        wheels = (speed / 0.33, speed / 0.33)
        engine = EngineState(rpm_to_rad_s(200.0), EngineMode.OFF)
        state = CoupledVehicleState(engine, wheels, speed)
        owner = EngineOwner(model(), engine)
        dt = 1.0 / 120.0
        ticket = owner.begin_substep(EngineCommand(0.0, ignition_on=False), dt)
        result = solve_coupled_vehicle_substep(
            owner, ticket, state, config, (0.0, 0.0), dt
        )
        self.assertIs(result.engine_bound_mode, EngineBoundMode.STOPPED)
        self.assertAlmostEqual(result.state.engine.omega_rad_s, 0.0, places=10)
        self.assertGreater(result.crank_stop_impulse_nms, 0.0)
        self.assert_contract(result)

    def test_coupled_backward_euler_refines_toward_small_dt_reference(self) -> None:
        config = rwd_config(mu=1.6, clutch_capacity_nm=1000.0)
        final_speeds: list[float] = []
        duration = 0.06
        for hz in (50, 100, 200, 400):
            initial = make_consistent_state(
                10.0, config, EngineState(0.0, EngineMode.RUNNING, 1.0)
            )
            owner = EngineOwner(model(), initial.engine)
            state = initial
            dt = 1.0 / hz
            for _ in range(round(duration * hz)):
                ticket = owner.begin_substep(EngineCommand(1.0), dt)
                result = solve_runtime_coupled_vehicle_substep(
                    owner, ticket, state, config, (0.0, 0.0), dt
                )
                self.assert_contract(result)
                state = result.state
            final_speeds.append(state.chassis_speed_m_s)
        reference = final_speeds[-1]
        errors = [abs(value - reference) for value in final_speeds[:-1]]
        self.assertGreater(errors[0], errors[1])
        self.assertGreater(errors[1], errors[2])


if __name__ == "__main__":
    unittest.main()

