from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple
import math
import numpy as np
from scipy.interpolate import RegularGridInterpolator
from scipy.optimize import root


@dataclass(frozen=True)
class AeroReference:
    area_m2: float
    length_m: float
    ref_point_vehicle_m: np.ndarray
    front_axle_x_m: float
    rear_axle_x_m: float


@dataclass(frozen=True)
class AeroPlatformSample:
    front_ground_clearance_m: float
    rear_ground_clearance_m: float
    roll_rad: float = 0.0
    steering_rad: float = 0.0


@dataclass(frozen=True)
class AeroEnvironment:
    air_density_kg_m3: float
    relative_air_velocity_body_mps: np.ndarray  # body/reference point velocity relative to air


@dataclass
class AeroEvaluation:
    force_body_n: np.ndarray
    moment_body_nm_at_ref: np.ndarray
    coefficients: np.ndarray
    dynamic_pressure_pa: float
    beta_rad: float


class CompiledQSSAeroMap:
    """Reference QSS aeromap.

    Runtime coefficients are signed body-axis coefficients:
      [CX, CY, CZ, Cl, Cm, Cn]
    with x-forward, y-left, z-up. For a symmetric forward-running car:
      CX < 0 is drag, CZ < 0 is downforce.
    Moments follow right-hand body axes and are reported about dataset ref point.

    This reference uses SciPy multidimensional PCHIP for values. Production code should
    compile the map offline and expose derivatives from the same interpolant.
    """

    def __init__(
        self,
        front_heights_m: np.ndarray,
        rear_heights_m: np.ndarray,
        beta_rad: np.ndarray,
        coeff_grid: np.ndarray,
        reference: AeroReference,
    ):
        self.front_heights_m = np.asarray(front_heights_m, float)
        self.rear_heights_m = np.asarray(rear_heights_m, float)
        self.beta_grid_rad = np.asarray(beta_rad, float)
        self.coeff_grid = np.asarray(coeff_grid, float)
        self.reference = reference
        assert self.coeff_grid.shape == (
            len(self.front_heights_m), len(self.rear_heights_m), len(self.beta_grid_rad), 6
        )
        self._interps = [
            RegularGridInterpolator(
                (self.front_heights_m, self.rear_heights_m, self.beta_grid_rad),
                self.coeff_grid[..., i],
                method="pchip",
                bounds_error=True,
            )
            for i in range(6)
        ]

    def _coeffs(self, platform: AeroPlatformSample, beta: float) -> np.ndarray:
        p = np.array([[platform.front_ground_clearance_m, platform.rear_ground_clearance_m, beta]])
        return np.array([float(f(p)[0]) for f in self._interps])

    def evaluate(self, platform: AeroPlatformSample, env: AeroEnvironment) -> AeroEvaluation:
        v = np.asarray(env.relative_air_velocity_body_mps, float)
        speed = float(np.linalg.norm(v))
        if speed <= 1e-12:
            return AeroEvaluation(np.zeros(3), np.zeros(3), np.zeros(6), 0.0, 0.0)
        # Forward QSS aeromap domain. Reverse should use an explicit fallback backend.
        if v[0] <= 0.0:
            raise ValueError("QSS aeromap valid only for forward relative flow; select reverse/fallback backend")
        beta = math.atan2(v[1], v[0])
        c = self._coeffs(platform, beta)
        q = 0.5 * env.air_density_kg_m3 * speed * speed
        F = q * self.reference.area_m2 * c[:3]
        M = q * self.reference.area_m2 * self.reference.length_m * c[3:]
        return AeroEvaluation(F, M, c, q, beta)

    def coefficient_jacobian_platform(self, platform: AeroPlatformSample, beta: float, dh=1e-5) -> np.ndarray:
        """Finite-difference derivative of coefficients wrt [hF,hR] for structural validation."""
        p0 = np.array([platform.front_ground_clearance_m, platform.rear_ground_clearance_m])
        out = np.zeros((6, 2))
        for j in range(2):
            pp = p0.copy(); pm = p0.copy()
            pp[j] += dh; pm[j] -= dh
            cp = self._coeffs(AeroPlatformSample(pp[0], pp[1]), beta)
            cm = self._coeffs(AeroPlatformSample(pm[0], pm[1]), beta)
            out[:, j] = (cp - cm) / (2*dh)
        return out


def shift_wrench(force_n: np.ndarray, moment_nm_at_a: np.ndarray, r_a_minus_b_m: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Shift a wrench from reference A to B.

    r_a_minus_b is vector from B to A. M_B = M_A + r_BA x F.
    """
    F = np.asarray(force_n, float)
    M = np.asarray(moment_nm_at_a, float) + np.cross(np.asarray(r_a_minus_b_m, float), F)
    return F.copy(), M


def equivalent_front_rear_vertical_forces(total_fz_n: float, pitch_moment_y_nm: float, x_front_m: float, x_rear_m: float) -> Tuple[float, float]:
    """Equivalent vertical forces at front/rear axle x locations.

    Body axes x-forward, y-left, z-up. For vertical Fz at x, pitch moment My = -x*Fz.
    """
    A = np.array([[1.0, 1.0], [-x_front_m, -x_rear_m]])
    b = np.array([total_fz_n, pitch_moment_y_nm])
    ff, fr = np.linalg.solve(A, b)
    return float(ff), float(fr)


def build_synthetic_race_aeromap() -> CompiledQSSAeroMap:
    hf = np.array([0.015, 0.025, 0.040, 0.060, 0.090])
    hr = np.array([0.025, 0.040, 0.060, 0.090, 0.120])
    beta = np.array([-0.16, -0.08, 0.0, 0.08, 0.16])
    ref = AeroReference(
        area_m2=1.55,
        length_m=2.65,
        ref_point_vehicle_m=np.array([0.0, 0.0, 0.25]),
        front_axle_x_m=1.35,
        rear_axle_x_m=-1.25,
    )
    g = np.zeros((len(hf), len(hr), len(beta), 6))
    for i, hfi in enumerate(hf):
        for j, hrj in enumerate(hr):
            # Synthetic but racecar-like: downforce improves as platform lowers, then front-floor stall appears very low.
            rake = (hrj - hfi)
            front_base = 0.56 + 0.62*np.exp(-((hfi-0.032)/0.035)**2) + 1.6*rake
            rear_base  = 0.78 + 0.74*np.exp(-((hrj-0.052)/0.050)**2) + 0.75*rake
            front_stall = 1.0 - 0.42*np.exp(-((hfi-0.010)/0.010)**2)
            rear_stall  = 1.0 - 0.20*np.exp(-((hrj-0.016)/0.012)**2)
            cdf = max(0.15, front_base*front_stall)
            cdr = max(0.20, rear_base*rear_stall)
            cz_total = -(cdf+cdr)
            # Equivalent pitch coefficient from front/rear vertical coefficient loads.
            # Moment coefficient Cm is My/(q*A*L), with My=-xFz.
            cm0 = (-ref.front_axle_x_m*(-cdf) - ref.rear_axle_x_m*(-cdr))/ref.length_m
            for k, b in enumerate(beta):
                yaw_loss = 1.0 - 0.70*b*b
                cz = cz_total*yaw_loss
                cm = cm0*(1.0 - 0.45*b*b)
                cx = -(0.54 + 0.055*(cdf+cdr))*(1.0 + 0.8*b*b)
                cy = -0.95*b - 0.55*b**3
                cl = -0.055*b
                cn = -0.19*b - 0.12*b**3
                g[i,j,k] = [cx, cy, cz, cl, cm, cn]
    return CompiledQSSAeroMap(hf, hr, beta, g, ref)


def simple_bilinear_2d(xgrid, ygrid, vals, x, y):
    i = np.searchsorted(xgrid, x) - 1
    j = np.searchsorted(ygrid, y) - 1
    i = int(np.clip(i, 0, len(xgrid)-2)); j=int(np.clip(j, 0, len(ygrid)-2))
    x0,x1=xgrid[i],xgrid[i+1]; y0,y1=ygrid[j],ygrid[j+1]
    tx=(x-x0)/(x1-x0); ty=(y-y0)/(y1-y0)
    return ((1-tx)*(1-ty)*vals[i,j] + tx*(1-ty)*vals[i+1,j] + (1-tx)*ty*vals[i,j+1] + tx*ty*vals[i+1,j+1])


def static_aero_platform_equilibrium(amap: CompiledQSSAeroMap, speed_mps: float, rho: float,
                                     h0_front: float, h0_rear: float,
                                     k_front_npm: float, k_rear_npm: float):
    ref = amap.reference
    env = AeroEnvironment(rho, np.array([speed_mps, 0.0, 0.0]))

    def residual(h):
        plat = AeroPlatformSample(float(h[0]), float(h[1]))
        ev = amap.evaluate(plat, env)
        ff, fr = equivalent_front_rear_vertical_forces(ev.force_body_n[2], ev.moment_body_nm_at_ref[1],
                                                       ref.front_axle_x_m, ref.rear_axle_x_m)
        # Downforce is negative Fz, compressing the suspension and reducing ride height.
        return np.array([
            h[0] - (h0_front + ff/k_front_npm),
            h[1] - (h0_rear + fr/k_rear_npm),
        ])

    sol = root(residual, np.array([h0_front, h0_rear]), method='hybr')
    return sol, residual


def drag_relative_power(force_body_n: np.ndarray, v_rel_body_mps: np.ndarray) -> float:
    return float(np.dot(force_body_n, v_rel_body_mps))


if __name__ == '__main__':
    amap = build_synthetic_race_aeromap()
    p=AeroPlatformSample(0.04,0.065)
    e=AeroEnvironment(1.225,np.array([60.,0.,0.]))
    print(amap.evaluate(p,e))

def isotropic_quadratic_drag(v_rel_body_mps: np.ndarray, rho: float, cd_area_m2: float) -> np.ndarray:
    v=np.asarray(v_rel_body_mps,float); s=float(np.linalg.norm(v))
    if s<=1e-15: return np.zeros(3)
    return -0.5*rho*cd_area_m2*s*v

def simulate_two_axle_vertical_aero(amap: CompiledQSSAeroMap, rate_hz: int, duration_s: float,
                                    speed_mps: float, rho: float,
                                    h0_front: float=.07, h0_rear: float=.09,
                                    k_front: float=120000., k_rear: float=120000.,
                                    c_front: float=7000., c_rear: float=7000.,
                                    m_front: float=360., m_rear: float=390.):
    dt=1.0/rate_hz
    x=np.zeros(2) # compression down: h=h0-x
    xd=np.zeros(2)
    ref=amap.reference
    env=AeroEnvironment(rho,np.array([speed_mps,0.,0.]))
    hist=[]
    for n in range(int(round(duration_s*rate_hz))):
        h=np.array([h0_front-x[0], h0_rear-x[1]])
        ev=amap.evaluate(AeroPlatformSample(float(h[0]),float(h[1])),env)
        ff,fr=equivalent_front_rear_vertical_forces(ev.force_body_n[2],ev.moment_body_nm_at_ref[1],ref.front_axle_x_m,ref.rear_axle_x_m)
        D=np.array([-ff,-fr])
        acc=np.array([(D[0]-k_front*x[0]-c_front*xd[0])/m_front,
                      (D[1]-k_rear*x[1]-c_rear*xd[1])/m_rear])
        xd += acc*dt
        x += xd*dt
        hist.append((n*dt,*h,*D))
    return np.array(hist), x, xd
