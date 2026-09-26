"""Driver-command and actuator-authority reference for the unified fixture.

The module deliberately stops at bounded authorities.  ABS/TCS/ESC do not
write wheel speed, chassis velocity, yaw rate, or engine speed.  The mechanical
solver consumes their brake capacities and engine positive-torque cap and
finds the actual reactions.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum
import math

import numpy as np

from .engine_model import EngineCommand
from .powertrain_controller import GearboxCommand
from .steering_reference_v2 import DeviceKind, SteeringCommand


class RequestedDirection(str, Enum):
    FORWARD = "FORWARD"
    NEUTRAL = "NEUTRAL"
    REVERSE = "REVERSE"


@dataclass(frozen=True)
class DriverCommand:
    throttle_request: float = 0.0
    service_brake_request: float = 0.0
    parking_brake_request: float = 0.0
    requested_direction: RequestedDirection = RequestedDirection.FORWARD
    steering_request: float = 0.0

    def validated(self) -> "DriverCommand":
        values = (
            self.throttle_request,
            self.service_brake_request,
            self.parking_brake_request,
            self.steering_request,
        )
        if not all(math.isfinite(value) for value in values):
            raise ValueError("driver command contains a non-finite value")
        return replace(
            self,
            throttle_request=float(np.clip(self.throttle_request, 0.0, 1.0)),
            service_brake_request=float(np.clip(self.service_brake_request, 0.0, 1.0)),
            parking_brake_request=float(np.clip(self.parking_brake_request, 0.0, 1.0)),
            requested_direction=RequestedDirection(self.requested_direction),
            steering_request=float(np.clip(self.steering_request, -1.0, 1.0)),
        )


@dataclass(frozen=True)
class DirectionFSMState:
    selected_direction: RequestedDirection = RequestedDirection.FORWARD
    near_stop_elapsed_s: float = 0.0


@dataclass(frozen=True)
class DirectionFSMTrial:
    snapshot: DirectionFSMState
    next_state: DirectionFSMState
    engine: EngineCommand
    gearbox: GearboxCommand
    steering: SteeringCommand
    service_brake_request: float
    parking_brake_request: float
    transition_blocked_by_motion: bool


@dataclass(frozen=True)
class DirectionFSMConfig:
    near_stop_speed_m_s: float = 0.35
    direction_change_hold_s: float = 0.12
    forward_gear: str = "1"
    neutral_gear: str = "N"
    reverse_gear: str = "R"

    def validate(self) -> None:
        if not math.isfinite(self.near_stop_speed_m_s) or self.near_stop_speed_m_s < 0.0:
            raise ValueError("near-stop speed must be finite and non-negative")
        if not math.isfinite(self.direction_change_hold_s) or self.direction_change_hold_s < 0.0:
            raise ValueError("direction-change hold must be finite and non-negative")
        gears = (self.forward_gear, self.neutral_gear, self.reverse_gear)
        if any(not value or not value.strip() for value in gears) or len(set(gears)) != 3:
            raise ValueError("forward, neutral and reverse gear names must be non-empty and distinct")


class DriverDirectionFSM:
    """Pure trial/commit driver intent adapter; it never writes physics state."""

    def __init__(self, state: DirectionFSMState | None = None, config: DirectionFSMConfig | None = None):
        self.state = state or DirectionFSMState()
        self.config = config or DirectionFSMConfig()
        self.config.validate()
        RequestedDirection(self.state.selected_direction)
        if not math.isfinite(self.state.near_stop_elapsed_s) or self.state.near_stop_elapsed_s < 0.0:
            raise ValueError("direction FSM elapsed time must be finite and non-negative")

    def prepare(self, command: DriverCommand, signed_speed_m_s: float, dt: float) -> DirectionFSMTrial:
        command = command.validated()
        if not math.isfinite(signed_speed_m_s) or not math.isfinite(dt) or dt <= 0.0:
            raise ValueError("direction FSM speed/dt must be finite and dt positive")
        cfg = self.config
        requested = command.requested_direction
        changing = requested is not self.state.selected_direction
        near_stop = abs(signed_speed_m_s) <= cfg.near_stop_speed_m_s
        opposite_selected_direction = (
            requested in (RequestedDirection.FORWARD, RequestedDirection.REVERSE)
            and self.state.selected_direction in (RequestedDirection.FORWARD, RequestedDirection.REVERSE)
            and requested is not self.state.selected_direction
        )
        moving_against_request = (
            (requested is RequestedDirection.FORWARD and signed_speed_m_s < -cfg.near_stop_speed_m_s)
            or (requested is RequestedDirection.REVERSE and signed_speed_m_s > cfg.near_stop_speed_m_s)
        )
        reversal_gate = changing and requested is not RequestedDirection.NEUTRAL and (
            opposite_selected_direction or moving_against_request
        )
        elapsed = self.state.near_stop_elapsed_s + dt if reversal_gate and near_stop else 0.0
        accepted = changing and (
            requested is RequestedDirection.NEUTRAL
            or not reversal_gate
            or elapsed >= cfg.direction_change_hold_s
        )
        selected = requested if accepted else self.state.selected_direction
        blocked = changing and not accepted
        # Keep the service brake asserted throughout the near-stop dwell.  The
        # intent layer may release it only after the signed-ratio change is
        # accepted; it never teleports a mechanical velocity.
        service_brake = max(command.service_brake_request, 1.0 if blocked else 0.0)
        throttle = 0.0 if blocked else command.throttle_request
        gear = None
        if accepted:
            gear = {
                RequestedDirection.FORWARD: cfg.forward_gear,
                RequestedDirection.NEUTRAL: cfg.neutral_gear,
                RequestedDirection.REVERSE: cfg.reverse_gear,
            }[selected]
        next_state = DirectionFSMState(selected, 0.0 if accepted else elapsed)
        return DirectionFSMTrial(
            snapshot=self.state,
            next_state=next_state,
            engine=EngineCommand(throttle_request=throttle),
            gearbox=GearboxCommand(requested_gear=gear),
            steering=SteeringCommand(DeviceKind.GAMEPAD, command.steering_request),
            service_brake_request=service_brake,
            parking_brake_request=command.parking_brake_request,
            transition_blocked_by_motion=blocked,
        )

    def commit(self, trial: DirectionFSMTrial) -> DirectionFSMState:
        self.validate_commit(trial)
        self.state = trial.next_state
        return self.state

    def validate_commit(self, trial: DirectionFSMTrial) -> None:
        if trial.snapshot is not self.state:
            raise RuntimeError("stale direction FSM trial")
        if not math.isfinite(trial.next_state.near_stop_elapsed_s) or trial.next_state.near_stop_elapsed_s < 0.0:
            raise ValueError("direction FSM trial contains invalid elapsed time")
        RequestedDirection(trial.next_state.selected_direction)

    def abort(self, trial: DirectionFSMTrial) -> DirectionFSMState:
        if trial.snapshot is not self.state:
            raise RuntimeError("stale direction FSM trial")
        return self.state


@dataclass(frozen=True)
class BrakeAssistConfig:
    service_capacity_nm: tuple[float, float, float, float] = (3600.0, 3600.0, 2400.0, 2400.0)
    parking_capacity_nm: tuple[float, float, float, float] = (0.0, 0.0, 3200.0, 3200.0)
    abs_enabled: bool = True
    abs_target_braking_slip: float = -0.14
    abs_release_gain: float = 3.5
    abs_min_modulation: float = 0.08
    tcs_enabled: bool = True
    tcs_target_drive_slip: float = 0.12
    tcs_torque_cut_gain: float = 2.5
    tcs_brake_gain_nm: float = 900.0
    esc_enabled: bool = True
    esc_yaw_error_deadband_rad_s: float = 0.04
    esc_brake_gain_nm_per_rad_s: float = 600.0
    esc_max_brake_nm: float = 700.0

    def validate(self) -> None:
        for values in (self.service_capacity_nm, self.parking_capacity_nm):
            if len(values) != 4 or any((not math.isfinite(value) or value < 0.0) for value in values):
                raise ValueError("brake capacities require four finite non-negative values")
        if not 0.0 <= self.abs_min_modulation <= 1.0:
            raise ValueError("ABS minimum modulation must lie in [0,1]")
        scalars = (
            self.abs_target_braking_slip,
            self.abs_release_gain,
            self.tcs_target_drive_slip,
            self.tcs_torque_cut_gain,
            self.tcs_brake_gain_nm,
            self.esc_yaw_error_deadband_rad_s,
            self.esc_brake_gain_nm_per_rad_s,
            self.esc_max_brake_nm,
        )
        if not all(math.isfinite(value) for value in scalars):
            raise ValueError("brake-assist parameters must be finite")
        if not -1.0 < self.abs_target_braking_slip < 0.0 or self.abs_release_gain < 0.0:
            raise ValueError("ABS target must be a negative slip and release gain non-negative")
        if self.tcs_target_drive_slip < 0.0 or self.tcs_torque_cut_gain < 0.0 or self.tcs_brake_gain_nm < 0.0:
            raise ValueError("TCS target/gains must be non-negative")
        if (
            self.esc_yaw_error_deadband_rad_s < 0.0
            or self.esc_brake_gain_nm_per_rad_s < 0.0
            or self.esc_max_brake_nm < 0.0
        ):
            raise ValueError("ESC deadband/gains must be non-negative")


@dataclass(frozen=True)
class AssistEvaluation:
    wheel_slip: tuple[float, float, float, float]
    abs_modulation: tuple[float, float, float, float]
    driver_service_capacity_nm: tuple[float, float, float, float]
    service_request_capacity_nm: tuple[float, float, float, float]
    service_capacity_nm: tuple[float, float, float, float]
    parking_capacity_nm: tuple[float, float, float, float]
    tcs_brake_capacity_nm: tuple[float, float, float, float]
    esc_brake_capacity_nm: tuple[float, float, float, float]
    total_brake_capacity_nm: tuple[float, float, float, float]
    engine_positive_torque_limit: float
    desired_yaw_rate_rad_s: float
    yaw_error_rad_s: float


class BrakeAssistController:
    """Stateless actuator-capacity evaluation from a frozen state snapshot."""

    def __init__(self, config: BrakeAssistConfig | None = None):
        self.config = config or BrakeAssistConfig()
        self.config.validate()

    def evaluate(
        self,
        *,
        service_brake_request: float,
        parking_brake_request: float,
        body_u_m_s: float,
        yaw_rate_rad_s: float,
        steering_curvature_1pm: float,
        wheel_omega_rad_s: tuple[float, float, float, float],
        effective_radius_m: tuple[float, float, float, float],
        driven_wheels: tuple[bool, bool, bool, bool],
    ) -> AssistEvaluation:
        cfg = self.config
        vectors = (wheel_omega_rad_s, effective_radius_m, driven_wheels)
        if any(len(values) != 4 for values in vectors):
            raise ValueError("brake assists require four wheel inputs")
        numeric = (
            service_brake_request,
            parking_brake_request,
            body_u_m_s,
            yaw_rate_rad_s,
            steering_curvature_1pm,
            *wheel_omega_rad_s,
            *effective_radius_m,
        )
        if not all(math.isfinite(value) for value in numeric):
            raise ValueError("brake-assist inputs must be finite")
        if any(radius <= 0.0 for radius in effective_radius_m):
            raise ValueError("effective radii must be positive")
        service = float(np.clip(service_brake_request, 0.0, 1.0))
        parking = float(np.clip(parking_brake_request, 0.0, 1.0))
        denom = max(abs(body_u_m_s), 0.5)
        slip = tuple((omega * radius - body_u_m_s) / denom for omega, radius in zip(wheel_omega_rad_s, effective_radius_m))

        driver_service = tuple(service * base for base in cfg.service_capacity_nm)
        parking_capacity = tuple(parking * base for base in cfg.parking_capacity_nm)

        max_drive_slip = max((value for value, driven in zip(slip, driven_wheels) if driven), default=0.0)
        drive_excess = max(0.0, max_drive_slip - cfg.tcs_target_drive_slip) if cfg.tcs_enabled else 0.0
        engine_limit = float(np.clip(1.0 - cfg.tcs_torque_cut_gain * drive_excess, 0.0, 1.0))
        tcs_brake = tuple(
            cfg.tcs_brake_gain_nm * max(0.0, value - cfg.tcs_target_drive_slip)
            if cfg.tcs_enabled and driven
            else 0.0
            for value, driven in zip(slip, driven_wheels)
        )

        desired_yaw = body_u_m_s * steering_curvature_1pm
        yaw_error = desired_yaw - yaw_rate_rad_s
        esc = [0.0, 0.0, 0.0, 0.0]
        if cfg.esc_enabled and abs(yaw_error) > cfg.esc_yaw_error_deadband_rad_s:
            request = min(cfg.esc_max_brake_nm, cfg.esc_brake_gain_nm_per_rad_s * abs(yaw_error))
            # Positive missing yaw moment: brake inside rear (left for left turn).
            # Negative missing yaw moment mirrors the allocation.
            esc[2 if yaw_error > 0.0 else 3] = request
        # Driver, TCS and ESC share the service-brake actuator.  Clamp their
        # combined request to the physical per-wheel authority, then apply ABS
        # to that complete channel.  Parking remains independent and bypasses
        # ABS so intentional rear-wheel locking stays possible.
        service_request = tuple(
            min(
                cfg.service_capacity_nm[i],
                driver_service[i] + tcs_brake[i] + esc[i],
            )
            for i in range(4)
        )
        abs_mod = []
        for value, requested_capacity in zip(slip, service_request):
            modulation = 1.0
            if cfg.abs_enabled and requested_capacity > 0.0 and value < cfg.abs_target_braking_slip:
                modulation = max(
                    cfg.abs_min_modulation,
                    1.0 - cfg.abs_release_gain * (cfg.abs_target_braking_slip - value),
                )
            abs_mod.append(modulation)
        service_capacity = tuple(
            requested_capacity * modulation
            for requested_capacity, modulation in zip(service_request, abs_mod)
        )
        total = tuple(
            service_capacity[i] + parking_capacity[i]
            for i in range(4)
        )
        return AssistEvaluation(
            wheel_slip=tuple(map(float, slip)),
            abs_modulation=tuple(map(float, abs_mod)),
            driver_service_capacity_nm=tuple(map(float, driver_service)),
            service_request_capacity_nm=tuple(map(float, service_request)),
            service_capacity_nm=tuple(map(float, service_capacity)),
            parking_capacity_nm=tuple(map(float, parking_capacity)),
            tcs_brake_capacity_nm=tuple(map(float, tcs_brake)),
            esc_brake_capacity_nm=tuple(map(float, esc)),
            total_brake_capacity_nm=tuple(map(float, total)),
            engine_positive_torque_limit=engine_limit,
            desired_yaw_rate_rad_s=float(desired_yaw),
            yaw_error_rad_s=float(yaw_error),
        )
