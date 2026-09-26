"""Transactional gearbox/clutch controller for the coupled vehicle solver.

Gear selection is discrete controller state; engine speed is mechanical state.
This module keeps those ownership domains separate.  A shift passes through
OPENING -> NEUTRAL -> CLOSING and changes the wheel-speed mapping only while
the clutch is open.  It never assigns an RPM during a shift.

Each physics substep is a two-owner transaction:

1. Gearbox prepares a frozen mapping and average clutch engagement.
2. Engine prepares a frozen torque/controller trial.
3. The coupled active-set solver finds mechanical end state.
4. Both canonical owners commit once, or both trials abort on failure.

Substeps may end exactly on a phase boundary but may not cross one.  The
``SubstepSplitRequired`` exception reports the safe duration so a host physics
scheduler can align its substeps with discontinuous mapping changes.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum
import math
from typing import Mapping, Sequence

import numpy as np

from .coupled_vehicle_solver import (
    CoupledVehicleConfig,
    CoupledVehicleState,
    CoupledVehicleStepResult,
    solve_coupled_vehicle_substep,
)
from .engine_model import EngineCommand, EngineModel, EngineOwner


def ideal_open_differential_mapping(
    final_drive_ratio: float,
    *,
    wheel_count: int = 4,
    side_wheels: tuple[int, int] = (2, 3),
) -> tuple[float, ...]:
    """Return the one-coordinate lossless mapping for an ideal open diff.

    The carrier/clutch-side speed is ``final_drive*(w_left+w_right)/2``.
    The transpose mapping therefore gives equal side-wheel reaction impulses
    while leaving both wheel angular speeds independent.  This is the baseline
    open differential, not an LSD/locked-differential model.
    """

    if not math.isfinite(final_drive_ratio) or final_drive_ratio <= 0.0:
        raise ValueError("final-drive ratio must be finite and positive")
    if wheel_count <= 0 or len(side_wheels) != 2 or len(set(side_wheels)) != 2:
        raise ValueError("an ideal open differential needs two distinct side wheels")
    if any(index < 0 or index >= wheel_count for index in side_wheels):
        raise ValueError("open-differential wheel index is outside the wheel array")
    mapping = [0.0] * wheel_count
    for index in side_wheels:
        mapping[index] = 0.5 * final_drive_ratio
    return tuple(mapping)


class ShiftPhase(str, Enum):
    STEADY = "STEADY"
    OPENING = "OPENING"
    NEUTRAL = "NEUTRAL"
    CLOSING = "CLOSING"


@dataclass(frozen=True)
class GearDefinition:
    name: str
    ratio: float

    def validate(self) -> None:
        if not self.name or not self.name.strip():
            raise ValueError("gear name cannot be empty")
        if not math.isfinite(self.ratio):
            raise ValueError("gear ratio must be finite")


@dataclass(frozen=True)
class GearboxAsset:
    gears: tuple[GearDefinition, ...]
    neutral_gear: str
    final_drive_wheel_mapping: tuple[float, ...]
    clutch_open_s: float
    neutral_dwell_s: float
    clutch_close_s: float

    def validate(self) -> None:
        if not self.gears:
            raise ValueError("gearbox requires at least one gear")
        for gear in self.gears:
            gear.validate()
        names = [gear.name for gear in self.gears]
        if len(set(names)) != len(names):
            raise ValueError("gear names must be unique")
        if self.neutral_gear not in names:
            raise ValueError("declared neutral gear is missing")
        if abs(self.gear(self.neutral_gear).ratio) > 1.0e-15:
            raise ValueError("neutral gear ratio must be zero")
        if not self.final_drive_wheel_mapping or any(
            not math.isfinite(value) for value in self.final_drive_wheel_mapping
        ):
            raise ValueError("final-drive wheel mapping must be finite and non-empty")
        if self.clutch_open_s <= 0.0 or self.clutch_close_s <= 0.0:
            raise ValueError("clutch opening and closing durations must be positive")
        if self.neutral_dwell_s < 0.0 or not math.isfinite(self.neutral_dwell_s):
            raise ValueError("neutral dwell duration must be finite and non-negative")

    def gear(self, name: str) -> GearDefinition:
        for gear in self.gears:
            if gear.name == name:
                return gear
        raise ValueError(f"unknown gear {name!r}")

    def mapping_for(self, gear_name: str) -> tuple[float, ...]:
        """Power-conjugate clutch-speed/wheel-reaction mapping.

        A single vector is sufficient for the declared ideal lossless reduced
        path.  More general differentials need separate speed contributions,
        torque fractions and state and must not be hidden in this field.
        """

        ratio = self.gear(gear_name).ratio
        return tuple(float(ratio * value) for value in self.final_drive_wheel_mapping)

    def clutch_side_speed(self, gear_name: str, wheel_omega_rad_s: tuple[float, ...]) -> float:
        mapping = self.mapping_for(gear_name)
        if len(wheel_omega_rad_s) != len(mapping):
            raise ValueError("wheel-speed and drivetrain mappings differ in length")
        if not all(math.isfinite(value) for value in wheel_omega_rad_s):
            raise ValueError("wheel speeds must be finite")
        return float(np.dot(mapping, wheel_omega_rad_s))

    def wheel_reaction_impulses(
        self,
        gear_name: str,
        engine_side_impulse_nms: float,
    ) -> tuple[float, ...]:
        if not math.isfinite(engine_side_impulse_nms):
            raise ValueError("clutch impulse must be finite")
        return tuple(
            -coefficient * engine_side_impulse_nms
            for coefficient in self.mapping_for(gear_name)
        )

    def canonical_payload(self) -> Mapping[str, object]:
        return {
            "gears": [{"name": gear.name, "ratio": gear.ratio} for gear in self.gears],
            "neutral_gear": self.neutral_gear,
            "final_drive_wheel_mapping": list(self.final_drive_wheel_mapping),
            "clutch_open_s": self.clutch_open_s,
            "neutral_dwell_s": self.neutral_dwell_s,
            "clutch_close_s": self.clutch_close_s,
        }


@dataclass(frozen=True)
class GearboxState:
    selected_gear: str
    phase: ShiftPhase = ShiftPhase.STEADY
    phase_elapsed_s: float = 0.0
    source_gear: str | None = None
    target_gear: str | None = None
    clutch_engagement: float = 1.0


@dataclass(frozen=True)
class GearboxCommand:
    requested_gear: str | None = None


@dataclass(frozen=True)
class GearboxControlTrial:
    snapshot: GearboxState
    command: GearboxCommand
    dt: float
    next_state: GearboxState
    effective_gear: str
    effective_mapping: tuple[float, ...]
    average_clutch_engagement: float
    events: tuple[str, ...]
    time_to_boundary_before_s: float


@dataclass(frozen=True)
class GearboxSolveTicket:
    token: int
    snapshot: GearboxState
    trial: GearboxControlTrial


class SubstepSplitRequired(ValueError):
    def __init__(self, requested_dt: float, maximum_dt: float, phase: ShiftPhase):
        super().__init__(
            f"substep {requested_dt:.9g}s crosses {phase.value} boundary; "
            f"split at {maximum_dt:.9g}s"
        )
        self.requested_dt = float(requested_dt)
        self.maximum_dt = float(maximum_dt)
        self.phase = phase


class GearboxController:
    def __init__(self, asset: GearboxAsset):
        asset.validate()
        self.asset = asset

    def validate_state(self, state: GearboxState) -> None:
        self.asset.gear(state.selected_gear)
        if not math.isfinite(state.phase_elapsed_s) or state.phase_elapsed_s < 0.0:
            raise ValueError("gearbox phase time must be finite and non-negative")
        if not math.isfinite(state.clutch_engagement) or not 0.0 <= state.clutch_engagement <= 1.0:
            raise ValueError("clutch engagement must lie in [0, 1]")
        if state.phase is ShiftPhase.STEADY:
            if state.source_gear is not None or state.target_gear is not None:
                raise ValueError("steady gearbox cannot retain a pending shift")
            expected = 0.0 if state.selected_gear == self.asset.neutral_gear else 1.0
            if abs(state.clutch_engagement - expected) > 1.0e-10:
                raise ValueError("steady clutch engagement is inconsistent with selected gear")
        else:
            if state.source_gear is None or state.target_gear is None:
                raise ValueError("active shift must own source and target gears")
            self.asset.gear(state.source_gear)
            self.asset.gear(state.target_gear)

    def _start_shift(
        self, state: GearboxState, target: str, events: list[str]
    ) -> GearboxState:
        asset = self.asset
        asset.gear(target)
        if target == state.selected_gear:
            return state
        events.append(f"SHIFT_REQUESTED:{state.selected_gear}->{target}")
        if state.selected_gear == asset.neutral_gear:
            events.append(f"GEAR_SELECTED:{target}")
            return GearboxState(
                selected_gear=target,
                phase=ShiftPhase.CLOSING,
                phase_elapsed_s=0.0,
                source_gear=asset.neutral_gear,
                target_gear=target,
                clutch_engagement=0.0,
            )
        return GearboxState(
            selected_gear=state.selected_gear,
            phase=ShiftPhase.OPENING,
            phase_elapsed_s=0.0,
            source_gear=state.selected_gear,
            target_gear=target,
            clutch_engagement=1.0,
        )

    def _duration(self, phase: ShiftPhase) -> float:
        if phase is ShiftPhase.OPENING:
            return self.asset.clutch_open_s
        if phase is ShiftPhase.NEUTRAL:
            return self.asset.neutral_dwell_s
        if phase is ShiftPhase.CLOSING:
            return self.asset.clutch_close_s
        return math.inf

    def _phase_engagement(self, phase: ShiftPhase, elapsed: float) -> float:
        if phase is ShiftPhase.OPENING:
            return float(np.clip(1.0 - elapsed / self.asset.clutch_open_s, 0.0, 1.0))
        if phase is ShiftPhase.CLOSING:
            return float(np.clip(elapsed / self.asset.clutch_close_s, 0.0, 1.0))
        if phase is ShiftPhase.NEUTRAL:
            return 0.0
        raise ValueError("steady engagement is state-dependent")

    def _finish_phase(self, state: GearboxState, events: list[str]) -> GearboxState:
        assert state.source_gear is not None and state.target_gear is not None
        asset = self.asset
        if state.phase is ShiftPhase.OPENING:
            events.append("CLUTCH_OPEN")
            if state.target_gear == asset.neutral_gear:
                events.append(f"GEAR_SELECTED:{asset.neutral_gear}")
                return GearboxState(asset.neutral_gear, ShiftPhase.STEADY, clutch_engagement=0.0)
            if asset.neutral_dwell_s > 0.0:
                events.append(f"GEAR_SELECTED:{asset.neutral_gear}")
                return GearboxState(
                    asset.neutral_gear,
                    ShiftPhase.NEUTRAL,
                    0.0,
                    state.source_gear,
                    state.target_gear,
                    0.0,
                )
            events.append(f"GEAR_SELECTED:{state.target_gear}")
            return GearboxState(
                state.target_gear,
                ShiftPhase.CLOSING,
                0.0,
                state.source_gear,
                state.target_gear,
                0.0,
            )
        if state.phase is ShiftPhase.NEUTRAL:
            events.append(f"GEAR_SELECTED:{state.target_gear}")
            return GearboxState(
                state.target_gear,
                ShiftPhase.CLOSING,
                0.0,
                state.source_gear,
                state.target_gear,
                0.0,
            )
        if state.phase is ShiftPhase.CLOSING:
            events.append("CLUTCH_CLOSED")
            events.append(f"SHIFT_COMPLETED:{state.target_gear}")
            return GearboxState(state.target_gear, ShiftPhase.STEADY, clutch_engagement=1.0)
        return state

    def prepare_control(
        self, state: GearboxState, command: GearboxCommand, dt: float
    ) -> GearboxControlTrial:
        self.validate_state(state)
        if not math.isfinite(dt) or dt <= 0.0:
            raise ValueError("gearbox dt must be finite and positive")
        requested = command.requested_gear
        if requested is not None:
            self.asset.gear(requested)
        events: list[str] = []
        working = state
        if working.phase is ShiftPhase.STEADY and requested is not None:
            working = self._start_shift(working, requested, events)
        elif working.phase is not ShiftPhase.STEADY and requested not in (None, working.target_gear):
            raise ValueError(
                f"cannot retarget active shift {working.source_gear}->{working.target_gear} "
                f"to {requested}"
            )

        if working.phase is ShiftPhase.STEADY:
            engagement = 0.0 if working.selected_gear == self.asset.neutral_gear else 1.0
            next_state = replace(working, clutch_engagement=engagement)
            effective_gear = working.selected_gear
            time_to_boundary = math.inf
            average_engagement = engagement
        else:
            duration = self._duration(working.phase)
            time_to_boundary = max(0.0, duration - working.phase_elapsed_s)
            tolerance = 1.0e-12 * max(1.0, duration, dt)
            if dt > time_to_boundary + tolerance:
                raise SubstepSplitRequired(dt, time_to_boundary, working.phase)
            end_elapsed = min(duration, working.phase_elapsed_s + dt)
            start_engagement = self._phase_engagement(working.phase, working.phase_elapsed_s)
            end_engagement = self._phase_engagement(working.phase, end_elapsed)
            average_engagement = 0.5 * (start_engagement + end_engagement)
            effective_gear = (
                working.source_gear
                if working.phase is ShiftPhase.OPENING
                else self.asset.neutral_gear
                if working.phase is ShiftPhase.NEUTRAL
                else working.target_gear
            )
            assert effective_gear is not None
            next_state = replace(
                working,
                phase_elapsed_s=end_elapsed,
                clutch_engagement=end_engagement,
            )
            if end_elapsed >= duration - tolerance:
                next_state = self._finish_phase(next_state, events)

        return GearboxControlTrial(
            snapshot=state,
            command=command,
            dt=float(dt),
            next_state=next_state,
            effective_gear=effective_gear,
            effective_mapping=self.asset.mapping_for(effective_gear),
            average_clutch_engagement=float(average_engagement),
            events=tuple(events),
            time_to_boundary_before_s=float(time_to_boundary),
        )


class GearboxOwner:
    def __init__(self, controller: GearboxController, initial_state: GearboxState):
        controller.validate_state(initial_state)
        self.controller = controller
        self.state = initial_state
        self._next_token = 1
        self._open_token: int | None = None

    def begin_substep(
        self, command: GearboxCommand, dt: float
    ) -> GearboxSolveTicket:
        if self._open_token is not None:
            raise RuntimeError("previous gearbox substep has not been resolved")
        trial = self.controller.prepare_control(self.state, command, dt)
        token = self._next_token
        self._next_token += 1
        self._open_token = token
        return GearboxSolveTicket(token, self.state, trial)

    def validate_commit(self, ticket: GearboxSolveTicket) -> None:
        if self._open_token != ticket.token or ticket.snapshot is not self.state:
            raise RuntimeError("stale or duplicate Gearbox.commit")

    def commit(self, ticket: GearboxSolveTicket) -> GearboxState:
        self.validate_commit(ticket)
        self.state = ticket.trial.next_state
        self._open_token = None
        return self.state

    def abort(self, ticket: GearboxSolveTicket) -> GearboxState:
        if self._open_token != ticket.token or ticket.snapshot is not self.state:
            raise RuntimeError("stale or duplicate Gearbox.abort")
        self._open_token = None
        return self.state

    def restore_group_snapshot(self, ticket: GearboxSolveTicket) -> bool:
        """Restore the canonical snapshot after a group-commit failure."""

        if self._open_token not in (ticket.token, None):
            raise RuntimeError("Gearbox group rollback found an unrelated open token")
        had_committed = self._open_token is None or self.state is not ticket.snapshot
        self.state = ticket.snapshot
        self._open_token = None
        return had_committed


@dataclass(frozen=True)
class PowertrainVehicleState:
    vehicle: CoupledVehicleState
    gearbox: GearboxState


@dataclass(frozen=True)
class PowertrainTransactionAudit:
    begun: tuple[str, ...] = ()
    preflighted: tuple[str, ...] = ()
    committed: tuple[str, ...] = ()
    aborted: tuple[str, ...] = ()
    rolled_back: tuple[str, ...] = ()


@dataclass(frozen=True)
class PowertrainVehicleStepResult:
    state: PowertrainVehicleState
    vehicle_step: CoupledVehicleStepResult
    gearbox_trial: GearboxControlTrial
    transaction: PowertrainTransactionAudit


class PowertrainVehicleSystem:
    """Own Engine, gearbox controller state, and coupled vehicle state together."""

    def __init__(
        self,
        engine_model: EngineModel,
        gearbox_asset: GearboxAsset,
        vehicle_config: CoupledVehicleConfig,
        initial_state: PowertrainVehicleState,
    ):
        gearbox_asset.validate()
        vehicle_config.validate()
        if len(gearbox_asset.final_drive_wheel_mapping) != vehicle_config.wheel_count:
            raise ValueError("gearbox mapping and vehicle wheel counts differ")
        self.vehicle_config = vehicle_config
        self.engine_owner = EngineOwner(engine_model, initial_state.vehicle.engine)
        self.gearbox_owner = GearboxOwner(
            GearboxController(gearbox_asset), initial_state.gearbox
        )
        self.state = initial_state
        self.last_transaction_audit = PowertrainTransactionAudit()

    def step(
        self,
        engine_command: EngineCommand,
        gearbox_command: GearboxCommand,
        wheel_external_torque_nm: Sequence[float],
        dt: float,
        *,
        wind_speed_m_s: float = 0.0,
    ) -> PowertrainVehicleStepResult:
        if self.state.vehicle.engine is not self.engine_owner.state:
            raise RuntimeError("system vehicle state lost Engine ownership")
        if self.state.gearbox is not self.gearbox_owner.state:
            raise RuntimeError("system vehicle state lost Gearbox ownership")
        system_snapshot = self.state
        begun: list[str] = []
        preflighted: list[str] = []
        committed: list[str] = []
        aborted: list[str] = []
        rolled_back: list[str] = []
        commit_phase_started = False
        gearbox_ticket = self.gearbox_owner.begin_substep(gearbox_command, dt)
        begun.append("gearbox")
        engine_ticket = None
        try:
            engine_ticket = self.engine_owner.begin_substep(engine_command, dt)
            begun.append("engine")
            vehicle_step = solve_coupled_vehicle_substep(
                self.engine_owner,
                engine_ticket,
                self.state.vehicle,
                self.vehicle_config,
                wheel_external_torque_nm,
                dt,
                clutch_engagement=gearbox_ticket.trial.average_clutch_engagement,
                clutch_speed_mapping=gearbox_ticket.trial.effective_mapping,
                wind_speed_m_s=wind_speed_m_s,
                commit_engine=False,
            )
            solved_omega = vehicle_step.state.engine.omega_rad_s
            # Two-owner commit preflight: after both checks pass, neither commit
            # contains a remaining data-dependent failure path.  This prevents an
            # Engine-only canonical advance when gearbox ownership is stale.
            self.engine_owner.validate_commit(engine_ticket, solved_omega)
            preflighted.append("engine")
            self.gearbox_owner.validate_commit(gearbox_ticket)
            preflighted.append("gearbox")
            commit_phase_started = True
            engine_state = self.engine_owner.commit(engine_ticket, solved_omega)
            committed.append("engine")
            gearbox_state = self.gearbox_owner.commit(gearbox_ticket)
            committed.append("gearbox")
            vehicle_step = replace(
                vehicle_step,
                state=replace(vehicle_step.state, engine=engine_state),
            )
        except Exception:
            if commit_phase_started:
                if self.gearbox_owner.restore_group_snapshot(gearbox_ticket):
                    rolled_back.append("gearbox")
                else:
                    aborted.append("gearbox")
                if engine_ticket is not None:
                    if self.engine_owner.restore_group_snapshot(engine_ticket):
                        rolled_back.append("engine")
                    else:
                        aborted.append("engine")
                self.state = system_snapshot
            else:
                try:
                    self.gearbox_owner.abort(gearbox_ticket)
                    aborted.append("gearbox")
                except RuntimeError:
                    pass
                if engine_ticket is not None:
                    try:
                        self.engine_owner.abort(engine_ticket)
                        aborted.append("engine")
                    except RuntimeError:
                        pass
            self.last_transaction_audit = PowertrainTransactionAudit(
                tuple(begun),
                tuple(preflighted),
                tuple(committed),
                tuple(aborted),
                tuple(rolled_back),
            )
            raise

        next_state = PowertrainVehicleState(vehicle_step.state, gearbox_state)
        self.state = next_state
        transaction = PowertrainTransactionAudit(
            tuple(begun),
            tuple(preflighted),
            tuple(committed),
            (),
            (),
        )
        self.last_transaction_audit = transaction
        return PowertrainVehicleStepResult(
            next_state,
            vehicle_step,
            gearbox_ticket.trial,
            transaction,
        )
