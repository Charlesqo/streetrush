from __future__ import annotations
import unittest

from engine_calibration_reference.engine_model import EngineCommand
from engine_calibration_reference.integrated_closeout import (
    IntegratedCloseoutSystem, NormalBackend,
)

class TestIntegratedCloseoutV21(unittest.TestCase):
    def test_both_normal_backends_execute_real_same_step_chain(self):
        results=[]
        for backend in NormalBackend:
            with self.subTest(backend=backend.value):
                system=IntegratedCloseoutSystem.synthetic()
                old_engine=system.engine_owner.state
                r=system.step(EngineCommand(.45),1/120,backend)
                results.append(r)
                self.assertLess(r.residual_scaled_inf,3e-7)
                self.assertTrue(r.normal_tangential_iterations_are_same_step)
                self.assertTrue(r.aero_wrench_is_canonical)
                self.assertTrue(r.simplified_internal_tire_aero_disabled)
                self.assertGreater(r.clutch_capacity_margin_nms,0.)
                self.assertTrue(all(f>0 for f in r.normal_loads_n))
                self.assertTrue(all(o.state_trial.mode.name=='HANDLING' for o in r.tire_outputs))
                self.assertIs(system.engine_owner.state,r.state.engine)
                self.assertIsNot(system.engine_owner.state,old_engine)
                self.assertNotEqual(sum(abs(o.Fx) for o in r.tire_outputs),0.)
        # Backends are genuinely distinct normal dynamics, not aliases returning the same Fz vector.
        self.assertGreater(max(abs(a-b) for a,b in zip(results[0].normal_loads_n,results[1].normal_loads_n)),20.)

    def test_aero_seam_cannot_double_count_low_order_solver_paths(self):
        system=IntegratedCloseoutSystem.synthetic()
        seam=system.production_powertrain_seam_config(system.config)
        self.assertEqual(seam.tire_mu,(0.,0.,0.,0.))
        self.assertEqual(seam.cd_area_m2,0.)
        self.assertEqual(seam.cl_area_m2,0.)
        self.assertEqual(seam.rolling_resistance_coefficient,0.)

    def test_failed_solve_does_not_commit_engine(self):
        system=IntegratedCloseoutSystem.synthetic()
        old=system.engine_owner.state
        with self.assertRaises(ValueError):
            system.step(EngineCommand(.4),0.,NormalBackend.MAPPED_MASSLESS)
        self.assertIs(system.engine_owner.state,old)

if __name__=='__main__': unittest.main()
