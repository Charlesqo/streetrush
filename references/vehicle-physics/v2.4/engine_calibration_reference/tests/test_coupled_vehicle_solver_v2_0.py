from __future__ import annotations

from dataclasses import replace
import hashlib
import json
from pathlib import Path
import unittest

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
from engine_calibration_reference.engine_model import (
    EngineAsset,
    EngineCommand,
    EngineMode,
    EngineModel,
    EngineOwner,
    EngineState,
    rpm_to_rad_s,
)


ROOT = Path(__file__).resolve().parents[1]


def load_model() -> EngineModel:
    return EngineModel(EngineAsset.from_json(ROOT / "data" / "synthetic_engine_asset.json"))


def rwd_config(mu: float = 1.5, clutch_capacity_nm: float = 900.0) -> CoupledVehicleConfig:
    return CoupledVehicleConfig(
        mass_kg=1420.0,
        wheel_inertias_kg_m2=(1.25, 1.25),
        wheel_radii_m=(0.33, 0.33),
        clutch_speed_mapping=(4.5, 4.5),
        clutch_capacity_nm=clutch_capacity_nm,
        tire_mu=(mu, mu),
        wheel_axles=(Axle.REAR, Axle.REAR),
        wheelbase_m=2.72,
        cg_to_rear_axle_m=1.42,
        cg_height_m=0.53,
        cd_area_m2=0.68,
        cl_area_m2=0.35,
        aero_front_fraction=0.46,
    )


def consistent_fixture(
    config: CoupledVehicleConfig, speed_m_s: float = 15.0, load: float = 0.5
) -> tuple[EngineOwner, CoupledVehicleState]:
    template = EngineState(0.0, EngineMode.RUNNING, load)
    state = make_consistent_state(speed_m_s, config, template)
    return EngineOwner(load_model(), state.engine), state


class TestFiniteCapacityCoupledVehicle(unittest.TestCase):
    def test_locked_adhesion_solution_closes_every_row_and_energy_identity(self) -> None:
        config = rwd_config()
        owner, state = consistent_fixture(config)
        dt = 1.0 / 120.0
        ticket = owner.begin_substep(EngineCommand(0.55), dt)
        result = solve_coupled_vehicle_substep(
            owner, ticket, state, config, (0.0, 0.0), dt
        )

        self.assertIs(result.engine_bound_mode, EngineBoundMode.FREE)
        self.assertIs(result.clutch_mode, ClutchMode.LOCKED)
        self.assertEqual(result.tire_modes, (TireMode.ADHERING, TireMode.ADHERING))
        self.assertLess(abs(result.engine_row_residual_nms), 2.0e-8)
        self.assertLess(max(map(abs, result.wheel_row_residual_nms)), 2.0e-8)
        self.assertLess(abs(result.chassis_row_residual_n_s), 2.0e-7)
        self.assertLess(abs(result.clutch_relative_speed_rad_s), 2.0e-7)
        self.assertLess(max(map(abs, result.tire_slip_speeds_m_s)), 2.0e-7)
        self.assertLess(abs(result.energy.identity_residual_j), 1.0e-5)
        self.assertGreaterEqual(result.energy.physical_constraint_dissipation_j, -1.0e-8)
        self.assertIs(owner.state, result.state.engine)

    def test_low_capacity_clutch_slips_at_declared_capacity(self) -> None:
        config = rwd_config(clutch_capacity_nm=18.0)
        model = load_model()
        speed = 10.0
        wheels = (speed / 0.33, speed / 0.33)
        engine = EngineState(rpm_to_rad_s(3600.0), EngineMode.RUNNING, 0.7)
        state = CoupledVehicleState(engine, wheels, speed)
        owner = EngineOwner(model, engine)
        dt = 1.0 / 120.0
        ticket = owner.begin_substep(EngineCommand(0.7), dt)
        result = solve_coupled_vehicle_substep(
            owner, ticket, state, config, (0.0, 0.0), dt
        )

        self.assertIs(result.clutch_mode, ClutchMode.SLIDING_POSITIVE)
        self.assertAlmostEqual(
            abs(result.clutch_impulse_nms), result.clutch_capacity_impulse_nms, places=9
        )
        self.assertGreater(result.clutch_relative_speed_rad_s, 0.0)
        self.assertLessEqual(
            result.energy.clutch_constraint_work_j, 1.0e-9
        )

    def test_low_mu_selects_tire_sliding_instead_of_over_capacity_adhesion(self) -> None:
        config = rwd_config(mu=0.055, clutch_capacity_nm=900.0)
        owner, state = consistent_fixture(config, speed_m_s=8.0, load=1.0)
        dt = 1.0 / 120.0
        ticket = owner.begin_substep(EngineCommand(1.0), dt)
        result = solve_coupled_vehicle_substep(
            owner, ticket, state, config, (0.0, 0.0), dt
        )

        self.assertTrue(any(mode is not TireMode.ADHERING for mode in result.tire_modes))
        for impulse, capacity, mode, slip in zip(
            result.tire_impulses_n_s,
            result.tire_capacity_impulses_n_s,
            result.tire_modes,
            result.tire_slip_speeds_m_s,
        ):
            if mode is not TireMode.ADHERING:
                self.assertAlmostEqual(abs(impulse), capacity, places=7)
                self.assertGreaterEqual(impulse * slip, -1.0e-8)
        self.assertGreaterEqual(result.energy.physical_constraint_dissipation_j, -1.0e-8)

    def test_open_clutch_decouples_engine_without_rewriting_wheel_state(self) -> None:
        config = replace(rwd_config(), rolling_resistance_coefficient=0.0, cd_area_m2=0.0)
        model = load_model()
        speed = 12.0
        wheels = (speed / 0.33, speed / 0.33)
        engine = EngineState(rpm_to_rad_s(1800.0), EngineMode.RUNNING, 0.0)
        state = CoupledVehicleState(engine, wheels, speed)
        owner = EngineOwner(model, engine)
        dt = 1.0 / 120.0
        ticket = owner.begin_substep(EngineCommand(1.0), dt)
        result = solve_coupled_vehicle_substep(
            owner,
            ticket,
            state,
            config,
            (0.0, 0.0),
            dt,
            clutch_engagement=0.0,
        )

        self.assertIs(result.clutch_mode, ClutchMode.NEUTRAL)
        self.assertAlmostEqual(result.clutch_impulse_nms, 0.0, places=12)
        self.assertGreater(result.state.engine.rpm, engine.rpm)
        self.assertAlmostEqual(result.state.chassis_speed_m_s, speed, places=10)
        for actual, expected in zip(result.state.wheel_omega_rad_s, wheels):
            self.assertAlmostEqual(actual, expected, places=10)

    def test_invalid_solve_aborts_ticket_and_preserves_canonical_state(self) -> None:
        config = rwd_config()
        owner, state = consistent_fixture(config)
        original = owner.state
        dt = 1.0 / 120.0
        ticket = owner.begin_substep(EngineCommand(0.5), dt)
        with self.assertRaises(ValueError):
            solve_coupled_vehicle_substep(
                owner,
                ticket,
                state,
                replace(config, mass_kg=-1.0),
                (0.0, 0.0),
                dt,
            )
        self.assertIs(owner.state, original)

        retry = owner.begin_substep(EngineCommand(0.5), dt)
        owner.abort(retry)
        self.assertIs(owner.state, original)
        with self.assertRaises(RuntimeError):
            owner.abort(retry)

    def test_replay_is_bitwise_deterministic_for_identical_commands(self) -> None:
        config = rwd_config(mu=0.8, clutch_capacity_nm=250.0)

        def run() -> str:
            owner, state = consistent_fixture(config, speed_m_s=11.0, load=0.2)
            rows: list[dict[str, object]] = []
            dt = 1.0 / 120.0
            for step_index in range(24):
                throttle = 0.85 if step_index < 12 else 0.15
                ticket = owner.begin_substep(EngineCommand(throttle), dt)
                result = solve_coupled_vehicle_substep(
                    owner,
                    ticket,
                    state,
                    config,
                    (-15.0, -15.0),
                    dt,
                )
                state = result.state
                rows.append(
                    {
                        "engine": state.engine.omega_rad_s,
                        "wheels": state.wheel_omega_rad_s,
                        "speed": state.chassis_speed_m_s,
                        "clutch": result.clutch_mode.value,
                        "tires": [mode.value for mode in result.tire_modes],
                        "j": result.clutch_impulse_nms,
                        "p": result.tire_impulses_n_s,
                    }
                )
            payload = json.dumps(rows, sort_keys=True, separators=(",", ":")).encode()
            return hashlib.sha256(payload).hexdigest()

        self.assertEqual(run(), run())


if __name__ == "__main__":
    unittest.main()

