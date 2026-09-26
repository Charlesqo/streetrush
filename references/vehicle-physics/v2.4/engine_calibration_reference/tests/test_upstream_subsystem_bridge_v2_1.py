from __future__ import annotations
import unittest
import numpy as np

from engine_calibration_reference.chassis_suspension_reference import build_synthetic_kc_map, validate_monotone_contact_path
from engine_calibration_reference.tire_v2_reference_v1_7 import (
    TireMode, TireTransientState, synthetic_passenger_tire,
    solve_explicit_unsprung_normal_tangential_block,
    solve_mapped_massless_normal_tangential_block,
)

class TestUpstreamSubsystemBridgeV21(unittest.TestCase):
    def test_accepted_mapped_kc_asset_is_executable_not_a_stub(self):
        kc,_=build_synthetic_kc_map()
        ok,min_dz=validate_monotone_contact_path(kc,[-.4,0.,.4])
        self.assertTrue(ok)
        self.assertGreater(min_dz,0.)
        sample=kc.evaluate(.02,.1)
        self.assertIn('pz',sample)

    def test_both_accepted_tire_normal_host_blocks_still_converge(self):
        p=synthetic_passenger_tire(); prev=TireTransientState(.01,0.,TireMode.HANDLING)
        mapped=solve_mapped_massless_normal_tangential_block(
            p,np.array([1.5,.4]),np.array([[.075,.003],[.003,.018]]),16.,16.,prev,1/120,
            3400.,np.array([.03,.02]),0.,1.,
        )
        explicit=solve_explicit_unsprung_normal_tangential_block(
            p,np.array([1.5,.4]),np.array([[.075,.003],[.003,.018]]),16.,16.,prev,1/120,
            42.,0.,.016,3400.,np.array([.03,.02]),0.,1.,
        )
        self.assertTrue(mapped.converged)
        self.assertTrue(explicit.converged)
        self.assertLess(mapped.residual_norm,1e-8)
        self.assertLess(explicit.residual_norm,1e-8)
        self.assertGreater(mapped.fz,0.)
        self.assertGreater(explicit.fz,0.)

if __name__=='__main__': unittest.main()
