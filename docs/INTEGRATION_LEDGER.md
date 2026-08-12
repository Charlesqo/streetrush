# 整合记录

更新日期：2026-08-13

## 当前判断

当前最有价值的路线是：保留 NAS clean HEAD 的可玩网页基线，同时先把固定步调度与计时等边界清楚、容易对照的逻辑放入 Rust 共享核心。复杂车辆物理暂不机械翻译；C++ 核心和研究续跑先作为 oracle，等输入、输出、状态所有权和允许误差固定后再移植。

## 已整合

### NAS clean product baseline

- 来源：`Z:\Temp\street-rush-studio-continuation`
- Git 实际根：`//DS918/Charles/Temp/street-rush-studio-continuation`
- 分支：`main`
- 来源 commit：`5fdea8405c1951057eeb994635e5468273a71e62`
- 主题：`Abort stalled vehicle requests`
- 提取方式：对上述 commit 执行只读 `git archive`，校验 ZIP SHA-256 为 `3E4282576A77BEB8C43F8667CAF7FCAEF67F27B965E4C62B66A2013F61162B3A` 后解包；临时 ZIP 已删除。
- 与来源的变化：产品文件保持 commit 内容；新项目额外加入本整合记录、来源清单和实验日志。
- 回退边界：本导入将作为独立 Git 提交；NAS 脏工作区未混入。

### Windows 资产清单路径修复

- 触发：clean baseline 的完整 `pnpm verify` 在 Windows 上稳定产生 20 个互为镜像的资产路径错误。
- 最小复现：`scripts/test-asset-license-check.mjs` 直接运行 inventory checker，要求 10 个 manifest 路径与文件系统路径匹配。
- 来源参考：NAS 脏工作区 `scripts/check-asset-licenses.mjs` 已含相同的分隔符归一化思路，但其余约 350 行授权策略扩展未一并采用。
- 实际变化：`walk()` 只把 `node:path.relative()` 的平台分隔符归一为 `/`；加入回归脚本并接入 `pnpm verify`。
- 结果：最小回归和完整 `pnpm verify` 均通过；inventory 正确报告 10 个资产、1 个 public blocker、3 个 commercial blocker。

### Rust 固定步共享核心

- 来源 oracle：NAS clean commit `5fdea84` 中的 `src/config.js`、`src/physics-scheduling.js` 和 `scripts/test-physics-scheduling.mjs`。
- 原始契约：120 Hz `FIXED_DT`、50 ms `MAX_FRAME_DT`、每帧最多 6 个 physics steps；60/30/24/20 FPS 的 60 秒输入保持 60 秒模拟，15 FPS 因明确限幅得到 45 秒。
- 复制与变化：没有机械复制 JS；在 `crates/streetrush-core` 中实现 renderer-independent 状态化 accumulator、单帧计划和固定帧序列探针，并保留 JS 对 NaN、负数和无穷值的边界语义。
- 原生目标：`apps/streetrush-native` 使用同一 crate 输出五种帧率的步数、模拟秒数和 remainder，并以 oracle 偏差作为退出状态。
- WASM 接口：`streetrush-core` 同时生成 `cdylib`，以依赖为零的 raw ABI 导出常量、clamp、accumulate、单帧 plan 和序列 probe。稳定符号需要 `unsafe(no_mangle)`，`unsafe_code` lint 例外只允许在 `wasm_exports` 模块，其他 workspace 代码仍为 deny。
- Web 对照：`scripts/test-core-wasm.mjs` 实际实例化生成的 `.wasm`，逐帧与当前 JS oracle 比较；后续网页 owner 切换见下节。
- 结果：Rust 单测、native probe、native/WASM Clippy、wasm32 build 和 Node/WASM 对照全部通过。

### 固定步输入脉冲交接

- 来源参考：NAS HEAD `5fdea84` 之上的未提交 `src/input.js`、`src/main.js` 和 `scripts/test-input.mjs`；来源本批仍是 unstaged 脏改动，没有把它视为已验证 commit。
- 原始问题：clean baseline 每个 render frame 都立即消费换挡、变速模式和重置脉冲；当连续渲染帧小于一个 120 Hz physics step 时，脉冲会在没有执行任何物理步的情况下丢失。
- 失败证据：在本仓库加入键盘换挡、触屏重置和手柄重置的 sub-fixed 回归后，clean 实现稳定失败于第二帧 `keyboard shift-up ... retains pulse`，实际值为 `false`。
- 实际变化：`InputController.update()` 可选择只观察 fixed pulse；新增显式 `consumeFixedPulses()`，由 `fixedUpdate()` 在第一个实际物理步后统一消费；手动 reset 同步移入 fixed step。旧的即时消费调用仍是默认行为，非主循环调用者保持兼容。
- 未吸收：同一 NAS input diff 中的 gamepad 对象身份重连和多指 blur 行为；同一 `main.js` 大 diff 中的计时、生命周期、HUD 等改动。
- 结果：三类输入均跨两个 sub-fixed render frames 保留，在下一 physics frame 可见，消费后不重复；针对性测试、完整 `pnpm verify`、Rust 单测和 JS/WASM scheduler 对照均通过。

### 六车 reset 状态清理

- 来源参考：NAS 未跟踪 `scripts/test-vehicle-finite.mjs` 的 reset 部分，以及 HEAD `5fdea84` 之上的未提交 `src/vehicle.js`；测试在本仓库重写为不依赖 NAS 新增内部字段的 `scripts/test-vehicle-reset.mjs`。
- 原始问题：clean `reset()` 已清理刚体速度和部分传动标量，但保留转向/负载、轮胎接触缓存和上一帧 telemetry，导致 reset 后 HUD、音频或下一物理步可能观察到旧状态。
- 失败证据：用有限值污染后，6/6 车型均在相同字段簇失败：`steerAngle`、`engineLoad`、四轮 grounded/compression/force/hit/surface，以及整套 vehicle/wheel telemetry。
- 实际变化：只补全 `reset()` 拥有的现有运行状态，并抽出 `resetTelemetry()`；没有新增轮胎内部字段，没有加入无效 `dt`/输入防护，也没有吸收同一 NAS diff 的 texture 释放或 destroy 幂等。
- 结果：6/6 reset 回归、完整 `pnpm verify`、既有六车 smoke/regression、Rust 单测和 JS/WASM scheduler 对照全部通过；新回归已进入 `verify`。

### 车辆调用边界清理

- 来源参考：NAS 未跟踪 `scripts/test-vehicle-finite.mjs` 的 invalid input/`dt` 部分，以及未提交 `src/vehicle.js` 的 `safeUpdateDt()`/`sanitizeInput()`；本仓库把它重写成每个 case 使用独立车辆和配对 oracle 的测试。
- 原始问题：`fixedUpdate()` 直接解引用/计算外部参数；6/6 车型对 `null`、缺字段、NaN/Infinity 控制量和无效 `dt` 会抛异常或把非有限值扩散到 wheel、telemetry，随后污染 Rapier 刚体。
- oracle：非有限或非正 `dt` 替换为 `FIXED_DT`，其余限制到 `0.25 * FIXED_DT..50ms`；数值控制量限制到物理范围，非有限值回落为 0，离散字段只接受真正的布尔值。每个异常 case 与同初始状态的规范参数车辆逐字段比较，容差为 `1e-10 * max(1, |expected|)`。
- 额外证据：使用有效油门/转向后，`Number.MIN_VALUE` 和 `Number.MAX_VALUE` 虽未立即产生 NaN，也都偏离限幅 oracle；因此有限极端值限幅是可观察契约。
- 实际变化：只在 `VehicleSystem.fixedUpdate()` 入口生成 `safeDt`/`activeInput`，后续仍运行原物理算法；没有处理已污染内部标量或非有限刚体状态。
- 结果：15 个 input/`dt` 边界 × 6 车型（90 个配对 case）全部通过；完整 `pnpm verify` 的正常 120 Hz 六车加速、刹车、圆周和操稳指标保持原阈值，Rust/WASM scheduler 对照保持通过。

### 网页 Rust/WASM scheduler owner

- 来源：本仓库已提交 `streetrush-core` raw WASM ABI 和 JS fixed-step oracle；本批没有再复制外部代码。
- 生成边界：`scripts/build-core-wasm.mjs` 用锁文件构建 release `wasm32-unknown-unknown`，复制到忽略的 `src/generated/`；当前产物 2,533 bytes，Vite 因小于 4 KiB 把它作为 data URL 内联，不提交二进制。
- owner 接口：JS 与 Rust/WASM 都提供状态化 `advance()`/`reset()`、owner 名称、fallback 原因和同形 `{ steps, remainderSeconds, alpha }`；主循环不再拥有第二份 accumulator。
- 握手与回退：加载时核对 fixed dt、最大 frame dt、最大 steps 和五个必需导出；fetch、1.5 秒 timeout、instantiate、缺导出或契约不符均返回结构化原因的 JS owner，不让启动收到 rejected promise。
- 初始化时序：WASM 加载与 Rapier/车辆/场景加载并行，在第一次 `requestAnimationFrame` 前固定 owner；`html[data-physics-scheduler-owner]` 和可选 fallback code 提供运行时观测。
- 自动测试：真实 release WASM 逐帧对照 JS；注入 fetch、timeout、compile、missing export、contract mismatch 后，fallback owner 仍逐帧等价。
- 浏览器验证：真实路径报告 `rust-wasm`、无 fallback/console error；开始比赛后 HUD 可见、菜单隐藏、计时推进。开发期 missing-WASM 注入报告 `javascript`/`wasm-instantiate-failed` 并完成启动；Vite 对未知路径返回 HTML，故该实测分类是 instantiate 而非 404 fetch。
- 结果：完整 `pnpm verify`、Rust fmt/native+WASM Clippy、Rust 单测均通过；构建模块数由 29 增至 30，保留既有大 chunk warning。

## 待分批吸收的 NAS 脏改动

来源工作区无 staged 内容；有 28 个 tracked 修改和 11 个 untracked 测试，约 `+3108/-252`。二进制模型/纹理虽字节数相同但 Git 内容不同，必须单独审计哈希和结构。

建议批次：

1. 已污染内部标量/刚体 finite recovery 与对应失败测试（调用边界、reset 和输入脉冲已独立整合）；
2. 音频 pause/resume/recovery 与生命周期测试；
3. 资产超时、取消、缓存、引用安全释放与六车切换测试；
4. 计时并发存储、路线 HUD、布局和 renderer lifecycle；
5. 车辆 GLB、source model 和纹理的二进制差异。

## 当前仅参考或候选

- 旧 `E:\Codex\street-rush`：采样音频和较短兼容实现；没有独立提交历史。
- 六车模型研究：报告和隔离测试作为视觉适配器 oracle；生产适配器尚未实现。
- 多车音频：权威 runtime/data/schema 是强候选；不复制 3.14 GB 隔离副本和 vendor。
- C++ 物理核心：算法和实验是强 oracle；现有生产 `Vehicle` 与研究 `SharedWheelRide` 仍有明确耦合/状态边界。
- 六车物理数据：只采用带 provenance、field-scoped eligible 的值；冲突和缺失保持显式。
- 网络/轨迹/ESP32/城市模块：保留为未来能力，不进入近期集成。

## 已证实与被推翻的判断

- 证实：NAS clean commit 可以从 Git 对象精确提取，未混入工作区脏改动。
- 证实：NAS 是当前产品主线；旧实现的核心网页逻辑明显更早。
- 证实：模型研究齐全但生产轮组 adapter 缺失，不能把隔离动画当成游戏已接入。
- 证实：多车音频候选已覆盖取消、stale、fallback、重试、车库重入和释放；仍缺目标设备成本及完整系统 suspend/resume 证据。
- 证实：物理数据完整度不足以支持六车真实参数声称。
- 推翻：`vehicle-physics-core` 现存测试二进制通过不能代表当前源码全量通过；二进制早于新增 `shared_wheel_force_assembly` 测试并少报告一组 suite。
- 推翻：相同文件大小不能证明 NAS 脏二进制资产没有变化；Git 已报告内容差异。
- 推翻：首次 baseline `verify` 的资产失败不只是“新仓库还没有 HEAD”；创建 HEAD 后仍复现，真正根因是 Windows `\\` 与 manifest `/` 的路径比较。
- 证实：clean 输入层会在没有 physics step 的 sub-fixed render frame 提前消费离散脉冲；延迟到 fixed owner 消费可以保持一次性语义。
- 证实：clean `reset()` 没有清除多个自己拥有的车辆、轮胎和 telemetry 状态；六车的遗漏字段形状一致，能用独立 reset-only 修复消除。
- 证实：调用边界的非有限值会跨 wheel/telemetry 进入 Rapier；入口规范化能让 90 个配对 case 与明确 oracle 一致，并保持正常 120 Hz 回归。

## 当前最值得继续的方向

1. 审查 NAS 音频 pause/resume/recovery 改动与 `scripts/test-audio.mjs`，先复现 visibility/pause 生命周期的最小失败；
2. 将已污染 runtime scalar 与非有限 Rapier body recovery 保持为独立后续实验，不与调用边界清理混合；
3. 随后评估资产取消/释放与六车切换簇，按可观测资源生命周期选择下一批。
