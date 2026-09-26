# StreetRush Testing and Completion

> 审计快照：2026-08-31。测试结果是当时 current working tree 的记录；并行实现后必须刷新。本文没有在文档创建任务中重新运行大型测试。

## 1. 状态定义

| 状态 | 含义 |
|---|---|
| `PASS` | 测试声明的合同在当前支持域内满足 |
| `PARTIAL` | 有有效实现或证据，但未覆盖完整权威合同 |
| `FAIL` | 应成立的合同不成立；release blocker |
| `XFAIL_EXPECTED` | 有名称、有理由的 accepted limitation 或 negative control；XPASS 也需审查 |
| `SKIP_TARGET_DATA` | 必需的真实目标 fixture 不存在，当前不能评价 target fidelity |
| `NOT_RUN` | 没有取得运行结果 |
| `BLOCKED_TOOL` | `NOT_RUN` 的补充原因；工具/环境受阻，不会把结果变成 PASS |
| `UNDECIDED` | 需要用户/项目作出的路线、模式、baseline 或数据范围决定 |

“代码存在”“被 import”“生产调用”“selected golden PASS”“完整 v2.4 PASS”是五种不同证据，不得互相替代。

## 2. 分层验收门

### L0 — Schema、坐标与 ownership

- 输入、输出、owner state、finite 值、单位和 frame contract。
- 每个 semantic physical state exactly one owner。
- Legacy/shadow/active force authority 互斥。

### L1 — Component reference parity

- Tire、K&C、Steering、Engine、clutch/gearbox/open diff、brakes/assists、Aero。
- 对比 state、wrench/impulse、active mode、domain/error semantics，而不只对比最终车速。

### L2 — Constraint 与 transaction invariants

- Capacity、complementarity、dissipation、energy ledger、scaled residual。
- Frozen trial、preflight、exactly-once commit、abort、post-commit group rollback。
- Host rollback 必须恢复自己的增量，不能误删其他 force writer。

### L3 — Coupled synthetic maneuvers

- Engine—clutch—wheels—Tire/contact—chassis 同一步闭合。
- 60/120/240 Hz refinement。
- Straight、service/parking brake、direction change、steering、split-μ、airborne、one-wheel step、open diff。

### L4 — Target measured validation

- Hardpoint/K&C、Tire rig、dyno、Aero/coastdown、lateral transient、标准 maneuvers。
- 数据缺失必须 `SKIP_TARGET_DATA`；synthetic PASS 不得改写为 target PASS。

### L5 — Production validation

- `main.js` 和 validation 页面显式运行预期 mode。
- Browser/Rapier scene、动态地面、HUD/audio/camera/race timing 不破坏 physics ownership。
- Determinism、性能、长时间稳定、failure visibility、无 legacy double-force path。

## 3. v2.4 完成定义

只有同时满足以下条件，StreetRush 才能称为 v2.4-complete：

1. v2.0 强制 baseline 全部有实现和验收证据。
2. 每个可选/互斥 backend 有用户或项目的显式决定，且未选方案不会被误报为支持。
3. 所选 backend 的 v2.4 accepted equations、state、active modes、domain、transaction semantics 有 JS/Rapier differential coverage。
4. Same-step whole-vehicle coupled solve 存在；不是分阶段结果的 residual 汇总。
5. Rapier host boundary完整接入，且 candidate solve 中不写 canonical world state。
6. Production 和 production-validation 使用声明的同一 mode；legacy/shadow 单独隔离。
7. 零个 unexpected FAIL；每个 XFAIL/SKIP 有理由、影响和解除路径。
8. Numerical convergence 与 timestep convergence 分别通过。
9. Golden、config、data、code hash 和 seed/run manifest 可复现。
10. 任何 synthetic、estimated 或 fallback asset 都没有被称为目标车辆验证。

## 4. 必须维护的测试面

### v24 主门禁

```text
node scripts/test-vehicle-v24.mjs
node scripts/test-vehicle-v24-contract.mjs
node scripts/test-vehicle-v24-golden.mjs
node scripts/test-vehicle-v24-host.mjs
node scripts/test-vehicle-v24-runtime.mjs
node scripts/test-vehicle-v24-legacy-isolation.mjs
node scripts/test-vehicle-v24-determinism.mjs
node scripts/test-vehicle-v24-performance.mjs
```

### Vehicle/host/regression

```text
node scripts/test-vehicle-braking.mjs
node scripts/smoke-physics.mjs
node scripts/regression-physics.mjs
node scripts/test-surface-stability.mjs
node scripts/test-vehicle-direction-change.mjs
node scripts/test-vehicle-reset.mjs
node scripts/test-vehicle-determinism.mjs
```

### Scheduler/input/timing/audio

```text
node scripts/test-physics-scheduling.mjs
node scripts/test-physics-scheduler-owner.mjs
node scripts/test-input.mjs
node scripts/test-race-timing.mjs
node scripts/test-audio-context.mjs
node scripts/test-audio-pause.mjs
```

### Python reference/oracle

- 使用 standalone 声明的 Python/NumPy/SciPy/pytest 环境。
- 运行 package validation、upstream references 和 33-case maneuver matrix。
- Oracle exporter 只生成 versioned JSON/golden，不进入 browser runtime。
- 如果环境缺失，标 `NOT_RUN / BLOCKED_TOOL`，不要临时改 reference 或降低测试面。

## 5. 2026-08-31 recorded results

这些结果来自此前只读审计；本次文档创建没有重新运行它们。

| 门禁 | Recorded result |
|---|---|
| `scripts/test-vehicle-v24.mjs` | `PASS`：7 suites、240 checks |
| Contract | `PASS`：17 checks |
| Golden parity | `PASS`：29 checks；只证明当前 selected oracle 面 |
| Rapier host | `PASS`：53 checks |
| Runtime | `PASS`：102 checks |
| Legacy isolation | `PASS`：30 checks |
| v24 determinism | `PASS`：720 steps/run；recorded SHA-256 `c632cc5a8a3bb0e58ba0a465f8b1fde12ed4dd487dbf39f3b570cd1ab43a3ffb` |
| v24 performance | `PASS`：120 Hz；p95 约 3.729 ms，p99 约 5.160 ms，无 overrun |
| Braking/smoke/regression/surface/direction/reset | Recorded `PASS` |
| Scheduler/input/race timing/audio | Recorded `PASS` |
| Legacy vehicle determinism | `FAIL`：`vehicle replay baseline changed`；处置 `UNDECIDED` |
| Standalone manifest | Recorded：99 package tests（1 skip、1 expected failure）；109 upstream passed（2 skip、2 xfail）；31 maneuver PASS、2 expected host boundary、0 FAIL |
| Standalone 本轮复跑 | `NOT_RUN / BLOCKED_TOOL`：当时本机缺 pytest/SciPy |
| Live browser v24 production validation | `NOT_RUN` |

现有 v24 gate 是重要证据，但它不能把 [VEHICLE_PHYSICS_BASELINE.md](VEHICLE_PHYSICS_BASELINE.md#7-当前-streetrush-审计矩阵) 中的 coupled solver、spatial `JᵀW` 或 production-validation 缺口改写成 PASS。

## 6. Expected XFAIL/SKIP 记账

### `XFAIL_EXPECTED`

- Additive K&C combined-load cross term。
- Tire standstill bore / parking turn-slip。
- Naive RPM clamp conservation negative control。
- Training-fit-only validation negative control。

### `SKIP_TARGET_DATA`

- Target hardpoint/Chrono、TIR/Flat-Trac、engine dyno/start-stall。
- Aeromap/coastdown/anemometry、ISO lateral transient、真实 mass/COM/inertia/damper/K&C。

任何 XFAIL 意外通过都要审查；任何 SKIP 被解除都必须附 dataset passport、source hash、domain 和 hold-out gate。

## 7. Golden 与 baseline 规则

- 不能仅因 hash 变化就重录 baseline。
- 重录前必须说明：物理语义是否改变、owner/coordinate/domain 是否改变、预期影响哪些 maneuvers。
- Legacy determinism 当前为 `FAIL`，处理方式见 baseline 的 `D-13`，状态仍 `UNDECIDED`。
- Python oracle、JS golden 和 production telemetry 必须有版本/schema/hash 关联。
- Golden 通过不等于 production mode 正确，也不等于目标车辆数据通过。

## 8. 每阶段完成报告模板

每个实施阶段至少报告：

```text
Scope:
Authoritative Python files/symbols:
JS/Rapier files changed:
Selected backend decision ID:
State/owner changes:
Oracle/golden changes:
Commands run:
PASS:
PARTIAL:
FAIL:
XFAIL_EXPECTED:
SKIP_TARGET_DATA:
NOT_RUN / BLOCKED_TOOL:
Performance/determinism impact:
Remaining blockers:
```

未引用显式 decision ID 的 backend 改动不得视为完成。
