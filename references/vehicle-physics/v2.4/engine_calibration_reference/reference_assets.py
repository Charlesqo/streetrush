"""Declared synthetic assets for exercising the standalone implementation.

These values are deliberately named reference/synthetic.  They are executable
integration fixtures, not a claim about any target vehicle.
"""

from __future__ import annotations

from .coupled_vehicle_solver import Axle, CoupledVehicleConfig
from .powertrain_controller import GearDefinition, GearboxAsset


def make_reference_vehicle_config(
    *, tire_mu: float = 1.5, clutch_capacity_nm: float = 900.0
) -> CoupledVehicleConfig:
    return CoupledVehicleConfig(
        mass_kg=1420.0,
        wheel_inertias_kg_m2=(1.25, 1.25),
        wheel_radii_m=(0.33, 0.33),
        clutch_speed_mapping=(4.5, 4.5),
        clutch_capacity_nm=clutch_capacity_nm,
        tire_mu=(tire_mu, tire_mu),
        wheel_axles=(Axle.REAR, Axle.REAR),
        wheelbase_m=2.72,
        cg_to_rear_axle_m=1.42,
        cg_height_m=0.53,
        cd_area_m2=0.68,
        cl_area_m2=0.35,
        aero_front_fraction=0.46,
        rolling_resistance_coefficient=0.012,
    )


def make_reference_gearbox_asset() -> GearboxAsset:
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
        final_drive_wheel_mapping=(1.5, 1.5),
        clutch_open_s=0.04,
        neutral_dwell_s=0.02,
        clutch_close_s=0.06,
    )

