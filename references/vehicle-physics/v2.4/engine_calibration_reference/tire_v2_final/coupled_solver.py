"""Small wheel/tire coupling experiments for the Tire V2 design."""

from __future__ import annotations

from dataclasses import dataclass
from math import isfinite

from .tire_model import TireModel, TireState


@dataclass(frozen=True)
class WheelStepResult:
    omega_radps: float
    tire_state: TireState
    force_x_n: float
    iterations: int
    converged: bool


def _newton_scalar(function, initial: float, tolerance: float = 1.0e-10, max_iterations: int = 30):
    x = initial
    for iteration in range(1, max_iterations + 1):
        value = function(x)
        if abs(value) <= tolerance:
            return x, iteration, True
        step = 1.0e-5 * max(1.0, abs(x))
        derivative = (function(x + step) - function(x - step)) / (2.0 * step)
        if not isfinite(derivative) or abs(derivative) < 1.0e-12:
            break
        delta = -value / derivative
        # A loose trust region keeps Newton on the same force branch.
        max_delta = 0.5 * max(10.0, abs(x))
        delta = max(-max_delta, min(max_delta, delta))
        x += delta
        if not isfinite(x):
            break
    return x, max_iterations, False


def _bracketed_scalar(function, a: float, b: float, tolerance: float = 1.0e-10, max_iterations: int = 80):
    """Bisection with automatic expansion for a robust one-DOF reference solve."""

    if a > b:
        a, b = b, a
    fa = function(a)
    fb = function(b)
    if abs(fa) <= tolerance:
        return a, 1, True
    if abs(fb) <= tolerance:
        return b, 1, True
    width = max(b - a, 1.0)
    for _ in range(12):
        if fa * fb < 0.0:
            break
        a -= width
        b += width
        width *= 2.0
        fa = function(a)
        fb = function(b)
    if fa * fb >= 0.0:
        return _newton_scalar(function, 0.5 * (a + b), tolerance, max_iterations)
    for iteration in range(1, max_iterations + 1):
        middle = 0.5 * (a + b)
        fm = function(middle)
        if abs(fm) <= tolerance or abs(b - a) <= tolerance:
            return middle, iteration, True
        if fa * fm <= 0.0:
            b, fb = middle, fm
        else:
            a, fa = middle, fm
    return 0.5 * (a + b), max_iterations, False


def implicit_coupled_longitudinal_step(
    model: TireModel,
    state: TireState,
    omega_n_radps: float,
    wheel_inertia_kgm2: float,
    drive_torque_nm: float,
    vehicle_speed_mps: float,
    normal_load_n: float,
    effective_radius_m: float,
    dt_s: float,
) -> WheelStepResult:
    """Backward-Euler wheel + first-order tire state, solved in one residual.

    The two lateral states are carried unchanged because this controlled
    experiment isolates the stiff wheel-speed/longitudinal-force loop.
    """

    p = model.params
    transport = max(abs(vehicle_speed_mps), abs(effective_radius_m * omega_n_radps), 1.0e-9)
    denominator = 1.0 + dt_s * transport / p.relaxation_length_x_m

    def state_from_omega(omega: float) -> float:
        slip_velocity = effective_radius_m * omega - vehicle_speed_mps
        return (
            state.relaxed_slip_x + dt_s * slip_velocity / p.relaxation_length_x_m
        ) / denominator

    def force_from_omega(omega: float) -> float:
        sx = state_from_omega(omega)
        fx, *_ = model.evaluate_from_model_slips(
            sx,
            state.relaxed_slip_y + state.relaxed_camber_slip,
            normal_load_n,
            travel_sign=1.0,
            omega_radps=omega,
        )
        return fx

    def residual(omega: float) -> float:
        fx = force_from_omega(omega)
        return wheel_inertia_kgm2 * (omega - omega_n_radps) / dt_s - drive_torque_nm + effective_radius_m * fx

    predictor = omega_n_radps + dt_s * drive_torque_nm / wheel_inertia_kgm2
    omega, iterations, converged = _newton_scalar(residual, predictor)
    sx = state_from_omega(omega)
    sx, sy, s_gamma = model._project_transient_state(
        sx, state.relaxed_slip_y, state.relaxed_camber_slip
    )
    fx, *_ = model.evaluate_from_model_slips(
        sx, sy + s_gamma, normal_load_n, travel_sign=1.0, omega_radps=omega
    )
    next_state = TireState(sx, sy, 0.0, s_gamma)
    return WheelStepResult(omega, next_state, fx, iterations, converged)


def explicit_coupled_longitudinal_step(
    model: TireModel,
    state: TireState,
    omega_n_radps: float,
    wheel_inertia_kgm2: float,
    drive_torque_nm: float,
    vehicle_speed_mps: float,
    normal_load_n: float,
    effective_radius_m: float,
    dt_s: float,
) -> WheelStepResult:
    """Forward-Euler negative control for the same dynamic equations."""

    fx, *_ = model.evaluate_from_model_slips(
        state.relaxed_slip_x,
        state.relaxed_slip_y + state.relaxed_camber_slip,
        normal_load_n,
        travel_sign=1.0,
        omega_radps=omega_n_radps,
    )
    omega = omega_n_radps + dt_s * (drive_torque_nm - effective_radius_m * fx) / wheel_inertia_kgm2
    transport = max(abs(vehicle_speed_mps), abs(effective_radius_m * omega_n_radps))
    ux = effective_radius_m * omega_n_radps - vehicle_speed_mps
    sx = state.relaxed_slip_x + dt_s * (
        ux - transport * state.relaxed_slip_x
    ) / model.params.relaxation_length_x_m
    sx, sy, s_gamma = model._project_transient_state(
        sx, state.relaxed_slip_y, state.relaxed_camber_slip
    )
    return WheelStepResult(omega, TireState(sx, sy, 0.0, s_gamma), fx, 0, True)


def algebraic_explicit_wheel_step(
    model: TireModel,
    omega_n_radps: float,
    wheel_inertia_kgm2: float,
    drive_torque_nm: float,
    vehicle_speed_mps: float,
    normal_load_n: float,
    effective_radius_m: float,
    dt_s: float,
) -> WheelStepResult:
    """Instantaneous steady tire + explicit wheel: deliberately stiff V1-like control."""

    transport = max(abs(vehicle_speed_mps), abs(effective_radius_m * omega_n_radps), 0.05)
    slip = (effective_radius_m * omega_n_radps - vehicle_speed_mps) / transport
    fx, *_ = model.evaluate_from_model_slips(slip, 0.0, normal_load_n, travel_sign=1.0, omega_radps=omega_n_radps)
    omega = omega_n_radps + dt_s * (drive_torque_nm - effective_radius_m * fx) / wheel_inertia_kgm2
    return WheelStepResult(omega, TireState(slip, 0.0, 0.0), fx, 0, True)


def algebraic_implicit_wheel_step(
    model: TireModel,
    omega_n_radps: float,
    wheel_inertia_kgm2: float,
    drive_torque_nm: float,
    vehicle_speed_mps: float,
    normal_load_n: float,
    effective_radius_m: float,
    dt_s: float,
) -> WheelStepResult:
    """Same instantaneous tire solved implicitly; useful as a solver contract test."""

    def force(omega: float) -> tuple[float, float]:
        transport = max(abs(vehicle_speed_mps), abs(effective_radius_m * omega), 0.05)
        slip = (effective_radius_m * omega - vehicle_speed_mps) / transport
        fx, *_ = model.evaluate_from_model_slips(slip, 0.0, normal_load_n, travel_sign=1.0, omega_radps=omega)
        return fx, slip

    def residual(omega: float) -> float:
        fx, _ = force(omega)
        return wheel_inertia_kgm2 * (omega - omega_n_radps) / dt_s - drive_torque_nm + effective_radius_m * fx

    predictor = omega_n_radps + dt_s * drive_torque_nm / wheel_inertia_kgm2
    omega, iterations, converged = _bracketed_scalar(residual, omega_n_radps, predictor)
    fx, slip = force(omega)
    return WheelStepResult(omega, TireState(slip, 0.0, 0.0), fx, iterations, converged)
