import math
import numpy as np
import pytest

from engine_calibration_reference.tire_v2_reference_v1_7 import *
import engine_calibration_reference.tire_v2_reference_v1_7 as tv

P = synthetic_passenger_tire()


def test_asset_compiler_contract_passes_synthetic_fixture():
    assert validate_characteristic_asset(P) == []


def test_small_slip_frechet_derivative_is_anisotropic_linear():
    c, _ = P.load_map.evaluate(4000)
    eps = 1e-7
    for th in np.linspace(0, 2 * math.pi, 24, endpoint=False):
        d = np.array([math.cos(th), math.sin(th)])
        o = evaluate_relaxed_state(P, 4000, eps * d[0], eps * d[1])
        got = np.array([o.Fx, o.Fy]) / eps
        expect = np.array([c.kx0 * d[0], c.ky0 * d[1]])
        assert np.linalg.norm(got - expect) / max(np.linalg.norm(expect), 1.0) < 2e-5


def test_legacy_parallel_slip_model_has_direction_dependent_origin_slope():
    c, _ = P.load_map.evaluate(4000)
    eps = 1e-6
    fx, fy = tv._legacy_parallel_slip_force(c, eps, eps, 1.0)
    got = np.array([fx, fy]) / eps
    expect = np.array([c.kx0, c.ky0])
    assert np.linalg.norm(got - expect) / np.linalg.norm(expect) > 0.05


def test_pure_axis_curves_preserved_by_new_combined_model():
    for s in np.linspace(-0.5, 0.5, 31):
        o = evaluate_relaxed_state(P, 4000, s, 0)
        c, _ = P.load_map.evaluate(4000)
        # Build pure-axis oracle from same scalar characteristic.
        fm = c.fx_peak
        fs = c.fx_slide
        ref = math.copysign(tv._scalar_characteristic(abs(s), c.kx0, c.sx_peak, fm, c.sx_slide, fs), s) if s else 0.0
        assert abs(o.Fx - ref) < 1e-9
        assert abs(o.Fy) < 1e-12


def test_pure_lateral_axis_curve_preserved():
    c, _ = P.load_map.evaluate(4000)
    for s in np.linspace(-0.45, 0.45, 31):
        o = evaluate_relaxed_state(P, 4000, 0, s)
        ref = math.copysign(tv._scalar_characteristic(abs(s), c.ky0, c.sy_peak, c.fy_peak, c.sy_slide, c.fy_slide), s) if s else 0.0
        assert abs(o.Fy - ref) < 1e-9
        assert abs(o.Fx) < 1e-12


def test_asset_validation_checks_interpolated_domain_not_only_nodes():
    d = characteristic_asset_diagnostics(P, load_samples=65, direction_samples=361)
    assert d["min_k_peak_ratio"] >= 1.0 - 1e-8
    assert validate_characteristic_asset(P, load_samples=65, direction_samples=361) == []


def test_invalid_characteristic_asset_is_rejected_instead_of_silently_rewriting_initial_stiffness():
    # Deliberately make the high-load lateral peak too early for the selected scalar-curve family.
    bad = synthetic_passenger_tire()
    lm = bad.load_map
    fields = {name: np.array([float(ip(x)) for x in lm.fz_nodes]) for name, ip in lm._interp.items()}
    fields["sy_peak"][-1] = math.tan(math.radians(6.0))
    bp = TireV2Params(**{**bad.__dict__, "load_map": PchipLoadMap(lm.fz_nodes, fields)})
    assert validate_characteristic_asset(bp)


def test_combined_force_shared_capacity_and_anisotropy():
    o = evaluate_relaxed_state(P, 4000, 0.1, 0.1)
    assert o.Fx > 0 and o.Fy > 0 and abs(o.Fx-o.Fy) > 1.0
    c, _ = P.load_map.evaluate(4000)
    assert force_inside_peak_ellipse(c, o.Fx, o.Fy, 1.0)


def test_load_sensitivity():
    mus = []
    for fz in [2000, 4000, 6000, 8000]:
        c, _ = P.load_map.evaluate(fz)
        mus.append(c.fy_peak / fz)
    assert all(mus[i] > mus[i + 1] for i in range(len(mus) - 1))


def test_high_load_characteristic_clamps_but_normal_load_does_not():
    a = evaluate_relaxed_state(P, 8000, 0.1, 0.05)
    b = evaluate_relaxed_state(P, 12000, 0.1, 0.05)
    assert b.load_clamped
    assert abs(a.Fx - b.Fx) < 1e-12 and abs(a.Fy - b.Fy) < 1e-12


def test_road_mu_reduces_peak_without_halving_small_slip_slope():
    h = 1e-6
    f1 = evaluate_relaxed_state(P, 4000, h, 0, mu_scale=1.0).Fx / h
    f05 = evaluate_relaxed_state(P, 4000, h, 0, mu_scale=0.5).Fx / h
    assert abs(f05 / f1 - 1.0) < 1e-3
    p1 = max(evaluate_relaxed_state(P, 4000, s, 0, mu_scale=1.0).Fx for s in np.linspace(0, 0.3, 1000))
    p05 = max(evaluate_relaxed_state(P, 4000, s, 0, mu_scale=0.5).Fx for s in np.linspace(0, 0.3, 1000))
    assert abs(p05 / p1 - 0.5) < 5e-3


def test_camber_thrust_is_transient_not_instantaneous():
    c, _ = P.load_map.evaluate(4000)
    gamma = math.radians(3)
    steady = evaluate_relaxed_state(P, 4000, 0, camber_equivalent_slip(c, gamma), gamma).Fy
    prev = TireTransientState(0, 0, TireMode.HANDLING)
    first = handling_eval(P, 4000, 0, 0, gamma, 1.0, prev, 20.0, 1 / 240).Fy
    assert 0 < first < 0.5 * steady
    s = prev
    for _ in range(240):
        o = handling_eval(P, 4000, 0, 0, gamma, 1.0, s, 20.0, 1 / 240)
        s = o.state_trial
    assert abs(o.Fy - steady) / abs(steady) < 1e-10


def test_camber_relaxation_timestep_invariance_at_fixed_time():
    gamma = math.radians(3)
    vals = []
    for hz in [30, 60, 120, 240]:
        s = TireTransientState(0, 0, TireMode.HANDLING)
        for _ in range(int(0.2 * hz)):
            o = handling_eval(P, 4000, 0, 0, gamma, 1.0, s, 20.0, 1 / hz)
            s = o.state_trial
        vals.append(o.Fy)
    assert max(vals) - min(vals) < 1e-9


def test_relaxation_one_length():
    c, _ = P.load_map.evaluate(4000)
    t = c.sigma_x / 20.0
    s = exact_relaxation_update(TireTransientState(), 0.1, 0.0, 20.0, t, c.sigma_x, c.sigma_y)
    assert abs(s.sx / 0.1 - (1 - math.exp(-1))) < 1e-12


def test_airborne_commit_clears_contact_patch_memory():
    prev = TireTransientState(0.12, -0.08, TireMode.HANDLING)
    air = commit_airborne_state()
    assert air.mode is TireMode.AIRBORNE and air.sx == 0 and air.sy_eff == 0
    # Recontact starts with transient buildup instead of resurrecting the pre-flight contact-patch shear state.
    o = handling_eval(P, 4000, 0.1, 0.0, 0.0, 1.0, air, 20.0, 1 / 240)
    assert 0 < o.state_trial.sx < 0.1


def test_mode_policy_has_hysteresis():
    pol = TireRegimePolicy(2.0, 1.2, 2.0, 1.2)
    assert select_tire_mode(TireMode.FRICTION_CONTACT, True, 1.5, 10.0, pol) is TireMode.FRICTION_CONTACT
    assert select_tire_mode(TireMode.FRICTION_CONTACT, True, 2.1, 2.1, pol) is TireMode.HANDLING
    assert select_tire_mode(TireMode.HANDLING, True, 1.5, 5.0, pol) is TireMode.HANDLING
    assert select_tire_mode(TireMode.HANDLING, True, 1.1, 5.0, pol) is TireMode.FRICTION_CONTACT
    assert select_tire_mode(TireMode.HANDLING, True, 20.0, 0.2, pol) is TireMode.FRICTION_CONTACT  # near lock
    assert select_tire_mode(TireMode.HANDLING, False, 20, 20, pol) is TireMode.AIRBORNE


def test_handling_kinematics_forward_reverse_and_backend_specific_transport_normalization():
    R = 0.3
    f = handling_kinematics(15.0, 0.0, 50.0, R)
    assert abs(f.sx_inst) < 1e-15 and abs(f.v_norm - 15.0) < 1e-15
    rev = handling_kinematics(-15.0, 0.0, -50.0, R)
    assert abs(rev.sx_inst) < 1e-15 and abs(rev.v_norm - 15.0) < 1e-15
    lat = handling_kinematics(10.0, 2.0, 10.0 / R, R)
    assert abs(lat.sy_inst + 0.2) < 1e-15
    # This characteristic backend intentionally does not define a locked-wheel handling coordinate.
    # Regime policy routes that case to FRICTION_CONTACT instead of an epsilon denominator.
    with pytest.raises(ValueError):
        handling_kinematics(15.0, 0.0, 0.0, R)


def test_handling_kinematics_can_form_a_coordinate_at_zero_vehicle_speed_but_policy_still_routes_to_friction_contact():
    k = handling_kinematics(0.0, 0.0, 20.0, 0.3)
    assert math.isfinite(k.sx_inst)
    pol = TireRegimePolicy()
    assert select_tire_mode(TireMode.HANDLING, True, 0.0, k.travel_speed, pol) is TireMode.FRICTION_CONTACT


def test_normalization_speed_and_relaxation_travel_speed_are_semantically_separate():
    # Same calibrated instantaneous slip, different tread-convection distance -> different transient buildup.
    c, _ = P.load_map.evaluate(4000)
    prev = TireTransientState(0, 0, TireMode.HANDLING)
    slow = exact_relaxation_update(prev, 0.1, 0.0, 5.0, 0.01, c.sigma_x, c.sigma_y)
    fast = exact_relaxation_update(prev, 0.1, 0.0, 20.0, 0.01, c.sigma_x, c.sigma_y)
    assert 0 < slow.sx < fast.sx < 0.1


def test_low_vlong_standing_burnout_uses_friction_slide_without_slip_denominator():
    u = np.array([12.0, 0.0])
    W = np.diag([0.02, 0.002])
    r = solve_friction_contact_2d(P, u, W, 4000, 1.0, 1 / 60)
    assert r.converged and r.mode is FrictionContactMode.SLIDE
    c, _ = P.load_map.evaluate(4000)
    assert force_inside_peak_ellipse(c, r.force[0], r.force[1], 1.0, 1e-7)
    assert np.linalg.norm(r.u_post) < np.linalg.norm(u)


def test_low_speed_sliding_uses_kinetic_plateau_not_static_peak_capacity():
    u = np.array([30.0, 0.0])
    W = np.diag([0.002, 0.002])
    r = solve_friction_contact_2d(P, u, W, 4000, 1.0, 1 / 60)
    c, _ = P.load_map.evaluate(4000)
    assert r.mode is FrictionContactMode.SLIDE and r.converged
    # Pure longitudinal max-dissipation slide must land on the sliding/plateau force, not the larger static peak.
    assert abs(abs(r.force[0]) - c.fx_slide) < 1e-6
    assert abs(r.force[1]) < 1e-8
    assert c.fx_slide < c.fx_peak


def test_low_speed_stick_when_capacity_sufficient():
    u = np.array([0.15, 0.05])
    W = np.array([[0.08, 0.002], [0.002, 0.02]])
    r = solve_friction_contact_2d(P, u, W, 4000, 1.0, 1 / 60)
    assert r.mode is FrictionContactMode.STICK
    assert np.linalg.norm(r.u_post) < 1e-10


def test_sideways_near_90deg_fallback_is_finite_and_dissipative():
    u = np.array([0.02, 20.0])
    W = np.array([[0.08, 0.0], [0.0, 0.01]])
    r = solve_friction_contact_2d(P, u, W, 4000, 1.0, 1 / 60)
    assert r.converged
    assert np.isfinite(r.force).all()
    assert np.dot(r.force, u) > 0


def test_friction_contact_random_sweep_converges_and_is_dissipative():
    rng = np.random.default_rng(123)
    for _ in range(1000):
        a = float(rng.uniform(.005, .2)); off = float(rng.uniform(-.006, .006))
        b = max(float(rng.uniform(.001, .05)), off * off / a + 1e-5)
        W = np.array([[a, off], [off, b]])
        u = rng.uniform(-25, 25, 2)
        r = solve_friction_contact_2d(P, u, W, float(rng.uniform(50, 10000)), float(rng.uniform(.1, 1.2)), float(rng.choice([1/30,1/60,1/120,1/240])))
        assert r.converged and r.residual_norm < 1e-8
        assert np.isfinite(r.force).all()
        # Sign convention: positive F reduces u in u_post = u_free - W*lambda, so F dot u must be non-negative.
        assert np.dot(r.force, u) >= -1e-8


def test_adhesion_exit_seed_continuity_new_model():
    F = np.array([1500.0, 900.0])
    s = invert_force_to_relaxed_state(P, 4000, *F)
    o = evaluate_relaxed_state(P, 4000, s.sx, s.sy_eff, state_trial=s)
    assert np.linalg.norm(np.array([o.Fx, o.Fy]) - F) < 1e-5


def test_rolling_resistance_is_odd_and_dissipative():
    R = 0.30
    for w in [-100, -20, -1, 0, 1, 20, 100]:
        t = rolling_resistance_torque(P, 4000, R, w)
        assert t * w <= 1e-12
        if w != 0:
            assert math.copysign(1.0, t) == -math.copysign(1.0, w)
    assert abs(rolling_resistance_torque(P, 4000, R, 20) + rolling_resistance_torque(P, 4000, R, -20)) < 1e-12


def test_old_constant_negative_rr_would_inject_energy_in_reverse():
    old_t = -P.crr * 4000 * P.R0
    assert old_t * (-50) > 0  # deliberately demonstrates the v1.6 defect


def test_effective_radius_energy_consistency():
    assert contact_power_error(4000, 100, 0.300, 0.300) == 0
    assert abs(contact_power_error(4000, 100, 0.300, 0.295) - 2000) < 1e-9


def test_effective_radius_load_law_is_decoupled_from_vertical_contact_stiffness():
    r0 = effective_radius(P, vertical_compression=None, fz=4000, omega=0)
    # Changing TireVerticalLaw stiffness must not change Re in a rigid-normal route.
    q = TireV2Params(**{**P.__dict__, "vertical_k1": P.vertical_k1 * 5.0})
    r1 = effective_radius(q, vertical_compression=None, fz=4000, omega=0)
    assert abs(r0 - r1) < 1e-15
    # But explicit compliant-normal compression remains authoritative when supplied.
    rc = effective_radius(q, vertical_compression=0.02, fz=4000, omega=0)
    assert rc != r1


def test_effective_radius_optional_speed_growth_is_even_in_omega():
    p = TireV2Params(**{**P.__dict__, "radius_growth_q": 0.002})
    r0 = effective_radius(p, vertical_compression=0.01, omega=0)
    rp = effective_radius(p, vertical_compression=0.01, omega=150)
    rn = effective_radius(p, vertical_compression=0.01, omega=-150)
    assert rp > r0 and abs(rp - rn) < 1e-12


def test_vertical_law_no_tension():
    assert tire_vertical_law(P, -0.01, -1).fz == 0
    assert tire_vertical_law(P, 0.01, -100).fz == 0
    assert tire_vertical_law(P, 0.01, 0).fz > 0


def test_chain_jacobian_matches_full_residual_finite_difference():
    rng = np.random.default_rng(3)
    for _ in range(40):
        W = np.array([[rng.uniform(.02, .12), rng.uniform(-.002, .002)], [0, rng.uniform(.002, .03)]])
        W[1, 0] = W[0, 1]
        W[1, 1] = max(W[1, 1], W[0, 1] ** 2 / W[0, 0] + 1e-3)
        u = rng.uniform(-2, 2, 2)
        lam = rng.uniform(-20, 20, 2)
        prev = TireTransientState(*rng.uniform(-.03, .03, 2), TireMode.HANDLING)
        args = (P, u, W, 15.0, 4000.0, 0.03, 0.9, prev, 15.0, 1 / 60, lam)
        Ja = chain_jacobian_at_lambda(*args)
        Jf = residual_jacobian_finite_difference(*args)
        assert np.linalg.norm(Ja - Jf) / max(np.linalg.norm(Jf), 1.0) < 3e-5


def test_tire_exposes_load_sensitivity_derivative_without_owning_normal_solve():
    d = force_load_tangent_numeric(P, 4000, 0.08, 0.05, 0.02, 1.0)
    assert np.isfinite(d).all() and np.linalg.norm(d) > 0


def test_synthetic_normal_tangential_outer_iteration_closes_for_both_suspension_hosts():
    # Host-side fixture: suspension normal equilibrium has a jacking term proportional to tire Fy.
    # Tire only supplies Fy(Fz); it does not own this equation.  This emulates the coupling both a mapped-massless
    # backend and an explicit-unsprung backend must iterate/block-solve around.
    base = 3600.0
    jacking = 0.12
    sx, sy = 0.03, 0.09
    fz = base
    for _ in range(40):
        o = evaluate_relaxed_state(P, fz, sx, sy)
        nxt = base + jacking * o.Fy
        if abs(nxt - fz) < 1e-10:
            break
        fz = nxt
    residual = fz - (base + jacking * evaluate_relaxed_state(P, fz, sx, sy).Fy)
    assert abs(residual) < 1e-8
    assert 0 < fz < 8000


def test_handling_solver_refuses_zero_normalization_speed_instead_of_epsilon_hack():
    with pytest.raises(ValueError):
        solve_handling_impulse_2d(
            P, np.array([1.0, 0.0]), np.eye(2) * 0.02, 0.0, 4000, 0, 1,
            TireTransientState(0, 0, TireMode.HANDLING), 0.0, 1 / 60
        )


def test_implicit_2d_solver_converges():
    r = solve_handling_impulse_2d(
        P, np.array([2.0, 1.2]), np.array([[0.095, 0.008], [0.008, 0.015]]),
        20.0, 4000, 0.0, 1.0, TireTransientState(0, 0, TireMode.HANDLING), 20.0, 1 / 60
    )
    assert r.converged and r.residual_norm < 1e-8
    assert np.linalg.norm(r.u_post) < np.linalg.norm(np.array([2.0, 1.2]))


def test_implicit_random_sweep_convergence():
    rng = np.random.default_rng(11)
    failures = []
    for _ in range(300):
        a = float(rng.uniform(.01, .15)); b = float(rng.uniform(.002, .03)); off = float(rng.uniform(-.004, .004))
        W = np.array([[a, off], [off, max(b, off * off / a + 1e-4)]])
        u = rng.uniform(-3, 3, 2)
        v = float(rng.uniform(3, 40))
        res = solve_handling_impulse_2d(
            P, u, W, v, float(rng.uniform(500, 8000)), float(rng.uniform(-.08, .08)),
            float(rng.uniform(.3, 1.1)), TireTransientState(), v, 1 / 60, max_iter=20
        )
        if not res.converged or res.residual_norm > 1e-7:
            failures.append(res.residual_norm)
    assert not failures


def test_force_is_dissipative_over_random_relaxed_slips_zero_camber():
    rng = np.random.default_rng(42)
    for _ in range(3000):
        sx, sy = rng.uniform(-0.8, 0.8, 2)
        o = evaluate_relaxed_state(P, float(rng.uniform(100, 10000)), sx, sy, 0, float(rng.uniform(.2, 1.2)))
        assert o.Fx * sx + o.Fy * sy >= -1e-8


def test_reverse_symmetry_for_symmetric_fixture():
    for sx, sy in [(0.1, 0.03), (-0.2, 0.05), (0.3, -0.08)]:
        a = evaluate_relaxed_state(P, 4000, sx, sy)
        b = evaluate_relaxed_state(P, 4000, -sx, -sy)
        assert abs(a.Fx + b.Fx) < 1e-9
        assert abs(a.Fy + b.Fy) < 1e-9
        assert abs(a.Mz + b.Mz) < 1e-9


@pytest.mark.xfail(reason="Core handling Tire V2 intentionally excludes standstill turn-slip / bore / parking torque state")
def test_standstill_bore_torque_not_core():
    o = evaluate_relaxed_state(P, 4000, 0, 0, 0)
    assert abs(o.Mz) > 1.0


@pytest.mark.skip(reason="No target-tire measured/TIR fixture supplied; structure tests cannot establish MX-5/GT3 fit accuracy")
def test_target_tire_measurement_fit():
    pass

# --- Tire V2 close-out: Mz / combined surface / transient semantics / host coupling ---

def _num_deriv(fn, x, h=1e-7):
    return (fn(x+h)-fn(x-h))/(2*h)


def test_pneumatic_trail_full_curve_sign_reversal_and_zero_tail():
    c, _ = P.load_map.evaluate(4000)
    z, e = c.trail_zero_sy, c.trail_end_sy
    samples = {
        'small': evaluate_relaxed_state(P, 4000, 0, 0.25*z),
        'zero': evaluate_relaxed_state(P, 4000, 0, z),
        'reverse': evaluate_relaxed_state(P, 4000, 0, 0.5*(z+e)),
        'end': evaluate_relaxed_state(P, 4000, 0, e),
        'beyond': evaluate_relaxed_state(P, 4000, 0, 1.2*e),
    }
    assert samples['small'].Fy > 0 and samples['small'].Mz < 0 and samples['small'].trail > 0
    assert abs(samples['zero'].trail) < 1e-12 and abs(samples['zero'].Mz) < 1e-10
    assert samples['reverse'].trail < 0 and samples['reverse'].Mz > 0
    assert abs(samples['end'].trail) < 1e-12 and abs(samples['end'].Mz) < 1e-10
    assert abs(samples['beyond'].trail) < 1e-12 and abs(samples['beyond'].Mz) < 1e-10


def test_new_trail_is_c1_at_zero_crossing_and_tail_while_v17_was_not():
    c, _ = P.load_map.evaluate(4000)
    h = 1e-7
    jumps = {}
    old_jumps = {}
    for name, x in [('zero', c.trail_zero_sy), ('end', c.trail_end_sy)]:
        dl = (tv._trail(c, x) - tv._trail(c, x-h))/h
        dr = (tv._trail(c, x+h) - tv._trail(c, x))/h
        old_dl = (tv._v17_trail(c, x) - tv._v17_trail(c, x-h))/h
        old_dr = (tv._v17_trail(c, x+h) - tv._v17_trail(c, x))/h
        jumps[name] = abs(dr-dl)
        old_jumps[name] = abs(old_dr-old_dl)
    assert max(jumps.values()) < 1e-3
    assert min(old_jumps.values()) > 0.05


def test_mz_is_odd_and_full_surface_is_continuous_across_lateral_sign():
    for sx in np.linspace(-0.4, 0.4, 9):
        for sy in np.linspace(0.005, 0.35, 40):
            a = evaluate_relaxed_state(P, 4000, sx, sy)
            b = evaluate_relaxed_state(P, 4000, -sx, -sy)
            assert abs(a.Mz + b.Mz) < 1e-8
    # Near sy=0, Mz approaches zero continuously even at finite longitudinal slip.
    sx = 0.2
    vals = [abs(evaluate_relaxed_state(P, 4000, sx, sy).Mz) for sy in [1e-3, 5e-4, 2e-4, 1e-4]]
    assert vals[-1] < 0.11 * vals[0]


def test_mz_steering_feedback_virtual_work_and_no_pneumatic_trail_double_count():
    o = evaluate_relaxed_state(P, 4000, 0.02, 0.06)
    assert o.Fy != 0 and o.trail != 0
    F = np.array([o.Fx, o.Fy, 4000.0])
    M = np.array([o.Mx, o.rolling_resistance_torque, o.Mz])
    zaxis = np.array([0.0, 0.0, 1.0])
    cp = np.zeros(3)
    # Axis through the contact reference point: only the Tire free moment contributes.
    q_direct = steering_axis_generalized_force(F, M, cp, cp, zaxis)
    assert abs(q_direct - o.Mz) < 1e-12
    # Equivalent pneumatic-trail representation: shift Fy rearward, but then Mz must be omitted.
    shifted_cp = np.array([-o.trail, 0.0, 0.0])
    q_shift = steering_axis_generalized_force(F, np.array([o.Mx, o.rolling_resistance_torque, 0.0]), shifted_cp, cp, zaxis)
    assert abs(q_shift - o.Mz) < 1e-9
    # Doing both is the forbidden double count and exactly doubles the pneumatic contribution in this isolated geometry.
    q_double = steering_axis_generalized_force(F, M, shifted_cp, cp, zaxis)
    assert abs(q_double - 2.0*o.Mz) < 1e-9


def test_mechanical_trail_and_pneumatic_trail_add_once_in_steering_axis_moment():
    o = evaluate_relaxed_state(P, 4000, 0.0, 0.05)
    mech_trail = 0.035
    F = np.array([0.0, o.Fy, 4000.0])
    M = np.array([0.0, 0.0, o.Mz])
    cp = np.zeros(3)
    axis_point = np.array([mech_trail, 0.0, 0.0])
    q = steering_axis_generalized_force(F, M, cp, axis_point, np.array([0,0,1.0]))
    expect = -o.Fy*mech_trail + o.Mz
    assert abs(q-expect) < 1e-10


def test_combined_surface_c1_across_peak_and_slide_boundaries_on_multiple_rays():
    c, _ = P.load_map.evaluate(4000)
    for th in np.linspace(0.08, math.pi/2-0.08, 9):
        d = np.array([math.cos(th), math.sin(th)])
        sm = tv._radial_to_ellipse(c.sx_peak, c.sy_peak, d)
        ss = tv._radial_to_ellipse(c.sx_slide, c.sy_slide, d)
        for r0 in [sm, ss]:
            h = 2e-6
            def f(r):
                o = evaluate_relaxed_state(P, 4000, r*d[0], r*d[1])
                return np.array([o.Fx,o.Fy])
            left = (f(r0)-f(r0-h))/h
            right = (f(r0+h)-f(r0))/h
            # Piecewise model is designed C1; finite difference near knots should not show an FFB/solver-sized derivative jump.
            assert np.linalg.norm(left-right) < 250.0


def test_combined_surface_axes_origin_quadrants_and_large_slip_are_finite():
    grid = np.concatenate([np.linspace(-2.0,2.0,41), np.array([-1e-10,0,1e-10])])
    for sx in grid:
        for sy in grid[::4]:
            o = evaluate_relaxed_state(P, 4000, float(sx), float(sy))
            assert np.isfinite([o.Fx,o.Fy,o.Mz]).all()
            if sx != 0: assert o.Fx*sx >= -1e-8
            if sy != 0: assert o.Fy*sy >= -1e-8
    z = evaluate_relaxed_state(P,4000,0,0)
    assert z.Fx == 0 and z.Fy == 0 and z.Mz == 0


def test_full_slide_direction_approaches_kinetic_ellipse_maximum_dissipation_and_v17_did_not():
    c,_ = P.load_map.evaluate(4000)
    sx, sy = 2.0, 2.0
    o = evaluate_relaxed_state(P,4000,sx,sy)
    expected = tv._ellipse_max_dissipation_force(c, np.array([sx,sy]), 1.0, sliding=True)
    got = np.array([o.Fx,o.Fy])
    # Same direction; magnitude is the kinetic radial capacity from the characteristic.
    cosang = float(np.dot(got, expected)/(np.linalg.norm(got)*np.linalg.norm(expected)))
    assert cosang > 1-1e-10
    old = np.array(tv._v17_anisotropic_combined_force(c,sx,sy,1.0))
    oldcos = float(np.dot(old, expected)/(np.linalg.norm(old)*np.linalg.norm(expected)))
    assert oldcos < 0.995


def test_combined_surface_mu_to_zero_is_well_defined_without_erasing_nonfriction_outputs():
    gamma=math.radians(3)
    o1=evaluate_relaxed_state(P,4000,0.08,0.05,gamma,1.0,omega=50)
    o0=evaluate_relaxed_state(P,4000,0.08,0.05,gamma,0.0,omega=50)
    assert abs(o0.Fx)+abs(o0.Fy)+abs(o0.Mz) < 1e-12
    assert o0.R_eff == o1.R_eff
    assert o0.rolling_resistance_torque != 0
    assert o0.Mx != 0


def test_combined_surface_fz_to_zero_is_continuous_and_no_nan():
    mags=[]
    for fz in [100.0,10.0,1.0,0.1,0.01,0.0]:
        o=evaluate_relaxed_state(P,fz,0.1,0.08,0.02,1.0,omega=20)
        assert np.isfinite([o.Fx,o.Fy,o.Mx,o.Mz,o.R_eff]).all()
        mags.append(math.hypot(o.Fx,o.Fy))
    assert all(mags[i] >= mags[i+1]-1e-9 for i in range(len(mags)-1))
    assert mags[-1] == 0


def test_transient_state_is_continuous_across_fz_step_but_constitutive_force_may_jump():
    prev=TireTransientState(0.06,0.04,TireMode.HANDLING)
    c1,_=P.load_map.evaluate(2000); c2,_=P.load_map.evaluate(8000)
    s1=exact_relaxation_update(prev,0.1,0.08,20,0.0,c1.sigma_x,c1.sigma_y)
    s2=exact_relaxation_update(prev,0.1,0.08,20,0.0,c2.sigma_x,c2.sigma_y)
    assert s1 == s2 == prev
    f1=evaluate_relaxed_state(P,2000,prev.sx,prev.sy_eff)
    f2=evaluate_relaxed_state(P,8000,prev.sx,prev.sy_eff)
    assert np.linalg.norm([f1.Fx-f2.Fx,f1.Fy-f2.Fy]) > 1000


def test_transient_state_is_not_rescaled_by_mu_step_and_recovers_from_current_state():
    prev=TireTransientState(0.07,-0.05,TireMode.HANDLING)
    dry=evaluate_relaxed_state(P,4000,prev.sx,prev.sy_eff,mu_scale=1.0,state_trial=prev,omega=40)
    ice=evaluate_relaxed_state(P,4000,prev.sx,prev.sy_eff,mu_scale=0.0,state_trial=prev,omega=40)
    dry2=evaluate_relaxed_state(P,4000,prev.sx,prev.sy_eff,mu_scale=1.0,state_trial=prev,omega=40)
    assert ice.state_trial == prev
    assert ice.Fx == 0 and ice.Fy == 0
    assert abs(dry.Fx-dry2.Fx)<1e-12 and abs(dry.Fy-dry2.Fy)<1e-12


def test_mu_zero_over_time_updates_kinematic_lag_state_without_hidden_force_memory():
    s=TireTransientState(0,0,TireMode.HANDLING)
    for _ in range(30):
        o=handling_eval(P,4000,0.12,-0.06,0,0.0,s,15,1/120)
        s=o.state_trial
        assert o.Fx == 0 and o.Fy == 0
    assert abs(s.sx)>0.05 and abs(s.sy_eff)>0.02
    regrip=evaluate_relaxed_state(P,4000,s.sx,s.sy_eff,mu_scale=1.0,state_trial=s)
    assert math.hypot(regrip.Fx,regrip.Fy)>1000


def test_contact_loss_semantics_use_final_normal_active_classification_not_fz_epsilon():
    prev=TireTransientState(0.08,0.03,TireMode.HANDLING)
    # A constitutive query at zero Fz does not by itself mutate/clear canonical state.
    o=evaluate_relaxed_state(P,0.0,prev.sx,prev.sy_eff,state_trial=prev)
    assert o.state_trial == prev
    # The host's final normal active-set classification owns contact loss; only then commit AIRBORNE clears patch memory.
    mode=select_tire_mode(prev.mode,False,10,10,TireRegimePolicy())
    assert mode is TireMode.AIRBORNE
    air=commit_airborne_state()
    assert air.sx == 0 and air.sy_eff == 0


def test_handling_to_friction_to_handling_cycle_reseeds_from_actual_reaction():
    low=solve_friction_contact_2d(P,np.array([0.25,0.10]),np.array([[0.08,0.002],[0.002,0.03]]),4000,1.0,1/60)
    fr=commit_friction_contact_state()
    assert fr.mode is TireMode.FRICTION_CONTACT and fr.sx == 0 and fr.sy_eff == 0
    seed=seed_handling_from_reaction(P,4000,*low.force)
    rec=evaluate_relaxed_state(P,4000,seed.state.sx,seed.state.sy_eff,state_trial=seed.state)
    assert np.linalg.norm(np.array([rec.Fx,rec.Fy])-low.force) < 1e-5
    assert not seed.projected


def test_handoff_projection_is_explicit_diagnostic_not_silent():
    c,_=P.load_map.evaluate(4000)
    seed=seed_handling_from_reaction(P,4000,2*c.fx_peak,2*c.fy_peak)
    assert seed.projected
    assert np.linalg.norm(seed.target_force-seed.represented_force) > 1000
    assert seed.error_norm < 1e-5  # error to projected representable target, not original out-of-domain request


def test_mapped_massless_full_normal_tangential_block_closes():
    r=solve_mapped_massless_normal_tangential_block(
        P,np.array([2.2,1.0]),np.array([[0.08,0.004],[0.004,0.018]]),18.0,18.0,
        TireTransientState(0.02,0.01,TireMode.HANDLING),1/60,3400.0,np.array([0.10,0.16]),camber=0.03,mu=0.9)
    assert r.converged and r.residual_norm < 1e-8
    assert 3000 < r.fz < 5000


def test_explicit_unsprung_compliant_normal_tangential_block_closes():
    r=solve_explicit_unsprung_normal_tangential_block(
        P,np.array([1.8,0.8]),np.array([[0.075,0.003],[0.003,0.016]]),16.0,16.0,
        TireTransientState(0.01,0.0,TireMode.HANDLING),1/120,42.0,-0.35,0.018,3800.0,np.array([0.08,0.12]),camber=0.02,mu=0.95)
    assert r.converged and r.residual_norm < 1e-8
    assert r.fz > 0 and math.isfinite(r.normal_state)


def test_one_pass_normal_tangential_split_leaves_large_mapped_host_residual_under_strong_coupling():
    # Deliberately strong but finite jacking fixture: one-pass old-Fz tangential evaluation is not closed.
    u=np.array([2.5,1.4]); W=np.array([[0.075,0.005],[0.005,0.018]]); dt=1/60; base=3000.; jc=np.array([0.22,0.28])
    oldfz=base
    tang=solve_handling_impulse_2d(P,u,W,18,oldfz,0.03,1.0,TireTransientState(),18,dt)
    F=tang.impulse/dt
    newfz=base+jc@F
    residual=abs(newfz-(base+jc@np.array([evaluate_relaxed_state(P,newfz,tang.state_trial.sx,tang.state_trial.sy_eff,0.03,1.0).Fx, evaluate_relaxed_state(P,newfz,tang.state_trial.sx,tang.state_trial.sy_eff,0.03,1.0).Fy])))
    block=solve_mapped_massless_normal_tangential_block(P,u,W,18,18,TireTransientState(),dt,base,jc,0.03,1.0)
    assert residual > 50.0
    assert block.converged and block.residual_norm < 1e-8
