from __future__ import annotations
from dataclasses import dataclass
from enum import Enum, auto
import math
from typing import Dict, Tuple, Optional, List

import numpy as np
from scipy.interpolate import PchipInterpolator
from scipy.optimize import least_squares

EPS = 1e-12


class TireMode(Enum):
    AIRBORNE = auto()
    FRICTION_CONTACT = auto()  # low-|Vx| / ill-conditioned handling coordinates; active-set stick or slide
    HANDLING = auto()


class FrictionContactMode(Enum):
    STICK = auto()
    SLIDE = auto()


@dataclass(frozen=True)
class TireTransientState:
    # sx: relaxed longitudinal slip coordinate.
    # sy_eff: relaxed *effective* lateral coordinate, including the camber-thrust target.
    sx: float = 0.0
    sy_eff: float = 0.0
    mode: TireMode = TireMode.AIRBORNE


@dataclass(frozen=True)
class TireVerticalResult:
    fz: float
    dF_dcompression: float
    dF_dcompression_rate: float
    active: bool


@dataclass(frozen=True)
class TireOutput:
    Fx: float
    Fy: float
    Mx: float
    Mz: float
    rolling_resistance_torque: float
    R_eff: float
    trail: float
    state_trial: TireTransientState
    load_clamped: bool
    force_scale: float


@dataclass(frozen=True)
class CharacteristicAtLoad:
    kx0: float
    ky0: float
    fx_peak: float
    fy_peak: float
    sx_peak: float
    sy_peak: float
    fx_slide: float
    fy_slide: float
    sx_slide: float
    sy_slide: float
    kgamma: float
    mx_gamma: float
    trail0: float
    trail_zero_sy: float
    trail_end_sy: float
    sigma_x: float
    sigma_y: float


class PchipLoadMap:
    """Immutable shape-preserving load interpolation with explicit high-load clamp.

    Fields that physically vanish with load are extended to Fz=0 with a zero node.
    Shape/location fields use the lowest calibrated positive-load value below the first node.
    """

    ZERO_AT_ZERO_FIELDS = {
        "kx0", "ky0", "fx_peak", "fy_peak", "fx_slide", "fy_slide",
        "kgamma", "mx_gamma"
    }

    def __init__(self, fz_nodes: np.ndarray, fields: Dict[str, np.ndarray]):
        fz_nodes = np.asarray(fz_nodes, dtype=float)
        if np.any(fz_nodes <= 0) or np.any(np.diff(fz_nodes) <= 0):
            raise ValueError("fz_nodes must be strictly increasing and > 0")
        self.fz_nodes = fz_nodes.copy()
        self.fz_min = float(fz_nodes[0])
        self.fz_max = float(fz_nodes[-1])
        self._interp: Dict[str, PchipInterpolator] = {}
        for name, values in fields.items():
            values = np.asarray(values, dtype=float)
            if values.shape != fz_nodes.shape:
                raise ValueError(name)
            if name in self.ZERO_AT_ZERO_FIELDS:
                x = np.concatenate([[0.0], fz_nodes])
                y = np.concatenate([[0.0], values])
            else:
                x, y = fz_nodes, values
            self._interp[name] = PchipInterpolator(x, y, extrapolate=False)

    def evaluate(self, fz: float) -> Tuple[CharacteristicAtLoad, bool]:
        if fz <= 0:
            zeros = {k: 0.0 for k in self.ZERO_AT_ZERO_FIELDS}
            first = {
                k: float(v(self.fz_min))
                for k, v in self._interp.items()
                if k not in self.ZERO_AT_ZERO_FIELDS
            }
            return CharacteristicAtLoad(**zeros, **first), False

        clamped = fz > self.fz_max
        fe = min(max(fz, 0.0), self.fz_max)
        vals = {}
        for name, ip in self._interp.items():
            x = max(fe, self.fz_min) if name not in self.ZERO_AT_ZERO_FIELDS else fe
            vals[name] = float(ip(x))
        return CharacteristicAtLoad(**vals), clamped


@dataclass(frozen=True)
class TireV2Params:
    R0: float = 0.31
    crr: float = 0.012
    rr_transition_speed: float = 0.25  # m/s at tread; numerical regularization, not a tire material constant
    vertical_k1: float = 220000.0
    vertical_k2: float = 0.0
    vertical_c: float = 1800.0
    effective_radius_deflection_fraction: float = 1.0 / 3.0
    # Empirical load->deflection proxy used only by the effective-radius law when the active normal backend
    # does not expose physical tire compression (e.g. rigid-normal contact).  This is deliberately separate
    # from TireVerticalLaw stiffness so choosing rigid vs compliant normal contact cannot silently change Re.
    effective_radius_load_compliance: float = 1.0 / 220000.0  # m/N
    # Optional reduced centrifugal growth. q_growth=0 means disabled.
    radius_growth_q: float = 0.0
    radius_growth_vref: float = 30.0
    load_map: Optional[PchipLoadMap] = None


@dataclass(frozen=True)
class TireRegimePolicy:
    # Characteristic backend is only active when both vehicle longitudinal motion and tread transport are well away
    # from their singular/standstill limits.  This also routes a nearly locked wheel at high vehicle speed into the
    # friction-contact fallback instead of dividing by a vanishing rolling transport speed.
    handling_enter_abs_vlong: float = 2.0
    handling_exit_abs_vlong: float = 1.2
    handling_enter_transport: float = 2.0
    handling_exit_transport: float = 1.2

    def __post_init__(self):
        if self.handling_enter_abs_vlong <= self.handling_exit_abs_vlong:
            raise ValueError("longitudinal enter speed must exceed exit speed")
        if self.handling_enter_transport <= self.handling_exit_transport:
            raise ValueError("transport enter speed must exceed exit speed")


@dataclass(frozen=True)
class TireHandlingKinematics:
    u_long: float
    u_lat: float
    v_norm: float
    travel_speed: float
    sx_inst: float
    sy_inst: float


def handling_kinematics(v_long: float, v_lat: float, wheel_omega: float, R_eff: float) -> TireHandlingKinematics:
    """TMeasy-like characteristic coordinates for this *specific* backend.

    The generic Tire API carries physical contact velocities and wheel omega; slip convention belongs to the
    constitutive backend/parameter asset.  This characteristic backend uses tread transport |Re*omega| for its
    dimensionless slip coordinates and first-order relaxation convection, following the semi-physical TMeasy/Rill
    convention.  A future MF6.x backend may use its own calibrated kappa/alpha definitions without changing the host.
    """
    transport = abs(float(wheel_omega) * float(R_eff))
    if transport <= 0:
        raise ValueError("characteristic HANDLING coordinates need nonzero tread transport; use FRICTION_CONTACT")
    ux = float(wheel_omega) * float(R_eff) - float(v_long)
    uy = -float(v_lat)
    return TireHandlingKinematics(ux, uy, transport, transport, ux / transport, uy / transport)


def synthetic_passenger_tire() -> TireV2Params:
    fz = np.array([2000.0, 4000.0, 6000.0, 8000.0])
    deg = math.pi / 180.0
    fields = {
        "kx0": np.array([65000.0, 105000.0, 135000.0, 155000.0]),
        "ky0": np.array([55000.0, 90000.0, 112000.0, 125000.0]),
        "fx_peak": np.array([2400.0, 4600.0, 6500.0, 8200.0]),
        "fy_peak": np.array([2500.0, 4700.0, 6500.0, 8100.0]),
        "sx_peak": np.array([0.095, 0.105, 0.115, 0.125]),
        "sy_peak": np.tan(np.array([5.5, 6.2, 6.8, 7.4]) * deg),
        "fx_slide": np.array([2050.0, 3900.0, 5450.0, 6800.0]),
        "fy_slide": np.array([2200.0, 4100.0, 5550.0, 6900.0]),
        "sx_slide": np.array([0.42, 0.45, 0.48, 0.52]),
        "sy_slide": np.tan(np.array([17.0, 18.0, 19.0, 20.0]) * deg),
        "kgamma": np.array([9000.0, 17000.0, 23500.0, 28500.0]),
        # Synthetic overturning stiffness [N m / rad], only for interface tests.
        "mx_gamma": np.array([45.0, 85.0, 120.0, 150.0]),
        "trail0": np.array([0.047, 0.043, 0.039, 0.036]),
        "trail_zero_sy": np.tan(np.array([7.5, 8.0, 8.5, 9.0]) * deg),
        "trail_end_sy": np.tan(np.array([15.0, 16.0, 17.0, 18.0]) * deg),
        "sigma_x": np.array([0.24, 0.29, 0.34, 0.39]),
        "sigma_y": np.array([0.32, 0.40, 0.49, 0.58]),
    }
    p = TireV2Params(load_map=PchipLoadMap(fz, fields))
    errs = validate_characteristic_asset(p)
    if errs:
        raise ValueError("synthetic asset invalid: " + "; ".join(errs))
    return p


def tire_vertical_law(params: TireV2Params, compression: float, compression_rate: float) -> TireVerticalResult:
    d = max(0.0, compression)
    if d <= 0 and compression_rate <= 0:
        return TireVerticalResult(0.0, 0.0, 0.0, False)
    fs = params.vertical_k1 * d + params.vertical_k2 * d * d
    fd = params.vertical_c * compression_rate
    f = max(0.0, fs + fd)
    if f <= 0:
        return TireVerticalResult(0.0, 0.0, 0.0, False)
    return TireVerticalResult(f, params.vertical_k1 + 2 * params.vertical_k2 * d, params.vertical_c, True)


def effective_radius(
    params: TireV2Params,
    vertical_compression: Optional[float] = None,
    fz: Optional[float] = None,
    omega: float = 0.0,
) -> float:
    if vertical_compression is None:
        if fz is None or fz <= 0:
            d = 0.0
        else:
            # Empirical/reduced loaded-radius estimate only. This does NOT create vertical compliance in the
            # contact-gap solve; rigid-normal and compliant-normal backends may share the same radius law.
            d = max(0.0, params.effective_radius_load_compliance * fz)
    else:
        d = max(0.0, vertical_compression)

    x = omega * params.R0 / max(params.radius_growth_vref, EPS)
    R_free_dyn = params.R0 * (1.0 + params.radius_growth_q * x * x)
    return max(0.2 * params.R0, R_free_dyn - params.effective_radius_deflection_fraction * d)


def rolling_resistance_torque(params: TireV2Params, fz: float, R_eff: float, omega: float) -> float:
    if fz <= 0 or R_eff <= 0:
        return 0.0
    mag = params.crr * fz * R_eff
    omega_scale = params.rr_transition_speed / max(R_eff, EPS)
    return -mag * math.tanh(omega / max(omega_scale, 1e-9))


def _scalar_characteristic(s: float, df0: float, sm: float, fm: float, ss: float, fs: float) -> float:
    """Continuous TMeasy-inspired scalar magnitude, s>=0.

    Runtime asset QA is expected to ensure df0 >= 2 fm/sm; the max below is retained as a final safeguard.
    """
    if s <= 0 or df0 <= 0 or sm <= 0 or fm <= 0:
        return 0.0
    df0loc = max(2.0 * fm / sm, df0)
    if s >= ss:
        return fs
    if s < sm:
        p = df0loc * sm / fm - 2.0
        sn = s / sm
        dn = 1.0 + (sn + p) * sn
        return df0loc * sm * sn / max(dn, EPS)
    a = (fm / sm) ** 2 / (df0loc * sm)
    sstar = sm + (fm - fs) / (a * (ss - sm))
    if sstar <= ss:
        if s <= sstar:
            return fm - a * (s - sm) ** 2
        b = a * (sstar - sm) / (ss - sstar)
        return fs + b * (ss - s) ** 2
    sn = (s - sm) / (ss - sm)
    return fm - (fm - fs) * sn * sn * (3.0 - 2.0 * sn)


def _radial_to_ellipse(xcap: float, ycap: float, direction: np.ndarray) -> float:
    dx, dy = float(direction[0]), float(direction[1])
    den = (dx / max(xcap, EPS)) ** 2 + (dy / max(ycap, EPS)) ** 2
    if den <= 0:
        return 0.0
    return 1.0 / math.sqrt(den)


def _smoothstep01(x: float) -> float:
    x = min(max(float(x), 0.0), 1.0)
    return x * x * (3.0 - 2.0 * x)


def _v17_anisotropic_combined_force(c: CharacteristicAtLoad, sx: float, sy_eff: float, mu_scale: float) -> Tuple[float, float]:
    """v1.7-pre-closeout force direction, retained as a regression counterexample.

    It fixed the anisotropic origin Jacobian but kept the K-weighted force direction all the way to full sliding,
    which is not the maximum-dissipation direction of the sliding friction ellipse.
    """
    r = math.hypot(sx, sy_eff)
    if r <= 1e-15 or mu_scale <= 0:
        return 0.0, 0.0
    sdir = np.array([sx / r, sy_eff / r])
    lin = np.array([c.kx0 * sx, c.ky0 * sy_eff])
    mlin = float(np.linalg.norm(lin))
    if mlin <= 1e-15:
        return 0.0, 0.0
    fdir = lin / mlin
    kdir = mlin / r
    sm = mu_scale * _radial_to_ellipse(c.sx_peak, c.sy_peak, sdir)
    ss = mu_scale * _radial_to_ellipse(c.sx_slide, c.sy_slide, sdir)
    fm = mu_scale * _radial_to_ellipse(c.fx_peak, c.fy_peak, fdir)
    fs = mu_scale * _radial_to_ellipse(c.fx_slide, c.fy_slide, fdir)
    sm = max(sm, 1e-8)
    ss = max(ss, sm + 1e-8)
    mag = _scalar_characteristic(r, kdir, sm, fm, ss, fs)
    F = mag * fdir
    return float(F[0]), float(F[1])


def _anisotropic_combined_force(c: CharacteristicAtLoad, sx: float, sy_eff: float, mu_scale: float) -> Tuple[float, float]:
    """Smooth characteristic combined-slip law for the reduced Tire V2 backend.

    Requirements enforced by construction:
      * F = diag(Kx,Ky) s + O(|s|^2) near the origin,
      * exact pure-axis scalar characteristics,
      * shared 2-D peak/slide capacity,
      * force remains in the same slip quadrant (dissipative under the host sign convention),
      * at full sliding the force direction approaches the maximum-dissipation direction of the kinetic ellipse.

    The transition of force direction is deliberately smooth and complete by the directional peak-slip radius.
    This is a reduced simcade closure, not a claim to reproduce MF6.x combined-slip equations.
    """
    r = math.hypot(sx, sy_eff)
    if r <= 1e-15 or mu_scale <= 0:
        return 0.0, 0.0

    sdir = np.array([sx / r, sy_eff / r], dtype=float)
    lin = np.array([c.kx0 * sx, c.ky0 * sy_eff], dtype=float)
    mlin = float(np.linalg.norm(lin))
    if mlin <= 1e-15:
        return 0.0, 0.0
    d_lin = lin / mlin
    kdir = mlin / r

    sm = mu_scale * _radial_to_ellipse(c.sx_peak, c.sy_peak, sdir)
    ss = mu_scale * _radial_to_ellipse(c.sx_slide, c.sy_slide, sdir)
    sm = max(sm, 1e-8)
    ss = max(ss, sm + 1e-8)

    # Maximum-dissipation direction for an ellipse Fx^2/Ax^2 + Fy^2/Ay^2 = 1
    # under a slip vector proportional to [sx, sy].  Common mu scaling cancels from the direction.
    d_slide_raw = np.array([c.fx_slide * c.fx_slide * sx, c.fy_slide * c.fy_slide * sy_eff], dtype=float)
    ms = float(np.linalg.norm(d_slide_raw))
    d_slide = d_lin if ms <= 1e-15 else d_slide_raw / ms

    # w = O(r^2) near zero, so the Frechet derivative remains exactly diag(Kx,Ky).
    w = _smoothstep01(r / sm)
    d = (1.0 - w) * d_lin + w * d_slide
    md = float(np.linalg.norm(d))
    fdir = d_lin if md <= 1e-15 else d / md

    fm = mu_scale * _radial_to_ellipse(c.fx_peak, c.fy_peak, fdir)
    fs = mu_scale * _radial_to_ellipse(c.fx_slide, c.fy_slide, fdir)
    mag = _scalar_characteristic(r, kdir, sm, fm, ss, fs)
    F = mag * fdir
    return float(F[0]), float(F[1])


def _legacy_parallel_slip_force(c: CharacteristicAtLoad, sx: float, sy_eff: float, mu_scale: float) -> Tuple[float, float]:
    """v1.6 / Chrono-basic-style resultant construction retained only for numerical comparison tests."""
    sc = math.hypot(sx, sy_eff)
    if sc <= 1e-15:
        return 0.0, 0.0
    cx, cy = sx / sc, sy_eff / sc
    df0 = math.hypot(c.kx0 * cx, c.ky0 * cy)
    fm = mu_scale * math.hypot(c.fx_peak * cx, c.fy_peak * cy)
    sm = mu_scale * math.hypot(c.sx_peak * cx, c.sy_peak * cy)
    fs = mu_scale * math.hypot(c.fx_slide * cx, c.fy_slide * cy)
    ss = mu_scale * math.hypot(c.sx_slide * cx, c.sy_slide * cy)
    mag = _scalar_characteristic(sc, df0, max(sm, 1e-8), fm, max(ss, sm + 1e-8), fs)
    return mag * cx, mag * cy


def _v17_trail(c: CharacteristicAtLoad, sy_eff: float) -> float:
    """Old C0-only negative-lobe trail retained for regression measurement."""
    a = abs(sy_eff)
    z = max(c.trail_zero_sy, 1e-9)
    e = max(c.trail_end_sy, z + 1e-9)
    if a >= e:
        return 0.0
    if a <= z:
        x = a / z
        return c.trail0 * (1.0 - x * x * (3.0 - 2.0 * x))
    x = (a - z) / (e - z)
    return -0.15 * c.trail0 * 4.0 * x * (1.0 - x)


def _trail(c: CharacteristicAtLoad, sy_eff: float) -> float:
    """C1 pneumatic-trail curve used by the reduced backend.

    Positive trail collapses smoothly to zero, a small calibrated sign-reversal lobe is allowed near saturation,
    and the trail returns to zero with zero slope.  The C1 endpoints matter because Mz feeds Steering/FFB.
    """
    a = abs(sy_eff)
    z = max(c.trail_zero_sy, 1e-9)
    e = max(c.trail_end_sy, z + 1e-9)
    if a >= e:
        return 0.0
    if a <= z:
        x = a / z
        return c.trail0 * (1.0 - _smoothstep01(x))
    x = (a - z) / (e - z)
    # 16 x^2(1-x)^2 has value 1 at x=.5 and zero value/slope at both ends.
    return -0.15 * c.trail0 * 16.0 * x * x * (1.0 - x) * (1.0 - x)


def camber_equivalent_slip(c: CharacteristicAtLoad, camber: float) -> float:
    return (c.kgamma / max(c.ky0, EPS)) * camber


def evaluate_relaxed_state(
    params: TireV2Params,
    fz: float,
    sx_relaxed: float,
    sy_eff_relaxed: float,
    camber: float = 0.0,
    mu_scale: float = 1.0,
    vertical_compression: Optional[float] = None,
    omega: float = 0.0,
    state_trial: Optional[TireTransientState] = None,
) -> TireOutput:
    if params.load_map is None:
        raise ValueError("load_map")
    if fz <= 0:
        st = state_trial or TireTransientState(0.0, 0.0, TireMode.AIRBORNE)
        R = effective_radius(params, vertical_compression, fz, omega)
        return TireOutput(0, 0, 0, 0, 0, R, 0, st, False, max(mu_scale, 0.0))

    c, clamped = params.load_map.evaluate(fz)
    R = effective_radius(params, vertical_compression, fz, omega)
    Trr = rolling_resistance_torque(params, fz, R, omega)
    Mx = -c.mx_gamma * camber
    if mu_scale <= 0:
        # Road friction scales tangential shear capacity, not normal-load geometry, overturning compliance, or
        # hysteretic rolling resistance.  Keep those outputs alive on a zero-mu surface.
        st = state_trial or TireTransientState(sx_relaxed, sy_eff_relaxed, TireMode.HANDLING)
        return TireOutput(0, 0, Mx, 0, Trr, R, _trail(c, sy_eff_relaxed), st, clamped, 0.0)

    Fx, Fy = _anisotropic_combined_force(c, sx_relaxed, sy_eff_relaxed, mu_scale)
    tr = _trail(c, sy_eff_relaxed)
    Mz = -Fy * tr
    st = state_trial or TireTransientState(sx_relaxed, sy_eff_relaxed, TireMode.HANDLING)
    return TireOutput(Fx, Fy, Mx, Mz, Trr, R, tr, st, clamped, mu_scale)


def exact_relaxation_update(
    prev: TireTransientState,
    sx_target: float,
    sy_eff_target: float,
    travel_speed: float,
    dt: float,
    sigma_x: float,
    sigma_y: float,
    mode: TireMode = TireMode.HANDLING,
) -> TireTransientState:
    if dt < 0:
        raise ValueError("dt")
    v = max(0.0, travel_speed)
    ax = math.exp(-v * dt / max(sigma_x, 1e-9))
    ay = math.exp(-v * dt / max(sigma_y, 1e-9))
    return TireTransientState(
        ax * prev.sx + (1.0 - ax) * sx_target,
        ay * prev.sy_eff + (1.0 - ay) * sy_eff_target,
        mode,
    )


def handling_eval(
    params: TireV2Params,
    fz: float,
    sx_inst: float,
    sy_inst: float,
    camber: float,
    mu_scale: float,
    prev: TireTransientState,
    travel_speed: float,
    dt: float,
    vertical_compression: Optional[float] = None,
    omega: float = 0.0,
) -> TireOutput:
    c, _ = params.load_map.evaluate(fz)
    sy_eff_target = sy_inst + camber_equivalent_slip(c, camber)
    trial = exact_relaxation_update(
        prev, sx_inst, sy_eff_target, travel_speed, dt, c.sigma_x, c.sigma_y, TireMode.HANDLING
    )
    return evaluate_relaxed_state(
        params, fz, trial.sx, trial.sy_eff, camber, mu_scale, vertical_compression, omega, trial
    )


def select_tire_mode(
    prev_mode: TireMode, in_contact: bool, v_long: float, transport_speed: float, policy: TireRegimePolicy
) -> TireMode:
    if not in_contact:
        return TireMode.AIRBORNE
    v = abs(float(v_long))
    vt = abs(float(transport_speed))
    if prev_mode == TireMode.HANDLING:
        if v < policy.handling_exit_abs_vlong or vt < policy.handling_exit_transport:
            return TireMode.FRICTION_CONTACT
        return TireMode.HANDLING
    if v > policy.handling_enter_abs_vlong and vt > policy.handling_enter_transport:
        return TireMode.HANDLING
    return TireMode.FRICTION_CONTACT


def commit_airborne_state() -> TireTransientState:
    # This state represents contact-patch shear memory. In the reduced handling model there is no belt mode that can
    # carry this memory through flight, so confirmed contact loss clears it. This matches the simplicity boundary of
    # the core model; a rigid-ring/belt extension would own its own airborne structural states.
    return TireTransientState(0.0, 0.0, TireMode.AIRBORNE)


def _peak_axes(c: CharacteristicAtLoad, mu_scale: float) -> Tuple[float, float]:
    return max(mu_scale * c.fx_peak, EPS), max(mu_scale * c.fy_peak, EPS)


def _slide_axes(c: CharacteristicAtLoad, mu_scale: float) -> Tuple[float, float]:
    return max(mu_scale * c.fx_slide, EPS), max(mu_scale * c.fy_slide, EPS)


def force_inside_peak_ellipse(c: CharacteristicAtLoad, Fx: float, Fy: float, mu_scale: float, tol: float = 1e-10) -> bool:
    ax, ay = _peak_axes(c, mu_scale)
    q = (Fx / ax) ** 2 + (Fy / ay) ** 2
    return q <= 1.0 + tol


def _ellipse_max_dissipation_force(
    c: CharacteristicAtLoad, u: np.ndarray, mu_scale: float, *, sliding: bool = True
) -> np.ndarray:
    # Static feasibility uses the peak ellipse; once sliding is active, use the lower kinetic/plateau ellipse.
    ax, ay = _slide_axes(c, mu_scale) if sliding else _peak_axes(c, mu_scale)
    ux, uy = float(u[0]), float(u[1])
    den = math.sqrt((ax * ux) ** 2 + (ay * uy) ** 2)
    if den <= 1e-15:
        return np.zeros(2)
    return np.array([ax * ax * ux / den, ay * ay * uy / den])


@dataclass(frozen=True)
class FrictionSolveResult:
    impulse: np.ndarray
    u_post: np.ndarray
    force: np.ndarray
    mode: FrictionContactMode
    residual_norm: float
    converged: bool


def solve_friction_contact_2d(
    params: TireV2Params,
    u_free: np.ndarray,
    W: np.ndarray,
    fz: float,
    mu_scale: float,
    dt: float,
) -> FrictionSolveResult:
    """Low-|Vx| / handling-domain fallback: exact stick if feasible, otherwise implicit max-dissipation sliding.

    This is not the normal-speed tire characteristic. It exists so standing burnout, locked-wheel approach to zero,
    and near-90-degree kinematics do not require a dimensionless slip denominator.
    """
    u_free = np.asarray(u_free, float)
    W = np.asarray(W, float)
    c, _ = params.load_map.evaluate(fz)
    if fz <= 0 or dt <= 0:
        return FrictionSolveResult(np.zeros(2), u_free.copy(), np.zeros(2), FrictionContactMode.SLIDE, 0.0, True)

    try:
        lam_stick = np.linalg.solve(W, u_free)
    except np.linalg.LinAlgError:
        lam_stick = np.linalg.lstsq(W, u_free, rcond=None)[0]
    F_stick = lam_stick / dt
    if force_inside_peak_ellipse(c, float(F_stick[0]), float(F_stick[1]), mu_scale):
        up = u_free - W @ lam_stick
        return FrictionSolveResult(lam_stick, up, F_stick, FrictionContactMode.STICK, float(np.linalg.norm(up)), True)

    def residual(lam: np.ndarray) -> np.ndarray:
        up = u_free - W @ lam
        F = _ellipse_max_dissipation_force(c, up if np.linalg.norm(up) > 1e-12 else u_free, mu_scale, sliding=True)
        return lam - dt * F

    F0 = _ellipse_max_dissipation_force(c, u_free, mu_scale, sliding=True)
    x0 = dt * F0
    ls = least_squares(residual, x0, xtol=1e-13, ftol=1e-13, gtol=1e-13, max_nfev=80)
    lam = ls.x
    up = u_free - W @ lam
    F = lam / dt
    rn = float(np.linalg.norm(residual(lam)))
    return FrictionSolveResult(lam, up, F, FrictionContactMode.SLIDE, rn, bool(ls.success and rn < 1e-8))


def invert_force_to_relaxed_state(
    params: TireV2Params,
    fz: float,
    Fx: float,
    Fy: float,
    camber: float = 0.0,
    mu_scale: float = 1.0,
) -> TireTransientState:
    """Backward-compatible convenience wrapper. Prefer seed_handling_from_reaction for diagnostics."""
    return seed_handling_from_reaction(params, fz, Fx, Fy, camber, mu_scale).state


def force_tangent_numeric_relaxed(
    params: TireV2Params,
    fz: float,
    sx: float,
    sy_eff: float,
    camber: float,
    mu: float,
    h: float = 1e-6,
) -> np.ndarray:
    def f(a: float, b: float) -> np.ndarray:
        o = evaluate_relaxed_state(params, fz, a, b, camber, mu)
        return np.array([o.Fx, o.Fy])

    hx = h * max(1.0, abs(sx))
    hy = h * max(1.0, abs(sy_eff))
    return np.column_stack(
        (
            (f(sx + hx, sy_eff) - f(sx - hx, sy_eff)) / (2.0 * hx),
            (f(sx, sy_eff + hy) - f(sx, sy_eff - hy)) / (2.0 * hy),
        )
    )




def force_load_tangent_numeric(
    params: TireV2Params,
    fz: float,
    sx: float,
    sy_eff: float,
    camber: float,
    mu: float,
    h_rel: float = 1e-4,
) -> np.ndarray:
    """Reference d[Fx,Fy]/dFz for optional normal<->tangential block coupling.

    Production compiled backends may provide analytic/AD derivatives.  The Tire does not solve Fz; it only exposes
    this constitutive derivative so either suspension backend can include load sensitivity in its host iteration.
    """
    if fz <= 0:
        return np.zeros(2)
    h = max(1e-3, abs(fz) * h_rel)
    lo = max(0.0, fz - h)
    hi = fz + h
    flo = evaluate_relaxed_state(params, lo, sx, sy_eff, camber, mu)
    fhi = evaluate_relaxed_state(params, hi, sx, sy_eff, camber, mu)
    den = hi - lo
    return (np.array([fhi.Fx, fhi.Fy]) - np.array([flo.Fx, flo.Fy])) / den

@dataclass(frozen=True)
class ImplicitSolveResult:
    impulse: np.ndarray
    u_post: np.ndarray
    state_trial: TireTransientState
    output: TireOutput
    iterations: int
    residual_norm: float
    converged: bool
    fallback_used: bool


def solve_handling_impulse_2d(
    params: TireV2Params,
    u_free: np.ndarray,
    W: np.ndarray,
    v_norm_frozen: float,
    fz: float,
    camber: float,
    mu: float,
    prev: TireTransientState,
    travel_speed_frozen: float,
    dt: float,
    vertical_compression: Optional[float] = None,
    omega: float = 0.0,
    max_iter: int = 12,
) -> ImplicitSolveResult:
    """Solve lambda = dt F(xi_trial(u_free-W lambda)).

    v_norm_frozen is the constitutive slip normalization speed (normally |v_long| in HANDLING mode).
    travel_speed_frozen is the relaxation-length convection speed.  The two are deliberately separate API values.
    """
    u_free = np.asarray(u_free, float)
    W = np.asarray(W, float)
    lam = np.zeros(2)
    if v_norm_frozen <= 0:
        raise ValueError("HANDLING requires a positive frozen slip-normalization speed; use FRICTION_CONTACT near zero")
    vnorm = float(v_norm_frozen)
    c, _ = params.load_map.evaluate(fz)
    ax = math.exp(-max(travel_speed_frozen, 0.0) * dt / max(c.sigma_x, 1e-9))
    ay = math.exp(-max(travel_speed_frozen, 0.0) * dt / max(c.sigma_y, 1e-9))
    beta = np.array([1.0 - ax, 1.0 - ay])
    sgamma = camber_equivalent_slip(c, camber)

    def eval_lam(l: np.ndarray):
        u = u_free - W @ l
        target = np.array([u[0] / vnorm, u[1] / vnorm + sgamma])
        trial = TireTransientState(
            ax * prev.sx + beta[0] * target[0],
            ay * prev.sy_eff + beta[1] * target[1],
            TireMode.HANDLING,
        )
        out = evaluate_relaxed_state(params, fz, trial.sx, trial.sy_eff, camber, mu, vertical_compression, omega, trial)
        r = l - dt * np.array([out.Fx, out.Fy])
        return r, u, trial, out

    def jacobian_chain(trial: TireTransientState) -> np.ndarray:
        D = force_tangent_numeric_relaxed(params, fz, trial.sx, trial.sy_eff, camber, mu)
        Dxi_Dlam = -np.diag(beta / vnorm) @ W
        return np.eye(2) - dt * D @ Dxi_Dlam

    best = None
    for it in range(1, max_iter + 1):
        r, u, trial, out = eval_lam(lam)
        rn = float(np.linalg.norm(r))
        if best is None or rn < best[0]:
            best = (rn, lam.copy(), u.copy(), trial, out, it)
        if rn < 1e-9:
            return ImplicitSolveResult(lam, u, trial, out, it, rn, True, False)

        J = jacobian_chain(trial)
        try:
            step = np.linalg.solve(J, -r)
        except np.linalg.LinAlgError:
            step = -r

        accepted = False
        t = 1.0
        for _ in range(12):
            cand = lam + t * step
            rc, *_ = eval_lam(cand)
            if np.linalg.norm(rc) < rn:
                lam = cand
                accepted = True
                break
            t *= 0.5
        if not accepted:
            lam = lam - 0.25 * r

    rn, l, u, trial, out, it = best

    def fun(x: np.ndarray) -> np.ndarray:
        return eval_lam(x)[0]

    ls = least_squares(fun, l, xtol=1e-13, ftol=1e-13, gtol=1e-13, max_nfev=100)
    rr, uu, tt, oo = eval_lam(ls.x)
    rrn = float(np.linalg.norm(rr))
    if rrn < rn:
        return ImplicitSolveResult(ls.x, uu, tt, oo, it + int(ls.nfev), rrn, rrn < 1e-9, True)
    return ImplicitSolveResult(l, u, trial, out, it, rn, False, False)


def residual_jacobian_finite_difference(
    params: TireV2Params,
    u_free: np.ndarray,
    W: np.ndarray,
    vnorm: float,
    fz: float,
    camber: float,
    mu: float,
    prev: TireTransientState,
    travel_speed: float,
    dt: float,
    lam: np.ndarray,
    h: float = 1e-5,
) -> np.ndarray:
    # Independent oracle for checking the chain-assembled Newton Jacobian.
    c, _ = params.load_map.evaluate(fz)
    ax = math.exp(-travel_speed * dt / max(c.sigma_x, 1e-9))
    ay = math.exp(-travel_speed * dt / max(c.sigma_y, 1e-9))
    sg = camber_equivalent_slip(c, camber)

    def res(l: np.ndarray) -> np.ndarray:
        u = u_free - W @ l
        trial = TireTransientState(
            ax * prev.sx + (1 - ax) * u[0] / vnorm,
            ay * prev.sy_eff + (1 - ay) * (u[1] / vnorm + sg),
            TireMode.HANDLING,
        )
        o = evaluate_relaxed_state(params, fz, trial.sx, trial.sy_eff, camber, mu, state_trial=trial)
        return l - dt * np.array([o.Fx, o.Fy])

    J = np.zeros((2, 2))
    for j in range(2):
        d = np.zeros(2)
        d[j] = h
        J[:, j] = (res(lam + d) - res(lam - d)) / (2 * h)
    return J


def chain_jacobian_at_lambda(
    params: TireV2Params,
    u_free: np.ndarray,
    W: np.ndarray,
    vnorm: float,
    fz: float,
    camber: float,
    mu: float,
    prev: TireTransientState,
    travel_speed: float,
    dt: float,
    lam: np.ndarray,
) -> np.ndarray:
    c, _ = params.load_map.evaluate(fz)
    ax = math.exp(-travel_speed * dt / max(c.sigma_x, 1e-9))
    ay = math.exp(-travel_speed * dt / max(c.sigma_y, 1e-9))
    beta = np.array([1 - ax, 1 - ay])
    sg = camber_equivalent_slip(c, camber)
    u = np.asarray(u_free) - np.asarray(W) @ np.asarray(lam)
    trial = TireTransientState(
        ax * prev.sx + beta[0] * u[0] / vnorm,
        ay * prev.sy_eff + beta[1] * (u[1] / vnorm + sg),
        TireMode.HANDLING,
    )
    D = force_tangent_numeric_relaxed(params, fz, trial.sx, trial.sy_eff, camber, mu)
    return np.eye(2) + dt * D @ np.diag(beta / vnorm) @ np.asarray(W)


@dataclass(frozen=True)
class HandoffSeedResult:
    state: TireTransientState
    projected: bool
    target_force: np.ndarray
    represented_force: np.ndarray
    error_norm: float


def seed_handling_from_reaction(
    params: TireV2Params, fz: float, Fx: float, Fy: float, camber: float = 0.0, mu_scale: float = 1.0
) -> HandoffSeedResult:
    """Seed HANDLING from the actual low-speed/friction-contact reaction.

    State is never copied blindly across regimes. If the low-speed solver's force lies outside the handling peak set,
    it is projected and the projection is reported instead of hidden.
    """
    if fz <= 0 or mu_scale <= 0:
        z = TireTransientState(0.0, 0.0, TireMode.HANDLING)
        return HandoffSeedResult(z, False, np.array([Fx, Fy], float), np.zeros(2), float(math.hypot(Fx, Fy)))
    c, _ = params.load_map.evaluate(fz)
    original = np.array([Fx, Fy], dtype=float)
    target = original.copy()
    ax, ay = _peak_axes(c, mu_scale)
    q = math.sqrt((target[0] / ax) ** 2 + (target[1] / ay) ** 2)
    projected = q > 1.0
    if projected:
        target /= q
    x0 = np.array([target[0] / max(c.kx0, EPS), target[1] / max(c.ky0, EPS)])
    bx = max(c.sx_peak * mu_scale, 1e-5)
    by = max(c.sy_peak * mu_scale, 1e-5)

    def fun(x: np.ndarray) -> np.ndarray:
        o = evaluate_relaxed_state(params, fz, float(x[0]), float(x[1]), camber, mu_scale)
        return np.array([o.Fx, o.Fy]) - target

    ls = least_squares(fun, x0, bounds=([-bx, -by], [bx, by]), xtol=1e-13, ftol=1e-13, gtol=1e-13, max_nfev=120)
    represented = target + fun(ls.x)
    err = float(np.linalg.norm(represented - target))
    if err > 1e-5:
        raise RuntimeError("could not seed handling state from contact reaction")
    st = TireTransientState(float(ls.x[0]), float(ls.x[1]), TireMode.HANDLING)
    return HandoffSeedResult(st, projected, original, represented, err)


def commit_friction_contact_state() -> TireTransientState:
    # FRICTION_CONTACT has its own instantaneous/bounded solver and does not consume the handling lag state.
    # Clearing avoids a stale hidden state; exit back to HANDLING must seed from the actual solved reaction.
    return TireTransientState(0.0, 0.0, TireMode.FRICTION_CONTACT)


def steering_axis_generalized_force(
    force: np.ndarray, moment: np.ndarray, contact_point: np.ndarray, axis_point: np.ndarray, axis_direction: np.ndarray
) -> float:
    """Virtual-work oracle used to verify Tire Mz -> Steering feedback consistency."""
    a = np.asarray(axis_direction, float)
    n = float(np.linalg.norm(a))
    if n <= 1e-15:
        raise ValueError("axis_direction")
    a = a / n
    r = np.asarray(contact_point, float) - np.asarray(axis_point, float)
    wrench_moment = np.cross(r, np.asarray(force, float)) + np.asarray(moment, float)
    return float(np.dot(a, wrench_moment))


@dataclass(frozen=True)
class CoupledHostSolveResult:
    fz: float
    impulse: np.ndarray
    force: np.ndarray
    normal_state: float
    residual_norm: float
    iterations: int
    converged: bool


def solve_mapped_massless_normal_tangential_block(
    params: TireV2Params,
    u_free: np.ndarray,
    W: np.ndarray,
    vnorm: float,
    travel_speed: float,
    prev: TireTransientState,
    dt: float,
    base_normal_force: float,
    jacking_coeff: np.ndarray,
    camber: float = 0.0,
    mu: float = 1.0,
) -> CoupledHostSolveResult:
    """Synthetic Mapped-K&C massless host block.

    The normal equation is the reduced generalized equilibrium
        Fz = Fbase + jx*Fx + jy*Fy.
    jacking_coeff stands in for the host's J_q^T mapping. Tire still owns only the constitutive law.
    """
    u_free = np.asarray(u_free, float); W = np.asarray(W, float); jc = np.asarray(jacking_coeff, float)
    x0 = np.array([0.0, 0.0, max(base_normal_force, 1.0)])

    def residual(x: np.ndarray) -> np.ndarray:
        lam = x[:2]; fz = max(float(x[2]), 0.0)
        c, _ = params.load_map.evaluate(max(fz, 1e-9))
        ax = math.exp(-max(travel_speed,0.0)*dt/max(c.sigma_x,1e-9))
        ay = math.exp(-max(travel_speed,0.0)*dt/max(c.sigma_y,1e-9))
        sg = camber_equivalent_slip(c, camber)
        u = u_free - W @ lam
        trial = TireTransientState(
            ax*prev.sx + (1-ax)*u[0]/vnorm,
            ay*prev.sy_eff + (1-ay)*(u[1]/vnorm + sg),
            TireMode.HANDLING,
        )
        o = evaluate_relaxed_state(params, fz, trial.sx, trial.sy_eff, camber, mu, state_trial=trial)
        Ft = np.array([o.Fx,o.Fy])
        return np.array([lam[0]-dt*Ft[0], lam[1]-dt*Ft[1], fz-(base_normal_force + float(jc@Ft))])

    ls = least_squares(residual, x0, bounds=([-np.inf,-np.inf,0.0],[np.inf,np.inf,np.inf]), xtol=1e-12, ftol=1e-12, gtol=1e-12, max_nfev=120)
    rr = residual(ls.x); fz=float(ls.x[2]); lam=ls.x[:2]; force=lam/dt
    return CoupledHostSolveResult(fz, lam, force, fz, float(np.linalg.norm(rr)), int(ls.nfev), bool(ls.success and np.linalg.norm(rr)<1e-8))


def solve_explicit_unsprung_normal_tangential_block(
    params: TireV2Params,
    u_free: np.ndarray,
    W: np.ndarray,
    vnorm: float,
    travel_speed: float,
    prev: TireTransientState,
    dt: float,
    unsprung_mass: float,
    vz0: float,
    compression0: float,
    suspension_down_force: float,
    jacking_coeff: np.ndarray,
    camber: float = 0.0,
    mu: float = 1.0,
) -> CoupledHostSolveResult:
    """Synthetic explicit-unsprung + compliant-normal block for interface validation.

    Positive vz is upward, so delta_dot=-vz and delta1=delta0-dt*vz1.
    Normal dynamics: m(v1-v0)/dt = Fz - Fsusp_down + j^T Ft.
    """
    u_free=np.asarray(u_free,float); W=np.asarray(W,float); jc=np.asarray(jacking_coeff,float)
    if unsprung_mass <= 0: raise ValueError("unsprung_mass")
    x0=np.array([0.0,0.0,vz0])

    def residual(x: np.ndarray) -> np.ndarray:
        lam=x[:2]; vz=float(x[2]); comp=max(0.0, compression0-dt*vz)
        vert=tire_vertical_law(params, comp, -vz); fz=vert.fz
        c,_=params.load_map.evaluate(max(fz,1e-9))
        ax=math.exp(-max(travel_speed,0.0)*dt/max(c.sigma_x,1e-9)); ay=math.exp(-max(travel_speed,0.0)*dt/max(c.sigma_y,1e-9))
        sg=camber_equivalent_slip(c,camber); u=u_free-W@lam
        trial=TireTransientState(ax*prev.sx+(1-ax)*u[0]/vnorm, ay*prev.sy_eff+(1-ay)*(u[1]/vnorm+sg), TireMode.HANDLING)
        o=evaluate_relaxed_state(params,fz,trial.sx,trial.sy_eff,camber,mu,vertical_compression=comp,state_trial=trial)
        Ft=np.array([o.Fx,o.Fy])
        rn=unsprung_mass*(vz-vz0)/dt - (fz - suspension_down_force + float(jc@Ft))
        return np.array([lam[0]-dt*Ft[0],lam[1]-dt*Ft[1],rn])

    ls=least_squares(residual,x0,xtol=1e-12,ftol=1e-12,gtol=1e-12,max_nfev=160)
    rr=residual(ls.x); lam=ls.x[:2]; vz=float(ls.x[2]); comp=max(0.0,compression0-dt*vz); fz=tire_vertical_law(params,comp,-vz).fz
    return CoupledHostSolveResult(fz,lam,lam/dt,vz,float(np.linalg.norm(rr)),int(ls.nfev),bool(ls.success and np.linalg.norm(rr)<1e-8))


def contact_power_error(Fx: float, omega: float, R_kin: float, R_torque: float) -> float:
    return Fx * omega * (R_kin - R_torque)


def characteristic_asset_diagnostics(
    params: TireV2Params, load_samples: int = 33, direction_samples: int = 181
) -> Dict[str, float]:
    """Return worst compatibility margins over the *interpolated runtime domain*, not only table nodes.

    The current scalar characteristic preserves the requested initial stiffness only if
    K_dir >= 2 F_peak_dir / s_peak_dir.  We treat violation as an offline asset/compiler error rather than
    silently changing K at runtime.
    """
    if params.load_map is None:
        return {"min_k_peak_ratio": float("nan"), "worst_fz": float("nan"), "worst_theta": float("nan")}
    low_audit = max(1e-6, 0.01 * params.load_map.fz_min)
    loads = np.linspace(low_audit, params.load_map.fz_max, max(2, load_samples))
    # Guarantee the raw nodes are present in the audit too.
    loads = np.unique(np.concatenate([loads, params.load_map.fz_nodes]))
    worst = (float("inf"), float("nan"), float("nan"))
    for fz in loads:
        c, _ = params.load_map.evaluate(float(fz))
        for th in np.linspace(0.0, 2.0 * math.pi, direction_samples, endpoint=False):
            sdir = np.array([math.cos(th), math.sin(th)])
            lin = np.array([c.kx0 * sdir[0], c.ky0 * sdir[1]])
            kdir = float(np.linalg.norm(lin))
            if kdir <= 0:
                continue
            fdir = lin / kdir
            sm = _radial_to_ellipse(c.sx_peak, c.sy_peak, sdir)
            fm = _radial_to_ellipse(c.fx_peak, c.fy_peak, fdir)
            ratio = kdir * sm / max(2.0 * fm, EPS)
            if ratio < worst[0]:
                worst = (ratio, float(fz), float(th))
    return {"min_k_peak_ratio": worst[0], "worst_fz": worst[1], "worst_theta": worst[2]}


def validate_characteristic_asset(
    params: TireV2Params, load_samples: int = 33, direction_samples: int = 181
) -> List[str]:
    errs: List[str] = []
    if params.load_map is None:
        return ["missing load_map"]

    # Basic raw-node sanity first.
    for fz in params.load_map.fz_nodes:
        c, _ = params.load_map.evaluate(float(fz))
        vals = [
            c.kx0, c.ky0, c.fx_peak, c.fy_peak, c.sx_peak, c.sy_peak,
            c.fx_slide, c.fy_slide, c.sx_slide, c.sy_slide, c.sigma_x, c.sigma_y
        ]
        if any(v <= 0 for v in vals):
            errs.append(f"non-positive parameter at Fz={fz}")
        if not (c.sx_slide > c.sx_peak and c.sy_slide > c.sy_peak):
            errs.append(f"slide slip must exceed peak slip at Fz={fz}")
        if not (c.fx_peak >= c.fx_slide and c.fy_peak >= c.fy_slide):
            errs.append(f"peak force must exceed slide force at Fz={fz}")

    # PCHIP can create a perfectly sane set of nodes whose *combined/interpolated* tuples are not compatible with
    # the selected scalar-curve family.  Audit the runtime domain, not just the source table.
    diag = characteristic_asset_diagnostics(params, load_samples, direction_samples)
    if math.isfinite(diag["min_k_peak_ratio"]) and diag["min_k_peak_ratio"] < 1.0 - 1e-8:
        errs.append(
            "incompatible K/peak shape over compiled domain: "
            f"min_ratio={diag['min_k_peak_ratio']:.9g} at Fz={diag['worst_fz']:.9g}, theta={diag['worst_theta']:.9g}"
        )
    return errs

