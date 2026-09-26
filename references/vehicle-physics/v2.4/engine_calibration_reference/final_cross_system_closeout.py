"""Final cross-system executable reference closure (v2.2).

This module closes the subsystem contracts that the v2.1 longitudinal fixture
still left disconnected.  It is deliberately a *reference validation host*,
not a surrogate for the missing Rapier/world 6-DOF owner.

Actually executed in the same nonlinear substep:

  Engine / ideal locked clutch / four wheel rotational states
  Mapped K&C wheel pose and its q/steer spatial Jacobians
  spring + damper motion-ratio virtual work
  front/rear anti-roll-bar cross-corner coupling
  load-dependent compliance feedback into final steer pose
  Tire V2 v1.8 final transient policy over the accepted v1.7 steady/Mz core
  canonical Aero v1.9 6-D wrench
  planar chassis u/v/yaw dynamics
  Tire full contact wrench -> steering generalized road load

The normal closure is a flat-road quasi-static heave/pitch/roll validation host:
contact gaps and total vertical/roll/pitch wrench balance are solved together.
Those algebraic platform variables are NOT claimed to be chassis dynamic DOFs.
A real world rigid-body host remains an explicit SKIP boundary.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
import math
from pathlib import Path
from typing import Iterable

import numpy as np
from scipy.optimize import least_squares

from .aero_reference_v1_9 import AeroEnvironment, AeroEvaluation, AeroPlatformSample, build_synthetic_race_aeromap
from .chassis_suspension_reference import (
    DomainError as KCDomainError,
    additive_compliance_model,
    build_synthetic_kc_map,
    exp_so3,
    rotvec_rate_to_spatial_omega,
)
from .engine_model import EngineAsset, EngineCommand, EngineMode, EngineModel, EngineOwner, EngineState, rpm_to_rad_s
from .tire_v2_reference_v1_7 import TireOutput, TireMode, TireRegimePolicy, effective_radius, handling_kinematics
from .tire_v2_reference_v1_8 import (
    CamberTransientConfig,
    CamberTransientPolicy,
    LowSpeedTangentialPolicy,
    TireTransientPolicyV18,
    TireTransientStateV18,
    TransientEnergyPolicy,
    evaluate_state_v18,
    handling_trial_state_v18,
    synthetic_passenger_tire,
)


class MissingHostCapability(RuntimeError):
    """A baseline route exists, but its canonical host/artifact is absent."""


@dataclass(frozen=True)
class FinalCloseoutConfig:
    mass_kg: float = 1420.0
    yaw_inertia_kg_m2: float = 2250.0
    wheelbase_m: float = 2.72
    cg_to_rear_axle_m: float = 1.42
    track_front_m: float = 1.58
    track_rear_m: float = 1.56
    cg_height_m: float = 0.53
    wheel_inertias_kg_m2: tuple[float, float, float, float] = (1.25, 1.25, 1.25, 1.25)
    clutch_speed_mapping: tuple[float, float, float, float] = (0.0, 0.0, 4.5, 4.5)
    clutch_capacity_nm: float = 900.0
    spring_rate_n_m: tuple[float, float, float, float] = (44000.0, 44000.0, 50000.0, 50000.0)
    damper_rate_n_s_m: tuple[float, float, float, float] = (4200.0, 4200.0, 4700.0, 4700.0)
    arb_stiffness: tuple[float, float] = (4200.0, 3600.0)
    air_density_kg_m3: float = 1.225
    aero_front_clearance_m: float = 0.040
    aero_rear_clearance_m: float = 0.060
    mu_scale: float = 1.0
    gravity_m_s2: float = 9.81
    nonlinear_tolerance: float = 2.0e-9
    max_nfev: int = 180
    min_handling_speed_m_s: float = 2.05

    @property
    def front_axle_x_m(self) -> float:
        return self.wheelbase_m - self.cg_to_rear_axle_m

    @property
    def rear_axle_x_m(self) -> float:
        return -self.cg_to_rear_axle_m

    def validate(self) -> None:
        if self.mass_kg <= 0 or self.yaw_inertia_kg_m2 <= 0:
            raise ValueError("mass/inertia must be positive")
        if not 0 < self.cg_to_rear_axle_m < self.wheelbase_m:
            raise ValueError("CG must lie between axles")
        if min(self.track_front_m, self.track_rear_m) <= 0:
            raise ValueError("tracks must be positive")
        if len(self.wheel_inertias_kg_m2) != 4 or len(self.clutch_speed_mapping) != 4:
            raise ValueError("four-corner fixture required")
        if self.nonlinear_tolerance <= 0 or self.max_nfev < 10:
            raise ValueError("invalid nonlinear settings")


@dataclass(frozen=True)
class PlatformSolution:
    heave_m: float
    pitch_rad: float
    roll_rad: float


@dataclass(frozen=True)
class FinalCloseoutState:
    engine: EngineState
    wheel_omega_rad_s: tuple[float, float, float, float]
    u_m_s: float
    v_m_s: float
    yaw_rate_rad_s: float
    yaw_rad: float
    tire_states: tuple[TireTransientStateV18, TireTransientStateV18, TireTransientStateV18, TireTransientStateV18]
    suspension_q_m: tuple[float, float, float, float]
    platform: PlatformSolution
    steering_coordinate_rad: float = 0.0


@dataclass(frozen=True)
class CornerEvaluation:
    q_m: float
    fz_n: float
    final_steer_rad: float
    camber_rad: float
    compliance_steer_rad: float
    contact_point_body_m: tuple[float, float, float]
    tire: TireOutput
    tire_state_trial: TireTransientStateV18
    force_body_n: tuple[float, float, float]
    moment_body_nm: tuple[float, float, float]
    suspension_contact_q_n: float
    spring_q_n: float
    damper_q_n: float
    arb_q_n: float
    steering_road_q: float
    steering_mz_contribution: float


@dataclass(frozen=True)
class PreparedFinalStep:
    token: int
    dt: float
    steering_coordinate_rad: float
    command: EngineCommand
    snapshot: FinalCloseoutState
    engine_ticket: object


@dataclass(frozen=True)
class SolvedFinalStep:
    prepared: PreparedFinalStep
    next_state: FinalCloseoutState
    corners: tuple[CornerEvaluation, CornerEvaluation, CornerEvaluation, CornerEvaluation]
    aero: AeroEvaluation
    normal_loads_n: tuple[float, float, float, float]
    clutch_impulse_nms: float
    steering_road_generalized_load: float
    steering_mz_generalized_contribution: float
    residual_scaled_inf: float
    nonlinear_evaluations: int
    action_reaction_wheel_torque_error_nm: float
    vertical_wrench_residual_n: float
    roll_wrench_residual_nm: float
    pitch_wrench_residual_nm: float
    committed: bool = False


class FinalCrossSystemCloseout:
    """Transactional cross-system reference fixture.

    prepare() opens only the Engine owner ticket. solve() is pure with respect to
    canonical Engine/Tire/chassis state. commit() advances all owners once.
    abort() closes the Engine ticket and leaves every canonical state unchanged.
    """

    def __init__(self, engine_model: EngineModel, initial_state: FinalCloseoutState, config: FinalCloseoutConfig | None = None):
        self.config = config or FinalCloseoutConfig()
        self.config.validate()
        self.engine_owner = EngineOwner(engine_model, initial_state.engine)
        self.state = initial_state
        self.tire = synthetic_passenger_tire()
        self.kc, self.kc_truth = build_synthetic_kc_map()
        self.aero_map = build_synthetic_race_aeromap()
        self.tire_policy = TireTransientPolicyV18(
            TransientEnergyPolicy.EMPIRICAL_RELAXATION_BOUNDED,
            CamberTransientConfig(CamberTransientPolicy.INSTANT, None),
            LowSpeedTangentialPolicy.FRICTION_CONTACT,
        )
        self.tire_policy.validate()
        self.regime = TireRegimePolicy()
        self._next_token = 1
        self._open_token: int | None = None
        self._spring_ref_length = self._field_scalar_at_zero("spring_length")
        self._preload_axial_n = self._derive_static_preloads()
        self._last_fz_guess = np.array(self._static_fz_seed(), float)
        self._last_comp_guess = np.zeros(4, float)

    @classmethod
    def synthetic(cls, root: Path | None = None, speed_m_s: float = 15.0) -> "FinalCrossSystemCloseout":
        root = root or Path(__file__).resolve().parent
        model = EngineModel(EngineAsset.from_json(root / "data" / "synthetic_engine_asset.json"))
        cfg = FinalCloseoutConfig()
        tire = synthetic_passenger_tire()
        # Initialization only: static axle weights seed wheel speed/radius and
        # spring preload. Dynamic Fz is never computed from a base-axle formula.
        front_total = cfg.mass_kg * cfg.gravity_m_s2 * cfg.cg_to_rear_axle_m / cfg.wheelbase_m
        rear_total = cfg.mass_kg * cfg.gravity_m_s2 - front_total
        fz_seed = (front_total/2, front_total/2, rear_total/2, rear_total/2)
        radii = tuple(effective_radius(tire, fz=f) for f in fz_seed)
        wheels = tuple(speed_m_s / r for r in radii)
        mapping = np.asarray(cfg.clutch_speed_mapping)
        engine_omega = float(np.dot(mapping, np.asarray(wheels)))
        state = FinalCloseoutState(
            engine=EngineState(engine_omega, EngineMode.RUNNING, 0.30),
            wheel_omega_rad_s=wheels,
            u_m_s=float(speed_m_s), v_m_s=0.0, yaw_rate_rad_s=0.0, yaw_rad=0.0,
            tire_states=tuple(TireTransientStateV18(0.0, 0.0, 0.0, TireMode.HANDLING) for _ in range(4)),
            suspension_q_m=(0.0, 0.0, 0.0, 0.0),
            platform=PlatformSolution(cfg.cg_height_m, 0.0, 0.0),
            steering_coordinate_rad=0.0,
        )
        return cls(model, state, cfg)

    def _field_scalar_at_zero(self, name: str) -> float:
        return float(self.kc.fields[name].eval(0.0, 0.0))

    def _static_fz_seed(self) -> tuple[float, float, float, float]:
        c = self.config
        front_total = c.mass_kg*c.gravity_m_s2*c.cg_to_rear_axle_m/c.wheelbase_m
        rear_total = c.mass_kg*c.gravity_m_s2-front_total
        return (front_total/2, front_total/2, rear_total/2, rear_total/2)

    def _derive_static_preloads(self) -> tuple[float, float, float, float]:
        fz = self._static_fz_seed()
        js = self.kc.fields["spring_length"].eval(0.0, 0.0, dq=1)
        if js >= -1e-6:
            raise ValueError("synthetic K&C spring motion ratio has unexpected sign")
        return tuple(float(-f/js) for f in fz)

    def _base_center(self, k: int) -> np.ndarray:
        c = self.config
        front = k < 2
        left = k % 2 == 0
        x = c.front_axle_x_m if front else c.rear_axle_x_m
        y = (c.track_front_m if front else c.track_rear_m) * (0.5 if left else -0.5)
        z = -(c.cg_height_m - self.tire.R0)
        return np.array([x, y, z], float)

    @staticmethod
    def _mirror_position(v: np.ndarray) -> np.ndarray:
        return np.array([v[0], -v[1], v[2]], float)

    @staticmethod
    def _mirror_rotvec(v: np.ndarray) -> np.ndarray:
        # Axial-vector reflection across x-z plane: det(M) M phi.
        return np.array([-v[0], v[1], -v[2]], float)

    def _kc_corner(self, k: int, q: float, steer_global: float):
        left = k % 2 == 0
        s_local = steer_global if left else -steer_global
        vals = self.kc.evaluate(float(q), float(s_local), policy="reject")
        dqv = self.kc.derivative_q(float(q), float(s_local), policy="reject")
        dsv = self.kc.derivative_steer(float(q), float(s_local), policy="reject")

        p = np.array([vals["px"], vals["py"], vals["pz"]], float)
        rv = np.array([vals["rx"], vals["ry"], vals["rz"]], float)
        pdq = np.array([dqv["px"], dqv["py"], dqv["pz"]], float)
        rvdq = np.array([dqv["rx"], dqv["ry"], dqv["rz"]], float)
        pds_local = np.array([dsv["px"], dsv["py"], dsv["pz"]], float)
        rvds_local = np.array([dsv["rx"], dsv["ry"], dsv["rz"]], float)
        if not left:
            p = self._mirror_position(p)
            rv = self._mirror_rotvec(rv)
            pdq = self._mirror_position(pdq)
            rvdq = self._mirror_rotvec(rvdq)
            # d/ds_global = mirror(d/ds_local) * (-1)
            pds_local = -self._mirror_position(pds_local)
            rvds_local = -self._mirror_rotvec(rvds_local)
        return vals, dqv, dsv, p, rv, pdq, rvdq, pds_local, rvds_local, s_local

    def _aero(self, u: float, v: float, platform: PlatformSolution, steer: float) -> AeroEvaluation:
        c = self.config
        dh = platform.heave_m - c.cg_height_m
        hf = c.aero_front_clearance_m + dh - platform.pitch_rad*c.front_axle_x_m
        hr = c.aero_rear_clearance_m + dh - platform.pitch_rad*c.rear_axle_x_m
        sample = AeroPlatformSample(float(hf), float(hr), float(platform.roll_rad), float(steer))
        env = AeroEnvironment(c.air_density_kg_m3, np.array([u, v, 0.0], float))
        return self.aero_map.evaluate(sample, env)

    def prepare(self, command: EngineCommand, dt: float, steering_coordinate_rad: float) -> PreparedFinalStep:
        if self._open_token is not None:
            raise RuntimeError("previous final-closeout step is still open")
        if not math.isfinite(dt) or dt <= 0:
            raise ValueError("dt must be finite and positive")
        # K&C domain is a real declared domain. Reject before opening any owner ticket.
        if not self.kc.steer_axis.contains(float(steering_coordinate_rad)):
            raise KCDomainError("steering coordinate outside compiled K&C domain")
        if self.state.u_m_s < self.config.min_handling_speed_m_s:
            raise MissingHostCapability(
                "LOW_SPEED_REQUIRES_FRICTION_CONTACT_HOST_SKIP: empirical Tire V2 v1.8 "
                "must use FRICTION_CONTACT here, but the missing world/contact host owns that constraint route"
            )
        ticket = self.engine_owner.begin_substep(command, dt)
        tok = self._next_token
        self._next_token += 1
        self._open_token = tok
        return PreparedFinalStep(tok, float(dt), float(steering_coordinate_rad), command, self.state, ticket)

    def _check_prepared(self, p: PreparedFinalStep) -> None:
        if self._open_token != p.token or p.snapshot is not self.state:
            raise RuntimeError("stale final-closeout transaction")

    def solve(self, p: PreparedFinalStep, *, tolerance: float | None = None, max_nfev: int | None = None) -> SolvedFinalStep:
        self._check_prepared(p)
        c = self.config
        dt = p.dt
        tol = float(tolerance if tolerance is not None else c.nonlinear_tolerance)
        maxeval = int(max_nfev if max_nfev is not None else c.max_nfev)
        n = 4
        Iw = np.asarray(c.wheel_inertias_kg_m2, float)
        mapping = np.asarray(c.clutch_speed_mapping, float)
        w0 = np.asarray(p.snapshot.wheel_omega_rad_s, float)
        q0 = np.asarray(p.snapshot.suspension_q_m, float)
        u0, v0, r0 = p.snapshot.u_m_s, p.snapshot.v_m_s, p.snapshot.yaw_rate_rad_s
        steer_rate = (p.steering_coordinate_rad - p.snapshot.steering_coordinate_rad)/dt
        Ie = self.engine_owner.model.asset.inertia_kg_m2
        upper_engine = rpm_to_rad_s(self.engine_owner.model.asset.hard_overspeed_rpm)

        # x layout: we | wheel[4] | u,v,r | clutchJ | q[4] | Fz[4] | compSteer[4] | heave,pitch,roll
        WE = 0; W = slice(1,5); U=5; V=6; R=7; J=8; Q=slice(9,13); FZ=slice(13,17); COMP=slice(17,21); H=21; PITCH=22; ROLL=23
        fz_guess = self._last_fz_guess.copy()
        x0 = np.zeros(24, float)
        x0[WE] = p.snapshot.engine.omega_rad_s
        x0[W] = w0
        x0[U: R+1] = [u0, v0, r0]
        x0[J] = 0.0
        x0[Q] = q0
        x0[FZ] = fz_guess
        x0[COMP] = self._last_comp_guess
        x0[H:PITCH+2] = [p.snapshot.platform.heave_m, p.snapshot.platform.pitch_rad, p.snapshot.platform.roll_rad]

        lo = np.array([
            0.0, *([0.5]*4), 2.01, -15.0, -2.5, -c.clutch_capacity_nm*dt,
            *([-0.075]*4), *([100.0]*4), *([-0.14]*4),
            c.cg_height_m-0.018, -0.007, -0.10,
        ], float)
        hi = np.array([
            upper_engine, *([500.0]*4), 90.0, 15.0, 2.5, c.clutch_capacity_nm*dt,
            *([0.075]*4), *([7990.0]*4), *([0.14]*4),
            c.cg_height_m+0.018, 0.007, 0.10,
        ], float)

        last: dict[str, object] = {}

        # Dimensionless equation scales. Every returned row is divided by its physical-scale counterpart.
        dyn_engine_scale = max(20.0, Ie*max(100.0, p.snapshot.engine.omega_rad_s))
        wheel_scales = [max(5.0, Iw[k]*max(20.0, w0[k])) for k in range(4)]
        planar_scale = max(3000.0, c.mass_kg*max(5.0, u0))
        yaw_scale = max(3000.0, c.yaw_inertia_kg_m2*0.5)
        clutch_scale = max(100.0, p.snapshot.engine.omega_rad_s)
        suspension_scale = max(3000.0, c.mass_kg*c.gravity_m_s2/4)
        compliance_scale = 0.05
        gap_scale = 0.02
        vertical_scale = c.mass_kg*c.gravity_m_s2
        moment_scale = c.mass_kg*c.gravity_m_s2*0.8
        scales = np.array([
            dyn_engine_scale, *wheel_scales, planar_scale, planar_scale, yaw_scale, clutch_scale,
            *([suspension_scale]*4), *([compliance_scale]*4), *([gap_scale]*4),
            vertical_scale, moment_scale, moment_scale,
        ], float)

        def equations(x: np.ndarray, *, store: bool = False) -> np.ndarray:
            we=float(x[WE]); wheels=np.asarray(x[W]); u=float(x[U]); v=float(x[V]); rr=float(x[R]); j=float(x[J])
            qs=np.asarray(x[Q]); fzs=np.asarray(x[FZ]); comps=np.asarray(x[COMP]); platform=PlatformSolution(float(x[H]),float(x[PITCH]),float(x[ROLL]))
            aero=self._aero(u,v,platform,p.steering_coordinate_rad)
            corners=[]
            forces=[]; moments=[]; tire_trials=[]; q_contact=[]; qspring=[]; qdamper=[]; qarb=np.zeros(4); qsteer=[]; qmz=[]
            arb_coords=np.zeros(4); arb_dq=np.zeros(4)
            cache=[]

            for k in range(4):
                vals,dqv,dsv,pdelta,rv_base,pdq,rvdq,pds,rvds,s_local=self._kc_corner(k,float(qs[k]),p.steering_coordinate_rad)
                rv=rv_base.copy(); rv[2]+=float(comps[k])
                Rw=exp_so3(rv)
                Re=effective_radius(self.tire,fz=float(fzs[k]),omega=float(wheels[k]))
                rdown=Rw@np.array([0.0,0.0,-Re])
                center=self._base_center(k)+pdelta
                cp=center+rdown
                # Planar rigid-body contact-point velocity in body axes.
                vx=u-rr*cp[1]; vy=v+rr*cp[0]
                delta=float(rv[2]); cd=math.cos(delta); sd=math.sin(delta)
                vlong=cd*vx+sd*vy; vlat=-sd*vx+cd*vy
                transport=abs(float(wheels[k])*Re)
                prev=p.snapshot.tire_states[k]
                mode_prev=prev.mode
                # Final v1.8 empirical policy cannot be silently extended through standstill.
                if abs(vlong)<self.regime.handling_exit_abs_vlong or transport<self.regime.handling_exit_transport:
                    raise MissingHostCapability("LOW_SPEED_REQUIRES_FRICTION_CONTACT_HOST_SKIP")
                kin=handling_kinematics(vlong,vlat,float(wheels[k]),Re)
                trial=handling_trial_state_v18(
                    self.tire,float(fzs[k]),prev,kin.sx_inst,kin.sy_inst,float(rv[0]),kin.travel_speed,dt,self.tire_policy.camber
                )
                out=evaluate_state_v18(self.tire,float(fzs[k]),trial,float(rv[0]),c.mu_scale,omega=float(wheels[k]))
                # Accepted tire convention: local x forward, y left, z road-normal upward.
                Fw=np.array([out.Fx,out.Fy,float(fzs[k])],float)
                Mw=np.array([out.Mx,out.rolling_resistance_torque,out.Mz],float)
                Fb=Rw@Fw; Mb=Rw@Mw

                omega_q=rotvec_rate_to_spatial_omega(rv_base,rvdq)
                dcp_q=pdq+np.cross(omega_q,rdown)
                Qc=float(dcp_q@Fb+omega_q@Mb)

                omega_s=rotvec_rate_to_spatial_omega(rv_base,rvds)
                dcp_s=pds+np.cross(omega_s,rdown)
                Qsroad=float(dcp_s@Fb+omega_s@Mb)
                mz_body=Rw@np.array([0.0,0.0,out.Mz])
                Qmz=float(omega_s@mz_body)

                spring_l=float(vals["spring_length"]); js=float(dqv["spring_length"])
                spring_force=self._preload_axial_n[k]+c.spring_rate_n_m[k]*(self._spring_ref_length-spring_l)
                Qspring=float(spring_force*js)
                qdot=(float(qs[k])-q0[k])/dt
                # Damper shaft rate uses both jounce and steering-coordinate Jacobians.
                dldq=float(dqv["damper_length"]); dlds_local=float(dsv["damper_length"])
                sdot_local=steer_rate if k%2==0 else -steer_rate
                ldot=dldq*qdot+dlds_local*sdot_local
                damper_force=-c.damper_rate_n_s_m[k]*ldot
                Qdamper=float(damper_force*dldq)

                arb_coords[k]=float(vals["arb_coord"]); arb_dq[k]=float(dqv["arb_coord"])
                cache.append((vals,dqv,rv,cp,out,trial,Fb,Mb,Qc,Qspring,Qdamper,Qsroad,Qmz,Re))
                forces.append(Fb); moments.append(np.cross(cp,Fb)+Mb); tire_trials.append(trial)
                q_contact.append(Qc); qspring.append(Qspring); qdamper.append(Qdamper); qsteer.append(Qsroad); qmz.append(Qmz)

            for axle,(l,rgt) in enumerate(((0,1),(2,3))):
                theta=arb_coords[l]-arb_coords[rgt]
                kb=c.arb_stiffness[axle]
                qarb[l]=-kb*theta*arb_dq[l]
                qarb[rgt]=+kb*theta*arb_dq[rgt]

            rows=[]
            sample=self.engine_owner.evaluate(p.engine_ticket,we)
            rows.append(Ie*(we-p.snapshot.engine.omega_rad_s)-dt*sample.free_torque_nm-j)
            for k in range(4):
                out=cache[k][4]
                rows.append(Iw[k]*(wheels[k]-w0[k])+mapping[k]*j+out.R_eff*out.Fx*dt-dt*out.rolling_resistance_torque)

            Ft=np.sum(np.asarray(forces),axis=0)+np.asarray(aero.force_body_n)
            # Body-axis Newton-Euler with standard transport terms.
            rows.append(c.mass_kg*((u-u0)-dt*rr*v)-dt*Ft[0])
            rows.append(c.mass_kg*((v-v0)+dt*rr*u)-dt*Ft[1])
            total_m=np.sum(np.asarray(moments),axis=0)+np.asarray(aero.moment_body_nm_at_ref)
            rows.append(c.yaw_inertia_kg_m2*(rr-r0)-dt*total_m[2])
            rows.append(we-float(mapping@wheels))

            for k in range(4):
                rows.append(qspring[k]+qdamper[k]+qarb[k]+q_contact[k])
            for k in range(4):
                out=cache[k][4]
                # Existing synthetic compliance reference: remove its unloaded 0.1*q kinematics term.
                load_increment=additive_compliance_model(float(qs[k]),out.Fy,out.Mz)-additive_compliance_model(float(qs[k]),0.0,0.0)
                rows.append(float(comps[k]-load_increment))
            for k in range(4):
                cp=cache[k][3]
                # Small-angle rigid platform -> flat-road contact gap.
                gap=platform.heave_m + platform.roll_rad*cp[1] - platform.pitch_rad*cp[0] + cp[2]
                rows.append(float(gap))
            # Quasi-static platform closure, not dynamic heave/pitch/roll ownership.
            rows.append(float(np.sum(fzs)+aero.force_body_n[2]-c.mass_kg*c.gravity_m_s2))
            rows.append(float(total_m[0]))
            rows.append(float(total_m[1]))

            if store:
                corner_objs=[]
                for k in range(4):
                    vals,dqv,rv,cp,out,trial,Fb,Mb,Qc,Qsp,Qd,Qsr,Qm,Re=cache[k]
                    corner_objs.append(CornerEvaluation(
                        float(qs[k]),float(fzs[k]),float(rv[2]),float(rv[0]),float(comps[k]),tuple(map(float,cp)),out,trial,
                        tuple(map(float,Fb)),tuple(map(float,Mb)),float(Qc),float(Qsp),float(Qd),float(qarb[k]),float(Qsr),float(Qm)
                    ))
                last.update(corners=tuple(corner_objs),aero=aero,total_m=total_m,forces=tuple(forces),sample=sample)
            return np.asarray(rows,float)

        def scaled(x: np.ndarray) -> np.ndarray:
            return equations(x)/scales

        try:
            sol=least_squares(scaled,x0,bounds=(lo,hi),xtol=tol,ftol=tol,gtol=tol,max_nfev=maxeval,x_scale="jac")
            raw=equations(sol.x,store=True)
            scaled_inf=float(np.max(np.abs(raw/scales)))
            if not sol.success or scaled_inf > max(2.0e-6, 20*tol):
                raise RuntimeError(f"final cross-system solve failed: {sol.message}; scaled_inf={scaled_inf:.3g}")
            we=float(sol.x[WE]); wheels=tuple(map(float,sol.x[W])); u=float(sol.x[U]); v=float(sol.x[V]); rr=float(sol.x[R]); j=float(sol.x[J])
            qs=tuple(map(float,sol.x[Q])); fzs=tuple(map(float,sol.x[FZ])); platform=PlatformSolution(float(sol.x[H]),float(sol.x[PITCH]),float(sol.x[ROLL]))
            corners=last["corners"]; aero=last["aero"]
            assert isinstance(corners,tuple) and isinstance(aero,AeroEvaluation)
            self.engine_owner.validate_commit(p.engine_ticket,we)
            next_engine=replace(p.engine_ticket.trial.next_controller_state,omega_rad_s=we)
            next_state=FinalCloseoutState(
                engine=next_engine,wheel_omega_rad_s=wheels,u_m_s=u,v_m_s=v,yaw_rate_rad_s=rr,
                yaw_rad=p.snapshot.yaw_rad+dt*rr,tire_states=tuple(cc.tire_state_trial for cc in corners),
                suspension_q_m=qs,platform=platform,steering_coordinate_rad=p.steering_coordinate_rad,
            )
            # Independently reconstruct wheel torque balance instead of subtracting an expression from itself.
            errs=[]
            for k,cc in enumerate(corners):
                lhs=Iw[k]*(wheels[k]-w0[k])/dt
                rhs=-mapping[k]*j/dt-cc.tire.R_eff*cc.tire.Fx+cc.tire.rolling_resistance_torque
                errs.append(abs(lhs-rhs))
            return SolvedFinalStep(
                prepared=p,next_state=next_state,corners=corners,aero=aero,normal_loads_n=fzs,clutch_impulse_nms=j,
                steering_road_generalized_load=float(sum(cc.steering_road_q for cc in corners)),
                steering_mz_generalized_contribution=float(sum(cc.steering_mz_contribution for cc in corners)),
                residual_scaled_inf=scaled_inf,nonlinear_evaluations=int(sol.nfev),
                action_reaction_wheel_torque_error_nm=float(max(errs)),
                vertical_wrench_residual_n=float(raw[-3]),roll_wrench_residual_nm=float(raw[-2]),pitch_wrench_residual_nm=float(raw[-1]),
                committed=False,
            )
        except Exception:
            # solve() itself remains transactional. The caller may inspect/fail and then abort().
            raise

    def commit(self, solved: SolvedFinalStep) -> SolvedFinalStep:
        p=solved.prepared
        self._check_prepared(p)
        # Engine preflight was already done by solve; validate again before the only mutations.
        self.engine_owner.validate_commit(p.engine_ticket, solved.next_state.engine.omega_rad_s)
        eng=self.engine_owner.commit(p.engine_ticket, solved.next_state.engine.omega_rad_s)
        self.state=replace(solved.next_state,engine=eng)
        self._last_fz_guess=np.array(solved.normal_loads_n,float)
        self._last_comp_guess=np.array([cc.compliance_steer_rad for cc in solved.corners],float)
        self._open_token=None
        return replace(solved,next_state=self.state,committed=True)

    def abort(self, p: PreparedFinalStep) -> FinalCloseoutState:
        self._check_prepared(p)
        self.engine_owner.abort(p.engine_ticket)
        self._open_token=None
        return self.state

    def step(self, command: EngineCommand, dt: float, steering_coordinate_rad: float, *, tolerance: float | None = None) -> SolvedFinalStep:
        p=self.prepare(command,dt,steering_coordinate_rad)
        try:
            s=self.solve(p,tolerance=tolerance)
            return self.commit(s)
        except Exception:
            self.abort(p)
            raise


def half_cosine_steer(t: float, ramp_s: float = 0.35, amplitude_rad: float = 0.18) -> float:
    if t <= 0: return 0.0
    if t >= ramp_s: return amplitude_rad
    x=t/ramp_s
    return amplitude_rad*0.5*(1.0-math.cos(math.pi*x))


def run_maneuver(hz: int, *, duration_s: float = 0.55, tolerance: float = 2e-9, throttle: float = 0.32, ramp_s: float = 0.35, amplitude_rad: float = 0.18) -> dict:
    sys=FinalCrossSystemCloseout.synthetic(speed_m_s=15.0)
    dt=1.0/float(hz)
    n=int(round(duration_s*hz))
    peak_fy=0.0; peak_mz=0.0; peak_steer_load=0.0; min_fz=float("inf"); max_fz=0.0; max_res=0.0; evals=0
    for i in range(n):
        t=(i+1)*dt
        steer=half_cosine_steer(t,ramp_s=ramp_s,amplitude_rad=amplitude_rad)
        r=sys.step(EngineCommand(throttle_request=throttle),dt,steer,tolerance=tolerance)
        peak_fy=max(peak_fy,max(abs(cc.tire.Fy) for cc in r.corners))
        peak_mz=max(peak_mz,max(abs(cc.tire.Mz) for cc in r.corners))
        peak_steer_load=max(peak_steer_load,abs(r.steering_road_generalized_load))
        min_fz=min(min_fz,min(r.normal_loads_n)); max_fz=max(max_fz,max(r.normal_loads_n)); max_res=max(max_res,r.residual_scaled_inf); evals+=r.nonlinear_evaluations
    s=sys.state
    return {
        "hz":hz,"dt_s":dt,"steps":n,"final_u_m_s":s.u_m_s,"final_v_m_s":s.v_m_s,"final_yaw_rate_rad_s":s.yaw_rate_rad_s,
        "final_yaw_rad":s.yaw_rad,"peak_abs_Fy_N":peak_fy,"peak_abs_Mz_Nm":peak_mz,"peak_abs_steering_Q":peak_steer_load,
        "min_Fz_N":min_fz,"max_Fz_N":max_fz,"max_scaled_residual":max_res,"total_nonlinear_evaluations":evals,
        "final_tire_states":[{"sx":x.sx,"sy":x.sy,"sgamma":x.sgamma,"mode":x.mode.name} for x in s.tire_states],
    }
