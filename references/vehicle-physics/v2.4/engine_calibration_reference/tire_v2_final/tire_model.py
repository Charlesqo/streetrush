"""Tire V2 reference constitutive model.

The code is intentionally small enough to audit.  It is not a production tire
library and its sample parameters do not represent a named real tire.

Coordinate/sign convention
--------------------------
Contact frame: +x wheel-forward, +y left, +z road-normal.  Positive wheel
spin is about +y, so a freely rolling forward wheel has ``R_eff * omega = Vx``.
The raw longitudinal slip velocity is ``u_x = R_eff*omega - Vx``.  Forces are
on the wheel: drive force follows ``u_x`` and lateral force opposes ``Vy``.
For steady states whose force follows the current slip, the contact power
``-Fx*u_x + Fy*Vy + My*omega`` is non-positive.  A transient elastic state may
return stored energy during unloading, so instantaneous contact power may then
be positive; a closed state cycle must still have non-positive net work.

The steady law is inspired by the generalized-slip construction used by
TMeasy: load-dependent pure-axis curve parameters are combined in the current
slip direction before a single force magnitude is evaluated.  This is not a
copy of a commercial implementation and is not claimed to be TMeasy itself.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from math import atan2, exp, hypot, isfinite, pi, tanh


EPS = 1.0e-12


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def smoothstep01(x: float) -> float:
    x = clamp(x, 0.0, 1.0)
    return x * x * (3.0 - 2.0 * x)


@dataclass(frozen=True)
class AxisCurve:
    """Five physically legible parameters for one pure-slip characteristic."""

    initial_slope_n: float
    peak_slip: float
    peak_force_n: float
    slide_slip: float
    slide_force_n: float

    def validate(self) -> None:
        assert self.initial_slope_n > 0.0
        assert 0.0 < self.peak_slip < self.slide_slip
        assert 0.0 < self.slide_force_n <= self.peak_force_n


@dataclass(frozen=True)
class AligningCurve:
    """Pneumatic-trail characteristic for a given vertical load."""

    trail_at_zero_m: float
    characteristic_slip: float
    end_slip: float

    def validate(self) -> None:
        assert self.trail_at_zero_m >= 0.0
        assert 0.0 < self.characteristic_slip < self.end_slip


@dataclass(frozen=True)
class TireParams:
    unloaded_radius_m: float
    width_m: float
    reference_load_n: float
    max_model_load_n: float

    longitudinal_at_ref: AxisCurve
    longitudinal_at_2ref: AxisCurve
    lateral_at_ref: AxisCurve
    lateral_at_2ref: AxisCurve
    aligning_at_ref: AligningCurve
    aligning_at_2ref: AligningCurve

    camber_stiffness_ref_n_per_rad: float
    camber_stiffness_2ref_n_per_rad: float
    camber_limit_rad: float
    overturning_arm_per_rad_m: float

    relaxation_length_x_m: float
    relaxation_length_y_m: float
    relaxation_length_camber_m: float
    state_slip_limit: float
    air_state_decay_s: float
    air_state_reset_s: float

    rolling_resistance_coefficient: float
    rolling_resistance_omega_smooth_radps: float
    nominal_surface_mu: float
    min_surface_mu_scale: float
    max_surface_mu_scale: float

    vertical_stiffness_1_n_per_m: float
    vertical_stiffness_2_n_per_m2: float
    vertical_damping_n_s_per_m: float

    def validate(self) -> None:
        assert self.unloaded_radius_m > 0.0
        assert self.width_m > 0.0
        assert self.reference_load_n > 0.0
        assert self.max_model_load_n >= 2.0 * self.reference_load_n
        self.longitudinal_at_ref.validate()
        self.longitudinal_at_2ref.validate()
        self.lateral_at_ref.validate()
        self.lateral_at_2ref.validate()
        self.aligning_at_ref.validate()
        self.aligning_at_2ref.validate()
        assert self.camber_stiffness_ref_n_per_rad >= 0.0
        assert self.camber_stiffness_2ref_n_per_rad >= 0.0
        assert 0.0 < self.camber_limit_rad < pi / 2.0
        assert self.relaxation_length_x_m > 0.0
        assert self.relaxation_length_y_m > 0.0
        assert self.relaxation_length_camber_m > 0.0
        assert self.state_slip_limit > 0.0
        assert self.air_state_decay_s > 0.0
        assert self.air_state_reset_s >= self.air_state_decay_s
        assert self.rolling_resistance_omega_smooth_radps > 0.0
        assert self.nominal_surface_mu > 0.0
        assert 0.0 < self.min_surface_mu_scale <= self.max_surface_mu_scale
        assert self.vertical_stiffness_1_n_per_m > 0.0
        assert self.vertical_stiffness_2_n_per_m2 >= 0.0
        assert self.vertical_damping_n_s_per_m >= 0.0


@dataclass(frozen=True)
class ContactInput:
    """Backend-neutral tire input for one physics substep.

    ``velocity_x_mps`` and ``velocity_y_mps`` are wheel/contact-carrier
    translational velocities relative to the road, resolved in the final tire
    contact frame.  Spin is supplied separately; do not pre-subtract it.
    """

    in_contact: bool
    normal_load_n: float
    velocity_x_mps: float
    velocity_y_mps: float
    wheel_omega_radps: float
    camber_rad: float
    dt_s: float
    loaded_radius_m: float | None = None
    effective_radius_m: float | None = None
    surface_mu_x: float = 1.0
    surface_mu_y: float = 1.0


@dataclass(frozen=True)
class TireState:
    """Canonical tire-owned transient state, committed exactly once per step.

    Lateral sideslip and camber deformation are deliberately separate.  Tire
    measurements can show a much shorter camber-force lag than the sideslip
    relaxation length, so forcing both effects through one state is not a
    neutral simplification.
    """

    relaxed_slip_x: float = 0.0
    relaxed_slip_y: float = 0.0
    air_time_s: float = 0.0
    relaxed_camber_slip: float = 0.0


@dataclass(frozen=True)
class TireOutput:
    force_x_n: float
    force_y_n: float
    force_z_n: float
    moment_x_nm: float
    moment_y_nm: float
    moment_z_nm: float
    effective_radius_m: float
    wheel_contact_torque_nm: float
    raw_slip_velocity_x_mps: float
    raw_slip_velocity_y_mps: float
    transport_speed_mps: float
    kappa_observable: float
    alpha_observable_rad: float
    model_slip_x: float
    model_slip_y: float
    model_camber_slip: float
    pneumatic_trail_m: float
    contact_power_w: float
    gross_contact_loss_proxy_w: float
    force_utilization: float
    state_next: TireState


@dataclass(frozen=True)
class VerticalLawOutput:
    force_z_n: float
    dforce_dcompression_n_per_m: float
    dforce_dcompression_rate_n_s_per_m: float
    active: bool


def _quadratic_zero_load(value_ref: float, value_2ref: float, q: float) -> float:
    """Quadratic through (0,0), (1,value_ref), (2,value_2ref)."""

    return (2.0 * value_ref - 0.5 * value_2ref) * q + (0.5 * value_2ref - value_ref) * q * q


def _linear_load(value_ref: float, value_2ref: float, q: float) -> float:
    return value_ref + (q - 1.0) * (value_2ref - value_ref)


def _interpolate_axis(a: AxisCurve, b: AxisCurve, q: float) -> AxisCurve:
    result = AxisCurve(
        initial_slope_n=max(0.0, _quadratic_zero_load(a.initial_slope_n, b.initial_slope_n, q)),
        peak_slip=max(EPS, _linear_load(a.peak_slip, b.peak_slip, q)),
        peak_force_n=max(0.0, _quadratic_zero_load(a.peak_force_n, b.peak_force_n, q)),
        slide_slip=max(EPS, _linear_load(a.slide_slip, b.slide_slip, q)),
        slide_force_n=max(0.0, _quadratic_zero_load(a.slide_force_n, b.slide_force_n, q)),
    )
    if result.slide_slip <= result.peak_slip:
        result = replace(result, slide_slip=result.peak_slip + 1.0e-6)
    if result.slide_force_n > result.peak_force_n:
        result = replace(result, slide_force_n=result.peak_force_n)
    return result


def _pure_curve_magnitude(slip: float, curve: AxisCurve) -> float:
    """C1 curve from origin to peak, then to sliding plateau."""

    s = abs(slip)
    if s <= 0.0 or curve.peak_force_n <= 0.0:
        return 0.0
    k = max(curve.initial_slope_n, 2.0 * curve.peak_force_n / curve.peak_slip)
    if s < curve.peak_slip:
        sn = s / curve.peak_slip
        p = k * curve.peak_slip / curve.peak_force_n - 2.0
        denominator = 1.0 + (sn + p) * sn
        return k * curve.peak_slip * sn / denominator
    if s < curve.slide_slip:
        t = (s - curve.peak_slip) / (curve.slide_slip - curve.peak_slip)
        return curve.peak_force_n + (curve.slide_force_n - curve.peak_force_n) * smoothstep01(t)
    return curve.slide_force_n


def _travel_sign(vx: float, rolling_speed: float) -> float:
    transport = vx if abs(vx) >= abs(rolling_speed) else rolling_speed
    if transport > 1.0e-8:
        return 1.0
    if transport < -1.0e-8:
        return -1.0
    return 0.0


class TireModel:
    """Backend-neutral Tire V2 force element and vertical-law option."""

    def __init__(self, params: TireParams):
        params.validate()
        self.params = params

    def effective_radius(self, inp: ContactInput) -> float:
        if inp.effective_radius_m is not None:
            return clamp(inp.effective_radius_m, 0.5 * self.params.unloaded_radius_m, self.params.unloaded_radius_m)
        if inp.loaded_radius_m is None:
            return self.params.unloaded_radius_m
        loaded = clamp(inp.loaded_radius_m, 0.5 * self.params.unloaded_radius_m, self.params.unloaded_radius_m)
        # Empirical rolling-radius bridge used by several handling models.
        return (2.0 * self.params.unloaded_radius_m + loaded) / 3.0

    def vertical_law(self, compression_m: float, compression_rate_mps: float) -> VerticalLawOutput:
        """Optional COMPLIANT_TIRE_VERTICAL route; never combine with rigid g=0."""

        if compression_m <= 0.0:
            return VerticalLawOutput(0.0, 0.0, 0.0, False)
        p = self.params
        elastic = p.vertical_stiffness_1_n_per_m * compression_m
        elastic += p.vertical_stiffness_2_n_per_m2 * compression_m * compression_m
        raw = elastic + p.vertical_damping_n_s_per_m * compression_rate_mps
        if raw <= 0.0:
            return VerticalLawOutput(0.0, 0.0, 0.0, False)
        tangent = p.vertical_stiffness_1_n_per_m + 2.0 * p.vertical_stiffness_2_n_per_m2 * compression_m
        return VerticalLawOutput(raw, tangent, p.vertical_damping_n_s_per_m, True)

    def load_curves(self, normal_load_n: float, mu_x: float = 1.0, mu_y: float = 1.0) -> tuple[AxisCurve, AxisCurve]:
        p = self.params
        model_load = clamp(normal_load_n, 0.0, p.max_model_load_n)
        q = model_load / p.reference_load_n
        x = _interpolate_axis(p.longitudinal_at_ref, p.longitudinal_at_2ref, q)
        y = _interpolate_axis(p.lateral_at_ref, p.lateral_at_2ref, q)

        sx = clamp(mu_x / p.nominal_surface_mu, p.min_surface_mu_scale, p.max_surface_mu_scale)
        sy = clamp(mu_y / p.nominal_surface_mu, p.min_surface_mu_scale, p.max_surface_mu_scale)
        # Carcass stiffness is retained; force level and the slip at which the
        # peak/plateau occurs follow available road friction.
        x = replace(
            x,
            peak_slip=x.peak_slip * sx,
            peak_force_n=x.peak_force_n * sx,
            slide_slip=x.slide_slip * sx,
            slide_force_n=x.slide_force_n * sx,
        )
        y = replace(
            y,
            peak_slip=y.peak_slip * sy,
            peak_force_n=y.peak_force_n * sy,
            slide_slip=y.slide_slip * sy,
            slide_force_n=y.slide_force_n * sy,
        )
        return x, y

    def camber_equivalent_slip(self, normal_load_n: float, gamma_rad: float, lateral: AxisCurve) -> float:
        p = self.params
        q = clamp(normal_load_n, 0.0, p.max_model_load_n) / p.reference_load_n
        c_gamma = max(
            0.0,
            _quadratic_zero_load(
                p.camber_stiffness_ref_n_per_rad,
                p.camber_stiffness_2ref_n_per_rad,
                q,
            ),
        )
        gamma = clamp(gamma_rad, -p.camber_limit_rad, p.camber_limit_rad)
        return c_gamma * gamma / max(lateral.initial_slope_n, EPS)

    def _combined_force(
        self,
        slip_x: float,
        slip_y: float,
        normal_load_n: float,
        mu_x: float,
        mu_y: float,
    ) -> tuple[float, float, float, AxisCurve, AxisCurve]:
        xcurve, ycurve = self.load_curves(normal_load_n, mu_x, mu_y)
        s = hypot(slip_x, slip_y)
        if s <= EPS or normal_load_n <= 0.0:
            return 0.0, 0.0, 0.0, xcurve, ycurve
        cx = slip_x / s
        cy = slip_y / s
        directional = AxisCurve(
            initial_slope_n=hypot(xcurve.initial_slope_n * cx, ycurve.initial_slope_n * cy),
            peak_slip=hypot(xcurve.peak_slip * cx, ycurve.peak_slip * cy),
            peak_force_n=hypot(xcurve.peak_force_n * cx, ycurve.peak_force_n * cy),
            slide_slip=hypot(xcurve.slide_slip * cx, ycurve.slide_slip * cy),
            slide_force_n=hypot(xcurve.slide_force_n * cx, ycurve.slide_force_n * cy),
        )
        magnitude = _pure_curve_magnitude(s, directional)
        utilization = magnitude / max(directional.peak_force_n, EPS)
        return magnitude * cx, magnitude * cy, utilization, xcurve, ycurve

    def _aligning_params(self, normal_load_n: float) -> AligningCurve:
        p = self.params
        q = clamp(normal_load_n, 0.0, p.max_model_load_n) / p.reference_load_n
        a, b = p.aligning_at_ref, p.aligning_at_2ref
        result = AligningCurve(
            trail_at_zero_m=max(0.0, _linear_load(a.trail_at_zero_m, b.trail_at_zero_m, q)),
            characteristic_slip=max(EPS, _linear_load(a.characteristic_slip, b.characteristic_slip, q)),
            end_slip=max(EPS, _linear_load(a.end_slip, b.end_slip, q)),
        )
        if result.end_slip <= result.characteristic_slip:
            result = replace(result, end_slip=result.characteristic_slip + 1.0e-6)
        return result

    def pneumatic_trail(self, slip_x: float, slip_y: float, normal_load_n: float, xcurve: AxisCurve) -> float:
        a = self._aligning_params(normal_load_n)
        sy = abs(slip_y)
        if sy >= a.end_slip:
            base = 0.0
        elif sy <= a.characteristic_slip:
            sn = sy / a.characteristic_slip
            weight = a.characteristic_slip / a.end_slip
            linear = a.trail_at_zero_m * (1.0 - sn)
            cubic = a.trail_at_zero_m * (1.0 - smoothstep01(sn))
            base = (1.0 - weight) * linear + weight * cubic
        else:
            remaining = (a.end_slip - sy) / (a.end_slip - a.characteristic_slip)
            weight = a.characteristic_slip / a.end_slip
            base = (
                -a.trail_at_zero_m
                * (1.0 - weight)
                * (sy - a.characteristic_slip)
                / a.characteristic_slip
                * remaining
                * remaining
            )
        # Longitudinal demand shifts the lateral pressure resultant forward.
        reduction = 1.0 / (1.0 + (abs(slip_x) / max(xcurve.peak_slip, EPS)) ** 2)
        return base * reduction

    def _project_state(self, sx: float, sy: float) -> tuple[float, float]:
        length = hypot(sx, sy)
        limit = self.params.state_slip_limit
        if length > limit:
            scale = limit / length
            return sx * scale, sy * scale
        return sx, sy

    def _project_transient_state(
        self, sx: float, sy: float, s_gamma: float
    ) -> tuple[float, float, float]:
        """Bound both the constitutive total and its decomposed state parts.

        A bound on ``sy + s_gamma`` alone would allow two large cancelling
        hidden states which could reappear as an impulse after an input change.
        All components therefore receive one common scale factor.
        """

        measure = max(hypot(sx, sy + s_gamma), abs(sx), abs(sy), abs(s_gamma))
        limit = self.params.state_slip_limit
        if measure > limit:
            scale = limit / measure
            return sx * scale, sy * scale, s_gamma * scale
        return sx, sy, s_gamma

    @staticmethod
    def _advance_relaxed_state(state: float, slip_velocity_mps: float, transport_mps: float, length_m: float, dt_s: float) -> float:
        """Exact frozen-input update of L*s_dot + |V|*s = u.

        At V=0 this becomes a tread-deflection update ``s += u*dt/L``;
        there is no division by a regularized vehicle speed.
        """

        if dt_s <= 0.0:
            return state
        if transport_mps <= 1.0e-9:
            return state + slip_velocity_mps * dt_s / length_m
        target = slip_velocity_mps / transport_mps
        decay = exp(-transport_mps * dt_s / length_m)
        return target + (state - target) * decay

    def evaluate_from_model_slips(
        self,
        slip_x: float,
        slip_y: float,
        normal_load_n: float,
        camber_rad: float = 0.0,
        mu_x: float = 1.0,
        mu_y: float = 1.0,
        travel_sign: float = 1.0,
        omega_radps: float = 0.0,
    ) -> tuple[float, float, float, float, float, float]:
        """Stateless constitutive evaluation used by solvers and tests.

        Returns ``Fx, Fy, Mx, My, Mz, utilization``.  Camber should normally be
        included while advancing the dynamic lateral state; this helper adds its
        steady equivalent directly for algebraic calls.
        """

        _, ycurve = self.load_curves(normal_load_n, mu_x, mu_y)
        sy_total = slip_y + self.camber_equivalent_slip(normal_load_n, camber_rad, ycurve)
        fx, fy, utilization, xcurve, _ = self._combined_force(slip_x, sy_total, normal_load_n, mu_x, mu_y)
        trail = self.pneumatic_trail(slip_x, sy_total, normal_load_n, xcurve)
        mz = -travel_sign * trail * fy
        mx = -normal_load_n * self.params.overturning_arm_per_rad_m * clamp(
            camber_rad, -self.params.camber_limit_rad, self.params.camber_limit_rad
        )
        my = (
            -self.params.rolling_resistance_coefficient
            * normal_load_n
            * self.params.unloaded_radius_m
            * tanh(omega_radps / self.params.rolling_resistance_omega_smooth_radps)
        )
        return fx, fy, mx, my, mz, utilization

    def step(self, state: TireState, inp: ContactInput) -> TireOutput:
        p = self.params
        assert inp.dt_s >= 0.0
        values = (
            inp.normal_load_n,
            inp.velocity_x_mps,
            inp.velocity_y_mps,
            inp.wheel_omega_radps,
            inp.camber_rad,
            inp.dt_s,
            inp.surface_mu_x,
            inp.surface_mu_y,
        )
        assert all(isfinite(v) for v in values)

        radius = self.effective_radius(inp)
        rolling_speed = radius * inp.wheel_omega_radps
        ux = rolling_speed - inp.velocity_x_mps
        uy = -inp.velocity_y_mps
        transport = max(abs(inp.velocity_x_mps), abs(rolling_speed))
        observable_ref = max(transport, 0.05)
        kappa = ux / observable_ref
        alpha = atan2(-inp.velocity_y_mps, observable_ref)

        if (not inp.in_contact) or inp.normal_load_n <= 0.0:
            air_time = state.air_time_s + inp.dt_s
            decay = exp(-inp.dt_s / p.air_state_decay_s) if inp.dt_s > 0.0 else 1.0
            sx = state.relaxed_slip_x * decay
            sy = state.relaxed_slip_y * decay
            s_gamma = state.relaxed_camber_slip * decay
            if air_time >= p.air_state_reset_s:
                sx = 0.0
                sy = 0.0
                s_gamma = 0.0
            sy_total = sy + s_gamma
            next_state = TireState(
                relaxed_slip_x=sx,
                relaxed_slip_y=sy,
                air_time_s=air_time,
                relaxed_camber_slip=s_gamma,
            )
            return TireOutput(
                force_x_n=0.0,
                force_y_n=0.0,
                force_z_n=0.0,
                moment_x_nm=0.0,
                moment_y_nm=0.0,
                moment_z_nm=0.0,
                effective_radius_m=radius,
                wheel_contact_torque_nm=0.0,
                raw_slip_velocity_x_mps=ux,
                raw_slip_velocity_y_mps=uy,
                transport_speed_mps=transport,
                kappa_observable=kappa,
                alpha_observable_rad=alpha,
                model_slip_x=sx,
                model_slip_y=sy_total,
                model_camber_slip=s_gamma,
                pneumatic_trail_m=0.0,
                contact_power_w=0.0,
                gross_contact_loss_proxy_w=0.0,
                force_utilization=0.0,
                state_next=next_state,
            )

        xcurve, ycurve = self.load_curves(inp.normal_load_n, inp.surface_mu_x, inp.surface_mu_y)
        camber_slip_target = self.camber_equivalent_slip(inp.normal_load_n, inp.camber_rad, ycurve)
        sx = self._advance_relaxed_state(
            state.relaxed_slip_x, ux, transport, p.relaxation_length_x_m, inp.dt_s
        )
        sy = self._advance_relaxed_state(
            state.relaxed_slip_y, uy, transport, p.relaxation_length_y_m, inp.dt_s
        )
        # Camber thrust is generated by rolling contact-patch transport, but it
        # has its own (usually much shorter) distance-domain lag.  Using |V|
        # preserves ideal camber/conicity force direction in reverse.
        s_gamma = self._advance_relaxed_state(
            state.relaxed_camber_slip,
            transport * camber_slip_target,
            transport,
            p.relaxation_length_camber_m,
            inp.dt_s,
        )
        sx, sy, s_gamma = self._project_transient_state(sx, sy, s_gamma)
        sy_total = sy + s_gamma

        fx, fy, utilization, xcurve, _ = self._combined_force(
            sx, sy_total, inp.normal_load_n, inp.surface_mu_x, inp.surface_mu_y
        )
        trail = self.pneumatic_trail(sx, sy_total, inp.normal_load_n, xcurve)
        direction = _travel_sign(inp.velocity_x_mps, rolling_speed)
        mz = -direction * trail * fy
        mx = -inp.normal_load_n * p.overturning_arm_per_rad_m * clamp(
            inp.camber_rad, -p.camber_limit_rad, p.camber_limit_rad
        )
        my = (
            -p.rolling_resistance_coefficient
            * inp.normal_load_n
            * p.unloaded_radius_m
            * tanh(inp.wheel_omega_radps / p.rolling_resistance_omega_smooth_radps)
        )
        wheel_torque = -radius * fx + my
        total_contact_power = -fx * ux + fy * inp.velocity_y_mps + my * inp.wheel_omega_radps
        # This is useful telemetry but is not irreversible heat when transient
        # elastic storage is active; production thermal models must separate
        # storage-rate and dissipation terms.
        gross_loss_proxy = max(0.0, -total_contact_power)
        next_state = TireState(
            relaxed_slip_x=sx,
            relaxed_slip_y=sy,
            air_time_s=0.0,
            relaxed_camber_slip=s_gamma,
        )
        return TireOutput(
            force_x_n=fx,
            force_y_n=fy,
            force_z_n=inp.normal_load_n,
            moment_x_nm=mx,
            moment_y_nm=my,
            moment_z_nm=mz,
            effective_radius_m=radius,
            wheel_contact_torque_nm=wheel_torque,
            raw_slip_velocity_x_mps=ux,
            raw_slip_velocity_y_mps=uy,
            transport_speed_mps=transport,
            kappa_observable=kappa,
            alpha_observable_rad=alpha,
            model_slip_x=sx,
            model_slip_y=sy_total,
            model_camber_slip=s_gamma,
            pneumatic_trail_m=trail,
            contact_power_w=total_contact_power,
            gross_contact_loss_proxy_w=gross_loss_proxy,
            force_utilization=utilization,
            state_next=next_state,
        )

    def force_jacobian_wrt_model_slips(
        self,
        slip_x: float,
        slip_y: float,
        normal_load_n: float,
        mu_x: float = 1.0,
        mu_y: float = 1.0,
        epsilon: float = 1.0e-6,
    ) -> tuple[tuple[float, float], tuple[float, float]]:
        """Reference finite-difference tangent; production should use AD/analytic."""

        def force(x: float, y: float) -> tuple[float, float]:
            fx, fy, *_ = self.evaluate_from_model_slips(x, y, normal_load_n, 0.0, mu_x, mu_y)
            return fx, fy

        fxp, fyp = force(slip_x + epsilon, slip_y)
        fxm, fym = force(slip_x - epsilon, slip_y)
        dfx_dx = (fxp - fxm) / (2.0 * epsilon)
        dfy_dx = (fyp - fym) / (2.0 * epsilon)
        fxp, fyp = force(slip_x, slip_y + epsilon)
        fxm, fym = force(slip_x, slip_y - epsilon)
        dfx_dy = (fxp - fxm) / (2.0 * epsilon)
        dfy_dy = (fyp - fym) / (2.0 * epsilon)
        return ((dfx_dx, dfx_dy), (dfy_dx, dfy_dy))


def make_reference_params() -> TireParams:
    """Plausible synthetic 225/45R18-class parameters for structure tests only."""

    return TireParams(
        unloaded_radius_m=0.326,
        width_m=0.225,
        reference_load_n=4000.0,
        max_model_load_n=14000.0,
        longitudinal_at_ref=AxisCurve(120000.0, 0.11, 4400.0, 0.50, 4200.0),
        longitudinal_at_2ref=AxisCurve(200000.0, 0.10, 8000.0, 0.70, 7400.0),
        lateral_at_ref=AxisCurve(85000.0, 0.14, 4200.0, 0.55, 3900.0),
        lateral_at_2ref=AxisCurve(135000.0, 0.16, 7400.0, 0.75, 6800.0),
        aligning_at_ref=AligningCurve(0.045, 0.12, 0.32),
        aligning_at_2ref=AligningCurve(0.052, 0.14, 0.36),
        camber_stiffness_ref_n_per_rad=9500.0,
        camber_stiffness_2ref_n_per_rad=15500.0,
        camber_limit_rad=12.0 * pi / 180.0,
        overturning_arm_per_rad_m=0.018,
        relaxation_length_x_m=0.34,
        relaxation_length_y_m=0.46,
        relaxation_length_camber_m=0.04,
        state_slip_limit=1.5,
        air_state_decay_s=0.04,
        air_state_reset_s=0.20,
        rolling_resistance_coefficient=0.012,
        rolling_resistance_omega_smooth_radps=1.0,
        nominal_surface_mu=1.0,
        min_surface_mu_scale=0.08,
        max_surface_mu_scale=1.60,
        vertical_stiffness_1_n_per_m=185000.0,
        vertical_stiffness_2_n_per_m2=850000.0,
        vertical_damping_n_s_per_m=1800.0,
    )
