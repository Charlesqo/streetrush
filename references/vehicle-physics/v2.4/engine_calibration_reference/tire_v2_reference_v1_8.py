from __future__ import annotations
from dataclasses import dataclass
from enum import Enum, auto
import math
from typing import Optional
import numpy as np

from . import tire_v2_reference_v1_7 as v17

# Re-export the accepted v1.7 steady/contact machinery. v1.8 audit changes only
# transient policy semantics and validation gates; the v1.7 combined surface,
# Mz curve, Steering feedback contract and normal<->tangential blocks remain unchanged.
from .tire_v2_reference_v1_7 import *  # noqa: F401,F403


class TransientEnergyPolicy(Enum):
    EMPIRICAL_RELAXATION_BOUNDED = auto()
    ENERGY_CONSISTENT_DEFORMATION = auto()  # contract/future backend; not faked by this reduced reference


class CamberTransientPolicy(Enum):
    INSTANT = auto()
    FIRST_ORDER_SEPARATE = auto()


class LowSpeedTangentialPolicy(Enum):
    FRICTION_CONTACT = auto()
    SOFT_STATIC_DEFORMATION = auto()


@dataclass(frozen=True)
class TireTransientStateV18:
    sx: float = 0.0
    sy: float = 0.0
    sgamma: float = 0.0
    mode: v17.TireMode = v17.TireMode.AIRBORNE

    @property
    def sy_force(self) -> float:
        return self.sy + self.sgamma


@dataclass(frozen=True)
class CamberTransientConfig:
    policy: CamberTransientPolicy = CamberTransientPolicy.INSTANT
    relaxation_length_m: Optional[float] = None


@dataclass(frozen=True)
class TireTransientPolicyV18:
    energy_policy: TransientEnergyPolicy = TransientEnergyPolicy.EMPIRICAL_RELAXATION_BOUNDED
    camber: CamberTransientConfig = CamberTransientConfig()
    low_speed_policy: LowSpeedTangentialPolicy = LowSpeedTangentialPolicy.FRICTION_CONTACT

    def validate(self) -> None:
        # The empirical anisotropic characteristic is not a certified stored-energy gradient.
        # Therefore it cannot be used as a 2-D standstill elastic spring by default.
        if (
            self.low_speed_policy is LowSpeedTangentialPolicy.SOFT_STATIC_DEFORMATION
            and self.energy_policy is not TransientEnergyPolicy.ENERGY_CONSISTENT_DEFORMATION
        ):
            raise ValueError(
                "SOFT_STATIC_DEFORMATION requires ENERGY_CONSISTENT_DEFORMATION; "
                "the empirical relaxation wrapper is not globally integrable/passive"
            )
        if self.camber.policy is CamberTransientPolicy.FIRST_ORDER_SEPARATE:
            if self.camber.relaxation_length_m is None or self.camber.relaxation_length_m <= 0:
                raise ValueError("FIRST_ORDER_SEPARATE camber requires positive relaxation_length_m")


def exact_relax_distance(state: float, target: float, travel_speed: float, sigma: float, dt: float) -> float:
    if dt <= 0:
        return state
    if travel_speed <= 0:
        # This helper is for HANDLING distance-domain lag only.  v1.8 does not
        # reinterpret the empirical state as a standstill elastic spring.
        return state
    a = math.exp(-travel_speed * dt / sigma)
    return a * state + (1.0 - a) * target


def handling_trial_state_v18(
    params: v17.TireV2Params,
    fz: float,
    prev: TireTransientStateV18,
    sx_target: float,
    sy_target: float,
    camber_rad: float,
    travel_speed: float,
    dt: float,
    camber_config: CamberTransientConfig = CamberTransientConfig(),
) -> TireTransientStateV18:
    c, _ = params.load_map.evaluate(fz)
    sx = exact_relax_distance(prev.sx, sx_target, travel_speed, c.sigma_x, dt)
    sy = exact_relax_distance(prev.sy, sy_target, travel_speed, c.sigma_y, dt)
    gamma_target = v17.camber_equivalent_slip(c, camber_rad)
    if camber_config.policy is CamberTransientPolicy.INSTANT:
        sg = gamma_target
    elif camber_config.policy is CamberTransientPolicy.FIRST_ORDER_SEPARATE:
        sg = exact_relax_distance(
            prev.sgamma,
            gamma_target,
            travel_speed,
            float(camber_config.relaxation_length_m),
            dt,
        )
    else:
        raise ValueError(camber_config.policy)
    return TireTransientStateV18(sx, sy, sg, v17.TireMode.HANDLING)


def evaluate_state_v18(
    params: v17.TireV2Params,
    fz: float,
    state: TireTransientStateV18,
    geometric_camber_rad: float,
    mu_scale: float = 1.0,
    omega: float = 0.0,
    vertical_compression: Optional[float] = None,
):
    # Camber force authority is exactly state.sgamma (or instant target inserted there).
    # geometric camber remains available for Mx/domain telemetry through v1.7 evaluator.
    legacy_trial = v17.TireTransientState(state.sx, state.sy_force, v17.TireMode.HANDLING)
    return v17.evaluate_relaxed_state(
        params,
        fz,
        state.sx,
        state.sy_force,
        geometric_camber_rad,
        mu_scale,
        vertical_compression=vertical_compression,
        omega=omega,
        state_trial=legacy_trial,
    )


def weighted_cross_partial_mismatch(
    params: v17.TireV2Params,
    fz: float,
    sx: float,
    sy: float,
    h: float = 1e-6,
) -> float:
    c, _ = params.load_map.evaluate(fz)
    J = v17.force_tangent_numeric_relaxed(params, fz, sx, sy, 0.0, 1.0, h=h)
    # For Lx*sx_dot = ux - V*sx, Ly*sy_dot = uy - V*sy, a scalar E(s)
    # with grad E=[Lx Fx, Ly Fy] requires d(Lx Fx)/dsy=d(Ly Fy)/dsx.
    return float(c.sigma_y * J[1, 0] - c.sigma_x * J[0, 1])


def empirical_state_loop_circulation(
    params: v17.TireV2Params,
    fz: float,
    x0: float,
    x1: float,
    y0: float,
    y1: float,
    samples_per_edge: int = 400,
) -> float:
    c, _ = params.load_map.evaluate(fz)

    def force(sx: float, sy: float) -> np.ndarray:
        o = v17.evaluate_relaxed_state(params, fz, sx, sy, 0.0, 1.0)
        return np.array([o.Fx, o.Fy], float)

    total = 0.0
    edges = [
        (np.array([x0, y0]), np.array([x1, y0])),
        (np.array([x1, y0]), np.array([x1, y1])),
        (np.array([x1, y1]), np.array([x0, y1])),
        (np.array([x0, y1]), np.array([x0, y0])),
    ]
    for a, b in edges:
        for i in range(samples_per_edge):
            t0 = i / samples_per_edge
            t1 = (i + 1) / samples_per_edge
            p0 = a + (b - a) * t0
            p1 = a + (b - a) * t1
            pm = 0.5 * (p0 + p1)
            ds = p1 - p0
            F = force(float(pm[0]), float(pm[1]))
            total += c.sigma_x * F[0] * ds[0] + c.sigma_y * F[1] * ds[1]
    return float(total)


def soft_static_closed_loop_contact_work(
    params: v17.TireV2Params,
    fz: float,
    x0: float,
    x1: float,
    y0: float,
    y1: float,
    samples_per_edge: int = 400,
) -> float:
    # At V=0 the proposed soft-static empirical law gives ux=Lx*sx_dot,
    # uy=Ly*sy_dot and P_contact=-(Fx*ux+Fy*uy).  Hence closed-loop work
    # equals minus the weighted force circulation.
    return -empirical_state_loop_circulation(params, fz, x0, x1, y0, y1, samples_per_edge)


def transient_resolution_numbers(params: v17.TireV2Params, fz: float, travel_speed: float, dt: float, sigma_gamma: Optional[float] = None):
    c, _ = params.load_map.evaluate(fz)
    out = {
        "chi_x": travel_speed * dt / c.sigma_x,
        "chi_y": travel_speed * dt / c.sigma_y,
    }
    if sigma_gamma is not None and sigma_gamma > 0:
        out["chi_gamma"] = travel_speed * dt / sigma_gamma
    return out


def simulate_longitudinal_timestep_convergence(
    params: v17.TireV2Params,
    hz: int,
    sample_time_s: float = 0.05,
    final_time_s: float = 0.20,
    speed_mps: float = 20.0,
    drive_torque_nm: float = 800.0,
    wheel_inertia_kgm2: float = 1.35,
    fz: float = 4000.0,
):
    dt = 1.0 / hz
    R = v17.effective_radius(params, fz=fz, omega=speed_mps / params.R0)
    omega = speed_mps / R
    state = v17.TireTransientState(0.0, 0.0, v17.TireMode.HANDLING)
    W = np.array([[R * R / wheel_inertia_kgm2, 0.0], [0.0, 0.0]])
    sample = None
    max_residual = 0.0
    iterations = []
    n = round(final_time_s * hz)
    for k in range(n):
        omega_free = omega + dt * drive_torque_nm / wheel_inertia_kgm2
        u_free = np.array([R * omega_free - speed_mps, 0.0])
        vnorm = abs(R * omega_free)
        res = v17.solve_handling_impulse_2d(
            params,
            u_free,
            W,
            vnorm,
            fz,
            0.0,
            1.0,
            state,
            vnorm,
            dt,
            omega=omega_free,
        )
        if not res.converged:
            raise RuntimeError((hz, k, res.residual_norm))
        omega = omega_free - R * res.impulse[0] / wheel_inertia_kgm2
        state = res.state_trial
        max_residual = max(max_residual, res.residual_norm)
        iterations.append(res.iterations)
        t = (k + 1) * dt
        if sample is None and abs(t - sample_time_s) <= 0.5 * dt + 1e-15:
            sample = {
                "time_s": t,
                "Fx_N": res.output.Fx,
                "omega_radps": float(omega),
                "relaxed_slip_x": state.sx,
                "residual_norm": res.residual_norm,
            }
    return {
        "hz": hz,
        "sample": sample,
        "final": {
            "Fx_N": res.output.Fx,
            "omega_radps": float(omega),
            "relaxed_slip_x": state.sx,
        },
        "max_solver_residual": max_residual,
        "mean_iterations": float(np.mean(iterations)),
        "resolution": transient_resolution_numbers(params, fz, speed_mps, dt),
    }
