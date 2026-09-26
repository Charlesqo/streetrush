"""Active host contract between Contact/Suspension and the accepted Tire.

This module contains no constitutive tire law.  It owns only the final contact
kinematics and the mutually-exclusive normal-authority adapter used by both
suspension backends.  Keeping it outside ``tire_v2_final`` prevents the older
superseded tire implementation from remaining on the active runtime path.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol


@dataclass(frozen=True)
class ContactInput:
    """One wheel/contact sample resolved in the final contact tangent frame."""

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
class VerticalLawOutput:
    force_z_n: float
    dforce_dcompression_n_per_m: float
    dforce_dcompression_rate_n_s_per_m: float
    active: bool


class VerticalLawModel(Protocol):
    def vertical_law(self, compression_m: float, compression_rate_mps: float) -> VerticalLawOutput: ...


SuspensionBackendName = Literal["MAPPED_KC_MASSLESS", "DYNAMIC_UNSPRUNG"]
NormalMode = Literal["RIGID_NORMAL", "COMPLIANT_TIRE_VERTICAL"]


@dataclass(frozen=True)
class FinalContactKinematics:
    velocity_x_mps: float
    velocity_y_mps: float
    wheel_omega_radps: float
    camber_rad: float
    loaded_radius_m: float | None = None
    effective_radius_m: float | None = None
    surface_mu_x: float = 1.0
    surface_mu_y: float = 1.0


@dataclass(frozen=True)
class SuspensionContactPacket:
    backend: SuspensionBackendName
    normal_mode: NormalMode
    in_contact: bool
    kinematics: FinalContactKinematics
    solved_normal_force_n: float | None = None
    solved_normal_impulse_ns: float | None = None
    compression_m: float | None = None
    compression_rate_mps: float | None = None
    rigid_gap_constraint_active: bool = False


@dataclass(frozen=True)
class AdaptedContact:
    tire_input: ContactInput
    vertical: VerticalLawOutput | None


def adapt_contact(
    packet: SuspensionContactPacket,
    model: VerticalLawModel,
    dt_s: float,
) -> AdaptedContact:
    """Resolve exactly one normal authority into the Tire input contract."""

    if dt_s <= 0.0:
        raise ValueError("dt_s must be positive")
    k = packet.kinematics
    vertical: VerticalLawOutput | None = None
    if packet.normal_mode == "RIGID_NORMAL":
        if packet.compression_m is not None or packet.compression_rate_mps is not None:
            raise ValueError("RIGID_NORMAL cannot also drive TireVerticalLaw")
        candidates = (
            packet.solved_normal_force_n is not None,
            packet.solved_normal_impulse_ns is not None,
        )
        if sum(candidates) != 1:
            raise ValueError("RIGID_NORMAL requires exactly one solved force or impulse")
        if packet.solved_normal_force_n is not None:
            normal_load = packet.solved_normal_force_n
        else:
            assert packet.solved_normal_impulse_ns is not None
            normal_load = packet.solved_normal_impulse_ns / dt_s
    elif packet.normal_mode == "COMPLIANT_TIRE_VERTICAL":
        if packet.rigid_gap_constraint_active:
            raise ValueError("compliant vertical force and rigid g=0 row are mutually exclusive")
        if packet.solved_normal_force_n is not None or packet.solved_normal_impulse_ns is not None:
            raise ValueError("COMPLIANT_TIRE_VERTICAL cannot consume a rigid normal solution")
        if packet.compression_m is None or packet.compression_rate_mps is None:
            raise ValueError("COMPLIANT_TIRE_VERTICAL requires compression and rate")
        vertical = model.vertical_law(packet.compression_m, packet.compression_rate_mps)
        normal_load = vertical.force_z_n
    else:
        raise ValueError(f"unknown normal mode: {packet.normal_mode}")

    assert normal_load is not None
    return AdaptedContact(
        ContactInput(
            in_contact=packet.in_contact and normal_load > 0.0,
            normal_load_n=max(0.0, normal_load),
            velocity_x_mps=k.velocity_x_mps,
            velocity_y_mps=k.velocity_y_mps,
            wheel_omega_radps=k.wheel_omega_radps,
            camber_rad=k.camber_rad,
            dt_s=dt_s,
            loaded_radius_m=k.loaded_radius_m,
            effective_radius_m=k.effective_radius_m,
            surface_mu_x=k.surface_mu_x,
            surface_mu_y=k.surface_mu_y,
        ),
        vertical,
    )
