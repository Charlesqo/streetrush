"""Transactional owner around the accepted Steering V2 reference.

The accepted reference uses small mutable objects because it was originally a
standalone subsystem demonstrator.  A nonlinear whole-vehicle host must not
advance those objects on every residual evaluation.  This adapter reconstructs
the accepted objects from an immutable canonical snapshot, advances input/rack
state once, evaluates Tire road reaction once after the mechanical solution is
accepted, then commits exactly once.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
import math

from .steering_reference_v2 import (
    DeviceAdapter,
    DeviceKind,
    DriverIntent,
    InputConfig,
    PositionActuatorConfig,
    PositionRackActuator,
    RackMap,
    RackState,
    ReactionConfig,
    SteeringCommand,
    SteeringGeometry,
    SteeringGeometryConfig,
    SteeringOutput,
    SteeringReactionModel,
    SteeringReactionOutput,
    SteeringSystem,
    TireSteeringLoad,
    WheelAngles,
)


@dataclass(frozen=True)
class SteeringCanonicalState:
    keyboard_axis: float = 0.0
    rack_q: float = 0.0
    rack_rate_q_s: float = 0.0
    filtered_ffb_torque_nm: float = 0.0


@dataclass(frozen=True)
class SteeringControlTrial:
    snapshot: SteeringCanonicalState
    command: SteeringCommand
    dt: float
    output: SteeringOutput
    next_control_state: SteeringCanonicalState


@dataclass(frozen=True)
class SteeringReactionTrial:
    control: SteeringControlTrial
    output: SteeringReactionOutput
    next_state: SteeringCanonicalState


@dataclass(frozen=True)
class SteeringSolveTicket:
    token: int
    snapshot: SteeringCanonicalState
    trial: SteeringControlTrial


class SteeringTransactionalModel:
    def __init__(
        self,
        input_config: InputConfig | None = None,
        rack_map: RackMap | None = None,
        actuator_config: PositionActuatorConfig | None = None,
        geometry_config: SteeringGeometryConfig | None = None,
        reaction_config: ReactionConfig | None = None,
    ):
        self.input_config = input_config or InputConfig()
        self.rack_map = rack_map or RackMap()
        self.actuator_config = actuator_config or PositionActuatorConfig()
        self.geometry_config = geometry_config or SteeringGeometryConfig()
        self.reaction_config = reaction_config or ReactionConfig()

    def output_from_rack_state(self, rack_q: float, rack_rate_q_s: float) -> SteeringOutput:
        """Describe a rack state without advancing either steering causality."""

        virtual = self.rack_map.angle_from_q(rack_q)
        geometry = SteeringGeometry(self.geometry_config)
        angles = geometry.front_angles(virtual, 0.0, 0.0)
        curvature = math.tan(virtual) / self.geometry_config.wheelbase_m
        intent = DriverIntent(
            kind=DeviceKind.PHYSICAL_WHEEL,
            shaped_input=0.0,
            target_curvature=curvature,
            target_virtual_angle=virtual,
            target_handwheel_angle=rack_q * self.input_config.wheel_lock_rad,
        )
        return SteeringOutput(
            intent=intent,
            rack_q=rack_q,
            rack_rate_q_s=rack_rate_q_s,
            handwheel_angle_rad=rack_q * self.input_config.wheel_lock_rad,
            virtual_angle_rad=virtual,
            curvature_1pm=curvature,
            wheel_angles=angles,
        )

    def prepare_torque_control(
        self,
        state: SteeringCanonicalState,
        speed_m_s: float,
        dt: float,
    ) -> SteeringControlTrial:
        if not math.isfinite(speed_m_s):
            raise ValueError("Steering speed must be finite")
        if not math.isfinite(dt) or dt <= 0.0:
            raise ValueError("Steering dt must be finite and positive")
        command = SteeringCommand(DeviceKind.GAMEPAD, 0.0)
        output = self.output_from_rack_state(state.rack_q, state.rack_rate_q_s)
        return SteeringControlTrial(state, command, float(dt), output, state)

    def prepare_control(
        self,
        state: SteeringCanonicalState,
        command: SteeringCommand,
        speed_m_s: float,
        dt: float,
    ) -> SteeringControlTrial:
        if not math.isfinite(speed_m_s):
            raise ValueError("Steering speed must be finite")
        if not math.isfinite(dt) or dt <= 0.0:
            raise ValueError("Steering dt must be finite and positive")
        adapter = DeviceAdapter(self.input_config, keyboard_axis=state.keyboard_axis)
        actuator = PositionRackActuator(
            self.actuator_config,
            RackState(state.rack_q, state.rack_rate_q_s),
        )
        system = SteeringSystem(
            adapter=adapter,
            rack_map=self.rack_map,
            actuator=actuator,
            geometry=SteeringGeometry(self.geometry_config),
        )
        # Bump/toe is supplied by the accepted K&C map in the unified host.  It
        # must not also be injected by the simple Steering geometry helper.
        output = system.step(command, abs(speed_m_s), dt, 0.0, 0.0)
        next_state = SteeringCanonicalState(
            keyboard_axis=adapter.keyboard_axis,
            rack_q=output.rack_q,
            rack_rate_q_s=output.rack_rate_q_s,
            filtered_ffb_torque_nm=state.filtered_ffb_torque_nm,
        )
        return SteeringControlTrial(state, command, float(dt), output, next_state)

    def evaluate_reaction(
        self,
        trial: SteeringControlTrial,
        speed_m_s: float,
        left_load: TireSteeringLoad,
        right_load: TireSteeringLoad,
    ) -> SteeringReactionTrial:
        reaction_model = SteeringReactionModel(
            self.reaction_config,
            filtered_output_nm=trial.snapshot.filtered_ffb_torque_nm,
        )
        geometry = SteeringGeometry(self.geometry_config)
        derivatives = geometry.angle_derivatives_wrt_q(
            self.rack_map, trial.output.rack_q
        )
        output = reaction_model.step(
            speed_mps=abs(speed_m_s),
            rack_q=trial.output.rack_q,
            handwheel_rate_rad_s=(
                trial.output.rack_rate_q_s * self.input_config.wheel_lock_rad
            ),
            angle_derivatives_wrt_q=derivatives,
            left_load=left_load,
            right_load=right_load,
            dt=trial.dt,
        )
        return SteeringReactionTrial(
            control=trial,
            output=output,
            next_state=replace(
                trial.next_control_state,
                filtered_ffb_torque_nm=reaction_model.filtered_output_nm,
            ),
        )

    def evaluate_projected_reaction(
        self,
        trial: SteeringControlTrial,
        speed_m_s: float,
        wheel_generalized_loads_nm: WheelAngles,
        intrinsic_mz_generalized_torque_nm: float,
    ) -> SteeringReactionTrial:
        reaction_model = SteeringReactionModel(
            self.reaction_config,
            filtered_output_nm=trial.snapshot.filtered_ffb_torque_nm,
        )
        output = reaction_model.step_projected(
            speed_mps=abs(speed_m_s),
            rack_q=trial.output.rack_q,
            handwheel_rate_rad_s=(
                trial.output.rack_rate_q_s * self.input_config.wheel_lock_rad
            ),
            wheel_generalized_loads_nm=wheel_generalized_loads_nm,
            intrinsic_mz_generalized_torque_nm=intrinsic_mz_generalized_torque_nm,
            dt=trial.dt,
        )
        return SteeringReactionTrial(
            control=trial,
            output=output,
            next_state=replace(
                trial.next_control_state,
                filtered_ffb_torque_nm=reaction_model.filtered_output_nm,
            ),
        )


class SteeringOwner:
    def __init__(
        self, model: SteeringTransactionalModel, initial_state: SteeringCanonicalState
    ):
        self.model = model
        self.state = initial_state
        self._next_token = 1
        self._open_token: int | None = None

    def begin_substep(
        self, command: SteeringCommand, speed_m_s: float, dt: float
    ) -> SteeringSolveTicket:
        if self._open_token is not None:
            raise RuntimeError("previous Steering substep has not been resolved")
        trial = self.model.prepare_control(self.state, command, speed_m_s, dt)
        token = self._next_token
        self._next_token += 1
        self._open_token = token
        return SteeringSolveTicket(token, self.state, trial)

    def begin_torque_substep(self, speed_m_s: float, dt: float) -> SteeringSolveTicket:
        if self._open_token is not None:
            raise RuntimeError("previous Steering substep has not been resolved")
        trial = self.model.prepare_torque_control(self.state, speed_m_s, dt)
        token = self._next_token
        self._next_token += 1
        self._open_token = token
        return SteeringSolveTicket(token, self.state, trial)

    def evaluate_reaction(
        self,
        ticket: SteeringSolveTicket,
        speed_m_s: float,
        left_load: TireSteeringLoad,
        right_load: TireSteeringLoad,
    ) -> SteeringReactionTrial:
        if self._open_token != ticket.token or ticket.snapshot is not self.state:
            raise RuntimeError("stale Steering trial evaluation")
        return self.model.evaluate_reaction(
            ticket.trial, speed_m_s, left_load, right_load
        )

    def evaluate_projected_reaction(
        self,
        ticket: SteeringSolveTicket,
        speed_m_s: float,
        wheel_generalized_loads_nm: WheelAngles,
        intrinsic_mz_generalized_torque_nm: float,
    ) -> SteeringReactionTrial:
        if self._open_token != ticket.token or ticket.snapshot is not self.state:
            raise RuntimeError("stale Steering trial evaluation")
        return self.model.evaluate_projected_reaction(
            ticket.trial,
            speed_m_s,
            wheel_generalized_loads_nm,
            intrinsic_mz_generalized_torque_nm,
        )

    def validate_commit(
        self, ticket: SteeringSolveTicket, reaction: SteeringReactionTrial
    ) -> None:
        if self._open_token != ticket.token or ticket.snapshot is not self.state:
            raise RuntimeError("stale or duplicate Steering.commit")
        if reaction.control is not ticket.trial:
            raise RuntimeError("Steering reaction does not belong to this control trial")
        values = (
            reaction.next_state.keyboard_axis,
            reaction.next_state.rack_q,
            reaction.next_state.rack_rate_q_s,
            reaction.next_state.filtered_ffb_torque_nm,
        )
        if not all(math.isfinite(value) for value in values):
            raise ValueError("Steering solver returned non-finite canonical state")

    def commit(
        self, ticket: SteeringSolveTicket, reaction: SteeringReactionTrial
    ) -> SteeringCanonicalState:
        self.validate_commit(ticket, reaction)
        self.state = reaction.next_state
        self._open_token = None
        return self.state

    def abort(self, ticket: SteeringSolveTicket) -> SteeringCanonicalState:
        if self._open_token != ticket.token or ticket.snapshot is not self.state:
            raise RuntimeError("stale or duplicate Steering.abort")
        self._open_token = None
        return self.state

    def restore_group_snapshot(self, ticket: SteeringSolveTicket) -> bool:
        """Restore Steering after another owner failed the group commit."""

        if self._open_token not in (ticket.token, None):
            raise RuntimeError("Steering group rollback found an unrelated open token")
        had_committed = self._open_token is None or self.state is not ticket.snapshot
        self.state = ticket.snapshot
        self._open_token = None
        return had_committed
