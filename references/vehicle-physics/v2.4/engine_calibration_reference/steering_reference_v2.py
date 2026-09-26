"""Engine-agnostic steering reference model.

The model deliberately separates five concepts that are often collapsed into one
``steering`` float in games:

1. raw device command;
2. driver intent and device-specific shaping;
3. a stateful rack actuator;
4. per-wheel steering geometry;
5. road reaction / force-feedback rendering.

Angles are radians, distances are metres, forces are newtons, torques are N*m,
and positive steering/yaw means a left turn.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import math
from typing import Iterable, Sequence


EPS = 1.0e-12


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def sign(value: float) -> float:
    if value > 0.0:
        return 1.0
    if value < 0.0:
        return -1.0
    return 0.0


def interp_table(x: float, points: Sequence[tuple[float, float]]) -> float:
    """Piecewise-linear table with clamped endpoints."""
    if not points:
        raise ValueError("interpolation table cannot be empty")
    if x <= points[0][0]:
        return points[0][1]
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x <= x1:
            t = (x - x0) / max(x1 - x0, EPS)
            return lerp(y0, y1, t)
    return points[-1][1]


def wrapped_nearest_mod_pi(angle: float, reference: float) -> float:
    """Select an equivalent rolling direction closest to ``reference``.

    A wheel plane is unchanged by adding pi. This selection prevents a reverse or
    near-zero-speed kinematic solution from flipping the visual wheel by 180 degrees.
    """
    candidates = (angle - math.pi, angle, angle + math.pi)
    return min(candidates, key=lambda candidate: abs(candidate - reference))


class DeviceKind(str, Enum):
    PHYSICAL_WHEEL = "physical_wheel"
    GAMEPAD = "gamepad"
    KEYBOARD = "keyboard"
    AI_CURVATURE = "ai_curvature"


@dataclass(frozen=True)
class SteeringCommand:
    kind: DeviceKind
    value: float


@dataclass(frozen=True)
class DriverIntent:
    kind: DeviceKind
    shaped_input: float
    target_curvature: float
    target_virtual_angle: float
    target_handwheel_angle: float


@dataclass
class InputConfig:
    wheel_lock_rad: float = math.radians(540.0)
    max_virtual_angle_rad: float = math.radians(35.0)
    wheelbase_m: float = 2.70
    gamepad_dead_zone: float = 0.055
    gamepad_exponent: float = 1.55
    keyboard_rise_rate: float = 2.4
    keyboard_fall_rate: float = 3.2
    # Full stick requests at most this approximate lateral acceleration at speed.
    # A regularization speed preserves full parking lock near zero speed.
    gamepad_lateral_accel_authority_mps2: float = 8.5
    gamepad_regularization_speed_mps: float = 5.0

    def validate(self) -> None:
        if self.wheel_lock_rad <= 0.0:
            raise ValueError("wheel_lock_rad must be positive")
        if not 0.0 <= self.gamepad_dead_zone < 1.0:
            raise ValueError("gamepad_dead_zone must be in [0, 1)")
        if self.gamepad_exponent <= 0.0:
            raise ValueError("gamepad_exponent must be positive")
        if self.wheelbase_m <= 0.0:
            raise ValueError("wheelbase_m must be positive")


@dataclass
class DeviceAdapter:
    config: InputConfig = field(default_factory=InputConfig)
    keyboard_axis: float = 0.0

    def __post_init__(self) -> None:
        self.config.validate()

    def reset(self) -> None:
        self.keyboard_axis = 0.0

    def _dead_zone_and_expo(self, raw: float) -> float:
        raw = clamp(raw, -1.0, 1.0)
        magnitude = abs(raw)
        if magnitude <= self.config.gamepad_dead_zone:
            return 0.0
        unit = (magnitude - self.config.gamepad_dead_zone) / (
            1.0 - self.config.gamepad_dead_zone
        )
        return sign(raw) * unit**self.config.gamepad_exponent

    def _keyboard(self, raw: float, dt: float) -> float:
        desired = sign(clamp(raw, -1.0, 1.0))
        moving_outward = abs(desired) > abs(self.keyboard_axis)
        rate = (
            self.config.keyboard_rise_rate
            if moving_outward
            else self.config.keyboard_fall_rate
        )
        delta = clamp(desired - self.keyboard_axis, -rate * dt, rate * dt)
        self.keyboard_axis = clamp(self.keyboard_axis + delta, -1.0, 1.0)
        return self.keyboard_axis

    def _gamepad_max_curvature(self, speed_mps: float) -> float:
        geometry_limit = math.tan(self.config.max_virtual_angle_rad) / self.config.wheelbase_m
        v = abs(speed_mps)
        dynamic_limit = self.config.gamepad_lateral_accel_authority_mps2 / (
            v * v + self.config.gamepad_regularization_speed_mps**2
        )
        return min(geometry_limit, dynamic_limit)

    def adapt(self, command: SteeringCommand, speed_mps: float, dt: float) -> DriverIntent:
        if dt <= 0.0:
            raise ValueError("dt must be positive")

        raw = clamp(command.value, -1.0, 1.0)
        if command.kind is DeviceKind.PHYSICAL_WHEEL:
            shaped = raw
            handwheel = shaped * self.config.wheel_lock_rad
            virtual = shaped * self.config.max_virtual_angle_rad
            curvature = math.tan(virtual) / self.config.wheelbase_m
        elif command.kind is DeviceKind.GAMEPAD:
            shaped = self._dead_zone_and_expo(raw)
            curvature = shaped * self._gamepad_max_curvature(speed_mps)
            virtual = math.atan(self.config.wheelbase_m * curvature)
            handwheel = (
                virtual / self.config.max_virtual_angle_rad * self.config.wheel_lock_rad
            )
        elif command.kind is DeviceKind.KEYBOARD:
            shaped = self._keyboard(raw, dt)
            curvature = shaped * self._gamepad_max_curvature(speed_mps)
            virtual = math.atan(self.config.wheelbase_m * curvature)
            handwheel = (
                virtual / self.config.max_virtual_angle_rad * self.config.wheel_lock_rad
            )
        elif command.kind is DeviceKind.AI_CURVATURE:
            # For this reference API, AI_CURVATURE value is normalized to the
            # vehicle's geometric curvature limit. A production API should carry
            # curvature in 1/m as a typed field rather than overload a scalar.
            curvature_limit = math.tan(self.config.max_virtual_angle_rad) / self.config.wheelbase_m
            shaped = raw
            curvature = shaped * curvature_limit
            virtual = math.atan(self.config.wheelbase_m * curvature)
            handwheel = (
                virtual / self.config.max_virtual_angle_rad * self.config.wheel_lock_rad
            )
        else:  # pragma: no cover - defensive against invalid foreign enum values
            raise ValueError(f"unsupported device kind: {command.kind}")

        return DriverIntent(
            kind=command.kind,
            shaped_input=shaped,
            target_curvature=curvature,
            target_virtual_angle=virtual,
            target_handwheel_angle=handwheel,
        )


@dataclass
class RackMap:
    """Odd, monotonic map from normalized rack travel to virtual steer angle."""

    max_virtual_angle_rad: float = math.radians(35.0)
    progressive_fraction: float = 0.12

    def validate(self) -> None:
        if self.max_virtual_angle_rad <= 0.0:
            raise ValueError("max_virtual_angle_rad must be positive")
        if not -0.49 <= self.progressive_fraction <= 0.49:
            raise ValueError("progressive_fraction outside safe monotonic range")

    def angle_from_q(self, q: float) -> float:
        self.validate()
        q = clamp(q, -1.0, 1.0)
        c = self.progressive_fraction
        return self.max_virtual_angle_rad * ((1.0 - c) * q + c * q**3)

    def derivative(self, q: float) -> float:
        q = clamp(q, -1.0, 1.0)
        c = self.progressive_fraction
        return self.max_virtual_angle_rad * ((1.0 - c) + 3.0 * c * q * q)

    def q_from_angle(self, angle_rad: float) -> float:
        """Deterministic bisection inverse; no solver/library dependency."""
        target = clamp(
            angle_rad, -self.max_virtual_angle_rad, self.max_virtual_angle_rad
        )
        low, high = -1.0, 1.0
        for _ in range(48):
            mid = 0.5 * (low + high)
            if self.angle_from_q(mid) < target:
                low = mid
            else:
                high = mid
        return 0.5 * (low + high)


@dataclass
class PositionActuatorConfig:
    natural_frequency_rad_s: float = 16.0
    damping_ratio: float = 0.95
    max_rate_q_s: float = 5.5
    max_accel_q_s2: float = 75.0
    hard_limit_q: float = 1.0

    def validate(self) -> None:
        if self.natural_frequency_rad_s <= 0.0:
            raise ValueError("natural frequency must be positive")
        if self.damping_ratio <= 0.0:
            raise ValueError("damping ratio must be positive")
        if self.max_rate_q_s <= 0.0 or self.max_accel_q_s2 <= 0.0:
            raise ValueError("actuator rate and acceleration must be positive")
        if not 0.0 < self.hard_limit_q <= 1.0:
            raise ValueError("hard_limit_q must be in (0, 1]")


@dataclass
class RackState:
    q: float = 0.0
    q_rate: float = 0.0


@dataclass
class PositionRackActuator:
    config: PositionActuatorConfig = field(default_factory=PositionActuatorConfig)
    state: RackState = field(default_factory=RackState)

    def __post_init__(self) -> None:
        self.config.validate()

    def reset(self, q: float = 0.0, q_rate: float = 0.0) -> None:
        self.state = RackState(
            clamp(q, -self.config.hard_limit_q, self.config.hard_limit_q), q_rate
        )

    def step(self, target_q: float, dt: float) -> RackState:
        if dt <= 0.0:
            raise ValueError("dt must be positive")
        cfg = self.config
        target_q = clamp(target_q, -cfg.hard_limit_q, cfg.hard_limit_q)
        wn = cfg.natural_frequency_rad_s
        acceleration = wn * wn * (target_q - self.state.q) - (
            2.0 * cfg.damping_ratio * wn * self.state.q_rate
        )
        acceleration = clamp(acceleration, -cfg.max_accel_q_s2, cfg.max_accel_q_s2)
        new_rate = clamp(
            self.state.q_rate + acceleration * dt,
            -cfg.max_rate_q_s,
            cfg.max_rate_q_s,
        )
        new_q = self.state.q + new_rate * dt

        if new_q >= cfg.hard_limit_q:
            new_q = cfg.hard_limit_q
            new_rate = min(0.0, new_rate)
        elif new_q <= -cfg.hard_limit_q:
            new_q = -cfg.hard_limit_q
            new_rate = max(0.0, new_rate)

        self.state = RackState(new_q, new_rate)
        return self.state


@dataclass
class SteeringGeometryConfig:
    wheelbase_m: float = 2.70
    front_track_m: float = 1.60
    ackermann_strength: float = 0.82
    static_toe_in_rad: float = math.radians(0.04)
    left_bump_steer_rad_per_m: float = math.radians(-8.0)
    right_bump_steer_rad_per_m: float = math.radians(8.0)

    def validate(self) -> None:
        if self.wheelbase_m <= 0.0 or self.front_track_m <= 0.0:
            raise ValueError("wheelbase and track must be positive")
        if not -1.0 <= self.ackermann_strength <= 1.5:
            raise ValueError("ackermann_strength outside supported range")


@dataclass(frozen=True)
class WheelAngles:
    left_rad: float
    right_rad: float


@dataclass
class SteeringGeometry:
    config: SteeringGeometryConfig = field(default_factory=SteeringGeometryConfig)

    def __post_init__(self) -> None:
        self.config.validate()

    def front_angles(
        self,
        virtual_angle_rad: float,
        left_jounce_m: float = 0.0,
        right_jounce_m: float = 0.0,
    ) -> WheelAngles:
        cfg = self.config
        curvature = math.tan(virtual_angle_rad) / cfg.wheelbase_m
        half_track = 0.5 * cfg.front_track_m
        a = cfg.ackermann_strength
        left = math.atan2(
            cfg.wheelbase_m * curvature, 1.0 - a * half_track * curvature
        )
        right = math.atan2(
            cfg.wheelbase_m * curvature, 1.0 + a * half_track * curvature
        )

        # Positive toe-in points each front edge toward the vehicle centerline.
        left -= cfg.static_toe_in_rad
        right += cfg.static_toe_in_rad
        left += cfg.left_bump_steer_rad_per_m * left_jounce_m
        right += cfg.right_bump_steer_rad_per_m * right_jounce_m
        return WheelAngles(left, right)

    def angle_derivatives_wrt_q(
        self,
        rack_map: RackMap,
        q: float,
        epsilon: float = 1.0e-5,
    ) -> WheelAngles:
        q0 = clamp(q - epsilon, -1.0, 1.0)
        q1 = clamp(q + epsilon, -1.0, 1.0)
        if abs(q1 - q0) < EPS:
            return WheelAngles(0.0, 0.0)
        lo = self.front_angles(rack_map.angle_from_q(q0))
        hi = self.front_angles(rack_map.angle_from_q(q1))
        return WheelAngles(
            (hi.left_rad - lo.left_rad) / (q1 - q0),
            (hi.right_rad - lo.right_rad) / (q1 - q0),
        )


@dataclass(frozen=True)
class WheelPlanarLocation:
    x_m: float
    y_m: float
    reference_angle_rad: float = 0.0


def planar_twist_wheel_angles(
    wheel_locations: Iterable[WheelPlanarLocation],
    curvature_1pm: float,
    body_sideslip_rad: float = 0.0,
) -> list[float]:
    """General low-speed geometry for 4WS, multi-axle or crab steering.

    A unit longitudinal body velocity and yaw rate equal to curvature define the
    velocity at wheel i as ``[cos(beta)-k*y, sin(beta)+k*x]``. Each wheel is aligned
    with this local velocity and then wrapped to its nearest equivalent wheel plane.
    """
    vx = math.cos(body_sideslip_rad)
    vy = math.sin(body_sideslip_rad)
    angles: list[float] = []
    for location in wheel_locations:
        local_x = vx - curvature_1pm * location.y_m
        local_y = vy + curvature_1pm * location.x_m
        raw = math.atan2(local_y, local_x)
        angles.append(wrapped_nearest_mod_pi(raw, location.reference_angle_rad))
    return angles


@dataclass(frozen=True)
class SteeringOutput:
    intent: DriverIntent
    rack_q: float
    rack_rate_q_s: float
    handwheel_angle_rad: float
    virtual_angle_rad: float
    curvature_1pm: float
    wheel_angles: WheelAngles


@dataclass
class SteeringSystem:
    adapter: DeviceAdapter = field(default_factory=DeviceAdapter)
    rack_map: RackMap = field(default_factory=RackMap)
    actuator: PositionRackActuator = field(default_factory=PositionRackActuator)
    geometry: SteeringGeometry = field(default_factory=SteeringGeometry)

    def reset(self) -> None:
        self.adapter.reset()
        self.actuator.reset()

    def step(
        self,
        command: SteeringCommand,
        speed_mps: float,
        dt: float,
        left_jounce_m: float = 0.0,
        right_jounce_m: float = 0.0,
    ) -> SteeringOutput:
        intent = self.adapter.adapt(command, speed_mps, dt)
        target_q = self.rack_map.q_from_angle(intent.target_virtual_angle)
        rack = self.actuator.step(target_q, dt)
        virtual = self.rack_map.angle_from_q(rack.q)
        wheel_angles = self.geometry.front_angles(
            virtual, left_jounce_m, right_jounce_m
        )
        curvature = math.tan(virtual) / self.geometry.config.wheelbase_m
        handwheel = rack.q * self.adapter.config.wheel_lock_rad
        return SteeringOutput(
            intent=intent,
            rack_q=rack.q,
            rack_rate_q_s=rack.q_rate,
            handwheel_angle_rad=handwheel,
            virtual_angle_rad=virtual,
            curvature_1pm=curvature,
            wheel_angles=wheel_angles,
        )


@dataclass(frozen=True)
class TireSteeringLoad:
    longitudinal_force_n: float
    lateral_force_n: float
    intrinsic_aligning_moment_nm: float
    mechanical_trail_m: float
    scrub_radius_m: float = 0.0

    def steering_axis_torque_nm(self) -> float:
        # Ground-plane approximation of r x F + intrinsic Mz. A positive lateral
        # force in a left turn therefore produces a negative (centering) torque.
        return (
            self.intrinsic_aligning_moment_nm
            - self.mechanical_trail_m * self.lateral_force_n
            - self.scrub_radius_m * self.longitudinal_force_n
        )


@dataclass
class ReactionConfig:
    handwheel_lock_rad: float = math.radians(540.0)
    road_weight_by_speed: tuple[tuple[float, float], ...] = (
        (0.0, 0.24),
        (5.0, 0.30),
        (15.0, 0.48),
        (30.0, 0.66),
        (60.0, 0.72),
    )
    jacking_generalized_stiffness_nm: float = 4.0
    column_damping_nm_s_per_rad: float = 0.045
    coulomb_friction_nm: float = 0.06
    friction_smoothing_rad_s: float = 0.08
    output_lowpass_hz: float = 18.0
    max_output_torque_nm: float = 10.0


@dataclass(frozen=True)
class SteeringReactionOutput:
    axis_torques_nm: WheelAngles
    road_generalized_torque_nm: float
    road_handwheel_torque_nm: float
    jacking_handwheel_torque_nm: float
    damping_torque_nm: float
    friction_torque_nm: float
    ffb_torque_nm: float
    intrinsic_mz_generalized_torque_nm: float = 0.0
    load_source: str = "REDUCED_AXIS_APPROXIMATION"


@dataclass
class SteeringReactionModel:
    config: ReactionConfig = field(default_factory=ReactionConfig)
    filtered_output_nm: float = 0.0

    def reset(self) -> None:
        self.filtered_output_nm = 0.0

    def step(
        self,
        speed_mps: float,
        rack_q: float,
        handwheel_rate_rad_s: float,
        angle_derivatives_wrt_q: WheelAngles,
        left_load: TireSteeringLoad,
        right_load: TireSteeringLoad,
        dt: float,
    ) -> SteeringReactionOutput:
        if dt <= 0.0:
            raise ValueError("dt must be positive")
        cfg = self.config
        tau_left = left_load.steering_axis_torque_nm()
        tau_right = right_load.steering_axis_torque_nm()
        q_road = (
            tau_left * angle_derivatives_wrt_q.left_rad
            + tau_right * angle_derivatives_wrt_q.right_rad
        )
        road_at_handwheel = q_road / max(cfg.handwheel_lock_rad, EPS)
        road_weight = interp_table(abs(speed_mps), cfg.road_weight_by_speed)

        # A speed-independent low-speed centering component approximates steering
        # geometry jacking. It is intentionally separate from tire aligning moment.
        q_jack = -cfg.jacking_generalized_stiffness_nm * math.sin(
            0.5 * math.pi * clamp(rack_q, -1.0, 1.0)
        )
        jack_at_handwheel = q_jack / max(cfg.handwheel_lock_rad, EPS)
        damping = -cfg.column_damping_nm_s_per_rad * handwheel_rate_rad_s
        friction = -cfg.coulomb_friction_nm * math.tanh(
            handwheel_rate_rad_s / max(cfg.friction_smoothing_rad_s, EPS)
        )
        raw = road_weight * road_at_handwheel + jack_at_handwheel + damping + friction
        raw = clamp(raw, -cfg.max_output_torque_nm, cfg.max_output_torque_nm)

        # Exact one-pole discretization remains stable when render dt varies.
        alpha = 1.0 - math.exp(-2.0 * math.pi * cfg.output_lowpass_hz * dt)
        self.filtered_output_nm += alpha * (raw - self.filtered_output_nm)
        return SteeringReactionOutput(
            axis_torques_nm=WheelAngles(tau_left, tau_right),
            road_generalized_torque_nm=q_road,
            road_handwheel_torque_nm=road_at_handwheel,
            jacking_handwheel_torque_nm=jack_at_handwheel,
            damping_torque_nm=damping,
            friction_torque_nm=friction,
            ffb_torque_nm=self.filtered_output_nm,
        )

    def step_projected(
        self,
        speed_mps: float,
        rack_q: float,
        handwheel_rate_rad_s: float,
        wheel_generalized_loads_nm: WheelAngles,
        intrinsic_mz_generalized_torque_nm: float,
        dt: float,
    ) -> SteeringReactionOutput:
        """Filter one already-projected K&C spatial ``J^T W`` road load.

        ``wheel_generalized_loads_nm`` are contributions conjugate to the
        normalized rack coordinate.  They already contain force, intrinsic
        moment, trail/scrub geometry, and the declared wrench point.  This path
        therefore must not call :meth:`TireSteeringLoad.steering_axis_torque_nm`
        or append another ``Fy*trail``/``Fx*scrub`` term.
        """

        if dt <= 0.0:
            raise ValueError("dt must be positive")
        cfg = self.config
        q_road = wheel_generalized_loads_nm.left_rad + wheel_generalized_loads_nm.right_rad
        road_at_handwheel = q_road / max(cfg.handwheel_lock_rad, EPS)
        road_weight = interp_table(abs(speed_mps), cfg.road_weight_by_speed)
        q_jack = -cfg.jacking_generalized_stiffness_nm * math.sin(
            0.5 * math.pi * clamp(rack_q, -1.0, 1.0)
        )
        jack_at_handwheel = q_jack / max(cfg.handwheel_lock_rad, EPS)
        damping = -cfg.column_damping_nm_s_per_rad * handwheel_rate_rad_s
        friction = -cfg.coulomb_friction_nm * math.tanh(
            handwheel_rate_rad_s / max(cfg.friction_smoothing_rad_s, EPS)
        )
        raw = road_weight * road_at_handwheel + jack_at_handwheel + damping + friction
        raw = clamp(raw, -cfg.max_output_torque_nm, cfg.max_output_torque_nm)
        alpha = 1.0 - math.exp(-2.0 * math.pi * cfg.output_lowpass_hz * dt)
        self.filtered_output_nm += alpha * (raw - self.filtered_output_nm)
        return SteeringReactionOutput(
            axis_torques_nm=WheelAngles(0.0, 0.0),
            road_generalized_torque_nm=q_road,
            road_handwheel_torque_nm=road_at_handwheel,
            jacking_handwheel_torque_nm=jack_at_handwheel,
            damping_torque_nm=damping,
            friction_torque_nm=friction,
            ffb_torque_nm=self.filtered_output_nm,
            intrinsic_mz_generalized_torque_nm=intrinsic_mz_generalized_torque_nm,
            load_source="KC_SPATIAL_JTW_FULL_WRENCH",
        )


@dataclass
class TorqueRackConfig:
    equivalent_inertia_nm_s2: float = 6.0
    damping_nm_s: float = 10.0
    coulomb_friction_nm: float = 0.8
    friction_smoothing_q_s: float = 0.04
    hard_limit_q: float = 1.0
    stop_stiffness_nm: float = 1200.0
    stop_damping_nm_s: float = 40.0
    eps_assist_gain_by_speed: tuple[tuple[float, float], ...] = (
        (0.0, 2.6),
        (5.0, 2.2),
        (15.0, 1.2),
        (30.0, 0.45),
        (60.0, 0.25),
    )
    return_gain_nm: float = 7.0
    return_damping_nm_s: float = 5.0
    max_eps_generalized_torque_nm: float = 25.0

    def validate(self) -> None:
        if self.equivalent_inertia_nm_s2 <= 0.0:
            raise ValueError("rack inertia must be positive")
        if self.damping_nm_s < 0.0 or self.coulomb_friction_nm < 0.0:
            raise ValueError("rack dissipation parameters must be non-negative")
        if self.friction_smoothing_q_s <= 0.0:
            raise ValueError("rack friction smoothing speed must be positive")
        if self.hard_limit_q <= 0.0 or self.stop_stiffness_nm < 0.0 or self.stop_damping_nm_s < 0.0:
            raise ValueError("rack stop parameters are invalid")
        if self.max_eps_generalized_torque_nm < 0.0:
            raise ValueError("EPS torque limit must be non-negative")


@dataclass(frozen=True)
class TorqueRackEvaluation:
    driver_generalized_torque_nm: float
    eps_assist_generalized_torque_nm: float
    road_generalized_torque_nm: float
    damping_generalized_torque_nm: float
    friction_generalized_torque_nm: float
    stop_generalized_torque_nm: float
    total_generalized_torque_nm: float
    acceleration_q_s2: float


@dataclass
class TorqueDrivenRack:
    """Optional backdrivable rack, expressed in normalized rack coordinate q.

    This is not used by the default position-source SteeringSystem. It exists to
    make the V2 boundary concrete: driver, EPS and road loads are generalized
    torques in the same coordinate and are integrated exactly once.
    """

    config: TorqueRackConfig = field(default_factory=TorqueRackConfig)
    state: RackState = field(default_factory=RackState)

    def __post_init__(self) -> None:
        self.config.validate()

    def reset(self, q: float = 0.0, q_rate: float = 0.0) -> None:
        self.state = RackState(q, q_rate)

    def step(
        self,
        driver_generalized_torque_nm: float,
        road_generalized_torque_nm: float,
        speed_mps: float,
        driver_releasing: bool,
        dt: float,
    ) -> RackState:
        if dt <= 0.0:
            raise ValueError("dt must be positive")
        evaluated = self.evaluate(
            RackState(self.state.q, self.state.q_rate),
            driver_generalized_torque_nm,
            road_generalized_torque_nm,
            speed_mps,
            driver_releasing,
        )
        new_rate = self.state.q_rate + evaluated.acceleration_q_s2 * dt
        new_q = self.state.q + new_rate * dt
        self.state = RackState(new_q, new_rate)
        return self.state

    def evaluate(
        self,
        state: RackState,
        driver_generalized_torque_nm: float,
        road_generalized_torque_nm: float,
        speed_mps: float,
        driver_releasing: bool,
    ) -> TorqueRackEvaluation:
        """Evaluate the rack torque ledger without mutating canonical state."""

        values = (
            state.q,
            state.q_rate,
            driver_generalized_torque_nm,
            road_generalized_torque_nm,
            speed_mps,
        )
        if not all(math.isfinite(value) for value in values):
            raise ValueError("rack evaluation inputs must be finite")
        cfg = self.config
        assist_gain = interp_table(abs(speed_mps), cfg.eps_assist_gain_by_speed)
        eps = assist_gain * driver_generalized_torque_nm
        if driver_releasing:
            eps += -cfg.return_gain_nm * state.q - cfg.return_damping_nm_s * state.q_rate
        eps = clamp(
            eps,
            -cfg.max_eps_generalized_torque_nm,
            cfg.max_eps_generalized_torque_nm,
        )

        friction = cfg.coulomb_friction_nm * math.tanh(
            state.q_rate / max(cfg.friction_smoothing_q_s, EPS)
        )
        stop = 0.0
        if state.q > cfg.hard_limit_q:
            stop = -cfg.stop_stiffness_nm * (state.q - cfg.hard_limit_q)
            stop -= cfg.stop_damping_nm_s * max(state.q_rate, 0.0)
        elif state.q < -cfg.hard_limit_q:
            stop = -cfg.stop_stiffness_nm * (state.q + cfg.hard_limit_q)
            stop -= cfg.stop_damping_nm_s * min(state.q_rate, 0.0)

        total = (
            driver_generalized_torque_nm
            + eps
            + road_generalized_torque_nm
            - cfg.damping_nm_s * state.q_rate
            - friction
            + stop
        )
        acceleration = total / max(cfg.equivalent_inertia_nm_s2, EPS)
        return TorqueRackEvaluation(
            driver_generalized_torque_nm=driver_generalized_torque_nm,
            eps_assist_generalized_torque_nm=eps,
            road_generalized_torque_nm=road_generalized_torque_nm,
            damping_generalized_torque_nm=-cfg.damping_nm_s * state.q_rate,
            friction_generalized_torque_nm=-friction,
            stop_generalized_torque_nm=stop,
            total_generalized_torque_nm=total,
            acceleration_q_s2=acceleration,
        )
