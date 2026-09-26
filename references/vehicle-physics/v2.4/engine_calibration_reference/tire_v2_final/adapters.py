"""Adapters from the two accepted suspension backends to one Tire V2 input."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .tire_model import ContactInput, TireModel, VerticalLawOutput


SuspensionBackend = Literal["MAPPED_KC_MASSLESS", "DYNAMIC_UNSPRUNG"]
NormalMode = Literal["RIGID_NORMAL", "COMPLIANT_TIRE_VERTICAL"]


@dataclass(frozen=True)
class FinalContactKinematics:
    """Output of WheelPose + road query, after Steering and Suspension."""

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
    backend: SuspensionBackend
    normal_mode: NormalMode
    in_contact: bool
    kinematics: FinalContactKinematics

    # RIGID_NORMAL supplies either a solved force or a solved impulse.  The
    # massless K&C route generally has the former; the dynamic route generally
    # has the latter.  Exactly one is accepted.
    solved_normal_force_n: float | None = None
    solved_normal_impulse_ns: float | None = None

    # COMPLIANT_TIRE_VERTICAL supplies deformation to TireVerticalLaw and must
    # not simultaneously activate a rigid gap row.
    compression_m: float | None = None
    compression_rate_mps: float | None = None
    rigid_gap_constraint_active: bool = False


@dataclass(frozen=True)
class AdaptedContact:
    tire_input: ContactInput
    vertical: VerticalLawOutput | None


def adapt_contact(packet: SuspensionContactPacket, model: TireModel, dt_s: float) -> AdaptedContact:
    """Normalize either suspension backend without changing Tire semantics."""

    if dt_s <= 0.0:
        raise ValueError("dt_s must be positive")
    k = packet.kinematics
    vertical: VerticalLawOutput | None = None

    if packet.normal_mode == "RIGID_NORMAL":
        if packet.compression_m is not None or packet.compression_rate_mps is not None:
            raise ValueError("RIGID_NORMAL cannot also drive TireVerticalLaw")
        candidates = [packet.solved_normal_force_n is not None, packet.solved_normal_impulse_ns is not None]
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
    else:  # pragma: no cover - Literal protects typed callers
        raise ValueError(f"unknown normal mode: {packet.normal_mode}")

    inp = ContactInput(
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
    )
    return AdaptedContact(inp, vertical)
