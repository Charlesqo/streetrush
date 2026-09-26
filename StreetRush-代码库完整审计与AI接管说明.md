# StreetRush 完整代码审计与 AI 接管说明（自包含版）

> 日期：2026-08-25  
> 用途：把本文件单独交给另一个 AI，即使它无法访问原仓库，也能理解项目现状、关键代码、主要问题和后续处理方式。  
> 约束：本文不要求读者再打开任何其他文件。文中出现的模块名只用于说明代码来源；所有关键判断都附有必要的原代码摘录或等价结构。

---

## 1. 最短结论

StreetRush 当前不是“基本完成、只剩一些 bug 的赛车游戏”。

它是一个很薄的浏览器赛车原型，外围叠加了大量输入兼容、资产修补、候选音频、遥测、测试、文档以及 JS/Rust/WASM 多套实现。工程体量已经远大于实际游戏内容，形成了典型的 AI 生成式代码堆积。

项目真正拥有的是：

- Three.js 场景与 Rapier 刚体世界；
- 一条平面闭环样条赛道；
- 一个通用车辆刚体、四轮射线悬挂和简化轮胎模型；
- 六套主要依靠标量参数区分的车辆配置；
- 车库、倒计时、三圈、检查点、PB、暂停、重开等流程代码；
- 键盘、手柄、触控输入；
- 程序化音频和六套候选循环音频；
- 大量验证这些内部实现彼此一致的脚本。

项目没有建立的是：

- 一辆经过真实驾驶打磨、可以代表产品质量的主车；
- 一套资产正确、轮组正确、碰撞正确的稳定车辆生产管线；
- 经过人工证明的赛道可读性、相机、速度感和音频质量；
- 与工程体量匹配的游戏内容；
- 一个简单、单一 owner、容易继续开发的架构。

因此不建议继续 Vehicle V2，也不建议围绕现有六车逐个修 bug。建议冻结扩张，从“一辆车、一条赛道、键盘、完整跑圈”重新建立最小产品基线。

---

## 2. 证据类型

本文把信息分为三类：

- **代码事实**：来自实际生产代码、测试配置或当前 Git 状态。
- **工程判断**：基于代码职责、依赖和重复实现得出的结论。
- **处理建议**：后续方案，不表示已经实施。

任何“已接入”“生产 owner”“验证通过”“可发布”之类的说法，都不能只根据文档、dataset 标记或测试名字判断，必须看生产控制流实际调用了什么。

---

## 3. 代码体量

当前项目主要体量约为：

| 类别 | 文件数 | 行数 |
| --- | ---: | ---: |
| 生产 JavaScript | 28 | 7,820 |
| 测试脚本 | 43 | 7,137 |
| 全部工具/测试脚本 | 59 | 9,322 |
| Rust | 6 | 1,156 |
| 自述文档 | 11 | 2,030 |

最大的生产模块分别约有：

- 主入口与全局控制：1,258 行；
- 车辆系统：738 行；
- 比赛计时：701 行；
- 赛道系统：686 行；
- 资产系统：573 行；
- 输入系统：481 行；
- 音频系统：451 行。

测试脚本行数几乎等于生产 JavaScript，全部脚本已经超过生产 JavaScript。这些数字不能证明游戏成熟，只能证明项目在工程外围投入了大量代码。

---

## 4. 当前运行结构

项目的真实控制关系可以概括为：

```text
HTML 页面
  └─ 单一主入口（事实上的 God Module）
      ├─ Three.js renderer / scene / camera / lights
      ├─ Rapier physics world
      ├─ TrackSystem
      │   ├─ spline / nearest point / surface
      │   ├─ road / kerb / barrier / signs / furniture
      │   └─ ground + barrier colliders
      ├─ AssetManager
      │   ├─ GLB load/cache/preload/dispose
      │   ├─ runtime normalization/batching
      │   └─ wheel manifest / geometry split / generated wheels
      ├─ VehicleSystem
      │   ├─ generic chassis collider
      │   ├─ raycast suspension
      │   ├─ scalar tire model
      │   ├─ drivetrain/AT/MT/reverse
      │   ├─ ABS/TCS/ESC
      │   └─ telemetry + visual wheels
      ├─ InputController
      ├─ ProceduralAudio + candidate audio banks
      ├─ RaceTimingSession
      │   ├─ legacy JS progress
      │   ├─ JS/WASM capability
      │   └─ shadow/owner migration paths
      ├─ Rust/WASM fixed-step capability
      └─ HUD / modal / fullscreen / telemetry / lifecycle
```

虽然模块名很多，但控制权仍集中在主入口。主入口直接持有并协调所有游戏对象、DOM、异步加载、状态字符串和诊断状态。

---

## 5. 关键代码证据 A：主入口是 God Module

### 5.1 顶层直接创建全部系统

原代码的等价摘录：

```js
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(...);

await initializeRapier(RAPIER);
const physicsWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const track = new TrackSystem(...);
const assets = createGameAssetManager(scene, track);
const input = new InputController();
const audio = new ProceduralAudio(...);
const effects = new TireEffects(scene);
const chaseCamera = new ChaseCamera(camera);
const timingStore = new TimingStore();

let carIndex = 0;
let vehicle = null;
let vehicleLoadPending = false;
let state = 'menu';
let stateBeforePause = 'race';
let physicsScheduler = null;
let raceProgressCore = null;
let countdown = 0;
let timing = null;
let performanceVisible = false;
let powerDiagnosticsVisible = false;
```

这些对象和状态都处于模块顶层，没有应用对象或明确状态机 owner。

### 5.2 一个动画循环直接协调所有子系统

原代码核心结构：

```js
function animate(now) {
  requestAnimationFrame(animate);
  const frameDt = clampFrameDelta((now - lastFrame) / 1000);
  lastFrame = now;
  if (!vehicle) return;

  if (input.consumeGamepadMenuPulse()) {
    if (state === 'menu' || state === 'finish') startRace();
    else if (state === 'paused') resumeRace();
    else if (state === 'race' || state === 'countdown') openRaceMenu();
  }

  const inputBlocked = state === 'paused' || isRaceBlockedByModal();
  if (inputBlocked) {
    setAudioPaused(true);
    input.releaseAll();
    resetPhysicsScheduler();
    vehicle.syncVisual(1);
    chaseCamera.update(...);
    updateHUD();
    updatePerformance(frameDt);
    renderer.render(scene, camera);
    return;
  }

  const frameInput = input.update(frameDt, vehicle.telemetry.speedKmh, {
    deferFixedPulses: true,
  });
  const physicsPlan = physicsScheduler.advance(frameDt);
  for (let step = 0; step < physicsPlan.steps; step += 1) {
    fixedUpdate(frameInput);
  }

  vehicle.syncVisual(physicsPlan.alpha);
  chaseCamera.update(...);
  effects.update(...);
  setAudioPaused(false);
  audio.update(vehicle.telemetry);
  updateHUD();
  updatePerformance(frameDt);
  renderer.render(scene, camera);
}
```

这个循环直接知道输入、菜单 pulse、暂停、modal、音频、调度器、车辆、物理、相机、特效、HUD、性能和渲染。

### 5.3 同一入口还负责产品流程

它同时包含：

- 异步车辆加载、请求 token、失败重试和排队选择；
- 比赛开始、倒计时、暂停、恢复、完赛、返库；
- 检查点检测与圈无效；
- PB 和奖牌 UI；
- 全屏、横屏、iPhone 帮助；
- 所有按钮和键盘事件；
- 开发 telemetry；
- 当前新增的踏板与动力诊断。

### 5.4 工程判断

这是典型 God Module。拆出 helper 文件并没有真正拆出控制权。

直接后果：

- 任一功能都容易继续向主入口增长；
- 游戏状态由字符串、DOM class、dialog 状态和多个布尔共同表达；
- UI、物理和音频必须依赖多处分支保持同步；
- 开发诊断直接进入生产循环；
- 很难提取一个真正最小、可玩的核心。

---

## 6. 关键代码证据 B：车辆系统是一个参数化单体

### 6.1 六车使用同一种通用碰撞体

原代码：

```js
const halfLength = Math.max(1.75, config.wheelbase * 0.72);
const collider = RAPIER.ColliderDesc.cuboid(
  config.trackWidth * 0.52,
  0.28,
  halfLength,
)
  .setTranslation(0, -0.09, 0)
  .setMass(config.mass)
  .setFriction(0.28)
  .setRestitution(0.04);
```

不同车型没有经过确认的独立碰撞外形，只按轴距、轮距和质量缩放同一个长方体。

### 6.2 四轮射线永远朝世界下方

原代码核心：

```js
tmp.down.set(0, -1, 0);

for (const wheel of wheels) {
  const origin = wheel.anchor
    .clone()
    .applyQuaternion(bodyQuaternion)
    .add(bodyPosition);

  const ray = new RAPIER.Ray(origin, tmp.down);
  const hit = world.castRayAndGetNormal(ray, maxRay, false, ..., body);
  if (!hit) continue;

  const suspensionLength = hit.timeOfImpact - wheelRadius;
  wheel.compression = clamp(restLength - suspensionLength, 0, travel);

  const springForce = compression * springRate + compressionVelocity * damper;
  force.set(0, springForce, 0);
  body.addForceAtPoint(force, contactPoint, true);
}
```

悬挂射线和力都绑定世界 Y 轴，不以路面法线或完整悬挂几何为基础。这自然适合平面测试场，不适合复杂路面。

### 6.3 轮胎力是简化标量模型

原代码：

```js
const slipRatio =
  (wheel.omega * wheelRadius - wheelLongSpeed)
  / Math.max(3.5, Math.abs(wheelLongSpeed));

const slipAngle = Math.atan2(
  wheelLateralSpeed,
  Math.max(2.2, Math.abs(wheelLongSpeed)),
);

const muLoad = normalLoad * tire.mu * surface.grip;
let longitudinalForce = Math.tanh(slipRatio * tire.longStiffness) * muLoad;
let lateralForce = -Math.tanh(slipAngle * tire.lateralStiffness) * muLoad;

const magnitude = Math.hypot(longitudinalForce, lateralForce);
if (magnitude > muLoad) {
  const scale = muLoad / magnitude;
  longitudinalForce *= scale;
  lateralForce *= scale;
}
```

这是可用于轻量 simcade 原型的模型，但不能支撑“六辆真实车辆物理已经完成”的结论。

### 6.4 传动、正反向、制动和辅助全部混在同一个类

一个方法负责：

```js
if (input.toggleTransmission) toggleATMT();
if (manual) handleShiftPulses();

if (input.directionConflict) {
  cancelReverseHold();
  applyServiceBrakeByTravelDirection();
} else if (wantsForward) {
  brakeIfMovingBackward();
  otherwiseSelectForwardAndThrottle();
} else if (wantsReverse) {
  brakeIfMovingForward();
  otherwiseHoldThenSelectReverse();
}
```

另一个方法继续负责：

```js
calculateEngineRpm();
automaticShift();
calculateEngineTorque();
applyClutchAndFinalDrive();

for (each wheel) {
  calculateSuspension();
  calculateTireForces();
  applyTCS();
  applyABS();
  applyServiceBrake();
  applyHandbrake();
  integrateWheelOmega();
}

applyAerodynamicDrag();
applyStabilityAssist();
updateTelemetry();
detectStuckOrOverturned();
```

### 6.5 六辆车的差异主要是一组标量

六车配置的结构基本相同：

```js
{
  id, name, modelFile,
  mass, power, torque,
  wheelbase, trackWidth, wheelRadius, maxSteer,
  idleRpm, redlineRpm, peakRpm,
  gears, finalDrive, drivetrain,
  cdA, brakeTorque,
  suspension: {
    restLength, travel, springRate,
    damperBump, damperRebound, antiRoll,
  },
  tire: {
    mu, longStiffness, lateralStiffness, rollingResistance,
  },
}
```

工程判断：当前不是六辆完成的车，而是一个通用原型加六套调参。

---

## 7. 关键代码证据 C：资产系统在浏览器运行时修资产

### 7.1 每个模型都要运行时归一化

原逻辑等价于：

```js
const model = loadedTemplate.clone(true);
let box = new THREE.Box3().setFromObject(model);
let size = box.getSize(new THREE.Vector3());

if (size.x > size.z) model.rotation.y = Math.PI / 2;
model.rotation.y += config.model.yaw || 0;

box = new THREE.Box3().setFromObject(model);
size = box.getSize(new THREE.Vector3());
const scale = config.model.targetLength / Math.max(size.x, size.z, 0.001);
model.scale.setScalar(scale);

const center = box.getCenter(new THREE.Vector3());
const wheelGround = findWheelGroundByNamesAndShapes(model, box, config);
model.position.x -= center.x;
model.position.z -= center.z;
model.position.y -= wheelGround.y + config.model.groundOffset;

bindWheelManifestIfPresent();
const optimized = mergeStaticCarMeshes(model);
addContactShadow();
```

方向、缩放、中心、接地点和动态轮组并不是固定生产资产的一部分，而是在玩家浏览器中临时推断。

### 7.2 车轮接地点依赖名字和形状猜测

原逻辑：

```js
if (/tyre|tire/.test(meshName)) tireCandidates.push(bounds);
else if (/wheel|rim|circle\.00[2-5]/.test(meshName)) wheelCandidates.push(bounds);

const roundInProfile = Math.abs(size.y - size.z) < expectedDiameter * 0.42;
const plausibleDiameter =
  size.y > expectedDiameter * 0.62
  && size.y < expectedDiameter * 1.48;
const plausibleWidth = size.x < expectedDiameter * 0.72;

if (roundInProfile && plausibleDiameter && plausibleWidth) {
  shapeCandidates.push(bounds);
}
```

如果名字和形状都猜不到，就回退到整个模型包围盒底部。

### 7.3 M3 隐藏原轮并生成圆柱轮

原代码：

```js
if (config.id === 'm3e30') {
  model.traverse((object) => {
    if (object.isMesh && /BMW_E30_M3_(RIM|TIRE)/i.test(object.name)) {
      object.visible = false;
    }
  });
}

if (config.id === 'm3e30') {
  wrapper.add(createCalibratedWheelSet(config));
}
```

生成轮的核心：

```js
const tireGeometry = new THREE.CylinderGeometry(
  wheelRadius, wheelRadius, 0.205, 24, 1, true,
);
const rimGeometry = new THREE.CylinderGeometry(
  wheelRadius * 0.58, wheelRadius * 0.58, 0.214, 18,
);
```

这只能算占位或诊断方案，不是最终车辆资产。

### 7.4 先合并，再用 manifest 拆回来

运行时合批：

```js
for (const mesh of sourceMeshes) {
  const clone = mesh.geometry.clone();
  clone.applyMatrix4(mesh.matrixWorld);
  batches.get(materialAndAttributeSignature).geometries.push(clone);
}

for (const batch of batches.values()) {
  const merged = mergeGeometries(batch.geometries, false);
  optimized.add(new THREE.Mesh(merged, batch.material));
}
```

另一套运行时代码又按照 manifest 对三角形进行筛选，生成新的 wheel carrier、steer 和 roll 节点，并隐藏原 source mesh。

工程判断：资产处理方向完全反了。正确流程是离线修复、固定导出、运行时直接加载，而不是浏览器里猜测、合并、再拆分。

---

## 8. 关键代码证据 D：Rust/WASM 形成多套 owner

### 8.1 Rust 实际只负责很小的纯逻辑

WASM 导出主要是：

```rust
streetrush_fixed_dt_seconds()
streetrush_max_frame_dt_seconds()
streetrush_max_physics_steps()
streetrush_clamp_frame_delta(delta)
streetrush_plan_physics_steps(accumulator, delta)
streetrush_plan_remainder_seconds(accumulator, delta)

streetrush_timing_advance_exact_ms(status, current, delta)
streetrush_timing_round_duration_ms(value)
streetrush_timing_expected_checkpoint_index(passed, count)
streetrush_timing_checkpoint_ordinal(passed, count)
streetrush_timing_checkpoint_flags(...)
streetrush_timing_resolve_medal(...)

streetrush_replay_quantum()
streetrush_replay_digest_push_f64(...)
```

Rust 不拥有 Rapier 车辆动力学、碰撞、输入、Three.js、相机、音频或 UI。

### 8.2 同一比赛进度逻辑有多份

项目同时存在：

1. 旧 JavaScript 比赛状态；
2. JavaScript fallback capability；
3. staged progress session；
4. Rust progress functions；
5. raw WASM ABI；
6. shadow 和 owner 两种迁移模式；
7. 比较这些实现逐字段一致的测试。

运行时 shadow 检查甚至采用：

```js
const legacySnapshot = legacy.snapshot();
const wasmSnapshot = progressShadow.snapshot();

if (JSON.stringify(wasmSnapshot) !== JSON.stringify(legacySnapshot)) {
  throw new Error('race progress shadow mismatch');
}
```

### 8.3 capability 加载成功不等于生产 owner

加载阶段：

```js
const sharedCore = await loadSharedCoreCapabilities();
physicsScheduler = sharedCore.scheduler;
raceProgressCore = sharedCore.raceProgress;

html.dataset.physicsSchedulerOwner = physicsScheduler.owner;
html.dataset.raceProgressCoreOwner = raceProgressCore.owner;
```

创建比赛计时时：

```js
timing = new RaceTimingSession({
  trackId,
  carId,
  totalLaps,
  checkpointCount,
  sectorCheckpoints,
  store,

  ...(import.meta.env.DEV && raceProgressCore
    ? { progressCore: raceProgressCore, progressMode: 'owner' }
    : {}),
});
```

只有开发环境才把 progress capability 作为 owner 传入。正式构建仍可能使用旧 JavaScript 进度逻辑，但页面可以显示 WASM capability 已加载。

工程判断：这里把“存在一个 WASM capability”和“生产状态真正归它所有”混为一谈，造成架构完成度错觉。

---

## 9. 关键代码证据 E：测试主要证明内部自洽

### 9.1 默认验证链覆盖

```text
timing / medals / input
audio context / pause / bank / loader / player / pilot / six-car
telemetry / orientation / track / route
assets / model structure / wheel manifests / per-car wheel loaders
research salvage / asset licenses
physics scheduling / scheduler owner / shared core
replay core / race progress / shadow / staging / soak
vehicle reset / boundaries / recovery / visual wheels / determinism
physics smoke / regression / surfaces / direction / braking
build / Cloudflare / secrets / asset inventory
```

### 9.2 资产测试使用自造对象

```js
class FakeLoader {
  loadAsync(url, onProgress) {
    return configuredPromise;
  }
}

function makeTemplate() {
  const root = new THREE.Group();
  root.add(new THREE.Mesh(
    new THREE.BoxGeometry(2, 1, 4),
    new THREE.MeshBasicMaterial(),
  ));
  return root;
}
```

它们验证 pending request、超时清理、late dispose、合批和 manifest 契约。这些测试保护资产修补框架，不证明最终车辆外观。

### 9.3 progress 测试互相比对

```js
const legacy = new RaceTimingSession(...);
const wasm = new RaceProgressSession({ core: wasmCore });
const fallback = new RaceProgressSession({ core: jsCore });

for (each stage) {
  advanceAll();
  compareSnapshot(wasm, legacy);
  compareSnapshot(fallback, legacy);
  compareCheckpointOutcome();
}
```

它证明多套实现保持一致，不证明游戏循环值得玩。

### 9.4 验证倒置

自动测试能回答内部实现是否一致、loader 生命周期是否符合设计、manifest 拆分是否符合 manifest、音频循环元数据是否通过。

自动测试不能回答车辆是否好开、相机是否舒服、赛道是否可读、模型是否正确、声音是否像车、玩家是否愿意再玩一局。

---

## 10. 关键代码证据 F：赛道是程序化平面测试场

### 10.1 数据骨架

```js
const curve = new THREE.CatmullRomCurve3(
  points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
  true,
  'catmullrom',
  0.2,
);

const samples = Array.from({ length: 1024 }, (_, index) => {
  const t = index / 1024;
  const point = curve.getPointAt(t);
  const tangent = curve.getTangentAt(t).normalize();
  const side = new THREE.Vector3(tangent.z, 0, -tangent.x).normalize();
  return { index, t, point, tangent, side };
});
```

控制点的 Y 坐标都为 0。这部分 spline、采样、nearest point 和 reset pose 可以作为骨架保留。

### 10.2 视觉由基础几何生成

```js
const ground = new THREE.Mesh(
  new THREE.CircleGeometry(850, 160),
  dirtMaterial,
);

const box = new THREE.BoxGeometry(1, 1, 1);
const curbRed = new THREE.InstancedMesh(box, redMaterial, 384);
const curbWhite = new THREE.InstancedMesh(box, whiteMaterial, 384);
const edgeLines = new THREE.InstancedMesh(box, edgeMaterial, 768);
const barriers = new THREE.InstancedMesh(box, barrierMaterial, 768);
```

检查点门、起步灯、路线牌、终点格、灯杆和其他设施也使用基础几何生成。

### 10.3 物理世界是平面和分段盒子

```js
createCollider(
  RAPIER.ColliderDesc.cuboid(850, 0.33, 850)
    .setFriction(0.15)
    .setRestitution(0),
);

for (each barrierSegment) {
  createCollider(
    RAPIER.ColliderDesc.cuboid(0.18, 0.75, halfLength),
  );
}
```

工程判断：当前是一条程序化测试场，不是具有高差、地形、空间层次和独特视觉语言的成熟赛道世界。

---

## 11. 关键代码证据 G：音频工程先于音频质量

程序化音频同时创建主振荡器、sub、mechanical、noise、wave shaper、滤波器、排气噪声、路噪、风噪和胎噪。

六套 bank 的真实性质：

```js
mx5    -> bank.candidate.i4.mazda-b6-compatibility-proxy
m3e30  -> bank.candidate.i4.bmw-s14b23
gt3rs  -> bank.candidate.flat6.porsche-gt3-992-dacxl
lp700  -> bank.candidate.v12.lamborghini-l539-dacxl
amggt3 -> bank.candidate.v8-mercedes-m159-compression-compatible-proxy
m5g90  -> bank.candidate.v8-bmw-s68-compression-compatible-proxy
```

多层播放器按 RPM 和 load 混音：

```js
const rpmWeight = interpolateBetweenNearestAnchors(rpm);
const onWeight = Math.sqrt(load);
const offWeight = Math.sqrt(1 - load);

for (const layer of bank.layers) {
  const level = rpmWeight * (layer.mode === 'on' ? onWeight : offWeight);
  layer.gain.setTargetAtTime(level, now, 0.045);
  layer.source.playbackRate.setTargetAtTime(
    clamp(rpm / layer.rpm, 0.45, 1.55),
    now,
    0.035,
  );
}
```

系统还实现 loader、coordinator、request id、abort、late dispose、procedural fallback、pause/resume 和多项测试。

工程判断：加载工程完整，但“循环合法”和“听起来像车”不是一回事。项目过早为六辆车建设了音频平台。

---

## 12. 输入系统：有价值，但复杂度已扩张

当前一个输入类同时维护：

```text
keyboard keys / keyboard rearm / fixed pulses
gamepad connection / replacement / rearm / menu pulse
touch enabled / multi-pointer / pointer capture / pointer rearm
keyboard activation of touch buttons
raw throttle/brake/handbrake
filtered throttle/brake/handbrake
drive intent / direction conflict
```

有价值的部分包括失焦清零、手柄替换 rearm、触控多指、pulse/hold 分离和输入平滑。

问题是第一阶段就同时承担键盘、手柄、移动端、无障碍键盘触控按钮和多种边界 rearm，导致一个驾驶输入问题跨越太多状态。

---

## 13. 当前未提交改动

工作区已有其他未提交工作，任何接管 AI 都不得覆盖。

主要范围：输入、主入口、HTML/CSS、车辆物理、制动纯函数、物理 harness、多项车辆测试、replay baseline、新制动测试和油门/刹车/手刹审计材料。

新增状态包括：

```js
frame.rawThrottle
frame.rawBrake
frame.rawHandbrake
frame.directionConflict

telemetry.handbrake
telemetry.powertrain.driveTorqueRequestedNm
telemetry.powertrain.driveTorqueAppliedNm
telemetry.powertrain.serviceBrakeTorqueRequestedNm
telemetry.powertrain.serviceBrakeTorqueAppliedNm
telemetry.powertrain.handbrakeTorqueRequestedNm
telemetry.powertrain.handbrakeTorqueAppliedNm
```

还增加了约 100 行诊断 UI，用于显示 raw request、filtered input、applied pedal、requested/applied torque、TCS/ABS/contact limiting 和 W+S 仲裁。

这批改动中有些物理修正意图明确，但它也展示了膨胀模式：一个驾驶问题会同时增加输入字段、车辆字段、遥测、HTML、CSS、HUD、测试和 baseline。

接管前必须先保存这批改动。禁止 hard reset、整文件格式化或用重写覆盖。

---

## 14. 根因总结

1. **验证倒置**：先完成容易自动验证的内部契约，没有先完成驾驶、相机、赛道、声音和循环。
2. **所有权扩张**：同一规则拥有 legacy、fallback、shadow、owner、Rust、WASM 多套路径。
3. **运行时资产修补**：不回到源资产，而在浏览器中猜测、隐藏、生成、合并和拆分。
4. **过早扩展六车**：主车尚无质量基线，就建设六车物理、轮组、音频、PB 和测试矩阵。
5. **开发工具进入产品路径**：diagnostics、dataset owner、telemetry 和 HUD 持续进入主入口。
6. **文档与测试制造完成度错觉**：PASS 输出和状态表容易诱导后续 AI 继续扩张。

---

## 15. 保留、隔离、重写判断

| 领域 | 判断 | 后续处理 |
| --- | --- | --- |
| Three.js/Rapier 启动 | 保留思想 | 用更小入口重新接线 |
| fixed-step | 保留 | 单一 JavaScript owner |
| spline/nearest/reset | 保留 | 作为赛道数据骨架 |
| 程序化赛道视觉 | 重做 | 只当 debug renderer |
| 当前 VehicleSystem | 参考后重写 | 不继续 Vehicle V2 |
| 六车参数 | 隔离 | 主路径只留一车 |
| 通用长方体碰撞 | 临时可用 | 主车后续建立明确 collider |
| 当前简化轮胎 | 临时可用 | 先求可玩，不先换高级模型 |
| InputController | 部分保留 | 第一阶段只接键盘 |
| ChaseCamera | 可作为起点 | 用真实驾驶重新调 |
| TireEffects | 可选 | 不阻塞核心循环 |
| 圈时、PB、检查点需求 | 保留 | 收敛成一个 JS 实现 |
| Rust/WASM shared core | 退出主路径 | 暂存，不继续扩展 |
| shadow/owner/fallback | 删除或重写 | 最小生产路径只留一个 owner |
| 资产加载缓存思想 | 部分保留 | 主车使用固定生产 GLB |
| 运行时猜车轮/拆几何 | 否决 | 改为离线资产处理 |
| M3 圆柱轮 | 否决 | 只保留作失败证据 |
| 六车候选音频 | 隔离 | 不阻塞一车切片 |
| AudioContext 生命周期 | 可参考 | 真正需要音频时再接 |
| 大部分内部一致性测试 | 移出默认门禁 | 按产品风险选择恢复 |
| UI 视觉语言 | 可参考 | 第一阶段只留最小 HUD |
| 踏板诊断 | 开发工具 | 不继续扩大生产入口 |

---

## 16. 新的最小产品目标

> 一辆资产正确的车，在一条读得懂的封闭赛道上，能够用键盘稳定驾驶，完成碰撞、重置、暂停、计圈和三圈完赛；玩家跑完第一圈后愿意再跑一圈。

第一阶段明确不做：六车、Rust/WASM、多层候选音频平台、手机、完整手柄矩阵、真实车辆模拟承诺、第二赛道、AI 对手、联网、生涯和大型验证平台。

---

## 17. 推荐的最小结构

```text
bootstrap    只创建 renderer、scene、physics world 和必要资源
game loop   只负责 fixed-step、physics step、render interpolation
session     只负责 menu、countdown、race、paused、finish
input       第一阶段只有键盘规范化输入
vehicle     一辆车的物理、重置和只读 snapshot
track       spline、surface、checkpoint、最小视觉和碰撞
camera      单一 chase camera
HUD         只把 session/vehicle snapshot 映射到 DOM
audio       可选；简单临时实现，第一阶段甚至可以静音
```

关键约束：fixed-step 只有一个 owner；比赛进度只有一个 owner；输入只有一个规范结构；车辆 GLB 在运行时加载前已经正确；开发诊断不扩张产品循环；每个模块能用一句话说明职责。

---

## 18. 推荐实施顺序

### 阶段 0：保护现场

保存当前未提交改动，建立可回退提交、分支或 patch；不删除模型源文件、研究资料和失败证据。

### 阶段 1：一辆车

选择节点和轮组层级最可靠的一辆车；固定生产 GLB；禁止运行时猜车轮或拆几何；只支持键盘；完成稳定起步、刹停、转向、碰撞和重置。

### 阶段 2：一局闭环

完成倒计时、顺序检查点、圈时、暂停/恢复、三圈完成、快速重开和最小 PB。

### 阶段 3：真实试玩

人用键盘完整跑三圈；记录第一个阻断问题；只修这个问题；重复直到核心循环稳定。

### 阶段 4：表现

严格按相机、赛道可读性、速度感与基础特效、一辆车音频、最小 UI 的顺序处理。

### 阶段 5：扩展决策

只有一车一赛道已经好玩，才讨论手柄、手机、第二辆车、更复杂音频、更复杂轮胎和 Rust/WASM。

---

## 19. 最小验收门槛

### 驾驶

- 连续油门稳定起步；
- 可重复刹停；
- 低速与高速转向可控；
- 护栏碰撞不穿透、不爆速、不永久卡死；
- 重置不保留旧输入或旧速度。

### 比赛

- 检查点只能按顺序通过；
- 越界、逆行、重置规则明确；
- 暂停时物理和计时冻结；
- 三圈后进入结果；
- 能立即重开并再次完成。

### 表现

- 主车轮胎位置、转向、滚动正确；
- 相机能看清路线；
- 赛道边界和方向易读；
- 不用 UI 掩盖空世界。

### 工程

- 构建成功；
- 控制台无持续错误；
- 一个车辆数值稳定测试；
- 一个比赛规则测试；
- 一个输入失焦测试；
- 不以几十个内部一致性测试代替人工验收。

---

## 20. 后续 AI 禁止事项

1. 不得因为模块、测试、Rust 或 WASM 多，就默认沿现架构继续。
2. 不得覆盖当前未提交改动。
3. 不得先重写所有模块，再确认游戏是否好玩。
4. 不得一次处理六辆车。
5. 不得继续在运行时猜测、生成或切分车辆模型。
6. 不得用更多 telemetry、dashboard、报告和 baseline 代替解决玩家问题。
7. 不得用自动测试通过宣称视觉、声音或驾驶手感合格。
8. 不得把候选音频循环合法写成听感合格。
9. 不得把 WASM capability 加载成功写成生产 owner 已迁移。
10. 不得扩展 AI、联网、开放世界、第二赛道或商业发布范围。

---

## 21. 后续 AI 的正确汇报格式

```text
玩家问题：实际体验中发生了什么？
代码原因：最小控制路径是什么？
修改范围：本次只动哪些职责？
解决方案：为什么这是最小方案？
自动验证：保护了什么具体风险？
人工验证：仍需人确认什么？
明确未做：哪些事情不在本次范围？
```

如果没有玩家可见问题或明确产品目标，不得自动扩张架构。

---

## 22. 最终判断

可以利用的部分：Three.js/Rapier 原型基础、赛道 spline 与检查点数据、输入生命周期处理经验、fixed-step 与计时需求、资产加载和 AudioContext 生命周期经验、来源可信的模型素材，以及少量真正保护产品风险的测试。

不值得继续沿用的方向：围绕当前 VehicleSystem 修补全部车型；为简单规则维护 JS/Rust/WASM/owner/shadow 多轨；在玩家浏览器中修复车辆资产；同时建设六车候选音频平台；继续增长主入口、诊断 HUD 和 baseline；用测试、文档和遥测制造完成度。

最终定性：

> StreetRush 当前的主要资产不是一个接近完成的游戏，而是一批可以筛选利用的原型代码、数据和失败经验。应从一车一赛道的真实可玩闭环重新建立产品基线，而不是继续沿现有 AI 生成式架构累加功能。

