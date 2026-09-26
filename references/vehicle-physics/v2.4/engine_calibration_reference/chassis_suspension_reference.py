"""Reference implementation for the Chassis + Suspension Kinematics v1.5 research close-out.

This is intentionally a small, inspectable numerical reference rather than production code.
It covers only the implementation questions studied in the v1.5 close-out:
  * massless airborne suspension / damper causality,
  * vertical tire compliance vs contact-gap / Fz coupling,
  * mapped K&C runtime interpolation / derivatives / domain handling,
  * safeguarded 1-D jounce solve.

Sign convention used by the vertical examples:
  q > 0  : suspension bump / wheel moves upward relative to chassis
  z       : chassis suspension-mount height above a flat road
  y_w     : wheel-center height = z - L + q
  delta_t : tire vertical compression = max(0, R - y_w)
  Fz > 0  : road normal force upward

For a linear corner, massless vertical equilibrium is
  0 = -k_s q - c_s qdot + Fz + Q_arb + Q_stop.

The module is not a Tire V2 implementation. TireVerticalLaw is only the normal
constitutive interface needed to close suspension/contact normal dynamics.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, Iterable, Mapping, Sequence, Tuple
import math

import numpy as np
from scipy.interpolate import RectBivariateSpline, RegularGridInterpolator, CubicSpline, PchipInterpolator
from scipy.optimize import brentq, root


class DomainError(ValueError):
    pass


class ContactClass(str, Enum):
    CONTACT = "contact"
    AIRBORNE = "airborne"
    OVERCOMPRESSED = "overcompressed"


@dataclass(frozen=True)
class AxisDomain:
    values: np.ndarray
    name: str

    def __post_init__(self):
        v = np.asarray(self.values, dtype=float)
        if v.ndim != 1 or len(v) < 2 or np.any(np.diff(v) <= 0):
            raise ValueError(f"{self.name}: breakpoints must be strictly increasing")
        object.__setattr__(self, "values", v)

    @property
    def lo(self) -> float:
        return float(self.values[0])

    @property
    def hi(self) -> float:
        return float(self.values[-1])

    def contains(self, x: float) -> bool:
        return self.lo <= x <= self.hi


@dataclass
class SplineField2D:
    """Cubic tensor-product runtime field with explicit hard-domain semantics.

    scipy's RectBivariateSpline itself evaluates out-of-range requests at the
    boundary while still returning a non-zero boundary derivative. That is a
    dangerous hidden extrapolation policy for physics. This wrapper therefore
    rejects out-of-domain queries by default, or performs an explicitly named
    clamp whose derivative is zero along the clamped dimension.
    """

    q_axis: AxisDomain
    steer_axis: AxisDomain
    values: np.ndarray
    name: str = "field"
    kq: int = 3
    ks: int = 3

    def __post_init__(self):
        values = np.asarray(self.values, dtype=float)
        expected = (len(self.q_axis.values), len(self.steer_axis.values))
        if values.shape != expected:
            raise ValueError(f"{self.name}: expected {expected}, got {values.shape}")
        kq = min(self.kq, len(self.q_axis.values) - 1)
        ks = min(self.ks, len(self.steer_axis.values) - 1)
        self._spline = RectBivariateSpline(
            self.q_axis.values,
            self.steer_axis.values,
            values,
            kx=kq,
            ky=ks,
            s=0.0,
        )

    def _resolve_domain(self, q: float, steer: float, policy: str) -> tuple[float, float, bool, bool]:
        q_out = not self.q_axis.contains(q)
        s_out = not self.steer_axis.contains(steer)
        if not q_out and not s_out:
            return q, steer, False, False
        if policy == "reject":
            raise DomainError(
                f"{self.name}: ({q:.6g}, {steer:.6g}) outside "
                f"q=[{self.q_axis.lo:.6g},{self.q_axis.hi:.6g}], "
                f"steer=[{self.steer_axis.lo:.6g},{self.steer_axis.hi:.6g}]"
            )
        if policy != "clamp":
            raise ValueError("policy must be 'reject' or 'clamp'")
        qc = min(max(q, self.q_axis.lo), self.q_axis.hi)
        sc = min(max(steer, self.steer_axis.lo), self.steer_axis.hi)
        return qc, sc, q_out, s_out

    def eval(self, q: float, steer: float, *, dq: int = 0, ds: int = 0, policy: str = "reject") -> float:
        qc, sc, q_clamped, s_clamped = self._resolve_domain(q, steer, policy)
        # A clamped value is constant with respect to the clamped input outside
        # the domain. Returning the boundary derivative would be inconsistent.
        if policy == "clamp" and ((dq > 0 and q_clamped) or (ds > 0 and s_clamped)):
            return 0.0
        return float(self._spline.ev(qc, sc, dx=dq, dy=ds))


@dataclass
class KCRuntimeMap:
    q_axis: AxisDomain
    steer_axis: AxisDomain
    fields: Dict[str, SplineField2D]

    @classmethod
    def compile(cls, q_values: Sequence[float], steer_values: Sequence[float], raw_fields: Mapping[str, np.ndarray]):
        qa = AxisDomain(np.asarray(q_values, dtype=float), "jounce")
        sa = AxisDomain(np.asarray(steer_values, dtype=float), "steer")
        fields = {name: SplineField2D(qa, sa, np.asarray(v, dtype=float), name=name) for name, v in raw_fields.items()}
        return cls(qa, sa, fields)

    def evaluate(self, q: float, steer: float, *, policy: str = "reject") -> Dict[str, float]:
        return {name: f.eval(q, steer, policy=policy) for name, f in self.fields.items()}

    def derivative_q(self, q: float, steer: float, *, policy: str = "reject") -> Dict[str, float]:
        return {name: f.eval(q, steer, dq=1, policy=policy) for name, f in self.fields.items()}

    def derivative_steer(self, q: float, steer: float, *, policy: str = "reject") -> Dict[str, float]:
        return {name: f.eval(q, steer, ds=1, policy=policy) for name, f in self.fields.items()}


# ---- SO(3) helpers for a mapped spindle orientation -------------------------

def skew(v: Sequence[float]) -> np.ndarray:
    x, y, z = map(float, v)
    return np.array([[0.0, -z, y], [z, 0.0, -x], [-y, x, 0.0]])




def vee(M: np.ndarray) -> np.ndarray:
    """Inverse of skew for an approximately skew-symmetric 3x3 matrix."""
    M = np.asarray(M, dtype=float)
    return np.array([M[2,1], M[0,2], M[1,0]], dtype=float)


def so3_left_jacobian(rotvec: Sequence[float]) -> np.ndarray:
    """SO(3) left Jacobian mapping rotation-vector rate to spatial angular velocity.

    If R = Exp(phi^) then omega_spatial = J_l(phi) * phi_dot, where
    R_dot R^T = omega_spatial^.  Suspension K&C rotations are small enough
    that the rotvec chart is well conditioned, but using J_l avoids silently
    treating rotvec derivatives as angular velocity away from zero.
    """
    phi = np.asarray(rotvec, dtype=float)
    theta = float(np.linalg.norm(phi))
    K = skew(phi)
    if theta < 1e-8:
        return np.eye(3) + 0.5*K + (1.0/6.0)*(K@K)
    a = (1.0 - math.cos(theta)) / (theta*theta)
    b = (theta - math.sin(theta)) / (theta*theta*theta)
    return np.eye(3) + a*K + b*(K@K)


def rotvec_rate_to_spatial_omega(rotvec: Sequence[float], rotvec_rate: Sequence[float]) -> np.ndarray:
    return so3_left_jacobian(rotvec) @ np.asarray(rotvec_rate, dtype=float)

def exp_so3(rotvec: Sequence[float]) -> np.ndarray:
    r = np.asarray(rotvec, dtype=float)
    a = float(np.linalg.norm(r))
    if a < 1e-12:
        K = skew(r)
        return np.eye(3) + K
    axis = r / a
    K = skew(axis)
    return np.eye(3) + math.sin(a) * K + (1.0 - math.cos(a)) * (K @ K)


@dataclass
class SyntheticKCGroundTruth:
    """Analytic map used only as a test oracle."""

    def values(self, q: float, s: float) -> Dict[str, float]:
        # Smooth, mildly nonlinear quantities representative of a reduced K&C map.
        return {
            "px": 0.018 * q + 0.22 * q * q + 0.0025 * q * s,
            "py": -0.025 * q + 0.0015 * math.sin(2.0 * s) + 0.004 * q * s,
            "pz": q + 0.10 * q * q - 0.0015 * s * s,
            "rx": -0.17 * q + 0.03 * q * s,      # camber-like rotation vector x
            "ry": 0.015 * q * s,                 # caster-like cross term
            "rz": 0.075 * q + 0.06 * s + 0.025 * q * s,  # toe/steer-like
            "spring_length": 0.31 - 0.74 * q + 0.28 * q * q + 0.004 * s * s,
            "damper_length": 0.29 - 0.69 * q + 0.18 * q * q + 0.003 * q * s,
            "arb_coord": 2.6 * q + 0.35 * q * q + 0.02 * s,
        }

    def dq(self, q: float, s: float) -> Dict[str, float]:
        return {
            "px": 0.018 + 0.44 * q + 0.0025 * s,
            "py": -0.025 + 0.004 * s,
            "pz": 1.0 + 0.20 * q,
            "rx": -0.17 + 0.03 * s,
            "ry": 0.015 * s,
            "rz": 0.075 + 0.025 * s,
            "spring_length": -0.74 + 0.56 * q,
            "damper_length": -0.69 + 0.36 * q + 0.003 * s,
            "arb_coord": 2.6 + 0.70 * q,
        }

    def ds(self, q: float, s: float) -> Dict[str, float]:
        return {
            "px": 0.0025 * q,
            "py": 0.003 * math.cos(2.0 * s) + 0.004 * q,
            "pz": -0.003 * s,
            "rx": 0.03 * q,
            "ry": 0.015 * q,
            "rz": 0.06 + 0.025 * q,
            "spring_length": 0.008 * s,
            "damper_length": 0.003 * q,
            "arb_coord": 0.02,
        }


def build_synthetic_kc_map(nq: int = 9, ns: int = 9) -> tuple[KCRuntimeMap, SyntheticKCGroundTruth]:
    gt = SyntheticKCGroundTruth()
    qv = np.linspace(-0.08, 0.08, nq)
    sv = np.linspace(-0.45, 0.45, ns)
    fields: Dict[str, np.ndarray] = {}
    names = list(gt.values(0.0, 0.0).keys())
    for name in names:
        arr = np.zeros((nq, ns))
        for i, q in enumerate(qv):
            for j, s in enumerate(sv):
                arr[i, j] = gt.values(float(q), float(s))[name]
        fields[name] = arr
    return KCRuntimeMap.compile(qv, sv, fields), gt


# ---- Mapped contact/jounce root ---------------------------------------------

@dataclass
class JounceSolveResult:
    classification: ContactClass
    q: float | None
    separation: float
    iterations_or_calls: int


def solve_jounce_safeguarded(
    gap_fn,
    q_min: float,
    q_max: float,
    *,
    xtol: float = 1e-11,
) -> JounceSolveResult:
    """Solve a one-dimensional wheel-path contact root with explicit classification.

    gap > 0 means separated. gap < 0 means geometric overlap relative to the
    unloaded wheel/tire envelope. A root inside [q_min,q_max] is contact.
    """
    g0 = float(gap_fn(q_min))
    g1 = float(gap_fn(q_max))
    if g0 == 0.0:
        return JounceSolveResult(ContactClass.CONTACT, q_min, 0.0, 1)
    if g1 == 0.0:
        return JounceSolveResult(ContactClass.CONTACT, q_max, 0.0, 1)
    if g0 > 0.0 and g1 > 0.0:
        # even at maximum droop / bump range there is no intersection
        return JounceSolveResult(ContactClass.AIRBORNE, None, min(g0, g1), 2)
    if g0 < 0.0 and g1 < 0.0:
        # the entire admissible wheel path lies inside the road envelope
        return JounceSolveResult(ContactClass.OVERCOMPRESSED, None, max(g0, g1), 2)
    calls = 0

    def wrapped(q):
        nonlocal calls
        calls += 1
        return float(gap_fn(q))

    q = brentq(wrapped, q_min, q_max, xtol=xtol, rtol=4*np.finfo(float).eps, maxiter=100)
    return JounceSolveResult(ContactClass.CONTACT, float(q), float(gap_fn(q)), calls + 2)


def validate_monotone_contact_path(kc: KCRuntimeMap, steer_samples: Iterable[float], *, min_dz_dq: float = 0.05) -> tuple[bool, float]:
    """Validate the local wheel-center z path for a flat-road root solver.

    This is not a universal road-normal proof; it is an offline sanity check for
    the common case where q must move the support point monotonically upward.
    """
    min_seen = float("inf")
    qs = np.linspace(kc.q_axis.lo, kc.q_axis.hi, 101)
    for s in steer_samples:
        for q in qs:
            dz = kc.fields["pz"].eval(float(q), float(s), dq=1)
            min_seen = min(min_seen, dz)
    return min_seen >= min_dz_dq, min_seen


# ---- Massless airborne suspension ------------------------------------------

@dataclass
class LinearMasslessCorner:
    k_s: float
    c_s: float
    q_free: float = 0.0
    q_min: float = -0.08
    q_max: float = 0.08

    def q_spring(self, q: float) -> float:
        return -self.k_s * (q - self.q_free)

    def q_damper(self, qdot: float) -> float:
        return -self.c_s * qdot

    def airborne_step(self, q_n: float, dt: float, q_external: float = 0.0) -> tuple[float, float, str]:
        """Backward-Euler massless airborne step.

        q_external is any known generalized load from internal cross-corner
        elements (e.g. ARB with the other corner treated as known in a GS sweep).
        No road reaction exists in this mode.
        """
        if dt <= 0:
            raise ValueError("dt must be positive")
        if self.c_s <= 0.0:
            # Pure elastic massless limit: no first-order time scale exists.
            q_eq = self.q_free + q_external / self.k_s
            q1 = min(max(q_eq, self.q_min), self.q_max)
            return q1, (q1 - q_n) / dt, "algebraic"
        # Solve 0 = -k(q1-q_free) - c(q1-qn)/dt + q_external.
        denom = self.k_s + self.c_s / dt
        q1 = (self.k_s * self.q_free + (self.c_s / dt) * q_n + q_external) / denom
        q1 = min(max(q1, self.q_min), self.q_max)
        return q1, (q1 - q_n) / dt, "viscous_massless"


@dataclass
class LinearARB:
    k_bar: float       # torsional stiffness in the reduced energy expression
    lever: float       # theta = lever * (q_left - q_right)

    def generalized(self, q_left: float, q_right: float) -> tuple[float, float, float]:
        theta = self.lever * (q_left - q_right)
        ql = -self.k_bar * self.lever * theta
        qr = +self.k_bar * self.lever * theta
        return ql, qr, theta

    def energy(self, q_left: float, q_right: float) -> float:
        theta = self.lever * (q_left - q_right)
        return 0.5 * self.k_bar * theta * theta


def airborne_pair_step(
    left: LinearMasslessCorner,
    right: LinearMasslessCorner,
    arb: LinearARB,
    ql_n: float,
    qr_n: float,
    dt: float,
    *,
    left_contact_q: float | None = None,
    right_contact_q: float | None = None,
    iterations: int = 12,
) -> tuple[float, float]:
    """Small Gauss-Seidel solve for airborne/cross-corner internal equilibrium.

    A contacted corner can be held at its externally solved q while the other
    corner remains airborne. The ARB is never contact-gated.
    """
    ql = ql_n if left_contact_q is None else left_contact_q
    qr = qr_n if right_contact_q is None else right_contact_q
    for _ in range(iterations):
        ql_arb, qr_arb, _ = arb.generalized(ql, qr)
        if left_contact_q is None:
            ql, _, _ = left.airborne_step(ql_n, dt, q_external=ql_arb)
        else:
            ql = left_contact_q
        ql_arb, qr_arb, _ = arb.generalized(ql, qr)
        if right_contact_q is None:
            qr, _, _ = right.airborne_step(qr_n, dt, q_external=qr_arb)
        else:
            qr = right_contact_q
    return ql, qr


# ---- Tire vertical compliance boundary -------------------------------------

@dataclass
class TireVerticalEval:
    fz: float
    dF_ddelta: float
    dF_ddeltadot: float
    active: bool


@dataclass
class TireVerticalLaw:
    k_t: float
    c_t: float = 0.0

    def evaluate(self, delta: float, delta_dot: float) -> TireVerticalEval:
        """Unilateral Kelvin-Voigt normal law with no tensile contact.

        Production code may replace this with a smoother Hunt-Crossley or a
        measured vertical curve. The suspension/contact API only relies on the
        returned Fz and tangents.
        """
        if delta <= 0.0:
            return TireVerticalEval(0.0, 0.0, 0.0, False)
        raw = self.k_t * delta + self.c_t * delta_dot
        if raw <= 0.0:
            return TireVerticalEval(0.0, 0.0, 0.0, False)
        return TireVerticalEval(raw, self.k_t, self.c_t, True)


@dataclass
class VerticalCornerModel:
    mass: float
    gravity: float
    k_s: float
    c_s: float
    tire: TireVerticalLaw
    L: float = 0.55
    R: float = 0.31

    def gap_unloaded(self, z: float, q: float) -> float:
        y_w = z - self.L + q
        return y_w - self.R

    def tire_compression(self, z: float, q: float) -> float:
        return max(0.0, -self.gap_unloaded(z, q))

    def static_from_load(self, target_fz: float) -> tuple[float, float, float]:
        """Return q, delta_t, chassis z for a requested static normal load."""
        q = target_fz / self.k_s
        delta = target_fz / self.tire.k_t
        z = self.R + self.L - q - delta
        return q, delta, z

    def solve_static_at_z(self, z: float) -> tuple[float, float, float]:
        """Solve massless corner equilibrium at fixed chassis z.

        0 = -k_s q + Fz(delta(q)); damping omitted at static equilibrium.
        """
        def residual(q):
            delta = self.tire_compression(z, q)
            fz = self.tire.evaluate(delta, 0.0).fz
            return -self.k_s * q + fz

        # Search a generous but finite suspension interval.
        qlo, qhi = -0.15, 0.15
        rlo, rhi = residual(qlo), residual(qhi)
        if rlo * rhi > 0:
            raise RuntimeError("static corner root not bracketed")
        q = brentq(residual, qlo, qhi)
        delta = self.tire_compression(z, q)
        fz = self.tire.evaluate(delta, 0.0).fz
        return float(q), float(delta), float(fz)

    def step_implicit(self, z0: float, v0: float, q0: float, dt: float) -> tuple[float, float, float, float]:
        """Active-set implicit step for chassis + massless q + vertical tire.

        A generic Newton solve across ``max(0, gap)`` / ``max(0, force)`` is
        fragile at lift-off and touchdown.  This reference instead solves the
        two unilateral modes separately and accepts only a mode that satisfies
        its own inequalities.  For the linear Kelvin-Voigt vertical law the
        contact mode is a 2x2 linear solve.
        """
        if dt <= 0:
            raise ValueError("dt must be positive")

        # --- Candidate 1: airborne (Fz = 0) --------------------------------
        v_air = v0 - dt * self.gravity
        if self.c_s > 0.0:
            q_air = (self.c_s / dt * q0) / (self.k_s + self.c_s / dt)
        else:
            q_air = 0.0
        z_air = z0 + dt * v_air
        gap_air = self.gap_unloaded(z_air, q_air)
        air_valid = gap_air >= -1e-12

        # --- Candidate 2: compressed unilateral tire (Fz > 0, delta > 0) ---
        kt, ct = self.tire.k_t, self.tire.c_t
        D0 = self.R - z0 + self.L
        C0 = kt * D0 + ct * q0 / dt
        Av = -(kt * dt + ct)
        Aq = -(kt + ct / dt)

        A = np.array([
            [1.0 - dt / self.mass * Av, -dt / self.mass * Aq],
            [Av, Aq - self.k_s - self.c_s / dt],
        ], dtype=float)
        b = np.array([
            v0 + dt / self.mass * C0 - dt * self.gravity,
            -C0 - self.c_s / dt * q0,
        ], dtype=float)

        try:
            v_con, q_con = map(float, np.linalg.solve(A, b))
            z_con = z0 + dt * v_con
            qdot_con = (q_con - q0) / dt
            delta_con = -self.gap_unloaded(z_con, q_con)
            delta_dot_con = -(v_con + qdot_con)
            raw_fz = kt * delta_con + ct * delta_dot_con
            contact_valid = delta_con > 1e-12 and raw_fz > 1e-10
        except np.linalg.LinAlgError:
            contact_valid = False
            v_con = q_con = z_con = raw_fz = float("nan")

        # Prefer continuity of contact if both are numerically admissible.
        was_contact = self.gap_unloaded(z0, q0) <= 0.0
        if contact_valid and (was_contact or not air_valid):
            return z_con, v_con, q_con, float(raw_fz)
        if air_valid:
            return z_air, v_air, q_air, 0.0
        if contact_valid:
            return z_con, v_con, q_con, float(raw_fz)

        # This should be rare for the linear reference.  A production solver
        # would bracket the exact touchdown event or substep to it.
        raise RuntimeError(
            f"vertical active-set solve found no admissible mode: "
            f"gap_air={gap_air:.6g}, delta_contact={delta_con:.6g}, Fz_contact={raw_fz:.6g}"
        )

    def step_explicit(self, z0: float, v0: float, q0: float, dt: float) -> tuple[float, float, float, float]:
        """Deliberately simple staggered explicit reference used as a negative control."""
        delta0 = max(0.0, -self.gap_unloaded(z0, q0))
        # For the negative control use the previous-state normal force and ignore
        # unknown end-of-step delta-rate, which is exactly the problematic lag.
        fz0 = self.tire.evaluate(delta0, 0.0).fz
        if self.c_s > 0:
            qdot0 = (fz0 - self.k_s * q0) / self.c_s
        else:
            qdot0 = 0.0
        q1 = q0 + dt * qdot0
        v1 = v0 + dt * (fz0 / self.mass - self.gravity)
        z1 = z0 + dt * v1
        return z1, v1, q1, fz0


# ---- Utilities used by executable validation tests -------------------------

def linear_airborne_exact(q0: float, t: float, k: float, c: float, q_free: float = 0.0) -> float:
    if c <= 0:
        return q_free
    return q_free + (q0 - q_free) * math.exp(-(k / c) * t)


def damper_dissipated_energy(c: float, qdot_samples: np.ndarray, dt: float) -> float:
    qdot_samples = np.asarray(qdot_samples, dtype=float)
    return float(np.sum(c * qdot_samples * qdot_samples) * dt)


def simple_lateral_load_transfer(m: float, ay: float, h: float, track: float) -> float:
    return m * ay * h / track


def quarter_car_modes(ms: float, mu: float, ks: float, kt: float) -> np.ndarray:
    M = np.diag([ms, mu])
    K = np.array([[ks, -ks], [-ks, ks + kt]], dtype=float)
    eig = np.linalg.eigvals(np.linalg.solve(M, K))
    w = np.sqrt(np.sort(np.real(eig)))
    return w / (2.0 * math.pi)


def massless_body_mode(ms: float, ks: float, kt: float) -> float:
    k_eq = ks * kt / (ks + kt)
    return math.sqrt(k_eq / ms) / (2.0 * math.pi)


def additive_compliance_model(q: float, fy: float, mz: float) -> float:
    return 0.10 * q + 2.0e-5 * fy + 1.5e-4 * mz


def coupled_compliance_truth(q: float, fy: float, mz: float) -> float:
    # Deliberate cross-term used to prove where additive K&C stops being exact.
    return additive_compliance_model(q, fy, mz) + 1.2e-8 * fy * mz


def raw_spline_outside_domain_inconsistency() -> tuple[float, float, float, float]:
    """Demonstrate why raw spline extrapolation semantics must not be implicit."""
    q = np.linspace(-0.1, 0.1, 5)
    s = np.linspace(-0.5, 0.5, 5)
    vals = np.outer(q**3, np.ones_like(s))
    sp = RectBivariateSpline(q, s, vals, kx=3, ky=3, s=0)
    x = 0.14
    value_out = float(sp.ev(x, 0.0))
    value_edge = float(sp.ev(0.1, 0.0))
    deriv_out = float(sp.ev(x, 0.0, dx=1))
    deriv_edge = float(sp.ev(0.1, 0.0, dx=1))
    return value_out, value_edge, deriv_out, deriv_edge


def cubic_monotonicity_counterexample() -> tuple[float, float]:
    """Return minimum derivatives for natural cubic vs monotone PCHIP.

    The samples are monotone, but an unconstrained cubic spline acquires a
    negative derivative between knots. This is a real failure mode for a
    contact-critical wheel path if such a spline is accepted without QA.
    """
    x = np.array([0.0, 1.0, 2.0, 3.0])
    y = np.array([0.0, 1.0, 1.01, 2.0])
    xx = np.linspace(0.0, 3.0, 1001)
    cs = CubicSpline(x, y)
    pc = PchipInterpolator(x, y)
    return float(np.min(cs(xx, 1))), float(np.min(pc(xx, 1)))


def bilinear_derivative_jump() -> tuple[float, float]:
    """Measure derivative jump at a cell boundary for linear vs cubic interpolation."""
    q = np.array([-0.10, -0.05, 0.0, 0.05, 0.10])
    s = np.array([-0.5, 0.0, 0.5, 1.0])
    vals = np.empty((len(q), len(s)))
    for i, x in enumerate(q):
        vals[i, :] = 10.0 * x * x
    lin = RegularGridInterpolator((q, s), vals, method="linear", bounds_error=True)
    cub = RectBivariateSpline(q, s, vals, kx=3, ky=3, s=0)
    eps = 1e-6
    h = 1e-5
    def fd_linear(x):
        return float((lin([[x+h, 0.2]])[0] - lin([[x-h, 0.2]])[0]) / (2*h))
    dl = fd_linear(-eps)
    dr = fd_linear(+eps)
    linear_jump = abs(dr - dl)
    cubic_jump = abs(float(cub.ev(-eps, 0.2, dx=1)) - float(cub.ev(+eps, 0.2, dx=1)))
    return linear_jump, cubic_jump
