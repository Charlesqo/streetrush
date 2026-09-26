"""Reference Engine Behavior model for the accepted vehicle architecture.

The only mechanical shaft state is ``omega_rad_s``.  Controller memory and the
discrete run mode belong to Engine, but they are not extra rotating shafts.  A
coupled drivetrain solver asks for free torque and a local tangent, solves its
clutch/gear/wheel rows, then commits the solved engine speed exactly once.

This module deliberately does not contain a gearbox, differential, wheel,
tire, suspension, steering, or aerodynamic model.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum
import hashlib
import json
import math
from pathlib import Path
from typing import Any, Mapping, Sequence

import numpy as np


RPM_PER_RAD_S = 60.0 / (2.0 * math.pi)
RAD_S_PER_RPM = 1.0 / RPM_PER_RAD_S


def rpm_to_rad_s(rpm: float) -> float:
    return float(rpm) * RAD_S_PER_RPM


def rad_s_to_rpm(omega_rad_s: float) -> float:
    return float(omega_rad_s) * RPM_PER_RAD_S


class DomainError(ValueError):
    """The requested operating point is outside the declared model domain."""


class TorqueSemantics(str, Enum):
    """Meaning of the supplied torque tables.

    NET_BRAKE_MAP
        Both closed- and full-throttle curves are already net crankshaft
        torque under the declared accessory/test condition.  No extra generic
        friction is subtracted.

    GROSS_COMBUSTION_PLUS_LOSS
        The full curve is gross combustion torque.  Part load scales that
        positive source and the separate loss curve is subtracted once.
    """

    NET_BRAKE_MAP = "NET_BRAKE_MAP"
    GROSS_COMBUSTION_PLUS_LOSS = "GROSS_COMBUSTION_PLUS_LOSS"
    FULL_LOAD_ONLY = "FULL_LOAD_ONLY"


class InterpolationPolicy(str, Enum):
    PIECEWISE_LINEAR = "PIECEWISE_LINEAR"
    PCHIP = "PCHIP"


class EngineMode(str, Enum):
    OFF = "OFF"
    CRANKING = "CRANKING"
    RUNNING = "RUNNING"
    STALLED = "STALLED"


@dataclass(frozen=True)
class Curve1D:
    rpm: tuple[float, ...]
    torque_nm: tuple[float, ...]
    interpolation: InterpolationPolicy = InterpolationPolicy.PCHIP

    def __post_init__(self) -> None:
        x = np.asarray(self.rpm, dtype=float)
        y = np.asarray(self.torque_nm, dtype=float)
        if len(x) < 2 or x.shape != y.shape:
            raise ValueError("curve requires matching rpm/torque arrays with >=2 knots")
        if not np.all(np.isfinite(x)) or not np.all(np.isfinite(y)):
            raise ValueError("curve contains non-finite data")
        if x[0] < 0.0 or not np.all(np.diff(x) > 0.0):
            raise ValueError("rpm knots must be non-negative and strictly increasing")

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any]) -> "Curve1D":
        return cls(
            tuple(map(float, data["rpm"])),
            tuple(map(float, data["torque_nm"])),
            InterpolationPolicy(data.get("interpolation", "PCHIP")),
        )

    @property
    def min_rpm(self) -> float:
        return self.rpm[0]

    @property
    def max_rpm(self) -> float:
        return self.rpm[-1]

    def _interval(self, rpm: float) -> int:
        x = float(rpm)
        if x < self.min_rpm - 1e-12 or x > self.max_rpm + 1e-12:
            raise DomainError(
                f"curve query {x:.6g} rpm outside [{self.min_rpm}, {self.max_rpm}]"
            )
        if x <= self.min_rpm:
            i = 0
        elif x >= self.max_rpm:
            return len(self.rpm) - 2
        else:
            return int(np.searchsorted(np.asarray(self.rpm), x, side="right")) - 1
        return 0

    def _pchip_slopes(self) -> np.ndarray:
        """Fritsch-Carlson/Fritsch-Butland shape-preserving knot slopes."""
        x = np.asarray(self.rpm, dtype=float)
        y = np.asarray(self.torque_nm, dtype=float)
        h = np.diff(x)
        delta = np.diff(y) / h
        n = len(x)
        slopes = np.zeros(n, dtype=float)
        if n == 2:
            slopes[:] = delta[0]
            return slopes
        for k in range(1, n - 1):
            if delta[k - 1] == 0.0 or delta[k] == 0.0 or np.sign(delta[k - 1]) != np.sign(delta[k]):
                slopes[k] = 0.0
            else:
                w1 = 2.0 * h[k] + h[k - 1]
                w2 = h[k] + 2.0 * h[k - 1]
                slopes[k] = (w1 + w2) / (w1 / delta[k - 1] + w2 / delta[k])

        def endpoint(h0: float, h1: float, d0: float, d1: float) -> float:
            value = ((2.0 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
            if np.sign(value) != np.sign(d0):
                return 0.0
            if np.sign(d0) != np.sign(d1) and abs(value) > abs(3.0 * d0):
                return 3.0 * d0
            return value

        slopes[0] = endpoint(h[0], h[1], delta[0], delta[1])
        slopes[-1] = endpoint(h[-1], h[-2], delta[-1], delta[-2])
        return slopes

    def sample_rpm(self, rpm: float) -> tuple[float, float]:
        """Return torque and analytic dTorque/dRPM inside the declared domain."""
        x = float(rpm)
        i = self._interval(x)
        x0, x1 = self.rpm[i], self.rpm[i + 1]
        y0, y1 = self.torque_nm[i], self.torque_nm[i + 1]
        slope = (y1 - y0) / (x1 - x0)
        if self.interpolation is InterpolationPolicy.PIECEWISE_LINEAR:
            return y0 + slope * (x - x0), slope
        h = x1 - x0
        t = (x - x0) / h
        m = self._pchip_slopes()
        h00 = 2.0 * t**3 - 3.0 * t**2 + 1.0
        h10 = t**3 - 2.0 * t**2 + t
        h01 = -2.0 * t**3 + 3.0 * t**2
        h11 = t**3 - t**2
        value = h00 * y0 + h10 * h * m[i] + h01 * y1 + h11 * h * m[i + 1]
        dh00 = (6.0 * t**2 - 6.0 * t) / h
        dh10 = 3.0 * t**2 - 4.0 * t + 1.0
        dh01 = (-6.0 * t**2 + 6.0 * t) / h
        dh11 = 3.0 * t**2 - 2.0 * t
        derivative = dh00 * y0 + dh10 * m[i] + dh01 * y1 + dh11 * m[i + 1]
        return float(value), float(derivative)

    def sample_omega(self, omega_rad_s: float) -> tuple[float, float]:
        value, dvalue_drpm = self.sample_rpm(rad_s_to_rpm(omega_rad_s))
        return value, dvalue_drpm * RPM_PER_RAD_S


@dataclass(frozen=True)
class EngineAsset:
    dataset_id: str
    semantics: TorqueSemantics
    full_curve: Curve1D
    closed_curve: Curve1D | None
    loss_curve: Curve1D | None
    inertia_kg_m2: float
    idle_rpm: float
    idle_kp_nm_per_rad_s: float
    idle_max_torque_nm: float
    stall_zero_rpm: float
    stall_detect_rpm: float
    stall_hold_s: float
    fire_rpm: float
    min_crank_s: float
    starter_torque_nm: float
    rev_limit_rpm: float
    rev_resume_rpm: float
    hard_overspeed_rpm: float
    torque_lag_s: float = 0.0
    environment: Mapping[str, Any] = field(default_factory=dict)
    source_kind: str = "SYNTHETIC"
    source_note: str = ""

    def __post_init__(self) -> None:
        if self.semantics is TorqueSemantics.NET_BRAKE_MAP:
            if self.closed_curve is None or self.loss_curve is not None:
                raise ValueError("NET_BRAKE_MAP requires closed_curve and forbids loss_curve")
            curves = (self.full_curve, self.closed_curve)
        elif self.semantics is TorqueSemantics.GROSS_COMBUSTION_PLUS_LOSS:
            if self.closed_curve is not None or self.loss_curve is None:
                raise ValueError(
                    "GROSS_COMBUSTION_PLUS_LOSS requires loss_curve and forbids closed_curve"
                )
            curves = (self.full_curve, self.loss_curve)
        else:
            if self.closed_curve is not None or self.loss_curve is not None:
                raise ValueError("FULL_LOAD_ONLY accepts only a full_curve")
            curves = (self.full_curve,)
        base_knots = curves[0].rpm
        if any(c.rpm != base_knots for c in curves[1:]):
            raise ValueError("reference backend requires all torque curves to share rpm knots")
        if self.inertia_kg_m2 <= 0.0:
            raise ValueError("engine inertia must be positive")
        ordered = (
            0.0 <= self.stall_zero_rpm
            < self.stall_detect_rpm
            < self.fire_rpm
            < self.idle_rpm
            < self.rev_resume_rpm
            < self.rev_limit_rpm
            < self.hard_overspeed_rpm
            <= self.full_curve.max_rpm
        )
        if not ordered:
            raise ValueError("stall/idle/limiter speeds are not strictly ordered or mapped")
        if min(
            self.idle_kp_nm_per_rad_s,
            self.idle_max_torque_nm,
            self.stall_hold_s,
            self.min_crank_s,
            self.starter_torque_nm,
            self.torque_lag_s,
        ) < 0.0:
            raise ValueError("engine controller parameters cannot be negative")

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "EngineAsset":
        semantics = TorqueSemantics(data["semantics"])
        return cls(
            dataset_id=str(data["dataset_id"]),
            semantics=semantics,
            full_curve=Curve1D.from_mapping(data["full_curve"]),
            closed_curve=(
                Curve1D.from_mapping(data["closed_curve"])
                if data.get("closed_curve") is not None
                else None
            ),
            loss_curve=(
                Curve1D.from_mapping(data["loss_curve"])
                if data.get("loss_curve") is not None
                else None
            ),
            inertia_kg_m2=float(data["inertia_kg_m2"]),
            idle_rpm=float(data["idle_rpm"]),
            idle_kp_nm_per_rad_s=float(data["idle_kp_nm_per_rad_s"]),
            idle_max_torque_nm=float(data["idle_max_torque_nm"]),
            stall_zero_rpm=float(data["stall_zero_rpm"]),
            stall_detect_rpm=float(data["stall_detect_rpm"]),
            stall_hold_s=float(data["stall_hold_s"]),
            fire_rpm=float(data["fire_rpm"]),
            min_crank_s=float(data["min_crank_s"]),
            starter_torque_nm=float(data["starter_torque_nm"]),
            rev_limit_rpm=float(data["rev_limit_rpm"]),
            rev_resume_rpm=float(data["rev_resume_rpm"]),
            hard_overspeed_rpm=float(data["hard_overspeed_rpm"]),
            torque_lag_s=float(data.get("torque_lag_s", 0.0)),
            environment=dict(data.get("environment", {})),
            source_kind=str(data.get("source_kind", "SYNTHETIC")),
            source_note=str(data.get("source_note", "")),
        )

    @classmethod
    def from_json(cls, path: str | Path) -> "EngineAsset":
        return cls.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))

    def canonical_payload(self) -> Mapping[str, Any]:
        def curve_payload(curve: Curve1D | None) -> Mapping[str, Any] | None:
            if curve is None:
                return None
            return {
                "rpm": list(curve.rpm),
                "torque_nm": list(curve.torque_nm),
                "interpolation": curve.interpolation.value,
            }

        return {
            "dataset_id": self.dataset_id,
            "semantics": self.semantics.value,
            "full_curve": curve_payload(self.full_curve),
            "closed_curve": curve_payload(self.closed_curve),
            "loss_curve": curve_payload(self.loss_curve),
            "inertia_kg_m2": self.inertia_kg_m2,
            "idle_rpm": self.idle_rpm,
            "idle_kp_nm_per_rad_s": self.idle_kp_nm_per_rad_s,
            "idle_max_torque_nm": self.idle_max_torque_nm,
            "stall_zero_rpm": self.stall_zero_rpm,
            "stall_detect_rpm": self.stall_detect_rpm,
            "stall_hold_s": self.stall_hold_s,
            "fire_rpm": self.fire_rpm,
            "min_crank_s": self.min_crank_s,
            "starter_torque_nm": self.starter_torque_nm,
            "rev_limit_rpm": self.rev_limit_rpm,
            "rev_resume_rpm": self.rev_resume_rpm,
            "hard_overspeed_rpm": self.hard_overspeed_rpm,
            "torque_lag_s": self.torque_lag_s,
            "environment": dict(self.environment),
            "source_kind": self.source_kind,
            "source_note": self.source_note,
        }

    def content_hash(self) -> str:
        payload = json.dumps(
            self.canonical_payload(), sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
        return hashlib.sha256(payload).hexdigest()

    def _sample_curves(self, load: float, omega_rad_s: float) -> tuple[float, float]:
        u = float(np.clip(load, 0.0, 1.0))
        full, dfull = self.full_curve.sample_omega(omega_rad_s)
        if self.semantics is TorqueSemantics.NET_BRAKE_MAP:
            assert self.closed_curve is not None
            closed, dclosed = self.closed_curve.sample_omega(omega_rad_s)
            return closed + u * (full - closed), dclosed + u * (dfull - dclosed)
        if self.semantics is TorqueSemantics.GROSS_COMBUSTION_PLUS_LOSS:
            assert self.loss_curve is not None
            loss, dloss = self.loss_curve.sample_omega(omega_rad_s)
            return u * full - loss, u * dfull - dloss
        if abs(u - 1.0) > 1e-12:
            raise DomainError("FULL_LOAD_ONLY has no part-throttle or overrun authority")
        return full, dfull

    def net_torque(self, load: float, omega_rad_s: float) -> tuple[float, float]:
        """Return net free torque and local dT/domega without controller additions."""
        self.validate_omega_domain(omega_rad_s)
        return self._sample_curves(load, max(0.0, omega_rad_s))

    def validate_omega_domain(self, omega_rad_s: float) -> None:
        rpm = rad_s_to_rpm(omega_rad_s)
        if rpm < -1e-9:
            raise DomainError("reduced ICE backend does not permit negative crank speed")
        if rpm > self.hard_overspeed_rpm + 1e-9:
            raise DomainError(
                f"engine speed {rpm:.2f} rpm exceeds hard domain {self.hard_overspeed_rpm:.2f}"
            )


@dataclass(frozen=True)
class EngineCommand:
    throttle_request: float = 0.0
    positive_torque_limit: float = 1.0
    ignition_on: bool = True
    start_request: bool = False

    def validated(self) -> "EngineCommand":
        vals = (self.throttle_request, self.positive_torque_limit)
        if not all(math.isfinite(v) for v in vals):
            raise ValueError("engine command contains non-finite value")
        return replace(
            self,
            throttle_request=float(np.clip(self.throttle_request, 0.0, 1.0)),
            positive_torque_limit=float(np.clip(self.positive_torque_limit, 0.0, 1.0)),
        )


@dataclass(frozen=True)
class EngineState:
    omega_rad_s: float
    mode: EngineMode = EngineMode.OFF
    load_actuated: float = 0.0
    limiter_cut: bool = False
    below_stall_s: float = 0.0
    crank_elapsed_s: float = 0.0

    @property
    def rpm(self) -> float:
        return rad_s_to_rpm(self.omega_rad_s)


@dataclass(frozen=True)
class EngineControlTrial:
    """Controller/mode result advanced exactly once from a canonical snapshot."""

    snapshot: EngineState
    command: EngineCommand
    dt: float
    effective_load: float
    next_controller_state: EngineState
    events: tuple[str, ...]


@dataclass(frozen=True)
class EngineTorqueSample:
    free_torque_nm: float
    dtorque_domega_nm_per_rad_s: float
    map_torque_nm: float
    idle_torque_nm: float
    starter_torque_nm: float
    effective_load: float
    evaluated_omega_rad_s: float
    domain_status: str


@dataclass(frozen=True)
class PreparedEngineTorque(EngineTorqueSample):
    next_state: EngineState
    events: tuple[str, ...]
    trial: EngineControlTrial


@dataclass(frozen=True)
class EngineStepResult:
    state: EngineState
    prepared: PreparedEngineTorque
    clutch_reaction_nm: float
    zero_speed_stop_impulse_nms: float
    free_power_w: float
    nonlinear_residual_nms: float
    nonlinear_iterations: int


class EngineModel:
    def __init__(self, asset: EngineAsset):
        self.asset = asset

    @staticmethod
    def _smoothstep01(x: float) -> tuple[float, float]:
        u = float(np.clip(x, 0.0, 1.0))
        return u * u * (3.0 - 2.0 * u), 6.0 * u * (1.0 - u)

    def _advance_mode(
        self, state: EngineState, command: EngineCommand, dt: float
    ) -> tuple[EngineMode, float, float, tuple[str, ...]]:
        a = self.asset
        mode = state.mode
        below = state.below_stall_s
        crank = state.crank_elapsed_s
        events: list[str] = []
        rpm = state.rpm

        if not command.ignition_on:
            if mode is not EngineMode.OFF:
                events.append("IGNITION_OFF")
            return EngineMode.OFF, 0.0, 0.0, tuple(events)

        if mode in (EngineMode.OFF, EngineMode.STALLED):
            if command.start_request:
                events.append("STARTER_ENGAGED")
                return EngineMode.CRANKING, 0.0, 0.0, tuple(events)
            if rpm >= a.fire_rpm:
                events.append("BUMP_START")
                return EngineMode.RUNNING, 0.0, 0.0, tuple(events)
            return mode, 0.0, 0.0, tuple(events)

        if mode is EngineMode.CRANKING:
            crank += dt
            if rpm >= a.fire_rpm and crank >= a.min_crank_s:
                events.append("ENGINE_FIRED")
                return EngineMode.RUNNING, 0.0, 0.0, tuple(events)
            return mode, 0.0, crank, tuple(events)

        if rpm < a.stall_detect_rpm:
            below += dt
        else:
            below = 0.0
        if below >= a.stall_hold_s:
            events.append("ENGINE_STALLED")
            return EngineMode.STALLED, 0.0, 0.0, tuple(events)
        return EngineMode.RUNNING, below, 0.0, tuple(events)

    def prepare_control(
        self, state: EngineState, command: EngineCommand, dt: float
    ) -> EngineControlTrial:
        """Advance controller/mode memory once without mutating canonical state.

        The returned trial may be evaluated at any number of predicted shaft
        speeds.  Those evaluations are pure and do not advance controller time.
        """
        if not math.isfinite(dt) or dt <= 0.0:
            raise ValueError("dt must be finite and positive")
        if not math.isfinite(state.omega_rad_s):
            raise ValueError("engine omega must be finite")
        command = command.validated()
        a = self.asset
        # Strict domain check happens before any controller can disguise it.
        a.validate_omega_domain(state.omega_rad_s)

        mode, below, crank, mode_events = self._advance_mode(state, command, dt)
        events = list(mode_events)
        limiter_cut = state.limiter_cut if mode is EngineMode.RUNNING else False
        if mode is EngineMode.RUNNING:
            if not limiter_cut and state.rpm >= a.rev_limit_rpm:
                limiter_cut = True
                events.append("REV_LIMIT_CUT")
            elif limiter_cut and state.rpm <= a.rev_resume_rpm:
                limiter_cut = False
                events.append("REV_LIMIT_RESUME")

        target_load = command.throttle_request * command.positive_torque_limit
        if mode is not EngineMode.RUNNING or limiter_cut:
            target_load = 0.0
        if a.torque_lag_s > 0.0:
            decay = math.exp(-dt / a.torque_lag_s)
            load_actuated = target_load + (state.load_actuated - target_load) * decay
        else:
            load_actuated = target_load
        load_actuated = float(np.clip(load_actuated, 0.0, 1.0))

        next_state = EngineState(
            omega_rad_s=state.omega_rad_s,
            mode=mode,
            load_actuated=load_actuated,
            limiter_cut=limiter_cut,
            below_stall_s=below,
            crank_elapsed_s=crank,
        )
        effective_load = 0.0 if mode is not EngineMode.RUNNING or limiter_cut else load_actuated
        return EngineControlTrial(
            snapshot=state,
            command=command,
            dt=dt,
            effective_load=effective_load,
            next_controller_state=next_state,
            events=tuple(events),
        )

    def evaluate_trial(self, trial: EngineControlTrial, omega_rad_s: float) -> EngineTorqueSample:
        """Evaluate frozen Engine control at a predicted shaft speed."""
        a = self.asset
        a.validate_omega_domain(omega_rad_s)
        mode = trial.next_controller_state.mode
        limiter_cut = trial.next_controller_state.limiter_cut
        map_torque = 0.0
        idle_torque = 0.0
        starter_torque = 0.0
        dtorque = 0.0
        domain_status = "IN_DOMAIN"

        if mode is EngineMode.RUNNING:
            map_torque, dmap = a.net_torque(trial.effective_load, omega_rad_s)
            full_torque, dfull = a.net_torque(1.0, omega_rad_s)
            dtorque = dmap
            if not limiter_cut and omega_rad_s < rpm_to_rad_s(a.idle_rpm):
                raw_idle = a.idle_kp_nm_per_rad_s * (rpm_to_rad_s(a.idle_rpm) - omega_rad_s)
                raw_idle = float(np.clip(raw_idle, 0.0, a.idle_max_torque_nm))
                headroom = max(0.0, full_torque - map_torque)
                idle_torque = min(raw_idle, headroom)
                if 0.0 < raw_idle < a.idle_max_torque_nm and raw_idle < headroom:
                    dtorque -= a.idle_kp_nm_per_rad_s
                elif headroom > 0.0 and headroom <= raw_idle:
                    dtorque = dfull

            pre_stall_torque = map_torque + idle_torque
            rpm = rad_s_to_rpm(omega_rad_s)
            if rpm <= a.stall_zero_rpm:
                blend, dblend_drpm = 0.0, 0.0
                domain_status = "STALL_ZERO_BLEND"
            elif rpm >= a.stall_detect_rpm:
                blend, dblend_drpm = 1.0, 0.0
            else:
                span = a.stall_detect_rpm - a.stall_zero_rpm
                blend, dshape = self._smoothstep01((rpm - a.stall_zero_rpm) / span)
                dblend_drpm = dshape / span
                domain_status = "STALL_TRANSITION_BLEND"
            free_torque = blend * pre_stall_torque
            dtorque = blend * dtorque + pre_stall_torque * dblend_drpm * RPM_PER_RAD_S
            if limiter_cut:
                domain_status = "REV_LIMIT_AUTHORITY_CUT"
        elif mode is EngineMode.CRANKING:
            starter_torque = a.starter_torque_nm if trial.command.start_request else 0.0
            free_torque = starter_torque
            domain_status = "CRANKING"
        else:
            free_torque = 0.0
            domain_status = mode.value

        return EngineTorqueSample(
            free_torque_nm=float(free_torque),
            dtorque_domega_nm_per_rad_s=float(dtorque),
            map_torque_nm=float(map_torque),
            idle_torque_nm=float(idle_torque),
            starter_torque_nm=float(starter_torque),
            effective_load=trial.effective_load,
            evaluated_omega_rad_s=float(omega_rad_s),
            domain_status=domain_status,
        )

    def prepare(
        self, state: EngineState, command: EngineCommand, dt: float
    ) -> PreparedEngineTorque:
        """Compatibility convenience: prepare once and sample at snapshot omega."""
        trial = self.prepare_control(state, command, dt)
        sample = self.evaluate_trial(trial, state.omega_rad_s)
        return PreparedEngineTorque(
            **sample.__dict__,
            next_state=trial.next_controller_state,
            events=trial.events,
            trial=trial,
        )

    def solve_backward_euler_trial(
        self,
        trial: EngineControlTrial,
        omega0_rad_s: float,
        external_engine_impulse_nms: float,
        max_iterations: int = 60,
        residual_tolerance_nms: float = 1e-10,
    ) -> tuple[float, EngineTorqueSample, float, int, float]:
        """Safeguarded Newton solve of one Engine row with frozen control.

        ``external_engine_impulse_nms`` is signed impulse applied *to* the
        engine by clutch/starter-external fixtures.  Starter torque owned by
        Engine is already included in the trial law.
        """
        if not math.isfinite(external_engine_impulse_nms):
            raise ValueError("external engine impulse must be finite")
        inertia = self.asset.inertia_kg_m2
        upper = rpm_to_rad_s(self.asset.hard_overspeed_rpm)

        def residual(x: float) -> tuple[float, EngineTorqueSample]:
            sample = self.evaluate_trial(trial, x)
            value = inertia * (x - omega0_rad_s) - trial.dt * sample.free_torque_nm - external_engine_impulse_nms
            return float(value), sample

        f_lo, sample_lo = residual(0.0)
        if f_lo >= 0.0:
            # Unconstrained solution would reverse the reduced ICE shaft.  The
            # stop impulse is a unilateral zero-speed reaction, not idle magic.
            return 0.0, sample_lo, 0.0, 0, float(f_lo)
        f_hi, _ = residual(upper)
        if f_hi <= 0.0:
            raise DomainError("Backward-Euler root lies above the hard engine domain")

        lo, hi = 0.0, upper
        x = float(np.clip(omega0_rad_s, lo, hi))
        sample = self.evaluate_trial(trial, x)
        f = math.inf
        scale = max(1.0, abs(external_engine_impulse_nms), inertia * max(1.0, omega0_rad_s))
        tolerance = residual_tolerance_nms * scale
        for iteration in range(1, max_iterations + 1):
            f, sample = residual(x)
            if abs(f) <= tolerance:
                return x, sample, abs(f), iteration, 0.0
            if f > 0.0:
                hi = x
            else:
                lo = x
            derivative = inertia - trial.dt * sample.dtorque_domega_nm_per_rad_s
            candidate = x - f / derivative if derivative > 0.0 else math.nan
            if not math.isfinite(candidate) or candidate <= lo or candidate >= hi:
                candidate = 0.5 * (lo + hi)
            x = candidate
        raise RuntimeError(f"engine Backward-Euler did not converge; residual={f:.6g} Nms")

    def integrate_standalone(
        self,
        state: EngineState,
        command: EngineCommand,
        clutch_reaction_nm: float,
        dt: float,
    ) -> EngineStepResult:
        """Scalar Backward-Euler one-shaft fixture, not the production clutch solve.

        Positive ``clutch_reaction_nm`` removes torque from the engine.  A
        negative value back-drives it.  The zero-speed projection represents a
        unilateral crank-stop constraint, not an idle clamp.
        """
        if not math.isfinite(clutch_reaction_nm):
            raise ValueError("clutch reaction must be finite")
        trial = self.prepare_control(state, command, dt)
        omega_next, sample, residual, iterations, stop_impulse = self.solve_backward_euler_trial(
            trial,
            state.omega_rad_s,
            external_engine_impulse_nms=-clutch_reaction_nm * dt,
        )
        next_state = replace(trial.next_controller_state, omega_rad_s=float(omega_next))
        prepared = PreparedEngineTorque(
            **sample.__dict__,
            next_state=trial.next_controller_state,
            events=trial.events,
            trial=trial,
        )
        return EngineStepResult(
            state=next_state,
            prepared=prepared,
            clutch_reaction_nm=float(clutch_reaction_nm),
            zero_speed_stop_impulse_nms=float(stop_impulse),
            free_power_w=float(prepared.free_torque_nm * omega_next),
            nonlinear_residual_nms=float(residual),
            nonlinear_iterations=iterations,
        )


@dataclass(frozen=True)
class EngineSolveTicket:
    token: int
    snapshot: EngineState
    trial: EngineControlTrial
    prepared: PreparedEngineTorque


class EngineOwner:
    """Tiny ownership fixture that enforces one commit per begun substep."""

    def __init__(self, model: EngineModel, initial_state: EngineState):
        self.model = model
        self.state = initial_state
        self._next_token = 1
        self._open_token: int | None = None

    def begin_substep(self, command: EngineCommand, dt: float) -> EngineSolveTicket:
        if self._open_token is not None:
            raise RuntimeError("previous engine substep has not been committed")
        token = self._next_token
        # Prepare before opening the transaction.  A malformed command, dt, or
        # out-of-domain snapshot must not leave the owner permanently locked.
        trial = self.model.prepare_control(self.state, command, dt)
        sample = self.model.evaluate_trial(trial, self.state.omega_rad_s)
        prepared = PreparedEngineTorque(
            **sample.__dict__,
            next_state=trial.next_controller_state,
            events=trial.events,
            trial=trial,
        )
        self._next_token += 1
        self._open_token = token
        return EngineSolveTicket(token, self.state, trial, prepared)

    def evaluate(self, ticket: EngineSolveTicket, predicted_omega_rad_s: float) -> EngineTorqueSample:
        if self._open_token != ticket.token:
            raise RuntimeError("stale Engine trial evaluation")
        return self.model.evaluate_trial(ticket.trial, predicted_omega_rad_s)

    def validate_commit(self, ticket: EngineSolveTicket, solved_omega_rad_s: float) -> None:
        """Preflight a commit without mutating canonical state.

        PowertrainVehicleSystem uses this together with GearboxOwner.validate_commit
        so that the subsequent two assignments are exception-free under the
        single-threaded ownership contract.
        """
        if self._open_token != ticket.token or ticket.snapshot is not self.state:
            raise RuntimeError("stale or duplicate Engine.commit")
        if solved_omega_rad_s < 0.0 or not math.isfinite(solved_omega_rad_s):
            raise ValueError("solver returned invalid engine omega")
        self.model.asset.validate_omega_domain(solved_omega_rad_s)

    def commit(self, ticket: EngineSolveTicket, solved_omega_rad_s: float) -> EngineState:
        self.validate_commit(ticket, solved_omega_rad_s)
        self.state = replace(ticket.trial.next_controller_state, omega_rad_s=float(solved_omega_rad_s))
        self._open_token = None
        return self.state

    def abort(self, ticket: EngineSolveTicket) -> EngineState:
        """Close a failed solver transaction without changing canonical state.

        Production active-set solvers may reject every candidate because the
        requested state lies outside a declared domain.  Leaving the ticket
        open would deadlock the owner on the following substep; committing a
        fallback speed would be an unauthorized state rewrite.  Abort is the
        explicit third outcome and is valid only for the currently open token.
        """
        if self._open_token != ticket.token:
            raise RuntimeError("stale or duplicate Engine.abort")
        if self.state is not ticket.snapshot:
            raise RuntimeError("Engine canonical state changed during open transaction")
        self._open_token = None
        return self.state

    def restore_group_snapshot(self, ticket: EngineSolveTicket) -> bool:
        """Restore this owner after a later participant failed group commit.

        Returns whether this owner had already closed or changed its canonical
        state, which lets the coordinator distinguish rollback from ordinary
        abort in its audit.  This is not a normal solver fallback path.
        """

        if self._open_token not in (ticket.token, None):
            raise RuntimeError("Engine group rollback found an unrelated open token")
        had_committed = self._open_token is None or self.state is not ticket.snapshot
        self.state = ticket.snapshot
        self._open_token = None
        return had_committed
