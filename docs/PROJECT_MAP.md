# StreetRush Project Map

> 审计快照：2026-08-31。本文记录当时的 current working tree，而非默认分支旧版本。并行任务可能继续修改代码；路径、模式和行号应在下一次实现审计时刷新。

## 1. 文档角色

- [VEHICLE_PHYSICS_BASELINE.md](VEHICLE_PHYSICS_BASELINE.md)：规范、当前实现裁决、host boundary、全部 `UNDECIDED` 项。
- [TESTING_AND_COMPLETION.md](TESTING_AND_COMPLETION.md)：状态定义、测试门、完成条件和审计快照结果。
- [../AGENTS.md](../AGENTS.md)：供后续代理快速读取的最小规则集。

## 2. 生产运行链

```text
index.html
  └─ dynamic import /src/main.js
      ├─ initializeRapier() → RAPIER.World(gravity, FIXED_DT)
      ├─ InputController
      │   └─ keyboard / touch / gamepad / fixed pulses
      ├─ PhysicsScheduler.advance(frameDt)
      │   └─ 0..N × fixedUpdate(1/120 s)
      └─ VehicleSystem(vehiclePhysicsMode = "v24-active" in audit snapshot)
          ├─ VehicleV24Runtime.step()
          │   ├─ snapshot Rapier body state
          │   ├─ query wheel contacts and ground-point velocity
          │   ├─ Steering / suspension / contact-frame preparation
          │   ├─ gearbox / assists / engine-clutch preparation
          │   ├─ Tire and low-speed contact response
          │   ├─ Aero and contact wrench batch
          │   └─ owner transaction commit → Rapier force/torque writes
          ├─ physicsWorld.step()
          └─ VehicleSystem.afterPhysics()
              ├─ pose snapshot and visual interpolation
              ├─ race timing / checkpoints / track limits
              ├─ HUD telemetry
              ├─ TireEffects
              ├─ ProceduralAudio
              └─ ChaseCamera / render
```

## 3. 入口与责任文件

| 层 | 主要文件 | 审计快照中的责任 |
|---|---|---|
| 页面入口 | `index.html` | Canvas、HUD、移动输入、动态加载 `src/main.js` |
| App 装配 | `src/main.js` | 初始化 Rapier、Track、Input、Vehicle、Audio、Effects、Camera、Timing、scheduler；生产构造时请求 `v24-active` |
| 输入 | `src/input.js` | 键盘、触摸、gamepad、方向意图与 fixed-pulse 排队 |
| 调度 | `src/physics-scheduling.js`、`src/physics-scheduler-owner.js` | 120 Hz fixed-step 计划；WASM/JS scheduler ownership |
| Vehicle façade | `src/vehicle.js` | 创建 Rapier body/wheels；分发 `legacy`、`v24-shadow`、`v24-active`；同步 telemetry/visual pose |
| v2.4 runtime | `src/vehicle-v24/runtime.js` | owner transaction、substep orchestration、solver report、wrench batch |
| v2.4 components | `src/vehicle-v24/{tire,suspension,steering,powertrain,aero}.js` | 各子系统算法与 trial/output |
| Contract | `src/vehicle-v24/contract.js` | 五 owner state、preflight、commit、abort、rollback |
| Rapier host | `src/vehicle-v24/rapier-host-adapter.js` | Body snapshot、scene query、contact frame、Delassus、world wrench/application reaction |
| World | `src/rapier-init.js`、Rapier world | Chassis 6DOF、碰撞世界、质量/惯量、世界积分 |
| 消费者 | `src/effects.js`、`src/audio.js`、`src/race-timing.js`、HUD/camera code | 只读消费 committed telemetry；不得成为 physics state owner |
| Validation | `validation.html`、`src/validation.js` | 审计快照中未显式选择 v24，因默认值而走 legacy；不能作为 v24 production validation |

## 4. Fixed-step 时序

一次物理子步的宿主顺序为：

1. 处理 reset/countdown 和固定步输入。
2. `VehicleSystem.fixedUpdate()`。
3. `physicsWorld.step()`。
4. `VehicleSystem.afterPhysics()`。
5. Race timing、track-limit、checkpoint 更新。
6. 消费本步脉冲。

渲染帧随后依据 scheduler alpha 同步 visual、camera、effects、audio、HUD 并绘制。任何车辆 solver 不得在 nonlinear candidate 迭代中交替写 Rapier canonical state 再读回。

## 5. Ownership 地图

| 状态/作用 | Owner | 允许的其他参与者 |
|---|---|---|
| Chassis pose、linear/angular velocity、world collision | Rapier | Vehicle solver 读取 snapshot 并提交一次 world wrench |
| Engine state | Engine owner | Coupled solver 只计算 accepted candidate |
| Gearbox/FSM state | Gearbox owner | Driver/input 只提供 command intent |
| Steering state | Steering owner | Tire/contact wrench 通过唯一 `JᵀW` reaction 进入 |
| Tire patch/transient state | Tire owner | Suspension/host 提供 final contact packet |
| Wheel omega、effective radius、suspension mechanical state | Mechanical owner | Coupled solver 计算 accepted next state |
| ABS/TCS/ESC | Actuator authority | 只改变 request/capacity，不写 wheel/body/yaw state |
| HUD/audio/effects/camera/timing | 无物理 ownership | 只读 committed output |

## 6. 当前模式不等于完成状态

审计快照确认 `main.js` 请求 `v24-active`，active abort 不自动退回 legacy，Rapier host 和低速 Delassus 已进入生产调用。但当前实现仍是分阶段/局部迭代：几何和悬架迭代、powertrain preparation、逐轮 Tire solve、制动 active set 分开进行。它不是 standalone reference 的同一 whole-vehicle residual/candidate solve。

因此：

- “生产调用 v24”是接线事实。
- “240 个现有门禁检查通过”是当前合同事实。
- “完整保持 v2.0/v2.4”仍是未完成目标。

完整裁决见 [VEHICLE_PHYSICS_BASELINE.md](VEHICLE_PHYSICS_BASELINE.md#7-当前-streetrush-审计矩阵)。

## 7. Rapier host boundary

StreetRush host 应提供：

- Scene query、contact point/normal/separation/material。
- Moving/rotating ground 的 contact-point velocity。
- Low-speed free contact velocity 和 Delassus/effective-mass response。
- Chassis 6DOF、完整 mass/inertia。
- World wind、track ground/kerb/footprint 信息。
- 对 chassis 和 dynamic ground 的一次性 action/reaction wrench application。
- Fixed substep scheduling。

Vehicle reference 提供 constitutive/constraint solve，不拥有 Rapier 世界。Vehicle internal coupled solver 与 Rapier world 是明确的 operator split，不能称为全世界 monolithic solver。

## 8. 刷新规则

下列事件发生后刷新本文：

- `main.js` 的 physics mode 或 scheduler 顺序改变。
- Vehicle/Rapier ownership 改变。
- Validation 页面切换 physics mode。
- v24 component 拆分、重命名或新增 production asset path。
- 任何 `UNDECIDED` backend 被用户正式决定。
