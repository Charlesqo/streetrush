"""Small numerical fixtures used to verify interfaces and identifiability."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import math
from typing import Callable

import numpy as np

from .engine_model import (
    DomainError,
    EngineCommand,
    EngineModel,
    EngineOwner,
    EngineSolveTicket,
    EngineState,
    EngineTorqueSample,
    rpm_to_rad_s,
)


@dataclass(frozen=True)
class EngineTrace:
    time_s: np.ndarray
    rpm: np.ndarray
    torque_nm: np.ndarray
    load: np.ndarray
    mode: tuple[str, ...]
    limiter_cut: np.ndarray
    events: tuple[tuple[str, ...], ...]


def simulate_engine(
    model: EngineModel,
    initial: EngineState,
    command_at: Callable[[float, EngineState], EngineCommand],
    clutch_reaction_at: Callable[[float, EngineState], float],
    duration_s: float,
    dt: float,
) -> EngineTrace:
    count = int(round(duration_s / dt)) + 1
    time = np.linspace(0.0, duration_s, count)
    rpm = np.empty(count)
    torque = np.empty(count)
    load = np.empty(count)
    cut = np.empty(count, dtype=bool)
    modes: list[str] = []
    event_log: list[tuple[str, ...]] = []
    state = initial
    for i, t in enumerate(time):
        rpm[i] = state.rpm
        modes.append(state.mode.value)
        cut[i] = state.limiter_cut
        if i == count - 1:
            torque[i] = torque[i - 1] if i else 0.0
            load[i] = state.load_actuated
            event_log.append(())
            break
        result = model.integrate_standalone(
            state,
            command_at(float(t), state),
            clutch_reaction_at(float(t), state),
            dt,
        )
        torque[i] = result.prepared.free_torque_nm
        load[i] = result.prepared.effective_load
        event_log.append(result.prepared.events)
        state = result.state
    return EngineTrace(time, rpm, torque, load, tuple(modes), cut, tuple(event_log))


def explicit_linear_clutch_step(
    omega_engine: float,
    omega_wheel: float,
    inertia_engine: float,
    inertia_wheel: float,
    clutch_stiffness_nm_per_rad_s: float,
    dt: float,
    engine_torque_nm: float = 0.0,
    wheel_torque_nm: float = 0.0,
) -> tuple[float, float]:
    reaction = clutch_stiffness_nm_per_rad_s * (omega_engine - omega_wheel)
    return (
        omega_engine + dt * (engine_torque_nm - reaction) / inertia_engine,
        omega_wheel + dt * (wheel_torque_nm + reaction) / inertia_wheel,
    )


def implicit_linear_clutch_step(
    omega_engine: float,
    omega_wheel: float,
    inertia_engine: float,
    inertia_wheel: float,
    clutch_stiffness_nm_per_rad_s: float,
    dt: float,
    engine_torque_nm: float = 0.0,
    wheel_torque_nm: float = 0.0,
) -> tuple[float, float]:
    """Implicit Euler solution of a two-inertia clutch penalty fixture."""
    k = clutch_stiffness_nm_per_rad_s
    matrix = np.array(
        [
            [1.0 + dt * k / inertia_engine, -dt * k / inertia_engine],
            [-dt * k / inertia_wheel, 1.0 + dt * k / inertia_wheel],
        ],
        dtype=float,
    )
    rhs = np.array(
        [
            omega_engine + dt * engine_torque_nm / inertia_engine,
            omega_wheel + dt * wheel_torque_nm / inertia_wheel,
        ],
        dtype=float,
    )
    solved = np.linalg.solve(matrix, rhs)
    return float(solved[0]), float(solved[1])


def rotational_energy(
    omega_engine: float, omega_wheel: float, inertia_engine: float, inertia_wheel: float
) -> float:
    return 0.5 * inertia_engine * omega_engine**2 + 0.5 * inertia_wheel * omega_wheel**2


class ClutchSolveMode(str, Enum):
    NEUTRAL = "NEUTRAL"
    LOCKED = "LOCKED"
    SLIPPING = "SLIPPING"


@dataclass(frozen=True)
class CoupledDrivetrainConfig:
    """Compiled clutch-side mapping from the already accepted drivetrain graph.

    ``clutch_speed_mapping`` defines ``omega_clutch = a dot omega_wheels``.
    It can represent forward, reverse, FWD/RWD/AWD, and differential weighting;
    this fixture does not own or redesign those upstream semantics.
    """

    wheel_inertias_kg_m2: tuple[float, ...]
    clutch_speed_mapping: tuple[float, ...]
    clutch_capacity_nm: float

    def validate(self) -> None:
        if not self.wheel_inertias_kg_m2 or len(self.wheel_inertias_kg_m2) != len(
            self.clutch_speed_mapping
        ):
            raise ValueError("wheel inertias and clutch mapping must be non-empty and matching")
        if any(i <= 0.0 or not math.isfinite(i) for i in self.wheel_inertias_kg_m2):
            raise ValueError("wheel inertias must be finite and positive")
        if any(not math.isfinite(a) for a in self.clutch_speed_mapping):
            raise ValueError("clutch mapping must be finite")
        if self.clutch_capacity_nm < 0.0 or not math.isfinite(self.clutch_capacity_nm):
            raise ValueError("clutch capacity must be finite and non-negative")


@dataclass(frozen=True)
class CoupledDrivetrainState:
    engine_omega_rad_s: float
    wheel_omega_rad_s: tuple[float, ...]


@dataclass(frozen=True)
class CoupledDrivetrainResult:
    state: CoupledDrivetrainState
    clutch_mode: ClutchSolveMode
    clutch_impulse_nms: float
    clutch_reaction_on_engine_nm: float
    clutch_relative_speed_rad_s: float
    engine_row_residual_nms: float
    wheel_row_residual_nms: tuple[float, ...]
    nonlinear_iterations: int
    engine_sample: EngineTorqueSample
    energy_before_j: float
    energy_after_j: float


def _solve_scalar_bracketed(
    function: Callable[[float], tuple[float, float, EngineTorqueSample]],
    lower: float,
    upper: float,
    scale: float,
    max_iterations: int = 80,
) -> tuple[float, float, EngineTorqueSample, int]:
    f_lo, _, _ = function(lower)
    f_hi, _, _ = function(upper)
    if f_lo > 0.0 or f_hi < 0.0:
        raise DomainError("coupled drivetrain root is outside the engine domain")
    x = 0.5 * (lower + upper)
    tolerance = 1e-11 * max(1.0, scale)
    for iteration in range(1, max_iterations + 1):
        value, derivative, sample = function(x)
        if abs(value) <= tolerance:
            return x, abs(value), sample, iteration
        if value > 0.0:
            upper = x
        else:
            lower = x
        candidate = x - value / derivative if derivative > 0.0 else math.nan
        if not math.isfinite(candidate) or candidate <= lower or candidate >= upper:
            candidate = 0.5 * (lower + upper)
        x = candidate
    raise RuntimeError("coupled drivetrain scalar solve did not converge")


def solve_coupled_drivetrain_substep(
    engine_owner: EngineOwner,
    ticket: EngineSolveTicket,
    state: CoupledDrivetrainState,
    config: CoupledDrivetrainConfig,
    wheel_external_torque_nm: tuple[float, ...],
    dt: float,
) -> CoupledDrivetrainResult:
    """Solve Engine + finite-capacity clutch + compiled wheel mapping together.

    The clutch is an impulse-bounded velocity constraint.  The Engine trial is
    queried repeatedly at predicted speed but its controller state is committed
    only once, after the active set is accepted.
    """
    config.validate()
    if ticket.snapshot is not engine_owner.state:
        # Identity is intentional here: a ticket belongs to the exact canonical
        # snapshot returned by this owner, not merely an equal value copy.
        raise RuntimeError("drivetrain ticket/snapshot ownership mismatch")
    if len(state.wheel_omega_rad_s) != len(config.wheel_inertias_kg_m2):
        raise ValueError("drivetrain state wheel count mismatch")
    if len(wheel_external_torque_nm) != len(config.wheel_inertias_kg_m2):
        raise ValueError("wheel torque count mismatch")
    if abs(state.engine_omega_rad_s - ticket.snapshot.omega_rad_s) > 1e-12:
        raise ValueError("drivetrain engine state differs from Engine owner snapshot")
    if dt <= 0.0 or abs(dt - ticket.trial.dt) > 1e-15:
        raise ValueError("drivetrain dt must match the frozen Engine trial")

    inertias = np.asarray(config.wheel_inertias_kg_m2, dtype=float)
    mapping = np.asarray(config.clutch_speed_mapping, dtype=float)
    wheel0 = np.asarray(state.wheel_omega_rad_s, dtype=float)
    wheel_torque = np.asarray(wheel_external_torque_nm, dtype=float)
    wheel_free = wheel0 + dt * wheel_torque / inertias
    engine0 = state.engine_omega_rad_s
    engine_inertia = engine_owner.model.asset.inertia_kg_m2
    energy_before = 0.5 * engine_inertia * engine0**2 + 0.5 * float(
        np.sum(inertias * wheel0**2)
    )

    engine_free, _, _, _, _ = engine_owner.model.solve_backward_euler_trial(
        ticket.trial, engine0, 0.0
    )
    if np.all(np.abs(mapping) <= 1e-15):
        sample = engine_owner.evaluate(ticket, engine_free)
        engine_owner.commit(ticket, engine_free)
        energy_after = 0.5 * engine_inertia * engine_free**2 + 0.5 * float(
            np.sum(inertias * wheel_free**2)
        )
        return CoupledDrivetrainResult(
            CoupledDrivetrainState(engine_free, tuple(map(float, wheel_free))),
            ClutchSolveMode.NEUTRAL,
            0.0,
            0.0,
            engine_free,
            0.0,
            tuple(0.0 for _ in wheel_free),
            0,
            sample,
            energy_before,
            energy_after,
        )

    free_slip = float(engine_free - np.dot(mapping, wheel_free))
    wheel_effective_inverse = float(np.sum(mapping**2 / inertias))
    if wheel_effective_inverse <= 0.0:
        raise ValueError("non-neutral clutch mapping has zero effective inverse inertia")
    mapped_free = float(np.dot(mapping, wheel_free))
    upper = rpm_to_rad_s(engine_owner.model.asset.hard_overspeed_rpm)

    def locked_residual(omega: float) -> tuple[float, float, EngineTorqueSample]:
        sample = engine_owner.evaluate(ticket, omega)
        impulse = (mapped_free - omega) / wheel_effective_inverse
        value = (
            engine_inertia * (omega - engine0)
            - dt * sample.free_torque_nm
            - impulse
        )
        derivative = (
            engine_inertia
            - dt * sample.dtorque_domega_nm_per_rad_s
            + 1.0 / wheel_effective_inverse
        )
        return float(value), float(derivative), sample

    locked_omega, locked_residual_value, locked_sample, locked_iterations = _solve_scalar_bracketed(
        locked_residual,
        0.0,
        upper,
        engine_inertia * max(1.0, engine0),
    )
    locked_impulse = (mapped_free - locked_omega) / wheel_effective_inverse
    impulse_limit = config.clutch_capacity_nm * dt

    if abs(locked_impulse) <= impulse_limit + 1e-12:
        clutch_mode = ClutchSolveMode.LOCKED
        impulse = float(np.clip(locked_impulse, -impulse_limit, impulse_limit))
        engine_omega = locked_omega
        engine_sample = locked_sample
        engine_residual = locked_residual_value
        iterations = locked_iterations
    else:
        clutch_mode = ClutchSolveMode.SLIPPING
        impulse = -math.copysign(impulse_limit, free_slip) if free_slip != 0.0 else 0.0
        engine_omega, engine_sample, engine_residual, iterations, stop_impulse = (
            engine_owner.model.solve_backward_euler_trial(
                ticket.trial,
                engine0,
                external_engine_impulse_nms=impulse,
            )
        )
        if stop_impulse > 0.0:
            raise DomainError("clutch fixture reached zero-speed unilateral stop")

    wheel_next = wheel_free - mapping * impulse / inertias
    relative_speed = float(engine_omega - np.dot(mapping, wheel_next))
    wheel_residual = inertias * (wheel_next - wheel0) - dt * wheel_torque + mapping * impulse
    engine_owner.commit(ticket, engine_omega)
    energy_after = 0.5 * engine_inertia * engine_omega**2 + 0.5 * float(
        np.sum(inertias * wheel_next**2)
    )
    return CoupledDrivetrainResult(
        state=CoupledDrivetrainState(engine_omega, tuple(map(float, wheel_next))),
        clutch_mode=clutch_mode,
        clutch_impulse_nms=impulse,
        clutch_reaction_on_engine_nm=-impulse / dt,
        clutch_relative_speed_rad_s=relative_speed,
        engine_row_residual_nms=float(engine_residual),
        wheel_row_residual_nms=tuple(map(float, wheel_residual)),
        nonlinear_iterations=iterations,
        engine_sample=engine_sample,
        energy_before_j=energy_before,
        energy_after_j=energy_after,
    )


@dataclass(frozen=True)
class LockedRigParams:
    mass_kg: float = 1500.0
    wheel_radius_m: float = 0.33
    total_ratio: float = 9.0
    driveline_efficiency: float = 0.9
    engine_torque_scale: float = 1.0
    f0_n: float = 150.0
    f1_n_per_m_s: float = 1.0
    f2_n_per_m2_s2: float = 0.42


def locked_wot_acceleration(
    model: EngineModel, speeds_m_s: np.ndarray, params: LockedRigParams
) -> np.ndarray:
    """Locked, no-slip identification fixture—not a general drivetrain route."""
    speeds = np.asarray(speeds_m_s, dtype=float)
    omega = speeds * params.total_ratio / params.wheel_radius_m
    engine_torque = np.array([model.asset.net_torque(1.0, w)[0] for w in omega])
    drive_force = (
        engine_torque
        * params.engine_torque_scale
        * params.driveline_efficiency
        * params.total_ratio
        / params.wheel_radius_m
    )
    road = params.f0_n + params.f1_n_per_m_s * speeds + params.f2_n_per_m2_s2 * speeds**2
    return (drive_force - road) / params.mass_kg


def coastdown_acceleration(
    speeds_m_s: np.ndarray,
    mass_kg: float,
    coefficients: tuple[float, float, float],
) -> np.ndarray:
    speed = np.asarray(speeds_m_s, dtype=float)
    f0, f1, f2 = coefficients
    return -(f0 + f1 * speed + f2 * speed**2) / mass_kg


def free_rev_analytic_constant_torque(
    omega0: float, torque_nm: float, inertia_kg_m2: float, duration_s: float
) -> float:
    return omega0 + torque_nm * duration_s / inertia_kg_m2


def engine_speed_for_locked_vehicle(speed_m_s: float, total_ratio: float, radius_m: float) -> float:
    return rpm_to_rad_s(1.0) * (speed_m_s * total_ratio / radius_m) / rpm_to_rad_s(1.0)
