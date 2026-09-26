# Runtime architecture

一个成功 substep 的主动数据流如下：

```text
Driver/Environment command
  → Gearbox + Steering + Engine trial snapshots
  → candidate mechanical state
  → K&C final spindle pose and derivatives
  → contact point / normal / tangent frame / point-relative velocity
  → exactly one normal authority
      ├─ mapped massless: CONTACT gap + candidate Fz / AIRBORNE Fz=0
      └─ dynamic unsprung: compliant TireVerticalLaw
  → accepted Tire v1.7/v1.8 wrench
  → suspension/steering JᵀW + chassis force/moment rows
  → Aero reference-point relative flow and 6D wrench
  → clutch/brake/contact active-set rows
  → residual gate + capacity/domain/invariant checks
  → five-owner preflight
  → group commit, or complete snapshot rollback
```

## 关键所有权

- Rigid Body/Mechanical owner：chassis state、wheel omega、suspension terminal state。
- Steering owner：rack/control/FFB canonical state；不直接制造 lateral force。
- Tire owner：patch transient state与constitutive wrench；不写 geometry 或 normal solution。
- Gearbox owner：gear/shift phase；不把 Engine RPM 传送到新齿比。
- Engine owner：engine state/control trial；不直接写 wheel speed。
- Aero 没有内部动态 canonical state；每次 residual evaluation 都从同一 candidate 纯求值。

## 接触 frame

Standalone host 明确使用 reduced flat-road normal `n=[0,0,1]`。最终 spindle forward 投影到接触平面得到 `t_x`，`t_y=n×t_x`；退化时只允许使用 wheel axle 的几何 fallback，否则拒绝。Tire 的 `Fx/Fy/Fz/Mx/My/Mz` 由该 contact frame 变换到 body frame；brake reaction 仍沿物理 spindle axle，因此两种 frame 不混用。

Contact-point velocity 包含 chassis COM velocity、body `ω×r`、K&C `qdot`、rack rate、compliance toe rate、spindle rotation 对 radius offset 的贡献，并扣除 ground-point velocity。

Mapped CONTACT 的 `qdot` 由同一步 normal velocity equation `n·(v_base + J_p qdot)=0` 求得；normal path Jacobian 接近奇异时显式拒绝。Mapped AIRBORNE 不使用该约束，而以 `(q_{n+1}-q_n)/dt` 进入 spring/damper/ARB 的 massless Backward-Euler 平衡，road reaction 严格为零。

平台求解向量直接使用 Aero asset 声明的 `hF/roll/hR`；heave/pitch 只是从两端 ride height 换算的输出。这样所有 accepted candidate 都在 Aero 数据域内，不再使用基准中不存在的硬编码 pitch box。

## 求解与事务

每个 nonlinear candidate 都从 frozen owner snapshot 重算。root 与 bounded least-squares 共享显式 aggregate evaluation budget；返回值保存 residual 分量、行标签、solver method/status/message/attempt history。CONTACT 的 gap 行以米缩放，AIRBORNE 的 zero-reaction 行以牛顿缩放，每次 mode 切换都会重建 labels/scales。任何 domain、capacity、mode、normal inequality 或 residual gate 失败都不能 commit。

离合、四轮制动和四角 normal contact 都有有限模式 active set。无界 LOCKED 离合若需要超过容量的 reaction，会切换到 signed slip mode 后重新求解；不会把有界 least-squares 的折中残差当作可接受锁止。

成功前先验证五个 candidate。若任一 owner 在 commit 后抛错，coordinator 会对所有参与 owner 恢复同一组 substep snapshots；审计将 `rolled_back` 与普通 `aborted` 分开记录。
