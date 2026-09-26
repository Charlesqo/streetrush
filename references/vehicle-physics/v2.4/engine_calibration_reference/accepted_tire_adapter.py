"""Accepted Tire V2 v1.7/v1.8 policy behind the unified host contract.

The v2.2 unified fixture originally called ``tire_v2_final`` directly.  That
model has a useful full-wrench host shape, but its airborne and standstill
state semantics predate the accepted v1.8 policy.  This adapter keeps the host
shape while delegating constitutive force/Mz work to the accepted v1.7 model
and transient state work to v1.8.

The low-speed friction-contact solver remains available in v1.7, but it needs
the world's free contact velocity and Delassus response.  A reduced vehicle
fixture must not fabricate those values.  Therefore this adapter raises a
typed capability error at that seam; a game/world adapter can provide the
reaction and use the v1.7 handoff helpers without running two tire-force paths
at once.
"""

from __future__ import annotations

from dataclasses import dataclass
import math

from .tire_host_contract import ContactInput, VerticalLawOutput
from . import tire_v2_reference_v1_7 as v17
from . import tire_v2_reference_v1_8 as v18


class FrictionContactHostRequired(RuntimeError):
    """The accepted low-speed mode needs a world contact response operator."""


TireState = v18.TireTransientStateV18


@dataclass(frozen=True)
class TireOutput:
    """Full host-facing output with an accepted v1.8 canonical state."""

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
    regime: v17.TireMode
    state_was_bounded: bool
    load_was_clamped: bool


class TireModel:
    """Host adapter for accepted v1.7 steady/Mz and v1.8 transient policy."""

    def __init__(
        self,
        params: v17.TireV2Params | None = None,
        transient_policy: v18.TireTransientPolicyV18 | None = None,
        regime_policy: v17.TireRegimePolicy | None = None,
    ):
        self.params = params or v17.synthetic_passenger_tire()
        self.transient_policy = transient_policy or v18.TireTransientPolicyV18()
        self.regime_policy = regime_policy or v17.TireRegimePolicy()
        self.transient_policy.validate()

    @property
    def unloaded_radius_m(self) -> float:
        return self.params.R0

    def vertical_law(self, compression_m: float, compression_rate_mps: float) -> VerticalLawOutput:
        out = v17.tire_vertical_law(self.params, compression_m, compression_rate_mps)
        return VerticalLawOutput(
            force_z_n=out.fz,
            dforce_dcompression_n_per_m=out.dF_dcompression,
            dforce_dcompression_rate_n_s_per_m=out.dF_dcompression_rate,
            active=out.active,
        )

    def compression_for_load(self, load_n: float) -> float:
        """Invert the accepted vertical law at zero compression rate."""

        if load_n <= 0.0:
            return 0.0
        a = self.params.vertical_k2
        b = self.params.vertical_k1
        if a <= 0.0:
            return load_n / b
        return (-b + math.sqrt(b * b + 4.0 * a * load_n)) / (2.0 * a)

    def effective_radius(
        self,
        normal_load_n: float,
        wheel_omega_radps: float,
        loaded_radius_m: float | None = None,
    ) -> float:
        compression = None
        if loaded_radius_m is not None:
            compression = max(0.0, self.params.R0 - loaded_radius_m)
        return v17.effective_radius(
            self.params,
            vertical_compression=compression,
            fz=normal_load_n,
            omega=wheel_omega_radps,
        )

    @staticmethod
    def _zero_output(radius_m: float, state: TireState) -> TireOutput:
        return TireOutput(
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            radius_m,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            state.sx,
            state.sy,
            state.sgamma,
            0.0,
            0.0,
            0.0,
            0.0,
            state,
            state.mode,
            False,
            False,
        )

    def step(self, state: TireState, inp: ContactInput) -> TireOutput:
        if inp.dt_s <= 0.0:
            raise ValueError("dt_s must be positive")
        vertical_compression = None
        if inp.loaded_radius_m is not None:
            vertical_compression = max(0.0, self.params.R0 - inp.loaded_radius_m)
        radius = self.effective_radius(
            inp.normal_load_n,
            inp.wheel_omega_radps,
            inp.loaded_radius_m,
        )
        if inp.effective_radius_m is not None and not math.isclose(
            inp.effective_radius_m,
            radius,
            rel_tol=2.0e-12,
            abs_tol=2.0e-12,
        ):
            raise ValueError(
                "host/Tire effective-radius mismatch: geometry and constitutive paths "
                "must consume one same-step radius"
            )

        if not inp.in_contact or inp.normal_load_n <= 0.0:
            # Final normal classification owns contact loss.  Patch shear
            # memory clears immediately; it is not an airborne belt state.
            airborne = TireState(0.0, 0.0, 0.0, v17.TireMode.AIRBORNE)
            return self._zero_output(radius, airborne)

        if not math.isclose(inp.surface_mu_x, inp.surface_mu_y, rel_tol=1.0e-10, abs_tol=1.0e-12):
            raise ValueError("accepted v1.7 characteristic uses one tangential surface-mu scale")
        mu = float(inp.surface_mu_x)
        transport = abs(inp.wheel_omega_radps * radius)
        regime = v17.select_tire_mode(
            state.mode,
            True,
            inp.velocity_x_mps,
            transport,
            self.regime_policy,
        )
        if regime is v17.TireMode.FRICTION_CONTACT:
            raise FrictionContactHostRequired(
                "FRICTION_CONTACT_HOST_REQUIRED: provide the world's free contact velocity "
                "and Delassus response; do not run handling force and contact reaction together"
            )

        kin = v17.handling_kinematics(
            inp.velocity_x_mps,
            inp.velocity_y_mps,
            inp.wheel_omega_radps,
            radius,
        )
        trial = v18.handling_trial_state_v18(
            self.params,
            inp.normal_load_n,
            state,
            kin.sx_inst,
            kin.sy_inst,
            inp.camber_rad,
            kin.travel_speed,
            inp.dt_s,
            self.transient_policy.camber,
        )
        # EMPIRICAL_RELAXATION_BOUNDED names the *validated operating
        # envelope*, not a plastic return map.  xi remains a relaxed
        # kinematic coordinate across load/mu changes; projecting it to the
        # current peak/slide set would silently turn it into bristle state.
        state_was_bounded = False
        accepted = v18.evaluate_state_v18(
            self.params,
            inp.normal_load_n,
            trial,
            inp.camber_rad,
            mu,
            inp.wheel_omega_radps,
            vertical_compression,
        )
        # Power of the complete road/tire wrench on the vehicle + wheel DOFs.
        # With u_long = R*omega-v_long and u_lat = -v_lat, the force terms are
        # -F.u.  Rolling resistance is a separate wheel-spin torque and must
        # appear once in the same ledger.
        contact_power = (
            -accepted.Fx * kin.u_long
            - accepted.Fy * kin.u_lat
            + accepted.rolling_resistance_torque * inp.wheel_omega_radps
        )
        c, _ = self.params.load_map.evaluate(inp.normal_load_n)
        peak_x = max(mu * c.fx_peak, 1.0e-12)
        peak_y = max(mu * c.fy_peak, 1.0e-12)
        utilization = math.sqrt((accepted.Fx / peak_x) ** 2 + (accepted.Fy / peak_y) ** 2)
        return TireOutput(
            force_x_n=accepted.Fx,
            force_y_n=accepted.Fy,
            force_z_n=inp.normal_load_n,
            moment_x_nm=accepted.Mx,
            moment_y_nm=accepted.rolling_resistance_torque,
            moment_z_nm=accepted.Mz,
            effective_radius_m=accepted.R_eff,
            wheel_contact_torque_nm=-accepted.R_eff * accepted.Fx + accepted.rolling_resistance_torque,
            raw_slip_velocity_x_mps=kin.u_long,
            raw_slip_velocity_y_mps=kin.u_lat,
            transport_speed_mps=kin.travel_speed,
            kappa_observable=kin.sx_inst,
            alpha_observable_rad=math.atan(kin.sy_inst),
            model_slip_x=trial.sx,
            model_slip_y=trial.sy,
            model_camber_slip=trial.sgamma,
            pneumatic_trail_m=accepted.trail,
            contact_power_w=contact_power,
            gross_contact_loss_proxy_w=max(0.0, -contact_power),
            force_utilization=utilization,
            state_next=trial,
            regime=regime,
            state_was_bounded=state_was_bounded,
            load_was_clamped=accepted.load_clamped,
        )


def make_reference_model() -> TireModel:
    """Construct the accepted synthetic reference policy explicitly."""

    return TireModel(
        params=v17.synthetic_passenger_tire(),
        transient_policy=v18.TireTransientPolicyV18(
            energy_policy=v18.TransientEnergyPolicy.EMPIRICAL_RELAXATION_BOUNDED,
            camber=v18.CamberTransientConfig(v18.CamberTransientPolicy.INSTANT),
            low_speed_policy=v18.LowSpeedTangentialPolicy.FRICTION_CONTACT,
        ),
    )
