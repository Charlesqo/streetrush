# StreetRush Vehicle Physics Baseline

> 审计快照：2026-08-31。本文基于当时的 current working tree、v2.0 baseline 和 v2.4 standalone closeout。并行实现可能继续变化；“当前 StreetRush”栏需要在下一次实现审计时刷新。本文不替用户作 backend、模式、baseline 或数据范围决定。

## 1. 权威顺序

发生冲突时按以下顺序裁决：

1. `vehicle_physics_design_baseline_cn_v2.0 (1).docx`：强制 baseline、合法可选/互斥路线、XFAIL/SKIP 纪律。
2. `vehicle_physics_v2_4_standalone_closeout`：active implemented scope、host boundary、executable reference 与 recorded validation manifest。
3. 本文中用户已经明确作出的项目选择。当前所有路线选择仍为 `UNDECIDED`。
4. StreetRush 当前代码、golden 和测试。

局部测试 PASS 不得推翻更高层物理、ownership 或 transaction contract。

本次审计的本地来源位置：

- StreetRush working tree：`/Volumes/Storage/streetrush`。
- v2.0：`/Users/charles/Downloads/vehicle_physics_design_baseline_cn_v2.0 (1).docx`。
- v2.4 standalone：`/Users/charles/Documents/New project/vehicle_physics_v2_4_standalone_closeout`。
- 审计时 HEAD：`afcb616551024ab97a9163eeb7550c8c69f7db24`。`src/vehicle-v24` 当时为 working-tree 新增目录，不在该 HEAD tree 中。

这些位置是审计定位信息，不要求未来环境使用相同绝对路径；迁移时保留 source identity、版本和 hash。

## 2. “不缩减”的定义

- 完整保留 v2.0 强制 baseline。
- 完整移植 v2.4 已接受、已实现且属于所选 backend 的语义与算法。
- 接上 v2.4 明确留给真实 host 的 Rapier/接触边界。
- 可选且互斥 backend 可以只选一种，但必须由用户或明确项目决定记录；未决定时保持 `UNDECIDED`。
- 真实数据不存在时标 `SKIP_TARGET_DATA`，不得编造或将 synthetic/estimated 数据称为 target validation。
- 禁止用更简单的数学模型替换 accepted 模型后仍称为 v2.4。

## 3. v2.0 强制 baseline

| 领域 | 强制合同 |
|---|---|
| State ownership | Chassis 6DOF、Engine `ωe`、各轮 `ωi` 是真实状态；每个 semantic state 一个 owner |
| Finite constraints | Clutch、brake、tire adhesion 以 capacity/active-set 求解，不通过强制同步或 clamp |
| Coupled solve | Engine—clutch—gear mapping—wheels—Tire/contact—chassis reaction 在同一 substep 闭合 |
| Commit | Snapshot → frozen trial → candidate solve → preflight → exactly-once commit；失败精确 rollback |
| Open differential | Carrier 与两侧平均速度满足对偶映射；左右轮速保持独立 |
| Brake/assists | Brake input 是 capacity；ABS/TCS/ESC 只改 actuator authority，不写 wheel/body/yaw state |
| Contact | 使用 contact-point relative velocity、tangent frame、ground velocity；各轴线分离；禁止 epsilon 静摩擦 |
| Steering | Canonical steering state；road reaction 是完整 contact wrench 的唯一 spatial `ΣJᵀW` 投影 |
| K&C | Final WheelPose、exact map derivative/Jacobian、spring/damper/ARB、normal/load path；AIRBORNE 机械状态仍求解 |
| Tire V2 | Load sensitivity、2D combined slip、camber、moments、rolling resistance、`R_eff`、transient、handling/low-speed regimes、implicit solve |
| Normal authority | Rigid active normal 与 compliant `TireVerticalLaw` 严格二选一 |
| Aero | 相对风含 `vCOM + ω×r − vwind`；单一 declared-reference 6D chassis wrench；reference→CG shift |
| Engine | Signed torque law、finite idle/starter/limiter authority、stall mode、frozen control trial；禁止 RPM floor/clamp |
| Rapier boundary | Vehicle internal solver 与 Rapier world 显式 operator split；world/contact/aero/brake reaction 各记一次 |
| Validation | Schema/invariant/component/coupled/target/scenario 分层；numerical 与 timestep convergence 分开；PASS/XFAIL/SKIP 严格记账 |

## 4. v2.4 standalone accepted scope

Standalone active scope 已实现并记录：

- Tire v1.7 steady-state + v1.8 transient adapter。
- CONTACT/AIRBORNE active set、AIRBORNE patch clear、low-speed `FRICTION_CONTACT` host requirement。
- Mapped massless 与 dynamic unsprung K&C backend。
- SO(3) left Jacobian、velocity-level `Jq̇`、spring/damper/ARB、load-only compliance。
- Position-command 与 torque-driven Steering，完整 spatial `JᵀW`。
- Signed six-component QSS Aero、`ω×r`、wind subtraction、reference→CG shift。
- Engine torque state、finite clutch、signed gears、Neutral、ideal lossless open differential。
- Service/parking brake、ABS/TCS/ESC、Driver direction FSM。
- 五 owner frozen trial/preflight/commit/abort/group rollback。
- Same-step whole-vehicle residual、active-set telemetry、energy ledger。

Standalone 明确不拥有 Rapier 6DOF、真实 scene query、world contact response 或目标车辆标定。

## 5. Host boundary

真实 StreetRush/Rapier host 必须提供：

- Scene query、contact point/normal/separation/material。
- Moving/rotating ground point velocity。
- Low-speed free contact velocity 与 Delassus/effective mass。
- Chassis 6DOF pose/velocity/full mass-inertia。
- World wind 和 track ground/kerb/footprint 信息。
- Net chassis/world wrench application 与 substep scheduler。

必须保持：

- Candidate residual 中不写 canonical Rapier state。
- Normal authority 唯一。
- Handling Tire 与 low-speed contact reaction 互斥。
- Road/Aero/brake reaction 各施加一次。
- ABS/TCS/ESC 只拥有 actuator authority；Driver FSM 只拥有 command authority。

## 6. 已知 XFAIL 与 SKIP

### `XFAIL_EXPECTED`

- Additive K&C 对 combined roll+lateral embedded cross term 的已知限制。
- Standstill bore / parking turn-slip torque 不属于 accepted handling Tire core。
- Naive post-integration RPM clamp 的角冲量不守恒 negative control。
- “training fit 足以代表 validation”的错误断言。

Generic Newton 跨 active set、staggered old-`Fz` Tire、epsilon slip、重复 Aero/normal force 等是被拒绝的实现，不得标成合法 XFAIL。

### `SKIP_TARGET_DATA`

- 目标车 hardpoint/Chrono、mass/COM/inertia、damper/K&C。
- TIR/Flat-Trac Tire 数据。
- Engine dyno 与低速 combustion/starter/stall 数据。
- Aeromap、SAE J2263 coastdown/anemometry。
- ISO 7401/22140 lateral transient 和目标标准 maneuver 数据。

## 7. 当前 StreetRush 审计矩阵

| 项目 | 状态 | 2026-08-31 裁决 |
|---|---|---|
| 当前 working tree 身份 | `PASS` | `src/vehicle-v24` 存在且不在当时 HEAD tree，审计的是工作树新增版本 |
| Production `v24-active` 接线 | `PASS` | `main.js` 显式请求 active；abort 不自动回退 legacy |
| Rapier query/body/ground velocity | `PASS` | 真实 ray normal、contact point、ground velocity、body sample 已接 |
| Low-speed Delassus host | `PASS` | 2×2 body/ground spatial response + wheel inertia 已接入生产 runtime |
| Whole-vehicle coupled solver | `FAIL` | 当前是几何局部迭代、powertrain preparation、逐轮 Tire、制动 active set 的分阶段路径，不是同一 global candidate residual |
| Tire V2 | `PARTIAL` | 有 PCHIP、combined slip、trail、transient、low-speed regimes；完整 reference/differential 和 whole-system coupling 未证明 |
| Mapped K&C | `PARTIAL` | 有 jounce/spring/damper/ARB；完整 map asset/SO(3)/velocity-level closure 未证明 |
| Dynamic unsprung | `PARTIAL` | 名称/枚举存在，runtime 无实现或 dispatch；是否要求实现仍 `UNDECIDED` |
| Steering position path | `PASS` | 作为当前存在的 causality path 可运行；是否正式选择仍 `UNDECIDED` |
| Full spatial Steering `JᵀW` | `FAIL` | 当前为 planar/数值角度导数 reaction，不等价于 Final WheelPose spatial Jacobian 对完整 wrench 的投影 |
| Engine/gearbox/FSM | `PARTIAL` | 状态和方向联锁存在；未与 chassis/Tire 在同一 global residual 中闭合 |
| Finite clutch/open diff | `PARTIAL` | Capacity/lock-slip 和 ideal mapping 存在；实际仍分阶段 |
| Brake/ABS/TCS/ESC | `PARTIAL` | Capacity/modulation 已接；accepted whole-system reaction/arbitration 未完整证明 |
| Aero algorithm | `PARTIAL` | 六系数分支存在；production 未传完整 `aeroAsset`，使用 `cdA` fallback |
| 目标车辆物理数据 | `SKIP_TARGET_DATA` | 不得将 fallback/synthetic 参数称为目标车验证 |
| 五 owner transaction | `PASS` | Stage/preflight/exactly-once/fault rollback 的现有 tests 通过 |
| Rapier host exact rollback | `PARTIAL` | `resetForces/resetTorques` 可能影响同 tick 其他 force writer；需 snapshot/delta 证据 |
| Oracle/golden | `PARTIAL` | Exporter/golden/hash 存在；selected checks 不覆盖完整 Python maneuver/owner/residual 面 |
| Production validation page | `FAIL` | 当时 `validation.js` 未指定 mode，默认走 legacy |
| v24 umbrella gate | `PASS` | Recorded：7 suites、240 checks |
| v24 determinism/performance | `PASS` | Recorded determinism hash；120 Hz performance 无 overrun |
| Legacy replay determinism | `FAIL` | Recorded：`vehicle replay baseline changed`；处置仍 `UNDECIDED` |
| Standalone 本轮 Python 重跑 | `NOT_RUN` | `BLOCKED_TOOL`：当时本机 Python 环境缺 pytest/SciPy；manifest 记录不可冒充本轮重跑 |
| Live browser v24 production maneuvers | `NOT_RUN` | 当时没有 v24-active validation 页面证据 |

总体状态：`PARTIAL`。`v24-active` 是接线模式，不是完整性认证。

## 8. 未决定事项登记

本节是唯一决策登记表。所有条目状态均为 `UNDECIDED`。表中的“当前建议”是审计建议，不是用户决定；实现不得据此静默删除其他方案或改变 production mode。

### D-01 Clutch 求解路线

- **状态：** `UNDECIDED`
- **可选方案：** A. 强耦合 implicit；B. Coulomb sliding + exact bounded lock active-set。
- **影响：** 决定 clutch lock/slip candidate、容量和与 wheel/chassis residual 的耦合方式。
- **v2.0 分类：** 可选且互斥；必须保留 finite-capacity/implicit semantics。
- **v2.4 standalone：** 已实现 finite clutch lock/slip active-set 并进入 coupled solve。
- **当前 StreetRush：** 有 capacity 和 lock/slip，但分阶段计算，整体 `PARTIAL`。
- **当前建议：** 采用 B 并并入同一 JS whole-vehicle active set；仍等待用户决定。

### D-02 Sliding Tire 路线

- **状态：** `UNDECIDED`
- **可选方案：** A. Maximum-dissipation Coulomb；B. Adhesion constraint + finite-slip constitutive law。
- **影响：** 决定 sliding direction、capacity projection、energy dissipation 和 handling handoff。
- **v2.0 分类：** 可选路线；文档推荐 B，禁止用错误的 slip-parallel 简化。
- **v2.4 standalone：** 已实现 accepted handling/low-speed active path。
- **当前 StreetRush：** 有 stick/slide 与 nonlinear/bounded solve，完整 parity `PARTIAL`。
- **当前建议：** 跟随 standalone accepted B；仍等待用户决定。

### D-03 Steering causality

- **状态：** `UNDECIDED`
- **可选方案：** A. Position-command；B. Torque-driven/physical handwheel-column；以后可扩展 VGR/SbW。
- **影响：** 决定 canonical steering state、driver/assist authority、road reaction 所进入的动力学方程。
- **v2.0 分类：** Position 与 torque causality 强制互斥；完整 spatial `JᵀW` 在任一路线都强制。
- **v2.4 standalone：** 两种 causality 均已实现。
- **当前 StreetRush：** Position path 已接；torque-driven 未形成 production dispatch；`JᵀW` 仍 `FAIL`。
- **当前建议：** 首轮冻结 position-command，但先补完整 `JᵀW`；仍等待用户决定。

### D-04 Suspension fidelity 与 dynamic unsprung

- **状态：** `UNDECIDED`
- **可选方案：** A. Axis/raycast massless；B. Mapped K&C Reduced massless；C. Reduced multibody/dynamic unsprung；D. Full multibody。Hardpoint solver 可作为离线 map generator。
- **影响：** 决定 wheel-pose state、rough-road/wheel-hop、额外 `q/q̇`、inertia、solver unknowns 和性能预算。
- **v2.0 分类：** 可选/分级；Mapped K&C massless 是默认。Massless 与 explicit unsprung DOF 互斥；禁止只有 `unsprungMass` 参数而无方程。
- **v2.4 standalone：** Mapped massless 和 dynamic unsprung 均已实现。
- **当前 StreetRush：** Mapped subset 已接；`DYNAMIC_UNSPRUNG` 仅声明、无 runtime implementation/dispatch。
- **当前建议：** 先选 B；若选 B，需明确把 dynamic 标为 unsupported 而不是伪装支持；仍等待用户决定，禁止静默删除 dynamic 选项。

### D-05 Normal-force backend

- **状态：** `UNDECIDED`
- **可选方案：** A. Rigid active normal contact；B. Compliant `TireVerticalLaw`。
- **影响：** 决定 normal impulse/load authority、Delassus 维度、contact complementarity 与 stored energy。
- **v2.0 分类：** 强制互斥；双重 normal force 是 `FAIL`。
- **v2.4 standalone：** Contract/adapter 支持 exactly-one authority，并实现 reduced closure/host boundary。
- **当前 StreetRush：** Ray/contact + suspension normal path 已存在；其正式 backend 名称和完整 coupled semantics 未冻结。
- **当前建议：** 采用 A 并由 Rapier host 提供 response；仍等待用户决定。

### D-06 Tire transient 与 static deformation

- **状态：** `UNDECIDED`
- **可选方案：** A. `EMPIRICAL_RELAXATION_BOUNDED` + `FRICTION_CONTACT`；B. `ENERGY_CONSISTENT_DEFORMATION`，可支持 soft-static deformation。
- **影响：** 决定 transient state、stored-energy/yield law、低速停车和 handoff contract。
- **v2.0 分类：** Backend 可选且兼容性受约束；empirical + soft-static 禁止。Standstill bore/turn-slip 仍为 XFAIL。
- **v2.4 standalone：** Empirical transient 已实现；energy-consistent deformation 只有 policy/gate，不是完整 brush 数值 backend。
- **当前 StreetRush：** Empirical transient 和 low-speed friction contact 已接；完整 differential parity `PARTIAL`。
- **当前建议：** 采用 A；保留 B 为未实现可选路线；仍等待用户决定。

### D-07 Camber transient

- **状态：** `UNDECIDED`
- **可选方案：** A. `INSTANT`；B. `FIRST_ORDER_SEPARATE`。
- **影响：** B 增加独立状态和所需 measured transient 数据；A 不伪造未知时间常数。
- **v2.0 分类：** 可选；无独立数据时默认 A。
- **v2.4 standalone：** Accepted transient policy 支持相应语义。
- **当前 StreetRush：** 有 camber 输入/处理，但未记录正式 backend/data provenance。
- **当前建议：** 无真实数据时 A；仍等待用户决定。

### D-08 Aero backend、reverse fallback 与 production asset

- **状态：** `UNDECIDED`
- **可选方案：** A. Constant coefficient；B. Signed QSS aeromap；C. Unsteady Aero（未来非核心）。Reverse 可 reject/flag 或使用明确命名的 fallback，不能静默套用 forward domain。
- **影响：** 决定 6D coefficients、ride-height coupling、domain handling、target-data acquisition 和 reverse 行为。
- **v2.0 分类：** Constant/QSS 可选；race 推荐 QSS；unsteady 非强制。超域必须 reject/flag。
- **v2.4 standalone：** Signed six-component QSS 已实现；forward-flow reduced reference 对 reverse 要求 host fallback。
- **当前 StreetRush：** 六系数代码和 test injection 存在；production 未传 `aeroAsset`，实际使用 `cdA`/isotropic fallback。
- **当前建议：** 保留 QSS 算法，fallback 明确命名，目标 fidelity 继续 `SKIP_TARGET_DATA`；仍等待用户决定。

### D-09 Engine torque semantics

- **状态：** `UNDECIDED`
- **可选方案：** A. `NET_CRANK_TORQUE_SURFACE`；B. Gross/combustion + separately sourced loss；C. Full-load-only 并把其他域标缺失。
- **影响：** 决定 engine braking、loss 是否双算、valid domain、starter/idle/limiter authority。
- **v2.0 分类：** 必须声明一种，路线互斥；不得 net map 再减 generic loss。
- **v2.4 standalone：** Signed Engine torque state/model 和 asset semantics 已实现。
- **当前 StreetRush：** Engine/clutch logic 存在，真实 asset/domain 与 complete coupled solve `PARTIAL`。
- **当前建议：** A；仍等待用户决定。

### D-10 Road-load 与 Aero 阻力分工

- **状态：** `UNDECIDED`
- **可选方案：** A. 独立 Aero asset + coastdown 仅识别 residual rolling/mechanical loss；B. 无独立 Aero 时 aggregate road-load 暂时承载总阻力。
- **影响：** 错误混用会 double-count drag/rolling loss，并破坏 coastdown calibration。
- **v2.0 分类：** 互斥；不可同时全量施加。
- **v2.4 standalone：** Aero 与 calibration/asset pipeline 均有分层语义。
- **当前 StreetRush：** `cdA` fallback 和其他 road/surface loss 共存，尚无 target passport/identifiability 证明。
- **当前建议：** 在真实 Aero asset 前明确采用 B；接入 asset 后迁移 A；仍等待用户决定。

### D-11 Dynamic ground action/reaction

- **状态：** `UNDECIDED`
- **可选方案：** A. 仅保证 static/kinematic ground；B. 支持 dynamic pair 双向 action/reaction。
- **影响：** B 要求 ground body velocity、有效质量、反力写入和精确 rollback。
- **v2.0 分类：** A 是主要目标；B 可选。两者仍是 Rapier/vehicle operator split。
- **v2.4 standalone：** 声明 host boundary，没有 Rapier 实体 adapter。
- **当前 StreetRush：** Adapter 已对 dynamic ground 写 reaction，但 exact rollback 仍 `PARTIAL`。
- **当前建议：** 保留 B 并修复/证明 snapshot-delta rollback；仍等待用户决定。

### D-12 Production mode：`v24-active` / `v24-shadow` / `legacy`

- **状态：** `UNDECIDED`
- **可选方案：** A. 继续 production `v24-active`；B. 完整 parity 前切 `v24-shadow`，通过后 active；C. 临时 legacy。
- **影响：** 决定玩家实际 force authority、回归风险、shadow telemetry 和 release gate。
- **v2.0 分类：** 不规定产品开关，但强制 single force authority、禁止双重施力和伪造完成。
- **v2.4 standalone：** 提供 reference/host contract，不决定 StreetRush rollout mode。
- **当前 StreetRush：** 审计快照中 `main.js` 硬编码 active；validation 页面默认 legacy。
- **当前建议：** 在 whole-vehicle parity 完成前 B 风险最低；仍等待用户决定，不在本文改代码。

### D-13 Legacy determinism baseline drift

- **状态：** `UNDECIDED`
- **可选方案：** A. 认定为预期语义变更，经审查后重录；B. 认定为回归并修复；C. Legacy 正式退役但保留归档证据。
- **影响：** 决定 replay hashes、legacy isolation、bisect 能力和 release blocker 状态。
- **v2.0 分类：** 强制可复现、不得仅为消除 FAIL 重录 baseline；具体是否保留 legacy 是项目选择。
- **v2.4 standalone：** 不拥有 StreetRush legacy replay baseline。
- **当前 StreetRush：** Recorded test `vehicle replay baseline changed`，状态 `FAIL`。
- **当前建议：** 先分类差异再决定 A/B/C；禁止自动更新 hash；仍等待用户决定。

### D-14 真实目标车辆数据范围

- **状态：** `UNDECIDED`
- **可选方案：** A. 启动完整 target-data acquisition；B. 仅完成 structural/synthetic v2.4，目标 fidelity 长期保持 SKIP；C. 分车型/分数据族逐步采购。
- **影响：** 决定 Parameter/Dataset Passport、L4 validation、标定预算和可以声称的 fidelity。
- **v2.0 分类：** 数据不存在时强制 `SKIP_TARGET_DATA`，禁止编造；是否采购数据由项目决定。
- **v2.4 standalone：** 结构/算法已用 synthetic fixtures 验证；明确不宣称目标车 calibration。
- **当前 StreetRush：** 车辆配置和 fallback 参数存在，但真实 hardpoint/Tire/Aero/dyno/coastdown/lateral fixtures 未建立权威证据。
- **当前建议：** 若短期不采购，选择 B 并保持诚实 SKIP；仍等待用户决定。

## 9. 实施依赖顺序

在任何路线最终决定后，建议依赖顺序仍为：

1. 冻结 contract、坐标、owner、backend decision record。
2. 扩充完整 Python oracle/differential fixtures。
3. 完成 host transaction snapshot/delta rollback。
4. 实现 same-step whole-vehicle coupled solver。
5. 接 Tire/contact。
6. 接所选 K&C 与完整 Steering `JᵀW`。
7. 接 Engine/clutch/gearbox/open diff、brake/assists。
8. 接所选 Aero/road-load/data backend。
9. 切 production/validation mode，并过完整 release gates。

不得跳过第 4 步后靠继续调参把分阶段算法称为 v2.4。

## 10. Python reference → JS/Rapier 文件映射

Python 文件名均相对于上述 standalone 的 `engine_calibration_reference/`。本表是审计快照，不宣称“有对应 JS 文件”就已等价。未来新增文件只是建议影响范围，并未在本次文档任务中创建。

| 系统 | Python authority | 当前 StreetRush 文件 | 无缩减移植要求 |
|---|---|---|---|
| Coupled solver | `coupled_vehicle_solver.py`；`unified_vehicle_fixture.py::_evaluate/step`；`runtime_vehicle_solver.py` 仅作 reduced fast-path 对照 | [runtime.js](../src/vehicle-v24/runtime.js)、[math.js](../src/vehicle-v24/math.js) | 建议新增 `src/vehicle-v24/coupled-solver.js`；统一 end-of-step unknowns、candidate modes、scaled residual、capacity/complementarity/dissipation 和 energy ledger。不能把 reduced fast path 当作完整 Tire V2 整车真值 |
| Tire | `accepted_tire_adapter.py`；`tire_v2_reference_v1_7.py`；`tire_v2_reference_v1_8.py` | [tire.js](../src/vehicle-v24/tire.js) | 对齐 constitutive law、PCHIP/domain、relaxation、camber、moments、R_eff、AIRBORNE clear、handoff 和错误语义；历史 `tire_v2_final/` 不是 active import truth |
| Contact contract | `tire_host_contract.py`；accepted adapter 的 `FrictionContactHostRequired` | [rapier-host-adapter.js](../src/vehicle-v24/rapier-host-adapter.js)、[contract.js](../src/vehicle-v24/contract.js) | Final spindle/contact pose、tangent frame、relative point velocity、free response packet、exactly-one normal authority |
| K&C/suspension | `chassis_suspension_reference.py`；unified fixture geometry/residual | [suspension.js](../src/vehicle-v24/suspension.js)、[math.js](../src/vehicle-v24/math.js) | 所选 backend 的 exact map derivative、SO(3) Jacobian、Jq̇、spring/damper/ARB、load-only compliance 和 CONTACT/AIRBORNE 方程；选择见 D-04/D-05 |
| Steering/JᵀW | `steering_reference_v2.py`；`steering_transaction.py` | [steering.js](../src/vehicle-v24/steering.js)、[runtime.js](../src/vehicle-v24/runtime.js) | 所选 causality 与 frozen owner trial；Final WheelPose spatial Jacobian 对完整 contact wrench 投影一次，不能重复计算 pneumatic trail |
| Engine | `engine_model.py` | [powertrain.js](../src/vehicle-v24/powertrain.js) | Asset torque semantics、valid domain、finite authority、modes、frozen evaluate/commit；clutch reaction 回到同一 engine residual |
| Clutch/gearbox/open diff | `powertrain_controller.py`；coupled residual | [powertrain.js](../src/vehicle-v24/powertrain.js) | Signed ratio/Neutral、speed-torque 对偶映射、独立 wheel omega、finite lock/slip candidate；不添加 standalone 未接受的 LSD/locked diff 作为替代 |
| Brake/ABS/TCS/ESC/FSM | `vehicle_controls_reference.py`；unified fixture brake active rows、`step_driver` | [powertrain.js](../src/vehicle-v24/powertrain.js)、[runtime.js](../src/vehicle-v24/runtime.js) | Service authority arbitration、ABS 调制 service channel、parking 独立；actual reaction 由 solve 决定；FSM 与 transaction 同成败 |
| Low-speed contact | Tire v1.7 friction-contact active set；`tire_host_contract.py` | [tire.js](../src/vehicle-v24/tire.js)、[rapier-host-adapter.js](../src/vehicle-v24/rapier-host-adapter.js) | Host free velocity/Delassus、stick/slide capacity、handling/reaction 互斥；不能以 epsilon slip 或 fake brake 代替 |
| Aero | `aero_reference_v1_9.py`；unified fixture reference-point flow/platform closure | [aero.js](../src/vehicle-v24/aero.js)、[runtime.js](../src/vehicle-v24/runtime.js)、[config.js](../src/config.js) | 相对风、ω×r、signed six coefficients、reference→CG shift、domain/footprint、一次施力；production asset/fallback 见 D-08/D-10 |
| Transaction/rollback | Unified 五 owner；Engine/Gearbox/Steering transaction owners | [contract.js](../src/vehicle-v24/contract.js)、[runtime.js](../src/vehicle-v24/runtime.js)、[rapier-host-adapter.js](../src/vehicle-v24/rapier-host-adapter.js) | Frozen trials、全 owner preflight、exactly-once、group rollback；host 使用可证明的 snapshot/delta 回撤 |
| Oracle/golden/validation | `run_v2_4_validation.py`；`run_v2_4_maneuver_matrix.py`；`asset_pipeline.py`；`calibration.py`；manifests | [exporter](../scripts/export-vehicle-v24-oracle.py)、[golden](../data/vehicle-v24-golden.json)、[v24 gate](../scripts/test-vehicle-v24.mjs)、[validation.js](../src/validation.js) | 完整 state/residual/active-set/energy/transaction/maneuver parity；生产 mode 验证；Parameter/Dataset Passport 与 target SKIP 不混淆 |

## 11. 分阶段影响范围与验收门

以下阶段是建议路线，不授权编辑，也不预先决定 D-01 至 D-14。阶段开始前必须列出相关 `UNDECIDED` 依赖；没有决定时可继续独立的 oracle/contract 工作，不得静默缩减范围。

| 阶段 | 建议文件影响范围 | 依赖 | 验收门 |
|---|---|---|---|
| P0 规范/决策登记 | `AGENTS.md`、本文、`PROJECT_MAP.md`、`TESTING_AND_COMPLETION.md`、contract schema | 无 | 强制 baseline、backend 决策、XFAIL/SKIP 和 host ownership 明确；未决定事项保持 UNDECIDED |
| P1 Oracle 完整化 | `scripts/export-vehicle-v24-oracle.py`、golden/fixtures、v24 differential tests | P0 | Python component/coupled state、residual、active set、energy、errors、rollback 均可逐步比较；不只比最终车速 |
| P2 Host/transaction | `contract.js`、`rapier-host-adapter.js`、`runtime.js` | P0–P1 | Pre/post-commit fault 后所有 owner 与 host force/torque 增量精确恢复；不破坏其他 writer |
| P3 Coupled core | 建议新 `coupled-solver.js`、`math.js`、`runtime.js` | P1–P2 | 同一 candidate 闭合 engine/wheels/clutch/contact/chassis reaction；scaled residual、capacity、complementarity、dissipation；无 canonical inner writes |
| P4 Tire/contact | `tire.js`、host packet、Tire fixtures | P3；D-02/D-05/D-06/D-07 | Accepted v1.7/v1.8 parity；AIRBORNE clear；R_eff 对偶一致；handling/low-speed 互斥与 timestep refinement |
| P5 K&C/Steering | `suspension.js`、`steering.js`、math/map assets | P3–P4；D-03/D-04/D-05 | 所选 backend map/Jacobian/SO(3)/ARB/AIRBORNE parity；完整 spatial JᵀW 虚功测试 |
| P6 Powertrain/brakes | `powertrain.js`（可按 owner 拆分）、coupled rows、tests | P3–P5；D-01/D-09 | Engine/clutch/open diff/brake 同解；finite authority；Neutral/换向/FSM/ABS/TCS/ESC parity |
| P7 Aero/data | `aero.js`、`config.js`、versioned assets/passports | P3、P5；D-08/D-10/D-14 | 6D wrench、domain、reference shift、风速/地面输入、一次施力；真实数据缺失继续 SKIP |
| P8 Production wiring | `main.js`、`vehicle.js`、`validation.js/html`、telemetry consumers | P2–P7；D-11/D-12 | main/validation mode 显式一致；legacy/shadow/active 隔离；host failure 可见；HUD/audio/camera/timing 只读 |
| P9 Release validation | v24 suites、33 maneuvers、browser gate、determinism/performance | P8；D-13/D-14 | 零 unexpected FAIL；XFAIL/SKIP 精确；numerical 与 60/120/240 Hz refinement 独立；版本/hash 可复现；不把 target SKIP 写成 PASS |

具体测试与完成定义见 [TESTING_AND_COMPLETION.md](TESTING_AND_COMPLETION.md)。生产运行链见 [PROJECT_MAP.md](PROJECT_MAP.md)。

## 12. StreetRush 强制降档超转策略（2026-09-09）

用户明确要求允许高速连续手动降档，即使故意造成机械超转也应继续游戏。运行时因此显式启用 `allowMechanicalOverrev`：超过现有 engine hard domain 时，继续使用独立曲轴/车轮状态与有限离合器冲量；现有扭矩曲线在该范围提供零燃烧扭矩，保留有限倒拖阻力。不拒绝降档、不钳制转速，也不以强制打开离合器规避超转；本次未新增发动机损坏模型。

这是超出标定域的游戏行为扩展，不代表 v2.4 reference 接受域外运行或目标车辆的真实超转行为。组件 `prepareEngineClutchTrial` 默认仍保留原 hard-domain 异常，游戏运行时显式选择扩展，并通过 `engineDomainStatus: MECHANICAL_OVERRUN_EXTENSION` 暴露域外状态。非有限状态和其他真实物理异常仍走事务回滚；界面提供可重新开始的暂停菜单。

验收：`scripts/test-vehicle-v24-downshift.mjs` 在六车型实际 Rapier 运行链中自然加速后连续降至一档，确认实际转速越过旧阈值后仍持续提交物理步，且后续升档和切回自动正常。这是合成平地场景的行为回归，不替代整套 reference parity 或目标车辆标定。

## 13. Rapier 接地点与车轮自转反作用修正（2026-09-09）

为处理用户正常游戏记录中的高速制动失控，当前宿主在接地点已经施加完整 road wrench 的前提下，将附加 wheel spin reaction 改为驱动、实际制动和轮胎接触净力矩的反作用；离地时仍保留非接触驱动/制动反作用。此项明确修正当前 aggregate Rapier body / independent wheel spin 的记账，不宣称与 reduced quasi-static reference 的平台载荷结果等价，不决定任何 backend `UNDECIDED` 项，也不修改上述历史审计矩阵的完整性裁决。范围、回归测试调整、正常游戏对照和未验收项见 [修复记录](verification/WHEEL_SPIN_REACTION_20260909.md)。
