# v2.4 maneuver matrix

Cases: 33; PASS=31, EXPECTED_HOST_BOUNDARY=2, FAIL=0, TIMEOUT=0

| scenario | backend | Hz | status | residual / exception |
|---|---|---:|---|---|
| straight_no_brake | MAPPED_KC_MASSLESS | 60 | PASS | 2.4093872513439307e-12 |
| straight_no_brake | MAPPED_KC_MASSLESS | 120 | PASS | 4.004737893300442e-12 |
| straight_no_brake | MAPPED_KC_MASSLESS | 240 | PASS | 4.917471798141469e-13 |
| straight_no_brake | DYNAMIC_UNSPRUNG | 60 | PASS | 2.0553947792324272e-12 |
| straight_no_brake | DYNAMIC_UNSPRUNG | 120 | PASS | 6.594576366101071e-12 |
| straight_no_brake | DYNAMIC_UNSPRUNG | 240 | PASS | 8.05225730318433e-14 |
| service_brake_0.45 | MAPPED_KC_MASSLESS | 60 | PASS | 8.238168028975942e-13 |
| service_brake_0.45 | MAPPED_KC_MASSLESS | 120 | PASS | 2.1617917671810614e-11 |
| service_brake_0.45 | MAPPED_KC_MASSLESS | 240 | PASS | 1.7582472749879535e-12 |
| service_brake_0.45 | DYNAMIC_UNSPRUNG | 60 | PASS | 9.557891654629916e-12 |
| service_brake_0.45 | DYNAMIC_UNSPRUNG | 120 | PASS | 4.327400791429703e-12 |
| service_brake_0.45 | DYNAMIC_UNSPRUNG | 240 | PASS | 1.5874841622720657e-11 |
| service_brake_full | MAPPED_KC_MASSLESS | 60 | EXPECTED_HOST_BOUNDARY | RigidBodyDynamicsHostRequired |
| service_brake_full | MAPPED_KC_MASSLESS | 120 | PASS | 9.311416746772527e-13 |
| service_brake_full | MAPPED_KC_MASSLESS | 240 | PASS | 3.809468256085954e-11 |
| parking_brake_15mps | MAPPED_KC_MASSLESS | 60 | PASS | 2.306042192015823e-12 |
| parking_brake_15mps | MAPPED_KC_MASSLESS | 120 | PASS | 3.0647843309659286e-12 |
| parking_brake_15mps | MAPPED_KC_MASSLESS | 240 | PASS | 2.1555024432018398e-14 |
| position_steering | MAPPED_KC_MASSLESS | 60 | PASS | 2.1542961642015412e-12 |
| position_steering | MAPPED_KC_MASSLESS | 120 | PASS | 1.1136340601850675e-11 |
| position_steering | MAPPED_KC_MASSLESS | 240 | PASS | 2.2353707697809339e-13 |
| torque_driven_steering | MAPPED_KC_MASSLESS | 60 | PASS | 1.44228840025587e-12 |
| torque_driven_steering | MAPPED_KC_MASSLESS | 120 | PASS | 1.103720420451721e-11 |
| torque_driven_steering | MAPPED_KC_MASSLESS | 240 | PASS | 2.2270647647001582e-13 |
| split_mu | MAPPED_KC_MASSLESS | 60 | PASS | 1.4403024045735277e-12 |
| split_mu | MAPPED_KC_MASSLESS | 120 | PASS | 6.9671282225446454e-12 |
| split_mu | MAPPED_KC_MASSLESS | 240 | PASS | 5.71848968053618e-13 |
| rear_wheel_differential_external | MAPPED_KC_MASSLESS | 60 | PASS | 4.423245724206464e-12 |
| rear_wheel_differential_external | MAPPED_KC_MASSLESS | 120 | PASS | 1.687393297160727e-11 |
| rear_wheel_differential_external | MAPPED_KC_MASSLESS | 240 | PASS | 5.369900197118143e-13 |
| step_driver_F_to_R_full_brake | MAPPED_KC_MASSLESS | 60 | EXPECTED_HOST_BOUNDARY | RigidBodyDynamicsHostRequired |
| step_driver_F_to_R_full_brake | MAPPED_KC_MASSLESS | 120 | PASS | 8.238432384205518e-12 |
| step_driver_F_to_R_full_brake | MAPPED_KC_MASSLESS | 240 | PASS | 8.205074664147105e-12 |
