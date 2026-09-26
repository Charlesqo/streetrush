# Vehicle Physics implementation close-out v2.2 (historical record)

> v2.4 notice: this file preserves the earlier v2.2 claim set. Its pass counts,
> missing `results/`/`reference_regressions/`, and Tire path description are not
> current validation evidence. See `../docs/VALIDATION.md` and the active imports
> in `unified_vehicle_fixture.py`.

## Final decision

| Claim | Decision | Evidence boundary |
|---|---|---|
| v2.1 Engine/powertrain close-out | Retained | Baseline ZIP SHA-256 `9dc94047d983fe04e49b0f6cab6bcfe480b88bcb91828a1ef95716225634432f`; fresh v2.1 rerun: 68 tests, 0 unexpected failure, 1 skip, 1 expected failure. |
| Current accepted subsystems in one executable reference fixture | PASS | `UnifiedVehicleFixture`; both suspension backends; dynamic and failure/refinement evidence. |
| Reduced-planar reference executable close-out | PASS | Generated `results/vehicle_physics_v2_2_final_closeout_results.json`. |
| Whole-vehicle 6DOF/game-host executable close-out | NOT ACHIEVED | `SKIP_RAPIER_6DOF_HOST`; no host files are present. |
| Target-vehicle validated/correlated model | NOT ACHIEVED | `SKIP_TARGET_VEHICLE_DATA`; only declared synthetic fixtures are available. |

这里的最终判断是刻意分层的。当前可用代码已经完成 reference 层面的真实接线；但不能把 reduced-planar fixture 改名成 whole vehicle，也不能用 synthetic 参数冒充实车标定。

## v2.1 gap audit

逐调用链检查确认，历史 `integrated_closeout.py` 有三个主要局限：

1. 它 import 和执行的是 Tire v1.7；没有完整 final `ContactInput/TireState/TireOutput`、独立 camber transient、low-speed deformation 和 airborne lifecycle。
2. normal load 是 static/base axle load、longitudinal transfer 和 `jacking_coeff * Fx`；虽然包内有 K&C reference，却没有调用 K&C map、derivatives、spring length、damper length、ARB coordinate 或 compliance policy。
3. 没有 Steering owner、rack/Ackermann、横向车身状态或 Tire Mz 到 steering-axis reaction 的链路。整车验证只是单步直线 reduced fixture。

Aero v1.9 的部分接入是真实的，但旧 fixture 只消费 `Fx/Fz/My`，未将 `Fy/Mx/Mz` 送入动态车身。

因此 v2.1 的 Engine/powertrain 结论有效，旧 integrated fixture 的“accepted subsystems packaged and executed”措辞则过宽。v2.2 文档和 manifest 已把它降为 historical longitudinal fixture。

## Implemented cross-system closure

### Steering and Tire Mz

- `steering_reference_v2.py` 是已验收 Steering implementation 的逐字节 copy。
- `steering_transaction.py` 将原 standalone mutable state 包成 immutable snapshot trial。
- driver input、rack actuator、Ackermann wheel angles 每 substep 只推进一次。
- K&C 拥有 bump/toe increment；Steering helper 的简化 bump steer 被关闭，避免双计数。
- final Tire 的 intrinsic `Mz` 进入 chassis yaw moment 一次，同时作为 Steering reaction 的 intrinsic load 输入一次。Steering mechanical trail/scrub 是独立力臂，不重新计算 pneumatic trail。
- accepted root 后才执行 FFB filter trial，并与其他 owner 一起 preflight/commit。

### K&C, spring/damper, ARB and compliance

每个 corner 的终态迭代实际调用：

- `KCRuntimeMap.evaluate(q, steer, policy="reject")`；
- `KCRuntimeMap.derivative_q(...)`；
- wheel-center path、camber、toe 和 SO(3) orientation Jacobian；
- spring/damper length 及其 q derivative；
- accepted `LinearARB.generalized()` 和 `LinearARB.energy()`，输入为 K&C `arb_coord`；
- accepted `additive_compliance_model(q, Fy, Mz)`。

contact generalized force 由 `dp/dq · F + omegaJacobian · M` 形成。这样 longitudinal/lateral jacking 和 Tire moments 来自 K&C virtual work，不再使用 scalar `jacking_coeff` 代替。

两种实际 normal authority：

- `MAPPED_KC_MASSLESS`：rigid-normal adapter 提供 solved Fz，rigid road geometry 与 massless generalized equilibrium 同时求解。
- `DYNAMIC_UNSPRUNG`：compliant-tire-vertical adapter 只接收 terminal compression/rate；q backward-Euler kinematics 和 unsprung generalized dynamics同时求解。

adapter 会拒绝 rigid Fz/impulse 与 compliant compression 同时激活。

### Tire V2 final

`tire_v2_final/` 从当前已验收完整 Tire V2 reference vendored，runner 会比较 upstream/vendored SHA-256。统一 fixture 只调用这一 final path，不再调用 v1.7 handling wrapper。

每次 nonlinear evaluation 都从同一个 canonical `TireState` 计算 trial output；只有 accepted root 的 `state_next` 可以 commit。输出包含 `Fx/Fy/Fz/Mx/My/Mz`、effective radius、wheel torque、slip observables、pneumatic trail、contact power 和独立 camber state。

### Aero and planar host

- 终态 body-relative air velocity包含 longitudinal/lateral velocity和 wind。
- Aero beta、front/rear platform height严格执行 map domain；reverse flow 明确拒绝。
- 计算完整 `[Fx,Fy,Fz,Mx,My,Mz]`，并用 `shift_wrench` 从 dataset reference point 移到 CG。
- reduced host 动态积分 body `u/v/yaw rate` 和 world `x/y/yaw`；vertical/roll/pitch 是 quasi-static platform balance，不冒充 6DOF host。

### Atomic state ownership

每个 substep 的 owner 集合固定为：

```text
EngineOwner
GearboxOwner
SteeringOwner
TireOwner
MechanicalOwner
```

工作顺序：所有 owner begin；非线性求解中只 pure-evaluate frozen trial；accepted root 重新计算所有输出；构造并验证完整 candidate state；五 owner 全部 preflight；随后每个 owner commit 恰好一次。任一 domain/solver/preflight failure 都 abort 所有已打开 ticket，并保持原 state object identity。

## Executable verification

最终 runner 的固定验证集合不是为了堆数量，而是分别覆盖不同闭环：

- both-backend step steer：横向/yaw/Steering-Mz 主闭环；
- sine weave：stateful direction reversal；
- brake-in-turn split-μ：combined slip、wheel dynamics 和 cross-corner load；
- single-wheel road input：K&C/damper/ARB/explicit-unsprung path；
- 3 m/s case：final Tire low-speed path；
- 60/120/240/480 Hz：timestep convergence；
- 45/120 max function evaluations：iteration refinement；
- Aero beta/K&C steer domain：all-owner abort and state identity preservation；
- Tire-road/Aero-air equal-and-opposite forces、damper non-negative dissipation、ARB energy、deterministic replay；
- fresh package and existing subsystem regressions。

当前生成证据的关键结果：

- 两种 step-steer backend 均 PASS，峰值 scaled residual 小于 `2.1e-10`；
- 60→120、120→240、240→480 Hz 的 terminal world-y 差依次减小；terminal yaw 差也依次减小；
- 45 和 120 evaluation limits 的接受终态逐字段一致到 `1e-12` 门限；
- Aero beta 与 K&C steer 域外测试均保持五个 canonical owner object identity，commit 数为 0；
- 既有 subsystem regression 保持原测试集合：Steering 13、Chassis/Suspension 16、Tire V2 final 20。

具体数值以重新生成的 JSON 为准，不以本文静态摘录代替运行结果。

## Explicit skips

- `SKIP_RAPIER_6DOF_HOST`：没有 game/Rapier host，无法验证 SE(3) entity/component application、真实 ground entity reaction 或 host scheduler/substep integration。
- `SKIP_TARGET_VEHICLE_DATA`：缺少目标 Engine/start-stall、coastdown、Flat-Trac/TIR、K&C、aero、hardpoints/springs/ARB/compliance、EPS/rack 和 ISO maneuver 数据。
- `SKIP_REVERSE_QSS_AERO`：Aero v1.9 明确只支持 forward relative flow，且没有已验收 fallback backend。
- `SKIP_GLOBAL_TIRE_PASSIVITY_PROOF`：final Tire reference 的 sample closed-cycle 检查不是全域 potential/passivity 数学证明。

这些项不是用新 surrogate 填上的隐藏缺口；它们在 machine-readable close-out result 中保持 SKIP/NOT ACHIEVED。
