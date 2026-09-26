from __future__ import annotations

from dataclasses import replace
from pathlib import Path
import time
import unittest

from engine_calibration_reference.coupled_vehicle_solver import (
    Axle, CoupledVehicleConfig, TireMode, make_consistent_state,
    solve_coupled_vehicle_substep,
)
from engine_calibration_reference.engine_model import (
    EngineAsset, EngineCommand, EngineMode, EngineModel, EngineOwner, EngineState,
)
from engine_calibration_reference.runtime_vehicle_solver import solve_runtime_coupled_vehicle_substep

ROOT = Path(__file__).resolve().parents[1]

def model():
    return EngineModel(EngineAsset.from_json(ROOT/'data'/'synthetic_engine_asset.json'))

def config2(mu=1.5, clutch=900.0):
    return CoupledVehicleConfig(
        mass_kg=1420., wheel_inertias_kg_m2=(1.25,1.25), wheel_radii_m=(.33,.33),
        clutch_speed_mapping=(4.5,4.5), clutch_capacity_nm=clutch, tire_mu=(mu,mu),
        wheel_axles=(Axle.REAR,Axle.REAR), wheelbase_m=2.72, cg_to_rear_axle_m=1.42,
        cg_height_m=.53, cd_area_m2=.68, cl_area_m2=.35, aero_front_fraction=.46,
    )

def config4():
    return CoupledVehicleConfig(
        mass_kg=1420., wheel_inertias_kg_m2=(1.25,)*4, wheel_radii_m=(.33,)*4,
        clutch_speed_mapping=(0.,0.,4.5,4.5), clutch_capacity_nm=900., tire_mu=(1.5,)*4,
        wheel_axles=(Axle.FRONT,Axle.FRONT,Axle.REAR,Axle.REAR), wheelbase_m=2.72,
        cg_to_rear_axle_m=1.42, cg_height_m=.53, cd_area_m2=.68, cl_area_m2=.35,
        aero_front_fraction=.46,
    )

class TestRuntimeVehicleSolverV21(unittest.TestCase):
    def test_common_mode_matches_exhaustive_oracle(self):
        cfg=config2(); dt=1/120
        state=make_consistent_state(15.,cfg,EngineState(0.,EngineMode.RUNNING,.5))
        owner_a=EngineOwner(model(),state.engine); ta=owner_a.begin_substep(EngineCommand(.55),dt)
        oracle=solve_coupled_vehicle_substep(owner_a,ta,state,cfg,(0.,0.),dt)
        owner_b=EngineOwner(model(),state.engine); tb=owner_b.begin_substep(EngineCommand(.55),dt)
        runtime=solve_runtime_coupled_vehicle_substep(owner_b,tb,state,cfg,(0.,0.),dt)
        self.assertEqual(runtime.candidates_examined,1)
        self.assertAlmostEqual(runtime.state.chassis_speed_m_s,oracle.state.chassis_speed_m_s,places=11)
        self.assertAlmostEqual(runtime.state.engine.omega_rad_s,oracle.state.engine.omega_rad_s,places=9)
        for a,b in zip(runtime.state.wheel_omega_rad_s,oracle.state.wheel_omega_rad_s): self.assertAlmostEqual(a,b,places=10)

    def test_four_wheel_common_mode_is_constant_candidate_count(self):
        cfg=config4(); dt=1/120
        state=make_consistent_state(15.,cfg,EngineState(0.,EngineMode.RUNNING,.5))
        owner=EngineOwner(model(),state.engine); t=owner.begin_substep(EngineCommand(.55),dt)
        result=solve_runtime_coupled_vehicle_substep(owner,t,state,cfg,(0.,0.,0.,0.),dt)
        self.assertEqual(result.candidates_examined,1)
        self.assertEqual(result.tire_modes,(TireMode.ADHERING,)*4)
        self.assertLess(result.scaled_residual_inf,2e-8)

    def test_transition_fallback_remains_bounded_not_exhaustive(self):
        cfg=config2(mu=.055); dt=1/120
        state=make_consistent_state(8.,cfg,EngineState(0.,EngineMode.RUNNING,1.))
        owner=EngineOwner(model(),state.engine); t=owner.begin_substep(EngineCommand(1.),dt)
        result=solve_runtime_coupled_vehicle_substep(owner,t,state,cfg,(0.,0.),dt)
        self.assertTrue(any(m is not TireMode.ADHERING for m in result.tire_modes))
        self.assertLessEqual(result.candidates_examined,6*cfg.wheel_count+12)
        self.assertLess(result.candidates_examined,2*3*(3**cfg.wheel_count))

    def test_commit_false_is_transactional_preflight_only(self):
        cfg=config2(); dt=1/120
        state=make_consistent_state(12.,cfg,EngineState(0.,EngineMode.RUNNING,.4))
        owner=EngineOwner(model(),state.engine); original=owner.state
        t=owner.begin_substep(EngineCommand(.5),dt)
        result=solve_runtime_coupled_vehicle_substep(owner,t,state,cfg,(0.,0.),dt,commit_engine=False)
        self.assertIs(owner.state,original)
        owner.commit(t,result.state.engine.omega_rad_s)
        self.assertIsNot(owner.state,original)

    def test_fast_path_has_large_reference_speedup_without_hard_realtime_assert(self):
        cfg=config2(); dt=1/120; state=make_consistent_state(15.,cfg,EngineState(0.,EngineMode.RUNNING,.5))
        oa=EngineOwner(model(),state.engine); ta=oa.begin_substep(EngineCommand(.55),dt)
        t0=time.perf_counter(); solve_coupled_vehicle_substep(oa,ta,state,cfg,(0.,0.),dt); oracle_s=time.perf_counter()-t0
        ob=EngineOwner(model(),state.engine); tb=ob.begin_substep(EngineCommand(.55),dt)
        t0=time.perf_counter(); solve_runtime_coupled_vehicle_substep(ob,tb,state,cfg,(0.,0.),dt); runtime_s=time.perf_counter()-t0
        # Loose ratio catches accidental exponential fallback while avoiding a flaky absolute wall-clock gate.
        self.assertLess(runtime_s,oracle_s*.25)

if __name__=='__main__': unittest.main()
