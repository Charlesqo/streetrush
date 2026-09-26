"""Final cross-system executable reference fixture.

This module is deliberately a *reduced planar reference host*, not a Rapier or
production 6-DOF vehicle implementation.  Within that declared scope it calls
the accepted subsystem implementations rather than replacing them with axle
load or steering surrogates:

* accepted Steering V2 input/rack/Ackermann and road-reaction implementation;
* accepted two-dimensional K&C map, its derivatives, spring/damper paths, ARB
  energy and additive compliance policy;
* accepted Tire V2 v1.7 steady/Mz and v1.8 transient policy behind the
  suspension adapters;
* the canonical Aero v1.9 six-component QSS wrench, shifted to the CG;
* the existing Engine and Gearbox transactional owners.

All nonlinear evaluations start from frozen canonical state.  Engine,
Gearbox, Steering, Tire, and mechanical state are preflighted together and
committed exactly once only after an accepted root has been re-evaluated.
Synthetic parameters exercise structure; they do not represent a target car.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from enum import Enum
import math
from pathlib import Path
from typing import Sequence

import numpy as np
from scipy.optimize import least_squares, root

from .aero_reference_v1_9 import (
    AeroEnvironment,
    AeroEvaluation,
    AeroPlatformSample,
    build_synthetic_race_aeromap,
    shift_wrench,
)
from .chassis_suspension_reference import (
    DomainError as KCDomainError,
    LinearARB,
    additive_compliance_model,
    build_synthetic_kc_map,
    exp_so3,
    rotvec_rate_to_spatial_omega,
)
from .engine_model import (
    EngineAsset,
    EngineCommand,
    EngineMode,
    EngineModel,
    EngineOwner,
    EngineState,
    rpm_to_rad_s,
)
from .powertrain_controller import (
    GearDefinition,
    GearboxAsset,
    GearboxCommand,
    GearboxController,
    GearboxOwner,
    GearboxState,
    ideal_open_differential_mapping,
)
from .steering_reference_v2 import (
    DeviceKind,
    InputConfig,
    RackState,
    SteeringCommand,
    SteeringGeometry,
    SteeringGeometryConfig,
    TorqueDrivenRack,
    TorqueRackConfig,
    TorqueRackEvaluation,
    WheelAngles,
)
from .steering_transaction import (
    SteeringCanonicalState,
    SteeringOwner,
    SteeringTransactionalModel,
)
from .tire_host_contract import (
    FinalContactKinematics,
    SuspensionContactPacket,
    adapt_contact,
)
from .accepted_tire_adapter import (
    TireModel,
    TireOutput,
    TireState,
    make_reference_model,
)
from .vehicle_controls_reference import (
    AssistEvaluation,
    BrakeAssistConfig,
    BrakeAssistController,
    DirectionFSMState,
    DirectionFSMTrial,
    DriverCommand,
    DriverDirectionFSM,
)


class UnifiedSolveError(RuntimeError):
    """The reduced host could not produce an admissible terminal state."""


class UnifiedDomainError(ValueError):
    """A declared accepted-subsystem domain was violated."""


class RigidBodyDynamicsHostRequired(UnifiedDomainError):
    """The reduced planar fixture reached a chassis 6-DOF ownership boundary."""


class SuspensionBackend(str, Enum):
    MAPPED_KC_MASSLESS = "MAPPED_KC_MASSLESS"
    DYNAMIC_UNSPRUNG = "DYNAMIC_UNSPRUNG"


class ClutchRegime(str, Enum):
    LOCKED = "LOCKED"
    OPEN = "OPEN"
    SLIP_POSITIVE = "SLIP_POSITIVE"
    SLIP_NEGATIVE = "SLIP_NEGATIVE"


class BrakeRegime(str, Enum):
    OPEN = "OPEN"
    LOCKED = "LOCKED"
    KINETIC_POSITIVE = "KINETIC_POSITIVE"
    KINETIC_NEGATIVE = "KINETIC_NEGATIVE"


class ContactRegime(str, Enum):
    CONTACT = "CONTACT"
    AIRBORNE = "AIRBORNE"


class SteeringCausality(str, Enum):
    POSITION_COMMAND = "POSITION_COMMAND"
    TORQUE_DRIVEN = "TORQUE_DRIVEN"


@dataclass(frozen=True)
class UnifiedVehicleConfig:
    mass_kg: float = 1420.0
    yaw_inertia_kg_m2: float = 2280.0
    wheelbase_m: float = 2.72
    cg_to_rear_axle_m: float = 1.42
    front_track_m: float = 1.60
    rear_track_m: float = 1.58
    cg_height_m: float = 0.53
    gravity_m_s2: float = 9.81
    wheel_inertias_kg_m2: tuple[float, ...] = (1.25, 1.25, 1.25, 1.25)
    spring_stiffness_n_m: tuple[float, ...] = (118000.0, 118000.0, 126000.0, 126000.0)
    damper_coefficient_n_s_m: tuple[float, ...] = (4200.0, 4200.0, 4600.0, 4600.0)
    unsprung_mass_kg: tuple[float, ...] = (42.0, 42.0, 44.0, 44.0)
    arb_stiffness: tuple[float, float] = (1550.0, 1250.0)
    clutch_capacity_nm: float = 900.0
    air_density_kg_m3: float = 1.225
    platform_front_m: float = 0.040
    platform_rear_m: float = 0.060
    mechanical_trail_m: float = 0.025
    scrub_radius_m: float = 0.012
    residual_tolerance: float = 2.0e-6
    max_nonlinear_evaluations: int = 120
    max_total_nonlinear_evaluations: int = 720
    normal_reaction_upper_bound_n: float = 13000.0
    normal_reaction_tolerance_n: float = 2.0e-6
    contact_gap_tolerance_m: float = 2.0e-7
    normal_velocity_tolerance_m_s: float = 2.0e-8
    steering_causality: SteeringCausality = SteeringCausality.POSITION_COMMAND
    torque_rack: TorqueRackConfig = field(default_factory=TorqueRackConfig)
    brake_assists: BrakeAssistConfig = field(default_factory=BrakeAssistConfig)

    @property
    def wheel_count(self) -> int:
        return 4

    @property
    def front_axle_x_m(self) -> float:
        return self.wheelbase_m - self.cg_to_rear_axle_m

    @property
    def rear_axle_x_m(self) -> float:
        return -self.cg_to_rear_axle_m

    @property
    def wheel_positions_m(self) -> tuple[tuple[float, float], ...]:
        return (
            (self.front_axle_x_m, +0.5 * self.front_track_m),
            (self.front_axle_x_m, -0.5 * self.front_track_m),
            (self.rear_axle_x_m, +0.5 * self.rear_track_m),
            (self.rear_axle_x_m, -0.5 * self.rear_track_m),
        )

    def validate(self) -> None:
        if self.mass_kg <= 0.0 or self.yaw_inertia_kg_m2 <= 0.0:
            raise ValueError("vehicle mass and yaw inertia must be positive")
        if self.wheelbase_m <= 0.0 or not 0.0 < self.cg_to_rear_axle_m < self.wheelbase_m:
            raise ValueError("CG must lie between positive wheelbase axles")
        for values in (
            self.wheel_inertias_kg_m2,
            self.spring_stiffness_n_m,
            self.damper_coefficient_n_s_m,
            self.unsprung_mass_kg,
        ):
            if len(values) != 4 or any(value <= 0.0 for value in values):
                raise ValueError("four positive corner values are required")
        if len(self.arb_stiffness) != 2 or any(value < 0.0 for value in self.arb_stiffness):
            raise ValueError("front and rear ARB stiffness must be non-negative")
        if self.clutch_capacity_nm <= 0.0:
            raise ValueError("clutch capacity must be positive")
        if self.max_nonlinear_evaluations <= 0:
            raise ValueError("per-attempt nonlinear evaluation budget must be positive")
        if self.max_total_nonlinear_evaluations < self.max_nonlinear_evaluations:
            raise ValueError("aggregate nonlinear evaluation budget cannot be smaller than one attempt")
        if self.normal_reaction_upper_bound_n <= 0.0:
            raise ValueError("normal reaction numerical upper bound must be positive")
        if (
            self.normal_reaction_tolerance_n <= 0.0
            or self.contact_gap_tolerance_m <= 0.0
            or self.normal_velocity_tolerance_m_s <= 0.0
        ):
            raise ValueError("normal active-set tolerances must be positive")
        SteeringCausality(self.steering_causality)
        self.torque_rack.validate()
        self.brake_assists.validate()


@dataclass(frozen=True)
class MechanicalState:
    wheel_omega_rad_s: tuple[float, ...]
    body_u_m_s: float
    body_v_m_s: float
    yaw_rate_rad_s: float
    world_x_m: float
    world_y_m: float
    yaw_rad: float
    suspension_q_m: tuple[float, ...]
    suspension_qdot_m_s: tuple[float, ...]
    platform_heave_m: float
    platform_roll_rad: float
    platform_pitch_rad: float
    compliance_toe_rad: tuple[float, ...]
    normal_loads_n: tuple[float, ...]
    road_heights_m: tuple[float, ...] = (0.0, 0.0, 0.0, 0.0)

    def validate(self) -> None:
        vector4 = (
            self.wheel_omega_rad_s,
            self.suspension_q_m,
            self.suspension_qdot_m_s,
            self.compliance_toe_rad,
            self.normal_loads_n,
            self.road_heights_m,
        )
        if any(len(values) != 4 for values in vector4):
            raise ValueError("mechanical corner state must contain four values")
        scalars = (
            *self.wheel_omega_rad_s,
            self.body_u_m_s,
            self.body_v_m_s,
            self.yaw_rate_rad_s,
            self.world_x_m,
            self.world_y_m,
            self.yaw_rad,
            *self.suspension_q_m,
            *self.suspension_qdot_m_s,
            self.platform_heave_m,
            self.platform_roll_rad,
            self.platform_pitch_rad,
            *self.compliance_toe_rad,
            *self.normal_loads_n,
            *self.road_heights_m,
        )
        if not all(math.isfinite(value) for value in scalars):
            raise ValueError("mechanical state contains a non-finite value")
        if self.body_u_m_s <= 0.0:
            raise UnifiedDomainError("forward QSS reference host requires body_u_m_s > 0")
        if any(load < -1.0e-8 for load in self.normal_loads_n):
            raise ValueError("normal loads cannot be tensile")


@dataclass(frozen=True)
class UnifiedVehicleState:
    engine: EngineState
    gearbox: GearboxState
    steering: SteeringCanonicalState
    tires: tuple[TireState, ...]
    mechanics: MechanicalState


@dataclass(frozen=True)
class UnifiedVehicleCommand:
    engine: EngineCommand
    gearbox: GearboxCommand = GearboxCommand()
    steering: SteeringCommand = SteeringCommand(DeviceKind.GAMEPAD, 0.0)
    wheel_external_torque_nm: tuple[float, ...] = (0.0, 0.0, 0.0, 0.0)
    surface_mu_x: tuple[float, ...] = (1.0, 1.0, 1.0, 1.0)
    surface_mu_y: tuple[float, ...] = (1.0, 1.0, 1.0, 1.0)
    road_heights_m: tuple[float, ...] = (0.0, 0.0, 0.0, 0.0)
    wind_body_m_s: tuple[float, float, float] = (0.0, 0.0, 0.0)
    steering_driver_torque_nm: float | None = None
    steering_driver_releasing: bool = False
    service_brake_request: float = 0.0
    parking_brake_request: float = 0.0

    def validate(self) -> None:
        for values in (
            self.wheel_external_torque_nm,
            self.surface_mu_x,
            self.surface_mu_y,
            self.road_heights_m,
        ):
            if len(values) != 4 or not all(math.isfinite(value) for value in values):
                raise ValueError("command corner arrays require four finite values")
        if any(value <= 0.0 for value in (*self.surface_mu_x, *self.surface_mu_y)):
            raise ValueError("surface friction scales must be positive")
        if len(self.wind_body_m_s) != 3 or not all(math.isfinite(value) for value in self.wind_body_m_s):
            raise ValueError("wind must be a finite body-axis vector")
        if self.steering_driver_torque_nm is not None and not math.isfinite(self.steering_driver_torque_nm):
            raise ValueError("steering driver torque must be finite")
        if not 0.0 <= self.service_brake_request <= 1.0:
            raise ValueError("service brake request must lie in [0,1]")
        if not 0.0 <= self.parking_brake_request <= 1.0:
            raise ValueError("parking brake request must lie in [0,1]")


@dataclass(frozen=True)
class TransactionAudit:
    begun: tuple[str, ...]
    preflighted: tuple[str, ...]
    committed: tuple[str, ...]
    aborted: tuple[str, ...]
    rolled_back: tuple[str, ...] = ()

    @property
    def committed_exactly_once(self) -> bool:
        required = {"engine", "gearbox", "steering", "tires", "mechanics"}
        return not self.rolled_back and all(
            len(events) == len(required)
            and len(set(events)) == len(events)
            and set(events) == required
            for events in (self.begun, self.preflighted, self.committed)
        )


@dataclass(frozen=True)
class CouplingCallAudit:
    kc_evaluate: int
    kc_derivative_q: int
    kc_derivative_steer: int
    spring_path: int
    damper_path: int
    arb_backend: int
    compliance_policy: int
    tire_adapter: int
    tire_final_step: int
    aero_full_wrench: int
    steering_spatial_jtw: int

    @property
    def all_required_paths_executed(self) -> bool:
        return all(value > 0 for value in self.__dict__.values())


@dataclass(frozen=True)
class CornerEvaluation:
    contact_regime: ContactRegime
    contact_gap_m: float
    normal_path_jacobian: float
    normal_velocity_residual_m_s: float
    solved_normal_force_n: float
    normal_complementarity_n_m: float
    wheel_angle_rad: float
    camber_rad: float
    kc_values: dict[str, float]
    tire: TireOutput
    force_body_n: tuple[float, float, float]
    moment_body_nm: tuple[float, float, float]
    contact_point_body_m: tuple[float, float, float]
    contact_normal_body: tuple[float, float, float]
    contact_tangent_x_body: tuple[float, float, float]
    contact_tangent_y_body: tuple[float, float, float]
    contact_velocity_body_mps: tuple[float, float, float]
    contact_velocity_x_mps: float
    contact_velocity_y_mps: float
    suspension_generalized_contact_n: float
    suspension_generalized_spring_n: float
    suspension_generalized_damper_n: float
    suspension_generalized_arb_n: float
    compliance_target_rad: float
    tire_compression_m: float
    steering_generalized_road_load_nm: float
    steering_intrinsic_mz_contribution_nm: float


@dataclass(frozen=True)
class UnifiedVehicleStepResult:
    backend: SuspensionBackend
    state: UnifiedVehicleState
    corners: tuple[CornerEvaluation, ...]
    aero_at_reference: AeroEvaluation
    aero_force_at_cg_n: tuple[float, float, float]
    aero_moment_at_cg_nm: tuple[float, float, float]
    steering_control: object
    steering_reaction: object
    clutch_regime: ClutchRegime
    clutch_impulse_nms: float
    clutch_capacity_margin_nms: float
    clutch_active_set_iterations: int
    clutch_active_set_events: tuple[str, ...]
    residual_scaled_inf: float
    residual_row_labels: tuple[str, ...]
    residual_scaled_components: tuple[float, ...]
    nonlinear_evaluations: int
    nonlinear_solver_method: str
    nonlinear_solver_status: int
    nonlinear_solver_message: str
    nonlinear_solver_attempts: tuple[str, ...]
    vehicle_contact_force_n: tuple[float, float, float]
    vehicle_contact_moment_at_cg_nm: tuple[float, float, float]
    road_contact_reaction_n: tuple[float, float, float]
    road_contact_reaction_moment_at_cg_nm: tuple[float, float, float]
    air_reaction_force_n: tuple[float, float, float]
    air_reaction_moment_at_cg_nm: tuple[float, float, float]
    action_reaction_inf_n: float
    action_reaction_moment_inf_nm: float
    aero_action_reaction_inf_n: float
    aero_action_reaction_moment_inf_nm: float
    aero_reference_point_body_m: tuple[float, float, float]
    aero_relative_velocity_at_reference_body_mps: tuple[float, float, float]
    aero_wrench_frame: str
    aero_ground_reference_quality: str
    clutch_virtual_work_j: float
    damper_dissipation_w: float
    arb_energy_j: float
    front_intrinsic_mz_chassis_nm: float
    front_intrinsic_mz_steering_input_nm: float
    steering_road_generalized_load_nm: float
    steering_intrinsic_mz_generalized_contribution_nm: float
    transaction: TransactionAudit
    calls: CouplingCallAudit
    steering_causality: SteeringCausality
    torque_rack_evaluation: TorqueRackEvaluation | None
    assists: AssistEvaluation
    brake_regimes: tuple[BrakeRegime, ...]
    brake_capacity_nm: tuple[float, ...]
    actual_brake_torque_nm: tuple[float, ...]
    brake_capacity_margin_nm: tuple[float, ...]
    brake_internal_action_reaction_inf_nm: float
    brake_active_set_iterations: int
    brake_active_set_events: tuple[str, ...]
    contact_regimes: tuple[ContactRegime, ...]
    contact_active_set_iterations: int
    contact_active_set_events: tuple[str, ...]
    normal_complementarity_inf_n_m: float
    normal_velocity_residual_inf_m_s: float
    contact_geometry_quality: str


@dataclass(frozen=True)
class DriverControlledStepResult:
    vehicle: UnifiedVehicleStepResult
    direction_trial: DirectionFSMTrial
    direction_state: DirectionFSMState


@dataclass(frozen=True)
class _TireTicket:
    token: int
    snapshot: tuple[TireState, ...]


class _TireOwner:
    def __init__(self, state: tuple[TireState, ...], model: TireModel):
        self.state = state
        self.model = model
        self._next_token = 1
        self._open_token: int | None = None

    def begin_substep(self) -> _TireTicket:
        if self._open_token is not None:
            raise RuntimeError("previous Tire substep has not been resolved")
        ticket = _TireTicket(self._next_token, self.state)
        self._next_token += 1
        self._open_token = ticket.token
        return ticket

    def evaluate(self, ticket: _TireTicket, inputs: Sequence[object]) -> tuple[TireOutput, ...]:
        if self._open_token != ticket.token or ticket.snapshot is not self.state:
            raise RuntimeError("stale Tire trial evaluation")
        if len(inputs) != 4:
            raise ValueError("four Tire inputs are required")
        return tuple(self.model.step(ticket.snapshot[index], inputs[index]) for index in range(4))

    def validate_commit(self, ticket: _TireTicket, outputs: Sequence[TireOutput]) -> None:
        if self._open_token != ticket.token or ticket.snapshot is not self.state:
            raise RuntimeError("stale or duplicate Tire.commit")
        if len(outputs) != 4:
            raise ValueError("four Tire outputs are required")
        values = tuple(
            value
            for output in outputs
            for value in output.state_next.__dict__.values()
            if isinstance(value, (int, float))
        )
        if not all(math.isfinite(value) for value in values):
            raise ValueError("Tire final state is non-finite")

    def commit(self, ticket: _TireTicket, outputs: Sequence[TireOutput]) -> tuple[TireState, ...]:
        self.validate_commit(ticket, outputs)
        self.state = tuple(output.state_next for output in outputs)
        self._open_token = None
        return self.state

    def abort(self, ticket: _TireTicket) -> tuple[TireState, ...]:
        if self._open_token != ticket.token or ticket.snapshot is not self.state:
            raise RuntimeError("stale or duplicate Tire.abort")
        self._open_token = None
        return self.state

    def restore_group_snapshot(self, ticket: _TireTicket) -> bool:
        if self._open_token not in (ticket.token, None):
            raise RuntimeError("Tire group rollback found an unrelated open token")
        had_committed = self._open_token is None or self.state is not ticket.snapshot
        self.state = ticket.snapshot
        self._open_token = None
        return had_committed


@dataclass(frozen=True)
class _MechanicalTicket:
    token: int
    snapshot: MechanicalState


class _MechanicalOwner:
    def __init__(self, state: MechanicalState):
        state.validate()
        self.state = state
        self._next_token = 1
        self._open_token: int | None = None

    def begin_substep(self) -> _MechanicalTicket:
        if self._open_token is not None:
            raise RuntimeError("previous mechanical substep has not been resolved")
        ticket = _MechanicalTicket(self._next_token, self.state)
        self._next_token += 1
        self._open_token = ticket.token
        return ticket

    def validate_commit(self, ticket: _MechanicalTicket, state: MechanicalState) -> None:
        if self._open_token != ticket.token or ticket.snapshot is not self.state:
            raise RuntimeError("stale or duplicate mechanical commit")
        state.validate()

    def commit(self, ticket: _MechanicalTicket, state: MechanicalState) -> MechanicalState:
        self.validate_commit(ticket, state)
        self.state = state
        self._open_token = None
        return self.state

    def abort(self, ticket: _MechanicalTicket) -> MechanicalState:
        if self._open_token != ticket.token or ticket.snapshot is not self.state:
            raise RuntimeError("stale or duplicate mechanical abort")
        self._open_token = None
        return self.state

    def restore_group_snapshot(self, ticket: _MechanicalTicket) -> bool:
        if self._open_token not in (ticket.token, None):
            raise RuntimeError("Mechanical group rollback found an unrelated open token")
        had_committed = self._open_token is None or self.state is not ticket.snapshot
        self.state = ticket.snapshot
        self._open_token = None
        return had_committed


@dataclass(frozen=True)
class _Evaluation:
    rows: np.ndarray
    corners: tuple[CornerEvaluation, ...]
    aero: AeroEvaluation
    aero_force_cg: np.ndarray
    aero_moment_cg: np.ndarray
    aero_relative_velocity_at_reference_body: np.ndarray
    tire_outputs: tuple[TireOutput, ...]
    calls: CouplingCallAudit
    damper_dissipation_w: float
    arb_energy_j: float
    steering_wheel_generalized_loads_nm: tuple[float, float]
    steering_intrinsic_mz_generalized_nm: float
    steering_control: object
    torque_rack_evaluation: TorqueRackEvaluation | None
    brake_internal_action_reaction_inf_nm: float
    suspension_qdot_m_s: tuple[float, ...]


class UnifiedVehicleFixture:
    """Transactional reduced host executing every currently available backend."""

    def __init__(
        self,
        engine_model: EngineModel,
        gearbox_asset: GearboxAsset,
        initial_state: UnifiedVehicleState,
        config: UnifiedVehicleConfig | None = None,
    ):
        self.config = config or UnifiedVehicleConfig()
        self.config.validate()
        initial_state.mechanics.validate()
        if len(initial_state.tires) != 4:
            raise ValueError("four canonical Tire states are required")
        if len(gearbox_asset.final_drive_wheel_mapping) != 4:
            raise ValueError("unified gearbox must expose four wheel mappings")
        self.engine_owner = EngineOwner(engine_model, initial_state.engine)
        self.gearbox_owner = GearboxOwner(GearboxController(gearbox_asset), initial_state.gearbox)
        self.steering_owner = SteeringOwner(
            SteeringTransactionalModel(
                input_config=InputConfig(wheelbase_m=self.config.wheelbase_m),
                geometry_config=SteeringGeometryConfig(
                    wheelbase_m=self.config.wheelbase_m,
                    front_track_m=self.config.front_track_m,
                ),
            ),
            initial_state.steering,
        )
        self.torque_rack = TorqueDrivenRack(self.config.torque_rack)
        self.brake_assist_controller = BrakeAssistController(self.config.brake_assists)
        self.tire_model = make_reference_model()
        self.tire_owner = _TireOwner(initial_state.tires, self.tire_model)
        self.mechanical_owner = _MechanicalOwner(initial_state.mechanics)
        self.kc_map, _ = build_synthetic_kc_map()
        self.arbs = (LinearARB(self.config.arb_stiffness[0], 1.0), LinearARB(self.config.arb_stiffness[1], 1.0))
        self.aero_map = build_synthetic_race_aeromap()
        self.static_loads_n = self._static_loads()
        self.static_compressions_m = tuple(self._compression_for_load(load) for load in self.static_loads_n)
        self.static_effective_radii_m = tuple(
            self.tire_model.params.R0
            - self.tire_model.params.effective_radius_deflection_fraction * compression
            for compression in self.static_compressions_m
        )
        self.spring_free_lengths_m = self._spring_free_lengths()
        self.state = initial_state
        self.last_transaction_audit = TransactionAudit((), (), (), ())

    @staticmethod
    def reference_gearbox_asset() -> GearboxAsset:
        return GearboxAsset(
            gears=(
                GearDefinition("R", -2.8),
                GearDefinition("N", 0.0),
                GearDefinition("1", 3.0),
                GearDefinition("2", 2.0),
                GearDefinition("3", 1.35),
                GearDefinition("4", 1.0),
                GearDefinition("5", 0.78),
            ),
            neutral_gear="N",
            final_drive_wheel_mapping=ideal_open_differential_mapping(3.0),
            clutch_open_s=0.04,
            neutral_dwell_s=0.02,
            clutch_close_s=0.06,
        )

    @classmethod
    def synthetic(
        cls,
        root: Path | None = None,
        speed_m_s: float = 15.0,
        config: UnifiedVehicleConfig | None = None,
    ) -> "UnifiedVehicleFixture":
        root = root or Path(__file__).resolve().parent
        cfg = config or UnifiedVehicleConfig()
        cfg.validate()
        engine_model = EngineModel(EngineAsset.from_json(root / "data" / "synthetic_engine_asset.json"))
        gearbox_asset = cls.reference_gearbox_asset()
        tire = make_reference_model()
        front = cfg.mass_kg * cfg.gravity_m_s2 * cfg.cg_to_rear_axle_m / cfg.wheelbase_m
        rear = cfg.mass_kg * cfg.gravity_m_s2 - front
        loads = (front / 2.0, front / 2.0, rear / 2.0, rear / 2.0)
        compressions = []
        wheels = []
        for load in loads:
            p = tire.params
            compression = tire.compression_for_load(load)
            compressions.append(compression)
            effective = p.R0 - p.effective_radius_deflection_fraction * compression
            wheels.append(speed_m_s / effective)
        mapping = np.asarray(gearbox_asset.mapping_for("3"), dtype=float)
        engine_omega = float(np.dot(mapping, np.asarray(wheels)))
        mechanics = MechanicalState(
            wheel_omega_rad_s=tuple(wheels),
            body_u_m_s=float(speed_m_s),
            body_v_m_s=0.0,
            yaw_rate_rad_s=0.0,
            world_x_m=0.0,
            world_y_m=0.0,
            yaw_rad=0.0,
            suspension_q_m=(0.0, 0.0, 0.0, 0.0),
            suspension_qdot_m_s=(0.0, 0.0, 0.0, 0.0),
            platform_heave_m=0.0,
            platform_roll_rad=0.0,
            platform_pitch_rad=0.0,
            compliance_toe_rad=(0.0, 0.0, 0.0, 0.0),
            normal_loads_n=loads,
        )
        state = UnifiedVehicleState(
            engine=EngineState(engine_omega, EngineMode.RUNNING, 0.35),
            gearbox=GearboxState("3"),
            steering=SteeringCanonicalState(),
            tires=(TireState(), TireState(), TireState(), TireState()),
            mechanics=mechanics,
        )
        return cls(engine_model, gearbox_asset, state, cfg)

    def _static_loads(self) -> tuple[float, ...]:
        c = self.config
        front = c.mass_kg * c.gravity_m_s2 * c.cg_to_rear_axle_m / c.wheelbase_m
        rear = c.mass_kg * c.gravity_m_s2 - front
        return (front / 2.0, front / 2.0, rear / 2.0, rear / 2.0)

    def _compression_for_load(self, load_n: float) -> float:
        return self.tire_model.compression_for_load(load_n)

    def _spring_free_lengths(self) -> tuple[float, ...]:
        lengths = []
        for index, load in enumerate(self.static_loads_n):
            values = self.kc_map.evaluate(0.0, 0.0)
            derivative = self.kc_map.derivative_q(0.0, 0.0)["spring_length"]
            extension = load / (self.config.spring_stiffness_n_m[index] * abs(derivative))
            lengths.append(values["spring_length"] + extension)
        return tuple(lengths)

    def _select_clutch_regime(self, mapping: np.ndarray, engagement: float) -> ClutchRegime:
        if engagement <= 1.0e-10 or float(np.linalg.norm(mapping, ord=1)) <= 1.0e-12:
            return ClutchRegime.OPEN
        slip = self.state.engine.omega_rad_s - float(np.dot(mapping, self.state.mechanics.wheel_omega_rad_s))
        if engagement >= 1.0 - 1.0e-10 and abs(slip) <= 0.5:
            return ClutchRegime.LOCKED
        return ClutchRegime.SLIP_POSITIVE if slip >= 0.0 else ClutchRegime.SLIP_NEGATIVE

    def _select_brake_regimes(
        self,
        capacities_nm: Sequence[float],
        dt: float,
    ) -> tuple[BrakeRegime, ...]:
        del dt  # mode feasibility is resolved by the coupled active-set solve
        regimes: list[BrakeRegime] = []
        for omega, capacity in zip(self.state.mechanics.wheel_omega_rad_s, capacities_nm):
            if capacity <= 1.0e-12:
                regimes.append(BrakeRegime.OPEN)
            elif abs(omega) <= 1.0e-10:
                regimes.append(BrakeRegime.LOCKED)
            elif omega > 0.0:
                regimes.append(BrakeRegime.KINETIC_POSITIVE)
            else:
                regimes.append(BrakeRegime.KINETIC_NEGATIVE)
        return tuple(regimes)

    def _select_contact_regimes(
        self,
        backend: SuspensionBackend,
    ) -> tuple[ContactRegime, ...]:
        """Seed the unilateral mapped-contact active set from canonical state.

        The dynamic-unsprung backend resolves contact through its compliant
        vertical law and therefore does not consume these modes.  Returning a
        four-corner tuple keeps the evaluation/result contract uniform.
        """

        if backend is not SuspensionBackend.MAPPED_KC_MASSLESS:
            return tuple(
                ContactRegime.CONTACT if load > 0.0 else ContactRegime.AIRBORNE
                for load in self.state.mechanics.normal_loads_n
            )
        return tuple(
            ContactRegime.CONTACT if load > 1.0e-7 else ContactRegime.AIRBORNE
            for load in self.state.mechanics.normal_loads_n
        )

    @staticmethod
    def _wheel_to_body(angle: float, vector: Sequence[float]) -> np.ndarray:
        c, s = math.cos(angle), math.sin(angle)
        x, y, z = map(float, vector)
        return np.array([c * x - s * y, s * x + c * y, z], dtype=float)

    @staticmethod
    def _contact_tangent_frame(
        wheel_rotation_body: np.ndarray,
        contact_normal_body: Sequence[float],
    ) -> np.ndarray:
        """Return [forward, left, normal] for the final wheel/contact pose.

        The standalone host deliberately supplies a reduced flat-road normal;
        it still must project the *final* spindle forward direction onto that
        plane.  The wheel axle is the geometry-owned fallback.  A degenerate
        spindle/normal pair is rejected rather than silently falling back to
        chassis/world forward.
        """

        rotation = np.asarray(wheel_rotation_body, dtype=float)
        normal = np.asarray(contact_normal_body, dtype=float)
        normal_norm = float(np.linalg.norm(normal))
        if rotation.shape != (3, 3) or not np.all(np.isfinite(rotation)):
            raise UnifiedDomainError("final spindle rotation must be a finite 3x3 matrix")
        if not np.all(np.isfinite(normal)) or normal_norm <= 1.0e-12:
            raise UnifiedDomainError("contact normal must be finite and non-zero")
        normal = normal / normal_norm
        wheel_forward = rotation[:, 0]
        tangent_x = wheel_forward - float(np.dot(wheel_forward, normal)) * normal
        tangent_norm = float(np.linalg.norm(tangent_x))
        if tangent_norm <= 1.0e-10:
            wheel_axle = rotation[:, 1]
            tangent_x = np.cross(wheel_axle, normal)
            tangent_norm = float(np.linalg.norm(tangent_x))
        if tangent_norm <= 1.0e-10:
            raise UnifiedDomainError("wheel pose is degenerate with the contact normal")
        tangent_x = tangent_x / tangent_norm
        tangent_y = np.cross(normal, tangent_x)
        tangent_y /= float(np.linalg.norm(tangent_y))
        frame = np.column_stack((tangent_x, tangent_y, normal))
        orthogonality_error = float(np.max(np.abs(frame.T @ frame - np.eye(3))))
        if orthogonality_error > 2.0e-12 or float(np.linalg.det(frame)) <= 0.0:
            raise RuntimeError("contact tangent frame lost right-handed orthonormality")
        return frame

    def _aero(
        self,
        body_linear_velocity: Sequence[float],
        body_angular_velocity: Sequence[float],
        heave: float,
        pitch: float,
        roll: float,
        steering: float,
        wind_at_reference_body: Sequence[float],
    ) -> tuple[AeroEvaluation, np.ndarray, np.ndarray, np.ndarray]:
        c = self.config
        front_h = c.platform_front_m + heave - pitch * c.front_axle_x_m
        rear_h = c.platform_rear_m + heave - pitch * c.rear_axle_x_m
        reference_point = np.asarray(self.aero_map.reference.ref_point_vehicle_m, dtype=float)
        reference_point_velocity = np.asarray(body_linear_velocity, dtype=float) + np.cross(
            np.asarray(body_angular_velocity, dtype=float),
            reference_point,
        )
        rel = reference_point_velocity - np.asarray(wind_at_reference_body, dtype=float)
        if rel[0] <= 0.0:
            raise UnifiedDomainError("SKIP_REVERSE_QSS: Aero v1.9 requires forward relative flow")
        beta = math.atan2(float(rel[1]), float(rel[0]))
        if not self.aero_map.beta_grid_rad[0] <= beta <= self.aero_map.beta_grid_rad[-1]:
            raise UnifiedDomainError(
                f"Aero beta={beta:.6g} outside [{self.aero_map.beta_grid_rad[0]:.6g}, {self.aero_map.beta_grid_rad[-1]:.6g}]"
            )
        if not self.aero_map.front_heights_m[0] <= front_h <= self.aero_map.front_heights_m[-1]:
            raise UnifiedDomainError("front platform height outside Aero map")
        if not self.aero_map.rear_heights_m[0] <= rear_h <= self.aero_map.rear_heights_m[-1]:
            raise UnifiedDomainError("rear platform height outside Aero map")
        platform = AeroPlatformSample(front_h, rear_h, roll_rad=roll, steering_rad=steering)
        aero = self.aero_map.evaluate(
            platform,
            AeroEnvironment(c.air_density_kg_m3, rel),
        )
        force, moment = shift_wrench(
            aero.force_body_n,
            aero.moment_body_nm_at_ref,
            self.aero_map.reference.ref_point_vehicle_m,
        )
        return aero, force, moment, rel

    def _platform_heights_from_pose(
        self,
        heave_m: float,
        pitch_rad: float,
    ) -> tuple[float, float]:
        c = self.config
        return (
            c.platform_front_m + heave_m - pitch_rad * c.front_axle_x_m,
            c.platform_rear_m + heave_m - pitch_rad * c.rear_axle_x_m,
        )

    def _platform_pose_from_heights(
        self,
        front_height_m: float,
        rear_height_m: float,
    ) -> tuple[float, float]:
        c = self.config
        pitch = (
            (rear_height_m - c.platform_rear_m)
            - (front_height_m - c.platform_front_m)
        ) / c.wheelbase_m
        heave = front_height_m - c.platform_front_m + pitch * c.front_axle_x_m
        return float(heave), float(pitch)

    def _slices(self, backend: SuspensionBackend) -> dict[str, slice | int]:
        # [we,w4,u,v,r,j,q4,normal4|qdot4,(hF,roll,hR),toe4,brakeJ4,(rack q,qdot)]
        out: dict[str, slice | int] = {
            "we": 0,
            "w": slice(1, 5),
            "body": slice(5, 8),
            "j": 8,
            "q": slice(9, 13),
        }
        if backend is SuspensionBackend.MAPPED_KC_MASSLESS:
            out["fz"] = slice(13, 17)
        else:
            out["qdot"] = slice(13, 17)
        out["platform"] = slice(17, 20)
        out["toe"] = slice(20, 24)
        out["brake"] = slice(24, 28)
        if SteeringCausality(self.config.steering_causality) is SteeringCausality.TORQUE_DRIVEN:
            out["steer"] = slice(28, 30)
        return out

    def _initial_vector(self, backend: SuspensionBackend) -> np.ndarray:
        m = self.state.mechanics
        base = [
            self.state.engine.omega_rad_s,
            *m.wheel_omega_rad_s,
            m.body_u_m_s,
            m.body_v_m_s,
            m.yaw_rate_rad_s,
            0.0,
            *m.suspension_q_m,
        ]
        base.extend(m.normal_loads_n if backend is SuspensionBackend.MAPPED_KC_MASSLESS else m.suspension_qdot_m_s)
        front_height, rear_height = self._platform_heights_from_pose(
            m.platform_heave_m,
            m.platform_pitch_rad,
        )
        base.extend((front_height, m.platform_roll_rad, rear_height))
        base.extend(m.compliance_toe_rad)
        base.extend((0.0, 0.0, 0.0, 0.0))
        if SteeringCausality(self.config.steering_causality) is SteeringCausality.TORQUE_DRIVEN:
            base.extend((self.state.steering.rack_q, self.state.steering.rack_rate_q_s))
        return np.asarray(base, dtype=float)

    def _bounds(
        self,
        backend: SuspensionBackend,
        dt: float,
        clutch_capacity: float,
        brake_capacity_nm: Sequence[float],
    ) -> tuple[np.ndarray, np.ndarray]:
        upper_engine = rpm_to_rad_s(self.engine_owner.model.asset.hard_overspeed_rpm)
        lo = [0.0, *([-500.0] * 4), 2.1, -2.0, -2.5, -clutch_capacity * dt, *([-0.078] * 4)]
        hi = [upper_engine, *([500.0] * 4), 95.0, 2.0, 2.5, clutch_capacity * dt, *([0.078] * 4)]
        if backend is SuspensionBackend.MAPPED_KC_MASSLESS:
            lo.extend([0.0] * 4)
            hi.extend([self.config.normal_reaction_upper_bound_n] * 4)
        else:
            lo.extend([-3.0] * 4); hi.extend([3.0] * 4)
        lo.extend([
            float(self.aero_map.front_heights_m[0]),
            -0.04,
            float(self.aero_map.rear_heights_m[0]),
            *([-0.16] * 4),
        ])
        hi.extend([
            float(self.aero_map.front_heights_m[-1]),
            +0.04,
            float(self.aero_map.rear_heights_m[-1]),
            *([+0.16] * 4),
        ])
        brake_spans = [max(float(capacity) * dt, 1.0e-12) for capacity in brake_capacity_nm]
        lo.extend([-span for span in brake_spans])
        hi.extend([+span for span in brake_spans])
        if SteeringCausality(self.config.steering_causality) is SteeringCausality.TORQUE_DRIVEN:
            penetration = 0.05
            limit = self.config.torque_rack.hard_limit_q + penetration
            lo.extend([-limit, -12.0])
            hi.extend([+limit, +12.0])
        return np.asarray(lo, dtype=float), np.asarray(hi, dtype=float)

    def _row_scales(
        self,
        backend: SuspensionBackend,
        contact_regimes: tuple[ContactRegime, ...] | None = None,
    ) -> np.ndarray:
        c = self.config
        scales = [
            max(20.0, self.engine_owner.model.asset.inertia_kg_m2 * max(100.0, self.state.engine.omega_rad_s)),
            *[max(20.0, inertia * max(30.0, abs(omega))) for inertia, omega in zip(c.wheel_inertias_kg_m2, self.state.mechanics.wheel_omega_rad_s)],
            c.mass_kg * max(10.0, self.state.mechanics.body_u_m_s),
            c.mass_kg * max(5.0, abs(self.state.mechanics.body_v_m_s) + 1.0),
            c.yaw_inertia_kg_m2 * max(0.5, abs(self.state.mechanics.yaw_rate_rad_s) + 0.1),
            max(100.0, self.state.engine.omega_rad_s),
        ]
        if backend is SuspensionBackend.MAPPED_KC_MASSLESS:
            if contact_regimes is None or len(contact_regimes) != 4:
                raise ValueError("mapped row scales require four contact regimes")
            scales.extend([4000.0] * 4)  # massless generalized equilibrium
            scales.extend(
                0.03 if regime is ContactRegime.CONTACT else 4000.0
                for regime in contact_regimes
            )
        else:
            scales.extend([0.02] * 4)    # q backward-Euler kinematics
            scales.extend([4000.0] * 4)  # unsprung dynamics
        scales.extend([14000.0, 10000.0, 20000.0])  # heave/roll/pitch balance
        scales.extend([0.08] * 4)
        scales.extend([50.0] * 4)
        if SteeringCausality(self.config.steering_causality) is SteeringCausality.TORQUE_DRIVEN:
            scales.extend(
                [
                    0.05,
                    max(10.0, self.config.torque_rack.equivalent_inertia_nm_s2),
                ]
            )
        return np.asarray(scales, dtype=float)

    def _row_labels(
        self,
        backend: SuspensionBackend,
        contact_regimes: tuple[ContactRegime, ...] | None = None,
    ) -> tuple[str, ...]:
        labels = [
            "engine_angular_momentum",
            *(f"wheel_{index}_angular_momentum" for index in range(4)),
            "body_longitudinal_momentum",
            "body_lateral_momentum",
            "body_yaw_momentum",
            "clutch_mode",
        ]
        if backend is SuspensionBackend.MAPPED_KC_MASSLESS:
            if contact_regimes is None or len(contact_regimes) != 4:
                raise ValueError("mapped row labels require four contact regimes")
            labels.extend(f"corner_{index}_massless_equilibrium" for index in range(4))
            labels.extend(
                (
                    f"corner_{index}_rigid_contact_geometry"
                    if regime is ContactRegime.CONTACT
                    else f"corner_{index}_airborne_zero_normal_reaction"
                )
                for index, regime in enumerate(contact_regimes)
            )
        else:
            labels.extend(f"corner_{index}_jounce_kinematics" for index in range(4))
            labels.extend(f"corner_{index}_unsprung_momentum" for index in range(4))
        labels.extend(("platform_heave", "platform_roll", "platform_pitch"))
        labels.extend(f"corner_{index}_compliance" for index in range(4))
        labels.extend(f"wheel_{index}_brake_mode" for index in range(4))
        if SteeringCausality(self.config.steering_causality) is SteeringCausality.TORQUE_DRIVEN:
            labels.extend(("rack_kinematics", "rack_angular_momentum"))
        return tuple(labels)

    def _evaluate(
        self,
        x: np.ndarray,
        backend: SuspensionBackend,
        dt: float,
        command: UnifiedVehicleCommand,
        engine_ticket,
        gearbox_ticket,
        steering_ticket,
        tire_ticket: _TireTicket,
        clutch_regime: ClutchRegime,
        assists: AssistEvaluation,
        brake_regimes: tuple[BrakeRegime, ...],
        contact_regimes: tuple[ContactRegime, ...],
        *,
        instrument: bool = False,
    ) -> _Evaluation:
        c = self.config
        if len(contact_regimes) != 4:
            raise ValueError("four contact regimes are required")
        sl = self._slices(backend)
        we = float(x[sl["we"]])
        wheels = np.asarray(x[sl["w"]], dtype=float)
        u, v, yaw_rate = map(float, x[sl["body"]])
        clutch_impulse = float(x[sl["j"]])
        q = np.asarray(x[sl["q"]], dtype=float)
        front_height, roll, rear_height = map(float, x[sl["platform"]])
        heave, pitch = self._platform_pose_from_heights(front_height, rear_height)
        compliance = np.asarray(x[sl["toe"]], dtype=float)
        brake_impulses = np.asarray(x[sl["brake"]], dtype=float)
        qdot = (
            np.asarray(x[sl["qdot"]], dtype=float)
            if backend is SuspensionBackend.DYNAMIC_UNSPRUNG
            else (q - np.asarray(self.state.mechanics.suspension_q_m)) / dt
        )
        fz_unknown = (
            np.asarray(x[sl["fz"]], dtype=float)
            if backend is SuspensionBackend.MAPPED_KC_MASSLESS
            else None
        )
        if SteeringCausality(c.steering_causality) is SteeringCausality.TORQUE_DRIVEN:
            rack_q, rack_rate = map(float, x[sl["steer"]])
            steering = self.steering_owner.model.output_from_rack_state(rack_q, rack_rate)
        else:
            steering = steering_ticket.trial.output
        steering_geometry = SteeringGeometry(self.steering_owner.model.geometry_config)
        front_angle_derivatives = steering_geometry.angle_derivatives_wrt_q(
            self.steering_owner.model.rack_map,
            steering.rack_q,
        )
        rack_angle_derivatives = np.array(
            [front_angle_derivatives.left_rad, front_angle_derivatives.right_rad, 0.0, 0.0],
            dtype=float,
        )
        steer_base = np.array(
            [steering.wheel_angles.left_rad, steering.wheel_angles.right_rad, 0.0, 0.0],
            dtype=float,
        )
        positions = c.wheel_positions_m
        previous = self.state.mechanics
        kc_values: list[dict[str, float]] = []
        kc_derivatives: list[dict[str, float]] = []
        kc_steer_derivatives: list[dict[str, float]] = []
        kc_zero_steer_derivatives: list[dict[str, float]] = []
        wheel_angles = np.zeros(4)
        cambers = np.zeros(4)
        tire_inputs = []
        compressions = np.zeros(4)
        wheel_rotations: list[np.ndarray] = []
        contact_rotations: list[np.ndarray] = []
        contact_points: list[np.ndarray] = []
        contact_velocities: list[np.ndarray] = []
        contact_gaps: list[float] = []
        normal_path_jacobians: list[float] = []
        normal_velocity_residuals: list[float] = []
        effective_radius_predictions: list[float] = []
        dcontact_q_vectors: list[np.ndarray] = []
        omega_q_vectors: list[np.ndarray] = []
        dcontact_steer_vectors: list[np.ndarray] = []
        omega_steer_vectors: list[np.ndarray] = []
        counts = {
            "kc_evaluate": 0,
            "kc_derivative_q": 0,
            "kc_derivative_steer": 0,
            "spring_path": 0,
            "damper_path": 0,
            "arb_backend": 0,
            "compliance_policy": 0,
            "tire_adapter": 0,
            "tire_final_step": 0,
            "aero_full_wrench": 0,
            "steering_spatial_jtw": 0,
        }
        previous_steering = self.steering_owner.model.output_from_rack_state(
            steering_ticket.snapshot.rack_q,
            steering_ticket.snapshot.rack_rate_q_s,
        )
        previous_steer_base = np.array(
            [
                previous_steering.wheel_angles.left_rad,
                previous_steering.wheel_angles.right_rad,
                0.0,
                0.0,
            ],
            dtype=float,
        )
        rack_rate_q_s = float(steering.rack_rate_q_s)
        platform_linear_velocity = np.array(
            [
                u,
                v,
                (heave - previous.platform_heave_m) / dt,
            ],
            dtype=float,
        )
        platform_angular_velocity = np.array(
            [
                (roll - previous.platform_roll_rad) / dt,
                (pitch - previous.platform_pitch_rad) / dt,
                yaw_rate,
            ],
            dtype=float,
        )
        # The standalone fixture owns no scene query.  Its explicit reduced
        # contract is a flat, stationary-in-plane road-height field; a game
        # adapter must replace this with the scene contact normal/point motion.
        contact_normal_body = np.array([0.0, 0.0, 1.0], dtype=float)
        for index, ((px, py), qi) in enumerate(zip(positions, q)):
            side = 1.0 if py > 0.0 else -1.0
            steer_i = float(steer_base[index])
            try:
                values = self.kc_map.evaluate(float(qi), steer_i, policy="reject")
                deriv = self.kc_map.derivative_q(float(qi), steer_i, policy="reject")
                steer_deriv = self.kc_map.derivative_steer(float(qi), steer_i, policy="reject")
                zero = self.kc_map.evaluate(0.0, steer_i, policy="reject")
                zero_steer_deriv = self.kc_map.derivative_steer(0.0, steer_i, policy="reject")
            except KCDomainError as exc:
                raise UnifiedDomainError(str(exc)) from exc
            counts["kc_evaluate"] += 2
            counts["kc_derivative_q"] += 1
            counts["kc_derivative_steer"] += 2
            kc_values.append(values)
            kc_derivatives.append(deriv)
            kc_steer_derivatives.append(steer_deriv)
            kc_zero_steer_derivatives.append(zero_steer_deriv)
            kc_toe = side * (values["rz"] - zero["rz"])
            wheel_angles[index] = steer_i + kc_toe + compliance[index]
            cambers[index] = side * values["rx"]
            body_height = heave + roll * py - pitch * px + values["pz"]
            contact_gap = body_height - command.road_heights_m[index]
            contact_gaps.append(float(contact_gap))
            if backend is SuspensionBackend.MAPPED_KC_MASSLESS:
                assert fz_unknown is not None
                contact_backend = "MAPPED_KC_MASSLESS"
                normal_mode = "RIGID_NORMAL"
                if contact_regimes[index] is ContactRegime.CONTACT:
                    compressions[index] = self.static_compressions_m[index]
                    normal_load_for_radius = float(fz_unknown[index])
                    loaded_radius = self.tire_model.unloaded_radius_m - self.static_compressions_m[index]
                    in_contact = True
                    solved_normal_force = normal_load_for_radius
                    rigid_gap_constraint_active = True
                else:
                    compressions[index] = 0.0
                    normal_load_for_radius = 0.0
                    loaded_radius = self.tire_model.unloaded_radius_m
                    in_contact = False
                    solved_normal_force = 0.0
                    rigid_gap_constraint_active = False
                compression_for_packet = None
                compression_rate_for_packet = None
            else:
                compression = self.static_compressions_m[index] + command.road_heights_m[index] - body_height
                old_values = self.kc_map.evaluate(
                    previous.suspension_q_m[index],
                    float(previous_steer_base[index]),
                    policy="reject",
                )
                counts["kc_evaluate"] += 1
                previous_height = (
                    previous.platform_heave_m
                    + previous.platform_roll_rad * py
                    - previous.platform_pitch_rad * px
                    + old_values["pz"]
                )
                previous_compression = self.static_compressions_m[index] + previous.road_heights_m[index] - previous_height
                compression_rate = (compression - previous_compression) / dt
                compressions[index] = compression
                normal_load_for_radius = self.tire_model.vertical_law(
                    float(compression),
                    float(compression_rate),
                ).force_z_n
                loaded_radius = self.tire_model.unloaded_radius_m - max(0.0, compression)
                contact_backend = "DYNAMIC_UNSPRUNG"
                normal_mode = "COMPLIANT_TIRE_VERTICAL"
                in_contact = compression > 0.0
                solved_normal_force = None
                compression_for_packet = float(compression)
                compression_rate_for_packet = float(compression_rate)
                rigid_gap_constraint_active = False

            effective_radius = self.tire_model.effective_radius(
                normal_load_for_radius,
                float(wheels[index]),
                loaded_radius,
            )
            effective_radius_predictions.append(effective_radius)
            rotvec = np.array(
                [side * values["rx"], values["ry"], wheel_angles[index]],
                dtype=float,
            )
            wheel_rotation = exp_so3(rotvec)
            wheel_rotations.append(wheel_rotation)
            contact_rotation = self._contact_tangent_frame(
                wheel_rotation,
                contact_normal_body,
            )
            contact_rotations.append(contact_rotation)
            rdown = wheel_rotation @ np.array([0.0, 0.0, -effective_radius], dtype=float)
            center = np.array(
                [
                    px + values["px"],
                    py + side * values["py"],
                    -c.cg_height_m + self.static_effective_radii_m[index] + values["pz"],
                ],
                dtype=float,
            )
            contact_point = center + rdown
            contact_points.append(contact_point)

            dpos_q = np.array([deriv["px"], side * deriv["py"], deriv["pz"]], dtype=float)
            drot_q = np.array(
                [side * deriv["rx"], deriv["ry"], side * deriv["rz"]],
                dtype=float,
            )
            omega_q = rotvec_rate_to_spatial_omega(rotvec, drot_q)
            dcontact_q = dpos_q + np.cross(omega_q, rdown)
            dcontact_q_vectors.append(dcontact_q)
            omega_q_vectors.append(omega_q)

            dsteer_dq = float(rack_angle_derivatives[index])
            dcenter_steer = dsteer_dq * np.array(
                [steer_deriv["px"], side * steer_deriv["py"], steer_deriv["pz"]],
                dtype=float,
            )
            drot_steer = dsteer_dq * np.array(
                [
                    side * steer_deriv["rx"],
                    steer_deriv["ry"],
                    1.0 + side * (steer_deriv["rz"] - zero_steer_deriv["rz"]),
                ],
                dtype=float,
            )
            omega_steer = rotvec_rate_to_spatial_omega(rotvec, drot_steer)
            dcontact_steer = dcenter_steer + np.cross(omega_steer, rdown)
            dcontact_steer_vectors.append(dcontact_steer)
            omega_steer_vectors.append(omega_steer)

            compliance_rate = (
                compliance[index] - previous.compliance_toe_rad[index]
            ) / dt
            base_rotvec_rate = (
                drot_steer * rack_rate_q_s
                + np.array([0.0, 0.0, compliance_rate], dtype=float)
            )
            base_spindle_omega_relative = rotvec_rate_to_spatial_omega(
                rotvec,
                base_rotvec_rate,
            )
            base_contact_velocity = (
                platform_linear_velocity
                + np.cross(platform_angular_velocity, contact_point)
                + dcenter_steer * rack_rate_q_s
                + np.cross(base_spindle_omega_relative, rdown)
                - contact_normal_body
                * ((command.road_heights_m[index] - previous.road_heights_m[index]) / dt)
            )
            normal_path_jacobian = float(np.dot(contact_normal_body, dcontact_q))
            if (
                backend is SuspensionBackend.MAPPED_KC_MASSLESS
                and contact_regimes[index] is ContactRegime.CONTACT
            ):
                if abs(normal_path_jacobian) <= 1.0e-8:
                    raise UnifiedDomainError(
                        f"corner {index} normal path Jacobian is singular"
                    )
                qdot[index] = -float(
                    np.dot(contact_normal_body, base_contact_velocity)
                ) / normal_path_jacobian
            contact_velocity = base_contact_velocity + dcontact_q * qdot[index]
            normal_velocity_residual = float(
                np.dot(contact_normal_body, contact_velocity)
            )
            normal_path_jacobians.append(normal_path_jacobian)
            normal_velocity_residuals.append(normal_velocity_residual)
            contact_velocities.append(contact_velocity)
            contact_velocity_x = float(np.dot(contact_velocity, contact_rotation[:, 0]))
            contact_velocity_y = float(np.dot(contact_velocity, contact_rotation[:, 1]))
            packet = SuspensionContactPacket(
                backend=contact_backend,
                normal_mode=normal_mode,
                in_contact=in_contact,
                kinematics=FinalContactKinematics(
                    contact_velocity_x,
                    contact_velocity_y,
                    float(wheels[index]),
                    float(cambers[index]),
                    loaded_radius_m=loaded_radius,
                    effective_radius_m=effective_radius,
                    surface_mu_x=command.surface_mu_x[index],
                    surface_mu_y=command.surface_mu_y[index],
                ),
                solved_normal_force_n=solved_normal_force,
                compression_m=compression_for_packet,
                compression_rate_mps=compression_rate_for_packet,
                rigid_gap_constraint_active=rigid_gap_constraint_active,
            )
            tire_inputs.append(adapt_contact(packet, self.tire_model, dt).tire_input)
            counts["tire_adapter"] += 1
        tire_outputs = self.tire_owner.evaluate(tire_ticket, tire_inputs)
        counts["tire_final_step"] += 4

        aero, aero_force, aero_moment, aero_relative_velocity = self._aero(
            platform_linear_velocity,
            platform_angular_velocity,
            heave,
            pitch,
            roll,
            steering.virtual_angle_rad,
            command.wind_body_m_s,
        )
        counts["aero_full_wrench"] += 1

        force_body: list[np.ndarray] = []
        moment_body: list[np.ndarray] = []
        q_contact = np.zeros(4)
        q_spring = np.zeros(4)
        q_damper = np.zeros(4)
        q_arb = np.zeros(4)
        arb_energy = 0.0
        for axle, pair in enumerate(((0, 1), (2, 3))):
            left, right = pair
            arb = self.arbs[axle]
            arb_left, arb_right, _ = arb.generalized(
                kc_values[left]["arb_coord"], kc_values[right]["arb_coord"]
            )
            q_arb[left] = arb_left * kc_derivatives[left]["arb_coord"]
            q_arb[right] = arb_right * kc_derivatives[right]["arb_coord"]
            arb_energy += arb.energy(kc_values[left]["arb_coord"], kc_values[right]["arb_coord"])
            counts["arb_backend"] += 1
        damper_power = 0.0
        corner_results: list[CornerEvaluation] = []
        brake_internal_errors: list[float] = []
        steering_road_loads = np.zeros(4)
        steering_mz_contributions = np.zeros(4)
        for index, output in enumerate(tire_outputs):
            deriv = kc_derivatives[index]
            if not math.isclose(
                output.effective_radius_m,
                effective_radius_predictions[index],
                rel_tol=2.0e-12,
                abs_tol=2.0e-12,
            ):
                raise RuntimeError("Tire changed the same-step geometry effective radius")
            wheel_rotation = wheel_rotations[index]
            contact_rotation = contact_rotations[index]
            contact_point = contact_points[index]
            contact_velocity = contact_velocities[index]
            fw = np.array([output.force_x_n, output.force_y_n, output.force_z_n], dtype=float)
            mw = np.array([output.moment_x_nm, output.moment_y_nm, output.moment_z_nm], dtype=float)
            fb = contact_rotation @ fw
            mb = contact_rotation @ mw
            force_body.append(fb)
            moment_body.append(mb)
            steering_road_loads[index] = float(
                np.dot(dcontact_steer_vectors[index], fb)
                + np.dot(omega_steer_vectors[index], mb)
            )
            q_contact[index] = float(
                np.dot(dcontact_q_vectors[index], fb)
                + np.dot(omega_q_vectors[index], mb)
            )
            mz_body = contact_rotation @ np.array([0.0, 0.0, output.moment_z_nm], dtype=float)
            steering_mz_contributions[index] = float(
                np.dot(omega_steer_vectors[index], mz_body)
            )
            spring_delta = kc_values[index]["spring_length"] - self.spring_free_lengths_m[index]
            q_spring[index] = -self.config.spring_stiffness_n_m[index] * spring_delta * deriv["spring_length"]
            damper_length_rate = deriv["damper_length"] * qdot[index]
            q_damper[index] = -self.config.damper_coefficient_n_s_m[index] * damper_length_rate * deriv["damper_length"]
            damper_power += self.config.damper_coefficient_n_s_m[index] * damper_length_rate**2
            compliance_target = (
                additive_compliance_model(float(q[index]), output.force_y_n, output.moment_z_nm)
                - additive_compliance_model(float(q[index]), 0.0, 0.0)
            )
            counts["spring_path"] += 1
            counts["damper_path"] += 1
            counts["compliance_policy"] += 1
            corner_contact_regime = (
                contact_regimes[index]
                if backend is SuspensionBackend.MAPPED_KC_MASSLESS
                else (
                    ContactRegime.CONTACT
                    if output.force_z_n > 0.0
                    else ContactRegime.AIRBORNE
                )
            )
            if backend is SuspensionBackend.MAPPED_KC_MASSLESS:
                assert fz_unknown is not None
                solved_normal_force_n = (
                    float(fz_unknown[index])
                    if corner_contact_regime is ContactRegime.CONTACT
                    else 0.0
                )
            else:
                solved_normal_force_n = float(output.force_z_n)
            corner_results.append(
                CornerEvaluation(
                    contact_regime=corner_contact_regime,
                    contact_gap_m=float(contact_gaps[index]),
                    normal_path_jacobian=float(normal_path_jacobians[index]),
                    normal_velocity_residual_m_s=float(normal_velocity_residuals[index]),
                    solved_normal_force_n=solved_normal_force_n,
                    normal_complementarity_n_m=abs(
                        float(contact_gaps[index]) * solved_normal_force_n
                    ),
                    wheel_angle_rad=float(wheel_angles[index]),
                    camber_rad=float(cambers[index]),
                    kc_values=dict(kc_values[index]),
                    tire=output,
                    force_body_n=tuple(map(float, fb)),
                    moment_body_nm=tuple(map(float, mb)),
                    contact_point_body_m=tuple(map(float, contact_point)),
                    contact_normal_body=tuple(map(float, contact_rotation[:, 2])),
                    contact_tangent_x_body=tuple(map(float, contact_rotation[:, 0])),
                    contact_tangent_y_body=tuple(map(float, contact_rotation[:, 1])),
                    contact_velocity_body_mps=tuple(map(float, contact_velocity)),
                    contact_velocity_x_mps=float(np.dot(contact_velocity, contact_rotation[:, 0])),
                    contact_velocity_y_mps=float(np.dot(contact_velocity, contact_rotation[:, 1])),
                    suspension_generalized_contact_n=float(q_contact[index]),
                    suspension_generalized_spring_n=float(q_spring[index]),
                    suspension_generalized_damper_n=float(q_damper[index]),
                    suspension_generalized_arb_n=float(q_arb[index]),
                    compliance_target_rad=float(compliance_target),
                    tire_compression_m=float(compressions[index]),
                    steering_generalized_road_load_nm=float(steering_road_loads[index]),
                    steering_intrinsic_mz_contribution_nm=float(steering_mz_contributions[index]),
                )
            )
            if index < 2:
                counts["steering_spatial_jtw"] += 1

        mapping = np.asarray(gearbox_ticket.trial.effective_mapping, dtype=float)
        engine_sample = self.engine_owner.evaluate(engine_ticket, we)
        rows: list[float] = []
        rows.append(
            self.engine_owner.model.asset.inertia_kg_m2 * (we - self.state.engine.omega_rad_s)
            - dt * engine_sample.free_torque_nm
            - clutch_impulse
        )
        wheel0 = np.asarray(previous.wheel_omega_rad_s, dtype=float)
        for index, output in enumerate(tire_outputs):
            rows.append(
                c.wheel_inertias_kg_m2[index] * (wheels[index] - wheel0[index])
                + mapping[index] * clutch_impulse
                + brake_impulses[index]
                - dt * (output.wheel_contact_torque_nm + command.wheel_external_torque_nm[index])
            )
        total_force = np.sum(np.asarray(force_body), axis=0) + aero_force
        rows.append(c.mass_kg * (u - previous.body_u_m_s - dt * yaw_rate * v) - dt * total_force[0])
        rows.append(c.mass_kg * (v - previous.body_v_m_s + dt * yaw_rate * u) - dt * total_force[1])
        yaw_moment = float(aero_moment[2])
        vertical_roll = float(aero_moment[0])
        vertical_pitch = float(aero_moment[1])
        for index, (contact_point, fb, mb, wheel_rotation) in enumerate(
            zip(contact_points, force_body, moment_body, wheel_rotations)
        ):
            contact_moment = np.cross(contact_point, fb) + mb
            brake_chassis_reaction = wheel_rotation @ np.array(
                [0.0, brake_impulses[index] / dt, 0.0],
                dtype=float,
            )
            brake_wheel_torque = -brake_chassis_reaction
            brake_internal_errors.append(
                float(np.max(np.abs(brake_wheel_torque + brake_chassis_reaction)))
            )
            contact_moment += brake_chassis_reaction
            yaw_moment += float(contact_moment[2])
            vertical_roll += float(contact_moment[0])
            vertical_pitch += float(contact_moment[1])
        rows.append(c.yaw_inertia_kg_m2 * (yaw_rate - previous.yaw_rate_rad_s) - dt * yaw_moment)
        capacity = c.clutch_capacity_nm * gearbox_ticket.trial.average_clutch_engagement * dt
        terminal_slip = we - float(np.dot(mapping, wheels))
        if clutch_regime is ClutchRegime.LOCKED:
            rows.append(terminal_slip)
        elif clutch_regime is ClutchRegime.OPEN:
            rows.append(clutch_impulse)
        else:
            target = -capacity if clutch_regime is ClutchRegime.SLIP_POSITIVE else capacity
            rows.append(clutch_impulse - target)

        if backend is SuspensionBackend.MAPPED_KC_MASSLESS:
            for index in range(4):
                rows.append(q_contact[index] + q_spring[index] + q_damper[index] + q_arb[index])
            assert fz_unknown is not None
            for index, regime in enumerate(contact_regimes):
                if regime is ContactRegime.CONTACT:
                    rows.append(contact_gaps[index])
                else:
                    rows.append(float(fz_unknown[index]))
        else:
            q0 = np.asarray(previous.suspension_q_m, dtype=float)
            qdot0 = np.asarray(previous.suspension_qdot_m_s, dtype=float)
            for index in range(4):
                rows.append(q[index] - q0[index] - dt * qdot[index])
            for index in range(4):
                rows.append(
                    self.config.unsprung_mass_kg[index] * (qdot[index] - qdot0[index]) / dt
                    - (q_contact[index] + q_spring[index] + q_damper[index] + q_arb[index])
                )
        rows.append(float(total_force[2] - c.mass_kg * c.gravity_m_s2))
        rows.append(vertical_roll)
        rows.append(vertical_pitch)
        for index, corner in enumerate(corner_results):
            rows.append(compliance[index] - corner.compliance_target_rad)

        for index, regime in enumerate(brake_regimes):
            capacity_impulse = assists.total_brake_capacity_nm[index] * dt
            if regime is BrakeRegime.OPEN:
                rows.append(brake_impulses[index])
            elif regime is BrakeRegime.LOCKED:
                rows.append(wheels[index])
            elif regime is BrakeRegime.KINETIC_POSITIVE:
                rows.append(brake_impulses[index] - capacity_impulse)
            else:
                rows.append(brake_impulses[index] + capacity_impulse)

        torque_rack_evaluation: TorqueRackEvaluation | None = None
        if SteeringCausality(c.steering_causality) is SteeringCausality.TORQUE_DRIVEN:
            assert command.steering_driver_torque_nm is not None
            rack_q, rack_rate = map(float, x[sl["steer"]])
            rack_state = RackState(rack_q, rack_rate)
            torque_rack_evaluation = self.torque_rack.evaluate(
                rack_state,
                command.steering_driver_torque_nm,
                float(steering_road_loads[0] + steering_road_loads[1]),
                u,
                command.steering_driver_releasing,
            )
            previous_steering = steering_ticket.snapshot
            rows.append(rack_q - previous_steering.rack_q - dt * rack_rate)
            rows.append(
                c.torque_rack.equivalent_inertia_nm_s2
                * (rack_rate - previous_steering.rack_rate_q_s)
                - dt * torque_rack_evaluation.total_generalized_torque_nm
            )

        call_audit = CouplingCallAudit(**counts)
        return _Evaluation(
            rows=np.asarray(rows, dtype=float),
            corners=tuple(corner_results),
            aero=aero,
            aero_force_cg=aero_force,
            aero_moment_cg=aero_moment,
            aero_relative_velocity_at_reference_body=aero_relative_velocity,
            tire_outputs=tire_outputs,
            calls=call_audit,
            damper_dissipation_w=float(damper_power),
            arb_energy_j=float(arb_energy),
            steering_wheel_generalized_loads_nm=(
                float(steering_road_loads[0]),
                float(steering_road_loads[1]),
            ),
            steering_intrinsic_mz_generalized_nm=float(
                steering_mz_contributions[0] + steering_mz_contributions[1]
            ),
            steering_control=steering,
            torque_rack_evaluation=torque_rack_evaluation,
            brake_internal_action_reaction_inf_nm=max(brake_internal_errors, default=0.0),
            suspension_qdot_m_s=tuple(map(float, qdot)),
        )

    def step(self, command: UnifiedVehicleCommand, dt: float, backend: SuspensionBackend) -> UnifiedVehicleStepResult:
        command.validate()
        if not math.isfinite(dt) or dt <= 0.0:
            raise ValueError("dt must be finite and positive")
        backend = SuspensionBackend(backend)
        steering_causality = SteeringCausality(self.config.steering_causality)
        if steering_causality is SteeringCausality.POSITION_COMMAND:
            if command.steering_driver_torque_nm is not None:
                raise ValueError("POSITION_COMMAND and steering driver torque are mutually exclusive")
        else:
            if command.steering_driver_torque_nm is None:
                raise ValueError("TORQUE_DRIVEN requires steering_driver_torque_nm")
            if abs(command.steering.value) > 1.0e-15:
                raise ValueError("TORQUE_DRIVEN cannot also consume a position steering command")
        if self.state.engine is not self.engine_owner.state:
            raise RuntimeError("Unified state lost Engine ownership")
        if self.state.gearbox is not self.gearbox_owner.state:
            raise RuntimeError("Unified state lost Gearbox ownership")
        if self.state.steering is not self.steering_owner.state:
            raise RuntimeError("Unified state lost Steering ownership")
        if self.state.tires is not self.tire_owner.state:
            raise RuntimeError("Unified state lost Tire ownership")
        if self.state.mechanics is not self.mechanical_owner.state:
            raise RuntimeError("Unified state lost mechanical ownership")

        begun: list[str] = []
        preflighted: list[str] = []
        committed: list[str] = []
        aborted: list[str] = []
        rolled_back: list[str] = []
        step_snapshot = self.state
        commit_phase_started = False
        engine_ticket = gearbox_ticket = steering_ticket = tire_ticket = mechanical_ticket = None
        try:
            gearbox_ticket = self.gearbox_owner.begin_substep(command.gearbox, dt); begun.append("gearbox")
            if steering_causality is SteeringCausality.POSITION_COMMAND:
                steering_ticket = self.steering_owner.begin_substep(
                    command.steering,
                    self.state.mechanics.body_u_m_s,
                    dt,
                )
            else:
                steering_ticket = self.steering_owner.begin_torque_substep(
                    self.state.mechanics.body_u_m_s,
                    dt,
                )
            begun.append("steering")
            mapping = np.asarray(gearbox_ticket.trial.effective_mapping, dtype=float)
            assists = self.brake_assist_controller.evaluate(
                service_brake_request=command.service_brake_request,
                parking_brake_request=command.parking_brake_request,
                body_u_m_s=self.state.mechanics.body_u_m_s,
                yaw_rate_rad_s=self.state.mechanics.yaw_rate_rad_s,
                steering_curvature_1pm=steering_ticket.trial.output.curvature_1pm,
                wheel_omega_rad_s=tuple(self.state.mechanics.wheel_omega_rad_s),
                effective_radius_m=tuple(self.static_effective_radii_m),
                driven_wheels=tuple(abs(value) > 1.0e-12 for value in mapping),
            )
            engine_command = replace(
                command.engine,
                positive_torque_limit=min(
                    command.engine.positive_torque_limit,
                    assists.engine_positive_torque_limit,
                ),
            )
            engine_ticket = self.engine_owner.begin_substep(engine_command, dt); begun.append("engine")
            tire_ticket = self.tire_owner.begin_substep(); begun.append("tires")
            mechanical_ticket = self.mechanical_owner.begin_substep(); begun.append("mechanics")
            clutch_regime = self._select_clutch_regime(mapping, gearbox_ticket.trial.average_clutch_engagement)
            brake_regimes = self._select_brake_regimes(assists.total_brake_capacity_nm, dt)
            contact_regimes = self._select_contact_regimes(backend)
            capacity = self.config.clutch_capacity_nm * gearbox_ticket.trial.average_clutch_engagement
            x0 = self._initial_vector(backend)
            lo, hi = self._bounds(backend, dt, capacity, assists.total_brake_capacity_nm)
            interior_margin = np.minimum(1.0e-10, 0.25 * (hi - lo))
            x0 = np.minimum(np.maximum(x0, lo + interior_margin), hi - interior_margin)
            x_seed = x0
            clutch_active_set_events: list[str] = []
            brake_active_set_events: list[str] = []
            contact_active_set_events: list[str] = []
            visited_active_modes: set[
                tuple[
                    ClutchRegime,
                    tuple[BrakeRegime, ...],
                    tuple[ContactRegime, ...],
                ]
            ] = set()
            total_nonlinear_evaluations = 0
            solver_attempts: list[str] = []
            accepted_solver_method = ""
            accepted_solver_status = 0
            accepted_solver_message = ""
            solution = None
            accepted = None
            scaled_inf = math.inf
            active_set_iterations = 0
            last_active_set_diagnostic = "not-evaluated"
            for active_set_iterations in range(1, 11):
                scales = self._row_scales(backend, contact_regimes)
                active_modes = (clutch_regime, brake_regimes, contact_regimes)
                if active_modes in visited_active_modes:
                    cycle_message = (
                        "coupled clutch/brake/contact active-set mode cycle: "
                        f"clutch={clutch_regime.value}; "
                        f"brake={[mode.value for mode in brake_regimes]}; "
                        f"contact={[mode.value for mode in contact_regimes]}; "
                        f"clutch_events={clutch_active_set_events}; "
                        f"brake_events={brake_active_set_events}; "
                        f"contact_events={contact_active_set_events}; "
                        f"last_candidate={last_active_set_diagnostic}"
                    )
                    if contact_active_set_events:
                        raise RigidBodyDynamicsHostRequired(
                            "RIGID_BODY_DYNAMICS_HOST_REQUIRED: the reduced quasi-static "
                            "platform has no admissible unilateral-contact equilibrium; "
                            + cycle_message
                        )
                    raise UnifiedSolveError(cycle_message)
                visited_active_modes.add(active_modes)

                def scaled_rows(candidate: np.ndarray) -> np.ndarray:
                    evaluated = self._evaluate(
                        candidate,
                        backend,
                        dt,
                        command,
                        engine_ticket,
                        gearbox_ticket,
                        steering_ticket,
                        tire_ticket,
                        clutch_regime,
                        assists,
                        brake_regimes,
                        contact_regimes,
                    )
                    return evaluated.rows / scales

                # The accepted root normally lies close to the previous
                # terminal state.  Bounded least squares is the defensive
                # fallback and also exposes an infeasible LOCKED reaction at
                # its capacity bound to the active-set update below.
                remaining_budget = (
                    self.config.max_total_nonlinear_evaluations
                    - total_nonlinear_evaluations
                )
                if remaining_budget <= 0:
                    raise UnifiedSolveError("aggregate nonlinear evaluation budget exhausted")
                root_budget = min(
                    self.config.max_nonlinear_evaluations,
                    remaining_budget,
                )
                root_solution = None
                root_in_bounds = False
                try:
                    root_solution = root(
                        scaled_rows,
                        x_seed,
                        method="hybr",
                        options={
                            "xtol": 2.0e-9,
                            "maxfev": root_budget,
                        },
                    )
                    total_nonlinear_evaluations += int(root_solution.nfev)
                    if total_nonlinear_evaluations > self.config.max_total_nonlinear_evaluations:
                        raise UnifiedSolveError("aggregate nonlinear evaluation budget exceeded by root solver")
                    root_in_bounds = bool(
                        np.all(root_solution.x >= lo - 1.0e-10)
                        and np.all(root_solution.x <= hi + 1.0e-10)
                    )
                    solver_attempts.append(
                        f"active_set={active_set_iterations}:root-hybr:"
                        f"status={int(root_solution.status)}:success={bool(root_solution.success)}:"
                        f"in_bounds={root_in_bounds}:nfev={int(root_solution.nfev)}"
                    )
                except UnifiedDomainError as exc:
                    solver_attempts.append(
                        f"active_set={active_set_iterations}:root-hybr:"
                        f"domain-rejected={type(exc).__name__}:{exc}"
                    )
                solution = root_solution
                accepted_solver_method = "root-hybr"
                if root_solution is None or not root_solution.success or not root_in_bounds:
                    remaining_budget = (
                        self.config.max_total_nonlinear_evaluations
                        - total_nonlinear_evaluations
                    )
                    if remaining_budget <= 0:
                        raise UnifiedSolveError(
                            "aggregate nonlinear evaluation budget exhausted before bounded fallback"
                        )
                    least_squares_budget = min(
                        self.config.max_nonlinear_evaluations,
                        remaining_budget,
                    )
                    solution = least_squares(
                        scaled_rows,
                        x_seed,
                        bounds=(lo, hi),
                        xtol=2.0e-10,
                        ftol=2.0e-10,
                        gtol=2.0e-10,
                        max_nfev=least_squares_budget,
                        x_scale="jac",
                    )
                    total_nonlinear_evaluations += int(solution.nfev)
                    if total_nonlinear_evaluations > self.config.max_total_nonlinear_evaluations:
                        raise UnifiedSolveError(
                            "aggregate nonlinear evaluation budget exceeded by bounded fallback"
                        )
                    solver_attempts.append(
                        f"active_set={active_set_iterations}:least-squares-trf:"
                        f"status={int(solution.status)}:success={bool(solution.success)}:"
                        f"nfev={int(solution.nfev)}"
                    )
                    accepted_solver_method = "least-squares-trf"
                accepted_solver_status = int(solution.status)
                accepted_solver_message = str(solution.message)
                if backend is SuspensionBackend.MAPPED_KC_MASSLESS:
                    normal_slice = self._slices(backend)["fz"]
                    for index, regime in enumerate(contact_regimes):
                        if regime is ContactRegime.AIRBORNE:
                            solution.x[normal_slice][index] = 0.0
                if (
                    total_nonlinear_evaluations + 1
                    > self.config.max_total_nonlinear_evaluations
                ):
                    raise UnifiedSolveError(
                        "aggregate nonlinear evaluation budget exhausted before final instrumentation"
                    )
                accepted = self._evaluate(
                    solution.x,
                    backend,
                    dt,
                    command,
                    engine_ticket,
                    gearbox_ticket,
                    steering_ticket,
                    tire_ticket,
                    clutch_regime,
                    assists,
                    brake_regimes,
                    contact_regimes,
                    instrument=True,
                )
                total_nonlinear_evaluations += 1
                scaled_inf = float(np.max(np.abs(accepted.rows / scales)))
                sl = self._slices(backend)
                scaled_components = accepted.rows / scales
                peak_index = int(np.argmax(np.abs(scaled_components)))
                platform_candidate = tuple(map(float, solution.x[sl["platform"]]))
                last_active_set_diagnostic = (
                    f"scaled_inf={scaled_inf:.9g}:"
                    f"peak={self._row_labels(backend, contact_regimes)[peak_index]}:"
                    f"hF={platform_candidate[0]:.9g}:roll={platform_candidate[1]:.9g}:"
                    f"hR={platform_candidate[2]:.9g}"
                )
                trial_wheels = tuple(map(float, solution.x[sl["w"]]))
                trial_brake_impulses = tuple(map(float, solution.x[sl["brake"]]))
                trial_clutch_impulse = float(solution.x[sl["j"]])
                trial_terminal_slip = (
                    float(solution.x[sl["we"]])
                    - float(np.dot(mapping, trial_wheels))
                )
                feasible = bool(
                    solution.success
                    and scaled_inf <= self.config.residual_tolerance
                )
                next_clutch_regime = clutch_regime
                clutch_capacity_impulse = capacity * dt
                if clutch_regime is ClutchRegime.LOCKED:
                    unconstrained_clutch_impulse = trial_clutch_impulse
                    if root_solution is not None and bool(root_solution.success):
                        unconstrained_clutch_impulse = float(root_solution.x[sl["j"]])
                    at_capacity = abs(trial_clutch_impulse) >= max(
                        0.0,
                        clutch_capacity_impulse
                        - max(2.0e-8, 1.0e-6 * clutch_capacity_impulse),
                    )
                    if unconstrained_clutch_impulse < -clutch_capacity_impulse - 2.0e-7:
                        next_clutch_regime = ClutchRegime.SLIP_POSITIVE
                    elif unconstrained_clutch_impulse > clutch_capacity_impulse + 2.0e-7:
                        next_clutch_regime = ClutchRegime.SLIP_NEGATIVE
                    elif not feasible and at_capacity:
                        next_clutch_regime = (
                            ClutchRegime.SLIP_POSITIVE
                            if trial_clutch_impulse < 0.0
                            else ClutchRegime.SLIP_NEGATIVE
                        )
                elif (
                    clutch_regime is ClutchRegime.SLIP_POSITIVE
                    and trial_terminal_slip < -2.0e-7
                ) or (
                    clutch_regime is ClutchRegime.SLIP_NEGATIVE
                    and trial_terminal_slip > 2.0e-7
                ):
                    next_clutch_regime = ClutchRegime.LOCKED
                next_modes = list(brake_regimes)
                for index, regime in enumerate(brake_regimes):
                    if regime is BrakeRegime.KINETIC_POSITIVE and trial_wheels[index] < -1.0e-7:
                        next_modes[index] = BrakeRegime.LOCKED
                    elif regime is BrakeRegime.KINETIC_NEGATIVE and trial_wheels[index] > 1.0e-7:
                        next_modes[index] = BrakeRegime.LOCKED

                if not feasible:
                    for index, regime in enumerate(brake_regimes):
                        if regime is not BrakeRegime.LOCKED:
                            continue
                        cap_impulse = assists.total_brake_capacity_nm[index] * dt
                        impulse = trial_brake_impulses[index]
                        at_capacity = abs(impulse) >= max(0.0, cap_impulse - max(2.0e-8, 1.0e-6 * cap_impulse))
                        if at_capacity:
                            direction = impulse if abs(impulse) > 1.0e-12 else trial_wheels[index]
                            next_modes[index] = (
                                BrakeRegime.KINETIC_POSITIVE
                                if direction >= 0.0
                                else BrakeRegime.KINETIC_NEGATIVE
                            )

                next_contact_modes = list(contact_regimes)
                contact_transition_reasons: list[str] = []
                if backend is SuspensionBackend.MAPPED_KC_MASSLESS:
                    assert "fz" in sl
                    trial_fz = tuple(map(float, solution.x[sl["fz"]]))
                    for index, regime in enumerate(contact_regimes):
                        gap = accepted.corners[index].contact_gap_m
                        if regime is ContactRegime.CONTACT:
                            unconstrained_reaction = trial_fz[index]
                            if (
                                root_solution is not None
                                and bool(root_solution.success)
                            ):
                                unconstrained_reaction = float(root_solution.x[sl["fz"]][index])
                            at_zero_reaction = (
                                trial_fz[index]
                                <= self.config.normal_reaction_tolerance_n
                            )
                            if (
                                unconstrained_reaction
                                < -self.config.normal_reaction_tolerance_n
                                or at_zero_reaction
                            ):
                                next_contact_modes[index] = ContactRegime.AIRBORNE
                                contact_transition_reasons.append(
                                    f"corner={index}:release:raw_reaction={unconstrained_reaction:.9g}:"
                                    f"bounded_reaction={trial_fz[index]:.9g}:"
                                    f"scaled_inf={scaled_inf:.9g}:hF={platform_candidate[0]:.9g}:"
                                    f"hR={platform_candidate[2]:.9g}:"
                                    f"peak={self._row_labels(backend, contact_regimes)[peak_index]}"
                                )
                        elif gap < -self.config.contact_gap_tolerance_m:
                            next_contact_modes[index] = ContactRegime.CONTACT
                            contact_transition_reasons.append(
                                f"corner={index}:recontact:gap={gap:.9g}"
                            )

                    # A domain-safe bounded solve can stop before exposing the
                    # negative unconstrained reaction that identifies lift-off
                    # (for example when the all-contact platform pitch reaches
                    # its admissible box).  Explore the clearly unloaded
                    # contact group only as an alternate active set; it still
                    # must satisfy the full residual and AIRBORNE gap
                    # inequality before it can be accepted.
                    if (
                        not feasible
                        and tuple(next_contact_modes) == contact_regimes
                        and next_clutch_regime is clutch_regime
                        and tuple(next_modes) == brake_regimes
                    ):
                        active_indices = [
                            index
                            for index, regime in enumerate(contact_regimes)
                            if regime is ContactRegime.CONTACT
                        ]
                        if len(active_indices) > 1:
                            active_reactions = [trial_fz[index] for index in active_indices]
                            maximum_reaction = max(active_reactions)
                            minimum_reaction = min(active_reactions)
                            if (
                                maximum_reaction
                                > self.config.normal_reaction_tolerance_n
                                and minimum_reaction / maximum_reaction < 0.25
                            ):
                                grouped_limit = minimum_reaction + 0.05 * maximum_reaction
                                for index in active_indices:
                                    if trial_fz[index] <= grouped_limit:
                                        next_contact_modes[index] = ContactRegime.AIRBORNE
                                        contact_transition_reasons.append(
                                            f"corner={index}:infeasible-low-reaction-search:"
                                            f"reaction={trial_fz[index]:.9g}:scaled_inf={scaled_inf:.9g}:"
                                            f"hF={platform_candidate[0]:.9g}:hR={platform_candidate[2]:.9g}:"
                                            f"peak={self._row_labels(backend, contact_regimes)[peak_index]}"
                                        )

                updated_modes = tuple(next_modes)
                updated_contact_modes = tuple(next_contact_modes)
                if (
                    feasible
                    and next_clutch_regime is clutch_regime
                    and updated_modes == brake_regimes
                    and updated_contact_modes == contact_regimes
                ):
                    break
                if (
                    next_clutch_regime is clutch_regime
                    and updated_modes == brake_regimes
                    and updated_contact_modes == contact_regimes
                ):
                    raise UnifiedSolveError(
                        f"{backend.value} solve failed: {solution.message}; scaled_inf={scaled_inf:.3e}"
                    )
                if next_clutch_regime is not clutch_regime:
                    clutch_active_set_events.append(
                        f"{clutch_regime.value} -> {next_clutch_regime.value}"
                    )
                if updated_modes != brake_regimes:
                    brake_active_set_events.append(
                        ",".join(mode.value for mode in brake_regimes)
                        + " -> "
                        + ",".join(mode.value for mode in updated_modes)
                    )
                if updated_contact_modes != contact_regimes:
                    contact_active_set_events.append(
                        ",".join(mode.value for mode in contact_regimes)
                        + " -> "
                        + ",".join(mode.value for mode in updated_contact_modes)
                        + "; "
                        + " | ".join(contact_transition_reasons)
                    )
                clutch_regime = next_clutch_regime
                brake_regimes = updated_modes
                contact_regimes = updated_contact_modes
                x_seed = np.minimum(
                    np.maximum(solution.x, lo + interior_margin),
                    hi - interior_margin,
                )
            else:
                raise UnifiedSolveError("coupled brake/contact active-set iteration limit")
            assert solution is not None and accepted is not None
            sl = self._slices(backend)
            we = float(solution.x[sl["we"]])
            wheels = tuple(map(float, solution.x[sl["w"]]))
            u, v, yaw_rate = map(float, solution.x[sl["body"]])
            clutch_impulse = float(solution.x[sl["j"]])
            q = tuple(map(float, solution.x[sl["q"]]))
            qdot = accepted.suspension_qdot_m_s
            front_height, roll, rear_height = map(float, solution.x[sl["platform"]])
            heave, pitch = self._platform_pose_from_heights(front_height, rear_height)
            toe = tuple(map(float, solution.x[sl["toe"]]))
            brake_impulses = tuple(map(float, solution.x[sl["brake"]]))
            loads = tuple(float(corner.tire.force_z_n) for corner in accepted.corners)
            capacity_impulse = capacity * dt
            if clutch_regime is ClutchRegime.LOCKED and abs(clutch_impulse) > capacity_impulse + 2.0e-5:
                raise UnifiedSolveError("locked clutch root exceeds finite capacity")
            terminal_slip = we - float(np.dot(mapping, wheels))
            if clutch_regime is ClutchRegime.SLIP_POSITIVE and terminal_slip < -1.0e-5:
                raise UnifiedSolveError("positive-slip clutch candidate crossed its mode boundary")
            if clutch_regime is ClutchRegime.SLIP_NEGATIVE and terminal_slip > 1.0e-5:
                raise UnifiedSolveError("negative-slip clutch candidate crossed its mode boundary")
            for index, regime in enumerate(brake_regimes):
                cap_impulse = assists.total_brake_capacity_nm[index] * dt
                if abs(brake_impulses[index]) > cap_impulse + 2.0e-6:
                    raise UnifiedSolveError("brake reaction exceeds actuator capacity")
                if regime is BrakeRegime.KINETIC_POSITIVE and wheels[index] < -1.0e-6:
                    raise UnifiedSolveError("positive kinetic brake crossed zero after active-set solve")
                if regime is BrakeRegime.KINETIC_NEGATIVE and wheels[index] > 1.0e-6:
                    raise UnifiedSolveError("negative kinetic brake crossed zero after active-set solve")
            final_contact_regimes = tuple(corner.contact_regime for corner in accepted.corners)
            if backend is SuspensionBackend.MAPPED_KC_MASSLESS:
                if final_contact_regimes != contact_regimes:
                    raise RuntimeError("mapped contact result lost its accepted active-set modes")
                for index, (regime, corner) in enumerate(
                    zip(contact_regimes, accepted.corners)
                ):
                    if regime is ContactRegime.CONTACT:
                        if (
                            corner.solved_normal_force_n
                            >= self.config.normal_reaction_upper_bound_n
                            - self.config.normal_reaction_tolerance_n
                        ):
                            raise UnifiedDomainError(
                                f"corner {index} reached the declared normal-reaction numerical bound"
                            )
                        if abs(
                            corner.solved_normal_force_n - corner.tire.force_z_n
                        ) > self.config.normal_reaction_tolerance_n:
                            raise UnifiedSolveError(
                                f"contact corner {index} lost normal-authority identity"
                            )
                        if (
                            abs(corner.normal_velocity_residual_m_s)
                            > self.config.normal_velocity_tolerance_m_s
                        ):
                            raise UnifiedSolveError(
                                f"contact corner {index} violates velocity-level closure"
                            )
                    if regime is ContactRegime.AIRBORNE:
                        if (
                            abs(corner.tire.force_z_n)
                            > self.config.normal_reaction_tolerance_n
                        ):
                            raise UnifiedSolveError(
                                f"airborne corner {index} retained a road normal reaction"
                            )
                        if (
                            corner.contact_gap_m
                            < -self.config.contact_gap_tolerance_m
                        ):
                            raise UnifiedSolveError(
                                f"airborne corner {index} penetrated the rigid road"
                            )

            reaction = self.steering_owner.evaluate_projected_reaction(
                steering_ticket,
                u,
                WheelAngles(*accepted.steering_wheel_generalized_loads_nm),
                accepted.steering_intrinsic_mz_generalized_nm,
            )
            if steering_causality is SteeringCausality.TORQUE_DRIVEN:
                rack_q, rack_rate = map(float, solution.x[sl["steer"]])
                reaction = replace(
                    reaction,
                    next_state=replace(
                        reaction.next_state,
                        rack_q=rack_q,
                        rack_rate_q_s=rack_rate,
                    ),
                )
            calls = accepted.calls
            old = self.state.mechanics
            yaw_next = old.yaw_rad + dt * yaw_rate
            world_vx = math.cos(yaw_next) * u - math.sin(yaw_next) * v
            world_vy = math.sin(yaw_next) * u + math.cos(yaw_next) * v
            mechanics_next = MechanicalState(
                wheel_omega_rad_s=wheels,
                body_u_m_s=u,
                body_v_m_s=v,
                yaw_rate_rad_s=yaw_rate,
                world_x_m=old.world_x_m + dt * world_vx,
                world_y_m=old.world_y_m + dt * world_vy,
                yaw_rad=yaw_next,
                suspension_q_m=q,
                suspension_qdot_m_s=qdot,
                platform_heave_m=heave,
                platform_roll_rad=roll,
                platform_pitch_rad=pitch,
                compliance_toe_rad=toe,
                normal_loads_n=loads,
                road_heights_m=command.road_heights_m,
            )
            # Construct and validate every candidate before any canonical assignment.
            engine_candidate = replace(engine_ticket.trial.next_controller_state, omega_rad_s=we)
            candidate_state = UnifiedVehicleState(
                engine_candidate,
                gearbox_ticket.trial.next_state,
                reaction.next_state,
                tuple(output.state_next for output in accepted.tire_outputs),
                mechanics_next,
            )
            candidate_state.mechanics.validate()
            self.engine_owner.validate_commit(engine_ticket, we); preflighted.append("engine")
            self.gearbox_owner.validate_commit(gearbox_ticket); preflighted.append("gearbox")
            self.steering_owner.validate_commit(steering_ticket, reaction); preflighted.append("steering")
            self.tire_owner.validate_commit(tire_ticket, accepted.tire_outputs); preflighted.append("tires")
            self.mechanical_owner.validate_commit(mechanical_ticket, mechanics_next); preflighted.append("mechanics")
            commit_phase_started = True
            engine_state = self.engine_owner.commit(engine_ticket, we); committed.append("engine")
            gearbox_state = self.gearbox_owner.commit(gearbox_ticket); committed.append("gearbox")
            steering_state = self.steering_owner.commit(steering_ticket, reaction); committed.append("steering")
            tire_states = self.tire_owner.commit(tire_ticket, accepted.tire_outputs); committed.append("tires")
            mechanical_state = self.mechanical_owner.commit(mechanical_ticket, mechanics_next); committed.append("mechanics")
            self.state = UnifiedVehicleState(engine_state, gearbox_state, steering_state, tire_states, mechanical_state)
            transaction = TransactionAudit(tuple(begun), tuple(preflighted), tuple(committed), ())
            self.last_transaction_audit = transaction
            tire_force = np.sum(np.asarray([corner.force_body_n for corner in accepted.corners]), axis=0)
            tire_moment_cg = np.sum(
                np.asarray(
                    [
                        np.cross(
                            np.asarray(corner.contact_point_body_m, dtype=float),
                            np.asarray(corner.force_body_n, dtype=float),
                        )
                        + np.asarray(corner.moment_body_nm, dtype=float)
                        for corner in accepted.corners
                    ]
                ),
                axis=0,
            )
            road_reaction = -tire_force
            road_reaction_moment = -tire_moment_cg
            air_reaction = -accepted.aero_force_cg
            air_reaction_moment = -accepted.aero_moment_cg
            front_mz = accepted.corners[0].tire.moment_z_nm + accepted.corners[1].tire.moment_z_nm
            actual_brake_torque = tuple(-impulse / dt for impulse in brake_impulses)
            brake_margin = tuple(
                assists.total_brake_capacity_nm[index] - abs(actual_brake_torque[index])
                for index in range(4)
            )
            return UnifiedVehicleStepResult(
                backend=backend,
                state=self.state,
                corners=accepted.corners,
                aero_at_reference=accepted.aero,
                aero_force_at_cg_n=tuple(map(float, accepted.aero_force_cg)),
                aero_moment_at_cg_nm=tuple(map(float, accepted.aero_moment_cg)),
                steering_control=accepted.steering_control,
                steering_reaction=reaction.output,
                clutch_regime=clutch_regime,
                clutch_impulse_nms=clutch_impulse,
                clutch_capacity_margin_nms=float(capacity_impulse - abs(clutch_impulse)),
                clutch_active_set_iterations=1 + len(clutch_active_set_events),
                clutch_active_set_events=tuple(clutch_active_set_events),
                residual_scaled_inf=scaled_inf,
                residual_row_labels=self._row_labels(backend, final_contact_regimes),
                residual_scaled_components=tuple(map(float, accepted.rows / scales)),
                nonlinear_evaluations=int(total_nonlinear_evaluations),
                nonlinear_solver_method=accepted_solver_method,
                nonlinear_solver_status=accepted_solver_status,
                nonlinear_solver_message=accepted_solver_message,
                nonlinear_solver_attempts=tuple(solver_attempts),
                vehicle_contact_force_n=tuple(map(float, tire_force)),
                vehicle_contact_moment_at_cg_nm=tuple(map(float, tire_moment_cg)),
                road_contact_reaction_n=tuple(map(float, road_reaction)),
                road_contact_reaction_moment_at_cg_nm=tuple(map(float, road_reaction_moment)),
                air_reaction_force_n=tuple(map(float, air_reaction)),
                air_reaction_moment_at_cg_nm=tuple(map(float, air_reaction_moment)),
                action_reaction_inf_n=float(np.max(np.abs(tire_force + road_reaction))),
                action_reaction_moment_inf_nm=float(
                    np.max(np.abs(tire_moment_cg + road_reaction_moment))
                ),
                aero_action_reaction_inf_n=float(np.max(np.abs(accepted.aero_force_cg + air_reaction))),
                aero_action_reaction_moment_inf_nm=float(
                    np.max(np.abs(accepted.aero_moment_cg + air_reaction_moment))
                ),
                aero_reference_point_body_m=tuple(
                    map(float, self.aero_map.reference.ref_point_vehicle_m)
                ),
                aero_relative_velocity_at_reference_body_mps=tuple(
                    map(float, accepted.aero_relative_velocity_at_reference_body)
                ),
                aero_wrench_frame="BODY_X_FORWARD_Y_LEFT_Z_UP_ABOUT_CG",
                aero_ground_reference_quality="REDUCED_FLAT_ROAD_CHASSIS_DATUM_PROXY",
                clutch_virtual_work_j=float(clutch_impulse * terminal_slip),
                damper_dissipation_w=accepted.damper_dissipation_w,
                arb_energy_j=accepted.arb_energy_j,
                front_intrinsic_mz_chassis_nm=float(front_mz),
                front_intrinsic_mz_steering_input_nm=float(front_mz),
                steering_road_generalized_load_nm=float(
                    sum(accepted.steering_wheel_generalized_loads_nm)
                ),
                steering_intrinsic_mz_generalized_contribution_nm=float(
                    accepted.steering_intrinsic_mz_generalized_nm
                ),
                transaction=transaction,
                calls=calls,
                steering_causality=steering_causality,
                torque_rack_evaluation=accepted.torque_rack_evaluation,
                assists=assists,
                brake_regimes=brake_regimes,
                brake_capacity_nm=tuple(assists.total_brake_capacity_nm),
                actual_brake_torque_nm=actual_brake_torque,
                brake_capacity_margin_nm=brake_margin,
                brake_internal_action_reaction_inf_nm=accepted.brake_internal_action_reaction_inf_nm,
                brake_active_set_iterations=1 + len(brake_active_set_events),
                brake_active_set_events=tuple(brake_active_set_events),
                contact_regimes=final_contact_regimes,
                contact_active_set_iterations=(
                    1 + len(contact_active_set_events)
                    if backend is SuspensionBackend.MAPPED_KC_MASSLESS
                    else 0
                ),
                contact_active_set_events=tuple(contact_active_set_events),
                normal_complementarity_inf_n_m=max(
                    corner.normal_complementarity_n_m
                    for corner in accepted.corners
                ),
                normal_velocity_residual_inf_m_s=max(
                    abs(corner.normal_velocity_residual_m_s)
                    for corner in accepted.corners
                    if corner.contact_regime is ContactRegime.CONTACT
                ) if any(
                    corner.contact_regime is ContactRegime.CONTACT
                    for corner in accepted.corners
                ) else 0.0,
                contact_geometry_quality="REDUCED_FLAT_ROAD_HEIGHT_SIGNAL",
            )
        except Exception:
            rollback_order = (
                ("mechanics", self.mechanical_owner, mechanical_ticket),
                ("tires", self.tire_owner, tire_ticket),
                ("steering", self.steering_owner, steering_ticket),
                ("gearbox", self.gearbox_owner, gearbox_ticket),
                ("engine", self.engine_owner, engine_ticket),
            )
            if commit_phase_started:
                for name, owner, ticket in rollback_order:
                    if ticket is None:
                        continue
                    if owner.restore_group_snapshot(ticket):
                        rolled_back.append(name)
                    else:
                        aborted.append(name)
                self.state = step_snapshot
            else:
                for name, owner, ticket in rollback_order:
                    if ticket is not None:
                        try:
                            owner.abort(ticket)
                            aborted.append(name)
                        except RuntimeError:
                            pass
            self.last_transaction_audit = TransactionAudit(
                tuple(begun),
                tuple(preflighted),
                tuple(committed),
                tuple(aborted),
                tuple(rolled_back),
            )
            raise

    def step_driver(
        self,
        direction_fsm: DriverDirectionFSM,
        driver_command: DriverCommand,
        dt: float,
        backend: SuspensionBackend,
        *,
        environment_command: UnifiedVehicleCommand | None = None,
    ) -> DriverControlledStepResult:
        """Run Driver intent and the vehicle as one preflighted outer trial.

        The direction FSM owns intent only.  Its state is committed after the
        five physical owners accept their step, and is aborted if the vehicle
        rejects the candidate.  Environment/road fields may be supplied by a
        low-level command, but its actuator requests are replaced by this
        driver trial so ownership cannot be ambiguous.
        """

        if SteeringCausality(self.config.steering_causality) is not SteeringCausality.POSITION_COMMAND:
            raise ValueError("step_driver is the position-command causal path; torque steering uses step()")
        trial = direction_fsm.prepare(
            driver_command,
            signed_speed_m_s=self.state.mechanics.body_u_m_s,
            dt=dt,
        )
        direction_fsm.validate_commit(trial)
        base = environment_command or UnifiedVehicleCommand(engine=trial.engine)
        engine = replace(
            base.engine,
            throttle_request=trial.engine.throttle_request,
        )
        command = replace(
            base,
            engine=engine,
            gearbox=trial.gearbox,
            steering=trial.steering,
            steering_driver_torque_nm=None,
            steering_driver_releasing=False,
            service_brake_request=trial.service_brake_request,
            parking_brake_request=trial.parking_brake_request,
        )
        try:
            result = self.step(command, dt, backend)
        except Exception:
            direction_fsm.abort(trial)
            raise
        state = direction_fsm.commit(trial)
        return DriverControlledStepResult(result, trial, state)
