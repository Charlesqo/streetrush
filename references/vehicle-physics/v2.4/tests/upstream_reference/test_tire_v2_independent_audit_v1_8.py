import math
import numpy as np
import pytest

import engine_calibration_reference.tire_v2_reference_v1_7 as v17
import engine_calibration_reference.tire_v2_reference_v1_8 as v18

P = v17.synthetic_passenger_tire()


def test_empirical_v17_transient_is_not_scalar_energy_integrable():
    sample = abs(v18.weighted_cross_partial_mismatch(P, 4000.0, 0.03, 0.03))
    grid_max = 0.0
    for sx in np.linspace(0.005, 0.16, 28):
        for sy in np.linspace(0.005, 0.20, 31):
            grid_max = max(grid_max, abs(v18.weighted_cross_partial_mismatch(P, 4000.0, float(sx), float(sy))))
    assert sample > 100.0
    assert grid_max > 1000.0


def test_soft_static_empirical_v17_can_generate_positive_closed_loop_work():
    # This is a new negative control, not the v1.7 FRICTION_CONTACT passivity test.
    # If the empirical relaxed-slip force map is reinterpreted as a 2-D static spring at V=0,
    # the non-integrable force field makes one loop orientation produce positive net contact work.
    work = v18.soft_static_closed_loop_contact_work(P, 4000.0, 0.0, 0.10, 0.0, 0.10, 600)
    assert work > 1.0


def test_policy_rejects_soft_static_for_empirical_transient():
    p = v18.TireTransientPolicyV18(
        energy_policy=v18.TransientEnergyPolicy.EMPIRICAL_RELAXATION_BOUNDED,
        low_speed_policy=v18.LowSpeedTangentialPolicy.SOFT_STATIC_DEFORMATION,
    )
    with pytest.raises(ValueError):
        p.validate()
    ok = v18.TireTransientPolicyV18(
        energy_policy=v18.TransientEnergyPolicy.EMPIRICAL_RELAXATION_BOUNDED,
        low_speed_policy=v18.LowSpeedTangentialPolicy.FRICTION_CONTACT,
    )
    ok.validate()


def test_camber_authority_is_separate_from_lateral_relaxation():
    c, _ = P.load_map.evaluate(4000.0)
    gamma = math.radians(4.0)
    target = v17.camber_equivalent_slip(c, gamma)
    distance = 0.10
    speed = 20.0
    dt = distance / speed

    # v1.7 folds camber into sy_eff and therefore forces it to use sigma_y.
    old_fraction = 1.0 - math.exp(-distance / c.sigma_y)
    old_out = v17.evaluate_relaxed_state(P, 4000.0, 0.0, old_fraction * target, gamma)

    # Independent-camber fixture: a deliberately short, separately identifiable Lgamma.
    cfg = v18.CamberTransientConfig(v18.CamberTransientPolicy.FIRST_ORDER_SEPARATE, 0.04)
    st = v18.handling_trial_state_v18(P, 4000.0, v18.TireTransientStateV18(), 0.0, 0.0, gamma, speed, dt, cfg)
    new_out = v18.evaluate_state_v18(P, 4000.0, st, gamma)

    assert st.sgamma / target > 0.90
    assert old_fraction < 0.25
    assert new_out.Fy > 3.5 * old_out.Fy


def test_default_camber_policy_can_be_instant_without_inventing_lgamma():
    c, _ = P.load_map.evaluate(4000.0)
    gamma = math.radians(4.0)
    target = v17.camber_equivalent_slip(c, gamma)
    st = v18.handling_trial_state_v18(
        P, 4000.0, v18.TireTransientStateV18(), 0.0, 0.0, gamma, 20.0, 1/120,
        v18.CamberTransientConfig(v18.CamberTransientPolicy.INSTANT, None),
    )
    assert abs(st.sgamma - target) < 1e-15
    assert st.sy == 0.0


def test_solver_residual_convergence_does_not_imply_timestep_convergence():
    rates = [60, 120, 240, 480, 960, 1920, 3840]
    runs = {hz: v18.simulate_longitudinal_timestep_convergence(P, hz) for hz in rates}
    # Every nonlinear solve is genuinely converged.
    assert max(r["max_solver_residual"] for r in runs.values()) < 1e-8
    # Yet early-time physical response remains strongly timestep dependent.
    ref = runs[3840]["sample"]["Fx_N"]
    assert abs(runs[60]["sample"]["Fx_N"] - ref) > 250.0
    assert abs(runs[480]["sample"]["Fx_N"] - ref) > 100.0
    # The error decreases once dt is actually refined, which is a separate acceptance axis.
    assert abs(runs[1920]["sample"]["Fx_N"] - ref) < abs(runs[480]["sample"]["Fx_N"] - ref)
