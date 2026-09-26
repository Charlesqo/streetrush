"""Bounded-cost longitudinal runtime route with exhaustive-oracle regression.

The exhaustive active-set solver in :mod:`coupled_vehicle_solver` is retained as
an offline oracle.  This module provides a production-oriented route:

1. O(1) common-mode solve for locked clutch + all tires adhering, reducing the
   constrained mechanics to one generalized vehicle-speed coordinate.
2. Bounded O(N) local active-set neighborhood, warm-started from the previous
   accepted mode, for clutch/tire/bound transitions.
3. No silent fallback to exponential 3**N enumeration.

The common-mode path deliberately uses the same reduced Coulomb contact model as
the oracle.  High-fidelity Tire V2 is connected through ``integrated_closeout``;
this module exists to prove that the Engine/powertrain reference does not require
486 active-set candidates every 120-Hz substep.
"""
from __future__ import annotations

from dataclasses import replace
import math
from typing import Sequence

import numpy as np

from .coupled_vehicle_solver import (
    AxleLoadResult,
    ClutchMode,
    CoupledSolveError,
    CoupledVehicleConfig,
    CoupledVehicleState,
    CoupledVehicleStepResult,
    EngineBoundMode,
    SolverModeHint,
    TireMode,
    _CandidateSolution,
    _CandidateSpec,
    _Context,
    _Index,
    _energy_ledger,
    _residual,
    _scales,
    _validate_candidate,
    solve_coupled_vehicle_substep,
)
from .engine_model import EngineOwner, EngineSolveTicket, rpm_to_rad_s


class RuntimeFastPathRejected(RuntimeError):
    """The O(1) mode was not admissible; bounded local solve may still work."""


def _road_force_derivative(config: CoupledVehicleConfig, speed: float, wind: float) -> float:
    relative = speed - wind
    d_drag = config.rho_kg_m3 * config.cd_area_m2 * abs(relative)
    x = speed / config.rolling_smoothing_speed_m_s
    # stable sech^2 without cosh overflow
    if abs(x) > 40.0:
        sech2 = 0.0
    else:
        sech2 = 1.0 / math.cosh(x) ** 2
    d_roll = (
        config.rolling_resistance_coefficient
        * config.mass_kg
        * config.gravity_m_s2
        * sech2
        / config.rolling_smoothing_speed_m_s
    )
    return float(d_drag + d_roll)


def _build_context(
    engine_owner: EngineOwner,
    ticket: EngineSolveTicket,
    state: CoupledVehicleState,
    config: CoupledVehicleConfig,
    wheel_torque: np.ndarray,
    dt: float,
    engagement: float,
    mapping: np.ndarray,
    wind: float,
) -> _Context:
    index = _Index(config.wheel_count)
    return _Context(
        engine_owner=engine_owner,
        ticket=ticket,
        state=state,
        config=config,
        wheel_torque=wheel_torque,
        mapping=mapping,
        engagement=engagement,
        wind_speed=wind,
        dt=dt,
        index=index,
        engine_inertia=engine_owner.model.asset.inertia_kg_m2,
        wheel_inertias=np.asarray(config.wheel_inertias_kg_m2, dtype=float),
        radii=np.asarray(config.wheel_radii_m, dtype=float),
        mus=np.asarray(config.tire_mu, dtype=float),
        clutch_capacity_impulse=config.clutch_capacity_nm * engagement * dt,
        engine_upper=rpm_to_rad_s(engine_owner.model.asset.hard_overspeed_rpm),
    )


def _finalize_fast_solution(
    ctx: _Context,
    spec: _CandidateSpec,
    x: np.ndarray,
    iterations: int,
    *,
    commit_engine: bool,
) -> CoupledVehicleStepResult:
    raw, sample = _residual(x, spec, ctx)
    _, row_scale = _scales(ctx, spec)
    issues, scaled_inf, tire_capacity, loads = _validate_candidate(x, raw, row_scale, spec, ctx)
    if issues:
        raise RuntimeFastPathRejected("; ".join(issues))
    solution = _CandidateSolution(
        spec, x, raw, row_scale, sample, iterations, scaled_inf,
        (0, scaled_inf, "runtime-fast/locked/adhering"),
    )
    i = ctx.index
    solved_engine_omega = float(x[i.engine])
    if commit_engine:
        engine_state = ctx.engine_owner.commit(ctx.ticket, solved_engine_omega)
    else:
        ctx.engine_owner.validate_commit(ctx.ticket, solved_engine_omega)
        engine_state = replace(
            ctx.ticket.trial.next_controller_state, omega_rad_s=solved_engine_omega
        )
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
        distance_m=ctx.state.distance_m
        + 0.5 * (ctx.state.chassis_speed_m_s + speed) * ctx.dt,
    )
    return CoupledVehicleStepResult(
        state=next_state,
        engine_sample=sample,
        engine_bound_mode=EngineBoundMode.FREE,
        clutch_mode=ClutchMode.LOCKED,
        tire_modes=spec.tires,
        clutch_impulse_nms=clutch_impulse,
        clutch_reaction_on_engine_nm=clutch_impulse / ctx.dt,
        tire_impulses_n_s=tire_impulses,
        tire_forces_on_chassis_n=tuple(value / ctx.dt for value in tire_impulses),
        crank_stop_impulse_nms=stop_impulse,
        clutch_relative_speed_rad_s=clutch_slip,
        tire_slip_speeds_m_s=tire_slips,
        clutch_capacity_impulse_nms=ctx.clutch_capacity_impulse,
        tire_capacity_impulses_n_s=tuple(map(float, tire_capacity)),
        axle_loads=AxleLoadResult(float(front_load), float(rear_load), tuple(wheel_loads)),
        engine_row_residual_nms=float(raw[i.engine]),
        wheel_row_residual_nms=tuple(map(float, raw[i.wheels])),
        chassis_row_residual_n_s=float(raw[i.chassis]),
        scaled_residual_inf=float(scaled_inf),
        nonlinear_iterations=iterations,
        candidates_examined=1,
        candidates_accepted=1,
        diagnostics=(),
        energy=energy,
    )


def _solve_common_locked_adhesion(
    engine_owner: EngineOwner,
    ticket: EngineSolveTicket,
    state: CoupledVehicleState,
    config: CoupledVehicleConfig,
    wheel_external_torque_nm: Sequence[float],
    dt: float,
    *,
    clutch_engagement: float,
    clutch_speed_mapping: Sequence[float],
    wind_speed_m_s: float,
    commit_engine: bool,
) -> CoupledVehicleStepResult:
    config.validate()
    if clutch_engagement <= 1.0e-12:
        raise RuntimeFastPathRejected("clutch is open")
    wheel_torque = np.asarray(tuple(wheel_external_torque_nm), dtype=float)
    mapping = np.asarray(tuple(clutch_speed_mapping), dtype=float)
    if wheel_torque.shape != (config.wheel_count,) or mapping.shape != wheel_torque.shape:
        raise ValueError("wheel torque/mapping count mismatch")
    radii = np.asarray(config.wheel_radii_m, dtype=float)
    inertias = np.asarray(config.wheel_inertias_kg_m2, dtype=float)
    wheel0 = np.asarray(state.wheel_omega_rad_s, dtype=float)
    v0 = state.chassis_speed_m_s
    # This reduction is exact only when the previous canonical state already lies
    # on the locked/adhered manifold.  Otherwise the impulse projection matters.
    manifold_tol = 2.0e-6
    if np.max(np.abs(radii * wheel0 - v0)) > manifold_tol:
        raise RuntimeFastPathRejected("previous tire state is not adhered")
    b = float(np.dot(mapping, 1.0 / radii))
    if abs(b) <= 1.0e-12:
        raise RuntimeFastPathRejected("clutch mapping has no generalized speed")
    if abs(state.engine.omega_rad_s - b * v0) > manifold_tol:
        raise RuntimeFastPathRejected("previous clutch state is not locked")

    ctx = _build_context(
        engine_owner, ticket, state, config, wheel_torque, dt,
        float(np.clip(clutch_engagement, 0.0, 1.0)), mapping, float(wind_speed_m_s),
    )
    upper = ctx.engine_upper
    if b > 0.0:
        lo, hi = 0.0, upper / b
    else:
        lo, hi = upper / b, 0.0
    if not (lo - 1e-12 <= v0 <= hi + 1e-12):
        raise RuntimeFastPathRejected("previous state outside locked engine domain")
    m_eff = (
        config.mass_kg
        + float(np.sum(inertias / (radii * radii)))
        + ctx.engine_inertia * b * b
    )
    wheel_force = float(np.sum(wheel_torque / radii))

    def residual(v: float):
        we = b * v
        if we < -config.engine_domain_tolerance_rad_s or we > upper + config.engine_domain_tolerance_rad_s:
            raise RuntimeFastPathRejected("fast root left engine domain")
        we = float(np.clip(we, 0.0, upper))
        sample = engine_owner.evaluate(ticket, we)
        road = config.road_force_n(v, wind_speed_m_s)
        r = m_eff * (v - v0) - dt * (sample.free_torque_nm * b + wheel_force - road)
        dr = (
            m_eff
            - dt * sample.dtorque_domega_nm_per_rad_s * b * b
            + dt * _road_force_derivative(config, v, wind_speed_m_s)
        )
        return float(r), float(dr), sample

    f_lo, _, _ = residual(lo)
    f_hi, _, _ = residual(hi)
    if f_lo == 0.0:
        v = lo
    elif f_hi == 0.0:
        v = hi
    elif f_lo * f_hi > 0.0:
        raise RuntimeFastPathRejected("common-mode root is not bracketed")
    else:
        v = float(np.clip(v0, lo, hi))
    scale = max(1.0, m_eff * max(1.0, abs(v0)))
    tol = 2.0e-11 * scale
    sample = None
    for iteration in range(1, 25):
        f, df, sample = residual(v)
        if abs(f) <= tol:
            break
        if f * f_lo > 0.0:
            lo, f_lo = v, f
        else:
            hi, f_hi = v, f
        candidate = v - f / df if df > 0.0 else math.nan
        if not math.isfinite(candidate) or candidate <= lo or candidate >= hi:
            candidate = 0.5 * (lo + hi)
        v = float(candidate)
    else:
        raise RuntimeFastPathRejected("common-mode scalar solve did not converge")

    assert sample is not None
    i = ctx.index
    x = np.zeros(i.size, dtype=float)
    we1 = b * v
    wheels1 = v / radii
    j = ctx.engine_inertia * (we1 - state.engine.omega_rad_s) - dt * sample.free_torque_nm
    p = (-inertias * (wheels1 - wheel0) + dt * wheel_torque - mapping * j) / radii
    x[i.engine] = we1
    x[i.wheels] = wheels1
    x[i.chassis] = v
    x[i.clutch] = j
    x[i.tires] = p
    x[i.stop] = 0.0
    spec = _CandidateSpec(
        EngineBoundMode.FREE,
        ClutchMode.LOCKED,
        tuple(TireMode.ADHERING for _ in range(config.wheel_count)),
    )
    return _finalize_fast_solution(ctx, spec, x, iteration, commit_engine=commit_engine)


def solve_runtime_coupled_vehicle_substep(
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
    warm_start: SolverModeHint | None = None,
) -> CoupledVehicleStepResult:
    """Runtime-oriented solve with bounded candidate count.

    A rejected fast path is not an error: the function immediately tries the
    O(N) local active-set neighborhood.  If that neighborhood has no admissible
    solution, ``CoupledSolveError`` is raised so a scheduler can substep or use
    the offline oracle explicitly; there is no hidden exponential fallback.
    """
    mapping = (
        config.clutch_speed_mapping
        if clutch_speed_mapping is None
        else tuple(clutch_speed_mapping)
    )
    try:
        return _solve_common_locked_adhesion(
            engine_owner, ticket, state, config, wheel_external_torque_nm, dt,
            clutch_engagement=clutch_engagement,
            clutch_speed_mapping=mapping,
            wind_speed_m_s=wind_speed_m_s,
            commit_engine=commit_engine,
        )
    except RuntimeFastPathRejected:
        return solve_coupled_vehicle_substep(
            engine_owner, ticket, state, config, wheel_external_torque_nm, dt,
            clutch_engagement=clutch_engagement,
            clutch_speed_mapping=mapping,
            wind_speed_m_s=wind_speed_m_s,
            commit_engine=commit_engine,
            candidate_strategy="local",
            warm_start=warm_start,
        )
