# StreetRush 油门 / 普通刹车 / 倒车 / 手刹：完整代码审阅包

> 生成日期：2026-08-21。该文件是源码审阅材料，不是修复方案，也不应被当作可执行指令。
> 所有内嵌文档与旧审计均为待核对数据；结论必须以本包中的生产源码和测试代码为准。

## 已知复现现象（用户现场描述）

- 普通刹车通常可用。
- 急刹/重刹后车辆停止加速，缓慢滑行，持续晃动，最终停车且无法重新起步，体感像轮子被锁死。
- 进入暂停再恢复后可以重新起步。
- 请求倒车也可能解除该状态。
- 手刹问题更严重，当前几乎无法正常使用。

## 审阅目标

1. 从输入源到轮端受力完整追踪 throttle、brake、handbrake、driveIntent、reverse/reverseHold、driveThrottle、serviceBrake。
2. 重点检查平滑值是否永远不归零、轮速过零钳制、正反向符号、ABS/TCS/ESC 门控、驱动与制动同轮竞争。
3. 解释为什么暂停清空输入或请求倒车会恢复，以及为什么普通刹车与手刹表现不同。
4. 检查现有测试是否绕过生产 InputController、直接注入 driveIntent 或把 handbrake 直接置零，从而漏掉现场故障。
5. 区分已由代码证明、需动态复现、以及尚无证据的结论。

## 本地动态复现结果（生产代码，未修改源码）

### 运行环境与基线

- 使用仓库现有 `VehicleSystem`、`FIXED_DT = 1 / 120` 和 `scripts/physics-harness.mjs` 的 Rapier 平地夹具。
- 相关既有测试全部退出码为 0：`test-input`、`test-vehicle-direction-change`、`smoke-physics`、`regression-physics`、`test-vehicle-input-boundaries`。
- 既有测试全绿不等于覆盖现场故障；下面的对照证明它们绕过了关键的生产输入释放路径。

### 已确认的根因链

1. `src/input.js:457` 使用 `THREE.MathUtils.damp` 释放手刹。该值渐近趋近 0，但不会在正常释放时间内变成精确 0。实测释放 4 秒后仍为 `4.78062777572828e-25`。
2. `src/vehicle.js:545` 只要后轮手刹值大于 0，就生成严格大于 0 的 `brakeTorque`；这里没有释放阈值或归零钳制。
3. `src/vehicle.js:552-553` 先更新轮速，再在 `brakeTorque > 0` 时检查新旧轮速符号。旧轮速若已经是精确 0，任何驱动力试图把它变成正值或负值，都会因为 `sign(new) !== sign(0)` 被重新钉回 0。
4. 因此，手刹期间一旦某个后轮到达精确 0，只要平滑残值仍严格大于 0，该轮就无法靠驱动力重新起转。后驱车会彻底失去驱动；四驱车前轮虽有驱动，仍会拖着锁死的后轮，几乎无法起步。
5. `src/vehicle.js:540-543` 的 TCS 看到持续滑移后继续削减驱动力；`src/vehicle.js:573-576` 又因任何非零手刹残值关闭 ESC 修正，所以会出现持续摆动、偏航和“油门有显示但车不走”。
6. `src/main.js:789` 的暂停入口调用 `input.releaseAll()`；`src/input.js:131-149` 会把 `frame.handbrake` 直接写成精确 0。这个精确 0 使 `brakeTorque > 0` 条件消失，轮子下一步即可重新起转。这与现场“暂停一下就恢复”完全一致。

普通刹车之所以通常没这个永久锁止，是因为它先经过 `updateTransmission` 仲裁。S 松开或重新请求前进后，`serviceBrake` 会立刻变成 0，平滑后的 `frame.brake` 残值不会继续传到轮端；手刹则绕过这层仲裁，直接把平滑残值叠加到后轮。

### 生产式转弯手刹对照（MX-5）

序列与现有回归测试基本相同：加速到约 65 km/h，0.8 秒轻油门转弯，0.7 秒手刹，然后 4 秒直行恢复。唯一变量是手刹释放方式。

| 释放方式 | 手刹期间首次精确归零 | 4 秒后手刹值 | 4 秒后车速 | 4 秒后后轮角速度 RL / RR | 4 秒后偏航率 | TCS |
|---|---:|---:|---:|---:|---:|---|
| 测试夹具式：直接写 `0` | RR 在 0.3583 s | 0 | 61.156 km/h | 59.587 / 59.587 rad/s | 约 `-1.45e-7` rad/s | false |
| 生产式：`damp(..., 0, 14, dt)` | RR 在 0.3583 s | `4.7806e-25` | 34.229 km/h | 33.706 / **0** rad/s | **0.1961 rad/s** | **true** |

这组结果直接复现了“一侧后轮锁死、车辆持续晃/偏航、加速恢复失败”。平地夹具完全左右对称时不容易暴露；加入现有测试本来就使用的转向后，内外侧载荷差使单侧后轮先归零，故障立即出现。

### 六车全停后重新起步对照

序列：约 80 km/h 后持续手刹，等两个后轮均到达精确 0；随后保持前进油门 2 秒。`精确 0` 是测试夹具/暂停清零式释放，`平滑残值` 是生产式释放。

| 车辆 | 驱动 | 后轮首次均为 0 | 精确 0 后 2 秒车速 | 平滑残值后 2 秒车速 | 平滑残值时后轮 |
|---|---|---:|---:|---:|---|
| mx5 | RWD | 5.375 s | 19.942 km/h | **-0.077 km/h** | 0 / 0 |
| m3e30 | RWD | 5.033 s | 18.003 km/h | **-0.084 km/h** | 0 / 0 |
| gt3rs | RWD | 4.158 s | 26.852 km/h | **-0.107 km/h** | 0 / 0 |
| lp700 | AWD | 4.142 s | 33.507 km/h | **0.141 km/h** | 0 / 0 |
| amggt3 | RWD | 3.925 s | 33.857 km/h | **-0.110 km/h** | 0 / 0 |
| m5g90 | AWD | 3.942 s | 33.945 km/h | **0.348 km/h** | 0 / 0 |

两秒时平滑手刹残值约为 `6.9144e-13`，物理制动力矩本身已经微不足道；车辆仍不能起步，证明真正维持锁止的是“严格大于 0”触发的轮速过零钳制，而不是残余制动力矩大小。

### 暂停清零对照

MX-5 两个后轮已锁为 0、持续给油 5 秒仍只有约 0.073 km/h。模拟暂停的精确清零后继续给油 1 秒：

- 车速恢复到 8.871 km/h；
- 后轮角速度从 `0 / 0` 恢复到 `9.061 / 9.061 rad/s`。

暂停没有重置 `VehicleSystem`、刚体或轮子；仅清空输入就恢复，进一步锁定了上述根因链。

### 关于“请求倒车也能恢复”

- 代码上存在明确的解锁机会：`src/vehicle.js:222-230` 的 `setReverseState` 会按当前车身纵向速度重写四个轮子的 `omega`，而不是保留原来的 0。
- 但在完全平坦、对称的夹具中，若换向发生时纵向速度接近 0，非零手刹残值仍可能在下一步把轮子再次钉回 0；本地夹具未能稳定复现“倒车必定恢复”。
- 现场赛道上的坡度、偏航和车身前后摆动会改变换向瞬间的 `longSpeed`，所以倒车重写轮速可能偶发成功。这一点目前应标为“现场已观察、代码有机制解释、结果依赖时序”，不能写成确定保证。

### 为什么现有测试漏掉

- `scripts/regression-physics.mjs:302-323` 把事件手刹直接注入为 0 或 1，恢复阶段直接传 0；它没有经过 `InputController` 的渐近释放。
- `scripts/test-input.mjs` 测输入生命周期，但没有把输出接进 `VehicleSystem`，因此看不到轮速锁止。
- `scripts/test-vehicle-direction-change.mjs` 只直接调用 `updateTransmission`，没有轮胎、轮速或手刹。
- `scripts/smoke-physics.mjs` 覆盖普通刹车、倒车和恢复，但没有生产式手刹释放序列。
- 既有手刹回归的“精确 0”对照本身会解除故障，所以测试恰好证明了错误的安全路径。

## 文件清单与完整性

| 路径 | 字节 | SHA-256 |
|---|---:|---|
| package.json | 5907 | 676684a0dbabd89cac2abf9605b31b2546f81df5ea8d6a602b3cfffee3ed2941 |
| index.html | 13325 | 2435bdd4aa002e242aaae1cab88a64264560bc2bdbac72221c7b268f5ad9ceff |
| src/config.js | 7027 | f6953c25119ec31b8f640366c68bffdb0dd79cb715965f9e006fe0dcf014a964 |
| src/input.js | 18660 | 1949db8c4f1221582c5eff62aa4ceb1452e87ee8db37f0356f146393db9437d7 |
| src/main.js | 46249 | a36375f7fd496580305e4643a95ee3cda7238b7ac0a536c483677c3885d16b96 |
| src/vehicle.js | 30911 | e7b481acb32f733d993b5b5fa09c13e94f0e990a002c5224cc58b3733b825f72 |
| src/vehicle-physics.js | 2368 | 37baacddde526b79682f346f686bab536279e3333b040e82f62fd15d293812c8 |
| src/physics-scheduling.js | 659 | 60dabe3c0ac5c913d2ddcbf312e1ca65ebc53bf3d56962b5631215e18f5ed540 |
| src/physics-scheduler-owner.js | 4354 | 1f1419b5620ff725f95ebc7b7fc852c846de93a61327b8d3996861f07e242b39 |
| src/shared-core-owner.js | 1315 | 3faeba36b8f7a66817263ff3448ab9e5744c16b9985a9b624f75c2ff67d13f69 |
| crates/streetrush-core/src/scheduling.rs | 6093 | 929e6af5e729335585800f1609ee28447b75ec79fdd54c92710f27330ff1b283 |
| crates/streetrush-core/src/wasm_exports.rs | 4352 | 63ab7f3f69a2a0a0a3ac6476864d739b58f4b9ddf4fe47bd98db4d5e5b2c1ceb |
| scripts/physics-harness.mjs | 2762 | 4e3dbf90ecab92a7ff11f9dfd1212d0ea933a40a7d76ce4d7f7e9e8f0e87e044 |
| scripts/test-input.mjs | 21633 | 5df3b0584b9fa6af83fc4efc1c91b7e173963d5ce2864d44020ee756e86dfe9a |
| scripts/smoke-physics.mjs | 6518 | dbb9ea1baee8c3158726960719d6b521fc0c62f231f8526afcd10042d744cdbd |
| scripts/regression-physics.mjs | 15298 | b47052f525a4bab4f6c3893aa9edda3b2ea3bf8d8413d4ca38d4f566e7067b66 |
| scripts/test-vehicle-direction-change.mjs | 1831 | 6011724de04460e8fb96896ae4083cf88ada12d468d9e9c575202d1d186a3bb9 |
| scripts/test-vehicle-input-boundaries.mjs | 7485 | da4fdaedcf17d56e8533e474f48e9db65b922e803f513b5a41e3c5d551fb3f14 |
| scripts/test-vehicle-internal-recovery.mjs | 9137 | a35de4a8eb10491e1721685ef646565e4c6131d2b6d7efa3097487825cc92b15 |
| scripts/test-vehicle-reset.mjs | 5450 | 12bb2b5d39bc0740b7b22cca9e2ce4d92373c06e2fa80f64f582432170ed633f |
| scripts/test-vehicle-determinism.mjs | 12535 | 62d84d50f732c6c6e0f53731971ef2a6647816dcb1f3071167eedba4dc73e114 |
| scripts/test-surface-stability.mjs | 2690 | f7ede9b0d0336df2c799bfbe8086949af9022d9661d7f10012b7afbb6fd7cb96 |
| scripts/calibrate-physics.mjs | 1892 | e707426890fac2000e3b426dd319f14c444e3d68d2ea51738bb74a4c91e5e4e4 |
| src/validation.js | 5174 | 6ec7c00e6add0b4516fcdb82279caa51b67318225c675911fac855c562218628 |
| data/vehicle-replay-baseline.json | 9663 | e6c861ade9a4d0119680418aa6fcd08fdf5dd48222253f0a8422fe22d09decd9 |
| data/vehicle-replay-fnv-baseline.json | 2732 | b10be15d9ca2946ce7749c9202b77b485b19a70c4dff486890744e8919f5ce62 |
| THROTTLE_BRAKE_HANDBRAKE_AUDIT.json | 14884 | 25768dc295038eb365be510a9b0ce71e5284fe7e8dc4ed154f272d1b9e231cae |

## 源码与测试原文

### package.json

~~~~json
{
  "name": "street-rush",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=22"
  },
  "packageManager": "pnpm@11.9.0",
  "scripts": {
    "dev": "pnpm build:core-wasm && vite --host 127.0.0.1",
    "build": "pnpm build:core-wasm && vite build",
    "build:core-wasm": "node scripts/build-core-wasm.mjs",
    "check:cloudflare": "node scripts/check-cloudflare.mjs",
    "check:secrets": "node scripts/check-secrets.mjs",
    "check:git-release": "node scripts/check-git-release.mjs",
    "check:assets": "node scripts/check-asset-licenses.mjs --mode=inventory",
    "check:assets:public": "node scripts/check-asset-licenses.mjs --mode=public",
    "check:assets:commercial": "node scripts/check-asset-licenses.mjs --mode=commercial",
    "check:goal-calibration": "node scripts/check-goal-calibration.mjs",
    "test:timing": "node scripts/test-race-timing.mjs",
    "test:medals": "node scripts/test-medal-goals.mjs",
    "test:input": "node scripts/test-input.mjs",
    "test:audio-context": "node scripts/test-audio-context.mjs",
    "test:audio-pause": "node scripts/test-audio-pause.mjs",
    "test:audio-bank": "node scripts/test-audio-bank-coordinator.mjs",
    "test:audio-bank-loader": "node scripts/test-audio-bank-loader.mjs",
    "test:audio-player": "node scripts/test-layered-engine-bank.mjs",
    "test:audio-pilot": "node scripts/test-audio-bank-pilot.mjs",
    "test:audio-production-banks": "node scripts/test-production-audio-banks.mjs",
    "test:audio-six-car": "node scripts/test-six-car-audio-runtime.mjs",
    "test:telemetry": "node scripts/test-dev-telemetry.mjs",
    "test:orientation": "node scripts/test-orientation.mjs",
    "test:track": "node scripts/test-track-markers.mjs",
    "test:route": "node scripts/test-route-guidance.mjs",
    "test:assets": "node scripts/test-assets.mjs",
    "test:model-structure": "node scripts/test-car-model-structure.mjs",
    "test:wheel-manifest": "node scripts/test-car-wheel-manifest.mjs",
    "test:wheel-pivots": "node scripts/test-mx5-wheel-pivots.mjs",
    "test:wheel-loader": "node scripts/test-mx5-wheel-loader.mjs",
    "test:gt3-wheel-loader": "node scripts/test-gt3-wheel-loader.mjs",
    "test:lp700-wheel-loader": "node scripts/test-lp700-wheel-loader.mjs",
    "test:amg-wheel-loader": "node scripts/test-amg-wheel-loader.mjs",
    "test:research-salvage": "node scripts/test-research-salvage.mjs",
    "test:asset-license": "node scripts/test-asset-license-check.mjs",
    "test:scheduling": "node scripts/test-physics-scheduling.mjs",
    "test:scheduler-owner": "pnpm build:core-wasm && node scripts/test-physics-scheduler-owner.mjs",
    "test:shared-core": "pnpm build:core-wasm && node scripts/test-shared-core-owner.mjs",
    "test:replay-core": "pnpm build:core-wasm && node scripts/test-replay-core-wasm.mjs",
    "test:race-progress-core": "pnpm build:core-wasm && node scripts/test-race-progress-core-wasm.mjs",
    "test:race-progress-session": "pnpm build:core-wasm && node scripts/test-race-progress-session.mjs",
    "test:timing-shadow": "pnpm build:core-wasm && node scripts/test-race-timing-progress-shadow.mjs",
    "test:progress-staging": "pnpm build:core-wasm && node scripts/test-race-progress-staging.mjs",
    "test:timing-soak": "pnpm build:core-wasm && node scripts/test-race-timing-lifecycle-soak.mjs",
    "test:vehicle-reset": "node scripts/test-vehicle-reset.mjs",
    "test:vehicle-boundaries": "node scripts/test-vehicle-input-boundaries.mjs",
    "test:vehicle-recovery": "node scripts/test-vehicle-internal-recovery.mjs",
    "test:vehicle-visual-wheels": "node scripts/test-vehicle-visual-wheels.mjs",
    "test:vehicle-direction-change": "node scripts/test-vehicle-direction-change.mjs",
    "test:determinism": "pnpm build:core-wasm && node scripts/test-vehicle-determinism.mjs",
    "test:physics": "node scripts/smoke-physics.mjs && node scripts/regression-physics.mjs && node scripts/test-surface-stability.mjs && node scripts/test-vehicle-direction-change.mjs",
    "test:physics:smoke": "node scripts/smoke-physics.mjs",
    "test:physics:regression": "node scripts/regression-physics.mjs",
    "test:physics:surfaces": "node scripts/test-surface-stability.mjs",
    "calibrate": "node scripts/calibrate-physics.mjs",
    "verify": "pnpm test:timing && pnpm test:medals && pnpm test:input && pnpm test:audio-context && pnpm test:audio-pause && pnpm test:audio-bank && pnpm test:audio-bank-loader && pnpm test:audio-player && pnpm test:audio-pilot && pnpm test:audio-production-banks && pnpm test:audio-six-car && pnpm test:telemetry && pnpm test:orientation && pnpm test:track && pnpm test:route && pnpm test:assets && pnpm test:model-structure && pnpm test:wheel-manifest && pnpm test:wheel-pivots && pnpm test:wheel-loader && pnpm test:gt3-wheel-loader && pnpm test:lp700-wheel-loader && pnpm test:amg-wheel-loader && pnpm test:research-salvage && pnpm test:asset-license && pnpm test:scheduling && pnpm test:scheduler-owner && pnpm test:shared-core && pnpm test:replay-core && pnpm test:race-progress-core && pnpm test:race-progress-session && pnpm test:timing-shadow && pnpm test:progress-staging && pnpm test:timing-soak && pnpm test:vehicle-reset && pnpm test:vehicle-boundaries && pnpm test:vehicle-recovery && pnpm test:vehicle-visual-wheels && pnpm test:determinism && pnpm check:goal-calibration && pnpm test:physics && pnpm build && pnpm check:cloudflare && pnpm check:secrets && pnpm check:assets",
    "check:release:public": "pnpm verify && pnpm check:assets:public && pnpm check:git-release",
    "check:release:commercial": "pnpm verify && pnpm check:assets:commercial && pnpm check:git-release"
  },
  "dependencies": {
    "@dimforge/rapier3d-compat": "^0.19.0",
    "three": "^0.180.0"
  },
  "devDependencies": {
    "vite": "^7.1.7"
  }
}
~~~~

### index.html

~~~~html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#080b12" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
  <title>晴空环线 · Street Rush</title>
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800&family=Noto+Sans+SC:wght@400;600;800&display=swap" rel="stylesheet">
</head>
<body>
  <canvas id="game" tabindex="-1" aria-label="Street Rush 游戏画面"></canvas>

  <div id="loading" class="loading">
    <div class="loading-mark">SR</div>
    <div class="loading-copy">
      <span>准备发车</span>
      <strong id="loading-status" role="status" aria-live="polite">载入城市…</strong>
    </div>
    <div class="loading-bar"><i id="loading-progress"></i></div>
    <button id="boot-retry-button" class="boot-retry hidden" type="button">刷新重试</button>
  </div>

  <header class="topbar">
    <div class="brand"><b>STREET</b><span>RUSH</span></div>
    <div class="route"><i></i><span>龙湾国际赛道</span><small>午后 · 干地</small></div>
    <div class="topbar-actions">
      <button id="race-menu-button" class="fullscreen-toggle hidden" type="button" aria-label="比赛菜单">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
          <path d="M4 5h12M4 10h12M4 15h12"></path>
        </svg>
      </button>
      <button id="fullscreen-button" class="fullscreen-toggle" type="button" aria-label="进入全屏">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M7 3H3v4"></path><path d="M13 3h4v4"></path>
          <path d="M7 17H3v-4"></path><path d="M13 17h4v-4"></path>
        </svg>
      </button>
      <button id="sound-button" class="icon-button" aria-label="切换声音" aria-pressed="true">SOUND ON</button>
    </div>
  </header>

  <main id="menu" class="menu">
    <div class="eyebrow">晴空试车计划 / 01</div>
    <h1>今天，<br><em>跑哪一台？</em></h1>
    <p class="lede">六台真车模型，一条封闭城市赛道。控制轮胎负载，跑出三圈稳定节奏。</p>

    <section class="garage">
      <button id="prev-car" class="nav-button" aria-label="上一辆车">←</button>
      <div class="car-meta">
        <small id="car-index">01 / 06</small>
        <h2 id="car-name">MAZDA MX-5 NA</h2>
        <div id="garage-status" class="garage-status">READY</div>
        <div class="stats">
          <span>极速 <b id="stat-speed">184</b></span>
          <span>加速 <b id="stat-accel">82</b></span>
          <span>操控 <b id="stat-grip">94</b></span>
        </div>
        <div id="garage-goal" class="garage-goal">三圈奖牌目标 · 载入中</div>
        <div class="garage-records" aria-live="polite">
          <span>本机最佳单圈 <b id="garage-best-lap">--:--.---</b></span>
          <span>三圈 PB <b id="garage-best-race">--:--.---</b></span>
        </div>
      </div>
      <button id="next-car" class="nav-button" aria-label="下一辆车">→</button>
    </section>

    <div class="actions">
      <button id="start-button" class="start-button"><span>开始比赛</span><b>ENTER</b></button>
      <button id="retry-car-button" class="retry-car-button hidden" type="button">重新加载车辆</button>
      <span class="hint">WASD / 方向键驾驶 · 空格手刹 · C 自动/手动 · Q/E 换挡</span>
    </div>
  </main>

  <aside id="hud" class="hud hidden">
    <div class="lap"><small>LAP</small><strong><span id="lap-now">1</span>/3</strong></div>
    <div class="time"><small>TOTAL</small><strong id="race-time">00:00.000</strong></div>
    <div class="position"><small>CHECKPOINT</small><strong><span id="checkpoint-now">0</span>/10</strong></div>
    <div class="timing-board" aria-label="圈速与分段计时">
      <div class="timing-primary">
        <small>LAP TIME</small>
        <strong id="lap-time">00:00.000</strong>
        <b id="lap-valid-state" class="lap-valid" aria-live="polite">VALID</b>
      </div>
      <div>
        <small>SECTOR <span id="sector-now">1</span>/3</small>
        <strong id="sector-time">00:00.000</strong>
        <b id="sector-delta" class="timing-delta">NO DATA</b>
      </div>
      <div>
        <small>PERSONAL BEST</small>
        <strong id="best-lap">--:--.---</strong>
        <b id="lap-delta" class="timing-delta">FIRST RUN</b>
      </div>
      <div class="timing-goal">
        <small id="race-target-label">下一目标 · 铜牌</small>
        <strong id="race-target">--:--.---</strong>
        <b id="race-target-delta" class="timing-delta">首个检查点后计算</b>
      </div>
    </div>
    <div class="speed"><strong id="speed">0</strong><span>KM/H</span></div>
    <div class="gearbox">
      <div><small>GEAR</small><strong id="gear">1</strong></div>
      <div><small>RPM</small><strong id="rpm">1000</strong></div>
      <div><small>MODE</small><strong id="shift-mode">AT</strong></div>
    </div>
    <div class="nitro"><span>THROTTLE</span><i><b id="throttle-bar"></b></i></div>
    <div class="brake"><span>BRAKE</span><i><b id="brake-bar"></b></i></div>
    <div class="chassis-state"><span>4-WHEEL CONTACT</span><b id="drive-mode">ASPHALT</b><span>ASSIST</span><b id="assist-state">READY</b><span>C 自动/手动 · Q/E 换挡 · P 性能</span></div>
    <div id="race-message" class="race-message" role="status" aria-live="polite" aria-atomic="true"></div>
    <button id="invalid-lap-restart-button" class="invalid-lap-restart hidden" type="button" aria-hidden="true" aria-keyshortcuts="R">
      <span>重开本次挑战</span><b>R</b>
    </button>
  </aside>

  <div id="mobile-controls" class="mobile-controls" aria-label="触摸驾驶控制">
    <div class="touch-steering" aria-label="左右转向">
      <button id="touch-left" class="touch-direction" type="button" aria-label="向左转">
        <b>‹</b><span>LEFT</span>
      </button>
      <button id="touch-right" class="touch-direction" type="button" aria-label="向右转">
        <b>›</b><span>RIGHT</span>
      </button>
    </div>
    <div class="touch-utilities">
      <button id="touch-reset" class="touch-utility" type="button"><b>↺</b><span>重置</span></button>
      <button id="touch-mode" class="touch-utility" type="button"><b id="mobile-mode">AT</b><span>档位</span></button>
      <button id="touch-handbrake" class="touch-utility touch-handbrake" type="button"><b>!</b><span>手刹</span></button>
    </div>
    <div class="touch-shift" aria-label="手动换挡">
      <button id="touch-shift-down" type="button" aria-label="降档">−</button>
      <span>SHIFT</span>
      <button id="touch-shift-up" type="button" aria-label="升档">＋</button>
    </div>
    <div class="touch-pedals">
      <button id="touch-brake" class="touch-pedal touch-brake" type="button"><b>BRAKE</b><span>刹车 / 倒车</span></button>
      <button id="touch-throttle" class="touch-pedal touch-throttle" type="button"><b>GAS</b><span>油门</span></button>
    </div>
  </div>

  <div id="orientation-hint" class="orientation-hint hidden" aria-live="polite" role="dialog" aria-modal="true" aria-labelledby="orientation-hint-title" aria-hidden="true">
    <div class="phone-rotate">↻</div>
    <strong id="orientation-hint-title">请横屏驾驶</strong>
    <span>转动手机，方向键和踏板会自动就位</span>
    <button id="orientation-fullscreen" class="orientation-fullscreen" type="button">进入全屏</button>
  </div>

  <section id="fullscreen-help" class="fullscreen-help hidden" role="dialog" aria-modal="true" aria-labelledby="fullscreen-help-title" aria-hidden="true">
    <div class="fullscreen-help-panel">
      <button id="fullscreen-help-close" class="fullscreen-help-close" type="button" aria-label="关闭全屏提示">×</button>
      <small>MOBILE FULLSCREEN</small>
      <h2 id="fullscreen-help-title">需要添加到主屏幕</h2>
      <p>iPhone Safari 不能用网页按钮把整个互动游戏直接全屏。添加到主屏幕后，再从桌面图标打开，就会以无地址栏的全屏模式运行。</p>
      <ol>
        <li>点击 Safari 底部或顶部的分享按钮</li>
        <li>选择“添加到主屏幕”</li>
        <li>从主屏幕上的 Street Rush 图标重新打开</li>
      </ol>
    </div>
  </section>

  <section id="pause-menu" class="pause-menu hidden" role="dialog" aria-modal="true" aria-labelledby="pause-menu-title" aria-hidden="true">
    <div class="pause-menu-panel">
      <small>RACE MENU</small>
      <h2 id="pause-menu-title">暂停驾驶</h2>
      <button id="resume-button" class="pause-primary" type="button">继续比赛</button>
      <button id="race-restart-button" type="button">重新开始</button>
      <button id="race-garage-button" type="button">退出到主菜单</button>
    </div>
  </section>

  <section id="finish" class="finish hidden" role="dialog" aria-modal="true" aria-labelledby="finish-title" aria-describedby="finish-copy" aria-hidden="true">
    <small id="finish-kicker">环线挑战完成</small>
    <h2 id="finish-title">漂亮收车。</h2>
    <div class="result-time" id="finish-time">00:00.000</div>
    <div class="result-summary">
      <div><small>VALID LAPS</small><strong id="finish-valid-laps">0 / 3</strong></div>
      <div><small>BEST LAP</small><strong id="finish-best-lap">--:--.---</strong></div>
      <div><small>RACE PB</small><strong id="finish-race-best">--:--.---</strong></div>
    </div>
    <div class="result-goals" aria-label="奖牌与个人最佳差值">
      <div><small>奖牌</small><strong id="finish-medal" class="medal-value unverified">未认证</strong></div>
      <div><small>相对个人最佳</small><strong id="finish-race-delta" class="timing-delta">首次挑战</strong></div>
      <div><small>当前目标</small><strong id="finish-target">--:--.---</strong></div>
    </div>
    <ol id="finish-laps" class="result-laps" aria-label="逐圈成绩"></ol>
    <p id="finish-copy">数据已记录，下一圈继续压榨极限。</p>
    <button id="restart-button" class="start-button"><span>再跑一次</span><b>R</b></button>
    <button id="garage-button" class="text-button">退出到主菜单</button>
  </section>

  <div class="corner-links">
    <span class="corner-note">SIMCADE FOUNDATION · v0.3</span>
    <button id="about-button" class="corner-button" type="button">说明</button>
  </div>

  <section id="about" class="about hidden" role="dialog" aria-modal="true" aria-labelledby="about-title" aria-hidden="true">
    <div class="about-panel">
      <button id="about-close" class="about-close" type="button" aria-label="关闭说明">×</button>
      <small>PERSONAL WEB EXPERIMENT</small>
      <h2 id="about-title">只是一个非商业驾驶实验。</h2>
      <p>这不是正式发行的游戏，不收费，也不提供任何商业服务。只是个人用来研究浏览器 3D、车辆物理和交互手感的小项目。</p>
      <div class="about-credits">
        <h3>素材署名</h3>
        <p>
          Mazda MX-5 NA — Lexyc16 · CC BY 4.0<br>
          BMW M3 E30 — Martin Trafas · CC BY 4.0<br>
          Porsche GT3 RS — Black Snow · CC BY 4.0<br>
          BMW M5 G90 / Mercedes-AMG GT3 — vecarz · CC BY-NC-SA 4.0<br>
          Downtown City MegaKit — Quaternius · CC0
        </p>
        <a href="/THIRD_PARTY_NOTICES.txt" target="_blank" rel="noopener">完整第三方署名与来源</a>
      </div>
      <span class="about-footnote">车辆名称与商标归各自权利人所有。本页面仅作个人技术演示。</span>
    </div>
  </section>

  <div id="perf" class="perf hidden">-- FPS · PHYS --ms</div>
  <script type="module">
    const bootRetry = document.getElementById('boot-retry-button');
    bootRetry?.addEventListener('click', () => location.reload());
    import('/src/main.js').catch((error) => {
      console.error('[Street Rush] boot failed', error);
      document.getElementById('loading')?.classList.remove('hidden');
      const status = document.getElementById('loading-status');
      if (status) {
        status.textContent = '启动失败 · 请刷新重试';
        status.setAttribute('role', 'alert');
      }
      bootRetry?.classList.remove('hidden');
      bootRetry?.focus();
    });
  </script>
</body>
</html>
~~~~

### src/config.js

~~~~javascript
export const FIXED_DT = 1 / 120;
export const TOTAL_LAPS = 3;

// Positions are normalized along the closed spline so guidance stays valid when
// the render sample count changes. TrackSystem expands them to sample indices and
// metres after the curve has been measured.
export const ROUTE_GUIDANCE = {
  brakePoints: [
    { id: 'brake-01', progress: 0.285, targetSpeedKmh: 165, turnId: 'turn-01' },
    { id: 'brake-02', progress: 0.475, targetSpeedKmh: 135, turnId: 'turn-02' },
    { id: 'brake-03', progress: 0.565, targetSpeedKmh: 125, turnId: 'turn-03' },
    { id: 'brake-04', progress: 0.690, targetSpeedKmh: 120, turnId: 'turn-04' },
    { id: 'brake-05', progress: 0.875, targetSpeedKmh: 115, turnId: 'turn-05' },
  ],
  turns: [
    { id: 'turn-01', progress: 0.335, direction: 'right', severity: 'hard', targetSpeedKmh: 110 },
    { id: 'turn-02', progress: 0.505, direction: 'right', severity: 'medium', targetSpeedKmh: 125 },
    { id: 'turn-03', progress: 0.610, direction: 'left', severity: 'medium', targetSpeedKmh: 115 },
    { id: 'turn-04', progress: 0.735, direction: 'right', severity: 'hard', targetSpeedKmh: 105 },
    { id: 'turn-05', progress: 0.925, direction: 'right', severity: 'hard', targetSpeedKmh: 100 },
  ],
  markers: {
    enabled: true,
    lateralOffset: 9.0,
    poleHeight: 2.2,
    boardWidth: 1.9,
    boardHeight: 0.9,
    boardDepth: 0.12,
  },
};

const baseTire = {
  mu: 1.05,
  longStiffness: 10.5,
  lateralStiffness: 7.2,
  rollingResistance: 0.014,
};

const baseSuspension = {
  restLength: 0.31,
  travel: 0.18,
  springRate: 34000,
  damperBump: 4200,
  damperRebound: 5200,
  antiRoll: 8500,
};

export const CARS = [
  {
    id: 'mx5', name: 'MAZDA MX-5 NA', file: 'mazda-miata-mx5-na.glb',
    speed: 185, accel: 68, grip: 82, mass: 990, power: 116, torque: 136,
    wheelbase: 2.27, trackWidth: 1.42, wheelRadius: 0.29, steer: 0.46,
    idle: 850, redline: 7000, peakRpm: 5500, gears: [3.136, 1.888, 1.330, 1.000, 0.814],
    finalDrive: 4.30, drivetrain: 'RWD', cdA: 0.66, brakeTorque: 2450,
    suspension: { ...baseSuspension, springRate: 28500, damperBump: 3500, damperRebound: 4300, antiRoll: 6200 },
    tire: { ...baseTire, mu: 0.98, lateralStiffness: 6.6 },
    model: { targetLength: 4.05, yaw: 0, groundOffset: 0.66 },
    audio: { family: 'i4', cylinders: 4, low: 118, mid: 920, high: 2450, drive: 1.25 },
  },
  {
    id: 'm3e30', name: 'BMW M3 E30', file: 'bmw-m3-e30.glb',
    speed: 230, accel: 78, grip: 86, mass: 1200, power: 200, torque: 240,
    wheelbase: 2.56, trackWidth: 1.43, wheelRadius: 0.31, steer: 0.43,
    idle: 900, redline: 7250, peakRpm: 4750, gears: [3.720, 2.400, 1.770, 1.260, 1.000],
    finalDrive: 3.25, drivetrain: 'RWD', cdA: 0.68, brakeTorque: 3100,
    suspension: { ...baseSuspension, springRate: 32000, antiRoll: 7600 },
    tire: { ...baseTire, mu: 1.04, lateralStiffness: 7.0 },
    model: { targetLength: 4.35, yaw: 0, groundOffset: 0.68 },
    audio: { family: 'i4', cylinders: 4, low: 126, mid: 1080, high: 2700, drive: 1.35 },
  },
  {
    id: 'gt3rs', name: 'PORSCHE GT3 RS', file: 'porsche-gt3-rs.glb',
    speed: 296, accel: 96, grip: 98, mass: 1450, power: 525, torque: 465,
    wheelbase: 2.46, trackWidth: 1.62, wheelRadius: 0.335, steer: 0.41,
    idle: 900, redline: 9000, peakRpm: 6300, gears: [3.750, 2.290, 1.720, 1.340, 1.110, 0.960, 0.840],
    finalDrive: 4.25, drivetrain: 'RWD', cdA: 0.862, brakeTorque: 4550,
    suspension: { ...baseSuspension, restLength: 0.27, springRate: 44000, damperBump: 5200, damperRebound: 6500, antiRoll: 12500 },
    tire: { ...baseTire, mu: 1.27, longStiffness: 12.5, lateralStiffness: 8.8 },
    model: { targetLength: 4.55, yaw: 0, groundOffset: 0.64 },
    audio: { family: 'flat6', cylinders: 6, low: 102, mid: 760, high: 3180, drive: 1.42 },
  },
  {
    id: 'lp700', name: 'LAMBORGHINI LP700', file: 'lamborghini-aventador-lp700.glb',
    speed: 350, accel: 99, grip: 91, mass: 1680, power: 700, torque: 690,
    wheelbase: 2.70, trackWidth: 1.72, wheelRadius: 0.345, steer: 0.39,
    idle: 850, redline: 8500, peakRpm: 5500, gears: [3.910, 2.440, 1.810, 1.460, 1.190, 0.970, 0.840],
    finalDrive: 3.73, drivetrain: 'AWD', cdA: 0.72, brakeTorque: 4850,
    suspension: { ...baseSuspension, restLength: 0.28, springRate: 46500, damperBump: 5400, damperRebound: 6800, antiRoll: 13200 },
    tire: { ...baseTire, mu: 1.18, longStiffness: 12.0, lateralStiffness: 8.2 },
    model: { targetLength: 4.78, yaw: 0, groundOffset: 0.65 },
    audio: { family: 'v12', cylinders: 12, low: 94, mid: 690, high: 3900, drive: 1.48 },
  },
  {
    id: 'amggt3', name: 'MERCEDES AMG GT3', file: 'mercedes-amg-gt3.glb',
    speed: 310, accel: 95, grip: 97, mass: 1285, power: 550, torque: 650,
    wheelbase: 2.63, trackWidth: 1.76, wheelRadius: 0.33, steer: 0.40,
    idle: 1000, redline: 7600, peakRpm: 5200, gears: [2.920, 2.080, 1.590, 1.270, 1.060, 0.900],
    finalDrive: 3.67, drivetrain: 'RWD', cdA: 0.96, brakeTorque: 5200,
    suspension: { ...baseSuspension, restLength: 0.25, springRate: 53000, damperBump: 6200, damperRebound: 7600, antiRoll: 15800 },
    tire: { ...baseTire, mu: 1.34, longStiffness: 13.0, lateralStiffness: 9.2 },
    model: { targetLength: 4.72, yaw: 0, groundOffset: 0.63 },
    audio: { family: 'v8', cylinders: 8, low: 82, mid: 620, high: 2260, drive: 1.62 },
  },
  {
    id: 'm5g90', name: 'BMW M5 G90', file: 'bmw-m5-g90.glb',
    speed: 305, accel: 94, grip: 89, mass: 2435, power: 727, torque: 1000,
    wheelbase: 3.01, trackWidth: 1.70, wheelRadius: 0.36, steer: 0.37,
    idle: 700, redline: 7200, peakRpm: 2500, gears: [5.000, 3.200, 2.143, 1.720, 1.314, 1.000, 0.823, 0.640],
    finalDrive: 3.15, drivetrain: 'AWD', cdA: 0.70, brakeTorque: 5850,
    suspension: { ...baseSuspension, restLength: 0.30, springRate: 51500, damperBump: 5900, damperRebound: 7300, antiRoll: 14500 },
    tire: { ...baseTire, mu: 1.12, longStiffness: 11.5, lateralStiffness: 7.7 },
    model: { targetLength: 5.10, yaw: 0, groundOffset: 0.72 },
    audio: { family: 'v8', cylinders: 8, low: 76, mid: 540, high: 1880, drive: 1.58 },
  },
];

export const TRACK_CONFIG = {
  name: '龙湾国际赛道',
  width: 14,
  runoff: 4.5,
  barrierOffset: 11.6,
  samples: 1024,
  checkpoints: 10,
  routeGuidance: ROUTE_GUIDANCE,
  points: [
    [-320, 0, 0], [-110, 0, 0], [115, 0, 0], [325, 0, 0],
    [405, 0, -32], [445, 0, -108], [428, 0, -178], [365, 0, -228],
    [270, 0, -250], [178, 0, -224], [92, 0, -182], [8, 0, -214],
    [-78, 0, -278], [-185, 0, -298], [-292, 0, -260], [-372, 0, -198],
    [-428, 0, -120], [-446, 0, -48], [-424, 0, 12], [-385, 0, 28],
  ],
};

export const SURFACES = {
  asphalt: { grip: 1, rolling: 1, label: 'SPORT' },
  kerb: { grip: 0.94, rolling: 1.25, label: 'KERB' },
  gravel: { grip: 0.58, rolling: 4.2, label: 'GRAVEL' },
  grass: { grip: 0.48, rolling: 3.2, label: 'GRASS' },
};
~~~~

### src/input.js

~~~~javascript
import * as THREE from 'three';

const INTERACTIVE_KEYBOARD_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select']);
const GAMEPLAY_PREVENT_DEFAULT_CODES = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space']);
const GAMEPAD_STICK_DEADZONE = 0.08;
const GAMEPAD_BUTTON_DEADZONE = 0.05;
const GAMEPAD_INPUT_BUTTONS = [0, 3, 4, 5, 6, 7, 9];
const FIXED_PULSE_CODES = [
  'KeyE',
  'KeyQ',
  'KeyC',
  'KeyR',
  'PadShiftUp',
  'PadShiftDown',
  'PadReset',
  'TouchShiftUp',
  'TouchShiftDown',
  'TouchTransmission',
  'TouchReset',
];

function gamepadButtonIsActive(pad, index) {
  const button = pad?.buttons?.[index];
  return Boolean(button?.pressed) || (button?.value || 0) > GAMEPAD_BUTTON_DEADZONE;
}

function gamepadHasInput(pad) {
  const axis = pad?.axes?.[0] || 0;
  return Math.abs(axis) > GAMEPAD_STICK_DEADZONE
    || GAMEPAD_INPUT_BUTTONS.some((index) => gamepadButtonIsActive(pad, index));
}

function isInteractiveKeyboardTarget(target) {
  if (!target) return false;
  if (target.isContentEditable || target.contentEditable === 'true' || target.contentEditable === 'plaintext-only') {
    return true;
  }

  const tagName = typeof target.tagName === 'string' ? target.tagName.toLowerCase() : '';
  if (INTERACTIVE_KEYBOARD_TAGS.has(tagName)) return true;

  return typeof target.closest === 'function'
    && Boolean(target.closest('button, a, input, textarea, select, [contenteditable]'));
}

function shouldIgnoreKeyboardShortcut(event) {
  return Boolean(event.ctrlKey || event.metaKey || event.altKey || isInteractiveKeyboardTarget(event.target));
}

export function updateKeyboardSteer(current, rawSteer, speedKmh, dt) {
  const highSpeed = THREE.MathUtils.clamp(speedKmh / 240, 0, 1);
  const keyboardTravel = THREE.MathUtils.lerp(1, 0.48, THREE.MathUtils.clamp(speedKmh / 190, 0, 1));
  const targetSteer = rawSteer * keyboardTravel;
  const turningRate = THREE.MathUtils.lerp(1.75, 0.72, highSpeed);
  const centeringRate = THREE.MathUtils.lerp(3.4, 2.25, highSpeed);
  const reversingDirection = targetSteer !== 0 && Math.sign(targetSteer) !== Math.sign(current);
  const rate = targetSteer === 0 || reversingDirection ? centeringRate : turningRate;
  const maximumChange = rate * dt;
  return current + THREE.MathUtils.clamp(targetSteer - current, -maximumChange, maximumChange);
}

export function updatePedal(current, target, riseRate, releaseRate, dt) {
  return THREE.MathUtils.damp(current, target, target > current ? riseRate : releaseRate, dt);
}

export function resolveDriveIntent(rawThrottle, rawBrake) {
  const forward = rawThrottle > 0.05;
  const reverse = rawBrake > 0.05;
  if (forward && !reverse) return 1;
  if (reverse && !forward) return -1;
  if (forward && reverse) {
    if (rawThrottle > rawBrake + 0.05) return 1;
    if (rawBrake > rawThrottle + 0.05) return -1;
  }
  return 0;
}

export class InputController {
  constructor() {
    this.keys = new Set();
    this.keyboardRearm = new Set();
    this.frame = {
      steer: 0,
      throttle: 0,
      brake: 0,
      handbrake: 0,
      shiftUp: false,
      shiftDown: false,
      toggleTransmission: false,
      reset: false,
      driveIntent: 0,
    };
    this.pulses = new Set();
    this.padButtons = { up: false, down: false, reset: false };
    this.gamepadRearmPending = false;
    this.gamepadConnected = false;
    this.gamepad = null;
    this.menuGamepad = null;
    this.menuGamepadDown = false;
    this.menuGamepadRearmPending = false;
    this.touchPointerResets = new Set();
    this.pointerCaptures = new Map();
    this.touchPointerRearm = new Set();
    this.touchKeyboardReleases = new Set();
    this.touch = {
      enabled: false,
      steerLeft: 0,
      steerRight: 0,
      throttle: 0,
      brake: 0,
      handbrake: 0,
    };
    this.onKeyDown = (event) => {
      if (shouldIgnoreKeyboardShortcut(event)) {
        this.keys.delete(event.code);
        this.pulses.delete(event.code);
        return;
      }
      if (GAMEPLAY_PREVENT_DEFAULT_CODES.has(event.code)) event.preventDefault();
      if (this.keyboardRearm.has(event.code)) return;
      const alreadyDown = this.keys.has(event.code);
      if (event.repeat && !alreadyDown) return;
      this.keys.add(event.code);
      if (!event.repeat && !alreadyDown) this.pulses.add(event.code);
    };
    this.onKeyUp = (event) => {
      this.keys.delete(event.code);
      this.keyboardRearm.delete(event.code);
      for (const release of this.touchKeyboardReleases) release(event.code);
    };
    this.releaseAll = () => {
      for (const code of this.keys) this.keyboardRearm.add(code);
      this.keys.clear();
      this.pulses.clear();
      this.frame.steer = 0;
      this.frame.throttle = 0;
      this.frame.brake = 0;
      this.frame.handbrake = 0;
      this.frame.shiftUp = false;
      this.frame.shiftDown = false;
      this.frame.toggleTransmission = false;
      this.frame.reset = false;
      this.frame.driveIntent = 0;
      this.padButtons = { up: false, down: false, reset: false };
      this.gamepadRearmPending = true;
      this.menuGamepadDown = false;
      this.menuGamepadRearmPending = true;
      this.releaseTouch();
    };
    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    const clearPointerRearm = (event) => {
      if (event.pointerId !== undefined && event.pointerId !== null) {
        this.touchPointerRearm.delete(event.pointerId);
      }
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      addEventListener(type, clearPointerRearm);
      document.addEventListener(type, clearPointerRearm);
    }
    addEventListener('blur', this.releaseAll);
    addEventListener('pagehide', this.releaseAll);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
    this.setupTouchControls();
  }

  registerPointerCapture(element, pointerId) {
    if (this.touchPointerRearm.has(pointerId)) return false;
    let pointerIds = this.pointerCaptures.get(element);
    if (!pointerIds) {
      pointerIds = new Set();
      this.pointerCaptures.set(element, pointerIds);
    }
    pointerIds.add(pointerId);

    try {
      element.setPointerCapture?.(pointerId);
    } catch {
      pointerIds.delete(pointerId);
      if (pointerIds.size === 0) this.pointerCaptures.delete(element);
      return false;
    }
    return true;
  }

  releasePointerCapture(element, pointerId) {
    const pointerIds = this.pointerCaptures.get(element);
    if (!pointerIds?.has(pointerId)) return;
    pointerIds.delete(pointerId);
    if (pointerIds.size === 0) this.pointerCaptures.delete(element);

    try {
      element.releasePointerCapture?.(pointerId);
    } catch {
      // The browser may already have released the capture.
    }
  }

  releaseAllPointerCaptures() {
    const captures = [];
    for (const [element, pointerIds] of this.pointerCaptures) {
      for (const pointerId of pointerIds) captures.push({ element, pointerId });
    }
    this.pointerCaptures.clear();

    for (const { element, pointerId } of captures) {
      try {
        element.releasePointerCapture?.(pointerId);
      } catch {
        // The browser may already have released the capture.
      }
    }
  }

  setupTouchControls() {
    const root = document.getElementById('mobile-controls');
    if (!root) return;

    const vibrate = (duration = 8) => navigator.vibrate?.(duration);

    const bindHold = (id, field) => {
      const element = document.getElementById(id);
      if (!element) return;
      const activePointers = new Set();
      const activeKeyboardCodes = new Set();
      const keyboardRearm = new Set();
      const keyboardPointerId = (code) => `keyboard:${id}:${code}`;
      const clearKeyboardPointers = () => {
        for (const code of activeKeyboardCodes) keyboardRearm.add(code);
        for (const code of activeKeyboardCodes) activePointers.delete(keyboardPointerId(code));
        activeKeyboardCodes.clear();
      };
      const clearPointers = () => {
        clearKeyboardPointers();
        activePointers.clear();
        this.touch[field] = 0;
        element.classList.remove('pressed');
      };
      const releaseKeyboard = (code) => {
        if (!activeKeyboardCodes.has(code) && !keyboardRearm.has(code)) return;
        activeKeyboardCodes.delete(code);
        keyboardRearm.delete(code);
        activePointers.delete(keyboardPointerId(code));
        if (activePointers.size === 0) clearPointers();
      };
      this.touchKeyboardReleases.add(releaseKeyboard);
      const keyboardPress = (event) => {
        if (!this.touch.enabled || !['Enter', 'Space'].includes(event.code)) return;
        event.preventDefault();
        if (event.repeat || keyboardRearm.has(event.code) || activeKeyboardCodes.has(event.code)) return;
        activeKeyboardCodes.add(event.code);
        activePointers.add(keyboardPointerId(event.code));
        this.touch[field] = 1;
        element.classList.add('pressed');
      };
      const keyboardRelease = (event) => {
        if (!['Enter', 'Space'].includes(event.code)) return;
        releaseKeyboard(event.code);
      };
      this.touchPointerResets.add(clearPointers);
      const release = (event) => {
        const awaitingRelease = this.touchPointerRearm.has(event.pointerId);
        if (event.type === 'pointerup' || event.type === 'pointercancel' || !awaitingRelease) {
          this.touchPointerRearm.delete(event.pointerId);
        }
        activePointers.delete(event.pointerId);
        this.releasePointerCapture(element, event.pointerId);
        if (activePointers.size > 0) return;
        clearPointers();
      };
      element.addEventListener('pointerdown', (event) => {
        if (!this.touch.enabled || this.touchPointerRearm.has(event.pointerId)) return;
        event.preventDefault();
        if (!this.registerPointerCapture(element, event.pointerId)) return;
        activePointers.add(event.pointerId);
        this.touch[field] = 1;
        element.classList.add('pressed');
        vibrate(field === 'handbrake' ? 12 : field.startsWith('steer') ? 5 : 6);
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        element.addEventListener(type, release);
      }
      element.addEventListener('keydown', keyboardPress);
      element.addEventListener('keyup', keyboardRelease);
      element.addEventListener('blur', () => {
        clearKeyboardPointers();
        if (activePointers.size === 0) {
          this.touch[field] = 0;
          element.classList.remove('pressed');
        }
      });
    };

    const bindPulse = (id, pulse) => {
      const element = document.getElementById(id);
      if (!element) return;
      const activePointers = new Set();
      const clearPointers = () => {
        activePointers.clear();
        element.classList.remove('pressed');
      };
      this.touchPointerResets.add(clearPointers);
      const release = (event) => {
        const awaitingRelease = this.touchPointerRearm.has(event.pointerId);
        if (event.type === 'pointerup' || event.type === 'pointercancel' || !awaitingRelease) {
          this.touchPointerRearm.delete(event.pointerId);
        }
        activePointers.delete(event.pointerId);
        this.releasePointerCapture(element, event.pointerId);
        if (activePointers.size === 0) element.classList.remove('pressed');
      };
      element.addEventListener('pointerdown', (event) => {
        if (!this.touch.enabled || this.touchPointerRearm.has(event.pointerId)) return;
        event.preventDefault();
        if (!this.registerPointerCapture(element, event.pointerId)) return;
        activePointers.add(event.pointerId);
        this.pulses.add(pulse);
        element.classList.add('pressed');
        vibrate(10);
      });
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        element.addEventListener(type, release);
      }
      element.addEventListener('click', (event) => {
        if (!this.touch.enabled || event.detail !== 0) return;
        this.pulses.add(pulse);
        element.classList.add('pressed');
        vibrate(10);
        setTimeout(() => element.classList.remove('pressed'), 80);
      });
    };

    bindHold('touch-left', 'steerLeft');
    bindHold('touch-right', 'steerRight');
    bindHold('touch-throttle', 'throttle');
    bindHold('touch-brake', 'brake');
    bindHold('touch-handbrake', 'handbrake');
    bindPulse('touch-reset', 'TouchReset');
    bindPulse('touch-mode', 'TouchTransmission');
    bindPulse('touch-shift-up', 'TouchShiftUp');
    bindPulse('touch-shift-down', 'TouchShiftDown');
    root.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  setTouchEnabled(enabled) {
    this.touch.enabled = enabled;
    if (!enabled) this.releaseTouch();
  }

  releaseTouch() {
    for (const pointerIds of this.pointerCaptures.values()) {
      for (const pointerId of pointerIds) this.touchPointerRearm.add(pointerId);
    }
    this.releaseAllPointerCaptures();
    for (const clearPointers of this.touchPointerResets) clearPointers();
    this.touch.steerLeft = 0;
    this.touch.steerRight = 0;
    this.touch.throttle = 0;
    this.touch.brake = 0;
    this.touch.handbrake = 0;
    document.querySelectorAll('.mobile-controls .pressed').forEach((element) => element.classList.remove('pressed'));
  }

  consumePulse(code) {
    const hit = this.pulses.has(code);
    this.pulses.delete(code);
    return hit;
  }

  consumeGamepadMenuPulse() {
    const pads = navigator.getGamepads?.() || [];
    const pad = Array.from(pads).find((candidate) => candidate && candidate.connected !== false) || null;
    const replaced = Boolean(pad && this.menuGamepad && pad !== this.menuGamepad);
    if (!pad) {
      this.menuGamepad = null;
      this.menuGamepadDown = false;
      this.menuGamepadRearmPending = false;
      return false;
    }
    if (replaced) {
      this.menuGamepadDown = false;
      this.menuGamepadRearmPending = true;
    }
    this.menuGamepad = pad;
    const down = gamepadButtonIsActive(pad, 9);
    if (this.menuGamepadRearmPending) {
      this.menuGamepadDown = down;
      if (!down) this.menuGamepadRearmPending = false;
      return false;
    }
    const pressed = down && !this.menuGamepadDown;
    this.menuGamepadDown = down;
    return pressed;
  }

  consumeFixedPulses() {
    for (const code of FIXED_PULSE_CODES) this.pulses.delete(code);
    this.frame.shiftUp = false;
    this.frame.shiftDown = false;
    this.frame.toggleTransmission = false;
    this.frame.reset = false;
  }

  update(dt, speedKmh = 0, { deferFixedPulses = false } = {}) {
    let rawSteer = (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0)
      - (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0);
    let rawThrottle = this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0;
    let rawBrake = this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0;
    let rawHandbrake = this.keys.has('Space') ? 1 : 0;

    let analogSteer = null;
    if (this.touch.enabled) {
      rawSteer = THREE.MathUtils.clamp(rawSteer + this.touch.steerLeft - this.touch.steerRight, -1, 1);
      rawThrottle = Math.max(rawThrottle, this.touch.throttle);
      rawBrake = Math.max(rawBrake, this.touch.brake);
      rawHandbrake = Math.max(rawHandbrake, this.touch.handbrake);
    }
    const pads = navigator.getGamepads?.() || [];
    const pad = Array.from(pads).find((candidate) => candidate && candidate.connected !== false);
    const gamepadReplaced = Boolean(pad && this.gamepad && pad !== this.gamepad);
    if ((this.gamepadConnected && !pad) || gamepadReplaced) {
      this.gamepadRearmPending = true;
      this.padButtons = { up: false, down: false, reset: false };
    }
    this.gamepadConnected = Boolean(pad);
    this.gamepad = pad || null;
    const activePad = pad && (!this.gamepadRearmPending || !gamepadHasInput(pad)) ? pad : null;
    if (activePad) {
      if (this.gamepadRearmPending) this.gamepadRearmPending = false;
      const stick = Math.abs(activePad.axes[0] || 0) > GAMEPAD_STICK_DEADZONE ? activePad.axes[0] : 0;
      const shaped = Math.sign(stick) * Math.pow(Math.abs(stick), 1.45);
      if (Math.abs(shaped) > 0 && analogSteer === null) analogSteer = -shaped;
      rawThrottle = Math.max(rawThrottle, activePad.buttons[7]?.value || 0);
      rawBrake = Math.max(rawBrake, activePad.buttons[6]?.value || 0);
      rawHandbrake = Math.max(rawHandbrake, activePad.buttons[0]?.value || 0);
      const padUp = Boolean(activePad.buttons[5]?.pressed);
      const padDown = Boolean(activePad.buttons[4]?.pressed);
      const padReset = Boolean(activePad.buttons[3]?.pressed);
      if (padUp && !this.padButtons.up) this.pulses.add('PadShiftUp');
      if (padDown && !this.padButtons.down) this.pulses.add('PadShiftDown');
      if (padReset && !this.padButtons.reset) this.pulses.add('PadReset');
      this.padButtons = { up: padUp, down: padDown, reset: padReset };
    } else {
      this.padButtons = { up: false, down: false, reset: false };
    }

    if (analogSteer !== null) {
      this.frame.steer = THREE.MathUtils.damp(this.frame.steer, analogSteer, 15, dt);
    } else {
      this.frame.steer = updateKeyboardSteer(this.frame.steer, rawSteer, speedKmh, dt);
    }
    this.frame.driveIntent = resolveDriveIntent(rawThrottle, rawBrake);
    this.frame.throttle = updatePedal(this.frame.throttle, rawThrottle, 4.3, 7.5, dt);
    this.frame.brake = updatePedal(this.frame.brake, rawBrake, 7.5, 11, dt);
    this.frame.handbrake = THREE.MathUtils.damp(this.frame.handbrake, rawHandbrake, 14, dt);
    const pulse = (code) => deferFixedPulses ? this.pulses.has(code) : this.consumePulse(code);
    this.frame.shiftUp = pulse('KeyE') || pulse('PadShiftUp') || pulse('TouchShiftUp');
    this.frame.shiftDown = pulse('KeyQ') || pulse('PadShiftDown') || pulse('TouchShiftDown');
    this.frame.toggleTransmission = pulse('KeyC') || pulse('TouchTransmission');
    this.frame.reset = pulse('KeyR') || pulse('PadReset') || pulse('TouchReset');
    return this.frame;
  }
}
~~~~

### src/main.js

~~~~javascript
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import RAPIER from '@dimforge/rapier3d-compat';
import './style.css';
import { CARS, FIXED_DT, TOTAL_LAPS, TRACK_CONFIG } from './config.js';
import { InputController } from './input.js';
import { TrackSystem } from './track.js';
import { createGameAssetManager } from './game-assets.js';
import { VehicleSystem, disposeOwnedVisual } from './vehicle.js';
import { ProceduralAudio } from './audio.js';
import { createGameAudioProfile, GAME_AUDIO_BANKS } from './game-audio-banks.js';
import { ChaseCamera, TireEffects } from './effects.js';
import { RaceTimingSession, TimingStore, formatRaceDelta, formatRaceTime } from './race-timing.js';
import { getLiveRaceGoal, LONGWAN_TIME_ATTACK, MIN_LIVE_GOAL_CHECKPOINTS } from './race-goals.js';
import { clampFrameDelta } from './physics-scheduling.js';
import { loadSharedCoreCapabilities } from './shared-core-owner.js';
import { initializeRapier } from './rapier-init.js';
import { getOrientationUiState, ORIENTATIONS, shouldFreezeRace } from './orientation.js';

const $ = (id) => document.getElementById(id);
const schedulerFault = import.meta.env.DEV
  ? new URLSearchParams(location.search).get('scheduler-fault')
  : null;
const sharedCorePromise = loadSharedCoreCapabilities(
  schedulerFault === 'missing-wasm'
    ? { wasmUrl: '/__streetrush_missing_core.wasm' }
    : undefined,
);
const MEDAL_LABELS = { gold: '金牌', silver: '银牌', bronze: '铜牌' };
const touchCapable = matchMedia('(pointer: coarse)').matches
  || navigator.maxTouchPoints > 0
  || new URLSearchParams(location.search).has('touch');
document.documentElement.classList.toggle('touch-ui', touchCapable);
const standaloneMode = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const canvas = $('game');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
const MAX_RENDER_SCALE = touchCapable ? 1.5 : 1.35;
const PIXEL_BUDGET = touchCapable ? 1_300_000 : 3_200_000;
const getRenderScaleLimit = () => Math.min(
  devicePixelRatio,
  MAX_RENDER_SCALE,
  Math.max(0.72, Math.sqrt(PIXEL_BUDGET / Math.max(1, innerWidth * innerHeight))),
);
let renderScale = getRenderScaleLimit();
renderer.setPixelRatio(Math.min(devicePixelRatio, renderScale));
renderer.setSize(innerWidth, innerHeight);
// The supplied car models are far denser than typical web-game assets. A small
// contact shadow keeps them grounded visually without rendering the whole scene
// a second time into a realtime shadow map.
renderer.shadowMap.enabled = false;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xa9c8dc);
scene.fog = new THREE.FogExp2(0xb8cbd3, 0.00072);
// A prefiltered static environment gives metallic paint and glass something to
// reflect without bringing realtime reflections back into the frame budget.
const environmentGenerator = new THREE.PMREMGenerator(renderer);
const roomEnvironment = new RoomEnvironment();
scene.environment = environmentGenerator.fromScene(roomEnvironment, 0.04).texture;
scene.environmentIntensity = 0.72;
roomEnvironment.dispose();
environmentGenerator.dispose();
const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 1300);

scene.add(new THREE.HemisphereLight(0xdcefff, 0x66705a, 1.72));
scene.add(new THREE.AmbientLight(0xaebdca, 0.26));
const sun = new THREE.DirectionalLight(0xffe6bc, 4.25);
sun.position.set(-180, 260, 110);
scene.add(sun);
await initializeRapier(RAPIER);
const physicsWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
physicsWorld.integrationParameters.dt = FIXED_DT;
const track = new TrackSystem(TRACK_CONFIG, scene, renderer, RAPIER, physicsWorld);
const assets = createGameAssetManager(scene, track);
const input = new InputController();
const audio = new ProceduralAudio({
  bankDocument: GAME_AUDIO_BANKS,
  resolveBankProfile: createGameAudioProfile,
  onBankEvent: (event) => recordDevEvent('audio-bank', { event }),
});
document.documentElement.dataset.audioPaused = 'false';
const effects = new TireEffects(scene);
const chaseCamera = new ChaseCamera(camera);
const timingStore = new TimingStore();

let carIndex = 0;
let vehicle = null;
let vehicleLoadToken = 0;
let vehicleLoadPending = false;
let queuedVehicleIndex = null;
let retryCarIndex = null;
let state = 'menu';
let stateBeforePause = 'race';
let physicsScheduler = null;
let raceProgressCore = null;
let lastFrame = performance.now();
let countdown = 0;
let countdownShown = 0;
let timing = null;
let lastSectorEvent = null;
let lastLapEvent = null;
let startLightsTimer = null;
let performanceVisible = false;
let fpsAccumulator = 0;
let fpsFrames = 0;
let physicsCost = 0;
let slowFrameWindows = 0;
let inputBlockedLastFrame = false;
let fullscreenHelpShown = false;
let devTelemetry = null;
let devFixedStepIndex = 0;
const MODAL_DIALOG_IDS = ['orientation-hint', 'fullscreen-help', 'pause-menu', 'finish', 'about'];
const dialogReturnFocus = new Map();

function resetPhysicsScheduler() {
  physicsScheduler?.reset();
}

function setAudioPaused(paused) {
  audio.setPaused(paused);
  document.documentElement.dataset.audioPaused = String(audio.paused);
}

function initializeAudio() {
  return audio.init()
    .then(() => audio.whenBankSettled())
    .finally(() => publishDevVehicleReadiness());
}

const devToolsRequested = import.meta.env.DEV && new URLSearchParams(location.search).has('devtools');
if (devToolsRequested) {
  const { DevTelemetryBuffer } = await import('./dev-telemetry.js');
  devTelemetry = new DevTelemetryBuffer({ capacity: 2048 });
}

function getDevReadiness() {
  const selectedCar = CARS[carIndex];
  const vehicleMatchesSelection = Boolean(vehicle && selectedCar && vehicle.config.id === selectedCar.id);
  const startableState = state === 'menu' || state === 'finish' || state === 'paused';
  const restartable = state === 'race' && timing?.snapshot().currentLapValid === false;
  const visualWheelSet = vehicle?.visual?.getObjectByName?.('calibrated-wheels');
  const audioBank = audio.snapshot().bank;
  return {
    assetSource: vehicle?.visual?.userData?.source ?? null,
    vehicleLoadPending,
    selectedCarId: selectedCar?.id ?? null,
    mountedCarId: vehicle?.config?.id ?? null,
    visualWheelBindingCount: vehicle?.visualWheelBindings?.length ?? 0,
    visualWheelSource: visualWheelSet?.userData?.visualWheelSource ?? null,
    audioBankState: audioBank.state,
    audioBankId: audioBank.player?.bankId ?? null,
    audioBankMode: audioBank.resolution?.mode ?? null,
    audioBankError: audioBank.error,
    physicsSchedulerOwner: physicsScheduler?.owner ?? null,
    physicsSchedulerFallback: physicsScheduler?.fallbackReason ?? null,
    state,
    restartable,
    startable: Boolean(startableState && !vehicleLoadPending && vehicleMatchesSelection && vehicle?.visual?.userData?.source === 'gltf'),
  };
}

function publishDevVehicleReadiness() {
  if (!import.meta.env.DEV) return;
  const visualWheelSet = vehicle?.visual?.getObjectByName?.('calibrated-wheels');
  const audioBank = audio.snapshot().bank;
  document.documentElement.dataset.mountedCarId = vehicle?.config?.id ?? '';
  document.documentElement.dataset.visualWheelBindingCount = String(vehicle?.visualWheelBindings?.length ?? 0);
  document.documentElement.dataset.visualWheelSource = visualWheelSet?.userData?.visualWheelSource ?? 'none';
  document.documentElement.dataset.audioBankState = audioBank.state;
  document.documentElement.dataset.audioBankId = audioBank.player?.bankId ?? 'none';
  document.documentElement.dataset.audioBankMode = audioBank.resolution?.mode ?? 'procedural';
}

function recordDevEvent(type, details = {}) {
  if (!devTelemetry) return false;
  try {
    return devTelemetry.record({
      type,
      state,
      fixedStepIndex: devFixedStepIndex,
      ...details,
    });
  } catch (error) {
    console.warn('[dev-telemetry] ignored event', error);
    return false;
  }
}

if (devToolsRequested) {
  globalThis.__STREET_RUSH_DEV__ = Object.freeze({
    getReadiness: getDevReadiness,
    record: (event) => {
      try {
        return devTelemetry.record(event);
      } catch (error) {
        console.warn('[dev-telemetry] ignored event', error);
        return false;
      }
    },
    snapshot: () => devTelemetry.snapshot(),
    clear: () => devTelemetry.clear(),
    serialize: () => devTelemetry.serialize(),
  });
}

function focusVisibleElement(element) {
  if (!(element instanceof HTMLElement)
    || !element.isConnected
    || element.disabled
    || element.closest('.hidden')
    || getComputedStyle(element).visibility === 'hidden'
    || getComputedStyle(element).display === 'none') return false;
  element.focus({ preventScroll: true });
  return true;
}

function openModalDialog(id, trigger = document.activeElement) {
  const dialog = $(id);
  if (!dialog) return;
  for (const otherId of MODAL_DIALOG_IDS) {
    if (otherId !== id) closeModalDialog(otherId, false);
  }
  const returnTarget = trigger instanceof HTMLElement ? trigger : document.activeElement;
  const canRestoreFocus = returnTarget instanceof HTMLElement
    && returnTarget !== dialog
    && !returnTarget.closest('.hidden')
    && getComputedStyle(returnTarget).display !== 'none'
    && getComputedStyle(returnTarget).visibility !== 'hidden';
  if (canRestoreFocus) dialogReturnFocus.set(id, returnTarget);
  dialog.classList.remove('hidden');
  dialog.setAttribute('aria-hidden', 'false');
  const firstFocusable = Array.from(dialog.querySelectorAll('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])'))
    .find((element) => !element.disabled && getComputedStyle(element).visibility !== 'hidden');
  firstFocusable?.focus({ preventScroll: true });
}

function closeModalDialog(id, restoreFocus = true) {
  const dialog = $(id);
  if (!dialog) return;
  dialog.classList.add('hidden');
  dialog.setAttribute('aria-hidden', 'true');
  if (id === 'fullscreen-help') {
    fullscreenHelpShown = false;
    input.releaseAll();
    resetPhysicsScheduler();
    lastFrame = performance.now();
  }
  if (id === 'orientation-hint') dialog.setAttribute('inert', '');
  if (!restoreFocus) {
    dialogReturnFocus.delete(id);
    return;
  }
  const returnTarget = dialogReturnFocus.get(id);
  dialogReturnFocus.delete(id);
  focusVisibleElement(returnTarget);
}

function closeAllModalDialogs(restoreFocus = false) {
  for (const id of MODAL_DIALOG_IDS) closeModalDialog(id, restoreFocus);
}

function getOpenModalDialog() {
  return MODAL_DIALOG_IDS
    .map((id) => $(id))
    .find((dialog) => dialog && !dialog.classList.contains('hidden')) ?? null;
}

function trapModalFocus(event) {
  const dialog = getOpenModalDialog();
  if (!dialog || event.code !== 'Tab') return false;
  const focusable = Array.from(dialog.querySelectorAll('button, a[href], input, textarea, select, [tabindex]:not([tabindex="-1"])'))
    .filter((element) => !element.disabled && getComputedStyle(element).visibility !== 'hidden');
  if (focusable.length === 0) return false;
  const currentIndex = focusable.indexOf(document.activeElement);
  const nextIndex = event.shiftKey
    ? currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1
    : currentIndex === focusable.length - 1 ? 0 : currentIndex + 1;
  event.preventDefault();
  focusable[nextIndex].focus({ preventScroll: true });
  return true;
}

for (const id of MODAL_DIALOG_IDS) $(id)?.setAttribute('aria-hidden', 'true');

function isAppleTouchDevice() {
  const classicIOS = /iPad|iPhone|iPod/i.test(navigator.userAgent);
  const touchMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return classicIOS || touchMac;
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement;
}

function syncFullscreenButton() {
  const active = Boolean(fullscreenElement());
  $('fullscreen-button').hidden = isAppleTouchDevice() && standaloneMode;
  $('fullscreen-button').classList.toggle('active', active);
  $('fullscreen-button').setAttribute('aria-label', active ? '退出全屏' : '进入全屏');
  $('orientation-fullscreen').hidden = standaloneMode;
}

function syncOrientationHint() {
  const hint = $('orientation-hint');
  if (!hint) return;
  const orientationState = getOrientationUiState({
    touchCapable,
    raceActive: state === 'race' || state === 'countdown',
    orientation: matchMedia('(orientation: portrait)').matches ? ORIENTATIONS.PORTRAIT : ORIENTATIONS.LANDSCAPE,
    fullscreenHelpOpen: fullscreenHelpShown,
  });
  const raceActive = state === 'race' || state === 'countdown';
  const openModal = getOpenModalDialog();
  const blockedByAnotherModal = openModal && openModal.id !== 'orientation-hint';
  const shouldShow = orientationState.orientationHintVisible && raceActive && !blockedByAnotherModal;
  if (!shouldShow) {
    if (!hint.classList.contains('hidden')) {
      closeModalDialog('orientation-hint');
      input.releaseAll();
      resetPhysicsScheduler();
      lastFrame = performance.now();
    }
    else {
      hint.setAttribute('aria-hidden', 'true');
      hint.setAttribute('inert', '');
    }
    return;
  }
  if (hint.classList.contains('hidden') || hint.getAttribute('aria-hidden') !== 'false') {
    input.releaseAll();
    resetPhysicsScheduler();
    lastFrame = performance.now();
    hint.removeAttribute('inert');
    openModalDialog('orientation-hint', document.activeElement);
  }
}

function isRaceBlockedByModal() {
  const openModal = getOpenModalDialog();
  return shouldFreezeRace({
    touchCapable,
    raceActive: state === 'race' || state === 'countdown',
    orientation: matchMedia('(orientation: portrait)').matches ? ORIENTATIONS.PORTRAIT : ORIENTATIONS.LANDSCAPE,
    modalId: openModal?.id ?? null,
  });
}

function showFullscreenHelp() {
  if (fullscreenHelpShown) return;
  fullscreenHelpShown = true;
  openModalDialog('fullscreen-help');
}

async function lockLandscape() {
  try {
    await screen.orientation?.lock?.('landscape');
  } catch {
    // Orientation lock is best-effort and is not exposed by every browser.
  }
}

async function requestPageFullscreen() {
  if (standaloneMode || fullscreenElement()) {
    if (touchCapable) await lockLandscape();
    return;
  }
  if (isAppleTouchDevice()) {
    showFullscreenHelp();
    return;
  }
  const request = document.documentElement.requestFullscreen
    || document.documentElement.webkitRequestFullscreen;
  if (!request) {
    showFullscreenHelp();
    return;
  }
  try {
    await request.call(document.documentElement);
    if (touchCapable) await lockLandscape();
  } catch (error) {
    console.warn('Fullscreen request failed', error);
    showFullscreenHelp();
  }
}

async function togglePageFullscreen() {
  if (standaloneMode) return;
  if (fullscreenElement()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    try {
      await exit?.call(document);
    } catch (error) {
      console.warn('Fullscreen exit failed', error);
    }
  } else {
    await requestPageFullscreen();
  }
  syncFullscreenButton();
}

function showMessage(text, duration = 760) {
  const element = $('race-message');
  element.textContent = text;
  element.style.opacity = 1;
  element.style.transform = 'translate(-50%, -50%) skew(-5deg) scale(1)';
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => {
    element.style.opacity = 0;
    element.style.transform = 'translate(-50%, -50%) skew(-5deg) scale(1.12)';
  }, duration);
}

function syncInvalidLapRestart(snapshot = timing?.snapshot()) {
  const button = $('invalid-lap-restart-button');
  if (!button) return;
  const visible = state === 'race' && snapshot?.currentLapValid === false;
  button.classList.toggle('hidden', !visible);
  button.setAttribute('aria-hidden', String(!visible));
}

function setStartLights(lightState, autoOffMs = 0) {
  clearTimeout(startLightsTimer);
  track.setStartLights(lightState);
  if (autoOffMs > 0) {
    startLightsTimer = setTimeout(() => track.setStartLights('off'), autoOffMs);
  }
}

function setDeltaUI(element, deltaMs, fallback) {
  const hasDelta = Number.isFinite(deltaMs);
  element.textContent = hasDelta ? formatRaceDelta(deltaMs) : fallback;
  element.classList.toggle('ahead', hasDelta && deltaMs < 0);
  element.classList.toggle('behind', hasDelta && deltaMs > 0);
}

function medalTargetsForCar(carId) {
  return LONGWAN_TIME_ATTACK.medalTargetsMs?.[carId] ?? null;
}

function updateRaceGoalUI(snapshot) {
  const label = $('race-target-label');
  const target = $('race-target');
  const delta = $('race-target-delta');
  const goal = getLiveRaceGoal({
    targets: medalTargetsForCar(vehicle?.config.id),
    checkpointsPassed: snapshot.checkpointsPassed,
    totalCheckpoints: TOTAL_LAPS * TRACK_CONFIG.checkpoints,
    runTimeMs: snapshot.runTimeMs,
    currentLapValid: snapshot.currentLapValid,
    laps: snapshot.laps,
  });
  if (goal?.invalid) {
    label.textContent = '本场已无效';
    target.textContent = '不计奖牌';
    delta.textContent = '完成仍可看单圈';
    delta.classList.remove('ahead', 'behind');
    return;
  }
  if (!goal) {
    label.textContent = '下一目标';
    target.textContent = '--:--.---';
    delta.textContent = '目标待定';
    delta.classList.remove('ahead', 'behind');
    return;
  }

  label.textContent = `下一目标 · ${MEDAL_LABELS[goal.medal]}`;
  target.textContent = formatRaceTime(goal.targetMs);
  const hasDelta = Number.isFinite(goal.deltaMs);
  delta.textContent = hasDelta ? `预测 ${formatRaceDelta(goal.deltaMs)}` : `完成 ${MIN_LIVE_GOAL_CHECKPOINTS} 个检查点后计算`;
  delta.classList.toggle('ahead', hasDelta && goal.deltaMs < 0);
  delta.classList.toggle('behind', hasDelta && goal.deltaMs > 0);
}

function updateCarUI() {
  const config = CARS[carIndex];
  const setTextIfPresent = (id, value) => {
    const element = $(id);
    if (element) element.textContent = value;
  };
  setTextIfPresent('car-index', `${String(carIndex + 1).padStart(2, '0')} / ${String(CARS.length).padStart(2, '0')}`);
  setTextIfPresent('car-name', config.name);
  setTextIfPresent('stat-speed', config.speed);
  setTextIfPresent('stat-accel', config.accel);
  setTextIfPresent('stat-grip', config.grip);
  const targets = medalTargetsForCar(config.id);
  setTextIfPresent('garage-goal', targets
    ? `三圈奖牌目标 · 金 ${formatRaceTime(targets.gold)} / 银 ${formatRaceTime(targets.silver)} / 铜 ${formatRaceTime(targets.bronze)}`
    : '三圈奖牌目标 · 待定');
  const record = timingStore.load(
    { trackId: LONGWAN_TIME_ATTACK.id, carId: config.id },
    LONGWAN_TIME_ATTACK.sectorCheckpoints.length,
  );
  setTextIfPresent('garage-best-lap', formatRaceTime(record.bestLapMs));
  setTextIfPresent('garage-best-race', formatRaceTime(record.bestRaceMsByLaps[String(TOTAL_LAPS)]));
}

async function mountVehicle(index, initial = false) {
  if (vehicleLoadPending) {
    if (state === 'menu') queuedVehicleIndex = index;
    return false;
  }
  const token = ++vehicleLoadToken;
  const config = CARS[index];
  vehicleLoadPending = true;
  $('garage-status').textContent = `LOADING ${config.name}`;
  $('garage-status').classList.add('active');
  $('start-button').disabled = true;
  $('retry-car-button').classList.add('hidden');
  retryCarIndex = null;
  if (initial) $('loading-status').textContent = `载入 ${config.name}…`;
  let visual = null;
  let visualHandedOff = false;
  try {
    visual = await assets.instantiateCar(config, (progress) => {
      if (initial) $('loading-progress').style.width = `${10 + progress * 76}%`;
    });
    if (token !== vehicleLoadToken || state !== 'menu') {
      disposeOwnedVisual(visual);
      return false;
    }
    if (visual.userData?.source !== 'gltf') {
      throw new Error(`Playable vehicle asset unavailable for ${config.id}`);
    }
    const nextVehicle = new VehicleSystem({
      RAPIER,
      world: physicsWorld,
      scene,
      track,
      config,
      visual,
      onAutomaticReset: (reason) => {
        if (state === 'race') {
          invalidateCurrentLap(reason, 'RECOVERY · LAP INVALID');
          recordDevEvent('automatic-reset', { reason });
        }
      },
    });
    nextVehicle.body.setEnabled(false);
    const previous = vehicle;
    vehicle = nextVehicle;
    visualHandedOff = true;
    previous?.destroy();
    const audioSelection = audio.setVehicle(config);
    publishDevVehicleReadiness();
    Promise.resolve(audioSelection).then(
      () => { if (vehicle?.config.id === config.id) publishDevVehicleReadiness(); },
      () => { if (vehicle?.config.id === config.id) publishDevVehicleReadiness(); },
    );
    if (visual.userData.source === 'gltf') assets.preloadNeighbors(CARS, index);
    chaseCamera.snap(vehicle.currentPose.position, vehicle.currentPose.rotation);
    return true;
  } catch (error) {
    if (visual && !visualHandedOff) {
      scene.remove(visual);
      disposeOwnedVisual(visual);
    }
    if (token === vehicleLoadToken) {
      retryCarIndex = index;
      const mountedIndex = CARS.findIndex((candidate) => candidate.id === vehicle?.config.id);
      if (mountedIndex >= 0) {
        carIndex = mountedIndex;
        updateCarUI();
      }
      console.warn(`Vehicle load failed for ${config.id}`, error);
    }
    return false;
  } finally {
    if (token === vehicleLoadToken) {
      const nextIndex = queuedVehicleIndex;
      queuedVehicleIndex = null;
      if (state === 'menu' && nextIndex !== null && nextIndex !== index) {
        vehicleLoadPending = false;
        carIndex = nextIndex;
        updateCarUI();
        return mountVehicle(nextIndex, initial);
      }
      vehicleLoadPending = false;
      const selectionReady = vehicle?.config.id === CARS[carIndex].id
        && vehicle.visual?.userData?.source === 'gltf';
      $('garage-status').classList.remove('active');
      $('garage-status').textContent = selectionReady ? 'READY' : 'LOAD FAILED';
      $('start-button').disabled = !selectionReady;
      $('retry-car-button').classList.toggle('hidden', retryCarIndex === null);
    }
  }
}

async function selectCar(direction) {
  if (state !== 'menu') return;
  carIndex = (carIndex + direction + CARS.length) % CARS.length;
  updateCarUI();
  if (vehicleLoadPending) {
    $('garage-status').textContent = `LOADING ${CARS[carIndex].name}`;
    $('garage-status').classList.add('active');
    $('start-button').disabled = true;
    queuedVehicleIndex = carIndex;
    return;
  }
  await mountVehicle(carIndex);
}

function resetRaceState() {
  timing = new RaceTimingSession({
    trackId: LONGWAN_TIME_ATTACK.id,
    carId: vehicle.config.id,
    totalLaps: TOTAL_LAPS,
    checkpointCount: TRACK_CONFIG.checkpoints,
    sectorCheckpoints: LONGWAN_TIME_ATTACK.sectorCheckpoints,
    medalTargetsMs: medalTargetsForCar(vehicle.config.id),
    store: timingStore,
    ...(import.meta.env.DEV && raceProgressCore
      ? { progressCore: raceProgressCore, progressMode: 'owner' }
      : {}),
  });
  document.documentElement.dataset.raceTimingProgressOwner = timing.progressOwner;
  lastSectorEvent = null;
  lastLapEvent = null;
  const snapshot = timing.snapshot();
  $('lap-now').textContent = '1';
  $('checkpoint-now').textContent = '0';
  $('race-time').textContent = '00:00.000';
  $('lap-time').textContent = '00:00.000';
  $('sector-now').textContent = '1';
  $('sector-time').textContent = '00:00.000';
  $('best-lap').textContent = formatRaceTime(snapshot.bestLapMs);
  $('lap-valid-state').textContent = 'VALID';
  $('lap-valid-state').classList.remove('invalid');
  setDeltaUI($('sector-delta'), null, snapshot.bestSectorsMs[0] == null ? 'NO DATA' : 'TARGET SET');
  setDeltaUI($('lap-delta'), null, snapshot.bestLapMs == null ? 'FIRST RUN' : 'PB LOADED');
  updateRaceGoalUI(snapshot);
  syncInvalidLapRestart(snapshot);
  track.setCheckpointHighlight(snapshot.expectedCheckpointIndex);
}

function startRace() {
  const restartingInvalidLap = state === 'race' && timing?.snapshot().currentLapValid === false;
  if (state !== 'menu' && state !== 'finish' && state !== 'paused' && !restartingInvalidLap) return;
  if (
    !vehicle
    || vehicleLoadPending
    || vehicle.config.id !== CARS[carIndex].id
    || vehicle.visual?.userData?.source !== 'gltf'
  ) return;
  closeAllModalDialogs(false);
  input.releaseAll();
  resetPhysicsScheduler();
  lastFrame = performance.now();
  if (standaloneMode && touchCapable) lockLandscape();
  setAudioPaused(false);
  initializeAudio().catch((error) => console.warn('Audio initialization failed', error));
  state = 'countdown';
  document.body.classList.add('race-active');
  $('mobile-controls').classList.add('active');
  $('race-menu-button').classList.remove('hidden');
  $('pause-menu').classList.add('hidden');
  input.setTouchEnabled(touchCapable);
  $('menu').classList.add('hidden');
  $('finish').classList.add('hidden');
  $('hud').classList.remove('hidden');
  vehicle.body.setEnabled(true);
  vehicle.reset(0);
  resetRaceState();
  countdown = 3;
  countdownShown = 3;
  setStartLights('three');
  showMessage('3', 650);
  devFixedStepIndex = 0;
  recordDevEvent('run-requested', { carId: vehicle.config.id, trackId: LONGWAN_TIME_ATTACK.id });
  focusVisibleElement($('game'));
  syncOrientationHint();
}

function renderFinishSummary(summary) {
  $('finish-kicker').textContent = summary?.valid ? '环线挑战完成' : '本次成绩未认证';
  $('finish-title').textContent = summary?.newBestRace
    ? '刷新纪录。'
    : summary?.valid
      ? '漂亮收车。'
      : '还有下一圈。';
  $('finish-time').textContent = formatRaceTime(summary?.timeMs);
  $('finish-best-lap').textContent = formatRaceTime(summary?.bestLapMs);
  $('finish-race-best').textContent = formatRaceTime(summary?.bestRaceMs);
  const validLaps = summary?.laps?.filter((lap) => lap.valid).length ?? 0;
  $('finish-valid-laps').textContent = `${validLaps} / ${TOTAL_LAPS}`;

  const medalElement = $('finish-medal');
  const medal = summary?.valid && summary.medal ? summary.medal : null;
  medalElement.textContent = !summary?.valid
    ? '未认证'
    : medal
      ? MEDAL_LABELS[medal]
      : '未达标';
  medalElement.className = `medal-value ${medal ?? (summary?.valid ? 'none' : 'unverified')}`;

  const raceDelta = summary?.valid && Number.isFinite(summary.deltaMs) ? summary.deltaMs : null;
  setDeltaUI($('finish-race-delta'), raceDelta, summary?.valid ? '首次挑战' : '未认证');

  const targets = medalTargetsForCar(vehicle?.config.id);
  if (!summary?.valid) {
    $('finish-target').textContent = '未认证';
  } else if (targets) {
    const targetMedal = summary.medal ?? 'bronze';
    $('finish-target').textContent = `${MEDAL_LABELS[targetMedal]} ${formatRaceTime(targets[targetMedal])}`;
  } else {
    $('finish-target').textContent = '--:--.---';
  }

  const lapList = $('finish-laps');
  lapList.replaceChildren();
  for (const lap of summary?.laps ?? []) {
    const row = document.createElement('li');
    row.className = lap.valid ? 'valid' : 'invalid';
    const label = document.createElement('span');
    const time = document.createElement('span');
    const status = document.createElement('span');
    label.textContent = `LAP ${lap.number}`;
    time.textContent = formatRaceTime(lap.timeMs);
    status.textContent = lap.valid ? (lap.newBest ? 'NEW PB' : formatRaceDelta(lap.deltaMs)) : 'INVALID';
    row.append(label, time, status);
    lapList.append(row);
  }
  $('finish-copy').textContent = !summary?.valid
    ? '本次包含无效圈，总成绩不会写入 PB；其中的有效单圈仍已保存。'
    : summary.newBestRace
      ? '新的三圈个人最佳已保存在本机。按 R 可以立即再跑。'
      : '成绩与有效单圈已保存在本机。按 R 可以立即再跑。';
}

function finishRace(summary = timing?.getSummary()) {
  state = 'finish';
  track.setCheckpointHighlight(null);
  closeAllModalDialogs(false);
  input.releaseAll();
  setStartLights('off');
  document.body.classList.remove('race-active');
  $('mobile-controls').classList.remove('active');
  $('race-menu-button').classList.add('hidden');
  $('pause-menu').classList.add('hidden');
  input.setTouchEnabled(false);
  vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
  vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  vehicle.body.setEnabled(false);
  vehicle.telemetry.speedKmh = 0;
  vehicle.telemetry.throttle = 0;
  renderFinishSummary(summary);
  $('finish').classList.remove('hidden');
  $('hud').classList.add('hidden');
  syncInvalidLapRestart();
  openModalDialog('finish', $('race-menu-button'));
}

function returnGarage() {
  state = 'menu';
  setAudioPaused(false);
  track.setCheckpointHighlight(null);
  closeAllModalDialogs(false);
  input.releaseAll();
  resetPhysicsScheduler();
  lastFrame = performance.now();
  setStartLights('off');
  document.body.classList.remove('race-active');
  $('mobile-controls').classList.remove('active');
  $('race-menu-button').classList.add('hidden');
  $('pause-menu').classList.add('hidden');
  input.setTouchEnabled(false);
  $('finish').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('menu').classList.remove('hidden');
  updateCarUI();
  syncInvalidLapRestart();
  vehicle.reset(0);
  vehicle.body.setEnabled(false);
  vehicle.telemetry.speedKmh = 0;
  vehicle.telemetry.throttle = 0;
  chaseCamera.snap(vehicle.currentPose.position, vehicle.currentPose.rotation);
  timing = null;
  focusVisibleElement($('start-button'));
}

function openRaceMenu() {
  if (state !== 'race' && state !== 'countdown') return;
  stateBeforePause = state;
  state = 'paused';
  setAudioPaused(true);
  input.releaseAll();
  input.setTouchEnabled(false);
  $('mobile-controls').classList.remove('active');
  syncInvalidLapRestart();
  openModalDialog('pause-menu', $('race-menu-button'));
}

function pauseOnLifecycleLoss() {
  if (state !== 'race' && state !== 'countdown') return;
  openRaceMenu();
}

function handleVisibilityChange() {
  if (document.hidden) pauseOnLifecycleLoss();
}

function resumeRace() {
  if (state !== 'paused') return;
  state = stateBeforePause;
  setAudioPaused(false);
  resetPhysicsScheduler();
  lastFrame = performance.now();
  input.setTouchEnabled(touchCapable);
  $('mobile-controls').classList.add('active');
  closeModalDialog('pause-menu', false);
  syncInvalidLapRestart();
  focusVisibleElement($('game'));
  syncOrientationHint();
}

function handleTimingEvents(events) {
  for (const event of events) {
    recordDevEvent(event.type, { event });
    if (event.type === 'checkpoint-completed') {
      const checkpointLabel = event.checkpointOrdinal === TRACK_CONFIG.checkpoints
        ? 'FINISH GATE'
        : `CHECKPOINT ${String(event.checkpointOrdinal).padStart(2, '0')}`;
      showMessage(checkpointLabel, 520);
    } else if (event.type === 'sector-completed') {
      lastSectorEvent = event;
    } else if (event.type === 'lap-completed') {
      lastLapEvent = event;
      lastSectorEvent = null;
      if (event.lap.number < TOTAL_LAPS) {
        const label = event.lap.valid
          ? event.lap.newBest
            ? 'NEW PERSONAL BEST'
            : `LAP ${event.lap.number} · ${formatRaceTime(event.lap.timeMs)}`
          : `LAP ${event.lap.number} INVALID`;
        showMessage(label, 1100);
      }
    } else if (event.type === 'run-completed') {
      finishRace(event.summary);
    }
  }
  track.setCheckpointHighlight(state === 'race' || state === 'countdown'
    ? timing?.snapshot().expectedCheckpointIndex
    : null);
}

function invalidateCurrentLap(reason, message = 'LAP INVALID') {
  const event = timing?.invalidate(reason);
  syncInvalidLapRestart();
  if (event) {
    recordDevEvent('lap-invalidated', { reason, event });
    showMessage(message, 950);
  }
}

function updateCheckpoints() {
  if (state !== 'race' || !timing) return;
  const expectedCheckpoint = timing.snapshot().expectedCheckpointIndex;
  const sampleCount = track.samples.length;
  const targetIndex = Math.floor((expectedCheckpoint % TRACK_CONFIG.checkpoints) / TRACK_CONFIG.checkpoints * sampleCount);
  let difference = vehicle.trackHint - targetIndex;
  if (difference > sampleCount / 2) difference -= sampleCount;
  if (difference < -sampleCount / 2) difference += sampleCount;
  const checkpointTrackInfo = track.nearestInfo(vehicle.currentPose.position, vehicle.trackHint);
  const onRoad = Math.abs(checkpointTrackInfo.offset) < TRACK_CONFIG.width * 0.5;
  if (Math.abs(difference) > 7 || !onRoad || vehicle.telemetry.signedSpeedKmh < 8) return;
  const events = timing.passCheckpoint(expectedCheckpoint);
  handleTimingEvents(events);
}

function fixedUpdate(frameInput) {
  if (!vehicle) return;
  if (state === 'menu' || state === 'finish' || state === 'paused') {
    input.consumeFixedPulses();
    return;
  }
  devFixedStepIndex += 1;
  if (state === 'race' && frameInput.reset) {
    invalidateCurrentLap('manual-reset', 'RESET · LAP INVALID');
    recordDevEvent('manual-reset', { reason: 'manual-reset' });
    vehicle.reset(vehicle.safeSample);
  }
  if (state === 'countdown') {
    countdown -= FIXED_DT;
    const nextNumber = Math.ceil(countdown);
    if (nextNumber > 0 && nextNumber !== countdownShown) {
      countdownShown = nextNumber;
      setStartLights(nextNumber === 3 ? 'three' : nextNumber === 2 ? 'two' : 'one');
      showMessage(String(nextNumber), 650);
    }
    if (countdown <= 0) {
      state = 'race';
      const runStarted = timing.start();
      recordDevEvent('run-started', { event: runStarted, carId: vehicle.config.id, trackId: LONGWAN_TIME_ATTACK.id });
      setStartLights('go', 1100);
      showMessage('GO!', 800);
    }
  }
  const active = state === 'race';
  vehicle.fixedUpdate(frameInput, !active, FIXED_DT);
  physicsWorld.step();
  vehicle.afterPhysics();
  if (active) {
    timing.advance(FIXED_DT * 1000);
    const trackInfo = track.nearestInfo(vehicle.currentPose.position, vehicle.trackHint);
    const beyondKerb = Math.abs(trackInfo.offset) > TRACK_CONFIG.width * 0.5 + 1.05;
    if (beyondKerb) invalidateCurrentLap('track-limits');
    updateCheckpoints();
  }
  input.consumeFixedPulses();
}

function updateHUD() {
  if (!vehicle) return;
  const telemetry = vehicle.telemetry;
  const timingSnapshot = timing?.snapshot();
  if (timingSnapshot) {
    $('race-time').textContent = formatRaceTime(timingSnapshot.runTimeMs);
    $('lap-now').textContent = String(timingSnapshot.currentLapNumber);
    $('checkpoint-now').textContent = String(timingSnapshot.checkpointInLap);
    $('lap-time').textContent = formatRaceTime(timingSnapshot.lapTimeMs);
    $('sector-now').textContent = String(timingSnapshot.currentSectorNumber);
    $('sector-time').textContent = formatRaceTime(timingSnapshot.sectorTimeMs);
    $('best-lap').textContent = formatRaceTime(timingSnapshot.bestLapMs);
    $('lap-valid-state').textContent = timingSnapshot.currentLapValid ? 'VALID' : 'INVALID';
    $('lap-valid-state').classList.toggle('invalid', !timingSnapshot.currentLapValid);
    syncInvalidLapRestart(timingSnapshot);
    setDeltaUI(
      $('sector-delta'),
      lastSectorEvent?.deltaMs,
      timingSnapshot.bestSectorsMs[timingSnapshot.currentSectorNumber - 1] == null ? 'NO DATA' : 'TARGET SET',
    );
    const completedLap = lastLapEvent?.lap;
    const lapFallback = completedLap?.newBest
      ? 'NEW PB'
      : completedLap && !completedLap.valid
        ? 'INVALID'
        : timingSnapshot.bestLapMs == null
          ? 'FIRST RUN'
          : 'PB ACTIVE';
    setDeltaUI($('lap-delta'), completedLap?.deltaMs, lapFallback);
    updateRaceGoalUI(timingSnapshot);
  }
  $('speed').textContent = String(Math.round(telemetry.speedKmh));
  $('gear').textContent = telemetry.reverse ? 'R' : String(telemetry.gear);
  $('rpm').textContent = String(Math.round(telemetry.rpm / 100) * 100);
  $('shift-mode').textContent = vehicle.transmissionMode;
  $('mobile-mode').textContent = vehicle.transmissionMode;
  $('mobile-controls').classList.toggle('manual', vehicle.transmissionMode === 'MT');
  $('throttle-bar').style.width = `${telemetry.throttle * 100}%`;
  $('brake-bar').style.width = `${telemetry.brake * 100}%`;
  const assist = telemetry.absActive ? 'ABS' : telemetry.tcsActive ? 'TCS' : telemetry.stabilityActive ? 'ESC' : 'READY';
  $('assist-state').textContent = assist;
  $('drive-mode').textContent = telemetry.reverse ? 'REVERSE' : telemetry.surface.toUpperCase();
}

function updatePerformance(frameDt) {
  fpsAccumulator += frameDt;
  fpsFrames += 1;
  if (fpsAccumulator < 0.5) return;
  const fps = Math.round(fpsFrames / fpsAccumulator);
  $('perf').textContent = `${fps} FPS · PHYS ${physicsCost.toFixed(2)}ms · ${renderer.info.render.calls} DRAWS · ${renderer.info.render.triangles.toLocaleString()} TRI`;
  fpsAccumulator = 0;
  fpsFrames = 0;
  slowFrameWindows = fps < 48 ? slowFrameWindows + 1 : Math.max(0, slowFrameWindows - 1);
  if (slowFrameWindows >= 3 && renderScale > 0.72) {
    renderScale = Math.max(0.72, renderScale - 0.12);
    renderer.setPixelRatio(Math.min(devicePixelRatio, renderScale));
    slowFrameWindows = 0;
  } else if (fps > 57 && renderScale < getRenderScaleLimit()) {
    renderScale = Math.min(getRenderScaleLimit(), renderScale + 0.05);
    renderer.setPixelRatio(Math.min(devicePixelRatio, renderScale));
  }
}

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
    if (!inputBlockedLastFrame) input.releaseAll();
    inputBlockedLastFrame = true;
    resetPhysicsScheduler();
    vehicle.syncVisual(1);
    chaseCamera.update(frameDt, vehicle.visual.position, vehicle.visual.quaternion, vehicle.telemetry, false);
    updateHUD();
    updatePerformance(frameDt);
    renderer.render(scene, camera);
    return;
  }
  inputBlockedLastFrame = false;
  const frameInput = input.update(frameDt, vehicle.telemetry.speedKmh, { deferFixedPulses: true });
  if (input.consumePulse('KeyP')) {
    performanceVisible = !performanceVisible;
    $('perf').classList.toggle('hidden', !performanceVisible);
  }
  const physicsStart = performance.now();
  const physicsPlan = physicsScheduler.advance(frameDt);
  for (let physicsStep = 0; physicsStep < physicsPlan.steps; physicsStep += 1) {
    fixedUpdate(frameInput);
  }
  physicsCost = THREE.MathUtils.damp(physicsCost, performance.now() - physicsStart, 5, frameDt);
  vehicle.syncVisual(physicsPlan.alpha);
  const menuMode = state === 'menu';
  chaseCamera.update(frameDt, vehicle.visual.position, vehicle.visual.quaternion, vehicle.telemetry, menuMode);
  if (!menuMode) effects.update(frameDt, vehicle.telemetry, vehicle.visual.quaternion);
  setAudioPaused(false);
  audio.update(vehicle.telemetry);
  if (!menuMode) updateHUD();
  updatePerformance(frameDt);
  renderer.render(scene, camera);
}

$('prev-car').onclick = () => selectCar(-1);
$('next-car').onclick = () => selectCar(1);
$('start-button').onclick = startRace;
$('restart-button').onclick = startRace;
$('invalid-lap-restart-button').onclick = startRace;
$('garage-button').onclick = returnGarage;
$('race-menu-button').onclick = openRaceMenu;
$('resume-button').onclick = resumeRace;
$('race-restart-button').onclick = startRace;
$('race-garage-button').onclick = returnGarage;
$('fullscreen-button').onclick = togglePageFullscreen;
$('orientation-fullscreen').onclick = requestPageFullscreen;
$('retry-car-button').onclick = () => {
  const index = retryCarIndex ?? carIndex;
  carIndex = index;
  updateCarUI();
  mountVehicle(index);
};
$('fullscreen-help-close').onclick = () => {
  closeModalDialog('fullscreen-help');
  syncOrientationHint();
};
$('fullscreen-help').onclick = (event) => {
  if (event.target === $('fullscreen-help')) {
    closeModalDialog('fullscreen-help');
    syncOrientationHint();
  }
};
$('about-button').onclick = (event) => {
  if (state !== 'menu') return;
  openModalDialog('about', event.currentTarget);
};
$('about-close').onclick = () => closeModalDialog('about');
$('about').onclick = (event) => {
  if (event.target === $('about')) closeModalDialog('about');
};
$('sound-button').onclick = () => {
  initializeAudio().catch((error) => console.warn('Audio initialization failed', error));
  audio.setEnabled(!audio.enabled);
  $('sound-button').textContent = audio.enabled ? 'SOUND ON' : 'SOUND OFF';
  $('sound-button').setAttribute('aria-pressed', String(audio.enabled));
};
addEventListener('keydown', (event) => {
  if (trapModalFocus(event)) return;
  const target = event.target;
  const isInteractiveTarget = target instanceof HTMLElement
    && (target.matches('button, a, input, textarea, select, [contenteditable="true"]')
      || target.isContentEditable);
  const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
  const isRestartShortcutTarget = target instanceof HTMLElement
    && Boolean(target.closest('#restart-button, #race-restart-button, #invalid-lap-restart-button'));
  if (event.code === 'Enter' && state === 'menu' && !isInteractiveTarget && !hasModifier) startRace();
  if (event.code === 'KeyR'
    && (!isInteractiveTarget || isRestartShortcutTarget)
    && (state === 'finish'
      || state === 'paused'
      || (state === 'race' && timing?.snapshot().currentLapValid === false))
    && !hasModifier) {
    event.preventDefault();
    startRace();
    return;
  }
  if (event.code === 'Escape') {
    const openDialog = getOpenModalDialog();
    if (openDialog) {
      if (openDialog.id === 'orientation-hint') {
        openRaceMenu();
      } else if (openDialog.id === 'pause-menu') {
        resumeRace();
      } else if (openDialog.id === 'finish') {
        returnGarage();
      } else {
        closeModalDialog(openDialog.id);
        if (openDialog.id === 'fullscreen-help') syncOrientationHint();
      }
    } else if (state === 'paused') {
      resumeRace();
    } else if (state === 'race' || state === 'countdown') {
      openRaceMenu();
    }
  }
});
window.addEventListener('blur', pauseOnLifecycleLoss);
window.addEventListener('pagehide', pauseOnLifecycleLoss);
document.addEventListener('visibilitychange', handleVisibilityChange);
function resizeRenderer() {
  renderScale = Math.min(renderScale, getRenderScaleLimit());
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, renderScale));
  syncOrientationHint();
}
addEventListener('resize', resizeRenderer);
window.visualViewport?.addEventListener('resize', resizeRenderer);
addEventListener('fullscreenchange', syncFullscreenButton);
addEventListener('webkitfullscreenchange', syncFullscreenButton);
addEventListener('orientationchange', syncOrientationHint);
matchMedia('(orientation: portrait)').addEventListener?.('change', syncOrientationHint);
syncFullscreenButton();
syncOrientationHint();

updateCarUI();
$('loading-status').textContent = '建立赛道与车辆物理…';
const sceneryPromise = assets.loadScenery().catch((error) => console.warn('Scenery failed to load', error));
await mountVehicle(carIndex, true);
await sceneryPromise;
const sharedCore = await sharedCorePromise;
physicsScheduler = sharedCore.scheduler;
raceProgressCore = sharedCore.raceProgress;
document.documentElement.dataset.physicsSchedulerOwner = physicsScheduler.owner;
document.documentElement.dataset.raceProgressCoreOwner = raceProgressCore.owner;
if (physicsScheduler.fallbackReason) {
  document.documentElement.dataset.physicsSchedulerFallback = physicsScheduler.fallbackReason.code;
} else {
  delete document.documentElement.dataset.physicsSchedulerFallback;
}
recordDevEvent('physics-scheduler-ready', {
  owner: physicsScheduler.owner,
  fallbackReason: physicsScheduler.fallbackReason,
});
recordDevEvent('race-progress-core-ready', {
  owner: raceProgressCore.owner,
  available: raceProgressCore.available,
  fallbackReason: raceProgressCore.fallbackReason,
});
if (physicsScheduler.fallbackReason) {
  console.warn('[physics-scheduler] using JavaScript fallback', physicsScheduler.fallbackReason);
}
if (raceProgressCore.fallbackReason) {
  console.warn('[race-progress-core] Rust shadow capability unavailable', raceProgressCore.fallbackReason);
}
$('loading-progress').style.width = '100%';
setTimeout(() => $('loading').classList.add('hidden'), 320);
lastFrame = performance.now();
requestAnimationFrame(animate);
~~~~

### src/vehicle.js

~~~~javascript
import * as THREE from 'three';
import { FIXED_DT, SURFACES } from './config.js';
import {
  GRAVITY,
  SHIFT_DURATION,
  SHIFT_TORQUE_FACTOR,
  aerodynamicDragScale,
  drivetrainEfficiency,
  frictionLimitedYawRate,
  roadWheelRpm,
  torqueCurveFactor,
} from './vehicle-physics.js';

const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;
const MIN_SAFE_UPDATE_DT = FIXED_DT * 0.25;
const MAX_SAFE_UPDATE_DT = 0.05;
const REVERSE_ENGAGE_HOLD_SECONDS = 0.45;

const finiteOr = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

function hasFiniteVector(value) {
  return value
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.z);
}

function hasFiniteBodyState(translation, rotation, linearVelocity, angularVelocity) {
  return hasFiniteVector(translation)
    && hasFiniteVector(rotation)
    && Number.isFinite(rotation.w)
    && hasFiniteVector(linearVelocity)
    && hasFiniteVector(angularVelocity);
}

function safeUpdateDt(dt) {
  if (!Number.isFinite(dt) || dt <= 0) return FIXED_DT;
  return clamp(dt, MIN_SAFE_UPDATE_DT, MAX_SAFE_UPDATE_DT);
}

function sanitizeInput(input) {
  const source = input && typeof input === 'object' ? input : {};
  const numberInRange = (value, minimum, maximum) => clamp(
    finiteOr(value),
    minimum,
    maximum,
  );
  const safeInput = {
    steer: numberInRange(source.steer, -1, 1),
    throttle: numberInRange(source.throttle, 0, 1),
    brake: numberInRange(source.brake, 0, 1),
    handbrake: numberInRange(source.handbrake, 0, 1),
    shiftUp: source.shiftUp === true,
    shiftDown: source.shiftDown === true,
    toggleTransmission: source.toggleTransmission === true,
    reset: source.reset === true,
  };
  if (Number.isFinite(source.driveIntent)) {
    safeInput.driveIntent = clamp(source.driveIntent, -1, 1);
  }
  return safeInput;
}

export function disposeOwnedVisual(root) {
  if (!root || root.userData?.source !== 'fallback') return false;
  const geometries = new Set();
  const materials = new Set();
  root.traverse((object) => {
    if (!object.isMesh) return;
    if (object.geometry) geometries.add(object.geometry);
    const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of objectMaterials) if (material) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  return true;
}

export class VehicleSystem {
  constructor({ RAPIER, world, scene, track, config, visual, onAutomaticReset = null }) {
    this.RAPIER = RAPIER;
    this.world = world;
    this.scene = scene;
    this.track = track;
    this.config = config;
    this.visual = visual;
    this.onAutomaticReset = typeof onAutomaticReset === 'function' ? onAutomaticReset : null;
    this.visual.name = `vehicle-${config.id}`;
    scene.add(this.visual);
    this.transmissionMode = 'AT';
    this.gear = 1;
    this.reverse = false;
    this.reverseHold = 0;
    this.shiftTimer = 0;
    this.engineRpm = config.idle;
    this.engineLoad = 0;
    this.previousLongSpeed = 0;
    this.smoothedLongAcceleration = 0;
    this.safeSample = 0;
    this.trackHint = 0;
    this.stuckTimer = 0;
    this.steerAngle = 0;
    this.wheelInertia = 1.25;
    this.currentPose = { position: new THREE.Vector3(), rotation: new THREE.Quaternion() };
    this.previousPose = { position: new THREE.Vector3(), rotation: new THREE.Quaternion() };
    this.tmp = {
      position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), forward: new THREE.Vector3(),
      right: new THREE.Vector3(), up: new THREE.Vector3(), origin: new THREE.Vector3(),
      worldUp: new THREE.Vector3(0, 1, 0),
      down: new THREE.Vector3(), point: new THREE.Vector3(),
      bodyVelocity: new THREE.Vector3(), velocity: new THREE.Vector3(),
      force: new THREE.Vector3(), wheelForward: new THREE.Vector3(), wheelRight: new THREE.Vector3(),
    };
    this.createBody();
    this.createWheels();
    this.visualWheelBindings = this.bindVisualWheels();
    this.drivenWheels = this.wheels.filter((wheel) => wheel.driven);
    this.lockedInput = {
      steer: 0, throttle: 0, brake: 0, handbrake: 0,
      shiftUp: false, shiftDown: false, toggleTransmission: false, reset: false, driveIntent: 0,
    };
    this.telemetry = {
      speedKmh: 0, signedSpeedKmh: 0, rpm: config.idle, gear: 1, reverse: false,
      throttle: 0, brake: 0, steer: 0, longitudinalAcceleration: 0, lateralAcceleration: 0,
      surface: 'asphalt', absActive: false, tcsActive: false, stabilityActive: false,
      wheels: this.wheels.map(() => ({
        grounded: false, load: 0, suspension: 0, slipRatio: 0, slipAngle: 0,
        slipPower: 0, surface: 'asphalt', contactPoint: new THREE.Vector3(),
      })),
    };
  }

  createBody() {
    const pose = this.track.getResetPose(0);
    pose.position.y = this.config.model.groundOffset + 0.025;
    const yawRotation = { x: 0, y: Math.sin(pose.yaw * 0.5), z: 0, w: Math.cos(pose.yaw * 0.5) };
    const desc = this.RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pose.position.x, pose.position.y, pose.position.z)
      .setRotation(yawRotation)
      // Rolling resistance and aerodynamic drag are modeled explicitly below.
      // Rapier damping is mass-scaled, so enabling it here adds a second hidden
      // speed-dependent resistance and disproportionately slows heavier cars.
      .setLinearDamping(0)
      .setAngularDamping(0.72)
      .setCcdEnabled(true)
      .setCanSleep(false);
    this.body = this.world.createRigidBody(desc);
    const halfLength = Math.max(1.75, this.config.wheelbase * 0.72);
    const collider = this.RAPIER.ColliderDesc.cuboid(this.config.trackWidth * 0.52, 0.28, halfLength)
      .setTranslation(0, -0.09, 0)
      .setMass(this.config.mass)
      .setFriction(0.28)
      .setRestitution(0.04);
    this.collider = this.world.createCollider(collider, this.body);
    this.currentPose.position.copy(pose.position);
    this.previousPose.position.copy(pose.position);
    this.currentPose.rotation.set(yawRotation.x, yawRotation.y, yawRotation.z, yawRotation.w);
    this.previousPose.rotation.copy(this.currentPose.rotation);
  }

  createWheels() {
    const halfTrack = this.config.trackWidth * 0.5;
    const halfBase = this.config.wheelbase * 0.5;
    const anchorHeight = this.config.wheelRadius + this.config.suspension.restLength
      - this.config.mass * GRAVITY / (4 * this.config.suspension.springRate)
      - this.config.model.groundOffset;
    const drivenFront = this.config.drivetrain === 'AWD' || this.config.drivetrain === 'FWD';
    const drivenRear = this.config.drivetrain === 'AWD' || this.config.drivetrain === 'RWD';
    this.wheels = [
      { id: 'FL', anchor: new THREE.Vector3(-halfTrack, anchorHeight, halfBase), front: true, driven: drivenFront, omega: 0 },
      { id: 'FR', anchor: new THREE.Vector3(halfTrack, anchorHeight, halfBase), front: true, driven: drivenFront, omega: 0 },
      { id: 'RL', anchor: new THREE.Vector3(-halfTrack, anchorHeight, -halfBase), front: false, driven: drivenRear, omega: 0 },
      { id: 'RR', anchor: new THREE.Vector3(halfTrack, anchorHeight, -halfBase), front: false, driven: drivenRear, omega: 0 },
    ].map((wheel) => ({
      ...wheel,
      grounded: false,
      compression: 0,
      springForce: 0,
      hit: null,
      surface: 'asphalt',
      previousVisualAngle: 0,
      visualAngle: 0,
    }));
  }

  bindVisualWheels() {
    const wheelSet = this.visual.getObjectByName('calibrated-wheels');
    if (wheelSet?.userData?.visualWheelBindingVersion !== 1) return [];
    const bindings = this.wheels.map(({ id }) => {
      const steer = wheelSet.getObjectByName(`visual-wheel-${id}-steer`);
      const roll = wheelSet.getObjectByName(`visual-wheel-${id}-roll`);
      if (!steer || !roll || roll.parent !== steer) return null;
      return { id, steer, roll, baseY: steer.position.y };
    });
    return bindings.every(Boolean) ? bindings : [];
  }

  advanceVisualWheelAngles(dt) {
    const safeDt = Number.isFinite(dt) && dt > 0 ? dt : 0;
    for (const wheel of this.wheels) {
      if (!Number.isFinite(wheel.visualAngle)) wheel.visualAngle = 0;
      if (!Number.isFinite(wheel.previousVisualAngle)) wheel.previousVisualAngle = wheel.visualAngle;
      wheel.previousVisualAngle = wheel.visualAngle;
      wheel.visualAngle += finiteOr(wheel.omega) * safeDt;
      if (Math.abs(wheel.visualAngle) > Math.PI * 4096) {
        const offset = Math.trunc(wheel.visualAngle / (Math.PI * 2)) * Math.PI * 2;
        wheel.visualAngle -= offset;
        wheel.previousVisualAngle -= offset;
      }
    }
  }

  requestShift(delta) {
    const next = clamp(this.gear + delta, 1, this.config.gears.length);
    if (next !== this.gear && this.shiftTimer <= 0) {
      this.gear = next;
      this.shiftTimer = SHIFT_DURATION;
    }
  }

  setReverseState(reverse, longSpeed = 0) {
    if (this.reverse === reverse) return;
    this.reverse = reverse;
    this.reverseHold = 0;
    this.gear = 1;
    this.shiftTimer = 0.08;
    const rollingOmega = longSpeed / this.config.wheelRadius;
    for (const wheel of this.wheels) wheel.omega = rollingOmega;
    this.engineRpm = Math.max(this.config.idle, Math.min(this.engineRpm, this.config.idle * 1.35));
  }

  reset(sampleIndex = this.safeSample) {
    const pose = this.track.getResetPose(sampleIndex);
    pose.position.y = this.config.model.groundOffset + 0.025;
    const rotation = { x: 0, y: Math.sin(pose.yaw * 0.5), z: 0, w: Math.cos(pose.yaw * 0.5) };
    this.body.setTranslation(pose.position, true);
    this.body.setRotation(rotation, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.resetForces(true);
    this.body.resetTorques(true);
    for (const wheel of this.wheels) {
      wheel.omega = 0;
      wheel.grounded = false;
      wheel.compression = 0;
      wheel.springForce = 0;
      wheel.hit = null;
      wheel.surface = 'asphalt';
      wheel.previousVisualAngle = 0;
      wheel.visualAngle = 0;
    }
    this.gear = 1;
    this.reverse = false;
    this.reverseHold = 0;
    this.shiftTimer = 0;
    this.engineRpm = this.config.idle;
    this.engineLoad = 0;
    this.steerAngle = 0;
    this.trackHint = pose.sampleIndex;
    this.previousLongSpeed = 0;
    this.smoothedLongAcceleration = 0;
    this.safeSample = pose.sampleIndex;
    this.stuckTimer = 0;
    this.afterPhysics();
    this.previousPose.position.copy(this.currentPose.position);
    this.previousPose.rotation.copy(this.currentPose.rotation);
    this.resetTelemetry();
  }

  resetTelemetry() {
    this.telemetry.speedKmh = 0;
    this.telemetry.signedSpeedKmh = 0;
    this.telemetry.rpm = this.config.idle;
    this.telemetry.gear = 1;
    this.telemetry.reverse = false;
    this.telemetry.throttle = 0;
    this.telemetry.brake = 0;
    this.telemetry.steer = 0;
    this.telemetry.longitudinalAcceleration = 0;
    this.telemetry.lateralAcceleration = 0;
    this.telemetry.surface = 'asphalt';
    this.telemetry.absActive = false;
    this.telemetry.tcsActive = false;
    this.telemetry.stabilityActive = false;
    for (const wheel of this.telemetry.wheels) {
      wheel.grounded = false;
      wheel.load = 0;
      wheel.suspension = 0;
      wheel.slipRatio = 0;
      wheel.slipAngle = 0;
      wheel.slipPower = 0;
      wheel.surface = 'asphalt';
      wheel.contactPoint.set(0, 0, 0);
    }
  }

  torqueCurve(rpm) {
    return torqueCurveFactor(this.config, rpm);
  }

  updateTransmission(input, dt, longSpeed) {
    if (input.toggleTransmission) this.transmissionMode = this.transmissionMode === 'AT' ? 'MT' : 'AT';
    if (this.transmissionMode === 'MT') {
      if (input.shiftUp) this.requestShift(1);
      if (input.shiftDown) this.requestShift(-1);
    }
    // W and S are directional requests, not two pedals whose meaning depends on
    // a sticky mode. W always asks for forward; S brakes a forward-moving car,
    // then selects reverse only once the driveline is almost stationary.
    const switchSpeed = 0.22;
    const explicitIntent = Number.isFinite(input.driveIntent);
    const driveIntent = explicitIntent
      ? Math.sign(input.driveIntent)
      : (input.throttle > 0.055 ? 1 : input.brake > 0.055 ? -1 : 0);
    const wantsForward = driveIntent > 0;
    const wantsReverse = driveIntent < 0;
    let driveThrottle = 0;
    let serviceBrake = 0;

    if (wantsForward) {
      this.reverseHold = 0;
      if (longSpeed < -switchSpeed) {
        serviceBrake = input.throttle;
      } else {
        if (this.reverse) this.setReverseState(false, longSpeed);
        driveThrottle = input.throttle;
      }
    } else if (wantsReverse) {
      if (longSpeed > switchSpeed) {
        this.reverseHold = 0;
        serviceBrake = input.brake;
      } else if (this.reverse) {
        driveThrottle = input.brake;
      } else {
        serviceBrake = input.brake;
        this.reverseHold += dt;
        if (this.reverseHold >= REVERSE_ENGAGE_HOLD_SECONDS) {
          this.setReverseState(true, longSpeed);
          serviceBrake = 0;
          driveThrottle = input.brake;
        }
      }
    } else {
      this.reverseHold = 0;
    }
    return { driveThrottle, serviceBrake };
  }

  fixedUpdate(input, controlsLocked = false, dt = FIXED_DT) {
    const safeDt = safeUpdateDt(dt);
    const activeInput = sanitizeInput(controlsLocked ? this.lockedInput : input);
    if (!Number.isFinite(this.steerAngle)) this.steerAngle = 0;
    else this.steerAngle = clamp(this.steerAngle, -this.config.steer, this.config.steer);
    if (!Number.isFinite(this.engineLoad)) this.engineLoad = 0;
    else this.engineLoad = clamp(this.engineLoad, 0, 1);
    if (!Number.isFinite(this.engineRpm)) this.engineRpm = this.config.idle;
    if (!Number.isFinite(this.reverseHold) || this.reverseHold < 0) this.reverseHold = 0;
    if (!Number.isFinite(this.shiftTimer) || this.shiftTimer < 0) this.shiftTimer = 0;
    if (!Number.isFinite(this.previousLongSpeed)) this.previousLongSpeed = 0;
    if (!Number.isFinite(this.smoothedLongAcceleration)) this.smoothedLongAcceleration = 0;
    if (!Number.isFinite(this.stuckTimer) || this.stuckTimer < 0) this.stuckTimer = 0;
    if (!Number.isInteger(this.gear) || this.gear < 1 || this.gear > this.config.gears.length) this.gear = 1;
    this.reverse = this.reverse === true;
    for (let index = 0; index < this.wheels.length; index += 1) {
      const wheel = this.wheels[index];
      if (!Number.isFinite(wheel.omega)) wheel.omega = 0;
      const wheelTelemetry = this.telemetry.wheels[index];
      if (!hasFiniteVector(wheelTelemetry.contactPoint)) wheelTelemetry.contactPoint.set(0, 0, 0);
    }
    this.body.resetForces(false);
    this.body.resetTorques(false);
    const t = this.body.translation();
    const r = this.body.rotation();
    const linvel = this.body.linvel();
    const angularVelocity = this.body.angvel();
    if (!hasFiniteBodyState(t, r, linvel, angularVelocity)) {
      this.reset(this.safeSample);
      return;
    }
    const tmp = this.tmp;
    tmp.position.set(t.x, t.y, t.z);
    tmp.quaternion.set(r.x, r.y, r.z, r.w);
    tmp.forward.set(0, 0, 1).applyQuaternion(tmp.quaternion);
    tmp.forward.y = 0;
    tmp.forward.normalize();
    tmp.right.set(1, 0, 0).applyQuaternion(tmp.quaternion);
    tmp.right.y = 0;
    tmp.right.normalize();
    tmp.up.set(0, 1, 0).applyQuaternion(tmp.quaternion).normalize();
    tmp.down.set(0, -1, 0);
    // Keep the center-of-mass velocity separate. tmp.velocity is reused below
    // for contact-point velocities and must never become the aerodynamic input.
    tmp.bodyVelocity.set(linvel.x, linvel.y, linvel.z);
    if (!Number.isFinite(tmp.bodyVelocity.lengthSq())) {
      this.reset(this.safeSample);
      return;
    }
    const longSpeed = tmp.bodyVelocity.dot(tmp.forward);
    const lateralSpeed = tmp.bodyVelocity.dot(tmp.right);
    const speedKmh = Math.abs(longSpeed) * 3.6;
    const pedals = this.updateTransmission(activeInput, safeDt, longSpeed);
    this.steerAngle = damp(this.steerAngle, activeInput.steer * this.config.steer * THREE.MathUtils.lerp(1, 0.28, clamp(speedKmh / 190, 0, 1)), 9, safeDt);
    this.shiftTimer = Math.max(0, this.shiftTimer - safeDt);

    const ratio = this.reverse ? 3.25 : this.config.gears[this.gear - 1];
    const drivenWheels = this.drivenWheels;
    // The road speed determines driveline RPM. Reading it from simulated wheel
    // spin made every launch or kerb strike look like an impossible gear change.
    const roadWheelRpmValue = roadWheelRpm(longSpeed, this.config.wheelRadius);
    const coupledRpm = roadWheelRpmValue * ratio * this.config.finalDrive;
    const freeRpm = this.config.idle + pedals.driveThrottle * (this.config.redline - this.config.idle) * 0.38;
    const clutchDemand = clamp(0.18 + speedKmh / 11 + pedals.driveThrottle * 0.32, 0.18, 1);
    let clutchCoupling = clutchDemand;
    if (!this.reverse && this.transmissionMode === 'AT' && this.gear === 1 && pedals.driveThrottle > 0) {
      // The automatic clutch may carry torque while it is still slipping, but
      // it must not kinematically lock before road speed can sustain launch RPM.
      const launchRpm = this.config.idle
        + pedals.driveThrottle * (this.config.redline - this.config.idle) * 0.24;
      if (coupledRpm < launchRpm) {
        const launchClutchLimit = (freeRpm - launchRpm) / Math.max(1, freeRpm - coupledRpm);
        clutchCoupling = Math.min(clutchDemand, clamp(launchClutchLimit, 0.18, 1));
      }
    }
    const targetRpm = Math.max(this.config.idle, THREE.MathUtils.lerp(freeRpm, coupledRpm, clutchCoupling));
    this.engineRpm = damp(this.engineRpm, targetRpm, this.shiftTimer > 0 ? 5 : 13, safeDt);
    if (!this.reverse && this.transmissionMode === 'AT' && this.shiftTimer <= 0) {
      const throttleDemand = pedals.driveThrottle;
      const upshiftRpm = this.config.redline * THREE.MathUtils.lerp(0.68, 0.91, throttleDemand);
      const downshiftRpm = this.config.redline * THREE.MathUtils.lerp(0.31, 0.43, throttleDemand);
      const lowerRatio = this.config.gears[Math.max(0, this.gear - 2)];
      const lowerGearRpm = roadWheelRpmValue * lowerRatio * this.config.finalDrive;
      if (speedKmh < 5 && this.gear > 1) this.requestShift(1 - this.gear);
      else if (this.engineRpm > upshiftRpm && this.gear < this.config.gears.length) this.requestShift(1);
      else if (this.gear > 1 && this.engineRpm < downshiftRpm && lowerGearRpm < this.config.redline * 0.92) this.requestShift(-1);
    }
    const engineTorque = this.config.torque * this.torqueCurve(this.engineRpm) * pedals.driveThrottle;
    const efficiency = drivetrainEfficiency(this.config.drivetrain);
    let totalDriveTorque = engineTorque * ratio * this.config.finalDrive * efficiency * clutchDemand;
    if (this.reverse) {
      totalDriveTorque *= -0.72;
      if (speedKmh > 38) totalDriveTorque *= clamp((43 - speedKmh) / 5, 0, 1);
    }
    if (this.shiftTimer > 0) totalDriveTorque *= SHIFT_TORQUE_FACTOR;
    const driveTorquePerWheel = totalDriveTorque / Math.max(1, drivenWheels.length);

    const suspension = this.config.suspension;
    const maxRay = suspension.restLength + suspension.travel + this.config.wheelRadius;
    for (let index = 0; index < this.wheels.length; index += 1) {
      const wheel = this.wheels[index];
      tmp.origin.copy(wheel.anchor).applyQuaternion(tmp.quaternion).add(tmp.position);
      const ray = new this.RAPIER.Ray(tmp.origin, tmp.down);
      const hit = this.world.castRayAndGetNormal(ray, maxRay, false, undefined, undefined, undefined, this.body);
      wheel.hit = hit;
      wheel.grounded = Boolean(hit);
      wheel.compression = 0;
      wheel.springForce = 0;
      if (!hit) continue;
      const suspensionLength = hit.timeOfImpact - this.config.wheelRadius;
      wheel.compression = clamp(suspension.restLength - suspensionLength, 0, suspension.travel);
      tmp.point.copy(tmp.origin).addScaledVector(tmp.down, hit.timeOfImpact);
      const pointVelocity = this.body.velocityAtPoint(tmp.point);
      const compressionVelocity = -pointVelocity.y;
      const damper = compressionVelocity >= 0 ? suspension.damperBump : suspension.damperRebound;
      const rawSpringForce = wheel.compression * suspension.springRate + compressionVelocity * damper;
      const maximumWheelLoad = this.config.mass * GRAVITY * 0.72;
      wheel.springForce = clamp(rawSpringForce, 0, maximumWheelLoad);
      wheel.contactPoint = wheel.contactPoint || new THREE.Vector3();
      wheel.contactPoint.copy(tmp.point);
      wheel.surface = this.track.getSurface(tmp.point, this.trackHint).id;
    }

    for (const [leftIndex, rightIndex] of [[0, 1], [2, 3]]) {
      const left = this.wheels[leftIndex];
      const right = this.wheels[rightIndex];
      if (!left.grounded || !right.grounded) continue;
      const antiRoll = (left.compression - right.compression) * suspension.antiRoll;
      const maximumWheelLoad = this.config.mass * GRAVITY * 0.72;
      left.springForce = clamp(left.springForce + antiRoll, 0, maximumWheelLoad);
      right.springForce = clamp(right.springForce - antiRoll, 0, maximumWheelLoad);
    }

    let absActive = false;
    let tcsActive = false;
    let groundedCount = 0;
    let supportedLoad = 0;
    let gripWeightedLoad = 0;
    let averageSurface = 'asphalt';
    for (let index = 0; index < this.wheels.length; index += 1) {
      const wheel = this.wheels[index];
      const telemetry = this.telemetry.wheels[index];
      telemetry.grounded = wheel.grounded;
      telemetry.load = 0;
      telemetry.suspension = wheel.compression;
      telemetry.slipRatio = 0;
      telemetry.slipAngle = 0;
      telemetry.slipPower = 0;
      if (!wheel.grounded) {
        wheel.omega *= 0.998;
        continue;
      }
      groundedCount += 1;
      averageSurface = wheel.surface;
      const normal = wheel.springForce;
      telemetry.load = normal;
      telemetry.surface = wheel.surface;
      telemetry.contactPoint.copy(wheel.contactPoint);
      tmp.force.set(0, normal, 0);
      this.body.addForceAtPoint(tmp.force, wheel.contactPoint, true);

      tmp.wheelForward.copy(tmp.forward);
      if (wheel.front) tmp.wheelForward.applyAxisAngle(tmp.worldUp, this.steerAngle);
      tmp.wheelRight.crossVectors(tmp.worldUp, tmp.wheelForward).normalize();
      const pointVelocity = this.body.velocityAtPoint(wheel.contactPoint);
      tmp.velocity.set(pointVelocity.x, pointVelocity.y, pointVelocity.z);
      const wheelLongSpeed = tmp.velocity.dot(tmp.wheelForward);
      const wheelLateralSpeed = tmp.velocity.dot(tmp.wheelRight);
      const slipRatio = (wheel.omega * this.config.wheelRadius - wheelLongSpeed) / Math.max(3.5, Math.abs(wheelLongSpeed));
      const slipAngle = Math.atan2(wheelLateralSpeed, Math.max(2.2, Math.abs(wheelLongSpeed)));
      const surface = SURFACES[wheel.surface];
      supportedLoad += normal;
      gripWeightedLoad += normal * surface.grip;
      const muLoad = normal * this.config.tire.mu * surface.grip;
      let longitudinalForce = Math.tanh(slipRatio * this.config.tire.longStiffness) * muLoad;
      let lateralForce = -Math.tanh(slipAngle * this.config.tire.lateralStiffness) * muLoad;
      const magnitude = Math.hypot(longitudinalForce, lateralForce);
      if (magnitude > muLoad && magnitude > 0) {
        const scale = muLoad / magnitude;
        longitudinalForce *= scale;
        lateralForce *= scale;
      }
      const rolling = Math.abs(wheelLongSpeed) > 0.25
        ? -Math.sign(wheelLongSpeed) * normal * this.config.tire.rollingResistance * surface.rolling
        : 0;
      longitudinalForce += rolling;
      tmp.force.copy(tmp.wheelForward).multiplyScalar(longitudinalForce).addScaledVector(tmp.wheelRight, lateralForce);
      this.body.addForceAtPoint(tmp.force, wheel.contactPoint, true);

      let wheelDriveTorque = wheel.driven ? driveTorquePerWheel : 0;
      if (pedals.driveThrottle > 0.05 && Math.abs(slipRatio) > 0.11) {
        wheelDriveTorque *= clamp(0.11 / Math.abs(slipRatio), 0.16, 1);
        tcsActive = true;
      }
      let brakeTorque = pedals.serviceBrake * this.config.brakeTorque * (wheel.front ? 0.31 : 0.19);
      if (!wheel.front) brakeTorque += activeInput.handbrake * this.config.brakeTorque * 0.62;
      if (brakeTorque > 0 && slipRatio < -0.17) {
        brakeTorque *= clamp(0.17 / Math.abs(slipRatio), 0.2, 1);
        absActive = true;
      }
      const brakeDirection = Math.sign(Math.abs(wheel.omega) > 0.2 ? wheel.omega : wheelLongSpeed);
      const angularTorque = wheelDriveTorque - longitudinalForce * this.config.wheelRadius - brakeDirection * brakeTorque;
      wheel.omega += angularTorque / this.wheelInertia * safeDt;
      if (brakeTorque > 0 && Math.sign(wheel.omega) !== Math.sign(wheel.omega - angularTorque / this.wheelInertia * safeDt)) wheel.omega = 0;
      wheel.omega = clamp(wheel.omega, -420, 420);
      telemetry.slipRatio = slipRatio;
      telemetry.slipAngle = slipAngle;
      telemetry.slipPower = (Math.abs(longitudinalForce * (wheel.omega * this.config.wheelRadius - wheelLongSpeed)) + Math.abs(lateralForce * wheelLateralSpeed)) / 10000;
    }
    const dragScale = aerodynamicDragScale(this.config.cdA, tmp.bodyVelocity.lengthSq());
    if (dragScale !== 0) {
      tmp.force.copy(tmp.bodyVelocity).multiplyScalar(dragScale);
      this.body.addForce(tmp.force, true);
    }
    const kinematicYawRate = longSpeed / Math.max(2, this.config.wheelbase) * Math.tan(this.steerAngle);
    const supportedGrip = supportedLoad > 1 ? gripWeightedLoad / supportedLoad : 0;
    const targetYawRate = frictionLimitedYawRate(
      kinematicYawRate,
      longSpeed,
      this.config.tire.mu,
      supportedGrip,
    );
    const stabilityError = targetYawRate - angularVelocity.y;
    const stabilityActive = groundedCount >= 2
      && Math.abs(stabilityError) > 0.16
      && speedKmh > 14
      && !activeInput.handbrake;
    if (stabilityActive) {
      const correctionLimit = this.config.mass * 8 * supportedGrip;
      const correctionTorque = clamp(
        stabilityError * this.config.mass * this.config.wheelbase * 1.65,
        -correctionLimit,
        correctionLimit,
      );
      this.body.addTorque({ x: 0, y: correctionTorque, z: 0 }, true);
    }

    this.engineLoad = damp(this.engineLoad, pedals.driveThrottle, 7, safeDt);
    this.telemetry.speedKmh = Math.abs(longSpeed) * 3.6;
    this.telemetry.signedSpeedKmh = longSpeed * 3.6;
    this.telemetry.rpm = this.engineRpm;
    this.telemetry.gear = this.gear;
    this.telemetry.reverse = this.reverse;
    this.telemetry.throttle = pedals.driveThrottle;
    this.telemetry.brake = pedals.serviceBrake;
    this.telemetry.steer = activeInput.steer;
    this.smoothedLongAcceleration = damp(this.smoothedLongAcceleration, (longSpeed - this.previousLongSpeed) / safeDt, 5, safeDt);
    this.telemetry.longitudinalAcceleration = this.smoothedLongAcceleration;
    this.telemetry.lateralAcceleration = longSpeed * angularVelocity.y;
    this.telemetry.surface = averageSurface;
    this.telemetry.absActive = absActive;
    this.telemetry.tcsActive = tcsActive;
    this.telemetry.stabilityActive = stabilityActive;
    this.previousLongSpeed = longSpeed;

    const telemetryFinite = [
      this.engineRpm,
      this.engineLoad,
      this.telemetry.speedKmh,
      this.telemetry.signedSpeedKmh,
      this.telemetry.rpm,
      this.telemetry.throttle,
      this.telemetry.brake,
      this.telemetry.steer,
      this.telemetry.longitudinalAcceleration,
      this.telemetry.lateralAcceleration,
    ].every(Number.isFinite)
      && this.telemetry.wheels.every((wheelTelemetry) => [
        wheelTelemetry.load,
        wheelTelemetry.suspension,
        wheelTelemetry.slipRatio,
        wheelTelemetry.slipAngle,
        wheelTelemetry.slipPower,
      ].every(Number.isFinite) && hasFiniteVector(wheelTelemetry.contactPoint));
    if (!telemetryFinite) {
      this.reset(this.safeSample);
      return;
    }
    this.advanceVisualWheelAngles(safeDt);

    const trackInfo = this.track.nearestInfo(tmp.position, this.trackHint);
    this.trackHint = trackInfo.index;
    if (groundedCount >= 3 && Math.abs(trackInfo.offset) < this.track.config.width * 0.5 && Math.abs(r.x) < 0.42 && Math.abs(r.z) < 0.42) {
      this.safeSample = trackInfo.index;
    }
    const nearlyStoppedWithInput = this.telemetry.speedKmh < 1.2 && pedals.driveThrottle > 0.5;
    this.stuckTimer = nearlyStoppedWithInput ? this.stuckTimer + safeDt : 0;
    const resetReason = tmp.position.y < -4
      ? 'fell-below-world'
      : Math.abs(r.x) > 0.78 || Math.abs(r.z) > 0.78
        ? 'vehicle-overturned'
        : this.stuckTimer > 8
          ? 'vehicle-stuck'
          : null;
    if (resetReason) {
      this.reset(this.safeSample);
      this.onAutomaticReset?.(resetReason);
    }
  }

  afterPhysics() {
    this.previousPose.position.copy(this.currentPose.position);
    this.previousPose.rotation.copy(this.currentPose.rotation);
    const translation = this.body.translation();
    const rotation = this.body.rotation();
    this.currentPose.position.set(translation.x, translation.y, translation.z);
    this.currentPose.rotation.set(rotation.x, rotation.y, rotation.z, rotation.w);
  }

  syncVisual(alpha = 1) {
    this.visual.position.lerpVectors(this.previousPose.position, this.currentPose.position, alpha);
    this.visual.quaternion.slerpQuaternions(this.previousPose.rotation, this.currentPose.rotation, alpha);
    for (let index = 0; index < this.visualWheelBindings.length; index += 1) {
      const binding = this.visualWheelBindings[index];
      const wheel = this.wheels[index];
      binding.steer.position.y = binding.baseY + wheel.compression;
      binding.steer.rotation.y = wheel.front ? this.steerAngle : 0;
      binding.roll.rotation.x = THREE.MathUtils.lerp(wheel.previousVisualAngle, wheel.visualAngle, alpha);
    }
  }

  destroy() {
    this.scene.remove(this.visual);
    this.world.removeRigidBody(this.body);
    disposeOwnedVisual(this.visual);
  }
}
~~~~

### src/vehicle-physics.js

~~~~javascript
export const GRAVITY = 9.81;
export const AIR_DENSITY = 1.225;
export const AERO_MIN_SPEED_SQUARED = 0.04;

export const DRIVETRAIN_EFFICIENCY = Object.freeze({
  AWD: 0.82,
  FWD: 0.88,
  RWD: 0.88,
});

export const SHIFT_DURATION = 0.18;
export const SHIFT_TORQUE_FACTOR = 0.08;

export const TORQUE_CURVE = Object.freeze({
  idleFactor: 0.56,
  redlineFactor: 0.74,
  limiterRatio: 1.018,
});

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const lerp = (start, end, alpha) => start + (end - start) * alpha;

export function torqueCurveFactor(config, rpm) {
  if (rpm >= config.redline * TORQUE_CURVE.limiterRatio) return 0;
  const rise = clamp01((rpm - config.idle) / Math.max(1, config.peakRpm - config.idle));
  const fall = clamp01((rpm - config.peakRpm) / Math.max(1, config.redline - config.peakRpm));
  return rpm <= config.peakRpm
    ? lerp(TORQUE_CURVE.idleFactor, 1, Math.sin(rise * Math.PI * 0.5))
    : lerp(1, TORQUE_CURVE.redlineFactor, fall);
}

export function drivetrainEfficiency(drivetrain) {
  return DRIVETRAIN_EFFICIENCY[drivetrain] ?? DRIVETRAIN_EFFICIENCY.RWD;
}

export function roadWheelRpm(speedMps, wheelRadius) {
  return Math.abs(speedMps) / Math.max(Number.EPSILON, wheelRadius) * 60 / (2 * Math.PI);
}

// Multiplying a velocity vector by this scalar produces a force opposite to
// that velocity with magnitude 0.5 * rho * CdA * speed^2.
export function aerodynamicDragScale(cdA, speedSquared) {
  if (speedSquared <= AERO_MIN_SPEED_SQUARED) return 0;
  return -0.5 * AIR_DENSITY * cdA * Math.sqrt(speedSquared);
}

// A yaw target can only be generated by tire force. Limit the kinematic target
// to the friction-circle acceleration available at the supported wheels so the
// stability assist cannot manufacture asphalt-level turning on loose surfaces.
export function frictionLimitedYawRate(targetYawRate, speedMps, tireMu, surfaceGrip) {
  const target = Number.isFinite(targetYawRate) ? targetYawRate : 0;
  const speed = Math.abs(Number.isFinite(speedMps) ? speedMps : 0);
  const grip = Math.max(0, Number.isFinite(surfaceGrip) ? surfaceGrip : 0);
  const mu = Math.max(0, Number.isFinite(tireMu) ? tireMu : 0);
  const maximumYawRate = mu * grip * GRAVITY / Math.max(1, speed);
  return Math.max(-maximumYawRate, Math.min(maximumYawRate, target));
}
~~~~

### src/physics-scheduling.js

~~~~javascript
import { FIXED_DT } from './config.js';

// Keep the largest accepted render delta and the catch-up budget aligned. A
// 50ms frame contains six 120Hz simulation steps; allowing only five steps
// would silently make races slower on a 20 FPS device.
export const MAX_FRAME_DT = 0.05;
export const MAX_PHYSICS_STEPS = Math.ceil(MAX_FRAME_DT / FIXED_DT);

export function clampFrameDelta(deltaSeconds) {
  return Math.min(MAX_FRAME_DT, Math.max(0, deltaSeconds));
}

export function accumulatePhysicsTime(accumulator, deltaSeconds) {
  return Math.min(
    accumulator + clampFrameDelta(deltaSeconds),
    FIXED_DT * MAX_PHYSICS_STEPS,
  );
}
~~~~

### src/physics-scheduler-owner.js

~~~~javascript
import { FIXED_DT } from './config.js';
import {
  MAX_FRAME_DT,
  MAX_PHYSICS_STEPS,
  accumulatePhysicsTime,
} from './physics-scheduling.js';
import {
  DEFAULT_CORE_WASM_URL,
  fallbackReasonFromError,
  instantiateSharedCore,
} from './shared-core-loader.js';

export { DEFAULT_CORE_WASM_URL } from './shared-core-loader.js';

class SchedulerLoadError extends Error {
  constructor(code, message, cause) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'SchedulerLoadError';
    this.code = code;
  }
}

function result(steps, remainderSeconds) {
  return {
    steps,
    remainderSeconds,
    alpha: remainderSeconds / FIXED_DT,
  };
}

function createScheduler({ owner, fallbackReason = null, planFrame }) {
  let accumulatorSeconds = 0;
  return {
    owner,
    fallbackReason,
    fixedDtSeconds: FIXED_DT,
    maxFrameDtSeconds: MAX_FRAME_DT,
    maxPhysicsSteps: MAX_PHYSICS_STEPS,
    get accumulatorSeconds() {
      return accumulatorSeconds;
    },
    reset() {
      accumulatorSeconds = 0;
    },
    advance(deltaSeconds) {
      const plan = planFrame(accumulatorSeconds, deltaSeconds);
      accumulatorSeconds = plan.remainderSeconds;
      return result(plan.steps, accumulatorSeconds);
    },
  };
}

export function createJavaScriptPhysicsScheduler({ fallbackReason = null } = {}) {
  return createScheduler({
    owner: 'javascript',
    fallbackReason,
    planFrame(accumulatorSeconds, deltaSeconds) {
      let remainderSeconds = accumulatePhysicsTime(accumulatorSeconds, deltaSeconds);
      let steps = 0;
      while (remainderSeconds >= FIXED_DT && steps < MAX_PHYSICS_STEPS) {
        remainderSeconds -= FIXED_DT;
        steps += 1;
      }
      return { steps, remainderSeconds };
    },
  });
}

const requiredWasmFunctions = [
  'streetrush_fixed_dt_seconds',
  'streetrush_max_frame_dt_seconds',
  'streetrush_max_physics_steps',
  'streetrush_plan_physics_steps',
  'streetrush_plan_remainder_seconds',
];

function readExports(source) {
  const exports = source?.instance?.exports ?? source?.exports;
  if (!exports || typeof exports !== 'object') {
    throw new SchedulerLoadError('wasm-export-missing', 'WASM instance did not expose an exports object');
  }
  for (const name of requiredWasmFunctions) {
    if (typeof exports[name] !== 'function') {
      throw new SchedulerLoadError('wasm-export-missing', `WASM export is missing: ${name}`);
    }
  }
  return exports;
}

function assertContract(exports) {
  const contract = {
    fixedDtSeconds: exports.streetrush_fixed_dt_seconds(),
    maxFrameDtSeconds: exports.streetrush_max_frame_dt_seconds(),
    maxPhysicsSteps: exports.streetrush_max_physics_steps(),
  };
  if (
    contract.fixedDtSeconds !== FIXED_DT
    || contract.maxFrameDtSeconds !== MAX_FRAME_DT
    || contract.maxPhysicsSteps !== MAX_PHYSICS_STEPS
  ) {
    throw new SchedulerLoadError(
      'wasm-contract-mismatch',
      `WASM scheduler contract mismatch: ${JSON.stringify(contract)}`,
    );
  }
}

export function createWasmPhysicsScheduler(source) {
  const exports = readExports(source);
  assertContract(exports);
  return createScheduler({
    owner: 'rust-wasm',
    planFrame(accumulatorSeconds, deltaSeconds) {
      const steps = exports.streetrush_plan_physics_steps(accumulatorSeconds, deltaSeconds);
      const remainderSeconds = exports.streetrush_plan_remainder_seconds(accumulatorSeconds, deltaSeconds);
      if (
        !Number.isInteger(steps)
        || steps < 0
        || steps > MAX_PHYSICS_STEPS
        || !Number.isFinite(remainderSeconds)
        || remainderSeconds < 0
        || remainderSeconds >= FIXED_DT
      ) {
        throw new SchedulerLoadError(
          'wasm-plan-invalid',
          `WASM scheduler returned an invalid plan: steps=${steps}, remainder=${remainderSeconds}`,
        );
      }
      return { steps, remainderSeconds };
    },
  });
}

export async function loadPhysicsScheduler({
  wasmUrl = DEFAULT_CORE_WASM_URL,
  fetchImpl = globalThis.fetch,
  instantiate,
  timeoutMs = 1500,
} = {}) {
  try {
    const source = await instantiateSharedCore({ wasmUrl, fetchImpl, instantiate, timeoutMs });
    return createWasmPhysicsScheduler(source);
  } catch (error) {
    return createJavaScriptPhysicsScheduler({
      fallbackReason: fallbackReasonFromError(error),
    });
  }
}
~~~~

### src/shared-core-owner.js

~~~~javascript
import {
  createJavaScriptPhysicsScheduler,
  createWasmPhysicsScheduler,
} from './physics-scheduler-owner.js';
import {
  createJavaScriptRaceProgressCore,
  createWasmRaceProgressCore,
} from './race-progress-core.js';
import {
  fallbackReasonFromError,
  instantiateSharedCore,
} from './shared-core-loader.js';

function createCapability(factory, fallback) {
  try {
    return factory();
  } catch (error) {
    return fallback(fallbackReasonFromError(error));
  }
}

export async function loadSharedCoreCapabilities(options) {
  let source;
  try {
    source = await instantiateSharedCore(options);
  } catch (error) {
    const loadFallbackReason = fallbackReasonFromError(error);
    return {
      loadFallbackReason,
      scheduler: createJavaScriptPhysicsScheduler({ fallbackReason: loadFallbackReason }),
      raceProgress: createJavaScriptRaceProgressCore({ fallbackReason: loadFallbackReason }),
    };
  }

  return {
    loadFallbackReason: null,
    scheduler: createCapability(
      () => createWasmPhysicsScheduler(source),
      (fallbackReason) => createJavaScriptPhysicsScheduler({ fallbackReason }),
    ),
    raceProgress: createCapability(
      () => createWasmRaceProgressCore(source),
      (fallbackReason) => createJavaScriptRaceProgressCore({ fallbackReason }),
    ),
  };
}
~~~~

### crates/streetrush-core/src/scheduling.rs

~~~~rust
//! Fixed-step scheduling contract shared by the native and web runtimes.
//!
//! The initial behavior is intentionally matched to the committed JavaScript
//! baseline in `src/physics-scheduling.js`: 120 Hz simulation, a 50 ms accepted
//! render-frame delta, and a six-step catch-up budget.

/// Simulation frequency used by the current playable baseline.
pub const FIXED_HZ: u32 = 120;
/// Duration of one physics tick in seconds.
pub const FIXED_DT_SECONDS: f64 = 1.0 / FIXED_HZ as f64;
/// Largest render-frame delta accepted by the scheduler.
pub const MAX_FRAME_DT_SECONDS: f64 = 0.05;
/// Maximum number of fixed steps consumed for one render frame.
pub const MAX_PHYSICS_STEPS: u32 = 6;

/// Result of accepting one render-frame delta.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FramePlan {
    pub steps: u32,
    pub remainder_seconds: f64,
}

/// Aggregate result for a deterministic render-frame sequence.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SimulationResult {
    pub steps: u64,
    pub remainder_seconds: f64,
}

/// Stateful fixed-step accumulator used by both executable targets.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FixedStepScheduler {
    accumulator_seconds: f64,
}

impl FixedStepScheduler {
    #[must_use]
    pub const fn new() -> Self {
        Self {
            accumulator_seconds: 0.0,
        }
    }

    #[must_use]
    pub const fn accumulator_seconds(&self) -> f64 {
        self.accumulator_seconds
    }

    pub fn reset(&mut self) {
        self.accumulator_seconds = 0.0;
    }

    pub fn advance(&mut self, delta_seconds: f64) -> FramePlan {
        let plan = plan_frame(self.accumulator_seconds, delta_seconds);
        self.accumulator_seconds = plan.remainder_seconds;
        plan
    }
}

/// Match `Math.min(MAX_FRAME_DT, Math.max(0, deltaSeconds))`, including NaN.
#[must_use]
pub fn clamp_frame_delta(delta_seconds: f64) -> f64 {
    delta_seconds.clamp(0.0, MAX_FRAME_DT_SECONDS)
}

/// Fill the accumulator while preserving the JavaScript baseline's hard cap.
#[must_use]
pub fn accumulate_physics_time(accumulator_seconds: f64, delta_seconds: f64) -> f64 {
    let total = accumulator_seconds + clamp_frame_delta(delta_seconds);
    if total.is_nan() {
        f64::NAN
    } else {
        total.min(FIXED_DT_SECONDS * f64::from(MAX_PHYSICS_STEPS))
    }
}

/// Plan the fixed steps for one render frame without mutating caller state.
#[must_use]
pub fn plan_frame(accumulator_seconds: f64, delta_seconds: f64) -> FramePlan {
    let mut remainder_seconds = accumulate_physics_time(accumulator_seconds, delta_seconds);
    let mut steps = 0;
    while remainder_seconds >= FIXED_DT_SECONDS && steps < MAX_PHYSICS_STEPS {
        remainder_seconds -= FIXED_DT_SECONDS;
        steps += 1;
    }
    FramePlan {
        steps,
        remainder_seconds,
    }
}

/// Run a constant render-frame sequence through the same stateful scheduler.
#[must_use]
pub fn simulate_render_frames(delta_seconds: f64, frame_count: u32) -> SimulationResult {
    let mut scheduler = FixedStepScheduler::new();
    let mut steps = 0_u64;
    for _ in 0..frame_count {
        steps += u64::from(scheduler.advance(delta_seconds).steps);
    }
    SimulationResult {
        steps,
        remainder_seconds: scheduler.accumulator_seconds(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPSILON: f64 = 1.0e-12;

    fn assert_near(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < EPSILON,
            "expected {expected}, got {actual}"
        );
    }

    #[test]
    fn constants_match_the_committed_javascript_contract() {
        assert!((FIXED_DT_SECONDS - 1.0 / 120.0).abs() < f64::EPSILON);
        assert!((MAX_FRAME_DT_SECONDS - 0.05).abs() < f64::EPSILON);
        assert_eq!(MAX_PHYSICS_STEPS, 6);
    }

    #[test]
    fn clamp_matches_javascript_boundaries() {
        assert_near(clamp_frame_delta(-1.0), 0.0);
        assert_near(clamp_frame_delta(f64::NEG_INFINITY), 0.0);
        assert_near(clamp_frame_delta(0.05), 0.05);
        assert_near(clamp_frame_delta(0.2), MAX_FRAME_DT_SECONDS);
        assert_near(clamp_frame_delta(f64::INFINITY), MAX_FRAME_DT_SECONDS);
        assert!(clamp_frame_delta(f64::NAN).is_nan());
    }

    #[test]
    fn accumulator_is_capped_to_the_per_frame_budget() {
        let cap = FIXED_DT_SECONDS * f64::from(MAX_PHYSICS_STEPS);
        assert_near(accumulate_physics_time(cap, 0.01), cap);
        assert_near(accumulate_physics_time(0.0, 1.0), cap);
        assert!(accumulate_physics_time(0.0, f64::NAN).is_nan());
    }

    #[test]
    fn frame_plan_consumes_at_most_six_steps() {
        let plan = plan_frame(0.0, 1.0);
        assert_eq!(plan.steps, 6);
        assert!(plan.remainder_seconds.abs() < EPSILON);
    }

    #[test]
    fn stateful_scheduler_preserves_substep_remainder() {
        let mut scheduler = FixedStepScheduler::new();
        let first = scheduler.advance(FIXED_DT_SECONDS * 0.75);
        let second = scheduler.advance(FIXED_DT_SECONDS * 0.75);
        assert_eq!(first.steps, 0);
        assert_eq!(second.steps, 1);
        assert!((second.remainder_seconds - FIXED_DT_SECONDS * 0.5).abs() < EPSILON);
        scheduler.reset();
        assert_near(scheduler.accumulator_seconds(), 0.0);
    }

    #[test]
    fn sixty_second_oracle_matches_the_web_baseline() {
        for (frames_per_second, expected_seconds) in [
            (60_u32, 60.0),
            (30, 60.0),
            (24, 60.0),
            (20, 60.0),
            (15, 45.0),
        ] {
            let result =
                simulate_render_frames(1.0 / f64::from(frames_per_second), frames_per_second * 60);
            let step_count = u32::try_from(result.steps).expect("one-minute step count fits u32");
            let simulated_seconds = f64::from(step_count) * FIXED_DT_SECONDS;
            assert!(
                (simulated_seconds - expected_seconds).abs() < 0.001,
                "{frames_per_second} FPS produced {simulated_seconds} seconds"
            );
        }
    }
}
~~~~

### crates/streetrush-core/src/wasm_exports.rs

~~~~rust
//! Dependency-free raw WebAssembly ABI for the first shared-core slice.

use crate::scheduling::{
    FIXED_DT_SECONDS, MAX_FRAME_DT_SECONDS, MAX_PHYSICS_STEPS, accumulate_physics_time,
    clamp_frame_delta, plan_frame, simulate_render_frames,
};
use crate::timing::{
    TIMING_CONTRACT_VERSION, advance_race_time_exact_ms, checkpoint_ordinal, classify_checkpoint,
    expected_checkpoint_index, resolve_medal_ms, round_duration_ms,
};
use crate::{
    REPLAY_DIGEST_OFFSET_BASIS, REPLAY_FORMAT_VERSION, REPLAY_QUANTUM, canonical_f64_bits,
    quantize_replay_value, replay_digest_push_f64,
};

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_timing_contract_version() -> u32 {
    TIMING_CONTRACT_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_timing_advance_exact_ms(
    status: u32,
    current_ms: f64,
    delta_ms: f64,
) -> f64 {
    advance_race_time_exact_ms(status, current_ms, delta_ms)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_timing_round_duration_ms(value: f64) -> f64 {
    round_duration_ms(value)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_timing_expected_checkpoint_index(
    checkpoints_passed: u32,
    checkpoint_count: u32,
) -> u32 {
    expected_checkpoint_index(checkpoints_passed, checkpoint_count)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_timing_checkpoint_ordinal(
    checkpoints_passed: u32,
    checkpoint_count: u32,
) -> u32 {
    checkpoint_ordinal(checkpoints_passed, checkpoint_count)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_timing_checkpoint_flags(
    status: u32,
    checkpoints_passed: u32,
    total_laps: u32,
    checkpoint_count: u32,
    next_sector_checkpoint: u32,
    checkpoint_index: u32,
) -> u32 {
    classify_checkpoint(
        status,
        checkpoints_passed,
        total_laps,
        checkpoint_count,
        next_sector_checkpoint,
        checkpoint_index,
    )
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_timing_resolve_medal(
    time_ms: f64,
    gold_ms: f64,
    silver_ms: f64,
    bronze_ms: f64,
) -> u32 {
    resolve_medal_ms(time_ms, gold_ms, silver_ms, bronze_ms) as u32
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_replay_format_version() -> u32 {
    REPLAY_FORMAT_VERSION
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_replay_quantum() -> f64 {
    REPLAY_QUANTUM
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_replay_digest_offset_basis() -> u64 {
    REPLAY_DIGEST_OFFSET_BASIS
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_replay_canonical_f64_bits(value: f64) -> u64 {
    canonical_f64_bits(value)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_quantize_replay_value(value: f64, quantum: f64) -> f64 {
    quantize_replay_value(value, quantum)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_replay_digest_push_f64(state: u64, value: f64) -> u64 {
    replay_digest_push_f64(state, value)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_fixed_dt_seconds() -> f64 {
    FIXED_DT_SECONDS
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_max_frame_dt_seconds() -> f64 {
    MAX_FRAME_DT_SECONDS
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_max_physics_steps() -> u32 {
    MAX_PHYSICS_STEPS
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_clamp_frame_delta(delta_seconds: f64) -> f64 {
    clamp_frame_delta(delta_seconds)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_accumulate_physics_time(
    accumulator_seconds: f64,
    delta_seconds: f64,
) -> f64 {
    accumulate_physics_time(accumulator_seconds, delta_seconds)
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_plan_physics_steps(
    accumulator_seconds: f64,
    delta_seconds: f64,
) -> u32 {
    plan_frame(accumulator_seconds, delta_seconds).steps
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_plan_remainder_seconds(
    accumulator_seconds: f64,
    delta_seconds: f64,
) -> f64 {
    plan_frame(accumulator_seconds, delta_seconds).remainder_seconds
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_simulate_step_count(delta_seconds: f64, frame_count: u32) -> u64 {
    simulate_render_frames(delta_seconds, frame_count).steps
}

#[unsafe(no_mangle)]
pub extern "C" fn streetrush_simulate_remainder_seconds(
    delta_seconds: f64,
    frame_count: u32,
) -> f64 {
    simulate_render_frames(delta_seconds, frame_count).remainder_seconds
}
~~~~

### scripts/physics-harness.mjs

~~~~javascript
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { FIXED_DT } from '../src/config.js';
import { initializeRapier } from '../src/rapier-init.js';
import { GRAVITY } from '../src/vehicle-physics.js';
import { VehicleSystem } from '../src/vehicle.js';

await initializeRapier(RAPIER);

export const zeroInput = (patch = {}) => ({
  steer: 0,
  throttle: 0,
  brake: 0,
  handbrake: 0,
  shiftUp: false,
  shiftDown: false,
  toggleTransmission: false,
  reset: false,
  ...patch,
});

export class FlatTrack {
  constructor({ width = 10000, sampleSpacing = 2 } = {}) {
    this.config = { width };
    this.sampleSpacing = sampleSpacing;
  }

  getResetPose(index = 0) {
    return {
      position: new THREE.Vector3(0, 0.8, index * this.sampleSpacing),
      yaw: 0,
      sampleIndex: index,
    };
  }

  getSurface(position) {
    return { id: 'asphalt', grip: 1, rolling: 1, info: this.nearestInfo(position) };
  }

  nearestInfo(position) {
    return {
      index: Math.max(0, Math.round(position.z / this.sampleSpacing)),
      offset: position.x,
      point: new THREE.Vector3(0, 0, position.z),
      surface: 'asphalt',
    };
  }
}

export function createVehicleRig(config, {
  groundHalfExtent = 12000,
  trackWidth = 10000,
  visual = new THREE.Group(),
} = {}) {
  const world = new RAPIER.World({ x: 0, y: -GRAVITY, z: 0 });
  world.integrationParameters.dt = FIXED_DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.3, 0));
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(groundHalfExtent, 0.3, groundHalfExtent).setFriction(0.2),
    ground,
  );
  const scene = new THREE.Scene();
  const vehicle = new VehicleSystem({
    RAPIER,
    world,
    scene,
    track: new FlatTrack({ width: trackWidth }),
    config,
    visual,
  });
  return { vehicle, world };
}

export function stepVehicle(rig, input = zeroInput()) {
  rig.vehicle.fixedUpdate(input, false, FIXED_DT);
  rig.world.step();
  rig.vehicle.afterPhysics();
}

export function runFor(rig, seconds, input = zeroInput(), onStep) {
  const steps = Math.round(seconds / FIXED_DT);
  for (let index = 0; index < steps; index += 1) {
    stepVehicle(rig, input);
    onStep?.({ index, elapsed: (index + 1) * FIXED_DT, ...rig });
  }
}

export function settleVehicle(rig, seconds = 2) {
  runFor(rig, seconds, zeroInput());
}

export function destroyVehicleRig(rig) {
  rig.vehicle.destroy();
  rig.world.free();
}

export function yawOf(rotation) {
  return Math.atan2(
    2 * (rotation.w * rotation.y + rotation.x * rotation.z),
    1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z),
  );
}
~~~~

### scripts/test-input.mjs

~~~~javascript
import assert from 'node:assert/strict';

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatchEvent(event) {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
  }
}

class FakeElement extends FakeEventTarget {
  constructor(id, tagName = 'div', { parentElement = null, isContentEditable = false } = {}) {
    super();
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.parentElement = parentElement;
    this.isContentEditable = isContentEditable;
    this.classList = {
      values: new Set(),
      add: (name) => this.classList.values.add(name),
      remove: (name) => this.classList.values.delete(name),
      contains: (name) => this.classList.values.has(name),
    };
    this.capturedPointers = new Set();
    this.setPointerCaptureCalls = [];
    this.releasePointerCaptureCalls = [];
  }

  closest() {
    let current = this;
    while (current) {
      const tagName = current.tagName.toLowerCase();
      if (['button', 'a', 'input', 'textarea', 'select'].includes(tagName) || current.isContentEditable) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  setPointerCapture(pointerId) {
    this.capturedPointers.add(pointerId);
    this.setPointerCaptureCalls.push(pointerId);
  }

  releasePointerCapture(pointerId) {
    this.capturedPointers.delete(pointerId);
    this.releasePointerCaptureCalls.push(pointerId);
  }

  hasPointerCapture(pointerId) {
    return this.capturedPointers.has(pointerId);
  }
}

const ids = [
  'mobile-controls',
  'touch-left',
  'touch-right',
  'touch-throttle',
  'touch-brake',
  'touch-handbrake',
  'touch-reset',
  'touch-mode',
  'touch-shift-up',
  'touch-shift-down',
];
const elements = new Map(ids.map((id) => [id, new FakeElement(id)]));
const documentTarget = new FakeEventTarget();
let gamepads = [];
globalThis.windowTarget = new FakeEventTarget();
globalThis.addEventListener = (...args) => globalThis.windowTarget.addEventListener(...args);
globalThis.document = {
  hidden: false,
  addEventListener: (...args) => documentTarget.addEventListener(...args),
  getElementById: (id) => elements.get(id) ?? null,
  querySelectorAll: () => [...elements.values()].filter((element) => element.classList.contains('pressed')),
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { getGamepads: () => gamepads, vibrate: () => {} },
});

const { InputController } = await import('../src/input.js');
const controller = new InputController();
controller.setTouchEnabled(true);

const frameStep = () => controller.update(1 / 60);

function makeGamepad({ axis = 0, throttle = 0, brake = 0, handbrake = 0, shiftUp = false, shiftDown = false, reset = false, menu = false } = {}) {
  const buttons = Array.from({ length: 10 }, () => ({ value: 0, pressed: false }));
  buttons[0] = { value: handbrake, pressed: handbrake > 0.5 };
  buttons[3] = { value: reset ? 1 : 0, pressed: reset };
  buttons[4] = { value: shiftDown ? 1 : 0, pressed: shiftDown };
  buttons[5] = { value: shiftUp ? 1 : 0, pressed: shiftUp };
  buttons[6] = { value: brake, pressed: brake > 0.5 };
  buttons[7] = { value: throttle, pressed: throttle > 0.5 };
  buttons[9] = { value: menu ? 1 : 0, pressed: menu };
  return { axes: [axis], buttons };
}

function makeKeyEvent(code, options = {}) {
  const event = {
    type: 'keydown',
    code,
    repeat: false,
    target: null,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    defaultPrevented: false,
    ...options,
  };
  event.preventDefault = () => {
    event.defaultPrevented = true;
  };
  return event;
}

function makePointerEvent(type, pointerId) {
  return { type, pointerId, preventDefault() {} };
}

function makeKeyboardEvent(type, code, options = {}) {
  return {
    type,
    code,
    repeat: false,
    detail: 0,
    preventDefault() {},
    ...options,
  };
}

const canvas = new FakeElement('canvas');
const keyboardButton = new FakeElement('keyboard-button', 'button');
const keyboardLink = new FakeElement('keyboard-link', 'a');
const keyboardInput = new FakeElement('keyboard-input', 'input');
const keyboardTextarea = new FakeElement('keyboard-textarea', 'textarea');
const keyboardSelect = new FakeElement('keyboard-select', 'select');
const keyboardEditable = new FakeElement('keyboard-editable', 'div', { isContentEditable: true });
const buttonChild = new FakeElement('button-child', 'span', { parentElement: keyboardButton });

for (const target of [
  keyboardButton,
  keyboardLink,
  keyboardInput,
  keyboardTextarea,
  keyboardSelect,
  keyboardEditable,
  buttonChild,
]) {
  const event = makeKeyEvent('KeyR', { target });
  windowTarget.dispatchEvent(event);
  assert.equal(controller.keys.has('KeyR'), false);
  assert.equal(controller.pulses.has('KeyR'), false);
  assert.equal(event.defaultPrevented, false);
}

for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
  const event = makeKeyEvent('KeyR', { target: canvas, [modifier]: true });
  windowTarget.dispatchEvent(event);
  assert.equal(controller.keys.has('KeyR'), false);
  assert.equal(controller.pulses.has('KeyR'), false);
  assert.equal(event.defaultPrevented, false);
}

const gameplayKey = makeKeyEvent('ArrowUp', { target: canvas });
windowTarget.dispatchEvent(gameplayKey);
assert.equal(controller.keys.has('ArrowUp'), true);
assert.equal(controller.pulses.has('ArrowUp'), true);
assert.equal(gameplayKey.defaultPrevented, true);
windowTarget.dispatchEvent({ type: 'keyup', code: 'ArrowUp', target: canvas });
assert.equal(controller.keys.has('ArrowUp'), false);
controller.releaseAll();

windowTarget.dispatchEvent(makeKeyEvent('KeyE'));
assert.equal(controller.keys.has('KeyE'), true);
assert.equal(frameStep().shiftUp, true);
windowTarget.dispatchEvent(makeKeyEvent('KeyE'));
windowTarget.dispatchEvent(makeKeyEvent('KeyE', { repeat: true }));
assert.equal(frameStep().shiftUp, false);
windowTarget.dispatchEvent({ type: 'keyup', code: 'KeyE', target: canvas });

windowTarget.dispatchEvent(makeKeyEvent('KeyW'));
assert.ok(frameStep().throttle > 0);
controller.releaseAll();
assert.equal(controller.keys.has('KeyW'), false);
assert.equal(controller.frame.throttle, 0);
windowTarget.dispatchEvent(makeKeyEvent('KeyW', { repeat: true }));
assert.equal(controller.keys.has('KeyW'), false);
windowTarget.dispatchEvent(makeKeyEvent('KeyW'));
assert.equal(controller.keys.has('KeyW'), false);
assert.equal(frameStep().throttle, 0);
windowTarget.dispatchEvent({ type: 'keyup', code: 'KeyW', target: canvas });
windowTarget.dispatchEvent(makeKeyEvent('KeyW'));
assert.equal(controller.keys.has('KeyW'), true);
assert.ok(frameStep().throttle > 0);
windowTarget.dispatchEvent({ type: 'keyup', code: 'KeyW', target: canvas });
controller.releaseAll();

const pad = makeGamepad();
gamepads = [pad];
assert.equal(frameStep().throttle, 0);
pad.axes[0] = 0.72;
pad.buttons[5] = { value: 1, pressed: true };
pad.buttons[7] = { value: 1, pressed: true };
assert.ok(frameStep().throttle > 0);
assert.equal(controller.frame.shiftUp, true);
controller.releaseAll();
assert.equal(controller.frame.throttle, 0);
assert.equal(controller.frame.steer, 0);
pad.axes[0] = 0.72;
assert.equal(frameStep().throttle, 0);
assert.equal(controller.frame.steer, 0);
assert.equal(controller.frame.shiftUp, false);
pad.axes[0] = 0;
pad.buttons[5] = { value: 0, pressed: false };
pad.buttons[7] = { value: 0, pressed: false };
assert.equal(frameStep().throttle, 0);
pad.axes[0] = -0.72;
pad.buttons[5] = { value: 1, pressed: true };
pad.buttons[7] = { value: 1, pressed: true };
assert.ok(frameStep().throttle > 0);
assert.ok(controller.frame.steer > 0);
assert.equal(controller.frame.shiftUp, true);
gamepads = [];
frameStep();
assert.equal(controller.frame.driveIntent, 0);
assert.equal(controller.frame.shiftUp, false);
pad.axes[0] = 0.72;
pad.buttons[5] = { value: 1, pressed: true };
pad.buttons[7] = { value: 1, pressed: true };
gamepads = [pad];
frameStep();
assert.equal(controller.frame.driveIntent, 0);
assert.equal(controller.frame.shiftUp, false);
pad.axes[0] = 0;
pad.buttons[5] = { value: 0, pressed: false };
pad.buttons[7] = { value: 0, pressed: false };
frameStep();
assert.equal(controller.frame.driveIntent, 0);
assert.equal(controller.frame.shiftUp, false);
pad.axes[0] = -0.72;
pad.buttons[5] = { value: 1, pressed: true };
pad.buttons[7] = { value: 1, pressed: true };
assert.ok(frameStep().throttle > 0);
assert.ok(controller.frame.steer > 0);
assert.equal(controller.frame.shiftUp, true);
gamepads = [];
controller.releaseAll();

const replacementPad = makeGamepad({ axis: 0.72, throttle: 1, shiftUp: true });
gamepads = [pad];
pad.axes[0] = 0;
pad.buttons[5] = { value: 0, pressed: false };
pad.buttons[7] = { value: 0, pressed: false };
assert.equal(frameStep().driveIntent, 0);
pad.axes[0] = -0.72;
pad.buttons[5] = { value: 1, pressed: true };
pad.buttons[7] = { value: 1, pressed: true };
assert.ok(frameStep().throttle > 0);
gamepads = [replacementPad];
assert.equal(frameStep().driveIntent, 0, 'replacement gamepad waits for a neutral handshake');
assert.equal(controller.frame.shiftUp, false);
replacementPad.axes[0] = 0;
replacementPad.buttons[5] = { value: 0, pressed: false };
replacementPad.buttons[7] = { value: 0, pressed: false };
assert.equal(frameStep().driveIntent, 0);
replacementPad.axes[0] = 0.72;
replacementPad.buttons[5] = { value: 1, pressed: true };
replacementPad.buttons[7] = { value: 1, pressed: true };
assert.equal(frameStep().driveIntent, 1);
assert.equal(controller.frame.shiftUp, true);
gamepads = [];
controller.releaseAll();

const menuPad = makeGamepad();
gamepads = [menuPad];
assert.equal(controller.consumeGamepadMenuPulse(), false, 'neutral gamepad rearms the menu button');
menuPad.buttons[9] = { value: 1, pressed: true };
assert.equal(controller.consumeGamepadMenuPulse(), true, 'gamepad menu button emits a rising-edge pulse');
assert.equal(controller.consumeGamepadMenuPulse(), false, 'held gamepad menu button does not repeat');
menuPad.buttons[9] = { value: 0, pressed: false };
assert.equal(controller.consumeGamepadMenuPulse(), false);
menuPad.buttons[9] = { value: 1, pressed: true };
assert.equal(controller.consumeGamepadMenuPulse(), true, 'gamepad menu button rearms after release');
controller.releaseAll();
assert.equal(controller.consumeGamepadMenuPulse(), false, 'pause entry waits for the held menu button to release');
menuPad.buttons[9] = { value: 0, pressed: false };
assert.equal(controller.consumeGamepadMenuPulse(), false);
menuPad.buttons[9] = { value: 1, pressed: true };
assert.equal(controller.consumeGamepadMenuPulse(), true, 'a fresh press can resume after pause');
gamepads = [];
controller.releaseAll();

const throttle = elements.get('touch-throttle');
const brake = elements.get('touch-brake');
const left = elements.get('touch-left');
const reset = elements.get('touch-reset');

const FIXED_DT = 1 / 120;
function assertPulseSurvivesSubFixedFrames({ label, field, prepare, trigger, release }) {
  controller.releaseAll();
  gamepads = [];
  controller.update(0, 0, { deferFixedPulses: true });
  prepare?.();
  trigger();

  const renderDt = FIXED_DT * 0.4;
  for (const frameNumber of [1, 2]) {
    const frame = controller.update(renderDt, 0, { deferFixedPulses: true });
    assert.equal(frame[field], true, `${label}: sub-fixed frame ${frameNumber} retains pulse`);
  }

  const fixedStepFrame = controller.update(renderDt, 0, { deferFixedPulses: true });
  assert.equal(fixedStepFrame[field], true, `${label}: next fixed step receives pulse`);
  controller.consumeFixedPulses();
  assert.equal(controller.frame[field], false, `${label}: fixed step consumes pulse once`);
  assert.equal(
    controller.update(renderDt, 0, { deferFixedPulses: true })[field],
    false,
    `${label}: consumed pulse does not repeat`,
  );

  release?.();
  gamepads = [];
  controller.releaseAll();
}

assertPulseSurvivesSubFixedFrames({
  label: 'keyboard shift-up',
  field: 'shiftUp',
  trigger: () => windowTarget.dispatchEvent(makeKeyEvent('KeyE')),
  release: () => windowTarget.dispatchEvent({ type: 'keyup', code: 'KeyE', target: canvas }),
});

assertPulseSurvivesSubFixedFrames({
  label: 'touch reset',
  field: 'reset',
  trigger: () => reset.dispatchEvent(makePointerEvent('pointerdown', 'deferred-touch-reset')),
  release: () => reset.dispatchEvent(makePointerEvent('pointerup', 'deferred-touch-reset')),
});

let pulsePad;
assertPulseSurvivesSubFixedFrames({
  label: 'gamepad reset',
  field: 'reset',
  prepare: () => {
    pulsePad = makeGamepad();
    gamepads = [pulsePad];
    controller.update(0, 0, { deferFixedPulses: true });
  },
  trigger: () => {
    pulsePad.buttons[3] = { value: 1, pressed: true };
  },
});

throttle.dispatchEvent(makePointerEvent('pointerdown', 1));
assert.equal(controller.touch.throttle, 1);
assert.equal(throttle.classList.contains('pressed'), true);
assert.equal(throttle.hasPointerCapture(1), true);

throttle.dispatchEvent(makePointerEvent('pointerup', 1));
assert.equal(controller.touch.throttle, 0);
assert.equal(throttle.classList.contains('pressed'), false);
assert.equal(throttle.hasPointerCapture(1), false);
assert.deepEqual(throttle.releasePointerCaptureCalls, [1]);

throttle.dispatchEvent(makePointerEvent('pointerdown', 'rearm-pointer'));
controller.releaseAll();
throttle.dispatchEvent(makePointerEvent('pointerdown', 'rearm-pointer'));
assert.equal(controller.touch.throttle, 0);
assert.equal(throttle.hasPointerCapture('rearm-pointer'), false);
throttle.dispatchEvent(makePointerEvent('pointerup', 'rearm-pointer'));
throttle.dispatchEvent(makePointerEvent('pointerdown', 'rearm-pointer'));
assert.equal(controller.touch.throttle, 1);
throttle.dispatchEvent(makePointerEvent('pointercancel', 'rearm-pointer'));
assert.equal(controller.touch.throttle, 0);

for (const type of ['pointercancel', 'lostpointercapture']) {
  const pointerId = `terminal-${type}`;
  throttle.dispatchEvent(makePointerEvent('pointerdown', pointerId));
  assert.equal(controller.touch.throttle, 1);
  throttle.dispatchEvent(makePointerEvent(type, pointerId));
  assert.equal(controller.touch.throttle, 0);
}

for (const [target, name] of [[documentTarget, 'document'], [windowTarget, 'window']]) {
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    const pointerId = `global-${name}-${type}`;
    throttle.dispatchEvent(makePointerEvent('pointerdown', pointerId));
    controller.releaseAll();
    throttle.dispatchEvent(makePointerEvent('pointerdown', pointerId));
    assert.equal(controller.touch.throttle, 0);
    target.dispatchEvent(makePointerEvent(type, pointerId));
    throttle.dispatchEvent(makePointerEvent('pointerdown', pointerId));
    assert.equal(controller.touch.throttle, 1);
    throttle.dispatchEvent(makePointerEvent('pointercancel', pointerId));
    assert.equal(controller.touch.throttle, 0);
  }
}

reset.dispatchEvent(makePointerEvent('pointerdown', 2));
assert.equal(controller.pulses.has('TouchReset'), true);
assert.equal(reset.classList.contains('pressed'), true);
assert.equal(reset.hasPointerCapture(2), true);
reset.dispatchEvent(makePointerEvent('pointerup', 2));
assert.equal(reset.classList.contains('pressed'), false);
assert.equal(reset.hasPointerCapture(2), false);
assert.equal(controller.pulses.has('TouchReset'), true);
controller.releaseAll();

throttle.dispatchEvent(makeKeyboardEvent('keydown', 'Space'));
assert.equal(controller.touch.throttle, 1);
assert.equal(throttle.classList.contains('pressed'), true);
throttle.dispatchEvent(makeKeyboardEvent('keydown', 'Space', { repeat: true }));
assert.equal(controller.touch.throttle, 1);
controller.releaseAll();
assert.equal(controller.touch.throttle, 0);
throttle.dispatchEvent(makeKeyboardEvent('keydown', 'Space', { repeat: true }));
assert.equal(controller.touch.throttle, 0);
windowTarget.dispatchEvent({ type: 'keyup', code: 'Space' });
throttle.dispatchEvent(makeKeyboardEvent('keydown', 'Space'));
assert.equal(controller.touch.throttle, 1);
throttle.dispatchEvent(makeKeyboardEvent('keyup', 'Space'));
assert.equal(controller.touch.throttle, 0);

controller.setTouchEnabled(true);
throttle.dispatchEvent(makePointerEvent('pointerdown', 'multi-gas-1'));
throttle.dispatchEvent(makePointerEvent('pointerdown', 'multi-gas-2'));
brake.dispatchEvent(makePointerEvent('pointerdown', 'multi-brake'));
left.dispatchEvent(makePointerEvent('pointerdown', 'multi-left'));
assert.equal(controller.touch.throttle, 1);
assert.equal(controller.touch.brake, 1);
assert.equal(controller.touch.steerLeft, 1);
assert.equal(throttle.hasPointerCapture('multi-gas-1'), true);
assert.equal(throttle.hasPointerCapture('multi-gas-2'), true);

throttle.dispatchEvent({ type: 'blur' });
assert.equal(controller.touch.throttle, 1, 'element blur preserves active touch pointers');
assert.equal(controller.touch.brake, 1);
assert.equal(controller.touch.steerLeft, 1);
assert.equal(throttle.hasPointerCapture('multi-gas-1'), true);
assert.equal(throttle.hasPointerCapture('multi-gas-2'), true);

throttle.dispatchEvent(makePointerEvent('pointerup', 'multi-gas-1'));
assert.equal(controller.touch.throttle, 1);
assert.equal(throttle.hasPointerCapture('multi-gas-1'), false);
assert.equal(throttle.hasPointerCapture('multi-gas-2'), true);
brake.dispatchEvent(makePointerEvent('pointerup', 'multi-brake'));
left.dispatchEvent(makePointerEvent('pointerup', 'multi-left'));
throttle.dispatchEvent(makePointerEvent('pointerup', 'multi-gas-2'));
assert.equal(controller.touch.throttle, 0);
assert.equal(controller.touch.brake, 0);
assert.equal(controller.touch.steerLeft, 0);
assert.equal(controller.pointerCaptures.size, 0);

reset.dispatchEvent(makePointerEvent('pointerdown', 'pulse-blur'));
assert.equal(reset.classList.contains('pressed'), true);
assert.equal(reset.hasPointerCapture('pulse-blur'), true);
reset.dispatchEvent({ type: 'blur' });
assert.equal(reset.classList.contains('pressed'), true, 'pulse blur preserves active pointer styling');
assert.equal(reset.hasPointerCapture('pulse-blur'), true);
reset.dispatchEvent(makePointerEvent('pointerup', 'pulse-blur'));
assert.equal(reset.classList.contains('pressed'), false);
assert.equal(reset.hasPointerCapture('pulse-blur'), false);
controller.consumeFixedPulses();

reset.dispatchEvent(makeKeyboardEvent('click', 'Enter'));
assert.equal(controller.pulses.has('TouchReset'), true);
controller.releaseAll();

const lifecycleReleases = [
  ['releaseAll', () => controller.releaseAll()],
  ['blur', () => windowTarget.dispatchEvent({ type: 'blur' })],
  ['visibilitychange', () => {
    document.hidden = true;
    documentTarget.dispatchEvent({ type: 'visibilitychange' });
    document.hidden = false;
  }],
  ['pagehide', () => windowTarget.dispatchEvent({ type: 'pagehide' })],
];

for (const [name, trigger] of lifecycleReleases) {
  controller.setTouchEnabled(true);
  throttle.dispatchEvent(makePointerEvent('pointerdown', name));
  reset.dispatchEvent(makePointerEvent('pointerdown', name + '-pulse'));
  assert.equal(controller.pointerCaptures.size, 2);
  assert.equal(throttle.capturedPointers.size, 1);
  assert.equal(reset.capturedPointers.size, 1);

  trigger();

  assert.equal(controller.touch.throttle, 0, name + ' clears hold state');
  assert.equal(controller.frame.throttle, 0, name + ' clears frame throttle');
  assert.equal(controller.frame.brake, 0, name + ' clears frame brake');
  assert.equal(controller.frame.steer, 0, name + ' clears frame steer');
  assert.equal(controller.pulses.has('TouchReset'), false, name + ' clears pulse state');
  assert.equal(throttle.classList.contains('pressed'), false, name + ' clears hold styling');
  assert.equal(reset.classList.contains('pressed'), false, name + ' clears pulse styling');
  assert.equal(controller.pointerCaptures.size, 0, name + ' clears registry');
  assert.equal(throttle.capturedPointers.size, 0, name + ' releases hold capture');
  assert.equal(reset.capturedPointers.size, 0, name + ' releases pulse capture');

  throttle.dispatchEvent(makePointerEvent('pointerup', name));
  reset.dispatchEvent(makePointerEvent('pointercancel', name + '-pulse'));
}

console.log('PASS keyboard shortcuts respect interactive targets and modifiers');
console.log('PASS releaseAll and gamepad reconnects rearm keyboard and gamepad sources');
console.log('PASS gamepad menu button emits one pulse per neutral-to-pressed transition');
console.log('PASS gamepad identity replacements require a neutral handshake');
console.log('PASS fixed-step pulse handoff retains keyboard, touch, and gamepad pulses across sub-fixed render frames');
console.log('PASS hold and pulse pointer captures release on pointerup and lifecycle events');
console.log('PASS touch hold controls rearm after local and global pointer and keyboard terminal events');
console.log('PASS multi-pointer holds and pulse styling survive element blur until terminal pointer events');
~~~~

### scripts/smoke-physics.mjs

~~~~javascript
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CARS, FIXED_DT } from '../src/config.js';
import { resolveDriveIntent, updatePedal } from '../src/input.js';
import { initializeRapier } from '../src/rapier-init.js';
import { VehicleSystem } from '../src/vehicle.js';

await initializeRapier(RAPIER);

class FlatTrack {
  constructor() {
    this.config = { width: 14 };
    this.samples = Array.from({ length: 1024 }, (_, index) => ({
      point: new THREE.Vector3(0, 0, index * 2),
      index,
    }));
  }
  getResetPose(index = 0) {
    return { position: new THREE.Vector3(0, 0.8, index * 2), yaw: 0, sampleIndex: index };
  }
  getSurface(position) {
    return { id: 'asphalt', grip: 1, rolling: 1, info: this.nearestInfo(position) };
  }
  nearestInfo(position) {
    const index = Math.max(0, Math.min(1023, Math.round(position.z / 2)));
    return { index, offset: position.x, point: this.samples[index].point, surface: 'asphalt' };
  }
}

const zeroInput = () => ({
  steer: 0, throttle: 0, brake: 0, handbrake: 0,
  shiftUp: false, shiftDown: false, toggleTransmission: false, reset: false,
});

function yawOf(rotation) {
  return Math.atan2(
    2 * (rotation.w * rotation.y + rotation.x * rotation.z),
    1 - 2 * (rotation.y * rotation.y + rotation.z * rotation.z),
  );
}

function runSteps(vehicle, world, seconds, patch = {}, onStep) {
  const input = { ...zeroInput(), ...patch };
  const steps = Math.round(seconds / FIXED_DT);
  for (let i = 0; i < steps; i += 1) {
    vehicle.fixedUpdate(input, false, FIXED_DT);
    world.step();
    vehicle.afterPhysics();
    onStep?.();
  }
}

let failed = false;
for (const config of CARS) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.integrationParameters.dt = FIXED_DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.3, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(80, 0.3, 2200).setFriction(0.2), ground);
  const scene = new THREE.Scene();
  const visual = new THREE.Group();
  visual.userData.wheelNodes = [];
  let automaticResetReason = null;
  const vehicle = new VehicleSystem({
    RAPIER,
    world,
    scene,
    track: new FlatTrack(),
    config,
    visual,
    onAutomaticReset: (reason) => {
      automaticResetReason = reason;
    },
  });

  runSteps(vehicle, world, 2);
  const restStart = vehicle.body.translation();
  let minimumRideHeight = Infinity;
  let maximumRideHeight = -Infinity;
  const restInput = zeroInput();
  for (let i = 0; i < Math.round(10 / FIXED_DT); i += 1) {
    vehicle.fixedUpdate(restInput, false, FIXED_DT);
    world.step();
    vehicle.afterPhysics();
    const rideHeight = vehicle.body.translation().y;
    minimumRideHeight = Math.min(minimumRideHeight, rideHeight);
    maximumRideHeight = Math.max(maximumRideHeight, rideHeight);
  }
  const restEnd = vehicle.body.translation();
  const drift = Math.hypot(restEnd.x - restStart.x, restEnd.z - restStart.z);
  const heave = maximumRideHeight - minimumRideHeight;
  let maximumLaunchHeight = -Infinity;
  let maximumGear = 1;
  let maximumRpm = config.idle;
  runSteps(vehicle, world, 8, { throttle: 1 }, () => {
    maximumLaunchHeight = Math.max(maximumLaunchHeight, vehicle.body.translation().y);
    maximumGear = Math.max(maximumGear, vehicle.telemetry.gear);
    maximumRpm = Math.max(maximumRpm, vehicle.telemetry.rpm);
  });
  const launchLift = maximumLaunchHeight - restEnd.y;
  const forwardSpeed = vehicle.telemetry.signedSpeedKmh;
  let stoppedSpeed = Math.abs(forwardSpeed);
  const filteredInput = { throttle: 1, brake: 0 };
  const stepRawPedals = (rawThrottle, rawBrake) => {
    filteredInput.throttle = updatePedal(filteredInput.throttle, rawThrottle, 4.3, 7.5, FIXED_DT);
    filteredInput.brake = updatePedal(filteredInput.brake, rawBrake, 7.5, 11, FIXED_DT);
    const frame = {
      ...zeroInput(),
      throttle: filteredInput.throttle,
      brake: filteredInput.brake,
      driveIntent: resolveDriveIntent(rawThrottle, rawBrake),
    };
    vehicle.fixedUpdate(frame, false, FIXED_DT);
    world.step();
    vehicle.afterPhysics();
  };
  for (let i = 0; i < Math.round(6 / FIXED_DT); i += 1) {
    stepRawPedals(0, 1);
    if (!vehicle.telemetry.reverse) stoppedSpeed = Math.min(stoppedSpeed, Math.abs(vehicle.telemetry.signedSpeedKmh));
    if (vehicle.telemetry.reverse) break;
  }
  for (let i = 0; i < Math.round(2 / FIXED_DT); i += 1) stepRawPedals(0, 1);
  const reverseSpeed = vehicle.telemetry.signedSpeedKmh;
  for (let i = 0; i < Math.round(4 / FIXED_DT); i += 1) stepRawPedals(1, 0);
  const forwardRecoverySpeed = vehicle.telemetry.signedSpeedKmh;
  const recoveredForward = !vehicle.telemetry.reverse && forwardRecoverySpeed > 3;
  vehicle.reset(0);
  runSteps(vehicle, world, 5, { throttle: 0.68 });
  const yawStart = yawOf(vehicle.body.rotation());
  let peakLateralAcceleration = 0;
  runSteps(vehicle, world, 0.8, { throttle: 0.18, steer: 0.38 }, () => {
    peakLateralAcceleration = Math.max(peakLateralAcceleration, Math.abs(vehicle.telemetry.lateralAcceleration));
  });
  const yawChange = Math.abs(yawOf(vehicle.body.rotation()) - yawStart);
  vehicle.body.setTranslation({ x: 0, y: -5, z: 0 }, true);
  vehicle.fixedUpdate(zeroInput(), false, FIXED_DT);
  const automaticRecoveryPassed = automaticResetReason === 'fell-below-world'
    && vehicle.body.translation().y > 0;
  const finite = [drift, heave, launchLift, yawChange, peakLateralAcceleration, forwardSpeed, stoppedSpeed, reverseSpeed, forwardRecoverySpeed, maximumRpm, vehicle.body.translation().y].every(Number.isFinite);
  const passed = finite && drift < 0.05 && heave < 0.035 && launchLift < 0.18
    && yawChange > 0.08 && peakLateralAcceleration > 2.2
    && forwardSpeed > 20 && stoppedSpeed < 1.5 && reverseSpeed < -2 && reverseSpeed > -46
    && recoveredForward && automaticRecoveryPassed
    && maximumGear >= 2 && maximumRpm <= config.redline * 1.04;
  failed ||= !passed;
  console.log(`${passed ? 'PASS' : 'FAIL'} ${config.name.padEnd(22)} heave=${heave.toFixed(3)}m lift=${launchLift.toFixed(3)}m turn=${yawChange.toFixed(2)}rad forward=${forwardSpeed.toFixed(1)}km/h gear=${maximumGear} reverse=${reverseSpeed.toFixed(1)}km/h recover=${forwardRecoverySpeed.toFixed(1)}km/h`);
  vehicle.destroy();
  world.free();
}

if (failed) process.exitCode = 1;
~~~~

### scripts/regression-physics.mjs

~~~~javascript
import assert from 'node:assert/strict';
import { CARS, FIXED_DT } from '../src/config.js';
import {
  AIR_DENSITY,
  GRAVITY,
  aerodynamicDragScale,
  drivetrainEfficiency,
  frictionLimitedYawRate,
  roadWheelRpm,
  torqueCurveFactor,
} from '../src/vehicle-physics.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  runFor,
  settleVehicle,
  stepVehicle,
  zeroInput,
} from './physics-harness.mjs';

const nearlyEqual = (actual, expected, tolerance = 1e-10) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
};

function testSharedModel() {
  const sample = CARS[0];
  nearlyEqual(torqueCurveFactor(sample, sample.idle), 0.56);
  nearlyEqual(torqueCurveFactor(sample, sample.peakRpm), 1);
  nearlyEqual(torqueCurveFactor(sample, sample.redline), 0.74);
  assert.equal(torqueCurveFactor(sample, sample.redline * 1.018), 0);
  assert.equal(drivetrainEfficiency('AWD'), 0.82);
  assert.equal(drivetrainEfficiency('RWD'), 0.88);
  nearlyEqual(roadWheelRpm(-20, sample.wheelRadius), roadWheelRpm(20, sample.wheelRadius));

  const speed = 25;
  const scale = aerodynamicDragScale(sample.cdA, speed * speed);
  const forceMagnitude = Math.abs(scale) * speed;
  nearlyEqual(forceMagnitude, 0.5 * AIR_DENSITY * sample.cdA * speed * speed);
  assert.equal(aerodynamicDragScale(sample.cdA, 0), 0);
  nearlyEqual(frictionLimitedYawRate(0.8, 20, 1, 0.5), GRAVITY * 0.5 / 20);
  nearlyEqual(frictionLimitedYawRate(-0.8, 20, 1, 0.5), -GRAVITY * 0.5 / 20);
  nearlyEqual(frictionLimitedYawRate(0.2, 20, 1, 1), 0.2);
}

function accelerateTo(rig, targetKmh, maximumSeconds, throttle = 1) {
  const input = zeroInput({ throttle, driveIntent: 1 });
  const maximumSteps = Math.round(maximumSeconds / FIXED_DT);
  for (let index = 0; index < maximumSteps; index += 1) {
    stepVehicle(rig, input);
    if (rig.vehicle.telemetry.speedKmh >= targetKmh) {
      return { reached: true, elapsed: (index + 1) * FIXED_DT };
    }
  }
  return { reached: false, elapsed: maximumSeconds };
}

function measureStraightLinePerformance(config) {
  const rig = createVehicleRig(config);
  try {
    settleVehicle(rig);
    const fullThrottle = zeroInput({ throttle: 1, driveIntent: 1 });
    let zeroToTwenty = null;
    let zeroToHundred = null;
    let minimumLaunchRpm = Infinity;
    let peakSpeed = 0;
    runFor(rig, 60, fullThrottle, ({ elapsed, vehicle }) => {
      const speed = vehicle.telemetry.speedKmh;
      peakSpeed = Math.max(peakSpeed, speed);
      if (elapsed >= 0.25 && speed < 20) {
        minimumLaunchRpm = Math.min(minimumLaunchRpm, vehicle.telemetry.rpm);
      }
      if (zeroToTwenty === null && speed >= 20) zeroToTwenty = elapsed;
      if (zeroToHundred === null && speed >= 100) zeroToHundred = elapsed;
    });
    // `speed` is the existing gameplay calibration target shown in the garage,
    // not a claim of engineering-grade reproduction. A broad envelope catches
    // hidden resistance or runaway power without overfitting the simcade tune.
    const targetRatio = peakSpeed / config.speed;
    const minimumLaunchBandRpm = config.idle + (config.redline - config.idle) * 0.15;
    const maximumLaunchBandRpm = config.idle + (config.redline - config.idle) * 0.35;
    const passed = zeroToTwenty !== null
      && zeroToTwenty > 1
      && zeroToTwenty < 2.5
      && minimumLaunchRpm > minimumLaunchBandRpm
      && minimumLaunchRpm < maximumLaunchBandRpm
      && zeroToHundred !== null
      && zeroToHundred > 3
      && zeroToHundred < 15
      && targetRatio > 0.88
      && targetRatio < 1.15;
    return { passed, zeroToTwenty, zeroToHundred, minimumLaunchRpm, peakSpeed, targetRatio };
  } finally {
    destroyVehicleRig(rig);
  }
}

function measureBraking(config) {
  const rig = createVehicleRig(config);
  try {
    settleVehicle(rig);
    const acceleration = accelerateTo(rig, 100, 30);
    const startSpeed = rig.vehicle.telemetry.speedKmh;
    const start = rig.vehicle.body.translation();
    let minimumSpeed = Math.abs(rig.vehicle.telemetry.signedSpeedKmh);
    let elapsed = 0;
    const brake = zeroInput({ brake: 1, driveIntent: -1 });
    const maximumSteps = Math.round(6 / FIXED_DT);
    for (let index = 0; index < maximumSteps && minimumSpeed > 1; index += 1) {
      stepVehicle(rig, brake);
      elapsed = (index + 1) * FIXED_DT;
      if (!rig.vehicle.reverse) {
        minimumSpeed = Math.min(minimumSpeed, Math.abs(rig.vehicle.telemetry.signedSpeedKmh));
      }
    }
    const end = rig.vehicle.body.translation();
    const distance = Math.hypot(end.x - start.x, end.z - start.z);
    const idealTireLimitedDistance = (startSpeed / 3.6) ** 2 / (2 * GRAVITY * config.tire.mu);
    const passed = acceleration.reached
      && minimumSpeed < 1.2
      && elapsed > 1.5
      && elapsed < 5.5
      && distance > idealTireLimitedDistance * 0.65
      && distance < idealTireLimitedDistance * 1.9
      && !rig.vehicle.reverse;
    return { passed, startSpeed, minimumSpeed, elapsed, distance, idealTireLimitedDistance };
  } finally {
    destroyVehicleRig(rig);
  }
}

function measureConstantRadius(config) {
  const rig = createVehicleRig(config);
  try {
    settleVehicle(rig);
    const acceleration = accelerateTo(rig, 65, 20, 0.6);
    const circleInput = zeroInput({ throttle: 0.18, steer: 0.28, driveIntent: 1 });
    const totalSteps = Math.round(4 / FIXED_DT);
    const sampleStart = Math.round(3 / FIXED_DT);
    let lateralGTotal = 0;
    let speedTotal = 0;
    let yawRateTotal = 0;
    let samples = 0;
    for (let index = 0; index < totalSteps; index += 1) {
      stepVehicle(rig, circleInput);
      if (index < sampleStart) continue;
      lateralGTotal += Math.abs(rig.vehicle.telemetry.lateralAcceleration) / GRAVITY;
      speedTotal += rig.vehicle.telemetry.speedKmh;
      yawRateTotal += Math.abs(rig.vehicle.body.angvel().y);
      samples += 1;
    }
    const lateralG = lateralGTotal / samples;
    const speedKmh = speedTotal / samples;
    const yawRate = yawRateTotal / samples;
    const radius = speedKmh / 3.6 / yawRate;
    const passed = acceleration.reached
      && Number.isFinite(radius)
      && lateralG > 0.38
      && lateralG < config.tire.mu * 1.05
      && speedKmh > 30
      && speedKmh < 95
      && yawRate > 0.2
      && yawRate < 0.75
      && radius > 15
      && radius < 90;
    return { passed, lateralG, speedKmh, yawRate, radius };
  } finally {
    destroyVehicleRig(rig);
  }
}

function measureSteeringStepAndSlalom(config) {
  const stepRig = createVehicleRig(config);
  let stepResult;
  try {
    settleVehicle(stepRig);
    const acceleration = accelerateTo(stepRig, 65, 20, 0.6);
    const steeringStep = zeroInput({ throttle: 0.18, steer: 0.28, driveIntent: 1 });
    let responseTime = null;
    let peakYawRate = 0;
    let peakLateralG = 0;
    runFor(stepRig, 1.5, steeringStep, ({ elapsed, vehicle }) => {
      const yawRate = vehicle.body.angvel().y;
      if (responseTime === null && yawRate > 0.1) responseTime = elapsed;
      peakYawRate = Math.max(peakYawRate, yawRate);
      peakLateralG = Math.max(peakLateralG, Math.abs(vehicle.telemetry.lateralAcceleration) / GRAVITY);
    });
    stepResult = {
      passed: acceleration.reached
        && responseTime !== null
        && responseTime > 0.03
        && responseTime < 0.35
        && peakYawRate > 0.35
        && peakYawRate < 0.9
        && peakLateralG > 0.55
        && peakLateralG < config.tire.mu * 1.35
        && stepRig.vehicle.telemetry.speedKmh > 40,
      responseTime,
      peakYawRate,
      peakLateralG,
    };
  } finally {
    destroyVehicleRig(stepRig);
  }

  const slalomRig = createVehicleRig(config);
  try {
    settleVehicle(slalomRig);
    const acceleration = accelerateTo(slalomRig, 65, 20, 0.6);
    const slalomInput = zeroInput({ throttle: 0.2, driveIntent: 1 });
    const duration = 8;
    const period = 1.6;
    const steps = Math.round(duration / FIXED_DT);
    let previousYawSign = 0;
    let yawReversals = 0;
    let peakLateralG = 0;
    let minimumSpeed = Infinity;
    let maximumSpeed = 0;
    let minimumX = Infinity;
    let maximumX = -Infinity;
    for (let index = 0; index < steps; index += 1) {
      const elapsed = index * FIXED_DT;
      slalomInput.steer = 0.36 * Math.sin(2 * Math.PI * elapsed / period);
      stepVehicle(slalomRig, slalomInput);
      const yawRate = slalomRig.vehicle.body.angvel().y;
      const yawSign = Math.abs(yawRate) > 0.08 ? Math.sign(yawRate) : 0;
      if (yawSign && previousYawSign && yawSign !== previousYawSign) yawReversals += 1;
      if (yawSign) previousYawSign = yawSign;
      peakLateralG = Math.max(
        peakLateralG,
        Math.abs(slalomRig.vehicle.telemetry.lateralAcceleration) / GRAVITY,
      );
      minimumSpeed = Math.min(minimumSpeed, slalomRig.vehicle.telemetry.speedKmh);
      maximumSpeed = Math.max(maximumSpeed, slalomRig.vehicle.telemetry.speedKmh);
      const positionX = slalomRig.vehicle.body.translation().x;
      minimumX = Math.min(minimumX, positionX);
      maximumX = Math.max(maximumX, positionX);
    }
    const lateralSpan = maximumX - minimumX;
    const slalomResult = {
      passed: acceleration.reached
        && yawReversals >= 8
        && yawReversals <= 11
        && peakLateralG > 0.6
        && peakLateralG < config.tire.mu * 1.5
        && minimumSpeed > 40
        && maximumSpeed < 90
        && lateralSpan > 10
        && lateralSpan < 50
        && slalomRig.vehicle.body.translation().y > 0.45,
      yawReversals,
      peakLateralG,
      minimumSpeed,
      maximumSpeed,
      lateralSpan,
    };
    return { step: stepResult, slalom: slalomResult };
  } finally {
    destroyVehicleRig(slalomRig);
  }
}

function measureLiftOffStability(config) {
  const rig = createVehicleRig(config);
  try {
    settleVehicle(rig);
    const acceleration = accelerateTo(rig, 75, 20, 0.6);
    const steadyTurn = zeroInput({ throttle: 0.2, steer: 0.18, driveIntent: 1 });
    let baselineYawRateTotal = 0;
    let baselineSamples = 0;
    runFor(rig, 2, steadyTurn, ({ elapsed, vehicle }) => {
      if (elapsed < 1.5) return;
      baselineYawRateTotal += Math.abs(vehicle.body.angvel().y);
      baselineSamples += 1;
    });
    const baselineYawRate = baselineYawRateTotal / baselineSamples;
    const startSpeed = rig.vehicle.telemetry.speedKmh;
    const liftOff = zeroInput({ steer: 0.18 });
    let peakYawRate = 0;
    let wrongWayYaw = false;
    runFor(rig, 2, liftOff, ({ vehicle }) => {
      const yawRate = vehicle.body.angvel().y;
      peakYawRate = Math.max(peakYawRate, Math.abs(yawRate));
      wrongWayYaw ||= yawRate < -0.03;
    });
    const endSpeed = rig.vehicle.telemetry.speedKmh;
    const rotation = rig.vehicle.body.rotation();
    const passed = acceleration.reached
      && baselineYawRate > 0.2
      && peakYawRate < baselineYawRate * 1.45
      && !wrongWayYaw
      && startSpeed - endSpeed > 4
      && startSpeed - endSpeed < 20
      && Math.abs(rotation.x) < 0.45
      && Math.abs(rotation.z) < 0.45
      && rig.vehicle.body.translation().y > 0.45;
    return { passed, baselineYawRate, peakYawRate, startSpeed, endSpeed };
  } finally {
    destroyVehicleRig(rig);
  }
}

function measureHandbrakeEvent(config, handbrake) {
  const rig = createVehicleRig(config);
  try {
    settleVehicle(rig);
    const acceleration = accelerateTo(rig, 65, 20, 0.6);
    runFor(rig, 0.8, zeroInput({ throttle: 0.16, steer: 0.22, driveIntent: 1 }));
    let peakYawRate = 0;
    let peakLateralG = 0;
    runFor(
      rig,
      0.7,
      zeroInput({ throttle: 0.05, steer: 0.22, handbrake, driveIntent: 1 }),
      ({ vehicle }) => {
        peakYawRate = Math.max(peakYawRate, Math.abs(vehicle.body.angvel().y));
        peakLateralG = Math.max(
          peakLateralG,
          Math.abs(vehicle.telemetry.lateralAcceleration) / GRAVITY,
        );
      },
    );
    const eventSpeed = rig.vehicle.telemetry.speedKmh;
    runFor(rig, 4, zeroInput({ throttle: 0.25, driveIntent: 1 }));
    return {
      acceleration,
      peakYawRate,
      peakLateralG,
      eventSpeed,
      recoveredYawRate: Math.abs(rig.vehicle.body.angvel().y),
      recoveredSpeed: rig.vehicle.telemetry.speedKmh,
      rideHeight: rig.vehicle.body.translation().y,
    };
  } finally {
    destroyVehicleRig(rig);
  }
}

function measureHandbrakeRecovery(config) {
  const control = measureHandbrakeEvent(config, 0);
  const handbrake = measureHandbrakeEvent(config, 1);
  const yawGain = handbrake.peakYawRate / control.peakYawRate;
  const passed = control.acceleration.reached
    && handbrake.acceleration.reached
    && yawGain > 1.15
    && yawGain < 2.2
    && handbrake.peakYawRate < 1
    && handbrake.peakLateralG < config.tire.mu * 1.3
    && handbrake.eventSpeed > 35
    && handbrake.recoveredYawRate < 0.08
    && handbrake.recoveredSpeed > 35
    && handbrake.rideHeight > 0.45;
  return { passed, control, handbrake, yawGain };
}

testSharedModel();
let failed = false;
for (const config of CARS) {
  const straightLine = measureStraightLinePerformance(config);
  const braking = measureBraking(config);
  const circle = measureConstantRadius(config);
  const passed = straightLine.passed && braking.passed && circle.passed;
  failed ||= !passed;
  console.log(
    `${passed ? 'PASS' : 'FAIL'} ${config.name.padEnd(22)} `
    + `0-20 ${straightLine.zeroToTwenty?.toFixed(2) ?? '--'}s `
    + `0-100 ${straightLine.zeroToHundred?.toFixed(2) ?? '--'}s `
    + `launch ${Math.round(straightLine.minimumLaunchRpm)}rpm `
    + `60s ${straightLine.peakSpeed.toFixed(0)}/${config.speed}km/h  `
    + `brake ${braking.startSpeed.toFixed(1)}→${braking.minimumSpeed.toFixed(1)}km/h `
    + `${braking.distance.toFixed(1)}m/${braking.elapsed.toFixed(2)}s  `
    + `circle ${circle.speedKmh.toFixed(1)}km/h ${circle.lateralG.toFixed(2)}g `
    + `${circle.radius.toFixed(0)}m radius`,
  );
}

const mx5 = CARS.find((config) => config.id === 'mx5');
const steering = measureSteeringStepAndSlalom(mx5);
const liftOff = measureLiftOffStability(mx5);
const handbrake = measureHandbrakeRecovery(mx5);
const handlingPassed = steering.step.passed
  && steering.slalom.passed
  && liftOff.passed
  && handbrake.passed;
failed ||= !handlingPassed;
console.log(
  `${handlingPassed ? 'PASS' : 'FAIL'} ${mx5.name.padEnd(22)} handling  `
  + `step ${(steering.step.responseTime * 1000).toFixed(0)}ms/${steering.step.peakYawRate.toFixed(2)}rad/s  `
  + `slalom ${steering.slalom.yawReversals} reversals/${steering.slalom.peakLateralG.toFixed(2)}g/`
  + `${steering.slalom.minimumSpeed.toFixed(0)}–${steering.slalom.maximumSpeed.toFixed(0)}km/h  `
  + `lift yaw ×${(liftOff.peakYawRate / liftOff.baselineYawRate).toFixed(2)}  `
  + `handbrake yaw ×${handbrake.yawGain.toFixed(2)} `
  + `recover ${handbrake.handbrake.recoveredYawRate.toFixed(3)}rad/s`,
);

if (failed) process.exitCode = 1;
~~~~

### scripts/test-vehicle-direction-change.mjs

~~~~javascript
import assert from 'node:assert/strict';

import { CARS, FIXED_DT } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  zeroInput,
} from './physics-harness.mjs';

const BRAKE_HOLD_BEFORE_REVERSE = 0.35;
const REVERSE_ENGAGE_MAXIMUM = 0.6;
const reverseRequest = zeroInput({ brake: 1, driveIntent: -1 });

for (const id of ['mx5', 'gt3rs']) {
  const config = CARS.find((candidate) => candidate.id === id);
  const rig = createVehicleRig(config);
  try {
    let pedals = rig.vehicle.updateTransmission(reverseRequest, FIXED_DT, 10);
    assert.equal(rig.vehicle.reverse, false, `${id} remains forward while moving`);
    assert.equal(pedals.serviceBrake, 1, `${id} uses S as a service brake while moving`);

    let stoppedHold = 0;
    while (stoppedHold < BRAKE_HOLD_BEFORE_REVERSE) {
      pedals = rig.vehicle.updateTransmission(reverseRequest, FIXED_DT, 0);
      stoppedHold += FIXED_DT;
      assert.equal(rig.vehicle.reverse, false, `${id} does not snap into reverse after braking to a stop`);
      assert.equal(pedals.serviceBrake, 1, `${id} keeps the service brake applied during reverse confirmation`);
      assert.equal(pedals.driveThrottle, 0, `${id} does not apply reverse torque during confirmation`);
    }

    while (!rig.vehicle.reverse && stoppedHold < REVERSE_ENGAGE_MAXIMUM) {
      pedals = rig.vehicle.updateTransmission(reverseRequest, FIXED_DT, 0);
      stoppedHold += FIXED_DT;
    }
    assert.equal(rig.vehicle.reverse, true, `${id} still enters reverse after a deliberate hold`);
    assert.equal(pedals.driveThrottle, 1, `${id} applies reverse throttle after engagement`);
  } finally {
    destroyVehicleRig(rig);
  }
}

console.log('PASS MX-5 and GT3 RS brake-to-reverse confirmation keeps braking before deliberate reverse');
~~~~

### scripts/test-vehicle-input-boundaries.mjs

~~~~javascript
import assert from 'node:assert/strict';

import { CARS, FIXED_DT } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  runFor,
  zeroInput,
} from './physics-harness.mjs';

const MIN_SAFE_UPDATE_DT = FIXED_DT * 0.25;
const MAX_SAFE_UPDATE_DT = 0.05;
const neutralInput = zeroInput();
const activeInput = zeroInput({ steer: 0.25, throttle: 0.6, driveIntent: 1 });
const cases = [
  { label: 'null-input', input: null, dt: FIXED_DT, expectedInput: neutralInput, expectedDt: FIXED_DT },
  { label: 'empty-input', input: {}, dt: FIXED_DT, expectedInput: neutralInput, expectedDt: FIXED_DT },
  { label: 'nan-steer', input: zeroInput({ steer: Number.NaN }), dt: FIXED_DT, expectedInput: neutralInput, expectedDt: FIXED_DT },
  { label: 'positive-infinite-throttle', input: zeroInput({ throttle: Number.POSITIVE_INFINITY }), dt: FIXED_DT, expectedInput: neutralInput, expectedDt: FIXED_DT },
  { label: 'negative-infinite-brake', input: zeroInput({ brake: Number.NEGATIVE_INFINITY }), dt: FIXED_DT, expectedInput: neutralInput, expectedDt: FIXED_DT },
  { label: 'nan-handbrake', input: zeroInput({ handbrake: Number.NaN }), dt: FIXED_DT, expectedInput: neutralInput, expectedDt: FIXED_DT },
  { label: 'positive-infinite-drive-intent', input: zeroInput({ driveIntent: Number.POSITIVE_INFINITY }), dt: FIXED_DT, expectedInput: neutralInput, expectedDt: FIXED_DT },
  {
    label: 'out-of-range-controls',
    input: zeroInput({ steer: 4, throttle: 2, brake: -3, handbrake: 2, driveIntent: 9 }),
    dt: FIXED_DT,
    expectedInput: zeroInput({ steer: 1, throttle: 1, brake: 0, handbrake: 1, driveIntent: 1 }),
    expectedDt: FIXED_DT,
  },
  {
    label: 'truthy-non-boolean-pulses',
    input: zeroInput({ shiftUp: 1, shiftDown: 'yes', toggleTransmission: {}, reset: 'true' }),
    dt: FIXED_DT,
    expectedInput: neutralInput,
    expectedDt: FIXED_DT,
  },
  { label: 'nan-dt', input: activeInput, dt: Number.NaN, expectedInput: activeInput, expectedDt: FIXED_DT },
  { label: 'positive-infinite-dt', input: activeInput, dt: Number.POSITIVE_INFINITY, expectedInput: activeInput, expectedDt: FIXED_DT },
  { label: 'negative-infinite-dt', input: activeInput, dt: Number.NEGATIVE_INFINITY, expectedInput: activeInput, expectedDt: FIXED_DT },
  { label: 'zero-dt', input: activeInput, dt: 0, expectedInput: activeInput, expectedDt: FIXED_DT },
  { label: 'minimum-positive-dt', input: activeInput, dt: Number.MIN_VALUE, expectedInput: activeInput, expectedDt: MIN_SAFE_UPDATE_DT },
  { label: 'maximum-dt', input: activeInput, dt: Number.MAX_VALUE, expectedInput: activeInput, expectedDt: MAX_SAFE_UPDATE_DT },
];

function collectNumericState(vehicle) {
  const entries = [];
  const add = (path, value) => entries.push([path, value]);
  const addVector = (path, vector) => {
    add(`${path}.x`, vector.x);
    add(`${path}.y`, vector.y);
    add(`${path}.z`, vector.z);
  };

  addVector('body.translation', vehicle.body.translation());
  addVector('body.linvel', vehicle.body.linvel());
  addVector('body.angvel', vehicle.body.angvel());
  const rotation = vehicle.body.rotation();
  add('body.rotation.x', rotation.x);
  add('body.rotation.y', rotation.y);
  add('body.rotation.z', rotation.z);
  add('body.rotation.w', rotation.w);
  for (const field of [
    'gear',
    'steerAngle',
    'engineLoad',
    'engineRpm',
    'reverseHold',
    'shiftTimer',
    'previousLongSpeed',
    'smoothedLongAcceleration',
    'stuckTimer',
  ]) {
    add(field, vehicle[field]);
  }
  for (const [index, wheel] of vehicle.wheels.entries()) add(`wheels[${index}].omega`, wheel.omega);
  for (const field of [
    'gear',
    'speedKmh',
    'signedSpeedKmh',
    'rpm',
    'throttle',
    'brake',
    'steer',
    'longitudinalAcceleration',
    'lateralAcceleration',
  ]) {
    add(`telemetry.${field}`, vehicle.telemetry[field]);
  }
  for (const [index, wheel] of vehicle.telemetry.wheels.entries()) {
    for (const field of ['load', 'suspension', 'slipRatio', 'slipAngle', 'slipPower']) {
      add(`telemetry.wheels[${index}].${field}`, wheel[field]);
    }
    addVector(`telemetry.wheels[${index}].contactPoint`, wheel.contactPoint);
  }
  return entries;
}

function collectNonFiniteFields(vehicle) {
  return collectNumericState(vehicle)
    .filter(([, value]) => !Number.isFinite(value))
    .map(([path]) => path);
}

function collectOracleMismatches(actualVehicle, expectedVehicle) {
  const expected = new Map(collectNumericState(expectedVehicle));
  return collectNumericState(actualVehicle).flatMap(([path, actual]) => {
    const expectedValue = expected.get(path);
    const tolerance = 1e-10 * Math.max(1, Math.abs(expectedValue));
    return Number.isFinite(actual) && Math.abs(actual - expectedValue) <= tolerance ? [] : [path];
  });
}

const failures = [];
for (const config of CARS) {
  for (const boundaryCase of cases) {
    const rig = createVehicleRig(config);
    const oracleRig = createVehicleRig(config);
    try {
      runFor(rig, 0.25, zeroInput());
      runFor(oracleRig, 0.25, zeroInput());
      oracleRig.vehicle.fixedUpdate(boundaryCase.expectedInput, false, boundaryCase.expectedDt);
      oracleRig.world.step();
      oracleRig.vehicle.afterPhysics();
      try {
        rig.vehicle.fixedUpdate(boundaryCase.input, false, boundaryCase.dt);
      } catch (error) {
        failures.push({
          carId: config.id,
          case: boundaryCase.label,
          phase: 'fixedUpdate',
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        continue;
      }

      const updateFields = collectNonFiniteFields(rig.vehicle);
      if (updateFields.length > 0) {
        failures.push({ carId: config.id, case: boundaryCase.label, phase: 'fixedUpdate', fields: updateFields });
      }
      try {
        rig.world.step();
        rig.vehicle.afterPhysics();
      } catch (error) {
        failures.push({
          carId: config.id,
          case: boundaryCase.label,
          phase: 'worldStep',
          error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        });
        continue;
      }
      const worldFields = collectNonFiniteFields(rig.vehicle);
      if (worldFields.length > 0) {
        failures.push({ carId: config.id, case: boundaryCase.label, phase: 'worldStep', fields: worldFields });
      }
      const oracleFields = collectOracleMismatches(rig.vehicle, oracleRig.vehicle);
      if (oracleFields.length > 0) {
        failures.push({ carId: config.id, case: boundaryCase.label, phase: 'sanitizedOracle', fields: oracleFields });
      }
    } finally {
      destroyVehicleRig(rig);
      destroyVehicleRig(oracleRig);
    }
  }
}

const unique = (values) => [...new Set(values)].sort();
const failedCars = unique(failures.map(({ carId }) => carId));
const failedCases = unique(failures.map(({ case: label }) => label));
const failedPhases = unique(failures.map(({ phase }) => phase));
const failedFields = unique(failures.flatMap(({ fields = [] }) => fields));
const errors = unique(failures.flatMap(({ error }) => error ? [error] : []));
assert.equal(
  failures.length,
  0,
  `invalid vehicle calls failed for cars=${failedCars.join(',')} cases=${failedCases.join(',')} `
    + `phases=${failedPhases.join(',')} fields=${failedFields.join(',')} errors=${errors.join(' | ')}`,
);
console.log(`PASS ${cases.length} invalid input/dt boundaries stay finite for ${CARS.length}/${CARS.length} cars`);
~~~~

### scripts/test-vehicle-internal-recovery.mjs

~~~~javascript
import assert from 'node:assert/strict';
import { CARS, FIXED_DT } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  runFor,
  zeroInput,
} from './physics-harness.mjs';

function snapshot(vehicle) {
  const values = new Map();
  const add = (path, value) => values.set(path, value);
  const addVector = (path, value) => {
    add(`${path}.x`, value.x);
    add(`${path}.y`, value.y);
    add(`${path}.z`, value.z);
  };
  addVector('body.translation', vehicle.body.translation());
  addVector('body.linvel', vehicle.body.linvel());
  addVector('body.angvel', vehicle.body.angvel());
  const rotation = vehicle.body.rotation();
  for (const field of ['x', 'y', 'z', 'w']) add(`body.rotation.${field}`, rotation[field]);
  for (const field of [
    'steerAngle', 'engineLoad', 'engineRpm', 'reverseHold', 'shiftTimer',
    'previousLongSpeed', 'smoothedLongAcceleration', 'stuckTimer',
  ]) add(field, vehicle[field]);
  add('gear', vehicle.gear);
  add('reverse', Number(vehicle.reverse));
  for (const [index, wheel] of vehicle.wheels.entries()) add(`wheels[${index}].omega`, wheel.omega);
  for (const field of [
    'speedKmh', 'signedSpeedKmh', 'rpm', 'throttle', 'brake', 'steer',
    'longitudinalAcceleration', 'lateralAcceleration',
  ]) add(`telemetry.${field}`, vehicle.telemetry[field]);
  for (const [index, wheel] of vehicle.telemetry.wheels.entries()) {
    for (const field of ['load', 'suspension', 'slipRatio', 'slipAngle', 'slipPower']) {
      add(`telemetry.wheels[${index}].${field}`, wheel[field]);
    }
    addVector(`telemetry.wheels[${index}].contactPoint`, wheel.contactPoint);
  }
  return values;
}

function assertFiniteSnapshot(values, label) {
  for (const [path, value] of values) {
    assert.ok(Number.isFinite(value), `${label}: ${path} is ${value}`);
  }
}

function assertSnapshotClose(actual, expected, label) {
  assert.deepEqual([...actual.keys()], [...expected.keys()], `${label}: snapshot shape`);
  for (const [path, expectedValue] of expected) {
    const actualValue = actual.get(path);
    const tolerance = 1e-9 * Math.max(1, Math.abs(expectedValue));
    assert.ok(
      Math.abs(actualValue - expectedValue) <= tolerance,
      `${label}: ${path} expected ${expectedValue}, got ${actualValue}`,
    );
  }
}

function hasFiniteBodyState(vehicle) {
  const translation = vehicle.body.translation();
  const rotation = vehicle.body.rotation();
  const linvel = vehicle.body.linvel();
  const angvel = vehicle.body.angvel();
  return [
    translation.x, translation.y, translation.z,
    rotation.x, rotation.y, rotation.z, rotation.w,
    linvel.x, linvel.y, linvel.z,
    angvel.x, angvel.y, angvel.z,
  ].every(Number.isFinite);
}

const scalarCases = [
  {
    name: 'controls',
    poison(vehicle) {
      vehicle.steerAngle = Number.NaN;
      vehicle.engineLoad = Number.POSITIVE_INFINITY;
      vehicle.engineRpm = Number.NEGATIVE_INFINITY;
    },
    normalize(vehicle) {
      vehicle.steerAngle = 0;
      vehicle.engineLoad = 0;
      vehicle.engineRpm = vehicle.config.idle;
    },
  },
  {
    name: 'transmission-timers',
    poison(vehicle) {
      vehicle.reverseHold = Number.NaN;
      vehicle.shiftTimer = Number.POSITIVE_INFINITY;
      vehicle.gear = 999;
      vehicle.reverse = 'truthy-corruption';
    },
    normalize(vehicle) {
      vehicle.reverseHold = 0;
      vehicle.shiftTimer = 0;
      vehicle.gear = 1;
      vehicle.reverse = false;
    },
  },
  {
    name: 'history-timers',
    poison(vehicle) {
      vehicle.previousLongSpeed = Number.NaN;
      vehicle.smoothedLongAcceleration = Number.POSITIVE_INFINITY;
      vehicle.stuckTimer = Number.NEGATIVE_INFINITY;
    },
    normalize(vehicle) {
      vehicle.previousLongSpeed = 0;
      vehicle.smoothedLongAcceleration = 0;
      vehicle.stuckTimer = 0;
    },
  },
  {
    name: 'wheel-omega',
    poison(vehicle) {
      for (const [index, wheel] of vehicle.wheels.entries()) {
        wheel.omega = index % 2 ? Number.POSITIVE_INFINITY : Number.NaN;
      }
    },
    normalize(vehicle) {
      for (const wheel of vehicle.wheels) wheel.omega = 0;
    },
  },
  {
    name: 'telemetry-cache',
    setup(vehicle) {
      const translation = vehicle.body.translation();
      vehicle.body.setTranslation({ x: translation.x, y: 20, z: translation.z }, true);
      vehicle.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      vehicle.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    },
    poison(vehicle) {
      for (const field of [
        'speedKmh', 'signedSpeedKmh', 'rpm', 'throttle', 'brake', 'steer',
        'longitudinalAcceleration', 'lateralAcceleration',
      ]) vehicle.telemetry[field] = Number.NaN;
      for (const wheel of vehicle.telemetry.wheels) {
        wheel.load = Number.NaN;
        wheel.suspension = Number.POSITIVE_INFINITY;
        wheel.slipRatio = Number.NaN;
        wheel.slipAngle = Number.NEGATIVE_INFINITY;
        wheel.slipPower = Number.NaN;
        wheel.contactPoint.set(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY);
      }
    },
    normalize(vehicle) {
      vehicle.resetTelemetry();
    },
  },
];

const bodyCases = [
  {
    name: 'body-translation',
    poison(vehicle) {
      vehicle.body.setTranslation({ x: Number.NaN, y: 1, z: 0 }, true);
    },
  },
  {
    name: 'body-rotation',
    poison(vehicle) {
      vehicle.body.setRotation({ x: Number.NaN, y: 0, z: 0, w: 1 }, true);
    },
  },
  {
    name: 'body-linvel',
    poison(vehicle) {
      vehicle.body.setLinvel({ x: Number.POSITIVE_INFINITY, y: 0, z: 0 }, true);
    },
  },
  {
    name: 'body-angvel',
    poison(vehicle) {
      vehicle.body.setAngvel({ x: 0, y: Number.NaN, z: 0 }, true);
    },
  },
];

const stepInput = zeroInput({ throttle: 0.35, steer: 0.2, driveIntent: 1 });
const failures = [];
let scalarPairs = 0;
let bodyPairs = 0;
let bodySetterNormalizedPairs = 0;

for (const config of CARS) {
  for (const recoveryCase of scalarCases) {
    const actualRig = createVehicleRig(config);
    const oracleRig = createVehicleRig(config);
    const label = `${config.id}/${recoveryCase.name}`;
    try {
      runFor(actualRig, 0.5, stepInput);
      runFor(oracleRig, 0.5, stepInput);
      recoveryCase.setup?.(actualRig.vehicle);
      recoveryCase.setup?.(oracleRig.vehicle);
      recoveryCase.poison(actualRig.vehicle);
      recoveryCase.normalize(oracleRig.vehicle);
      actualRig.vehicle.fixedUpdate(stepInput, false, FIXED_DT);
      oracleRig.vehicle.fixedUpdate(stepInput, false, FIXED_DT);
      assertFiniteSnapshot(snapshot(actualRig.vehicle), `${label}/fixedUpdate`);
      actualRig.world.step();
      oracleRig.world.step();
      actualRig.vehicle.afterPhysics();
      oracleRig.vehicle.afterPhysics();
      const actual = snapshot(actualRig.vehicle);
      const expected = snapshot(oracleRig.vehicle);
      assertFiniteSnapshot(actual, `${label}/worldStep`);
      assertSnapshotClose(actual, expected, label);
      scalarPairs += 1;
    } catch (error) {
      failures.push({ label, phase: 'scalar', error });
    } finally {
      destroyVehicleRig(actualRig);
      destroyVehicleRig(oracleRig);
    }
  }

  for (const recoveryCase of bodyCases) {
    const actualRig = createVehicleRig(config);
    const oracleRig = createVehicleRig(config);
    const label = `${config.id}/${recoveryCase.name}`;
    try {
      runFor(actualRig, 0.5, stepInput);
      runFor(oracleRig, 0.5, stepInput);
      recoveryCase.poison(actualRig.vehicle);
      const requiresReset = !hasFiniteBodyState(actualRig.vehicle);
      if (requiresReset) oracleRig.vehicle.reset(oracleRig.vehicle.safeSample);
      else oracleRig.vehicle.fixedUpdate(stepInput, false, FIXED_DT);
      actualRig.vehicle.fixedUpdate(stepInput, false, FIXED_DT);
      assertFiniteSnapshot(snapshot(actualRig.vehicle), `${label}/fixedUpdate`);
      actualRig.world.step();
      oracleRig.world.step();
      actualRig.vehicle.afterPhysics();
      oracleRig.vehicle.afterPhysics();
      const actual = snapshot(actualRig.vehicle);
      const expected = snapshot(oracleRig.vehicle);
      assertFiniteSnapshot(actual, `${label}/worldStep`);
      assertSnapshotClose(actual, expected, label);
      bodyPairs += 1;
      if (!requiresReset) bodySetterNormalizedPairs += 1;
    } catch (error) {
      failures.push({ label, phase: 'body', error });
    } finally {
      destroyVehicleRig(actualRig);
      destroyVehicleRig(oracleRig);
    }
  }
}

if (failures.length > 0) {
  const grouped = Object.groupBy(failures, ({ phase }) => phase);
  for (const [phase, entries] of Object.entries(grouped)) {
    console.error(`FAIL ${phase}: ${entries.length}`);
    for (const { label, error } of entries.slice(0, 8)) console.error(`- ${label}: ${error.message}`);
  }
  console.error(`FAIL vehicle internal recovery ${failures.length}/${CARS.length * (scalarCases.length + bodyCases.length)} paired cases`);
  process.exitCode = 1;
} else {
  console.log(
    `PASS vehicle internal recovery scalar=${scalarPairs} body=${bodyPairs} `
    + `rapier-normalized=${bodySetterNormalizedPairs} total=${scalarPairs + bodyPairs}`,
  );
}
~~~~

### scripts/test-vehicle-reset.mjs

~~~~javascript
import assert from 'node:assert/strict';

import { CARS } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  runFor,
  zeroInput,
} from './physics-harness.mjs';

const telemetryNumbers = [
  'speedKmh',
  'signedSpeedKmh',
  'rpm',
  'throttle',
  'brake',
  'steer',
  'longitudinalAcceleration',
  'lateralAcceleration',
];

function dirtyResetOwnedState(vehicle) {
  vehicle.body.setTranslation({ x: 12, y: 4, z: -8 }, true);
  vehicle.body.setLinvel({ x: 7, y: -3, z: 11 }, true);
  vehicle.body.setAngvel({ x: 0.4, y: -0.7, z: 0.2 }, true);
  vehicle.steerAngle = 0.42;
  vehicle.engineLoad = 0.81;
  vehicle.engineRpm = vehicle.config.redline * 0.75;
  vehicle.reverseHold = 0.11;
  vehicle.shiftTimer = 0.09;
  vehicle.previousLongSpeed = 18;
  vehicle.smoothedLongAcceleration = -2.5;
  vehicle.stuckTimer = 3;
  vehicle.gear = Math.min(2, vehicle.config.gears.length);
  vehicle.reverse = true;

  for (const wheel of vehicle.wheels) {
    wheel.omega = 23;
    wheel.grounded = true;
    wheel.compression = 0.12;
    wheel.springForce = 999;
    wheel.hit = { stale: true };
    wheel.surface = 'gravel';
    wheel.previousVisualAngle = 11;
    wheel.visualAngle = 12;
  }

  for (const key of telemetryNumbers) vehicle.telemetry[key] = 17;
  vehicle.telemetry.gear = 2;
  vehicle.telemetry.reverse = true;
  vehicle.telemetry.surface = 'gravel';
  vehicle.telemetry.absActive = true;
  vehicle.telemetry.tcsActive = true;
  vehicle.telemetry.stabilityActive = true;
  for (const wheel of vehicle.telemetry.wheels) {
    wheel.grounded = true;
    wheel.load = 400;
    wheel.suspension = 0.1;
    wheel.slipRatio = 0.3;
    wheel.slipAngle = 0.2;
    wheel.slipPower = 120;
    wheel.surface = 'gravel';
    wheel.contactPoint.set(4, 5, 6);
  }
}

function collectResetMismatches(vehicle) {
  const mismatches = [];
  const expect = (path, actual, expected) => {
    if (!Object.is(actual, expected)) mismatches.push(`${path}: ${actual} != ${expected}`);
  };
  const expectVector = (path, actual, expected) => {
    const values = Array.isArray(actual) ? actual : [actual.x, actual.y, actual.z];
    if (values.length !== expected.length || values.some((value, index) => !Object.is(value, expected[index]))) {
      mismatches.push(`${path}: [${values.join(',')}] != [${expected.join(',')}]`);
    }
  };

  expectVector('body.linvel', vehicle.body.linvel(), [0, 0, 0]);
  expectVector('body.angvel', vehicle.body.angvel(), [0, 0, 0]);
  expect('steerAngle', vehicle.steerAngle, 0);
  expect('engineLoad', vehicle.engineLoad, 0);
  expect('engineRpm', vehicle.engineRpm, vehicle.config.idle);
  expect('reverseHold', vehicle.reverseHold, 0);
  expect('shiftTimer', vehicle.shiftTimer, 0);
  expect('previousLongSpeed', vehicle.previousLongSpeed, 0);
  expect('smoothedLongAcceleration', vehicle.smoothedLongAcceleration, 0);
  expect('stuckTimer', vehicle.stuckTimer, 0);
  expect('gear', vehicle.gear, 1);
  expect('reverse', vehicle.reverse, false);

  for (const [index, wheel] of vehicle.wheels.entries()) {
    const path = `wheels[${index}]`;
    expect(`${path}.omega`, wheel.omega, 0);
    expect(`${path}.grounded`, wheel.grounded, false);
    expect(`${path}.compression`, wheel.compression, 0);
    expect(`${path}.springForce`, wheel.springForce, 0);
    expect(`${path}.hit`, wheel.hit, null);
    expect(`${path}.surface`, wheel.surface, 'asphalt');
    expect(`${path}.previousVisualAngle`, wheel.previousVisualAngle, 0);
    expect(`${path}.visualAngle`, wheel.visualAngle, 0);
  }

  const telemetryExpected = {
    speedKmh: 0,
    signedSpeedKmh: 0,
    rpm: vehicle.config.idle,
    gear: 1,
    reverse: false,
    throttle: 0,
    brake: 0,
    steer: 0,
    longitudinalAcceleration: 0,
    lateralAcceleration: 0,
    surface: 'asphalt',
    absActive: false,
    tcsActive: false,
    stabilityActive: false,
  };
  for (const [key, expected] of Object.entries(telemetryExpected)) {
    expect(`telemetry.${key}`, vehicle.telemetry[key], expected);
  }
  for (const [index, wheel] of vehicle.telemetry.wheels.entries()) {
    const path = `telemetry.wheels[${index}]`;
    expect(`${path}.grounded`, wheel.grounded, false);
    expect(`${path}.load`, wheel.load, 0);
    expect(`${path}.suspension`, wheel.suspension, 0);
    expect(`${path}.slipRatio`, wheel.slipRatio, 0);
    expect(`${path}.slipAngle`, wheel.slipAngle, 0);
    expect(`${path}.slipPower`, wheel.slipPower, 0);
    expect(`${path}.surface`, wheel.surface, 'asphalt');
    expectVector(`${path}.contactPoint`, wheel.contactPoint, [0, 0, 0]);
  }
  return mismatches;
}

const failures = [];
for (const config of CARS) {
  const rig = createVehicleRig(config);
  try {
    runFor(rig, 0.5, zeroInput({ throttle: 0.7, steer: 0.4, driveIntent: 1 }));
    dirtyResetOwnedState(rig.vehicle);
    rig.vehicle.reset(0);
    const mismatches = collectResetMismatches(rig.vehicle);
    if (mismatches.length > 0) failures.push({ carId: config.id, mismatches });
  } finally {
    destroyVehicleRig(rig);
  }
}

const failedFields = [...new Set(
  failures.flatMap(({ mismatches }) => mismatches.map((mismatch) => mismatch.split(':', 1)[0])),
)];
assert.equal(
  failures.length,
  0,
  `vehicle reset left owned state dirty for ${failures.map(({ carId }) => carId).join(',')}; `
    + `fields=${failedFields.join(',')}`,
);
console.log(`PASS vehicle reset clears owned runtime state for ${CARS.length}/${CARS.length} cars`);
~~~~

### scripts/test-vehicle-determinism.mjs

~~~~javascript
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CARS, FIXED_DT } from '../src/config.js';
import { createVehicleRig, destroyVehicleRig, zeroInput } from './physics-harness.mjs';
import {
  REPLAY_DIGEST_ALGORITHM,
  REPLAY_DIGEST_OFFSET_BASIS,
  REPLAY_FORMAT_VERSION,
  REPLAY_QUANTUM,
  asU64,
  digestHex,
  pushDigest,
  quantize,
} from './replay-digest-oracle.mjs';

const FORMAT_VERSION = 1;
const QUANTIZATION = 1e-6;
const REPEATS = 3;
const baselineUrl = new URL('../data/vehicle-replay-baseline.json', import.meta.url);
const fnvBaselineUrl = new URL('../data/vehicle-replay-fnv-baseline.json', import.meta.url);
const wasmUrl = new URL('../src/generated/streetrush_core.wasm', import.meta.url);

async function loadReplayCore(location = wasmUrl) {
  let wasmBytes;
  try {
    wasmBytes = await readFile(location);
  } catch (error) {
    throw new Error('Replay core WASM is required; run pnpm build:core-wasm first', { cause: error });
  }
  const { instance } = await WebAssembly.instantiate(wasmBytes);
  const core = instance.exports;
  for (const name of [
    'streetrush_replay_format_version',
    'streetrush_replay_quantum',
    'streetrush_replay_digest_offset_basis',
    'streetrush_quantize_replay_value',
    'streetrush_replay_digest_push_f64',
  ]) {
    assert.equal(typeof core[name], 'function', `missing replay export ${name}`);
  }
  assert.equal(core.streetrush_replay_format_version(), REPLAY_FORMAT_VERSION);
  assert.equal(core.streetrush_replay_quantum(), REPLAY_QUANTUM);
  assert.equal(
    asU64(core.streetrush_replay_digest_offset_basis()),
    REPLAY_DIGEST_OFFSET_BASIS,
  );
  return core;
}

await assert.rejects(
  () => loadReplayCore(new URL('../src/generated/__missing__/streetrush_core.wasm', import.meta.url)),
  { message: 'Replay core WASM is required; run pnpm build:core-wasm first' },
);
const replayCore = await loadReplayCore();

function xorshift32(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function piecewiseSeededInputs({ seed, ticks, resetTicks = [] }) {
  const random = xorshift32(seed);
  const resetSet = new Set(resetTicks);
  const phases = Array.from({ length: Math.ceil(ticks / 30) }, () => ({
    throttle: 0.28 + random() * 0.68,
    steer: (random() * 2 - 1) * 0.42,
    handbrake: random() > 0.94 ? 0.45 : 0,
  }));
  return Array.from({ length: ticks }, (_, tick) => {
    const phase = phases[Math.floor(tick / 30)];
    return zeroInput({
      throttle: phase.throttle,
      steer: phase.steer,
      handbrake: phase.handbrake,
      driveIntent: 1,
      reset: resetSet.has(tick),
    });
  });
}

function shiftDirectionInputs({ seed, ticks }) {
  const random = xorshift32(seed);
  const steerPhases = Array.from({ length: Math.ceil(ticks / 40) }, () => (random() * 2 - 1) * 0.22);
  return Array.from({ length: ticks }, (_, tick) => {
    const forward = tick < 500;
    return zeroInput({
      toggleTransmission: tick === 0,
      shiftUp: tick === 180 || tick === 340,
      shiftDown: tick === 620,
      throttle: forward ? 0.82 : 0,
      brake: forward ? 0 : 0.78,
      driveIntent: forward ? 1 : -1,
      steer: steerPhases[Math.floor(tick / 40)],
      handbrake: tick >= 450 && tick < 475 ? 0.35 : 0,
    });
  });
}

const scenarios = [
  {
    id: 'seeded-steady-v1',
    seed: 0x5eed_0001,
    ticks: 720,
    inputs(options) {
      return piecewiseSeededInputs(options);
    },
  },
  {
    id: 'shift-direction-v1',
    seed: 0x5eed_0002,
    ticks: 960,
    inputs(options) {
      return shiftDirectionInputs(options);
    },
  },
  {
    id: 'reset-replay-v1',
    seed: 0x5eed_0003,
    ticks: 900,
    inputs(options) {
      return piecewiseSeededInputs({ ...options, resetTicks: [300, 600] });
    },
  },
];

const FRAME_FIELDS = [
  'body.translation.x', 'body.translation.y', 'body.translation.z',
  'body.rotation.x', 'body.rotation.y', 'body.rotation.z', 'body.rotation.w',
  'body.linvel.x', 'body.linvel.y', 'body.linvel.z',
  'body.angvel.x', 'body.angvel.y', 'body.angvel.z',
  'gear', 'reverse', 'transmissionMode', 'engineRpm', 'engineLoad', 'steerAngle',
  'safeSample', 'trackHint',
  ...Array.from({ length: 4 }, (_, index) => `wheel.${index}.omega`),
  'telemetry.speedKmh', 'telemetry.signedSpeedKmh', 'telemetry.rpm',
  'telemetry.longitudinalAcceleration', 'telemetry.lateralAcceleration',
  ...Array.from({ length: 4 }, (_, index) => [
    `telemetry.wheel.${index}.load`,
    `telemetry.wheel.${index}.suspension`,
    `telemetry.wheel.${index}.slipRatio`,
    `telemetry.wheel.${index}.slipAngle`,
    `telemetry.wheel.${index}.slipPower`,
  ]).flat(),
];

const INPUT_FIELDS = [
  'steer', 'throttle', 'brake', 'handbrake', 'shiftUp', 'shiftDown',
  'toggleTransmission', 'reset', 'driveIntent',
];

function captureInput(input) {
  return [
    input.steer,
    input.throttle,
    input.brake,
    input.handbrake,
    input.shiftUp ? 1 : 0,
    input.shiftDown ? 1 : 0,
    input.toggleTransmission ? 1 : 0,
    input.reset ? 1 : 0,
    input.driveIntent,
  ];
}

function captureFrame(vehicle) {
  const translation = vehicle.body.translation();
  const rotation = vehicle.body.rotation();
  const linvel = vehicle.body.linvel();
  const angvel = vehicle.body.angvel();
  return [
    translation.x, translation.y, translation.z,
    rotation.x, rotation.y, rotation.z, rotation.w,
    linvel.x, linvel.y, linvel.z,
    angvel.x, angvel.y, angvel.z,
    vehicle.gear,
    vehicle.reverse ? 1 : 0,
    vehicle.transmissionMode === 'MT' ? 1 : 0,
    vehicle.engineRpm,
    vehicle.engineLoad,
    vehicle.steerAngle,
    vehicle.safeSample,
    vehicle.trackHint,
    ...vehicle.wheels.map((wheel) => wheel.omega),
    vehicle.telemetry.speedKmh,
    vehicle.telemetry.signedSpeedKmh,
    vehicle.telemetry.rpm,
    vehicle.telemetry.longitudinalAcceleration,
    vehicle.telemetry.lateralAcceleration,
    ...vehicle.telemetry.wheels.flatMap((wheel) => [
      wheel.load,
      wheel.suspension,
      wheel.slipRatio,
      wheel.slipAngle,
      wheel.slipPower,
    ]),
  ];
}

function hashFrames(frames, quantization = null) {
  const hash = createHash('sha256');
  const bytes = new ArrayBuffer(8);
  const view = new DataView(bytes);
  for (const frame of frames) {
    for (const original of frame) {
      assert.ok(Number.isFinite(original), `replay frame contains ${original}`);
      const value = quantization === null
        ? original
        : Math.round(original / quantization) * quantization;
      view.setFloat64(0, value, false);
      hash.update(new Uint8Array(bytes));
    }
  }
  return hash.digest('hex');
}

function digestFrames(frames, label) {
  let jsExact = REPLAY_DIGEST_OFFSET_BASIS;
  let wasmExact = REPLAY_DIGEST_OFFSET_BASIS;
  let jsQuantized = REPLAY_DIGEST_OFFSET_BASIS;
  let wasmQuantized = REPLAY_DIGEST_OFFSET_BASIS;

  for (let tick = 0; tick < frames.length; tick += 1) {
    for (let field = 0; field < FRAME_FIELDS.length; field += 1) {
      const value = frames[tick][field];
      const location = `${label} tick=${tick} field=${FRAME_FIELDS[field]}`;
      const jsQuantizedValue = quantize(value, QUANTIZATION);
      const wasmQuantizedValue = replayCore.streetrush_quantize_replay_value(
        value,
        QUANTIZATION,
      );
      assert.ok(
        Object.is(wasmQuantizedValue, jsQuantizedValue),
        `${location} quantized JS=${jsQuantizedValue} WASM=${wasmQuantizedValue}`,
      );

      jsExact = pushDigest(jsExact, value);
      wasmExact = asU64(replayCore.streetrush_replay_digest_push_f64(wasmExact, value));
      assert.equal(
        wasmExact,
        jsExact,
        `${location} exact JS=${digestHex(jsExact)} WASM=${digestHex(wasmExact)}`,
      );

      jsQuantized = pushDigest(jsQuantized, jsQuantizedValue);
      wasmQuantized = asU64(replayCore.streetrush_replay_digest_push_f64(
        wasmQuantized,
        wasmQuantizedValue,
      ));
      assert.equal(
        wasmQuantized,
        jsQuantized,
        `${location} quantized JS=${digestHex(jsQuantized)} WASM=${digestHex(wasmQuantized)}`,
      );
    }
  }

  return {
    exactFnv1a64: digestHex(jsExact),
    quantizedFnv1a64: digestHex(jsQuantized),
  };
}

function firstDivergence(actual, expected) {
  for (let tick = 0; tick < Math.min(actual.length, expected.length); tick += 1) {
    for (let field = 0; field < FRAME_FIELDS.length; field += 1) {
      if (!Object.is(actual[tick][field], expected[tick][field])) {
        return {
          tick,
          field: FRAME_FIELDS[field],
          expected: expected[tick][field],
          actual: actual[tick][field],
        };
      }
    }
  }
  if (actual.length !== expected.length) return { tick: Math.min(actual.length, expected.length), field: 'frame-count' };
  return null;
}

function runTrace(config, inputs) {
  const rig = createVehicleRig(config);
  const frames = [];
  const resetSamples = [];
  try {
    for (let tick = 0; tick < inputs.length; tick += 1) {
      const input = inputs[tick];
      if (input.reset) {
        resetSamples.push({ tick, sampleIndex: rig.vehicle.safeSample });
        rig.vehicle.reset(rig.vehicle.safeSample);
      }
      rig.vehicle.fixedUpdate(input, false, FIXED_DT);
      rig.world.step();
      rig.vehicle.afterPhysics();
      frames.push(captureFrame(rig.vehicle));
    }
    return { frames, resetSamples };
  } finally {
    destroyVehicleRig(rig);
  }
}

let baseline = null;
try {
  baseline = JSON.parse(await readFile(baselineUrl, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

let fnvBaseline = null;
try {
  fnvBaseline = JSON.parse(await readFile(fnvBaselineUrl, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const generated = {
  formatVersion: FORMAT_VERSION,
  fixedDt: FIXED_DT,
  quantization: QUANTIZATION,
  inputFields: INPUT_FIELDS,
  frameFields: FRAME_FIELDS,
  traces: {},
};
const generatedFnv = {
  formatVersion: REPLAY_FORMAT_VERSION,
  algorithm: REPLAY_DIGEST_ALGORITHM,
  quantization: REPLAY_QUANTUM,
  frameFieldsSha256: createHash('sha256').update(JSON.stringify(FRAME_FIELDS)).digest('hex'),
  traces: {},
};

for (const config of CARS) {
  generated.traces[config.id] = {};
  generatedFnv.traces[config.id] = {};
  for (const scenario of scenarios) {
    const inputs = scenario.inputs(scenario);
    const runs = Array.from({ length: REPEATS }, () => runTrace(config, inputs));
    const reference = runs[0];
    for (let repeat = 1; repeat < runs.length; repeat += 1) {
      const divergence = firstDivergence(runs[repeat].frames, reference.frames);
      assert.equal(divergence, null, `${config.id}/${scenario.id}/repeat-${repeat}: ${JSON.stringify(divergence)}`);
      assert.deepEqual(
        runs[repeat].resetSamples,
        reference.resetSamples,
        `${config.id}/${scenario.id}/reset samples`,
      );
    }
    generated.traces[config.id][scenario.id] = {
      seed: scenario.seed,
      ticks: scenario.ticks,
      inputSha256: hashFrames(inputs.map(captureInput)),
      exactSha256: hashFrames(reference.frames),
      quantizedSha256: hashFrames(reference.frames, QUANTIZATION),
      resetSamples: reference.resetSamples,
    };
    generatedFnv.traces[config.id][scenario.id] = digestFrames(
      reference.frames,
      `${config.id}/${scenario.id}`,
    );
  }
}

if (process.argv.includes('--print-candidate')) {
  console.log(JSON.stringify(generated, null, 2));
} else if (!baseline) {
  console.error('Replay baseline is missing. Generated candidate follows:');
  console.error(JSON.stringify(generated, null, 2));
  process.exitCode = 2;
} else {
  assert.deepEqual(generated, baseline, 'vehicle replay baseline changed');
  if (process.argv.includes('--print-fnv-candidate')) {
    console.log(JSON.stringify(generatedFnv, null, 2));
  } else if (!fnvBaseline) {
    console.error('Replay FNV baseline is missing. Generated candidate follows:');
    console.error(JSON.stringify(generatedFnv, null, 2));
    process.exitCode = 2;
  } else {
    assert.deepEqual(generatedFnv, fnvBaseline, 'vehicle replay FNV baseline changed');
    console.log(
      `PASS vehicle determinism cars=${CARS.length} scenarios=${scenarios.length} `
      + `repeats=${REPEATS} traces=${CARS.length * scenarios.length} wasmFnv=${CARS.length * scenarios.length}`,
    );
  }
}
~~~~

### scripts/test-surface-stability.mjs

~~~~javascript
import assert from 'node:assert/strict';
import { CARS, FIXED_DT, SURFACES } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  settleVehicle,
  stepVehicle,
  zeroInput,
} from './physics-harness.mjs';

function accelerateTo(rig, targetKmh) {
  const input = zeroInput({ throttle: 0.65, driveIntent: 1 });
  for (let step = 0; step < Math.round(20 / FIXED_DT); step += 1) {
    stepVehicle(rig, input);
    if (rig.vehicle.telemetry.speedKmh >= targetKmh) return;
  }
  throw new Error(`failed to reach ${targetKmh} km/h`);
}

function measureTurn(config, surfaceId) {
  const rig = createVehicleRig(config);
  try {
    settleVehicle(rig);
    accelerateTo(rig, 65);
    const baseNearestInfo = rig.vehicle.track.nearestInfo.bind(rig.vehicle.track);
    rig.vehicle.track.getSurface = (position) => ({
      id: surfaceId,
      ...SURFACES[surfaceId],
      info: { ...baseNearestInfo(position), surface: surfaceId },
    });

    const input = zeroInput({ throttle: 0.18, steer: 0.24, driveIntent: 1 });
    const totalSteps = Math.round(2.5 / FIXED_DT);
    const sampleStart = Math.round(2 / FIXED_DT);
    let yawRateTotal = 0;
    let lateralGTotal = 0;
    let samples = 0;
    for (let step = 0; step < totalSteps; step += 1) {
      stepVehicle(rig, input);
      if (step < sampleStart) continue;
      yawRateTotal += Math.abs(rig.vehicle.body.angvel().y);
      lateralGTotal += Math.abs(rig.vehicle.telemetry.lateralAcceleration) / 9.81;
      samples += 1;
    }
    return {
      yawRate: yawRateTotal / samples,
      lateralG: lateralGTotal / samples,
      speedKmh: rig.vehicle.telemetry.speedKmh,
    };
  } finally {
    destroyVehicleRig(rig);
  }
}

const mx5 = CARS.find((config) => config.id === 'mx5');
const asphalt = measureTurn(mx5, 'asphalt');
const gravel = measureTurn(mx5, 'gravel');
const grass = measureTurn(mx5, 'grass');

assert.ok(asphalt.yawRate > 0.3, 'asphalt reference turn must be established');
for (const [surfaceId, result] of [['asphalt', asphalt], ['gravel', gravel], ['grass', grass]]) {
  const availableLateralG = mx5.tire.mu * SURFACES[surfaceId].grip;
  assert.ok(
    result.lateralG <= availableLateralG * 1.05,
    `${surfaceId} lateral ${result.lateralG.toFixed(3)}g exceeded `
      + `${availableLateralG.toFixed(3)}g friction budget`,
  );
}

console.log(
  'PASS surface-limited stability',
  `asphalt=${asphalt.yawRate.toFixed(3)}rad/s ${asphalt.lateralG.toFixed(2)}g`,
  `gravel=${gravel.yawRate.toFixed(3)}rad/s ${gravel.lateralG.toFixed(2)}g`,
  `grass=${grass.yawRate.toFixed(3)}rad/s ${grass.lateralG.toFixed(2)}g`,
);
~~~~

### scripts/calibrate-physics.mjs

~~~~javascript
import { CARS } from '../src/config.js';
import {
  createVehicleRig,
  destroyVehicleRig,
  runFor,
  settleVehicle,
  zeroInput,
} from './physics-harness.mjs';

const TEST_DURATION_SECONDS = 60;

function simulateProductionVehicle(config) {
  const rig = createVehicleRig(config);
  settleVehicle(rig);
  const start = rig.vehicle.body.translation();
  let zeroToHundred = null;
  let zeroToTwoHundred = null;
  let peakSpeed = 0;
  const fullThrottle = zeroInput({ throttle: 1, driveIntent: 1 });

  runFor(rig, TEST_DURATION_SECONDS, fullThrottle, ({ elapsed, vehicle }) => {
    const speed = vehicle.telemetry.speedKmh;
    peakSpeed = Math.max(peakSpeed, speed);
    if (zeroToHundred === null && speed >= 100) zeroToHundred = elapsed;
    if (zeroToTwoHundred === null && speed >= 200) zeroToTwoHundred = elapsed;
  });

  const end = rig.vehicle.body.translation();
  const result = {
    zeroToHundred,
    zeroToTwoHundred,
    speedAtEnd: rig.vehicle.telemetry.speedKmh,
    peakSpeed,
    distance: Math.hypot(end.x - start.x, end.z - start.z),
    rpm: rig.vehicle.telemetry.rpm,
    gear: rig.vehicle.telemetry.gear,
  };
  destroyVehicleRig(rig);
  return result;
}

const formatTime = (value) => value === null ? '--' : `${value.toFixed(2)}s`;

console.log('Production VehicleSystem / flat asphalt / AT / full throttle');
for (const config of CARS) {
  const result = simulateProductionVehicle(config);
  console.log(
    `${config.name.padEnd(22)} `
    + `0-100 ${formatTime(result.zeroToHundred).padStart(7)}  `
    + `0-200 ${formatTime(result.zeroToTwoHundred).padStart(7)}  `
    + `60s ${result.speedAtEnd.toFixed(0).padStart(3)}km/h  `
    + `peak ${result.peakSpeed.toFixed(0).padStart(3)}km/h  `
    + `G${result.gear} ${Math.round(result.rpm)}rpm  `
    + `${(result.distance / 1000).toFixed(2)}km`,
  );
}
~~~~

### src/validation.js

~~~~javascript
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { CARS, FIXED_DT } from './config.js';
import { VehicleSystem } from './vehicle.js';
import { updateKeyboardSteer } from './input.js';

await RAPIER.init({});

class LabTrack {
  constructor() {
    this.config = { width: 80 };
    this.samples = Array.from({ length: 1024 }, (_, index) => ({ point: new THREE.Vector3(0, 0, index * 2), index }));
  }
  getResetPose() { return { position: new THREE.Vector3(0, 0.8, 0), yaw: 0, sampleIndex: 0 }; }
  getSurface(position) { return { id: 'asphalt', info: this.nearestInfo(position) }; }
  nearestInfo(position) { return { index: 0, offset: position.x, point: this.samples[0].point, surface: 'asphalt' }; }
}

const input = (patch = {}) => ({
  steer: 0, throttle: 0, brake: 0, handbrake: 0,
  shiftUp: false, shiftDown: false, toggleTransmission: false, reset: false,
  ...patch,
});

function step(vehicle, world, seconds, frame, observe) {
  for (let index = 0; index < Math.round(seconds / FIXED_DT); index += 1) {
    vehicle.fixedUpdate(frame, false, FIXED_DT);
    world.step();
    vehicle.afterPhysics();
    observe?.();
  }
}

function yaw(rotation) {
  return Math.atan2(2 * (rotation.w * rotation.y + rotation.x * rotation.z), 1 - 2 * (rotation.y ** 2 + rotation.z ** 2));
}

function angleDelta(after, before) {
  return Math.atan2(Math.sin(after - before), Math.cos(after - before));
}

function runCar(config) {
  const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  world.integrationParameters.dt = FIXED_DT;
  const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.3, 0));
  world.createCollider(RAPIER.ColliderDesc.cuboid(120, 0.3, 1500), ground);
  const vehicle = new VehicleSystem({ RAPIER, world, scene: new THREE.Scene(), track: new LabTrack(), config, visual: new THREE.Group() });

  step(vehicle, world, 2, input());
  let minY = Infinity;
  let maxY = -Infinity;
  step(vehicle, world, 3, input(), () => {
    minY = Math.min(minY, vehicle.body.translation().y);
    maxY = Math.max(maxY, vehicle.body.translation().y);
  });
  const restY = vehicle.body.translation().y;
  let launchY = restY;
  step(vehicle, world, 5, input({ throttle: 0.72 }), () => { launchY = Math.max(launchY, vehicle.body.translation().y); });
  const forward = vehicle.telemetry.signedSpeedKmh;

  const turn = (steer) => {
    vehicle.reset(0);
    step(vehicle, world, 4, input({ throttle: 0.58 }));
    const before = yaw(vehicle.body.rotation());
    step(vehicle, world, 0.75, input({ throttle: 0.12, steer }));
    return angleDelta(yaw(vehicle.body.rotation()), before);
  };
  const left = turn(0.42);
  const right = turn(-0.42);

  vehicle.reset(0);
  step(vehicle, world, 3.5, input({ throttle: 0.55 }));
  step(vehicle, world, 4, input({ brake: 1 }));
  step(vehicle, world, 1.6, input({ brake: 1 }));
  const reverse = vehicle.telemetry.signedSpeedKmh;
  step(vehicle, world, 4, input({ throttle: 1 }));
  const recovery = vehicle.telemetry.signedSpeedKmh;
  const recovered = !vehicle.telemetry.reverse && recovery > 3;
  const heave = maxY - minY;
  const lift = launchY - restY;
  const passed = heave < 0.035 && lift < 0.16 && forward > 20 && left > 0.06 && right < -0.06 && reverse < -3 && recovered;
  vehicle.destroy();
  world.free();
  return { heave, lift, forward, left, right, reverse, recovery, passed };
}

const tbody = document.querySelector('#results');
let passCount = 0;
for (const config of CARS) {
  const result = runCar(config);
  passCount += Number(result.passed);
  const row = document.createElement('tr');
  row.innerHTML = `<td>${config.name}</td><td>${(result.heave * 100).toFixed(1)} cm</td><td>${(result.lift * 100).toFixed(1)} cm</td><td>${result.forward.toFixed(0)} km/h</td><td>${result.left.toFixed(2)} rad</td><td>${result.right.toFixed(2)} rad</td><td>${result.reverse.toFixed(1)} km/h</td><td>${result.recovery.toFixed(1)} km/h</td><td class="${result.passed ? 'pass' : 'fail'}">${result.passed ? 'PASS' : 'FAIL'}</td>`;
  tbody.append(row);
  await new Promise((resolve) => requestAnimationFrame(resolve));
}
document.querySelector('#summary').textContent = `${passCount} / ${CARS.length} 车辆通过基础可驾驶验证`;
let lowSpeedTap = 0;
let highSpeedTap = 0;
for (let index = 0; index < 12; index += 1) {
  lowSpeedTap = updateKeyboardSteer(lowSpeedTap, 1, 0, 1 / 60);
  highSpeedTap = updateKeyboardSteer(highSpeedTap, 1, 160, 1 / 60);
}
let returned = lowSpeedTap;
for (let index = 0; index < 12; index += 1) returned = updateKeyboardSteer(returned, 0, 0, 1 / 60);
const inputPassed = lowSpeedTap > 0 && highSpeedTap > 0 && highSpeedTap < lowSpeedTap && Math.abs(returned) < 0.01;
const inputResult = document.querySelector('#input-result');
inputResult.className = inputPassed ? 'pass' : 'fail';
inputResult.textContent = `虚拟摇杆：${inputPassed ? 'PASS' : 'FAIL'} · 低速短按 ${(lowSpeedTap * 100).toFixed(0)}% · 高速短按 ${(highSpeedTap * 100).toFixed(0)}% · 松键回中 ${(returned * 100).toFixed(0)}%`;
~~~~

### data/vehicle-replay-baseline.json

~~~~json
{
  "formatVersion": 1,
  "fixedDt": 0.008333333333333333,
  "quantization": 0.000001,
  "inputFields": [
    "steer",
    "throttle",
    "brake",
    "handbrake",
    "shiftUp",
    "shiftDown",
    "toggleTransmission",
    "reset",
    "driveIntent"
  ],
  "frameFields": [
    "body.translation.x",
    "body.translation.y",
    "body.translation.z",
    "body.rotation.x",
    "body.rotation.y",
    "body.rotation.z",
    "body.rotation.w",
    "body.linvel.x",
    "body.linvel.y",
    "body.linvel.z",
    "body.angvel.x",
    "body.angvel.y",
    "body.angvel.z",
    "gear",
    "reverse",
    "transmissionMode",
    "engineRpm",
    "engineLoad",
    "steerAngle",
    "safeSample",
    "trackHint",
    "wheel.0.omega",
    "wheel.1.omega",
    "wheel.2.omega",
    "wheel.3.omega",
    "telemetry.speedKmh",
    "telemetry.signedSpeedKmh",
    "telemetry.rpm",
    "telemetry.longitudinalAcceleration",
    "telemetry.lateralAcceleration",
    "telemetry.wheel.0.load",
    "telemetry.wheel.0.suspension",
    "telemetry.wheel.0.slipRatio",
    "telemetry.wheel.0.slipAngle",
    "telemetry.wheel.0.slipPower",
    "telemetry.wheel.1.load",
    "telemetry.wheel.1.suspension",
    "telemetry.wheel.1.slipRatio",
    "telemetry.wheel.1.slipAngle",
    "telemetry.wheel.1.slipPower",
    "telemetry.wheel.2.load",
    "telemetry.wheel.2.suspension",
    "telemetry.wheel.2.slipRatio",
    "telemetry.wheel.2.slipAngle",
    "telemetry.wheel.2.slipPower",
    "telemetry.wheel.3.load",
    "telemetry.wheel.3.suspension",
    "telemetry.wheel.3.slipRatio",
    "telemetry.wheel.3.slipAngle",
    "telemetry.wheel.3.slipPower"
  ],
  "traces": {
    "mx5": {
      "seeded-steady-v1": {
        "seed": 1592590337,
        "ticks": 720,
        "inputSha256": "7c6ffcc87d5bc636740fdcd150070fe2b1136ea0c8a7d0bf3d18502e075002a0",
        "exactSha256": "f30f53cd0a03efe468656227862882bc14a1a6921f71cbef2fec34f70546c5b1",
        "quantizedSha256": "ed95fac9edf218d5b5678e3d00655b80b1e5a253aea509156128ab474c826297",
        "resetSamples": []
      },
      "shift-direction-v1": {
        "seed": 1592590338,
        "ticks": 960,
        "inputSha256": "64fba8b4c30314671863fb7dd11fe6d5dfcb1ba1e8ff8330c48576ff39a447e1",
        "exactSha256": "7c54872a5dfc8be2232bf66b1263e48cf9e40059f7672613b4f2223d0d1aebd2",
        "quantizedSha256": "1acdc157691967bc6a06a58d1c80ae54cf1eed711df1cae22dc6904334aa4404",
        "resetSamples": []
      },
      "reset-replay-v1": {
        "seed": 1592590339,
        "ticks": 900,
        "inputSha256": "6c343cb609376ab56a58b5c16767c4e59c228919f8da348202373a939bb63c90",
        "exactSha256": "c09378fbae9d5dd6af3bb00b4884375ca3d96f2c6017a89f9302b3af227d31dd",
        "quantizedSha256": "9a4973f981a87150581d01946eb165ec9f8473b6370a6f35d3b303fe70deae7a",
        "resetSamples": [
          { "tick": 300, "sampleIndex": 1 },
          { "tick": 600, "sampleIndex": 3 }
        ]
      }
    },
    "m3e30": {
      "seeded-steady-v1": {
        "seed": 1592590337,
        "ticks": 720,
        "inputSha256": "7c6ffcc87d5bc636740fdcd150070fe2b1136ea0c8a7d0bf3d18502e075002a0",
        "exactSha256": "9e91385b8fa3a0a50c6257fc3ee496cb66386e2329b5dd44fb0c67e55e613a28",
        "quantizedSha256": "b504ffd171d5c8aa38db52677de1ca148c0f1a57fe12dff7a28a7a83d7cb7bf2",
        "resetSamples": []
      },
      "shift-direction-v1": {
        "seed": 1592590338,
        "ticks": 960,
        "inputSha256": "64fba8b4c30314671863fb7dd11fe6d5dfcb1ba1e8ff8330c48576ff39a447e1",
        "exactSha256": "79847f35cc2a745ca80f14ded28200f2f452d9c022fc18884076238e1bd45cae",
        "quantizedSha256": "5fbdb7ea3c8c052ecb945a81186995c3c9a5f29a47b98f9719c7345b20a74d32",
        "resetSamples": []
      },
      "reset-replay-v1": {
        "seed": 1592590339,
        "ticks": 900,
        "inputSha256": "6c343cb609376ab56a58b5c16767c4e59c228919f8da348202373a939bb63c90",
        "exactSha256": "c7ccacdf4186de2d2367b22c580cd32448b90869d4198b963868b2184c549bb6",
        "quantizedSha256": "d3f6b2cd457bb2fa0ed544c7dfaf7dffd6bce53f3180385e09f0233546b60a61",
        "resetSamples": [
          { "tick": 300, "sampleIndex": 1 },
          { "tick": 600, "sampleIndex": 3 }
        ]
      }
    },
    "gt3rs": {
      "seeded-steady-v1": {
        "seed": 1592590337,
        "ticks": 720,
        "inputSha256": "7c6ffcc87d5bc636740fdcd150070fe2b1136ea0c8a7d0bf3d18502e075002a0",
        "exactSha256": "20f0246e5d42bbd1f80febba27e49c15ef417c2b4d2f718d7532c0c878a0b7bd",
        "quantizedSha256": "10935742e870294b42bb16ff1a093cf8cc0643d13ced4acdf73c93c3adcd6687",
        "resetSamples": []
      },
      "shift-direction-v1": {
        "seed": 1592590338,
        "ticks": 960,
        "inputSha256": "64fba8b4c30314671863fb7dd11fe6d5dfcb1ba1e8ff8330c48576ff39a447e1",
        "exactSha256": "19960cb970ece3e30830c1272a85d814108efeafebbfcbba2bc6a1f3feba038d",
        "quantizedSha256": "e4305f68a464c66f339e3768ea83c9836e85eff124f4452e12556c4dd326c42f",
        "resetSamples": []
      },
      "reset-replay-v1": {
        "seed": 1592590339,
        "ticks": 900,
        "inputSha256": "6c343cb609376ab56a58b5c16767c4e59c228919f8da348202373a939bb63c90",
        "exactSha256": "8c6c107a322187c0babad9f0debca89ac541e7776a8c6bdab5e5ca7f8f844541",
        "quantizedSha256": "6fe41036ce630b8c6edf16537e4719c1535684f2c422bebc7616cd71e918b293",
        "resetSamples": [
          { "tick": 300, "sampleIndex": 2 },
          { "tick": 600, "sampleIndex": 4 }
        ]
      }
    },
    "lp700": {
      "seeded-steady-v1": {
        "seed": 1592590337,
        "ticks": 720,
        "inputSha256": "7c6ffcc87d5bc636740fdcd150070fe2b1136ea0c8a7d0bf3d18502e075002a0",
        "exactSha256": "64fd12ed78c6c64bf86f2f8531da14ad343739fbc2b571774b22488c8cfe3179",
        "quantizedSha256": "6e6387d19eb10b6cda332ffc80eb307c69b1de1f82d53f95724f9e015387c941",
        "resetSamples": []
      },
      "shift-direction-v1": {
        "seed": 1592590338,
        "ticks": 960,
        "inputSha256": "64fba8b4c30314671863fb7dd11fe6d5dfcb1ba1e8ff8330c48576ff39a447e1",
        "exactSha256": "1dd6cf2c4d60c972ec23830dfc670a19d4e7ef0422e417e6c32b71c0bd08071b",
        "quantizedSha256": "d392b7abc3786739d53b5e1cec9d7c5c1f140c3bb451f82688be90746e4cd5c8",
        "resetSamples": []
      },
      "reset-replay-v1": {
        "seed": 1592590339,
        "ticks": 900,
        "inputSha256": "6c343cb609376ab56a58b5c16767c4e59c228919f8da348202373a939bb63c90",
        "exactSha256": "6414dc0828ceede2702cdaca00ac064dbf23b8caf3cc9145be9ebe306eef825b",
        "quantizedSha256": "bbd9578f3f55df2146338a9fc93b738ad1868fd9afd9a12b7bb645cf0a69b4c0",
        "resetSamples": [
          { "tick": 300, "sampleIndex": 2 },
          { "tick": 600, "sampleIndex": 4 }
        ]
      }
    },
    "amggt3": {
      "seeded-steady-v1": {
        "seed": 1592590337,
        "ticks": 720,
        "inputSha256": "7c6ffcc87d5bc636740fdcd150070fe2b1136ea0c8a7d0bf3d18502e075002a0",
        "exactSha256": "575c10120b2e56a87172b13dee885e66293d6ecfcf28ac200b74e1555ebb83cf",
        "quantizedSha256": "d374faadffc0f1fd5187f79dde62d8aae340cdb6a0b4745c54effa36bc9918c9",
        "resetSamples": []
      },
      "shift-direction-v1": {
        "seed": 1592590338,
        "ticks": 960,
        "inputSha256": "64fba8b4c30314671863fb7dd11fe6d5dfcb1ba1e8ff8330c48576ff39a447e1",
        "exactSha256": "9cc5bbcbaf04fd5b6aac1fc4409e629d6102f9e4cf63a6af97acfbf86c15f139",
        "quantizedSha256": "241be976ee669961a2bf11e9ddd3f8e033a466d9f3af8f2c6300d5e6d42b82f8",
        "resetSamples": []
      },
      "reset-replay-v1": {
        "seed": 1592590339,
        "ticks": 900,
        "inputSha256": "6c343cb609376ab56a58b5c16767c4e59c228919f8da348202373a939bb63c90",
        "exactSha256": "d78cec193cd19d453c0b33db4bbf373e4591c56612e8f30708f67099a6f670c2",
        "quantizedSha256": "80e7b26d9dec804995feefe621fc5a7d95588ba8ab6e32508e9d97bc2a74dc51",
        "resetSamples": [
          { "tick": 300, "sampleIndex": 2 },
          { "tick": 600, "sampleIndex": 5 }
        ]
      }
    },
    "m5g90": {
      "seeded-steady-v1": {
        "seed": 1592590337,
        "ticks": 720,
        "inputSha256": "7c6ffcc87d5bc636740fdcd150070fe2b1136ea0c8a7d0bf3d18502e075002a0",
        "exactSha256": "8005a861c6167894d0b5a2c80bd3a19d93278e35792963f3758fe87401781103",
        "quantizedSha256": "7176a07becc6ee766fea09d4d6a80eaa8f856a35fda2c67463de6b96272fce69",
        "resetSamples": []
      },
      "shift-direction-v1": {
        "seed": 1592590338,
        "ticks": 960,
        "inputSha256": "64fba8b4c30314671863fb7dd11fe6d5dfcb1ba1e8ff8330c48576ff39a447e1",
        "exactSha256": "a7ca6fc84aea666ed044c55d56a9fa13ccb49b87aafd2a5430c3d2333f147714",
        "quantizedSha256": "5d1cd11051b3993f3d61d2ded20010af40ec4b775dcd546833d6ffdc1cb0c456",
        "resetSamples": []
      },
      "reset-replay-v1": {
        "seed": 1592590339,
        "ticks": 900,
        "inputSha256": "6c343cb609376ab56a58b5c16767c4e59c228919f8da348202373a939bb63c90",
        "exactSha256": "e4f9bfb27598c6b34840520298887f80158a27e64f9edeadaad7219910cbc277",
        "quantizedSha256": "cdeb61f21b72355d8cfc197d9a24b35dcf206b38367382cff5c4314d589f5275",
        "resetSamples": [
          { "tick": 300, "sampleIndex": 2 },
          { "tick": 600, "sampleIndex": 4 }
        ]
      }
    }
  }
}
~~~~

### data/vehicle-replay-fnv-baseline.json

~~~~json
{
  "formatVersion": 1,
  "algorithm": "fnv1a64-canonical-f64-be",
  "quantization": 0.000001,
  "frameFieldsSha256": "d870ff6fbf581ec0b7766541a678a55ddf97035f25c5c93dbf36809793127787",
  "traces": {
    "mx5": {
      "seeded-steady-v1": {
        "exactFnv1a64": "c861e1b54259e4f1",
        "quantizedFnv1a64": "4cd7f5d47f18f6b0"
      },
      "shift-direction-v1": {
        "exactFnv1a64": "6ff5be20909cb55e",
        "quantizedFnv1a64": "6689ebab86072cda"
      },
      "reset-replay-v1": {
        "exactFnv1a64": "8cbf1354b10d3622",
        "quantizedFnv1a64": "4e56750def1fb4f3"
      }
    },
    "m3e30": {
      "seeded-steady-v1": {
        "exactFnv1a64": "97e3ea82859deea2",
        "quantizedFnv1a64": "4778feade0cf6b2c"
      },
      "shift-direction-v1": {
        "exactFnv1a64": "fc454af887bcd19d",
        "quantizedFnv1a64": "7c68ac040657f63a"
      },
      "reset-replay-v1": {
        "exactFnv1a64": "e97a5b2b12f7d50b",
        "quantizedFnv1a64": "dd04a94bcac56ada"
      }
    },
    "gt3rs": {
      "seeded-steady-v1": {
        "exactFnv1a64": "f34770843fe27e71",
        "quantizedFnv1a64": "33ac77777e8f9786"
      },
      "shift-direction-v1": {
        "exactFnv1a64": "19ef24a3e732025a",
        "quantizedFnv1a64": "2eb9d67f17f20a78"
      },
      "reset-replay-v1": {
        "exactFnv1a64": "168deec4203643bb",
        "quantizedFnv1a64": "2d30227eda573285"
      }
    },
    "lp700": {
      "seeded-steady-v1": {
        "exactFnv1a64": "3c836285e620323b",
        "quantizedFnv1a64": "69663e7d2fc13ab8"
      },
      "shift-direction-v1": {
        "exactFnv1a64": "3b538c7348ea2643",
        "quantizedFnv1a64": "8f5b9885583bf1ee"
      },
      "reset-replay-v1": {
        "exactFnv1a64": "1107281a813dd1fa",
        "quantizedFnv1a64": "3e911cdef2f97b9b"
      }
    },
    "amggt3": {
      "seeded-steady-v1": {
        "exactFnv1a64": "2da0546552e4421d",
        "quantizedFnv1a64": "2d8d774ccadb5bc3"
      },
      "shift-direction-v1": {
        "exactFnv1a64": "8966cb5686de2923",
        "quantizedFnv1a64": "04dd4fbf4eb07064"
      },
      "reset-replay-v1": {
        "exactFnv1a64": "4c0ef7b506f66393",
        "quantizedFnv1a64": "c80b8a2876fe16bf"
      }
    },
    "m5g90": {
      "seeded-steady-v1": {
        "exactFnv1a64": "e17ad9479f3c919f",
        "quantizedFnv1a64": "4907c3bbb6715fa4"
      },
      "shift-direction-v1": {
        "exactFnv1a64": "b468ea0d845c6d49",
        "quantizedFnv1a64": "dd91bd16b8773838"
      },
      "reset-replay-v1": {
        "exactFnv1a64": "f779de0a72ef8d6c",
        "quantizedFnv1a64": "4fa193b14a5f2fca"
      }
    }
  }
}
~~~~

### THROTTLE_BRAKE_HANDBRAKE_AUDIT.json

~~~~json
{
  "document_type": "streetrush_throttle_brake_handbrake_audit",
  "language": "zh-CN",
  "generated_date": "2026-08-21",
  "purpose": "自包含地记录当前油门、普通刹车、倒车和手刹的输入与物理逻辑，供直接复制、审阅和复现。本文不依赖任何外部文件引用。",
  "change_status": {
    "production_code_changed_by_this_audit": false,
    "note": "此前未经充分复现的试改已经完全撤回；本文件只记录当前已提交代码的真实行为。"
  },
  "control_mapping": {
    "keyboard": {
      "throttle": ["W", "ArrowUp"],
      "service_brake_and_reverse_request": ["S", "ArrowDown"],
      "handbrake": ["Space"]
    },
    "gamepad": {
      "throttle": "button 7 / right trigger",
      "service_brake_and_reverse_request": "button 6 / left trigger",
      "handbrake": "button 0 / A"
    },
    "touch": {
      "throttle": "GAS hold button",
      "service_brake_and_reverse_request": "BRAKE hold button",
      "handbrake": "handbrake hold button"
    }
  },
  "verified_current_outputs": [
    {
      "case": "S only",
      "raw_throttle": 0,
      "raw_brake": 1,
      "raw_handbrake": 0,
      "drive_intent": -1,
      "drive_throttle": 0,
      "service_brake": 1,
      "meaning": "车辆仍向前运动时，S会成为全量普通刹车。"
    },
    {
      "case": "W plus S",
      "raw_throttle": 1,
      "raw_brake": 1,
      "raw_handbrake": 0,
      "drive_intent": 0,
      "drive_throttle": 0,
      "service_brake": 0,
      "meaning": "油门和普通刹车同时满按时，当前逻辑把两者都归零；它不是刹车优先。"
    },
    {
      "case": "W plus Space",
      "raw_throttle": 1,
      "raw_brake": 0,
      "raw_handbrake": 1,
      "drive_intent": 1,
      "drive_throttle": 1,
      "service_brake": 0,
      "handbrake": 1,
      "meaning": "油门保持全量，同时后轮手刹保持全量；后驱车的驱动力和手刹力作用于同一对后轮。"
    }
  ],
  "confirmed_findings": [
    "W和S同时满按时，driveIntent为0，随后driveThrottle和serviceBrake都为0。",
    "普通刹车的名义分配为前轮每侧31%、后轮每侧19%，四轮合计100%的车辆brakeTorque。",
    "手刹额外施加在后轮，每侧62%，两侧合计124%的车辆brakeTorque。",
    "手刹制动力与普通刹车先相加，然后共同进入当前ABS滑移调制分支。",
    "手刹激活时，稳定辅助ESC被显式关闭。",
    "保持W并拉手刹时，当前传动逻辑不会自动切断driveThrottle。",
    "车辆油门、刹车、轮胎受力和手刹物理目前由JavaScript车辆系统负责；Rust/WASM不拥有这部分计算。"
  ],
  "not_yet_proven": [
    "仅凭静态代码还不能证明松开S后车辆为何会永久拒绝重新加速；该现象需要用持续W、按下S、释放S但不释放W的完整输入时间序列复现。",
    "仅凭现有测试不能证明手刹的最佳制动力矩或最佳ESC策略；现有测试场景与真人的急刹和全油门手刹操作不一致。",
    "没有现场遥测时，不能把所有左右摆动都归因于同一个变量。"
  ],
  "current_parameters": {
    "mx5": {
      "drivetrain": "RWD",
      "mass_kg": 990,
      "engine_torque_nm": 136,
      "final_drive": 4.3,
      "brake_torque": 2450,
      "tire_mu": 0.98,
      "service_brake_front_each_nm_at_full_input": 759.5,
      "service_brake_rear_each_nm_at_full_input": 465.5,
      "handbrake_rear_each_nm_at_full_input": 1519,
      "handbrake_rear_total_nm_at_full_input": 3038
    },
    "gt3rs": {
      "drivetrain": "RWD",
      "mass_kg": 1450,
      "engine_torque_nm": 465,
      "final_drive": 4.25,
      "brake_torque": 4550,
      "tire_mu": 1.27,
      "service_brake_front_each_nm_at_full_input": 1410.5,
      "service_brake_rear_each_nm_at_full_input": 864.5,
      "handbrake_rear_each_nm_at_full_input": 2821,
      "handbrake_rear_total_nm_at_full_input": 5642
    }
  },
  "production_logic": {
    "pedal_smoothing": {
      "description": "油门和普通刹车分别做阻尼平滑；driveIntent却直接根据未经平滑的rawThrottle和rawBrake计算。",
      "code": "export function updatePedal(current, target, riseRate, releaseRate, dt) {\n  return THREE.MathUtils.damp(current, target, target > current ? riseRate : releaseRate, dt);\n}\n\nframe.driveIntent = resolveDriveIntent(rawThrottle, rawBrake);\nframe.throttle = updatePedal(frame.throttle, rawThrottle, 4.3, 7.5, dt);\nframe.brake = updatePedal(frame.brake, rawBrake, 7.5, 11, dt);\nframe.handbrake = THREE.MathUtils.damp(frame.handbrake, rawHandbrake, 14, dt);"
    },
    "drive_intent_resolution": {
      "description": "同向只按一个踏板时返回方向；两个踏板同时有效且差值不超过0.05时返回0。",
      "code": "export function resolveDriveIntent(rawThrottle, rawBrake) {\n  const forward = rawThrottle > 0.05;\n  const reverse = rawBrake > 0.05;\n  if (forward && !reverse) return 1;\n  if (reverse && !forward) return -1;\n  if (forward && reverse) {\n    if (rawThrottle > rawBrake + 0.05) return 1;\n    if (rawBrake > rawThrottle + 0.05) return -1;\n  }\n  return 0;\n}"
    },
    "input_collection": {
      "description": "键盘、触控和手柄的输入会取最大值合并。",
      "code": "let rawThrottle = keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0;\nlet rawBrake = keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0;\nlet rawHandbrake = keys.has('Space') ? 1 : 0;\n\nrawThrottle = Math.max(rawThrottle, touch.throttle);\nrawBrake = Math.max(rawBrake, touch.brake);\nrawHandbrake = Math.max(rawHandbrake, touch.handbrake);\n\nrawThrottle = Math.max(rawThrottle, gamepad.buttons[7]?.value || 0);\nrawBrake = Math.max(rawBrake, gamepad.buttons[6]?.value || 0);\nrawHandbrake = Math.max(rawHandbrake, gamepad.buttons[0]?.value || 0);"
    },
    "transmission_direction_and_brake_arbitration": {
      "description": "这是当前完整的前进、普通刹车和倒车仲裁。driveIntent为0时，driveThrottle和serviceBrake保持初始0。",
      "code": "updateTransmission(input, dt, longSpeed) {\n  if (input.toggleTransmission) this.transmissionMode = this.transmissionMode === 'AT' ? 'MT' : 'AT';\n  if (this.transmissionMode === 'MT') {\n    if (input.shiftUp) this.requestShift(1);\n    if (input.shiftDown) this.requestShift(-1);\n  }\n\n  const switchSpeed = 0.22;\n  const explicitIntent = Number.isFinite(input.driveIntent);\n  const driveIntent = explicitIntent\n    ? Math.sign(input.driveIntent)\n    : (input.throttle > 0.055 ? 1 : input.brake > 0.055 ? -1 : 0);\n  const wantsForward = driveIntent > 0;\n  const wantsReverse = driveIntent < 0;\n  let driveThrottle = 0;\n  let serviceBrake = 0;\n\n  if (wantsForward) {\n    this.reverseHold = 0;\n    if (longSpeed < -switchSpeed) {\n      serviceBrake = input.throttle;\n    } else {\n      if (this.reverse) this.setReverseState(false, longSpeed);\n      driveThrottle = input.throttle;\n    }\n  } else if (wantsReverse) {\n    if (longSpeed > switchSpeed) {\n      this.reverseHold = 0;\n      serviceBrake = input.brake;\n    } else if (this.reverse) {\n      driveThrottle = input.brake;\n    } else {\n      serviceBrake = input.brake;\n      this.reverseHold += dt;\n      if (this.reverseHold >= REVERSE_ENGAGE_HOLD_SECONDS) {\n        this.setReverseState(true, longSpeed);\n        serviceBrake = 0;\n        driveThrottle = input.brake;\n      }\n    }\n  } else {\n    this.reverseHold = 0;\n  }\n  return { driveThrottle, serviceBrake };\n}"
    },
    "engine_and_driveline_torque": {
      "description": "普通油门经扭矩曲线、挡位、终传、效率和离合需求计算总驱动扭矩，再均分到驱动轮。手刹不参与这段仲裁。",
      "code": "const engineTorque = config.torque * torqueCurve(engineRpm) * pedals.driveThrottle;\nconst efficiency = drivetrainEfficiency(config.drivetrain);\nlet totalDriveTorque = engineTorque * ratio * config.finalDrive * efficiency * clutchDemand;\nif (reverse) {\n  totalDriveTorque *= -0.72;\n  if (speedKmh > 38) totalDriveTorque *= clamp((43 - speedKmh) / 5, 0, 1);\n}\nif (shiftTimer > 0) totalDriveTorque *= SHIFT_TORQUE_FACTOR;\nconst driveTorquePerWheel = totalDriveTorque / Math.max(1, drivenWheels.length);"
    },
    "wheel_drive_and_braking": {
      "description": "每个轮胎先取得驱动力；普通刹车按前31%和后19%分配；手刹在每个后轮额外叠加62%。合并后的brakeTorque进入同一个滑移调制。",
      "code": "let wheelDriveTorque = wheel.driven ? driveTorquePerWheel : 0;\nif (pedals.driveThrottle > 0.05 && Math.abs(slipRatio) > 0.11) {\n  wheelDriveTorque *= clamp(0.11 / Math.abs(slipRatio), 0.16, 1);\n  tcsActive = true;\n}\n\nlet brakeTorque = pedals.serviceBrake * config.brakeTorque * (wheel.front ? 0.31 : 0.19);\nif (!wheel.front) brakeTorque += activeInput.handbrake * config.brakeTorque * 0.62;\nif (brakeTorque > 0 && slipRatio < -0.17) {\n  brakeTorque *= clamp(0.17 / Math.abs(slipRatio), 0.2, 1);\n  absActive = true;\n}\n\nconst brakeDirection = Math.sign(Math.abs(wheel.omega) > 0.2 ? wheel.omega : wheelLongSpeed);\nconst angularTorque = wheelDriveTorque\n  - longitudinalForce * config.wheelRadius\n  - brakeDirection * brakeTorque;\nwheel.omega += angularTorque / wheelInertia * safeDt;\nif (brakeTorque > 0 && Math.sign(wheel.omega) !== Math.sign(wheel.omega - angularTorque / wheelInertia * safeDt)) {\n  wheel.omega = 0;\n}"
    },
    "stability_assist_gate": {
      "description": "稳定辅助要求至少两个轮胎承载、速度大于14km/h、偏航误差超过阈值，并且手刹没有激活。",
      "code": "const stabilityActive = groundedCount >= 2\n  && Math.abs(stabilityError) > 0.16\n  && speedKmh > 14\n  && !activeInput.handbrake;"
    },
    "telemetry": {
      "description": "HUD和音频读取的是仲裁后的driveThrottle与serviceBrake；当前HUD没有独立显示handbrake。",
      "code": "telemetry.throttle = pedals.driveThrottle;\ntelemetry.brake = pedals.serviceBrake;\ntelemetry.absActive = absActive;\ntelemetry.tcsActive = tcsActive;\ntelemetry.stabilityActive = stabilityActive;"
    },
    "audio_only": {
      "description": "声音系统只读取最终油门遥测作为发动机负载输入，不会向车辆施加任何力。",
      "code": "const load = telemetry.throttle;"
    }
  },
  "existing_test_coverage": {
    "service_brake_test": {
      "scenario": "先完全松开油门加速到约100km/h，再输入brake=1和driveIntent=-1。",
      "covered": ["单独普通刹车能减速到约1km/h", "停车距离和时间在宽容差内", "制动结束前不进入倒车"],
      "not_covered": ["W和S重叠", "刹车过程中转向或左右摆", "松开S但持续保持W后的恢复"]
    },
    "handbrake_test": {
      "scenario": "MX-5约65km/h，先以16%油门和0.22转向稳定，再以5%油门、0.22转向拉0.7秒手刹，随后以25%油门直行恢复4秒。",
      "covered": ["手刹相对对照组增加偏航", "峰值偏航和横向G不超过宽阈值", "四秒后偏航和车速恢复"],
      "not_covered": ["持续全油门时拉手刹", "直线急拉手刹", "普通刹车立即切到手刹", "真人键盘按键重叠", "GT3 RS手刹操控"]
    },
    "reverse_transition_test": {
      "scenario": "MX-5和GT3 RS在向前运动时单独按S，然后在静止状态继续保持S。",
      "covered": ["行驶中S作为普通刹车", "停车后短时间不误入倒车", "持续保持后仍能进入倒车"],
      "not_covered": ["同时按W和S", "从急刹直接恢复油门", "手刹"]
    }
  },
  "required_reproduction_sequences_before_any_fix": [
    {
      "id": "service_brake_overlap_recovery",
      "steps": [
        "MX-5自动挡、直线、约60至100km/h。",
        "持续保持W。",
        "不松W，按住S进行急刹。",
        "松开S，但整个过程不释放W。",
        "记录每个固定物理步的rawThrottle、rawBrake、driveIntent、smoothedThrottle、smoothedBrake、driveThrottle、serviceBrake、reverse、gear、speedKmh、四轮slipRatio和yawRate。"
      ],
      "success_condition": "S按下时车辆产生稳定普通制动；S释放后无需重新按W便恢复驱动力；不出现持续偏航振荡。"
    },
    {
      "id": "handbrake_recovery",
      "steps": [
        "MX-5自动挡、直线、约60至80km/h。",
        "持续保持W。",
        "点按空格0.2秒、0.4秒和0.7秒，分别独立运行。",
        "释放空格但持续保持W。",
        "记录driveThrottle、handbrake、四轮driveTorque估计、四轮brakeTorque、slipRatio、slipAngle、yawRate、ESC/ABS/TCS状态和恢复时间。"
      ],
      "success_condition": "手刹产生可预测的后轴滑移；释放后车辆能在合理时间内恢复，不因左右轮扭矩竞争持续摆动或自转。"
    }
  ],
  "standalone_reproduction_code": {
    "description": "以下JavaScript不导入项目文件，可单独复制运行，用来复现当前的踏板仲裁与名义制动力分配。它不是修复代码。",
    "code": "function resolveDriveIntent(rawThrottle, rawBrake) {\n  const forward = rawThrottle > 0.05;\n  const reverse = rawBrake > 0.05;\n  if (forward && !reverse) return 1;\n  if (reverse && !forward) return -1;\n  if (forward && reverse) {\n    if (rawThrottle > rawBrake + 0.05) return 1;\n    if (rawBrake > rawThrottle + 0.05) return -1;\n  }\n  return 0;\n}\n\nfunction currentTransmissionOutput({ throttle, brake, handbrake, longSpeed = 20 }) {\n  const driveIntent = resolveDriveIntent(throttle, brake);\n  const wantsForward = driveIntent > 0;\n  const wantsReverse = driveIntent < 0;\n  let driveThrottle = 0;\n  let serviceBrake = 0;\n\n  if (wantsForward) {\n    if (longSpeed < -0.22) serviceBrake = throttle;\n    else driveThrottle = throttle;\n  } else if (wantsReverse) {\n    if (longSpeed > 0.22) serviceBrake = brake;\n  }\n\n  return { driveIntent, driveThrottle, serviceBrake, handbrake };\n}\n\nfunction nominalBrakeTorques(brakeTorque, serviceBrake, handbrake) {\n  return {\n    frontLeft: serviceBrake * brakeTorque * 0.31,\n    frontRight: serviceBrake * brakeTorque * 0.31,\n    rearLeft: serviceBrake * brakeTorque * 0.19 + handbrake * brakeTorque * 0.62,\n    rearRight: serviceBrake * brakeTorque * 0.19 + handbrake * brakeTorque * 0.62\n  };\n}\n\nconst cases = [\n  { name: 'S only', throttle: 0, brake: 1, handbrake: 0 },\n  { name: 'W plus S', throttle: 1, brake: 1, handbrake: 0 },\n  { name: 'W plus Space', throttle: 1, brake: 0, handbrake: 1 }\n];\n\nfor (const input of cases) {\n  const output = currentTransmissionOutput(input);\n  const torques = nominalBrakeTorques(2450, output.serviceBrake, output.handbrake);\n  console.log(JSON.stringify({ input, output, mx5NominalBrakeTorques: torques }, null, 2));\n}"
  }
}
~~~~
