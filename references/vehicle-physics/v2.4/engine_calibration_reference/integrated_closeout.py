"""Historical v2.1 reduced longitudinal integration fixture.

The v2.2 audit confirmed that this module uses Tire v1.7 and reduced base-load
normal equations; it does not execute Steering or the packaged K&C,
spring/damper, ARB and compliance backend.  It remains unchanged for v2.1
regression compatibility.  ``unified_vehicle_fixture.py`` is the authoritative
final cross-system reference surface.

This module is intentionally *not* a replacement 6-DOF vehicle host.  It is a
reduced straight-line integration fixture whose purpose is to execute the
already accepted subsystem contracts in one same-step nonlinear solve:

    Aero 6D wrench -> host normal-load path -> per-wheel Fz -> Tire V2
    Engine/clutch -> wheel dynamics <-> Tire V2 Fx -> chassis dynamics

Two normal backends are exercised with the same Engine, Aero and Tire V2:
``MAPPED_MASSLESS`` and ``EXPLICIT_UNSPRUNG``.  The reduced planar fixture is
allowed to derive axle-equivalent vertical loads from the canonical Aero wrench;
the production contract remains that Aero itself never owns or writes tire Fz.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import math
from pathlib import Path
from typing import Sequence

import numpy as np
from scipy.optimize import least_squares

from .aero_reference_v1_9 import (
    AeroEnvironment,
    AeroPlatformSample,
    AeroEvaluation,
    build_synthetic_race_aeromap,
    equivalent_front_rear_vertical_forces,
)
from .coupled_vehicle_solver import Axle, CoupledVehicleConfig, CoupledVehicleState
from .engine_model import (
    EngineAsset,
    EngineCommand,
    EngineMode,
    EngineModel,
    EngineOwner,
    EngineState,
    rpm_to_rad_s,
)
from .tire_v2_reference_v1_7 import (
    TireOutput,
    TireTransientState,
    TireMode as TireV2Mode,
    effective_radius,
    handling_eval,
    handling_kinematics,
    synthetic_passenger_tire,
    tire_vertical_law,
)


class NormalBackend(str, Enum):
    MAPPED_MASSLESS = "MAPPED_MASSLESS"
    EXPLICIT_UNSPRUNG = "EXPLICIT_UNSPRUNG"


@dataclass(frozen=True)
class IntegratedCloseoutConfig:
    mass_kg: float = 1420.0
    wheelbase_m: float = 2.72
    cg_to_rear_axle_m: float = 1.42
    cg_height_m: float = 0.53
    wheel_inertias_kg_m2: tuple[float, ...] = (1.25, 1.25, 1.25, 1.25)
    clutch_speed_mapping: tuple[float, ...] = (0.0, 0.0, 4.5, 4.5)
    clutch_capacity_nm: float = 900.0
    jacking_coeff: tuple[float, ...] = (0.025, -0.020, 0.030, -0.024)
    unsprung_mass_kg: float = 42.0
    gravity_m_s2: float = 9.81
    platform_front_m: float = 0.040
    platform_rear_m: float = 0.060
    air_density_kg_m3: float = 1.225
    mu_scale: float = 1.0

    @property
    def wheel_count(self) -> int:
        return len(self.wheel_inertias_kg_m2)

    def validate(self) -> None:
        n = self.wheel_count
        if n != 4:
            raise ValueError("close-out fixture is intentionally four-corner")
        if len(self.clutch_speed_mapping) != n or len(self.jacking_coeff) != n:
            raise ValueError("wheel arrays must have four entries")
        if self.mass_kg <= 0 or self.wheelbase_m <= 0 or self.unsprung_mass_kg <= 0:
            raise ValueError("masses/geometry must be positive")
        if not 0 < self.cg_to_rear_axle_m < self.wheelbase_m:
            raise ValueError("CG must lie between axles")


@dataclass(frozen=True)
class IntegratedCloseoutState:
    engine: EngineState
    wheel_omega_rad_s: tuple[float, ...]
    chassis_speed_m_s: float
    tire_states: tuple[TireTransientState, ...]
    normal_velocity_m_s: tuple[float, ...]
    vertical_compression_m: tuple[float, ...]


@dataclass(frozen=True)
class IntegratedCloseoutResult:
    backend: NormalBackend
    state: IntegratedCloseoutState
    tire_outputs: tuple[TireOutput, ...]
    normal_loads_n: tuple[float, ...]
    aero: AeroEvaluation
    clutch_impulse_nms: float
    residual_scaled_inf: float
    nonlinear_evaluations: int
    clutch_capacity_margin_nms: float
    normal_tangential_iterations_are_same_step: bool
    aero_wrench_is_canonical: bool
    simplified_internal_tire_aero_disabled: bool


class IntegratedCloseoutSystem:
    """A same-step integration fixture around the accepted subsystem refs."""

    def __init__(
        self,
        engine_model: EngineModel,
        initial_state: IntegratedCloseoutState,
        config: IntegratedCloseoutConfig | None = None,
    ):
        self.config = config or IntegratedCloseoutConfig()
        self.config.validate()
        if len(initial_state.wheel_omega_rad_s) != self.config.wheel_count:
            raise ValueError("wheel state count mismatch")
        self.engine_owner = EngineOwner(engine_model, initial_state.engine)
        self.state = initial_state
        self.tire = synthetic_passenger_tire()
        self.aero_map = build_synthetic_race_aeromap()

    @classmethod
    def synthetic(cls, root: Path | None = None, speed_m_s: float = 15.0) -> "IntegratedCloseoutSystem":
        root = root or Path(__file__).resolve().parent
        model = EngineModel(EngineAsset.from_json(root / "data" / "synthetic_engine_asset.json"))
        cfg = IntegratedCloseoutConfig()
        tire = synthetic_passenger_tire()
        # Static per-corner estimate only initializes canonical state; every step
        # solves current Fz same-step rather than freezing this value.
        front_axle = cfg.mass_kg * cfg.gravity_m_s2 * cfg.cg_to_rear_axle_m / cfg.wheelbase_m
        rear_axle = cfg.mass_kg * cfg.gravity_m_s2 - front_axle
        fz0 = (front_axle / 2, front_axle / 2, rear_axle / 2, rear_axle / 2)
        radii = tuple(effective_radius(tire, fz=f) for f in fz0)
        wheels = tuple(speed_m_s / r for r in radii)
        engine_omega = float(np.dot(np.asarray(cfg.clutch_speed_mapping), np.asarray(wheels)))
        state = IntegratedCloseoutState(
            engine=EngineState(engine_omega, EngineMode.RUNNING, 0.35),
            wheel_omega_rad_s=wheels,
            chassis_speed_m_s=float(speed_m_s),
            tire_states=tuple(TireTransientState(0.0, 0.0, TireV2Mode.HANDLING) for _ in range(4)),
            normal_velocity_m_s=(0.0, 0.0, 0.0, 0.0),
            vertical_compression_m=tuple(f / tire.vertical_k1 for f in fz0),
        )
        return cls(model, state, cfg)

    @staticmethod
    def production_powertrain_seam_config(config: IntegratedCloseoutConfig) -> CoupledVehicleConfig:
        """Mechanical solver seam with its low-order Tire/Aero paths disabled.

        This object is not used to compute the close-out solution; it makes the
        ownership boundary machine-checkable for host integration tests.
        """
        return CoupledVehicleConfig(
            mass_kg=config.mass_kg,
            wheel_inertias_kg_m2=config.wheel_inertias_kg_m2,
            wheel_radii_m=(0.31,) * 4,
            clutch_speed_mapping=config.clutch_speed_mapping,
            clutch_capacity_nm=config.clutch_capacity_nm,
            tire_mu=(0.0,) * 4,
            wheel_axles=(Axle.FRONT, Axle.FRONT, Axle.REAR, Axle.REAR),
            wheelbase_m=config.wheelbase_m,
            cg_to_rear_axle_m=config.cg_to_rear_axle_m,
            cg_height_m=config.cg_height_m,
            cd_area_m2=0.0,
            cl_area_m2=0.0,
            rolling_resistance_coefficient=0.0,
        )

    def _aero(self, speed: float) -> AeroEvaluation:
        p = AeroPlatformSample(self.config.platform_front_m, self.config.platform_rear_m)
        e = AeroEnvironment(self.config.air_density_kg_m3, np.array([speed, 0.0, 0.0]))
        return self.aero_map.evaluate(p, e)

    def _base_loads(self, speed_next: float, aero: AeroEvaluation, dt: float) -> np.ndarray:
        c = self.config
        a_long = (speed_next - self.state.chassis_speed_m_s) / dt
        static_front = c.mass_kg * c.gravity_m_s2 * c.cg_to_rear_axle_m / c.wheelbase_m
        static_rear = c.mass_kg * c.gravity_m_s2 - static_front
        # Aero map is z-up: negative equivalent forces are downward loads.
        af_z, ar_z = equivalent_front_rear_vertical_forces(
            aero.force_body_n[2], aero.moment_body_nm_at_ref[1],
            self.aero_map.reference.front_axle_x_m, self.aero_map.reference.rear_axle_x_m,
        )
        transfer = c.mass_kg * a_long * c.cg_height_m / c.wheelbase_m
        front = static_front - af_z - transfer
        rear = static_rear - ar_z + transfer
        return np.array([front / 2, front / 2, rear / 2, rear / 2], dtype=float)

    def step(self, command: EngineCommand, dt: float, backend: NormalBackend) -> IntegratedCloseoutResult:
        if dt <= 0:
            raise ValueError("dt must be positive")
        backend = NormalBackend(backend)
        c = self.config
        n = c.wheel_count
        ticket = self.engine_owner.begin_substep(command, dt)
        Ie = self.engine_owner.model.asset.inertia_kg_m2
        Iw = np.asarray(c.wheel_inertias_kg_m2)
        mapping = np.asarray(c.clutch_speed_mapping)
        jacking = np.asarray(c.jacking_coeff)
        w0 = np.asarray(self.state.wheel_omega_rad_s)
        v0 = self.state.chassis_speed_m_s
        vz0 = np.asarray(self.state.normal_velocity_m_s)
        comp0 = np.asarray(self.state.vertical_compression_m)
        upper = rpm_to_rad_s(self.engine_owner.model.asset.hard_overspeed_rpm)

        # x = [we, w0..w3, v, clutch_impulse, Fz0..Fz3, (vz0..vz3)]
        base_n = 7
        fz_slice = slice(base_n, base_n + n)
        vz_slice = slice(base_n + n, base_n + 2*n)
        aero0 = self._aero(v0)
        base0 = self._base_loads(v0, aero0, dt)
        x0 = np.concatenate([
            [self.state.engine.omega_rad_s], w0, [v0, 0.0],
            np.clip(base0, 300.0, 7800.0),
            vz0 if backend is NormalBackend.EXPLICIT_UNSPRUNG else np.array([]),
        ])
        lo = np.concatenate([
            [0.0], np.zeros(n), [2.01, -c.clutch_capacity_nm*dt],
            np.full(n, 50.0),
            np.full(n, -6.0) if backend is NormalBackend.EXPLICIT_UNSPRUNG else np.array([]),
        ])
        hi = np.concatenate([
            [upper], np.full(n, 500.0), [95.0, c.clutch_capacity_nm*dt],
            np.full(n, 7990.0),
            np.full(n, 6.0) if backend is NormalBackend.EXPLICIT_UNSPRUNG else np.array([]),
        ])

        last_outputs: list[TireOutput] = []
        last_aero: AeroEvaluation | None = None

        def physical_rows(x: np.ndarray) -> np.ndarray:
            nonlocal last_outputs, last_aero
            we = float(x[0]); wheels = x[1:1+n]; v = float(x[1+n]); j = float(x[2+n])
            fz = x[fz_slice]
            aero = self._aero(v)
            base = self._base_loads(v, aero, dt)
            outs: list[TireOutput] = []
            radii = np.empty(n)
            for k in range(n):
                vertical_compression = None
                if backend is NormalBackend.EXPLICIT_UNSPRUNG:
                    vz = float(x[vz_slice][k])
                    vertical_compression = max(0.0, comp0[k] - dt * vz)
                R = effective_radius(self.tire, vertical_compression=vertical_compression, fz=float(fz[k]), omega=float(wheels[k]))
                kin = handling_kinematics(v, 0.0, float(wheels[k]), R)
                out = handling_eval(
                    self.tire, float(fz[k]), kin.sx_inst, kin.sy_inst, 0.0, c.mu_scale,
                    self.state.tire_states[k], kin.travel_speed, dt,
                    vertical_compression=vertical_compression, omega=float(wheels[k]),
                )
                outs.append(out); radii[k] = out.R_eff
            sample = self.engine_owner.evaluate(ticket, we)
            rows = []
            rows.append(Ie * (we - self.state.engine.omega_rad_s) - dt * sample.free_torque_nm - j)
            for k, out in enumerate(outs):
                # Tire Fx is forward on chassis, therefore -R*Fx acts on wheel.
                rows.append(Iw[k] * (wheels[k] - w0[k]) + mapping[k] * j + out.R_eff * out.Fx * dt - dt * out.rolling_resistance_torque)
            rows.append(c.mass_kg * (v - v0) - dt * (sum(o.Fx for o in outs) + float(aero.force_body_n[0])))
            rows.append(we - float(np.dot(mapping, wheels)))
            if backend is NormalBackend.MAPPED_MASSLESS:
                for k, out in enumerate(outs):
                    rows.append(float(fz[k] - (base[k] + jacking[k] * out.Fx)))
            else:
                vz = x[vz_slice]
                for k, out in enumerate(outs):
                    comp1 = max(0.0, comp0[k] - dt * vz[k])
                    vertical = tire_vertical_law(self.tire, comp1, -float(vz[k]))
                    rows.append(float(fz[k] - vertical.fz))
                for k, out in enumerate(outs):
                    rows.append(float(c.unsprung_mass_kg * (vz[k] - vz0[k]) / dt - (fz[k] - base[k] + jacking[k] * out.Fx)))
            last_outputs = outs
            last_aero = aero
            return np.asarray(rows, dtype=float)

        # Unit-aware scaling: impulse/dynamics rows and normal-force rows should
        # have comparable numerical authority without changing their roots.
        force_scale = max(1000.0, c.mass_kg*c.gravity_m_s2/4)
        speed_scale = max(100.0, abs(self.state.engine.omega_rad_s))
        scales = np.array(
            [max(1.0, Ie*speed_scale)]
            + [max(1.0, Iw[k]*max(10.0, abs(w0[k]))) for k in range(n)]
            + [max(1.0, c.mass_kg*max(5.0, abs(v0))), speed_scale]
            + [force_scale]*n
            + ([force_scale]*n if backend is NormalBackend.EXPLICIT_UNSPRUNG else []),
            dtype=float,
        )
        def scaled_rows(x: np.ndarray) -> np.ndarray:
            return physical_rows(x) / scales

        try:
            sol = least_squares(
                scaled_rows, x0, bounds=(lo, hi), xtol=1e-11, ftol=1e-11, gtol=1e-11,
                max_nfev=220, x_scale="jac",
            )
            raw = physical_rows(sol.x)
            scaled_inf = float(np.max(np.abs(raw / scales)))
            if not sol.success or scaled_inf > 3.0e-7:
                raise RuntimeError(f"integrated {backend.value} solve failed: {sol.message}; scaled_inf={scaled_inf:.3g}")
            we = float(sol.x[0]); wheels = tuple(map(float, sol.x[1:1+n])); v = float(sol.x[1+n]); j = float(sol.x[2+n])
            fz = tuple(map(float, sol.x[fz_slice]))
            self.engine_owner.validate_commit(ticket, we)
            engine = self.engine_owner.commit(ticket, we)
            if backend is NormalBackend.EXPLICIT_UNSPRUNG:
                vz = tuple(map(float, sol.x[vz_slice]))
                comp = tuple(max(0.0, comp0[k] - dt*vz[k]) for k in range(n))
            else:
                vz = self.state.normal_velocity_m_s
                comp = tuple(max(0.0, f/self.tire.vertical_k1) for f in fz)
            assert last_aero is not None
            new_state = IntegratedCloseoutState(
                engine=engine, wheel_omega_rad_s=wheels, chassis_speed_m_s=v,
                tire_states=tuple(out.state_trial for out in last_outputs),
                normal_velocity_m_s=vz, vertical_compression_m=comp,
            )
            self.state = new_state
            seam = self.production_powertrain_seam_config(c)
            return IntegratedCloseoutResult(
                backend=backend, state=new_state, tire_outputs=tuple(last_outputs),
                normal_loads_n=fz, aero=last_aero, clutch_impulse_nms=j,
                residual_scaled_inf=scaled_inf, nonlinear_evaluations=int(sol.nfev),
                clutch_capacity_margin_nms=c.clutch_capacity_nm*dt-abs(j),
                normal_tangential_iterations_are_same_step=True,
                aero_wrench_is_canonical=True,
                simplified_internal_tire_aero_disabled=(
                    max(seam.tire_mu)==0.0 and seam.cd_area_m2==0.0 and seam.cl_area_m2==0.0
                    and seam.rolling_resistance_coefficient==0.0
                ),
            )
        except Exception:
            # A failed cross-system solve must not advance Engine canonical state.
            try:
                self.engine_owner.abort(ticket)
            except RuntimeError:
                pass
            raise
