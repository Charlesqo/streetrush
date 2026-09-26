# Implemented scope

本文件只描述 v2.4 主动路径，不把目录中历史参考代码的“存在”算成实现完成。

## 已闭合

| 系统 | 主动实现 | 当前语义 |
|---|---|---|
| Tire | `accepted_tire_adapter.py` + v1.7/v1.8 references | accepted relaxed handling；ordinary empirical state 不做 peak/slide projection；AIRBORNE 立即清 patch；低速 friction-contact 明确要求 world response |
| Contact geometry | `unified_vehicle_fixture.py` + `tire_host_contract.py` | final spindle pose、flat-road reduced normal、切向基、实际 contact point velocity、ground-point velocity扣除、同一步有效半径；CONTACT/AIRBORNE 单边 active set 与 complementarity telemetry |
| Suspension/K&C | `chassis_suspension_reference.py` + Unified residual | exact map derivative、SO(3) left Jacobian、full-wrench JᵀW、spring/damper/ARB、load-only compliance、mapped massless/dynamic unsprung 双后端；mapped CONTACT 速度级 `qdot`，AIRBORNE massless BE 且保留 ARB |
| Steering | Steering V2 + `steering_transaction.py` | position-command 与 torque-driven 两条互斥因果；road load 只走一次 spatial projection |
| Aero | `aero_reference_v1_9.py` | signed 6D QSS wrench、relative air velocity at reference point、`ω×r`、reference→CG shift、force/moment reaction ledger；solver 直接以 dataset `hF/hR` valid domain 为平台变量 |
| Powertrain | `engine_model.py` + `powertrain_controller.py` | Engine torque state、signed reverse ratio、Neutral decoupling、finite clutch lock/slip active set、理想无损 open differential |
| Brakes/assists | `vehicle_controls_reference.py` + Unified active set | driver/TCS/ESC 共用 service actuator；ABS 调制整个 service channel；parking 独立且绕过 ABS；actual reaction 由 solve 决定 |
| Driver semantics | `DriverDirectionFSM` + `step_driver` | F↔R 先制动/近零 dwell；Neutral 立即；FSM 与 vehicle transaction 同成败 |
| Transaction | 五 owner + Powertrain 两 owner | frozen trial、preflight、exactly-once success、pre-commit abort、任一 post-commit fault 的 group snapshot rollback |

## 有意不扩展

- 不实现 LSD、locked differential 或 torque-vectoring differential。
- 不实现 Tire thermal、wear、hysteresis 或可储能 standstill deformation backend。
- 不实现 active/unsteady Aero。
- 不把 synthetic parameters 宣称为任何目标车辆标定。
- 不把 controller output 直接写成 wheel speed、body velocity、yaw rate 或 normal load。
- 不在 reduced planar fixture 内伪造 Rapier-owned chassis heave/roll/pitch inertia；需要该动态状态或更细 substep 的工况抛出 `RigidBodyDynamicsHostRequired`，且事务不提交。

这些项目不是“漏做后假装完成”，而是本轮冻结范围之外。
