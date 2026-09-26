from __future__ import annotations

from pathlib import Path
import unittest

from engine_calibration_reference.coupled_vehicle_solver import make_consistent_state
from engine_calibration_reference.engine_model import (
    EngineAsset,
    EngineCommand,
    EngineMode,
    EngineModel,
    EngineState,
)
from engine_calibration_reference.host_integration import (
    StandalonePowertrainAdapter,
    SubstepRequest,
)
from engine_calibration_reference.powertrain_controller import (
    GearboxState,
    PowertrainVehicleState,
    PowertrainVehicleSystem,
)
from engine_calibration_reference.tests.test_coupled_vehicle_solver_v2_0 import rwd_config
from engine_calibration_reference.tests.test_powertrain_controller_v2_0 import gearbox_asset


ROOT = Path(__file__).resolve().parents[1]


def adapter() -> StandalonePowertrainAdapter:
    config = rwd_config()
    gearbox = gearbox_asset()
    vehicle = make_consistent_state(
        9.0,
        config,
        EngineState(0.0, EngineMode.RUNNING, 0.2),
        mapping=gearbox.mapping_for("1"),
    )
    model = EngineModel(EngineAsset.from_json(ROOT / "data" / "synthetic_engine_asset.json"))
    system = PowertrainVehicleSystem(
        model,
        gearbox,
        config,
        PowertrainVehicleState(vehicle, GearboxState("1")),
    )
    return StandalonePowertrainAdapter(system, ("rear_left", "rear_right"))


class TestHostIntegration(unittest.TestCase):
    def test_named_wheel_port_and_sequence_contract(self) -> None:
        port = adapter()
        response = port.step(
            SubstepRequest(
                sequence=0,
                dt=0.02,
                engine_command=EngineCommand(0.4),
                requested_gear="1",
                wheel_external_torque_nm={"rear_right": -10.0, "rear_left": -15.0},
            )
        )
        self.assertEqual(set(response.tire_impulses_n_s), {"rear_left", "rear_right"})
        self.assertEqual(len(response.deterministic_state_hash), 64)
        self.assertEqual(port.next_sequence, 1)
        with self.assertRaisesRegex(RuntimeError, "expected substep sequence 1"):
            port.step(
                SubstepRequest(
                    sequence=0,
                    dt=0.02,
                    engine_command=EngineCommand(0.4),
                    requested_gear="1",
                    wheel_external_torque_nm={"rear_left": 0.0, "rear_right": 0.0},
                )
            )

    def test_invalid_host_mapping_does_not_consume_sequence_or_state(self) -> None:
        port = adapter()
        state = port.system.state
        with self.assertRaisesRegex(ValueError, "exactly match"):
            port.step(
                SubstepRequest(
                    sequence=0,
                    dt=0.02,
                    engine_command=EngineCommand(0.4),
                    requested_gear="1",
                    wheel_external_torque_nm={"rear_left": 0.0},
                )
            )
        self.assertEqual(port.next_sequence, 0)
        self.assertIs(port.system.state, state)


if __name__ == "__main__":
    unittest.main()

