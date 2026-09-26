"""Narrow host-facing adapter for the standalone powertrain reference module.

There is no game project in the supplied workspace, so this file defines the
integration seam without pretending to write into an unknown engine.  A host
maps its named wheel torques into :class:`SubstepRequest`, calls ``step`` once
per ordered physics substep, then consumes named tire impulses and the complete
canonical state from :class:`SubstepResponse`.

Sequence numbers reject duplicate or out-of-order replay.  Failed requests do
not consume a number because the underlying Engine/Gearbox transaction aborts.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from types import MappingProxyType
from typing import Mapping

from .engine_model import EngineCommand
from .powertrain_controller import (
    GearboxCommand,
    PowertrainVehicleState,
    PowertrainVehicleStepResult,
    PowertrainVehicleSystem,
)


@dataclass(frozen=True)
class SubstepRequest:
    sequence: int
    dt: float
    engine_command: EngineCommand
    requested_gear: str | None
    wheel_external_torque_nm: Mapping[str, float]
    wind_speed_m_s: float = 0.0


@dataclass(frozen=True)
class SubstepResponse:
    sequence: int
    state: PowertrainVehicleState
    wheel_omega_rad_s: Mapping[str, float]
    tire_impulses_n_s: Mapping[str, float]
    tire_forces_on_chassis_n: Mapping[str, float]
    tire_modes: Mapping[str, str]
    clutch_mode: str
    gearbox_phase: str
    engine_rpm: float
    deterministic_state_hash: str
    solver_result: PowertrainVehicleStepResult


class StandalonePowertrainAdapter:
    def __init__(self, system: PowertrainVehicleSystem, wheel_ids: tuple[str, ...]):
        if len(wheel_ids) != system.vehicle_config.wheel_count:
            raise ValueError("wheel ID count must match the coupled vehicle configuration")
        if any(not name for name in wheel_ids) or len(set(wheel_ids)) != len(wheel_ids):
            raise ValueError("wheel IDs must be non-empty and unique")
        self.system = system
        self.wheel_ids = wheel_ids
        self._next_sequence = 0

    @property
    def next_sequence(self) -> int:
        return self._next_sequence

    @staticmethod
    def _state_hash(state: PowertrainVehicleState) -> str:
        engine = state.vehicle.engine
        gearbox = state.gearbox
        payload = {
            "engine": {
                "omega_rad_s": engine.omega_rad_s,
                "mode": engine.mode.value,
                "load_actuated": engine.load_actuated,
                "limiter_cut": engine.limiter_cut,
                "below_stall_s": engine.below_stall_s,
                "crank_elapsed_s": engine.crank_elapsed_s,
            },
            "wheels_rad_s": list(state.vehicle.wheel_omega_rad_s),
            "chassis_speed_m_s": state.vehicle.chassis_speed_m_s,
            "distance_m": state.vehicle.distance_m,
            "gearbox": {
                "selected_gear": gearbox.selected_gear,
                "phase": gearbox.phase.value,
                "phase_elapsed_s": gearbox.phase_elapsed_s,
                "source_gear": gearbox.source_gear,
                "target_gear": gearbox.target_gear,
                "clutch_engagement": gearbox.clutch_engagement,
            },
        }
        encoded = json.dumps(
            payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def step(self, request: SubstepRequest) -> SubstepResponse:
        if request.sequence != self._next_sequence:
            raise RuntimeError(
                f"expected substep sequence {self._next_sequence}, got {request.sequence}"
            )
        if not math.isfinite(request.dt) or request.dt <= 0.0:
            raise ValueError("host substep dt must be finite and positive")
        if not math.isfinite(request.wind_speed_m_s):
            raise ValueError("host wind speed must be finite")
        if set(request.wheel_external_torque_nm) != set(self.wheel_ids):
            raise ValueError("host wheel torque keys must exactly match configured wheel IDs")
        ordered_torque = tuple(
            float(request.wheel_external_torque_nm[name]) for name in self.wheel_ids
        )
        if any(not math.isfinite(value) for value in ordered_torque):
            raise ValueError("host wheel torques must be finite")

        result = self.system.step(
            request.engine_command,
            GearboxCommand(request.requested_gear),
            ordered_torque,
            request.dt,
            wind_speed_m_s=request.wind_speed_m_s,
        )
        vehicle = result.vehicle_step
        wheel_speed = MappingProxyType(
            dict(zip(self.wheel_ids, result.state.vehicle.wheel_omega_rad_s))
        )
        impulses = MappingProxyType(dict(zip(self.wheel_ids, vehicle.tire_impulses_n_s)))
        forces = MappingProxyType(
            dict(zip(self.wheel_ids, vehicle.tire_forces_on_chassis_n))
        )
        modes = MappingProxyType(
            dict(zip(self.wheel_ids, (mode.value for mode in vehicle.tire_modes)))
        )
        response = SubstepResponse(
            sequence=request.sequence,
            state=result.state,
            wheel_omega_rad_s=wheel_speed,
            tire_impulses_n_s=impulses,
            tire_forces_on_chassis_n=forces,
            tire_modes=modes,
            clutch_mode=vehicle.clutch_mode.value,
            gearbox_phase=result.state.gearbox.phase.value,
            engine_rpm=result.state.vehicle.engine.rpm,
            deterministic_state_hash=self._state_hash(result.state),
            solver_result=result,
        )
        self._next_sequence += 1
        return response

