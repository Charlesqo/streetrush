"""Regenerate v2.1 correction/close-out evidence."""
from __future__ import annotations
from dataclasses import asdict
from io import StringIO
import json, platform, sys, time, unittest
from pathlib import Path
import numpy as np
import scipy

from .coupled_vehicle_solver import Axle, CoupledVehicleConfig, make_consistent_state, solve_coupled_vehicle_substep
from .engine_model import EngineAsset, EngineCommand, EngineMode, EngineModel, EngineOwner, EngineState
from .integrated_closeout import IntegratedCloseoutSystem, NormalBackend
from .runtime_vehicle_solver import solve_runtime_coupled_vehicle_substep

ROOT=Path(__file__).resolve().parent
RESULTS=ROOT/'results'

def _write(path,payload):
    path.write_text(json.dumps(payload,ensure_ascii=False,indent=2,allow_nan=False)+'\n',encoding='utf-8')

def _model(): return EngineModel(EngineAsset.from_json(ROOT/'data'/'synthetic_engine_asset.json'))

def _cfg(n=2):
    if n==2:
        return CoupledVehicleConfig(1420.,(1.25,1.25),(.33,.33),(4.5,4.5),900.,(1.5,1.5),(Axle.REAR,Axle.REAR),2.72,1.42,.53,cd_area_m2=.68,cl_area_m2=.35,aero_front_fraction=.46)
    return CoupledVehicleConfig(1420.,(1.25,)*4,(.33,)*4,(0.,0.,4.5,4.5),900.,(1.5,)*4,(Axle.FRONT,Axle.FRONT,Axle.REAR,Axle.REAR),2.72,1.42,.53,cd_area_m2=.68,cl_area_m2=.35,aero_front_fraction=.46)

def _one_runtime(n=2, oracle=False):
    cfg=_cfg(n); dt=1/120
    state=make_consistent_state(15.,cfg,EngineState(0.,EngineMode.RUNNING,.5))
    owner=EngineOwner(_model(),state.engine); ticket=owner.begin_substep(EngineCommand(.55),dt)
    torques=(0.,)*n
    t0=time.perf_counter()
    if oracle:
        r=solve_coupled_vehicle_substep(owner,ticket,state,cfg,torques,dt)
    else:
        r=solve_runtime_coupled_vehicle_substep(owner,ticket,state,cfg,torques,dt)
    elapsed=time.perf_counter()-t0
    return r,elapsed

def main():
    RESULTS.mkdir(exist_ok=True)
    stream=StringIO(); suite=unittest.defaultTestLoader.discover(str(ROOT/'tests'))
    tests_t0=time.perf_counter()
    tr=unittest.TextTestRunner(stream=stream,verbosity=1).run(suite)
    tests_elapsed=time.perf_counter()-tests_t0
    (RESULTS/'unittest_v2_1.txt').write_text(stream.getvalue(),encoding='utf-8')
    oracle2,t_oracle2=_one_runtime(2,True)
    rt2,t_rt2=_one_runtime(2,False)
    rt4,t_rt4=_one_runtime(4,False)
    integrated={}
    for b in NormalBackend:
        system=IntegratedCloseoutSystem.synthetic()
        r=system.step(EngineCommand(.45),1/120,b)
        integrated[b.value]={
            'scaled_residual_inf':r.residual_scaled_inf,
            'nonlinear_evaluations':r.nonlinear_evaluations,
            'chassis_speed_m_s':r.state.chassis_speed_m_s,
            'engine_rpm':r.state.engine.rpm,
            'normal_loads_n':list(r.normal_loads_n),
            'tire_fx_n':[o.Fx for o in r.tire_outputs],
            'clutch_capacity_margin_nms':r.clutch_capacity_margin_nms,
            'aero_force_body_n':r.aero.force_body_n.tolist(),
            'aero_moment_body_nm':r.aero.moment_body_nm_at_ref.tolist(),
            'canonical_aero_wrench_only':r.aero_wrench_is_canonical,
            'simplified_internal_tire_aero_disabled':r.simplified_internal_tire_aero_disabled,
        }
    payload={
        'schema':'vehicle-physics-v2.1-implementation-closeout',
        'scope':'Numerical robustness + transactional ownership + bounded runtime solver + real Tire V2/Aero/two-normal-backend integration seam',
        'synthetic_fixture_notice':'All bundled numeric fixtures are structural synthetic data, not target-vehicle calibration evidence.',
        'runtime':{'python':sys.version.split()[0],'implementation':platform.python_implementation(),'numpy':np.__version__,'scipy':scipy.__version__},
        'unittest':{
            'tests_run':tr.testsRun,'failures':len(tr.failures),'errors':len(tr.errors),'skipped':len(tr.skipped),
            'expected_failures':len(tr.expectedFailures),'unexpected_successes':len(tr.unexpectedSuccesses),'successful':tr.wasSuccessful(),
            'elapsed_seconds':tests_elapsed,
        },
        'runtime_solver':{
            'two_wheel_exhaustive_oracle_seconds':t_oracle2,
            'two_wheel_runtime_seconds':t_rt2,
            'two_wheel_speedup':t_oracle2/max(t_rt2,1e-12),
            'two_wheel_chassis_speed_difference_m_s':rt2.state.chassis_speed_m_s-oracle2.state.chassis_speed_m_s,
            'two_wheel_runtime_candidates':rt2.candidates_examined,
            'four_wheel_runtime_seconds':t_rt4,
            'four_wheel_runtime_candidates':rt4.candidates_examined,
            'policy':'exhaustive is offline oracle; runtime fast/common path + bounded O(N) local neighborhood; no hidden exponential fallback',
        },
        'cross_system_integration':integrated,
        'corrected_defects':[
            'roundoff-sensitive unilateral crank-stop domain rejection near zero speed',
            'Engine/Gearbox commit ordering lacked two-owner preflight',
            'exhaustive active-set enumeration was incorrectly positioned as a practical runtime route',
            'v2.0 whole-vehicle wording overstated a synthetic longitudinal oracle and did not execute accepted Tire V2/Aero normal-path interfaces',
            'reference runtime/dependency provenance was not packaged',
        ],
        'honest_boundaries':[
            'No target-vehicle measured Engine/tire/K&C/aero/whole-vehicle datasets are bundled; target-fidelity gates remain SKIP/FAIL exactly as recorded in v2.0 validation evidence.',
            'The standalone archive does not contain the game project/Rapier entity host, so production 6DOF application remains an interface boundary; the close-out fixture is explicitly reduced-planar.',
        ],
    }
    _write(RESULTS/'vehicle_physics_v2_1_closeout_results.json',payload)
    print(stream.getvalue(),end='')
    print(json.dumps(payload,ensure_ascii=False,indent=2))
    return 0 if tr.wasSuccessful() else 1

if __name__=='__main__': raise SystemExit(main())
