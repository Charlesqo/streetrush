from __future__ import annotations

from pathlib import Path
import unittest

from engine_calibration_reference.coupled_vehicle_solver import (
    CoupledVehicleState,
    make_consistent_state,
)
from engine_calibration_reference.engine_model import (
    EngineAsset,
    EngineCommand,
    EngineMode,
    EngineModel,
    EngineOwner,
    EngineState,
)
from engine_calibration_reference.powertrain_controller import (
    GearDefinition,
    GearboxAsset,
    GearboxCommand,
    GearboxController,
    GearboxOwner,
    GearboxState,
    PowertrainVehicleState,
    PowertrainVehicleSystem,
    ShiftPhase,
    SubstepSplitRequired,
)
from engine_calibration_reference.tests.test_coupled_vehicle_solver_v2_0 import (
    rwd_config,
)


ROOT = Path(__file__).resolve().parents[1]


def gearbox_asset() -> GearboxAsset:
    return GearboxAsset(
        gears=(
            GearDefinition("R", -2.8),
            GearDefinition("N", 0.0),
            GearDefinition("1", 3.0),
            GearDefinition("2", 2.0),
            GearDefinition("3", 1.35),
        ),
        neutral_gear="N",
        final_drive_wheel_mapping=(1.5, 1.5),
        clutch_open_s=0.04,
        neutral_dwell_s=0.02,
        clutch_close_s=0.06,
    )


def engine_model() -> EngineModel:
    return EngineModel(EngineAsset.from_json(ROOT / "data" / "synthetic_engine_asset.json"))


class TestGearboxTrialCommit(unittest.TestCase):
    def test_shift_phase_sequence_changes_mapping_only_at_open_clutch(self) -> None:
        controller = GearboxController(gearbox_asset())
        owner = GearboxOwner(controller, GearboxState("1"))
        dt = 0.02
        observations: list[tuple[str, str, float, tuple[float, ...]]] = []
        for _ in range(6):
            ticket = owner.begin_substep(GearboxCommand("2"), dt)
            observations.append(
                (
                    ticket.trial.effective_gear,
                    ticket.trial.next_state.phase.value,
                    ticket.trial.average_clutch_engagement,
                    ticket.trial.effective_mapping,
                )
            )
            owner.commit(ticket)

        self.assertEqual([item[0] for item in observations], ["1", "1", "N", "2", "2", "2"])
        self.assertEqual(owner.state.phase, ShiftPhase.STEADY)
        self.assertEqual(owner.state.selected_gear, "2")
        self.assertEqual(
            [round(item[2], 6) for item in observations],
            [0.75, 0.25, 0.0, 0.166667, 0.5, 0.833333],
        )
        self.assertEqual(observations[2][3], (0.0, 0.0))
        self.assertEqual(observations[3][3], (3.0, 3.0))

    def test_phase_boundary_requests_explicit_substep_split_without_locking_owner(self) -> None:
        controller = GearboxController(gearbox_asset())
        state = GearboxState(
            "1",
            ShiftPhase.OPENING,
            phase_elapsed_s=0.03,
            source_gear="1",
            target_gear="2",
            clutch_engagement=0.25,
        )
        owner = GearboxOwner(controller, state)
        with self.assertRaises(SubstepSplitRequired) as caught:
            owner.begin_substep(GearboxCommand("2"), 0.02)
        self.assertAlmostEqual(caught.exception.maximum_dt, 0.01, places=12)
        ticket = owner.begin_substep(GearboxCommand("2"), 0.01)
        owner.abort(ticket)
        self.assertIs(owner.state, state)

    def test_engine_prepare_error_does_not_leave_open_owner(self) -> None:
        model = engine_model()
        state = EngineState(100.0, EngineMode.RUNNING)
        owner = EngineOwner(model, state)
        with self.assertRaises(ValueError):
            owner.begin_substep(EngineCommand(0.2), -0.1)
        ticket = owner.begin_substep(EngineCommand(0.2), 1.0 / 120.0)
        owner.abort(ticket)
        self.assertIs(owner.state, state)


class TestTransactionalPowertrainSystem(unittest.TestCase):
    def make_system(self) -> PowertrainVehicleSystem:
        config = rwd_config(mu=1.2, clutch_capacity_nm=500.0)
        initial_vehicle = make_consistent_state(
            8.0,
            config,
            EngineState(0.0, EngineMode.RUNNING, 0.35),
            mapping=gearbox_asset().mapping_for("1"),
        )
        initial = PowertrainVehicleState(initial_vehicle, GearboxState("1"))
        return PowertrainVehicleSystem(engine_model(), gearbox_asset(), config, initial)

    def test_complete_shift_uses_mechanical_synchronization_not_rpm_assignment(self) -> None:
        system = self.make_system()
        dt = 0.02
        rows = []
        for _ in range(6):
            result = system.step(
                EngineCommand(0.4), GearboxCommand("2"), (0.0, 0.0), dt
            )
            rows.append(result)

        self.assertEqual(system.state.gearbox.phase, ShiftPhase.STEADY)
        self.assertEqual(system.state.gearbox.selected_gear, "2")
        neutral_step = rows[2]
        self.assertEqual(neutral_step.gearbox_trial.effective_gear, "N")
        self.assertEqual(neutral_step.vehicle_step.clutch_impulse_nms, 0.0)

        first_closing = rows[3]
        mapped_wheel_speed = sum(
            coefficient * omega
            for coefficient, omega in zip(
                first_closing.gearbox_trial.effective_mapping,
                first_closing.state.vehicle.wheel_omega_rad_s,
            )
        )
        # Closing begins with finite clutch authority: a speed mismatch is
        # resolved by impulse over time, not by assigning Engine RPM.
        self.assertGreater(
            abs(first_closing.state.vehicle.engine.omega_rad_s - mapped_wheel_speed),
            1.0e-4,
        )
        self.assertLessEqual(
            abs(first_closing.vehicle_step.clutch_impulse_nms),
            first_closing.vehicle_step.clutch_capacity_impulse_nms + 1.0e-7,
        )

    def test_mechanical_failure_aborts_both_owners_and_allows_retry(self) -> None:
        system = self.make_system()
        original = system.state
        with self.assertRaises(ValueError):
            system.step(
                EngineCommand(0.4), GearboxCommand("2"), (0.0,), 0.02
            )
        self.assertIs(system.state, original)
        self.assertIs(system.engine_owner.state, original.vehicle.engine)
        self.assertIs(system.gearbox_owner.state, original.gearbox)

        result = system.step(
            EngineCommand(0.4), GearboxCommand("2"), (0.0, 0.0), 0.02
        )
        self.assertIs(system.state, result.state)
        self.assertIsNot(system.engine_owner.state, original.vehicle.engine)
        self.assertIsNot(system.gearbox_owner.state, original.gearbox)

    def test_post_commit_fault_restores_engine_and_gearbox_group(self) -> None:
        for fault_name in ("engine", "gearbox"):
            with self.subTest(fault_owner=fault_name):
                system = self.make_system()
                original = system.state
                owner = (
                    system.engine_owner
                    if fault_name == "engine"
                    else system.gearbox_owner
                )
                original_commit = owner.commit

                def commit_then_fail(*args, _commit=original_commit):
                    _commit(*args)
                    raise RuntimeError("injected post-commit fault")

                owner.commit = commit_then_fail
                with self.assertRaisesRegex(RuntimeError, "injected post-commit fault"):
                    system.step(
                        EngineCommand(0.4),
                        GearboxCommand("2"),
                        (0.0, 0.0),
                        0.02,
                    )
                self.assertIs(system.state, original)
                self.assertIs(system.engine_owner.state, original.vehicle.engine)
                self.assertIs(system.gearbox_owner.state, original.gearbox)
                self.assertIn(fault_name, system.last_transaction_audit.rolled_back)


if __name__ == "__main__":
    unittest.main()
