import unittest, math
import numpy as np
from engine_calibration_reference.aero_reference_v1_9 import *


class TestAeroReference(unittest.TestCase):
    def setUp(self):
        self.amap=build_synthetic_race_aeromap()

    def test_zero_airspeed_zero_wrench(self):
        ev=self.amap.evaluate(AeroPlatformSample(.04,.06),AeroEnvironment(1.225,np.zeros(3)))
        self.assertTrue(np.all(ev.force_body_n==0))
        self.assertTrue(np.all(ev.moment_body_nm_at_ref==0))

    def test_forward_reverse_domain_is_explicit(self):
        with self.assertRaises(ValueError):
            self.amap.evaluate(AeroPlatformSample(.04,.06),AeroEnvironment(1.225,np.array([-10.,0,0])))

    def test_yaw_symmetry_contract(self):
        p=AeroPlatformSample(.04,.06)
        for b in [0.03,0.08,0.14]:
            cp=self.amap._coeffs(p,b); cm=self.amap._coeffs(p,-b)
            self.assertLess(np.max(np.abs(cp[[0,2,4]]-cm[[0,2,4]])),1e-12)
            self.assertLess(np.max(np.abs(cp[[1,3,5]]+cm[[1,3,5]])),1e-12)

    def test_wrench_shift_round_trip(self):
        F=np.array([-1200.,350.,-5000.]); M=np.array([20.,-300.,80.]); r=np.array([.3,-.1,.25])
        F2,M2=shift_wrench(F,M,r)
        F3,M3=shift_wrench(F2,M2,-r)
        self.assertLess(np.linalg.norm(F3-F),1e-12)
        self.assertLess(np.linalg.norm(M3-M),1e-12)

    def test_front_rear_equivalence(self):
        Fz=-9000.; My=-750.; xf=1.35; xr=-1.25
        ff,fr=equivalent_front_rear_vertical_forces(Fz,My,xf,xr)
        self.assertAlmostEqual(ff+fr,Fz,places=9)
        self.assertAlmostEqual(-xf*ff-xr*fr,My,places=9)

    def test_drag_is_dissipative_in_air_relative_frame(self):
        for v in [np.array([30.,5.,0]),np.array([-10.,0,0]),np.array([0.,12.,3.])]:
            F=isotropic_quadratic_drag(v,1.225,.65)
            self.assertLessEqual(float(F@v),1e-12)

    def test_tailwind_can_add_vehicle_energy_without_violating_relative_drag(self):
        v_vehicle=np.array([10.,0,0]); wind=np.array([20.,0,0]); v_rel=v_vehicle-wind
        F=isotropic_quadratic_drag(v_rel,1.225,.65)
        self.assertLess(float(F@v_rel),0)
        self.assertGreater(float(F@v_vehicle),0)

    def test_pchip_derivative_is_continuous_across_gridline_relative_to_bilinear(self):
        x=self.amap.front_heights_m; y=self.amap.rear_heights_m; vals=self.amap.coeff_grid[:,:,2,2]
        xb=.04; yr=.06; eps=1e-6
        bl=(simple_bilinear_2d(x,y,vals,xb-eps,yr)-simple_bilinear_2d(x,y,vals,xb-3*eps,yr))/(2*eps)
        br=(simple_bilinear_2d(x,y,vals,xb+3*eps,yr)-simple_bilinear_2d(x,y,vals,xb+eps,yr))/(2*eps)
        def cz(h): return self.amap._coeffs(AeroPlatformSample(h,yr),0)[2]
        pl=(cz(xb-eps)-cz(xb-3*eps))/(2*eps)
        pr=(cz(xb+3*eps)-cz(xb+eps))/(2*eps)
        self.assertGreater(abs(br-bl),10.0)
        self.assertLess(abs(pr-pl),0.02)

    def test_out_of_domain_rejected(self):
        with self.assertRaises(ValueError):
            self.amap.evaluate(AeroPlatformSample(.005,.06),AeroEnvironment(1.225,np.array([50.,0,0])))

    def test_static_aero_platform_requires_coupled_equilibrium(self):
        v=60.; rho=1.225; hf0=.07; hr0=.09; kf=kr=120000.
        env=AeroEnvironment(rho,np.array([v,0,0]))
        ev=self.amap.evaluate(AeroPlatformSample(hf0,hr0),env)
        ff,fr=equivalent_front_rear_vertical_forces(ev.force_body_n[2],ev.moment_body_nm_at_ref[1],
                                                    self.amap.reference.front_axle_x_m,self.amap.reference.rear_axle_x_m)
        one=np.array([hf0+ff/kf,hr0+fr/kr])
        sol,res=static_aero_platform_equilibrium(self.amap,v,rho,hf0,hr0,kf,kr)
        self.assertTrue(sol.success)
        residual_force=np.abs(res(one)*np.array([kf,kr]))
        self.assertGreater(float(residual_force.max()),900.)
        self.assertLess(float(np.abs(res(sol.x)).max()),1e-9)

    def test_timestep_refinement_on_aero_platform_rig(self):
        refs={}
        for hz in [60,120,240,480,960,1920]:
            _,x,_=simulate_two_axle_vertical_aero(self.amap,hz,.5,60.,1.225)
            refs[hz]=np.array([.07-x[0],.09-x[1]])
        e60=np.linalg.norm(refs[60]-refs[1920])
        e480=np.linalg.norm(refs[480]-refs[1920])
        self.assertLess(e480,e60)
        self.assertLess(e480,1e-4)

if __name__=='__main__':
    unittest.main()
