"""Finite-capacity longitudinal vehicle solve with transactional Engine ownership.

This module is the executable reference for the mechanical chain that was
previously represented only by a locked/no-slip algebraic oracle::

    Engine -- dry clutch / gear mapping -- wheel inertias -- tire contacts -- chassis

The end-of-substep velocities and impulses are solved in one Backward-Euler
system.  A small active-set enumeration gives each ideal finite-capacity
constraint an explicit state:

* clutch: neutral, locked, or sliding in either direction;
* tire: adhering, or sliding in either direction; and
* ICE lower speed bound: free, or stopped with a unilateral impulse.

No controller state is advanced during candidate iterations.  The caller
supplies an open :class:`EngineSolveTicket`; exactly one accepted candidate is
committed, while an unsuccessful solve aborts the ticket and leaves canonical
state untouched.

Sign convention
---------------

``j_clutch`` is the angular impulse applied *to the engine*.  With
``omega_c = a dot omega_wheels`` the clutch generalized impulse is
``[j, -a*j]``.  ``p_tire[i]`` is the forward linear impulse applied to the
chassis, so the matching wheel impulse is ``-radius[i] * p_tire[i]``.
Consequently a dissipative solution satisfies::

    j_clutch * (omega_engine - a dot omega_wheels) <= 0
    -p_tire[i] * (radius[i] * omega_wheel[i] - speed) <= 0

The implementation intentionally uses only NumPy so it remains embeddable in
the standalone reference artifact without a SciPy runtime dependency.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from enum import Enum
import itertools
import math
from typing import Iterable, Sequence

import numpy as np

from .engine_model import (
    DomainError,
    EngineOwner,
    EngineSolveTicket,
    EngineState,
    EngineTorqueSample,
    rpm_to_rad_s,
)


class Axle(str, Enum):
    FRONT = "FRONT"
    REAR = "REAR"


class ClutchMode(str, Enum):
    NEUTRAL = "NEUTRAL"
    LOCKED = "LOCKED"
    SLIDING_POSITIVE = "SLIDING_POSITIVE"
    SLIDING_NEGATIVE = "SLIDING_NEGATIVE"


class TireMode(str, Enum):
    ADHERING = "ADHERING"
    SLIDING_POSITIVE = "SLIDING_POSITIVE"
    SLIDING_NEGATIVE = "SLIDING_NEGATIVE"


class EngineBoundMode(str, Enum):
    FREE = "FREE"
    STOPPED = "STOPPED"


@dataclass(frozen=True)
class CoupledVehicleConfig:
    """Physical and numerical parameters for a longitudinal coupled solve.

    ``clutch_speed_mapping`` defines the already-compiled drivetrain relation
    ``omega_clutch = sum(a[i] * omega_wheel[i])``.  It therefore carries gear,
    final-drive, differential, driven-axle, and reverse signs without making
    this solver the owner of gearbox policy.

    Only wheels listed here have longitudinal contact impulses.  For a RWD
    reference, listing two rear wheels correctly limits drive force by rear
    axle load while the unmodelled front rolling losses remain in road load.
    """

    mass_kg: float
    wheel_inertias_kg_m2: tuple[float, ...]
    wheel_radii_m: tuple[float, ...]
    clutch_speed_mapping: tuple[float, ...]
    clutch_capacity_nm: float
    tire_mu: tuple[float, ...]
    wheel_axles: tuple[Axle, ...]
    wheelbase_m: float
    cg_to_rear_axle_m: float
    cg_height_m: float
    gravity_m_s2: float = 9.81
    rho_kg_m3: float = 1.225
    cd_area_m2: float = 0.68
    cl_area_m2: float = 0.0
    aero_front_fraction: float = 0.5
    rolling_resistance_coefficient: float = 0.012
    rolling_smoothing_speed_m_s: float = 0.25
    wheel_load_shares_within_axle: tuple[float, ...] | None = None
    newton_max_iterations: int = 50
    scaled_residual_tolerance: float = 2.0e-10
    acceptance_scaled_residual: float = 2.0e-8
    speed_complementarity_tolerance: float = 2.0e-7
    engine_domain_tolerance_rad_s: float = 1.0e-10
    impulse_abs_tolerance: float = 2.0e-7
    impulse_rel_tolerance: float = 2.0e-8

    @property
    def wheel_count(self) -> int:
        return len(self.wheel_inertias_kg_m2)

    def validate(self) -> None:
        n = self.wheel_count
        arrays: tuple[Sequence[object], ...] = (
            self.wheel_radii_m,
            self.clutch_speed_mapping,
            self.tire_mu,
            self.wheel_axles,
        )
        if n == 0 or any(len(values) != n for values in arrays):
            raise ValueError("all wheel parameter arrays must be non-empty and equal length")
        finite_positive = (
            self.mass_kg,
            self.wheelbase_m,
            self.gravity_m_s2,
            self.rho_kg_m3,
            self.rolling_smoothing_speed_m_s,
        )
        if any(not math.isfinite(v) or v <= 0.0 for v in finite_positive):
            raise ValueError("mass, geometry, gravity, density, and smoothing speed must be positive")
        if not 0.0 < self.cg_to_rear_axle_m < self.wheelbase_m:
            raise ValueError("CG longitudinal position must lie between the axles")
        if not math.isfinite(self.cg_height_m) or self.cg_height_m < 0.0:
            raise ValueError("CG height must be finite and non-negative")
        if not 0.0 <= self.aero_front_fraction <= 1.0:
            raise ValueError("aero front fraction must lie in [0, 1]")
        nonnegative = (
            self.clutch_capacity_nm,
            self.cd_area_m2,
            self.cl_area_m2,
            self.rolling_resistance_coefficient,
            self.speed_complementarity_tolerance,
            self.engine_domain_tolerance_rad_s,
            self.impulse_abs_tolerance,
            self.impulse_rel_tolerance,
        )
        if any(not math.isfinite(v) or v < 0.0 for v in nonnegative):
            raise ValueError("capacities, road-load terms, and tolerances cannot be negative")
        if any(not math.isfinite(v) or v <= 0.0 for v in self.wheel_inertias_kg_m2):
            raise ValueError("wheel inertias must be finite and positive")
        if any(not math.isfinite(v) or v <= 0.0 for v in self.wheel_radii_m):
            raise ValueError("wheel radii must be finite and positive")
        if any(not math.isfinite(v) for v in self.clutch_speed_mapping):
            raise ValueError("clutch mapping must be finite")
        if any(not math.isfinite(v) or v < 0.0 for v in self.tire_mu):
            raise ValueError("tire friction coefficients must be finite and non-negative")
        for axle in self.wheel_axles:
            Axle(axle)
        if self.wheel_load_shares_within_axle is not None:
            shares = self.wheel_load_shares_within_axle
            if len(shares) != n or any(not math.isfinite(v) or v <= 0.0 for v in shares):
                raise ValueError("explicit wheel load shares must be finite, positive, and complete")
            for axle in Axle:
                total = sum(
                    share
                    for share, item_axle in zip(shares, self.wheel_axles)
                    if Axle(item_axle) is axle
                )
                if total and abs(total - 1.0) > 1.0e-10:
                    raise ValueError(f"{axle.value} wheel load shares must sum to one")
        if self.newton_max_iterations < 2:
            raise ValueError("Newton iteration limit must be at least two")
        if self.scaled_residual_tolerance <= 0.0 or self.acceptance_scaled_residual <= 0.0:
            raise ValueError("residual tolerances must be positive")

    def road_force_n(self, speed_m_s: float, wind_speed_m_s: float) -> float:
        """Signed force magnitude subtracted from the chassis equation."""
        relative = speed_m_s - wind_speed_m_s
        drag = 0.5 * self.rho_kg_m3 * self.cd_area_m2 * relative * abs(relative)
        rolling = (
            self.rolling_resistance_coefficient
            * self.mass_kg
            * self.gravity_m_s2
            * math.tanh(speed_m_s / self.rolling_smoothing_speed_m_s)
        )
        return float(drag + rolling)

    def aero_downforce_n(self, speed_m_s: float, wind_speed_m_s: float) -> float:
        relative = speed_m_s - wind_speed_m_s
        return float(0.5 * self.rho_kg_m3 * self.cl_area_m2 * relative * relative)

    def normal_loads_n(
        self, speed_m_s: float, initial_speed_m_s: float, dt: float, wind_speed_m_s: float
    ) -> tuple[float, float, tuple[float, ...]]:
        """Return front, rear, and represented-wheel normal loads.

        The load transfer is coupled to the solved end velocity through the
        substep acceleration.  Positive acceleration transfers load rearward.
        """
        acceleration = (speed_m_s - initial_speed_m_s) / dt
        weight = self.mass_kg * self.gravity_m_s2
        downforce = self.aero_downforce_n(speed_m_s, wind_speed_m_s)
        front = (
            weight * self.cg_to_rear_axle_m / self.wheelbase_m
            + downforce * self.aero_front_fraction
            - self.mass_kg * acceleration * self.cg_height_m / self.wheelbase_m
        )
        rear = weight + downforce - front

        if self.wheel_load_shares_within_axle is None:
            counts = {
                axle: sum(Axle(item) is axle for item in self.wheel_axles) for axle in Axle
            }
            shares = tuple(1.0 / counts[Axle(item)] for item in self.wheel_axles)
        else:
            shares = self.wheel_load_shares_within_axle
        per_wheel = tuple(
            float((front if Axle(axle) is Axle.FRONT else rear) * share)
            for axle, share in zip(self.wheel_axles, shares)
        )
        return float(front), float(rear), per_wheel


@dataclass(frozen=True)
class CoupledVehicleState:
    engine: EngineState
    wheel_omega_rad_s: tuple[float, ...]
    chassis_speed_m_s: float
    distance_m: float = 0.0


@dataclass(frozen=True)
class CandidateDiagnostic:
    engine_bound_mode: EngineBoundMode
    clutch_mode: ClutchMode
    tire_modes: tuple[TireMode, ...]
    converged: bool
    accepted: bool
    nonlinear_iterations: int
    scaled_residual_inf: float
    reason: str


@dataclass(frozen=True)
class EnergyLedger:
    energy_before_j: float
    energy_after_j: float
    energy_change_j: float
    engine_work_j: float
    wheel_external_work_j: float
    road_load_work_j: float
    clutch_constraint_work_j: float
    tire_constraint_work_j: tuple[float, ...]
    crank_stop_work_j: float
    backward_euler_dissipation_j: float
    physical_constraint_dissipation_j: float
    identity_residual_j: float


@dataclass(frozen=True)
class AxleLoadResult:
    front_normal_n: float
    rear_normal_n: float
    represented_wheel_normal_n: tuple[float, ...]




@dataclass(frozen=True)
class SolverModeHint:
    """Warm-start mode hint for the bounded runtime active-set route."""

    engine_bound_mode: EngineBoundMode
    clutch_mode: ClutchMode
    tire_modes: tuple[TireMode, ...]


def mode_hint_from_result(result: "CoupledVehicleStepResult") -> SolverModeHint:
    return SolverModeHint(result.engine_bound_mode, result.clutch_mode, result.tire_modes)


@dataclass(frozen=True)
class CoupledVehicleStepResult:
    state: CoupledVehicleState
    engine_sample: EngineTorqueSample
    engine_bound_mode: EngineBoundMode
    clutch_mode: ClutchMode
    tire_modes: tuple[TireMode, ...]
    clutch_impulse_nms: float
    clutch_reaction_on_engine_nm: float
    tire_impulses_n_s: tuple[float, ...]
    tire_forces_on_chassis_n: tuple[float, ...]
    crank_stop_impulse_nms: float
    clutch_relative_speed_rad_s: float
    tire_slip_speeds_m_s: tuple[float, ...]
    clutch_capacity_impulse_nms: float
    tire_capacity_impulses_n_s: tuple[float, ...]
    axle_loads: AxleLoadResult
    engine_row_residual_nms: float
    wheel_row_residual_nms: tuple[float, ...]
    chassis_row_residual_n_s: float
    scaled_residual_inf: float
    nonlinear_iterations: int
    candidates_examined: int
    candidates_accepted: int
    diagnostics: tuple[CandidateDiagnostic, ...]
    energy: EnergyLedger


class CoupledSolveError(RuntimeError):
    """No enumerated active set satisfied dynamics and complementarity."""

    def __init__(self, message: str, diagnostics: Iterable[CandidateDiagnostic] = ()):
        super().__init__(message)
        self.diagnostics = tuple(diagnostics)


@dataclass(frozen=True)
class _CandidateSpec:
    engine_bound: EngineBoundMode
    clutch: ClutchMode
    tires: tuple[TireMode, ...]


@dataclass(frozen=True)
class _Index:
    wheel_count: int

    @property
    def engine(self) -> int:
        return 0

    @property
    def wheels(self) -> slice:
        return slice(1, 1 + self.wheel_count)

    @property
    def chassis(self) -> int:
        return 1 + self.wheel_count

    @property
    def clutch(self) -> int:
        return 2 + self.wheel_count

    @property
    def tires(self) -> slice:
        return slice(3 + self.wheel_count, 3 + 2 * self.wheel_count)

    @property
    def stop(self) -> int:
        return 3 + 2 * self.wheel_count

    @property
    def size(self) -> int:
        return 4 + 2 * self.wheel_count


@dataclass
class _Context:
    engine_owner: EngineOwner
    ticket: EngineSolveTicket
    state: CoupledVehicleState
    config: CoupledVehicleConfig
    wheel_torque: np.ndarray
    mapping: np.ndarray
    engagement: float
    wind_speed: float
    dt: float
    index: _Index
    engine_inertia: float
    wheel_inertias: np.ndarray
    radii: np.ndarray
    mus: np.ndarray
    clutch_capacity_impulse: float
    engine_upper: float


@dataclass(frozen=True)
class _CandidateSolution:
    spec: _CandidateSpec
    x: np.ndarray
    residual: np.ndarray
    row_scale: np.ndarray
    sample: EngineTorqueSample
    iterations: int
    scaled_inf: float
    score: tuple[int, float, str]


def make_consistent_state(
    speed_m_s: float,
    config: CoupledVehicleConfig,
    engine_template: EngineState,
    mapping: Sequence[float] | None = None,
) -> CoupledVehicleState:
    """Create a clutch-locked, tire-adhered state without changing mode memory."""
    config.validate()
    radii = np.asarray(config.wheel_radii_m, dtype=float)
    wheels = np.full(config.wheel_count, float(speed_m_s), dtype=float) / radii
    use_mapping = np.asarray(
        config.clutch_speed_mapping if mapping is None else tuple(mapping), dtype=float
    )
    if use_mapping.shape != wheels.shape:
        raise ValueError("mapping count does not match wheel count")
    engine = replace(engine_template, omega_rad_s=float(np.dot(use_mapping, wheels)))
    return CoupledVehicleState(engine, tuple(map(float, wheels)), float(speed_m_s), 0.0)


def _slip_sign_clutch(mode: ClutchMode) -> int:
    if mode is ClutchMode.SLIDING_POSITIVE:
        return 1
    if mode is ClutchMode.SLIDING_NEGATIVE:
        return -1
    return 0


def _slip_sign_tire(mode: TireMode) -> int:
    if mode is TireMode.SLIDING_POSITIVE:
        return 1
    if mode is TireMode.SLIDING_NEGATIVE:
        return -1
    return 0


def _residual(
    x: np.ndarray, spec: _CandidateSpec, ctx: _Context
) -> tuple[np.ndarray, EngineTorqueSample]:
    i = ctx.index
    we = float(x[i.engine])
    wheels = x[i.wheels]
    speed = float(x[i.chassis])
    clutch_impulse = float(x[i.clutch])
    tire_impulses = x[i.tires]
    stop_impulse = float(x[i.stop])
    sample = ctx.engine_owner.evaluate(ctx.ticket, we)
    _, _, wheel_loads = ctx.config.normal_loads_n(
        speed, ctx.state.chassis_speed_m_s, ctx.dt, ctx.wind_speed
    )
    tire_capacity = ctx.mus * np.asarray(wheel_loads, dtype=float) * ctx.dt

    residual = np.empty(i.size, dtype=float)
    residual[i.engine] = (
        ctx.engine_inertia * (we - ctx.state.engine.omega_rad_s)
        - ctx.dt * sample.free_torque_nm
        - clutch_impulse
        - stop_impulse
    )
    wheel0 = np.asarray(ctx.state.wheel_omega_rad_s, dtype=float)
    residual[i.wheels] = (
        ctx.wheel_inertias * (wheels - wheel0)
        - ctx.dt * ctx.wheel_torque
        + ctx.mapping * clutch_impulse
        + ctx.radii * tire_impulses
    )
    residual[i.chassis] = (
        ctx.config.mass_kg * (speed - ctx.state.chassis_speed_m_s)
        - float(np.sum(tire_impulses))
        + ctx.dt * ctx.config.road_force_n(speed, ctx.wind_speed)
    )

    clutch_slip = we - float(np.dot(ctx.mapping, wheels))
    if spec.clutch is ClutchMode.NEUTRAL:
        residual[i.clutch] = clutch_impulse
    elif spec.clutch is ClutchMode.LOCKED:
        residual[i.clutch] = clutch_slip
    else:
        sign = _slip_sign_clutch(spec.clutch)
        residual[i.clutch] = clutch_impulse + sign * ctx.clutch_capacity_impulse

    tire_slips = ctx.radii * wheels - speed
    for offset, mode in enumerate(spec.tires):
        row = i.tires.start + offset
        if mode is TireMode.ADHERING:
            residual[row] = tire_slips[offset]
        else:
            sign = _slip_sign_tire(mode)
            residual[row] = tire_impulses[offset] - sign * tire_capacity[offset]

    residual[i.stop] = stop_impulse if spec.engine_bound is EngineBoundMode.FREE else we
    if not np.all(np.isfinite(residual)):
        raise DomainError("candidate residual became non-finite")
    return residual, sample


def _scales(ctx: _Context, spec: _CandidateSpec) -> tuple[np.ndarray, np.ndarray]:
    i = ctx.index
    a = ctx.engine_owner.model.asset
    we_scale = max(10.0, abs(ctx.state.engine.omega_rad_s), 0.25 * ctx.engine_upper)
    wheel0 = np.asarray(ctx.state.wheel_omega_rad_s, dtype=float)
    wheel_scale = np.maximum(10.0, np.abs(wheel0))
    speed_scale = max(5.0, abs(ctx.state.chassis_speed_m_s))
    nominal_wheel_load = ctx.config.mass_kg * ctx.config.gravity_m_s2 / ctx.index.wheel_count
    tire_impulse_scale = np.maximum(1.0, ctx.mus * nominal_wheel_load * ctx.dt)
    engine_torque_scale = max(
        1.0,
        max(map(abs, a.full_curve.torque_nm)),
        max(map(abs, a.closed_curve.torque_nm)) if a.closed_curve is not None else 0.0,
        max(map(abs, a.loss_curve.torque_nm)) if a.loss_curve is not None else 0.0,
        a.starter_torque_nm,
        a.idle_max_torque_nm,
    )
    engine_impulse_scale = max(
        1.0,
        ctx.engine_inertia * we_scale,
        engine_torque_scale * ctx.dt,
        ctx.clutch_capacity_impulse,
    )

    x_scale = np.empty(i.size, dtype=float)
    x_scale[i.engine] = we_scale
    x_scale[i.wheels] = wheel_scale
    x_scale[i.chassis] = speed_scale
    x_scale[i.clutch] = engine_impulse_scale
    x_scale[i.tires] = tire_impulse_scale
    x_scale[i.stop] = engine_impulse_scale

    row_scale = np.empty(i.size, dtype=float)
    row_scale[i.engine] = engine_impulse_scale
    row_scale[i.wheels] = np.maximum.reduce(
        [
            np.ones(i.wheel_count),
            ctx.wheel_inertias * wheel_scale,
            np.abs(ctx.dt * ctx.wheel_torque),
            np.abs(ctx.mapping) * max(1.0, ctx.clutch_capacity_impulse),
            ctx.radii * tire_impulse_scale,
        ]
    )
    road_impulse = abs(ctx.dt * ctx.config.road_force_n(ctx.state.chassis_speed_m_s, ctx.wind_speed))
    row_scale[i.chassis] = max(
        1.0,
        ctx.config.mass_kg * speed_scale,
        float(np.sum(tire_impulse_scale)),
        road_impulse,
    )
    if spec.clutch is ClutchMode.LOCKED:
        row_scale[i.clutch] = max(
            1.0, we_scale, float(np.sum(np.abs(ctx.mapping) * wheel_scale))
        )
    else:
        row_scale[i.clutch] = max(1.0, ctx.clutch_capacity_impulse)
    for offset, mode in enumerate(spec.tires):
        row = i.tires.start + offset
        row_scale[row] = (
            max(1.0, ctx.radii[offset] * wheel_scale[offset], speed_scale)
            if mode is TireMode.ADHERING
            else tire_impulse_scale[offset]
        )
    row_scale[i.stop] = we_scale if spec.engine_bound is EngineBoundMode.STOPPED else engine_impulse_scale
    return x_scale, row_scale


def _initial_guess(ctx: _Context, spec: _CandidateSpec) -> np.ndarray:
    i = ctx.index
    x = np.zeros(i.size, dtype=float)
    engine_free, _, _, _, stop = ctx.engine_owner.model.solve_backward_euler_trial(
        ctx.ticket.trial, ctx.state.engine.omega_rad_s, 0.0
    )
    x[i.engine] = engine_free
    wheel0 = np.asarray(ctx.state.wheel_omega_rad_s, dtype=float)
    x[i.wheels] = wheel0 + ctx.dt * ctx.wheel_torque / ctx.wheel_inertias
    road0 = ctx.config.road_force_n(ctx.state.chassis_speed_m_s, ctx.wind_speed)
    x[i.chassis] = ctx.state.chassis_speed_m_s - ctx.dt * road0 / ctx.config.mass_kg

    clutch_slip = x[i.engine] - float(np.dot(ctx.mapping, x[i.wheels]))
    clutch_inverse_mass = 1.0 / ctx.engine_inertia + float(
        np.sum(ctx.mapping * ctx.mapping / ctx.wheel_inertias)
    )
    if spec.clutch is ClutchMode.LOCKED and clutch_inverse_mass > 0.0:
        x[i.clutch] = -clutch_slip / clutch_inverse_mass
    elif spec.clutch is not ClutchMode.NEUTRAL:
        x[i.clutch] = -_slip_sign_clutch(spec.clutch) * ctx.clutch_capacity_impulse

    try:
        _, _, wheel_loads = ctx.config.normal_loads_n(
            float(x[i.chassis]), ctx.state.chassis_speed_m_s, ctx.dt, ctx.wind_speed
        )
        capacities = ctx.mus * np.asarray(wheel_loads) * ctx.dt
    except (ValueError, DomainError):
        capacities = np.zeros(i.wheel_count)
    tire_slips = ctx.radii * x[i.wheels] - x[i.chassis]
    for offset, mode in enumerate(spec.tires):
        if mode is TireMode.ADHERING:
            inverse_mass = ctx.radii[offset] ** 2 / ctx.wheel_inertias[offset] + 1.0 / ctx.config.mass_kg
            x[i.tires.start + offset] = tire_slips[offset] / inverse_mass
        else:
            x[i.tires.start + offset] = _slip_sign_tire(mode) * capacities[offset]

    if spec.engine_bound is EngineBoundMode.STOPPED:
        x[i.engine] = 0.0
        x[i.stop] = max(0.0, stop)
    return x


def _project_engine_domain(x: np.ndarray, ctx: _Context) -> np.ndarray:
    """Project only roundoff-scale excursions at the declared ICE bounds.

    Active-set equations own the exact bound (not a soft clamp).  This helper
    prevents -ulp/+ulp platform noise from invalidating an otherwise exact
    STOPPED or hard-overspeed candidate while still rejecting material domain
    violations.
    """
    value = float(x[ctx.index.engine])
    tol = ctx.config.engine_domain_tolerance_rad_s
    if -tol <= value < 0.0:
        x = x.copy(); x[ctx.index.engine] = 0.0
    elif ctx.engine_upper < value <= ctx.engine_upper + tol:
        x = x.copy(); x[ctx.index.engine] = ctx.engine_upper
    return x


def _finite_difference_jacobian(
    y: np.ndarray,
    scaled_residual: np.ndarray,
    x_scale: np.ndarray,
    row_scale: np.ndarray,
    spec: _CandidateSpec,
    ctx: _Context,
) -> np.ndarray:
    columns = len(y)
    jacobian = np.empty((columns, columns), dtype=float)
    for column in range(columns):
        h = 2.0e-7 * max(1.0, abs(float(y[column])))
        directions = (1.0, -1.0)
        derivative: np.ndarray | None = None
        for direction in directions:
            trial_y = y.copy()
            trial_y[column] += direction * h
            trial_x = _project_engine_domain(trial_y * x_scale, ctx)
            if trial_x[ctx.index.engine] < 0.0 or trial_x[ctx.index.engine] > ctx.engine_upper:
                continue
            trial_y = trial_x / x_scale
            try:
                raw, _ = _residual(trial_x, spec, ctx)
            except (DomainError, ValueError, FloatingPointError):
                continue
            trial_scaled = raw / row_scale
            derivative = (trial_scaled - scaled_residual) / (direction * h)
            break
        if derivative is None:
            raise DomainError(f"cannot differentiate candidate variable {column}")
        jacobian[:, column] = derivative
    return jacobian


def _solve_candidate(
    ctx: _Context, spec: _CandidateSpec
) -> tuple[np.ndarray, np.ndarray, np.ndarray, EngineTorqueSample, int, float]:
    x_scale, row_scale = _scales(ctx, spec)
    y = _initial_guess(ctx, spec) / x_scale
    last_norm = math.inf
    sample: EngineTorqueSample | None = None
    raw = np.full(ctx.index.size, math.inf)
    for iteration in range(1, ctx.config.newton_max_iterations + 1):
        x = _project_engine_domain(y * x_scale, ctx)
        y = x / x_scale
        if x[ctx.index.engine] < 0.0 or x[ctx.index.engine] > ctx.engine_upper:
            raise DomainError("candidate left the declared engine speed domain")
        raw, sample = _residual(x, spec, ctx)
        scaled = raw / row_scale
        norm = float(np.linalg.norm(scaled, ord=np.inf))
        if norm <= ctx.config.scaled_residual_tolerance:
            return x, raw, row_scale, sample, iteration, norm
        jacobian = _finite_difference_jacobian(
            y, scaled, x_scale, row_scale, spec, ctx
        )
        try:
            step = np.linalg.solve(jacobian, -scaled)
        except np.linalg.LinAlgError:
            step = np.linalg.lstsq(jacobian, -scaled, rcond=1.0e-12)[0]
        if not np.all(np.isfinite(step)):
            raise DomainError("candidate Newton step became non-finite")

        accepted_line_step = False
        best: tuple[float, np.ndarray] | None = None
        alpha = 1.0
        base_l2 = float(np.dot(scaled, scaled))
        for _ in range(18):
            trial_y = y + alpha * step
            trial_x = _project_engine_domain(trial_y * x_scale, ctx)
            trial_y = trial_x / x_scale
            if 0.0 <= trial_x[ctx.index.engine] <= ctx.engine_upper:
                try:
                    trial_raw, _ = _residual(trial_x, spec, ctx)
                    trial_scaled = trial_raw / row_scale
                    trial_l2 = float(np.dot(trial_scaled, trial_scaled))
                except (DomainError, ValueError, FloatingPointError):
                    trial_l2 = math.inf
                if math.isfinite(trial_l2):
                    if best is None or trial_l2 < best[0]:
                        best = (trial_l2, trial_y)
                    if trial_l2 <= base_l2 * (1.0 - 1.0e-4 * alpha):
                        y = trial_y
                        accepted_line_step = True
                        break
            alpha *= 0.5
        if not accepted_line_step:
            if best is not None and best[0] < base_l2:
                y = best[1]
            else:
                raise DomainError("candidate Newton line search stalled")
        if norm >= last_norm * (1.0 - 1.0e-12) and np.linalg.norm(alpha * step) < 1.0e-12:
            raise DomainError("candidate Newton iteration stagnated")
        last_norm = norm
    assert sample is not None
    x = y * x_scale
    raw, sample = _residual(x, spec, ctx)
    norm = float(np.linalg.norm(raw / row_scale, ord=np.inf))
    raise DomainError(
        f"candidate did not converge in {ctx.config.newton_max_iterations} iterations; "
        f"scaled residual={norm:.3e}"
    )


def _impulse_tolerance(capacity: float, config: CoupledVehicleConfig) -> float:
    return config.impulse_abs_tolerance + config.impulse_rel_tolerance * max(1.0, abs(capacity))


def _validate_candidate(
    x: np.ndarray,
    raw: np.ndarray,
    row_scale: np.ndarray,
    spec: _CandidateSpec,
    ctx: _Context,
) -> tuple[list[str], float, np.ndarray, tuple[float, float, tuple[float, ...]]]:
    i = ctx.index
    issues: list[str] = []
    scaled_inf = float(np.linalg.norm(raw / row_scale, ord=np.inf))
    if scaled_inf > ctx.config.acceptance_scaled_residual:
        issues.append(f"scaled residual {scaled_inf:.3e} exceeds acceptance")

    we = float(x[i.engine])
    wheels = x[i.wheels]
    speed = float(x[i.chassis])
    clutch_impulse = float(x[i.clutch])
    tire_impulses = x[i.tires]
    stop_impulse = float(x[i.stop])
    clutch_slip = we - float(np.dot(ctx.mapping, wheels))
    tire_slips = ctx.radii * wheels - speed
    loads = ctx.config.normal_loads_n(
        speed, ctx.state.chassis_speed_m_s, ctx.dt, ctx.wind_speed
    )
    front_load, rear_load, wheel_loads = loads
    if front_load <= 0.0 or rear_load <= 0.0 or any(load <= 0.0 for load in wheel_loads):
        issues.append("normal load became non-positive")
    tire_capacity = ctx.mus * np.asarray(wheel_loads) * ctx.dt
    speed_tol = ctx.config.speed_complementarity_tolerance

    if spec.clutch is ClutchMode.NEUTRAL:
        if abs(clutch_impulse) > _impulse_tolerance(0.0, ctx.config):
            issues.append("neutral clutch transmitted impulse")
    elif spec.clutch is ClutchMode.LOCKED:
        if abs(clutch_slip) > speed_tol:
            issues.append("locked clutch has relative speed")
        tolerance = _impulse_tolerance(ctx.clutch_capacity_impulse, ctx.config)
        if abs(clutch_impulse) > ctx.clutch_capacity_impulse + tolerance:
            issues.append("locked clutch requires excess capacity")
    else:
        sign = _slip_sign_clutch(spec.clutch)
        if sign * clutch_slip < -speed_tol:
            issues.append("clutch slip sign opposes selected active set")
        if clutch_impulse * clutch_slip > 1.0e-8:
            issues.append("clutch active set creates energy")

    for offset, mode in enumerate(spec.tires):
        capacity = float(tire_capacity[offset])
        tolerance = _impulse_tolerance(capacity, ctx.config)
        if mode is TireMode.ADHERING:
            if abs(tire_slips[offset]) > speed_tol:
                issues.append(f"tire {offset} adhesion has slip")
            if abs(tire_impulses[offset]) > capacity + tolerance:
                issues.append(f"tire {offset} adhesion requires excess capacity")
        else:
            sign = _slip_sign_tire(mode)
            if sign * tire_slips[offset] < -speed_tol:
                issues.append(f"tire {offset} slip sign opposes selected active set")
            if -tire_impulses[offset] * tire_slips[offset] > 1.0e-8:
                issues.append(f"tire {offset} active set creates energy")

    stop_tolerance = _impulse_tolerance(max(1.0, abs(stop_impulse)), ctx.config)
    if spec.engine_bound is EngineBoundMode.FREE:
        if we < -speed_tol or abs(stop_impulse) > stop_tolerance:
            issues.append("free engine bound has a stop reaction")
    else:
        if abs(we) > speed_tol:
            issues.append("stopped engine has nonzero speed")
        if stop_impulse < -stop_tolerance:
            issues.append("crank stop impulse has invalid sign")
    if we > ctx.engine_upper + speed_tol:
        issues.append("engine exceeds hard overspeed domain")
    return issues, scaled_inf, tire_capacity, loads


def _candidate_specs(ctx: _Context) -> Iterable[_CandidateSpec]:
    if np.all(np.abs(ctx.mapping) <= 1.0e-15) or ctx.clutch_capacity_impulse <= 1.0e-15:
        clutch_modes = (ClutchMode.NEUTRAL,)
    else:
        clutch_modes = (
            ClutchMode.LOCKED,
            ClutchMode.SLIDING_POSITIVE,
            ClutchMode.SLIDING_NEGATIVE,
        )
    tire_options = (
        TireMode.ADHERING,
        TireMode.SLIDING_POSITIVE,
        TireMode.SLIDING_NEGATIVE,
    )
    for bound, clutch, tires in itertools.product(
        (EngineBoundMode.FREE, EngineBoundMode.STOPPED),
        clutch_modes,
        itertools.product(tire_options, repeat=ctx.index.wheel_count),
    ):
        yield _CandidateSpec(bound, clutch, tuple(tires))


def _candidate_specs_local(
    ctx: _Context, hint: SolverModeHint | None
) -> Iterable[_CandidateSpec]:
    """Bounded O(N) active-set neighborhood for runtime warm starts.

    The exhaustive solver remains the offline oracle.  Runtime starts from the
    previous accepted mode (when supplied), then checks only one-mode neighbors
    plus a deterministic kinematic guess.  It never silently falls back to the
    exponential 3**N enumeration.
    """
    specs: list[_CandidateSpec] = []
    seen: set[tuple[object, ...]] = set()

    def add(spec: _CandidateSpec) -> None:
        key = (spec.engine_bound, spec.clutch, *spec.tires)
        if len(spec.tires) != ctx.index.wheel_count or key in seen:
            return
        seen.add(key); specs.append(spec)

    mapping_disabled = (
        np.all(np.abs(ctx.mapping) <= 1.0e-15)
        or ctx.clutch_capacity_impulse <= 1.0e-15
    )
    if hint is not None and len(hint.tire_modes) == ctx.index.wheel_count:
        clutch = ClutchMode.NEUTRAL if mapping_disabled else hint.clutch_mode
        add(_CandidateSpec(hint.engine_bound_mode, clutch, tuple(hint.tire_modes)))

    wheel0 = np.asarray(ctx.state.wheel_omega_rad_s, dtype=float)
    clutch_slip0 = ctx.state.engine.omega_rad_s - float(np.dot(ctx.mapping, wheel0))
    if mapping_disabled:
        clutch_guess = ClutchMode.NEUTRAL
    elif abs(clutch_slip0) <= 5.0 * ctx.config.speed_complementarity_tolerance:
        clutch_guess = ClutchMode.LOCKED
    elif clutch_slip0 > 0.0:
        clutch_guess = ClutchMode.SLIDING_POSITIVE
    else:
        clutch_guess = ClutchMode.SLIDING_NEGATIVE
    tire_slip0 = ctx.radii * wheel0 - ctx.state.chassis_speed_m_s
    tire_guess = tuple(
        TireMode.ADHERING
        if abs(float(slip)) <= 5.0 * ctx.config.speed_complementarity_tolerance
        else (TireMode.SLIDING_POSITIVE if slip > 0.0 else TireMode.SLIDING_NEGATIVE)
        for slip in tire_slip0
    )
    bound_guess = (
        EngineBoundMode.STOPPED
        if ctx.state.engine.omega_rad_s <= ctx.config.engine_domain_tolerance_rad_s
        else EngineBoundMode.FREE
    )
    preferred = _CandidateSpec(bound_guess, clutch_guess, tire_guess)
    add(preferred)

    # Single-mode neighbors give deterministic mode transitions without 3**N growth.
    add(_CandidateSpec(
        EngineBoundMode.STOPPED if preferred.engine_bound is EngineBoundMode.FREE else EngineBoundMode.FREE,
        preferred.clutch, preferred.tires,
    ))
    clutch_options = (ClutchMode.NEUTRAL,) if mapping_disabled else (
        ClutchMode.LOCKED, ClutchMode.SLIDING_POSITIVE, ClutchMode.SLIDING_NEGATIVE
    )
    for clutch in clutch_options:
        add(_CandidateSpec(preferred.engine_bound, clutch, preferred.tires))
    for idx in range(ctx.index.wheel_count):
        for mode in (TireMode.ADHERING, TireMode.SLIDING_POSITIVE, TireMode.SLIDING_NEGATIVE):
            tires = list(preferred.tires); tires[idx] = mode
            add(_CandidateSpec(preferred.engine_bound, preferred.clutch, tuple(tires)))
    # Coherent axle saturation is common under drive/braking and may switch two
    # contacts in the same substep.  Cover each represented axle as one group
    # without returning to a 3**N Cartesian product.
    axle_values = tuple(Axle(item) for item in ctx.config.wheel_axles)
    for axle in Axle:
        members = [i for i, item in enumerate(axle_values) if item is axle]
        if not members:
            continue
        for mode in (TireMode.SLIDING_POSITIVE, TireMode.SLIDING_NEGATIVE):
            tires = list(preferred.tires)
            for idx in members:
                tires[idx] = mode
            add(_CandidateSpec(preferred.engine_bound, preferred.clutch, tuple(tires)))
    # Clutch and tire transitions often coincide (e.g. a clutch re-lock while
    # the driven axle saturates).  Cross the *bounded tire neighborhood* above
    # with the three clutch modes.  This remains O(N), unlike the full 3**N
    # tire Cartesian product, but avoids assuming only one subsystem may switch
    # mode in a substep.
    tire_patterns = []
    tire_seen = set()
    for item in tuple(specs):
        if item.engine_bound is preferred.engine_bound and item.tires not in tire_seen:
            tire_seen.add(item.tires); tire_patterns.append(item.tires)
    for tires in tire_patterns:
        for clutch in clutch_options:
            add(_CandidateSpec(preferred.engine_bound, clutch, tires))

    # Engine-bound activation can coincide with clutch switching; keep this
    # cross-product narrow because crank-stop activation is comparatively rare.
    other_bound = EngineBoundMode.STOPPED if preferred.engine_bound is EngineBoundMode.FREE else EngineBoundMode.FREE
    for clutch in clutch_options:
        add(_CandidateSpec(other_bound, clutch, preferred.tires))
    return tuple(specs)


def _mode_penalty(spec: _CandidateSpec) -> int:
    penalty = 0
    if spec.engine_bound is EngineBoundMode.STOPPED:
        penalty += 4
    if spec.clutch not in (ClutchMode.LOCKED, ClutchMode.NEUTRAL):
        penalty += 2
    penalty += sum(mode is not TireMode.ADHERING for mode in spec.tires)
    return penalty


def _energy_ledger(
    ctx: _Context, solution: _CandidateSolution
) -> EnergyLedger:
    i = ctx.index
    x = solution.x
    we0 = ctx.state.engine.omega_rad_s
    wheel0 = np.asarray(ctx.state.wheel_omega_rad_s, dtype=float)
    v0 = ctx.state.chassis_speed_m_s
    we1 = float(x[i.engine])
    wheel1 = x[i.wheels]
    v1 = float(x[i.chassis])
    j = float(x[i.clutch])
    p = x[i.tires]
    q = float(x[i.stop])
    before = (
        0.5 * ctx.engine_inertia * we0 * we0
        + 0.5 * float(np.sum(ctx.wheel_inertias * wheel0 * wheel0))
        + 0.5 * ctx.config.mass_kg * v0 * v0
    )
    after = (
        0.5 * ctx.engine_inertia * we1 * we1
        + 0.5 * float(np.sum(ctx.wheel_inertias * wheel1 * wheel1))
        + 0.5 * ctx.config.mass_kg * v1 * v1
    )
    engine_work = ctx.dt * solution.sample.free_torque_nm * we1
    wheel_work = float(np.sum(ctx.dt * ctx.wheel_torque * wheel1))
    road_work = -ctx.dt * ctx.config.road_force_n(v1, ctx.wind_speed) * v1
    clutch_slip = we1 - float(np.dot(ctx.mapping, wheel1))
    clutch_work = j * clutch_slip
    tire_slips = ctx.radii * wheel1 - v1
    tire_work = tuple(map(float, -p * tire_slips))
    stop_work = q * we1
    backward_euler = 0.5 * (
        ctx.engine_inertia * (we1 - we0) ** 2
        + float(np.sum(ctx.wheel_inertias * (wheel1 - wheel0) ** 2))
        + ctx.config.mass_kg * (v1 - v0) ** 2
    )
    total_terminal_work = (
        engine_work
        + wheel_work
        + road_work
        + clutch_work
        + sum(tire_work)
        + stop_work
    )
    identity = (after - before) - (total_terminal_work - backward_euler)
    physical_dissipation = -clutch_work - sum(tire_work) - stop_work
    return EnergyLedger(
        energy_before_j=float(before),
        energy_after_j=float(after),
        energy_change_j=float(after - before),
        engine_work_j=float(engine_work),
        wheel_external_work_j=float(wheel_work),
        road_load_work_j=float(road_work),
        clutch_constraint_work_j=float(clutch_work),
        tire_constraint_work_j=tire_work,
        crank_stop_work_j=float(stop_work),
        backward_euler_dissipation_j=float(backward_euler),
        physical_constraint_dissipation_j=float(physical_dissipation),
        identity_residual_j=float(identity),
    )


def solve_coupled_vehicle_substep(
    engine_owner: EngineOwner,
    ticket: EngineSolveTicket,
    state: CoupledVehicleState,
    config: CoupledVehicleConfig,
    wheel_external_torque_nm: Sequence[float],
    dt: float,
    *,
    clutch_engagement: float = 1.0,
    clutch_speed_mapping: Sequence[float] | None = None,
    wind_speed_m_s: float = 0.0,
    commit_engine: bool = True,
    candidate_strategy: str = "exhaustive",
    warm_start: SolverModeHint | None = None,
) -> CoupledVehicleStepResult:
    """Solve and atomically commit one finite-capacity vehicle substep.

    The Engine ticket must already be open and its ``dt`` must match this
    mechanical solve.  On every exception after ownership is established the
    ticket is aborted, making failure an explicit transaction outcome.
    """
    if ticket.snapshot is not engine_owner.state:
        raise RuntimeError("coupled solver ticket does not own the canonical Engine snapshot")
    if state.engine is not ticket.snapshot:
        raise RuntimeError("vehicle Engine state is not the exact ticket snapshot")
    owns_ticket = True
    committed = False
    diagnostics: list[CandidateDiagnostic] = []
    try:
        config.validate()
        if not math.isfinite(dt) or dt <= 0.0 or abs(dt - ticket.trial.dt) > 1.0e-15:
            raise ValueError("coupled solver dt must be positive and match the Engine trial")
        if len(state.wheel_omega_rad_s) != config.wheel_count:
            raise ValueError("vehicle state wheel count does not match configuration")
        wheel_torque = np.asarray(tuple(wheel_external_torque_nm), dtype=float)
        if wheel_torque.shape != (config.wheel_count,) or not np.all(np.isfinite(wheel_torque)):
            raise ValueError("wheel external torque must be finite and match wheel count")
        if not math.isfinite(state.chassis_speed_m_s) or not math.isfinite(state.distance_m):
            raise ValueError("vehicle translation state must be finite")
        if not all(math.isfinite(value) for value in state.wheel_omega_rad_s):
            raise ValueError("wheel speeds must be finite")
        if not math.isfinite(clutch_engagement):
            raise ValueError("clutch engagement must be finite")
        engagement = float(np.clip(clutch_engagement, 0.0, 1.0))
        mapping = np.asarray(
            config.clutch_speed_mapping
            if clutch_speed_mapping is None
            else tuple(clutch_speed_mapping),
            dtype=float,
        )
        if mapping.shape != (config.wheel_count,) or not np.all(np.isfinite(mapping)):
            raise ValueError("clutch mapping override must be finite and match wheel count")
        if not math.isfinite(wind_speed_m_s):
            raise ValueError("wind speed must be finite")

        index = _Index(config.wheel_count)
        ctx = _Context(
            engine_owner=engine_owner,
            ticket=ticket,
            state=state,
            config=config,
            wheel_torque=wheel_torque,
            mapping=mapping,
            engagement=engagement,
            wind_speed=float(wind_speed_m_s),
            dt=float(dt),
            index=index,
            engine_inertia=engine_owner.model.asset.inertia_kg_m2,
            wheel_inertias=np.asarray(config.wheel_inertias_kg_m2, dtype=float),
            radii=np.asarray(config.wheel_radii_m, dtype=float),
            mus=np.asarray(config.tire_mu, dtype=float),
            clutch_capacity_impulse=config.clutch_capacity_nm * engagement * dt,
            engine_upper=rpm_to_rad_s(engine_owner.model.asset.hard_overspeed_rpm),
        )

        if candidate_strategy not in {"exhaustive", "local"}:
            raise ValueError("candidate_strategy must be 'exhaustive' or 'local'")
        candidate_iter = (
            _candidate_specs(ctx)
            if candidate_strategy == "exhaustive"
            else _candidate_specs_local(ctx, warm_start)
        )
        accepted: list[_CandidateSolution] = []
        for spec in candidate_iter:
            try:
                x, raw, row_scale, sample, iterations, solved_inf = _solve_candidate(ctx, spec)
                issues, scaled_inf, _, _ = _validate_candidate(
                    x, raw, row_scale, spec, ctx
                )
                is_accepted = not issues
                reason = "accepted" if is_accepted else "; ".join(issues)
                diagnostics.append(
                    CandidateDiagnostic(
                        spec.engine_bound,
                        spec.clutch,
                        spec.tires,
                        True,
                        is_accepted,
                        iterations,
                        scaled_inf,
                        reason,
                    )
                )
                if is_accepted:
                    mode_key = "/".join(
                        [spec.engine_bound.value, spec.clutch.value]
                        + [mode.value for mode in spec.tires]
                    )
                    accepted.append(
                        _CandidateSolution(
                            spec,
                            x,
                            raw,
                            row_scale,
                            sample,
                            iterations,
                            solved_inf,
                            (_mode_penalty(spec), scaled_inf, mode_key),
                        )
                    )
            except (DomainError, ValueError, FloatingPointError, np.linalg.LinAlgError) as exc:
                diagnostics.append(
                    CandidateDiagnostic(
                        spec.engine_bound,
                        spec.clutch,
                        spec.tires,
                        False,
                        False,
                        0,
                        math.inf,
                        str(exc),
                    )
                )

        if not accepted:
            reason_counts: dict[str, int] = {}
            for diagnostic in diagnostics:
                reason_counts[diagnostic.reason] = reason_counts.get(diagnostic.reason, 0) + 1
            summary = ", ".join(
                f"{count}x {reason}" for reason, count in sorted(reason_counts.items(), key=lambda item: (-item[1], item[0]))[:5]
            )
            raise CoupledSolveError(
                f"no active set satisfied the coupled vehicle contract ({summary})",
                diagnostics,
            )

        solution = min(accepted, key=lambda item: item.score)
        i = ctx.index
        x = solution.x
        issues, scaled_inf, tire_capacity, loads = _validate_candidate(
            x, solution.residual, solution.row_scale, solution.spec, ctx
        )
        if issues:
            raise CoupledSolveError("accepted candidate changed validation status", diagnostics)

        solved_engine_omega = float(x[i.engine])
        if commit_engine:
            engine_state = engine_owner.commit(ticket, solved_engine_omega)
            committed = True
        else:
            engine_owner.validate_commit(ticket, solved_engine_omega)
            engine_state = replace(
                ticket.trial.next_controller_state,
                omega_rad_s=solved_engine_omega,
            )
        # In deferred-commit mode ownership transfers back to the caller.
        owns_ticket = False
        wheels = tuple(map(float, x[i.wheels]))
        speed = float(x[i.chassis])
        clutch_impulse = float(x[i.clutch])
        tire_impulses = tuple(map(float, x[i.tires]))
        stop_impulse = float(x[i.stop])
        clutch_slip = float(x[i.engine] - np.dot(ctx.mapping, x[i.wheels]))
        tire_slips = tuple(map(float, ctx.radii * x[i.wheels] - speed))
        front_load, rear_load, wheel_loads = loads
        energy = _energy_ledger(ctx, solution)
        next_state = CoupledVehicleState(
            engine=engine_state,
            wheel_omega_rad_s=wheels,
            chassis_speed_m_s=speed,
            distance_m=state.distance_m
            + 0.5 * (state.chassis_speed_m_s + speed) * dt,
        )
        return CoupledVehicleStepResult(
            state=next_state,
            engine_sample=solution.sample,
            engine_bound_mode=solution.spec.engine_bound,
            clutch_mode=solution.spec.clutch,
            tire_modes=solution.spec.tires,
            clutch_impulse_nms=clutch_impulse,
            clutch_reaction_on_engine_nm=clutch_impulse / dt,
            tire_impulses_n_s=tire_impulses,
            tire_forces_on_chassis_n=tuple(value / dt for value in tire_impulses),
            crank_stop_impulse_nms=stop_impulse,
            clutch_relative_speed_rad_s=clutch_slip,
            tire_slip_speeds_m_s=tire_slips,
            clutch_capacity_impulse_nms=ctx.clutch_capacity_impulse,
            tire_capacity_impulses_n_s=tuple(map(float, tire_capacity)),
            axle_loads=AxleLoadResult(float(front_load), float(rear_load), tuple(wheel_loads)),
            engine_row_residual_nms=float(solution.residual[i.engine]),
            wheel_row_residual_nms=tuple(map(float, solution.residual[i.wheels])),
            chassis_row_residual_n_s=float(solution.residual[i.chassis]),
            scaled_residual_inf=float(scaled_inf),
            nonlinear_iterations=solution.iterations,
            candidates_examined=len(diagnostics),
            candidates_accepted=len(accepted),
            diagnostics=tuple(diagnostics),
            energy=energy,
        )
    except Exception:
        if owns_ticket and not committed:
            try:
                engine_owner.abort(ticket)
            except RuntimeError:
                pass
        raise
