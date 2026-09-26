"""Legacy synthetic longitudinal integration oracle.

Retained for v2.0 evidence compatibility. This fixture does not constitute
production 6DOF whole-vehicle closure. The v2.2 authoritative reduced
cross-system surface is ``unified_vehicle_fixture.py``; the v2.1
``integrated_closeout.py`` path is also historical.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
import math
from typing import Callable

import numpy as np

from .engine_model import (
    DomainError,
    EngineCommand,
    EngineMode,
    EngineModel,
    EngineOwner,
    EngineState,
    EngineTorqueSample,
    rpm_to_rad_s,
)


@dataclass(frozen=True)
class AeroWrenchSample:
    drag_n: float
    downforce_n: float
    pitch_moment_n_m: float
    relative_air_speed_m_s: float


@dataclass(frozen=True)
class SyntheticAeroAdapter:
    rho_kg_m3: float
    cd_area_m2: float
    cl_area_m2: float
    aero_front_fraction: float
    wheelbase_m: float
    cg_to_rear_axle_m: float

    def sample(self, vehicle_speed_m_s: float, wind_speed_m_s: float = 0.0) -> AeroWrenchSample:
        relative = vehicle_speed_m_s - wind_speed_m_s
        q = 0.5 * self.rho_kg_m3 * relative * abs(relative)
        drag = self.cd_area_m2 * q
        downforce = self.cl_area_m2 * 0.5 * self.rho_kg_m3 * relative**2
        moment = (
            self.aero_front_fraction * self.wheelbase_m - self.cg_to_rear_axle_m
        ) * downforce
        return AeroWrenchSample(float(drag), float(downforce), float(moment), float(relative))


@dataclass(frozen=True)
class AxleLoadSample:
    front_normal_n: float
    rear_normal_n: float
    reconstruction_force_error_n: float
    reconstruction_moment_error_n_m: float


@dataclass(frozen=True)
class SyntheticSuspensionLoadPathAdapter:
    mass_kg: float
    wheelbase_m: float
    cg_to_rear_axle_m: float
    gravity_m_s2: float = 9.81

    def axle_loads(self, aero: AeroWrenchSample) -> AxleLoadSample:
        total = self.mass_kg * self.gravity_m_s2 + aero.downforce_n
        # Magnitude convention for this fixture: front/rear normal load is
        # positive downward demand carried by the ground reaction.  Aero My is
        # reconstructed about the chassis reference point/COM.
        front = (
            self.mass_kg * self.gravity_m_s2 * self.cg_to_rear_axle_m
            + aero.downforce_n * self.cg_to_rear_axle_m
            + aero.pitch_moment_n_m
        ) / self.wheelbase_m
        rear = total - front
        force_error = front + rear - total
        moment = (
            front * self.wheelbase_m
            - total * self.cg_to_rear_axle_m
            - aero.pitch_moment_n_m
        )
        return AxleLoadSample(float(front), float(rear), float(force_error), float(moment))


@dataclass(frozen=True)
class WholeVehicleConfig:
    mass_kg: float = 1420.0
    wheel_radius_m: float = 0.33
    driven_wheel_inertia_kg_m2: float = 1.25
    total_ratio: float = 9.0
    clutch_capacity_nm: float = 900.0
    tire_mu: float = 1.8
    rolling_resistance_coefficient: float = 0.012
    wheelbase_m: float = 2.72
    cg_to_rear_axle_m: float = 1.42
    rho_kg_m3: float = 1.225
    cd_area_m2: float = 0.68
    cl_area_m2: float = 0.35
    aero_front_fraction: float = 0.46

    def validate(self) -> None:
        positive = (
            self.mass_kg,
            self.wheel_radius_m,
            self.driven_wheel_inertia_kg_m2,
            abs(self.total_ratio),
            self.clutch_capacity_nm,
            self.tire_mu,
            self.wheelbase_m,
            self.rho_kg_m3,
        )
        if any(v <= 0.0 or not math.isfinite(v) for v in positive):
            raise ValueError("whole-vehicle fixture requires finite positive physical parameters")
        if not 0.0 < self.cg_to_rear_axle_m < self.wheelbase_m:
            raise ValueError("CG longitudinal location must lie between axles")
        if not 0.0 <= self.aero_front_fraction <= 1.0:
            raise ValueError("aero front fraction must lie in [0,1]")


@dataclass(frozen=True)
class WholeVehicleState:
    engine: EngineState
    wheel_omega_rad_s: tuple[float, float]
    chassis_speed_m_s: float
    distance_m: float = 0.0


@dataclass(frozen=True)
class WholeVehicleStepResult:
    state: WholeVehicleState
    engine_sample: EngineTorqueSample
    aero: AeroWrenchSample
    axle_load: AxleLoadSample
    tire_force_total_n: float
    tire_capacity_total_n: float
    clutch_reaction_on_engine_nm: float
    clutch_capacity_nm: float
    engine_row_residual_nms: float
    wheel_row_residual_nms: tuple[float, float]
    chassis_row_residual_n_s: float
    clutch_speed_residual_rad_s: float
    tire_speed_residual_m_s: tuple[float, float]
    nonlinear_iterations: int
    status: str


def make_consistent_state(
    speed_m_s: float,
    config: WholeVehicleConfig,
    mode: EngineMode = EngineMode.RUNNING,
    load_actuated: float = 0.0,
) -> WholeVehicleState:
    wheel = speed_m_s / config.wheel_radius_m
    engine = config.total_ratio * wheel
    return WholeVehicleState(
        EngineState(engine, mode, load_actuated),
        (wheel, wheel),
        speed_m_s,
        0.0,
    )


def solve_locked_adhesion_substep(
    engine_owner: EngineOwner,
    state: WholeVehicleState,
    config: WholeVehicleConfig,
    command: EngineCommand,
    dt: float,
    wind_speed_m_s: float = 0.0,
    max_iterations: int = 60,
) -> WholeVehicleStepResult:
    """Implicit locked-clutch + tire-adhesion whole-vehicle oracle."""
    config.validate()
    if dt <= 0.0:
        raise ValueError("dt must be positive")
    if engine_owner.state != state.engine:
        raise ValueError("whole-vehicle state and Engine owner are not synchronized")
    radius = config.wheel_radius_m
    ratio = config.total_ratio
    expected_wheel = state.chassis_speed_m_s / radius
    if max(abs(w - expected_wheel) for w in state.wheel_omega_rad_s) > 1e-8:
        raise ValueError("fixture requires an initially adhered wheel state")
    if abs(state.engine.omega_rad_s - ratio * expected_wheel) > 1e-8:
        raise ValueError("fixture requires an initially locked clutch state")

    ticket = engine_owner.begin_substep(command, dt)
    aero_adapter = SyntheticAeroAdapter(
        config.rho_kg_m3,
        config.cd_area_m2,
        config.cl_area_m2,
        config.aero_front_fraction,
        config.wheelbase_m,
        config.cg_to_rear_axle_m,
    )
    suspension_adapter = SyntheticSuspensionLoadPathAdapter(
        config.mass_kg, config.wheelbase_m, config.cg_to_rear_axle_m
    )
    engine_inertia = engine_owner.model.asset.inertia_kg_m2
    equivalent_mass = (
        config.mass_kg
        + 2.0 * config.driven_wheel_inertia_kg_m2 / radius**2
        + engine_inertia * ratio**2 / radius**2
    )
    upper_speed = rpm_to_rad_s(engine_owner.model.asset.hard_overspeed_rpm) * radius / abs(ratio)

    def residual(speed: float) -> tuple[float, float, EngineTorqueSample, AeroWrenchSample]:
        omega_engine = ratio * speed / radius
        sample = engine_owner.evaluate(ticket, omega_engine)
        aero = aero_adapter.sample(speed, wind_speed_m_s)
        rolling = config.rolling_resistance_coefficient * config.mass_kg * 9.81
        road_force = aero.drag_n + math.copysign(rolling, speed) if speed != 0.0 else aero.drag_n
        value = equivalent_mass * (speed - state.chassis_speed_m_s) - dt * (
            sample.free_torque_nm * ratio / radius - road_force
        )
        ddrag_dspeed = config.rho_kg_m3 * config.cd_area_m2 * abs(
            aero.relative_air_speed_m_s
        )
        derivative = (
            equivalent_mass
            - dt * sample.dtorque_domega_nm_per_rad_s * (ratio / radius) ** 2
            + dt * ddrag_dspeed
        )
        return float(value), float(derivative), sample, aero

    lo, hi = 0.0, upper_speed
    f_lo, _, _, _ = residual(lo)
    f_hi, _, _, _ = residual(hi)
    if f_lo > 0.0 or f_hi < 0.0:
        raise DomainError("whole-vehicle implicit root lies outside supported speed domain")
    speed = float(np.clip(state.chassis_speed_m_s, lo, hi))
    tolerance = 1e-10 * max(1.0, equivalent_mass * max(1.0, state.chassis_speed_m_s))
    for iteration in range(1, max_iterations + 1):
        value, derivative, sample, aero = residual(speed)
        if abs(value) <= tolerance:
            break
        if value > 0.0:
            hi = speed
        else:
            lo = speed
        candidate = speed - value / derivative if derivative > 0.0 else math.nan
        if not math.isfinite(candidate) or candidate <= lo or candidate >= hi:
            candidate = 0.5 * (lo + hi)
        speed = candidate
    else:
        raise RuntimeError("whole-vehicle implicit solve did not converge")

    omega_engine = ratio * speed / radius
    omega_wheel = speed / radius
    engine_impulse = (
        engine_inertia * (omega_engine - state.engine.omega_rad_s)
        - dt * sample.free_torque_nm
    )
    clutch_reaction = -engine_impulse / dt
    rolling = config.rolling_resistance_coefficient * config.mass_kg * 9.81
    road_force = aero.drag_n + (rolling if speed > 0.0 else 0.0)
    tire_body_impulse_total = config.mass_kg * (speed - state.chassis_speed_m_s) + dt * road_force
    tire_force_total = tire_body_impulse_total / dt
    axle_load = suspension_adapter.axle_loads(aero)
    tire_capacity = config.tire_mu * axle_load.rear_normal_n

    status = "IN_DOMAIN"
    if abs(clutch_reaction) > config.clutch_capacity_nm * (1.0 + 1e-9):
        status = "CLUTCH_CAPACITY_EXCEEDED"
    if abs(tire_force_total) > tire_capacity * (1.0 + 1e-9):
        status = (
            "TIRE_CAPACITY_EXCEEDED"
            if status == "IN_DOMAIN"
            else "MULTIPLE_CAPACITY_EXCEEDED"
        )

    wheel0 = np.asarray(state.wheel_omega_rad_s, dtype=float)
    wheel1 = np.array([omega_wheel, omega_wheel])
    mapping_each = ratio / 2.0
    tire_impulse_each = tire_body_impulse_total / 2.0
    wheel_residual = (
        config.driven_wheel_inertia_kg_m2 * (wheel1 - wheel0)
        + mapping_each * engine_impulse
        + radius * tire_impulse_each
    )
    engine_residual = (
        engine_inertia * (omega_engine - state.engine.omega_rad_s)
        - dt * sample.free_torque_nm
        - engine_impulse
    )
    chassis_residual = (
        config.mass_kg * (speed - state.chassis_speed_m_s)
        - tire_body_impulse_total
        + dt * road_force
    )

    engine_state = engine_owner.commit(ticket, omega_engine)
    next_state = WholeVehicleState(
        engine=engine_state,
        wheel_omega_rad_s=(omega_wheel, omega_wheel),
        chassis_speed_m_s=speed,
        distance_m=state.distance_m + 0.5 * (state.chassis_speed_m_s + speed) * dt,
    )
    return WholeVehicleStepResult(
        state=next_state,
        engine_sample=sample,
        aero=aero,
        axle_load=axle_load,
        tire_force_total_n=float(tire_force_total),
        tire_capacity_total_n=float(tire_capacity),
        clutch_reaction_on_engine_nm=float(clutch_reaction),
        clutch_capacity_nm=config.clutch_capacity_nm,
        engine_row_residual_nms=float(engine_residual),
        wheel_row_residual_nms=tuple(map(float, wheel_residual)),
        chassis_row_residual_n_s=float(chassis_residual),
        clutch_speed_residual_rad_s=float(omega_engine - ratio * 0.5 * (omega_wheel + omega_wheel)),
        tire_speed_residual_m_s=(float(radius * omega_wheel - speed),) * 2,
        nonlinear_iterations=iteration,
        status=status,
    )


@dataclass(frozen=True)
class WholeVehicleTrace:
    time_s: np.ndarray
    speed_m_s: np.ndarray
    engine_rpm: np.ndarray
    distance_m: np.ndarray
    max_engine_residual_nms: float
    max_wheel_residual_nms: float
    max_chassis_residual_n_s: float
    max_load_path_force_error_n: float
    max_load_path_moment_error_n_m: float
    statuses: tuple[str, ...]


def simulate_whole_vehicle(
    engine_model: EngineModel,
    config: WholeVehicleConfig,
    initial_speed_m_s: float,
    duration_s: float,
    dt: float,
    command_at: Callable[[float, WholeVehicleState], EngineCommand] | None = None,
) -> WholeVehicleTrace:
    state = make_consistent_state(initial_speed_m_s, config, EngineMode.RUNNING, 1.0)
    owner = EngineOwner(engine_model, state.engine)
    count = int(round(duration_s / dt)) + 1
    times = np.linspace(0.0, duration_s, count)
    speed = np.empty(count)
    rpm = np.empty(count)
    distance = np.empty(count)
    statuses: list[str] = []
    max_engine = max_wheel = max_chassis = max_force = max_moment = 0.0
    if command_at is None:
        command_at = lambda _t, _s: EngineCommand(1.0)
    for i, time_s in enumerate(times):
        speed[i] = state.chassis_speed_m_s
        rpm[i] = state.engine.rpm
        distance[i] = state.distance_m
        if i == count - 1:
            break
        result = solve_locked_adhesion_substep(
            owner, state, config, command_at(float(time_s), state), dt
        )
        statuses.append(result.status)
        max_engine = max(max_engine, abs(result.engine_row_residual_nms))
        max_wheel = max(max_wheel, *(abs(v) for v in result.wheel_row_residual_nms))
        max_chassis = max(max_chassis, abs(result.chassis_row_residual_n_s))
        max_force = max(max_force, abs(result.axle_load.reconstruction_force_error_n))
        max_moment = max(max_moment, abs(result.axle_load.reconstruction_moment_error_n_m))
        state = result.state
    return WholeVehicleTrace(
        times,
        speed,
        rpm,
        distance,
        max_engine,
        max_wheel,
        max_chassis,
        max_force,
        max_moment,
        tuple(statuses),
    )
