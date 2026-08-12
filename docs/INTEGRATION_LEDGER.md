# 整合记录

更新日期：2026-08-13

## 当前判断

当前最有价值的路线是：保留 NAS clean HEAD 的可玩网页基线，把已有明确 JS oracle 的固定步调度、replay 数值格式和比赛进度规则逐段交给 Rust 共享核心。网页 shared WASM、开发期 authoritative timing 和长序列 lifecycle 已有稳定证据；production timing 切换暂缓到实际浏览器运行条件恢复。六车实际 GLB 结构已固定为离线 baseline，M3 生成轮组已接入 steer/compression/omega，static merge 也能显式保留动态 branch；MX-5 的 manifest 与 host-space pivot 重组已在同构 Three scene 验证，下一步应验证真实 GLTFLoader 对象名称/几何和 AssetManager 的原子失败回退，再决定是否接 production runtime。复杂车辆物理暂不机械翻译；C++ 核心和研究续跑先作为 oracle，等输入、输出、状态所有权和允许误差固定后再移植。

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
- 本批当时未吸收：同一 NAS input diff 中的 gamepad 对象身份重连和多指 blur 行为，后续已按独立失败吸收，见下节；同一 `main.js` 大 diff 中的计时、生命周期、HUD 等改动没有随 input 一并复制。
- 结果：三类输入均跨两个 sub-fixed render frames 保留，在下一 physics frame 可见，消费后不重复；针对性测试、完整 `pnpm verify`、Rust 单测和 JS/WASM scheduler 对照均通过。

### 输入设备身份与触控 blur 生命周期

- 来源状态：NAS `Z:\Temp\street-rush-studio-continuation` 的 `src/input.js` 与 `scripts/test-input.mjs` 均为 unstaged tracked 修改；相对 HEAD 分别为 `+57/-10` 和 `+142/-0`，没有把整个 dirty diff 当作提交版本。
- 来源指纹：dirty `src/input.js` SHA-256 `C1247332D686F1199930A31517ABBF85AE2F1DACB331F62735B871678A8F1194`；dirty `scripts/test-input.mjs` SHA-256 `7C6BE736B046E22C7029EBD8B6BACE466FAF419A063ACDCD181E349367F1AC71`。
- 覆盖对照：当前测试已覆盖 disconnect/reconnect、`releaseAll`、window blur/pagehide/visibility、local/global pointer terminal 和 fixed pulse；真正缺少的是 same-slot/new-object gamepad、元素 blur 下的多指 hold、元素 blur 下的 pulse pressed styling。
- red evidence：替换成仍按住油门的新 gamepad 对象时 `driveIntent` 实际为 1、期望 0；双指油门在元素 blur 后 `touch.throttle` 实际为 0、期望 1；reset 指针仍捕获时 pressed styling 实际为 false、期望 true。
- 实际变化：只记录当前 gamepad 对象，身份替换与断连一样进入 neutral handshake 并清旧按钮 edge；hold 的元素 blur 只清键盘模拟指针，物理指针继续独立拥有状态；pulse 不再用元素 blur 冒充 terminal event。window/document lifecycle 的全量释放路径保持不变。
- 未复制：来源同一 input diff 中已经单独整合的 fixed-pulse 代码和其余重复测试没有再次覆盖；没有吸收任何 `main.js`、HUD 或计时改动。
- 结果：三个新增回归与既有 input suite 通过；完整 `pnpm verify` 保持 12 项资产、18 条六车 deterministic/WASM FNV、1,320-action timing soak、六车物理/恢复和音频生命周期绿色；build 仍为 34 modules、4,864-byte shared WASM、24 files。
- 证据边界：自动 fixture 证明对象替换与 pointer ownership 契约；实际浏览器若每次 `getGamepads()` 都返回新 wrapper，引用身份策略需要重新评估。当前 Browser URL policy 仍阻止补做真实设备/六车运行验证。

### 六车 production GLB 结构 baseline

- 当前对象：`public/cars` 六个文件均与 NAS clean HEAD Git blob 一致；新增依赖为零的 `scripts/car-model-structure.mjs`，直接校验 GLB v2/JSON chunk、SHA-256、scene/node/mesh/primitive/accessor、extension、name digest 和候选轮组/灯光名称。
- bounds 方法：只遍历 default scene，用静态 node matrix/TRS 变换 POSITION accessor min/max 的八个角，得到 conservative world AABB；不执行 skin、morph 或 animation。六车无 skin，只有 MX-5 报告 1 个 animation，因此 baseline 明确不是动画后包围盒。
- research 对照：MX-5、M3、GT3 RS、LP700 的 public GLB 与 `multi_car_model_research` SHA-256 完全相同；M5/AMG 的研究 hash 则与 NAS `source-models` 和 `赛车游戏素材/runtime/cars` 完全相同。现有文档/manifest 明确 public M5/AMG 是网页优化派生，不是来源漂移。
- derivative 证据：M5 source→public 为 `5,806→28 nodes`、`1,169→28 meshes`，AMG 为 `540→51 nodes`、`166→51 meshes`；两者 triangle counts 各自保持 790,738/302,492，public generator 为 `glTF-Transform v4.4.1`。
- 结构结果：新进程复跑得到 `cars=6 researchExact=4 wheelNamed=4`。LP700/M5 没有名字候选；GT3 的 102 个 wheel 命中大量来自 `rubbertrim`，说明名称 regex 只能作漂移探针，不能作为六车 runtime binding oracle。
- baseline：`data/car-model-structure-baseline.json` 固定当前 hash、counts、extensions、name/candidate digests、static bounds 与 production target-length normalization；测试加入 `pnpm verify`，模型字节或 config 尺寸变化必须显式重新评估。
- 纠错：NAS dirty raw diff 中 4 个 public GLB、2 个纹理和 2 个 source GLB 都是 `100755→100644` mode-only；HEAD/index/worktree blob 相同。此前把这些状态描述成“同大小但内容不同”已被推翻。

### M3 generated-wheel 动态 adapter

- 来源：M3 `wheel_binding.json` SHA-256 `A81DC71F99989C301CFA6C5F26C2E3D2121F6C5354A3B8465D6EF67036AA76D0`；`unresolved_items.json` SHA-256 `5239D6A9470A4916476497FC6B5FF1298BA40F09CC9FEF89AAE98891286FE258`。两者把 generated wheels 未接 `VehicleSystem` 列为 P0。
- red evidence：现有 `calibrated-wheels` 只是 8 个扁平 tire/rim meshes；第一个断言即失败为 `FL has a steer/suspension pivot`，证明 production 没有可绑定的四轮层级。
- 实际变化：按 physics `FL/FR/RL/RR` 建立 steer/suspension 外 pivot 和 roll 内 pivot；clone 后用稳定 name + primitive userData version 发现，不把 Object3D 引用塞入会 JSON-clone 的 `userData`。
- runtime：`VehicleSystem` 只在完整 v1 generated set 存在时绑定；front pivot 写 `steerAngle`，四轮 Y 写 `baseY + compression`，roll angle 由 `omega * fixed dt` 积分并按 render alpha 插值。角度有长期 rebase 与非有限恢复，reset 清除 previous/current angle。
- 结果：真实 Rapier rig 验证 clone 后四轮顺序、嵌套轴、steer/compression/roll、fixedUpdate 接线、NaN/Infinity 恢复和 reset；完整 `pnpm verify` 保持 18 条六车 WASM replay、1,320-action timing soak、六车物理/恢复、音频、12 项资产生命周期和 GLB baseline 绿色；build 仍为 34 modules、4,864-byte WASM、24 files。
- 未解决：M3 retained Brake_Disc/Brembo_Calipers 仍带约 28.68° baked front steer 并会进入 static merge；其动态分组/隐藏策略需要独立视觉与 draw-call 证据。其他五车没有获得生成轮组或名字猜测 adapter。

### static merge 的显式动态 branch 分区

- 来源参考：M3 wheel binding 同上；MX-5 `wheel_binding.json` SHA-256 `5879DC06C16289E221CF93032C98C9A5123BF99060A84B8F27F383C91F00A786`；GT3 `wheel_binding.json` SHA-256 `ADBE84417FA19F14B036C2E857C74E14F3AD95014F1842D7BFAE7206735A064B`。三者都指出 canonical static merge 会移除 source hierarchy。
- red evidence：合成 9 static + 2 dynamic meshes，dynamic root 带 `{version:1,id}` marker；旧 merge 后 `dynamic-FL-brake` 完全不存在，13 项资产测试唯一失败为 `dynamic pivot survives static batching`。
- 实际变化：只识别显式 v1 marker 的最上层 branch；其 meshes 不进入 static batches。输出用原 parent world matrix 的手动 base 包住 deep clone，从而保留 marker root 自己的 local pivot、子层级与共享 geometry/material。
- fail-closed：无 marker 路径仍执行原 merge；静态部分不满足原门槛或含 unsupported mesh 时仍返回原 model；nested marker 只保留最外层，避免重复 clone。diagnostic 分开记录 static source、dynamic 和总 batched draw calls。
- 合成结果：9 static draw calls 合为 1，2 dynamic 保持 2，总数 3；branch world position 误差 `<1e-9`，canonical/instance pivot 对象独立，geometry 仍共享。既有 pending/retry/timeout/late disposal/preload/fallback tests 保持通过，资产测试为 13/13。
- 回归：完整 `pnpm verify` 通过；18 条六车 deterministic/WASM replay、1,320-action timing soak、六车物理/恢复、音频与 Rust/WASM owner 均保持；build 为 34 modules、4,864-byte WASM、24 files。
- 暂缓 production marker：MX-5 虽有 `Circle.002..005` 稳定 roots，但报告要求按 tire centroid 新建 outer-Y/inner-X pivot；M3 brake/caliper 需处理 baked front steer；GT3 状态明确是 source hierarchy only in isolation。仅保留 branch 还不足以得到正确轮组运动。
- derivative 限制：M5/AMG public 模型已合并为 28/51 meshes，不存在 source hierarchy；本机制不能逆向拆 mesh。若未来采用，必须从 source copy 建立保留 dynamic partitions 的可重复优化 pipeline。
- 结论边界：本实验只证明显式 branch 可跨静态合并保存资源与变换所有权；它没有证明该 branch 已有正确的 wheel centroid、steer/roll 轴或 caliper 归属，车型级 manifest 仍是接入前置条件。

### MX-5 hash-scoped wheel manifest

- 来源状态：只读研究 `E:\Codex\autonomous_runs\multi_car_model_research\mazda-miata-mx5-na\wheel_binding.json` SHA-256 `5879dc06c16289e221cf93032c98c9a5123bf99060a84b8f27f383c91f00a786`，`wheel_validation_summary.json` SHA-256 `1e2f8db932f34f1b385b8a1402db0db1eedb052d157e80ef18e7cba2ee23544f`；报告状态是 isolated-browser 已验证但 canonical adapter 未接入。
- source identity：当前 `public/cars/mazda-miata-mx5-na.glb` 为 1,925,828 bytes，SHA-256 `a17b3b9edc0997ba77837ae4358e3dfe7b7aa7f59364d7c15b6fb01a3452d26b`，与研究 source byte-identical；manifest 不依赖外部来源目录才能运行，只登记来源路径/指纹。
- red/new finding：初版按 mesh 顺序猜 FL rim 的 POSITION accessor 为 24，实际 primitive 指向 72，测试首先报 `expected 24, found 72`；因此推翻“accessor 可按 mesh 顺序推导”，改为逐 primitive 解码并显式锁定。
- 实际变化：新增 v1 `data/car-wheel-manifests/mx5.json` 和只读 GLB BIN accessor validator；固定 FL/FR/RL/RR roots、三种 part role、node/mesh/material、12 个 POSITION accessors/vertex counts、exact transformed vertex bounds、tire vertex centroids 和坐标轴。
- geometry evidence：accessors 为 FL `72/76/80`、FR `60/64/68`、RL `84/88/92`、RR `48/52/56`；12 组 raw world bounds 与研究报告在 1e-9 舍入下一致。四个 tire centroid 摘要为 `9707b78576e4433d82dd8fbeef9f7cbf64a07337e96781fd78c0d45e58fe9dc3`。
- axis evidence：四个 raw parent local-Z 转 world 都与 +X 对齐，最大误差 `8.6821e-8`；manifest 明确 runtime outer steer 为 Y、nested roll 为 X，pivot method 是 Material.014 tire POSITION vertex average。
- fail-closed：source hash/bytes、root、material role、accessor、bounds、axis、pivot centroid 七类漂移均有独立拒绝测试；六车 structure baseline 与 MX-5 manifest 联合通过。
- 回归：manifest 测试加入 `pnpm verify`；完整回归保持 13 项资产生命周期、18 条六车 deterministic/WASM replay、1,320-action timing soak、六车物理/恢复、34 modules、4,864-byte WASM 和 24-file build。
- 边界：状态保持 `candidate-offline-validation-runtime-not-integrated`；本批没有给 GLB 节点加 marker、没有移动 mesh、没有改变 `AssetManager` 或 `VehicleSystem` runtime。下一前置条件是纯 scene attach/pivot fixture。

### MX-5 host-space wheel pivot 候选接口

- 来源复核：研究隔离 harness 的 `makeModel()` 把整个 `Circle00x` wheel root attach 到 nested spin pivot；因此 rim、tire、Material.017 brake-disc-like rotor 都随 X roll。报告同时明确“caliper mesh was not found”；此前计划中的“disc outer-only”判断被推翻，只有未来独立 caliper 才应留在 outer。
- runtime naming：GLTFLoader 会用 `PropertyBinding.sanitizeNodeName()` 去除句点；manifest 新增 `Circle004`/`Circle004_Material014_0` 等显式 runtime names，离线 validator 同时锁 raw name 与当前 Three sanitizer 输出。
- direct red：用 actual GLB root TRS、真实 tire vertex centroid 与 production scale `0.015102163` 构造同构 scene；source direct `rotateZ(0.72)` + front `rotateY(0.34)` 使 tire centroid 最大漂移 `0.008845718m`，与研究 7–9mm 量级一致。
- host boundary：pivot container 必须是 normalized GLB model 的未缩放 sibling，挂在 unit-scale vehicle host；否则 `compression=0.08m` 会再次乘 model scale，误成约 1.2mm。接口对非 unit host、缺 part、重复 binding 均在 mutation 前拒绝。
- attach finding：Three `Object3D.attach()` 对大 raw translation + 非均匀 wheel root scale 产生 `1.0395e-8` matrix 误差，超过 `<1e-9` 停止条件；改为 `inverse(parentWorld) × childWorld` manual matrix，并让 source root `matrixAutoUpdate=false`，零姿态 matrix error 为 0。
- bound green：四个 outer-Y / nested-X pivots 的 tire centroid 组合运动漂移 `<2.44e-16m`；全部 12 parts 的 matrix 随 roll，front rim/rotor 的偏置质心随 steer，rear 同轴质心在纯 roll 下保持；0.08m suspension 使 12 parts 精确移动 host Y 0.08m。
- ownership：`calibrated-wheels` 沿用现有 v1 binding marker；canonical/clone Object3D 独立而 geometry/material 共享，binder 不创建可释放的 GPU resource。失败缺 tire 时四个 source roots 全部保持原 parent；9 个静态 body meshes 仍可合为 1，独立 wheel host 不被吞掉。
- 回归：新增 pivot test 加入 `pnpm verify`；完整回归保持 13 项资产生命周期、manifest/structure、现有 M3 adapter、18 条六车 deterministic/WASM replay、1,320-action timing soak、六车物理/恢复、34 modules、4,864-byte WASM 和 24-file build。
- 边界：`src/car-wheel-pivots.js` 目前未被 production assets path 导入，仍是经测试的候选接口；同构 fixture 不能替代对真实 GLTFLoader clone、加载失败和 fallback 生命周期的验证。

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

### 六车内部数值污染恢复

- 来源参考：NAS 未跟踪 `scripts/test-vehicle-finite.mjs`，读取时 8,853 bytes，SHA-256 `11774364003300A3AAE79DEC422A9FD4F0AA762EA47D2FBF3D2582047B69A163`；原测试混合了已整合的 reset、外部 input/dt 和内部污染，本批只重写第三部分。
- 配对 oracle：每辆污染 rig 与同初态显式 fallback rig 比较。5 类 owner/cache（controls、transmission timers、history timers、4 wheel omega、悬空 telemetry contact）共 30 对；4 类 body setter 共 24 对。
- clean 结果：48/54 失败。30/30 scalar/cache 均失败；translation/linvel/angvel 真正写入非有限 body，18/18 失败；6 个 `setRotation(NaN)` 被 Rapier 拒绝/归一成有限状态，与正常一步一致，不能伪记为 reset 缺陷。
- 实际变化：fixedUpdate 使用 owner 前恢复并限幅 steer/load，恢复 RPM/timers/history/gear/reverse/wheel omega 与非有限 contact cache；读取 body pose/velocity 后先做有限性检查，失败则 `reset(safeSample)` 并立即返回；计算后 telemetry 再做有限性门禁。
- 恢复语义：owner/cache 与显式局部 fallback 一致；真正非有限 body 与显式 reset oracle 一致；Rapier 已保持有限的 rotation 不做多余 reset。未覆盖 config、wheel anchor 或 collider 内部污染，不声称任意内存损坏可恢复。
- 结果：30 scalar/cache + 24 body 配对全通过，其中 6 是 Rapier setter-normalized 路径；既有 90 外部边界、六车健康物理指标与完整 `pnpm verify` 保持通过。

### 固定 seed 六车确定性基线

- 事件 owner：测试复刻 main 顺序——manual reset 先 `reset(safeSample)`，同 tick 仍执行 `fixedUpdate → world.step → afterPhysics`；toggle/shift/direction 由 VehicleSystem 消费。
- trace：`seeded-steady-v1` 720 ticks、`shift-direction-v1` 960 ticks、`reset-replay-v1` 900 ticks；三组输入 seed 分别为 `0x5eed0001..3`，每组 9 个 input 字段有独立 SHA-256。
- snapshot：每 tick 50 个 canonical 数值，包括 body pose/velocity、gear/reverse/mode、RPM/load/steer、safeSample/trackHint、4 wheel omega 和关键 wheel telemetry；exact 使用 big-endian Float64 bytes，另有 1e-6 quantized SHA-256。
- 首次运行：同一进程每个 car/scenario 重复 3 次，逐 tick `Object.is` 无首个分歧；退出 2 只因 baseline 文件尚不存在。用候选创建 `data/vehicle-replay-baseline.json` 后，新 Node 进程 18/18 trace 全匹配。
- 信息量：reset sample 因车辆演化而不同（如 MX-5 `1→3`、AMG GT3 `2→5`），证明记录不是固定空日志；input hash 将“生成器/输入变化”与“物理状态变化”分层。
- 限制：只证明当前 Windows + Node 24 + 当前 Rapier WASM 在同环境的同/跨进程重现；未证明浏览器、不同 CPU/版本或 Rust 物理一致。quantized hash 是未来比较边界，不是已有跨平台证明。
- 结果：18 traces × 3 repeats = 54 runs 通过，并进入 `pnpm verify`；完整六车、Rust/WASM scheduler、audio/assets/build 门禁保持通过。

### Rust replay 数值契约 v1

- 来源：本仓库已登记的六车 replay 字段顺序与 JS `Float64`/1e-6 quantization 契约；本批没有复制外部代码，也没有迁移 Rapier 状态。
- 格式：`REPLAY_FORMAT_VERSION=1`；所有数值按 canonical big-endian IEEE-754 bytes 摘要。NaN payload 统一为 `0x7ff8000000000000`，`+0/-0` 和正负无穷保持可区分。
- 量化：默认 quantum 为 `1e-6`，精确遵循 JS `Math.round` 的 half-toward-positive-infinity 与负零行为；非法 quantum/非有限 value 保持原值，缩放溢出不把有限 value 变成 infinity，缩放下溢保留结果的 signed zero。
- digest owner：`streetrush-core` 提供无状态、无分配的 FNV-1a 64 `push_f64(state, value)`；没有加入全局 mutable state。native 和 raw WASM 使用同一函数，WASM `u64` 在 JS 侧按 unsigned 64-bit BigInt 解释。
- 固定 oracle：13 个边界值覆盖 ±0、±1.5、±half quantum、最大有限值、±最小次正规数、±Infinity 与两个不同 NaN payload；exact 固定为 `0248d9354f126505`，quantized 固定为 `0603ecb87904c881`。
- 真实 trace 接线：`scripts/test-vehicle-determinism.mjs` 只复用每个场景已有的 reference frames，不重跑第二套车辆模拟；在 774,000 个 tick/field 位置分别比较 exact 与 quantized 的 JS/WASM rolling state，失败信息含 car/scenario/tick/field/value/state。
- baseline：新增独立 `data/vehicle-replay-fnv-baseline.json`，登记 18 条 exact/quantized FNV 和 50-field schema SHA-256；原 `vehicle-replay-baseline.json` 的 SHA-256/input/reset fixture 未改。缺失 WASM 有显式失败探针，不静默用 JS 自证。
- 结果：replay 当批的 13 个 Rust 单测、native 固定摘要、native/WASM Clippy `-D warnings`、特殊向量和 18 条真实 trace 的 release WASM/独立 JS 对照全部通过；加入 timing ABI 前 WASM 为 3,658 bytes，完整 `pnpm verify` 保持绿色。
- 限制：FNV 只用于快速确定性比较，不是安全/防篡改摘要；证据仍限于当前 Windows + Node/Rapier WASM 环境，未证明浏览器、其他 CPU 或版本一致。

### Rust 比赛进度与计时规则核

- 来源 oracle：当前 `src/race-timing.js`、9 个 timing tests、medal tests 和 `main.fixedUpdate` 的 `advance → invalidate → checkpoint` 顺序；没有复制外部来源。
- 红测试：先加入真实 WASM shadow sequence，旧 core 明确失败于缺少 `streetrush_timing_contract_version`；实现前测试不是自始为绿。
- Rust native owner：`RaceProgress` 持有 status、exact ms、lap/sector 起点、checkpoint/sector 进度和当前圈有效性；校验 laps/checkpoints/sector config，非法 delta/index 返回错误且不改状态。原生程序完成 2 圈 11,700 ms 并判定 gold。
- raw WASM 边界：contract v1 只暴露无全局状态的 exact advance、JS-compatible duration round、expected/ordinal、checkpoint event flags 和 medal rule；JS shadow 持有同一标量状态，不使用 Rust 指针或隐藏 mutable singleton。
- JS 保留：track/car identity、localStorage、invalid reason 字符串/去重、PB/sector/race record mutation、save 时机、完整 event/snapshot 对象和 UI 均未迁移；因此当前网页 timing owner 没有切换。
- 对照序列：31 个 action snapshots 覆盖 120 Hz fractional accumulation、错序 checkpoint、首次/重复 invalidation、invalid+valid lap、sector/lap/run flags、restart、PB 已存在后的 valid run 和 gold boundary；每步对照 JS `RaceTimingSession` 的纯进度投影及 event duration/validity。
- 结果：Rust 单测由 13 增至 17，native probe、workspace/wasm32 Clippy、真实 WASM shadow 和完整 `pnpm verify` 全部通过。
- 资产边界：release WASM 从 3,658 增至 4,864 bytes，超过 Vite 4 KiB inline 阈值；构建正确输出 `assets/streetrush_core-*.wasm`，24-file freshness/public-asset/Cloudflare 检查通过，scheduler owner 仍走真实 WASM。
- 限制：shadow 证明规则一致，不等于网页 timing owner 已切换；PB/persistence/save event 尚无 Rust 数据协议，不能把它们默认为可直接迁移。

### shared-core 单实例与 capability 隔离

- 原始问题：`physics-scheduler-owner.js` 同时拥有 fetch/AbortController/timeout/instantiate 和 scheduler contract；timing shadow 只能直接再实例化同一 WASM，继续扩展会复制资源生命周期。
- 红测试：先加入 `test-shared-core-owner.mjs`，旧代码因不存在 `shared-core-owner.js` 以 `ERR_MODULE_NOT_FOUND` 退出 1。
- 分层：`shared-core-loader.js` 只负责一次 fetch/timeout/instantiate 和 exports object；scheduler 与 race-progress 模块分别验证 required exports/contract 并各自生成 structured fallback；聚合 owner 不合并 capability failure。
- 隔离矩阵：完整 core instantiate 计数为 1；缺 timing、缺 scheduler、两类 contract mismatch 均只回退对应 capability；fetch 404 与 timeout 才让两者共享 load fallback。scheduler fallback 仍逐帧与 JS oracle 一致。
- 兼容：既有 `loadPhysicsScheduler()` 继续可调用，但内部复用通用 loader；原 fetch/compile/timeout/missing export/contract mismatch 测试和 fallback code 未改变。
- main：启动期并行 promise 现在返回 `{scheduler, raceProgress}`；设置两个独立 data owner 并记录 dev events。race-progress 只作为已加载的 shadow capability，`RaceTimingSession` 仍是 live owner。
- timing shadow：改为从聚合 owner 取 wrapper，断言 scheduler 与 timing 共用一次 real WASM instantiate；31-snapshot oracle 保持通过。
- 结果：shared/legacy/timing targeted tests 和完整 `pnpm verify` 通过；Vite 33 modules、单个 4,864-byte hashed WASM，Cloudflare/public assets/secret guard 均通过。
- 限制：自动测试证明实例与失败隔离；此前 Browser URL policy 已阻止继续本地浏览器循环，本批未把构建测试描述为新的实际浏览器证据。

### RaceProgressSession 双路径 wrapper

- 红测试：先以真实 shared core 和 fallback capability 导入不存在的 `race-progress-session.js`，稳定得到 `ERR_MODULE_NOT_FOUND`。
- wrapper owner：持有 exact clock、lap/sector 起点、checkpoint/sector 进度和 current-lap validity；通过注入 core 调用 advance/round/expected/ordinal/flags。输出只含 11-field progress snapshot 和 compact checkpoint outcome。
- JS fallback：`createJavaScriptRaceProgressCore` 从 metadata fallback 补成完整同形 rule capability；保留 fallback reason，同时 `available=true` 表示纯规则可用，不把 WASM 缺失变成 timing 不可用。
- legacy 对照：同一 action 流并行运行 legacy、WASM wrapper、fallback wrapper；34 个 snapshots 覆盖 fractional tick、错序、重复 invalidation、invalid/valid laps、restart、finish 后输入和非法调用。sector/lap/run outcome 逐字段一致。
- 隔离：wrapper 不知道 track/car identity、invalid reason、PB、record、storage、save、medal targets、完整 event 或 DOM；这些仍由 `RaceTimingSession` 拥有。
- 结果：wrapper test 加入 `verify`；完整回归通过，Vite 33 modules、单个 4,864-byte WASM、secret guard 114 files。
- 限制：本批只证明可注入 owner 的行为，不改 `RaceTimingSession` 或 main fixedUpdate；live 网页仍未由 Rust/WASM progress mutation 驱动。

### RaceTimingSession 开发期 live shadow

- 新约束：legacy `checkpoint-completed.snapshot` 在 sector/lap commit 前生成，而 `RaceProgressSession.passCheckpoint()` 当前原子完成全部进度 mutation。直接委托会改变公开 event snapshot，即使最终 snapshot 相同；因此本批不切 owner。
- 红测试：完整 legacy/injected scenario 在实现前可运行，但 `progressOwner` 为 `undefined`，稳定失败；这证明构造参数尚未被使用。
- 可选注入：`RaceTimingSession` 接受 `progressCore`，创建 shadow session；默认构造仍是 `progressOwner=legacy`。每个 reset/start/advance/invalidate 后比较 11-field progress，checkpoint 完成后比较 compact outcome 与最终 progress；差异立即抛错。
- API 守恒：shadow 不参与 legacy event 构造、record mutation 或 store.save。测试并行跑 legacy、Rust/WASM shadow、JS fallback shadow，35 个完整 action results、所有 event snapshots、summary、record 和 3 次 save 时机逐值相同。
- main：只在 `import.meta.env.DEV` 注入已加载 race-progress capability；production 不做 120 Hz 双运行/JSON 比较。shared capability metadata 仍在两种构建发布。
- 结果：9 timing tests、6-car medal tests、shadow test 和完整 `pnpm verify` 通过；Vite 34 modules、单个 4,864-byte WASM，secret guard 115 files。
- 限制：这是开发期运行断言，不是 production owner；没有新的实际浏览器循环证据，Browser URL policy 受阻仍成立。

### checkpoint staged progress transaction

- 红测试：staged oracle 首先失败于 `RaceProgressSession.prepareCheckpoint is not a function`，证明原子 wrapper 不能表达 legacy 中间 event 状态。
- 协议：accepted checkpoint 后创建 pending transaction；依次 `commitSector → commitLap → commitRun → finishCheckpoint`。pending 期间禁止 advance/invalidate/另一 checkpoint，阶段重复或乱序明确抛错；现有 `passCheckpoint()` 内部完整执行四阶段，保持 atomic API 兼容。
- 第一处已知时序：prepare 后只增加 checkpoint，sector/lap/run 未提交，能对应 `checkpoint-completed.snapshot`；sector/lap/run 各自 commit 后分别对应 legacy event snapshot。
- 新发现：wrapper 原以 checkpoint 数推导 current lap，因此 finish checkpoint 的 pre-lap snapshot 过早显示下一圈；新增 `completedLaps`，只在 lap commit 增加，匹配 legacy `laps.length + 1`。
- 双路径证据：WASM 与 JS fallback 在 46 个 intermediate snapshots 上一致，覆盖 wrong checkpoint、invalid first lap、两圈 finish、sector 不是每 checkpoint 的配置和 final run。原子 wrapper 34 snapshots、live shadow 35 actions 保持通过。
- ABI/成本：staging 完全位于 JS adapter，复用现有 flags/round exports；Rust ABI、WASM 4,864 bytes 和每次 checkpoint 的跨边界调用数未增加。120 Hz advance 仍只有单 rule call。
- 结果：staged test 进入 `verify`，完整回归通过；Vite 34 modules、24 build files、secret guard 116 files。
- 限制：事务 owner 仍未注入 legacy mutation；本批只消除了已知 event snapshot 时序阻碍，没有证明 record adapter 可完全单写。

### authoritative RaceTimingSession progress owner

- 红测试：35-action fixture 加入 `progressMode=owner` 后，未实现版本仍报告 `rust-wasm-shadow`，与预期 `rust-wasm-owner` 不符并退出 1。
- 三模式：无 core 保持 `legacy`；注入 core 默认仍可 `shadow`；显式 `owner` 后 start/advance/invalidate/checkpoint/snapshot 只读写 `RaceProgressSession` 的纯进度。构造时非法 mode 拒绝。
- staged adapter：owner checkpoint 使用 prepare snapshot 构造 checkpoint event，sector/lap/run commit 后分别构造对应 event；JS 只更新 current sector time list、invalid reasons、laps、PB record、summary 和 store.save。
- 单写证据：完整 scenario 后 owner 实例的 legacy `status/runTimeExact/lapStart/sectorStart/checkpoints/currentSector/currentLapValid` 仍为 reset 值；不是先写 legacy 再覆盖 snapshot。
- 完整等价：legacy、WASM shadow、fallback shadow、WASM owner、fallback owner 的 35 action results、events、snapshots、summary、record 和 3 次 save 全相同。
- sparse sector：额外 1-lap `[2,3]` sector fixture 证明 checkpoint 1 accepted 但无 sector event，owner 与 legacy 完整 action/summary/record 相同；更接近龙湾 `[3,6,10]` 形状。
- main policy：DEV session 使用 `progressMode=owner` 并发布 `data-race-timing-progress-owner`；production build 因 `import.meta.env.DEV` 保持 legacy，以免在实际浏览器六车循环仍受 policy 阻止时过早扩张运行风险。
- 结果：targeted 与完整 `pnpm verify` 通过；WASM 4,864 bytes、Vite 34 modules、build 24 files、secret guard 116 files。
- 限制：自动/构建证据充分但还没有新的实际浏览器 lifecycle soak；production 未切换，不能记录为全部网页环境已由 Rust timing 驱动。

### timing lifecycle 固定 seed soak

- 生成器：4 seeds `0x71c30001..4`，每个 12 次目标完赛；固定加入 3 次中途 restart、valid/invalid runs、错序 checkpoint、重复/第二原因 invalidation、fractional advance 和 finish 后噪声。不是重复同一 action list。
- 三 owner：每个 action 后比较 legacy、Rust/WASM owner、JS fallback owner 的返回值、完整 snapshot、record、summary 和 storage write count；差异消息包含 seed/action index/type/owner。
- 首轮：共 1,320 actions、48 completed runs；每 seed 15 run-started、81 accepted checkpoints、17–24 rejected、54 sectors、27 laps、12 completed、5 invalidated events；8 valid/4 invalid runs，22 writes。
- baseline：`data/timing-lifecycle-baseline.json` 登记每 seed action/result SHA-256、event counts、runs/writes、best lap/race；候选登记后新 Node 进程复跑匹配，不在同一进程自我批准。
- 信息量：seed 间 action count 为 316–343，best lap 为 1,656–2,356 ms、best race 为 4,110–6,960 ms；restart 后可再次产生 invalid event，解释 4 invalid runs 对应 5 invalidation events。
- 结果：soak 加入 `verify`；完整回归通过，WASM 4,864 bytes、Vite 34 modules、secret guard 118 files。
- 限制：这是 session lifecycle，不含 DOM/track/visibility/audio；不能替代此前受 Browser URL policy 阻止的实际六车浏览器循环。

### 网页 Rust/WASM scheduler owner

- 来源：本仓库已提交 `streetrush-core` raw WASM ABI 和 JS fixed-step oracle；本批没有再复制外部代码。
- 生成边界：`scripts/build-core-wasm.mjs` 用锁文件构建 release `wasm32-unknown-unknown`，复制到忽略的 `src/generated/`；scheduler-only 为 2,533 bytes，加入 replay ABI 后为 3,658 bytes，加入 timing ABI 后当前为 4,864 bytes 并由 Vite 输出独立 hashed WASM；生成物不提交。
- owner 接口：JS 与 Rust/WASM 都提供状态化 `advance()`/`reset()`、owner 名称、fallback 原因和同形 `{ steps, remainderSeconds, alpha }`；主循环不再拥有第二份 accumulator。
- 握手与回退：加载时核对 fixed dt、最大 frame dt、最大 steps 和五个必需导出；fetch、1.5 秒 timeout、instantiate、缺导出或契约不符均返回结构化原因的 JS owner，不让启动收到 rejected promise。
- 初始化时序：WASM 加载与 Rapier/车辆/场景加载并行，在第一次 `requestAnimationFrame` 前固定 owner；`html[data-physics-scheduler-owner]` 和可选 fallback code 提供运行时观测。
- 自动测试：真实 release WASM 逐帧对照 JS；注入 fetch、timeout、compile、missing export、contract mismatch 后，fallback owner 仍逐帧等价。
- 浏览器验证：真实路径报告 `rust-wasm`、无 fallback/console error；开始比赛后 HUD 可见、菜单隐藏、计时推进。开发期 missing-WASM 注入报告 `javascript`/`wasm-instantiate-failed` 并完成启动；Vite 对未知路径返回 HTML，故该实测分类是 instantiate 而非 404 fetch。
- 结果：完整 `pnpm verify`、Rust fmt/native+WASM Clippy、Rust 单测均通过；构建模块数由 29 增至 30，保留既有大 chunk warning。

### AudioContext 单飞恢复

- 来源参考：NAS 未跟踪 `scripts/test-audio.mjs` 的 gesture/init/recovery 部分，以及 HEAD `5fdea84` 之上的未提交 `src/audio.js`；fake WebAudio 被裁剪为本仓库 `scripts/audio-test-harness.mjs`。
- 原始问题：clean `init()` 在已有 context 时直接再次 `resume()`；并发 init 对同一 context 发出两次请求，resume rejection 会拒绝 init，系统 statechange 挂起后也没有受控恢复。
- 失败证据：并发 init 测试在 clean 实现稳定得到 `resumeCalls=2`，期望 1。
- 实际变化：加入单飞 `resumeContext()`、suspended/interrupted statechange 监听、500 ms 失败重试节流与 rejection 吞吐；update 只在 context 已存在时尝试恢复，仍保持用户手势创建 context 的门槛。
- 保持不变：恢复不重建/重启节点图，不改变 enabled 开关或 mute gain；pause gate、暂停时 telemetry 冻结和 main lifecycle wiring 留到下一批。
- 结果：gesture gate、并发 init、初次拒绝、系统挂起、重复 update、节流重试、mute/node identity 断言通过；完整 `pnpm verify`、六车物理和真实 Rust/WASM owner 测试通过。

### 音频 pause gate 与主循环接线

- 来源参考：NAS 未跟踪 `scripts/test-audio.mjs` 的 pause 部分，以及未提交 `src/audio.js`/`src/main.js` 中的 `setPaused()` 接线；没有吸收倒计时消息或其他 main 大 diff。
- 原始问题：clean 主循环在 pause/modal 分支仍调用 `audio.update()`，使 engine/road/wind/tire 参数继续跟随冻结后的 telemetry，也没有阻止换挡 tone/noise transient。
- 失败证据：独立 owner 测试首先在 `audio.setPaused is not a function` 失败；这证明 baseline 没有 pause 所有权，而不是 fake graph 的数值差异。
- 实际变化：compressor 与 destination 之间加入 60 ms 平滑 pause gate；paused 时 update/tone/noise 全部短路，恢复时重置 previous gear/reverse 观察点；重复 pause/resume 不重复调度 gain。
- main 接线：start/garage/resume/active 打开 gate，paused 或受阻 modal 关闭 gate并跳过 `audio.update()`；根元素 `data-audio-paused` 作为只读运行时观测。
- 自动结果：暂停前后 AudioParam target 数、临时 oscillator/buffer source 数、gate gain/time constant、幂等和恢复首帧无 stale shift transient 均通过；context recovery 测试保持通过。
- 浏览器结果：真实流程“开始比赛 → 比赛菜单 → 继续比赛”依次得到 `false → true → false`，scheduler 同时保持 `rust-wasm`，无 console warning/error。
- 回归：完整 `pnpm verify`、六车物理、真实 WASM owner、构建和资产检查全部通过。

### 音频 bank 选择与异步发布契约

- 来源：`E:\Codex\autonomous_runs\multi_car_audio\runtime\vehicle-audio-runtime.js`；来源目录不是独立仓库，外层 `E:\Codex` 是无提交的 `master`，该目录整体 untracked。采用时原文件 29,559 bytes，SHA-256 `C60A8CC740913ACFD04D1BE3E976428AA1C0C5B6417829D896277F1818621B2A`。
- 依赖边界：7/7 Node 场景还直接读取 23,628-byte 测试、21,960-byte profiles、7,575-byte bank manifest 及真实 WAV。当前没有复制这些数据、schema、vendor、candidate WAV 或 3.14 GB 隔离树；它们保持候选/证据。
- 失败证据：先加入 success、missing、retry、快速切车、不可取消 decode 晚到和 dispose 契约；实现前测试稳定以 `ERR_MODULE_NOT_FOUND` 退出 1。
- 实际变化：`src/audio-bank-coordinator.js` 提炼 candidate approval、exact/family/procedural 选择，以及 `requestId + AbortController + post-load stale discard` 协议；loader 返回值可带 `dispose()`，过期发布和切换后的 active bank 都会释放。
- 保守边界：协调器不创建 AudioContext、不创建/播放 sample node，也未替换 `ProceduralAudio`。没有显式采用详细 profile 时，现有六车兼容配置全部保持 procedural-only，不能仅凭 `family` 猜测候选录音。
- 诚实映射：来源六车 profile 当前均没有 exact bank；其 fallback 是 family candidate 或 compatibility proxy，所以本批只证明选择和所有权协议，不声称已有六车真实声音。
- 结果：批准/拒绝、6/6 兼容回退、失败后重试、abort、decode 晚到销毁和 dispose 契约通过，并接入 `pnpm verify`。

### 严格音频 bank manifest/decode loader

- 来源参考：同一 `vehicle-audio-runtime.js` 的 URL/fetch/decode 顺序，以及两个真实 manifest：approved Mazda candidate SHA-256 `90BEC41E53072B8AC932EC4C357A5BB37571EB3B2AE9687565AB37A7EA4903D8`；V8 prototype SHA-256 `CC4FD3532EA4F29E814978875AB66958DBF4B4CD6A0D907C86E7DE3816E19994`。
- 真实差异：candidate manifest 的 bank 与 6 层各自携带 approved loop；prototype manifest 只有 family/6 层，没有 loop。新 loader 只对 `bank.candidate.*` 执行 bank + layer 双重门槛，保留显式 prototype fallback。
- 失败证据：实现前新增测试以 `ERR_MODULE_NOT_FOUND` 退出 1；测试使用 4-byte 内存占位和 fake decode，没有复制/伪造可听 WAV。
- 实际变化：`createDecodedAudioBankLoader()` 负责 assetVersion URL、manifest/WAV HTTP、JSON/层结构、candidate loop、逐层 decode、稳定 error code 与 AbortError 归一化；decode 后再次检查 signal，成功 value 提供幂等 `dispose()` 清空 buffer 引用。
- coordinator 边界：loader 只返回未发布 value；上一批 coordinator 决定是否发布。切到 procedural 时 active decoded value 会被释放，职责没有合并成第二套 AudioContext/播放图。
- 结果：success、manifest HTTP/JSON/空层、candidate quality/bank loop/layer loop、坏层、WAV HTTP、decode failure、fetch 前 abort、不可取消 decode 后 abort、prototype 与 coordinator release 均通过；候选 metadata 错误在 WAV fetch/decode 前 fail closed。

### 六车资产请求隔离与 preload 生命周期

- 来源参考：NAS dirty `src/assets.js`，读取时 26,606 bytes，SHA-256 `89D224FA0E8FCDBA87296B584E05BEB7F829845B68AD93201D371F44C01FFFFB`；其 clean HEAD blob 为 `ee8ba685a4522d5cf5db80064ef21809b2f31017`，dirty 相对 HEAD `+335/-12` 且未提交。
- 失败证据：扩展现有资产 fixture 后 3/10 失败。单车 timeout 调用共享 `LoadingManager.abort()`，使并发健康请求也以 `shared loading manager aborted` 失败；preload 没有 AbortSignal/timeout，正式加载不能取消匹配的重复 HTTP，六车 stalled preload 永久占据 scheduling slot。
- 实际变化：formal GLTF timeout 只拒绝该 request owner，不再 abort 共享 manager；preload 以 per-car token、AbortController、15 秒可配置 timeout 和 identity-safe cleanup 管理，`fetchCar(id)` 只取消同 id preload。
- 保持暂缓：未采用 NAS dirty 的 visual LRU、reference graph、late GLTF scene disposal 和纹理递归回收。六份 visual cache 是当前固定车表的有界缓存，尚无目标设备预算证据证明必须 LRU；timeout 后底层 GLTF 晚到的资源回收仍是明确候选。
- 自动结果：健康并发不受另一请求 timeout 影响；formal load 只 abort 同 id preload；六车 stalled preload 全部 abort 并释放 6/6 slots；既有 pending 复用、retry、fallback/GLTF ownership 和邻车 preload 回归保持通过，共 10/10。
- 浏览器证据边界：实际页确认 MX-5 `01 / 06 READY`、start enabled、scheduler `rust-wasm`、无 fallback；单次可见控件切换观察到 M3 `02 / 06 LOADING`。后续本地页操作被 Browser URL policy 阻止，因此没有声称完成实际六车循环；该验证保持待办。

### timeout 后 late GLTF 安全回收

- 失败证据：外层 `fetchCar()` 已 timeout 且 caches/pending 全清后，让不可取消的 loader 晚到一个独立 scene；其 texture/material/geometry dispose 计数均为 0。共享资源对照也为 0，证明当前行为安全但独立 late 资源没有显式回收。
- 实际变化：只观察 timeout 后的原始 load promise；late scene 必须未挂载、当时没有任何 pending car/visual，且其 geometry/material/texture identity 与 scene、car cache、visual cache 完全不重叠，才按 texture → material → geometry 顺序幂等释放。
- fail-safe：任一资源 identity 重叠时整棵 late scene 保留；任一 pending 请求存在也保留。没有建立 deferred queue 或猜测未来 loader 是否共享资源，因此仍可能保守残留，但不会因本批误释放健康实例。
- 结果：独立 late scene 三类资源各释放 1 次；共享 identity 三类均为 0；pending/retry、preload、fallback、GLTF clone 既有测试保持通过，资产测试 12/12、完整 `pnpm verify` 通过。

## 待分批吸收的 NAS 脏改动

来源工作区无 staged 内容；有 28 个 tracked 修改和 11 个 untracked 测试，约 `+3108/-252`。其中 4 个 public GLB、2 个纹理和 2 个 source GLB 的 dirty 状态已确认只是 Windows mode-only，blob 未变；六车结构另由当前项目 hash baseline 守护。

建议批次：

1. vehicle config、wheel anchor/collider 等更深内部污染，仅在出现明确故障证据时继续；owner scalar/body recovery 已独立整合；
2. 多车音频 shared registry/播放图与真实 bank 接线（选择、loader、context recovery 和 pause gate 已独立整合）；
3. 资产 visual cache 预算与 pending 时 late result 的 deferred reference graph（request/preload/独立 late scene 已整合）；
4. 计时并发存储、路线 HUD、布局和 renderer lifecycle；
5. source wheel branches 的车型级 manifest 与 pivot/axis 适配；static merge 的显式动态分区已整合，但尚未给 production GLB 添加 marker。

## 当前仅参考或候选

- 旧 `E:\Codex\street-rush`：采样音频和较短兼容实现；没有独立提交历史。
- 六车模型研究：production GLB 结构 baseline、M3 generated-wheel adapter、MX-5 离线 manifest 与纯 host-space pivot 接口已采用；MX-5 production 接线、source brake/caliper、其余车型 wheel/light/camera binding 仍是候选，M5/AMG source 报告不能直接按 node id 套到优化 public derivative。
- 多车音频：bank 选择/发布与严格 manifest/decode loader 已采用；权威 data/schema、shared decoded registry 和样本播放图仍是强候选，不复制 3.14 GB 隔离副本和 vendor。
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
- 推翻：NAS 的二进制 dirty status 不是内容变化；raw diff 对 8 个 asset 路径均为 `100755→100644`，HEAD/index/worktree blob 相同。文件大小本身仍不是证据，本次结论来自 blob/hash。
- 推翻：首次 baseline `verify` 的资产失败不只是“新仓库还没有 HEAD”；创建 HEAD 后仍复现，真正根因是 Windows `\\` 与 manifest `/` 的路径比较。
- 证实：clean 输入层会在没有 physics step 的 sub-fixed render frame 提前消费离散脉冲；延迟到 fixed owner 消费可以保持一次性语义。
- 证实：clean `reset()` 没有清除多个自己拥有的车辆、轮胎和 telemetry 状态；六车的遗漏字段形状一致，能用独立 reset-only 修复消除。
- 证实：调用边界的非有限值会跨 wheel/telemetry 进入 Rapier；入口规范化能让 90 个配对 case 与明确 oracle 一致，并保持正常 120 Hz 回归。
- 证实：clean audio 并发 init 会重复 resume；单飞恢复能吞吐拒绝、节流 statechange retry，同时保持节点图和静音状态。
- 证实：clean pause/modal 帧继续更新 WebAudio 参数；独立 pause gate 能冻结连续值和瞬态，浏览器实际 pause/resume 接线与 Rust scheduler 共存。
- 证实：`requestId + abort + post-load discard` 能同时覆盖可取消 fetch 和不可取消 decode；晚到结果会释放，不能覆盖新车辆 bank。
- 证实：来源六车 profile 没有 exact bank；family candidate/proxy 不能被记录为已完成的六车真实声音。
- 证实：candidate 与 prototype manifest 的 loop 契约不同；只对 candidate 双重 fail-closed 可在不破坏 prototype fallback 的前提下阻止未批准层进入 decode。
- 证实：GLTFLoader 的 LoadingManager 是共享 owner，单请求 timeout 不能用全局 abort；per-car preload token/signal 能隔离六车重复请求并有界释放 stalled slots。
- 证实：late GLTF 只有在未挂载、无 pending、与全部已知资源 identity 不重叠时才可局部安全回收；共享判断不足时应保留而不是猜测 dispose。
- 证实：六车 owner scalar/cache 污染不会靠下一步自然消失；入口局部 fallback 可与显式 oracle 一致。Rapier 的 NaN rotation setter 在本环境保持有限，不能把所有坏 setter 统一描述为 body poison。
- 证实：当前 JS/Rapier 六车在三类固定 seed 状态序列中可逐 tick exact 重现，并能跨新 Node 进程匹配登记 hash；证据范围尚不跨浏览器/平台。
- 证实：canonical Float64、JS 兼容 1e-6 quantization 与 FNV-1a 64 增量摘要可由同一 Rust 纯函数在 native/raw WASM 使用；特殊向量和现有 18 条六车 trace 均与独立 JS oracle 逐 push 一致。
- 证实：比赛进度可拆成 Rust 状态 owner/native API 与无全局状态 raw WASM rule ABI；31 个 JS/WASM action snapshot 一致。PB、持久化和 UI event 是独立 JS 边界，尚未切换。
- 证实：scheduler 与 timing 不需要两个 WASM instance；通用 lifecycle + capability-specific contract 能让 partial failure 互不误伤，同时保留旧 scheduler API。
- 证实：同一 `RaceProgressSession` 可在 Rust/WASM 与 JS fallback capability 上运行，并与 legacy 纯进度/compact outcome 一致；record/event adapter 尚未委托。
- 证实：shadow 可嵌入完整 `RaceTimingSession` 而不改变 35-action event/record/save 结果；同时证实 checkpoint event 需要 staged snapshot，不能直接用原子 outcome 机械替换。
- 证实：prepare/sector/lap/run staged transaction 可重现 46 个 legacy 中间 snapshot；current lap 必须由已提交 lap 数拥有，而不能只由 checkpoint 数推导。
- 证实：authoritative WASM/fallback progress owner 可保持完整 JS event/record/save API 且无 legacy 进度双写；开发构建已使用 owner，production 仍需运行期证据。
- 证实：4-seed/1,320-action timing lifecycle 中 legacy/WASM/fallback owner 每一步 exact 一致；短 fixture 未暴露的 restart/save/PB 顺序也保持。
- 证实：gamepad 不断连但对象身份替换会绕过 reconnect rearm；元素 blur 也不是物理 pointer terminal。身份握手和键盘/物理指针所有权拆分可消除三个独立失败，同时保留 window 级全量释放。
- 证实：六车 public 模型结构并不共享可靠命名；4 车与研究字节一致，M5/AMG 是已声明的 source-model 优化派生。当前 GLB/hash/TRS bounds 必须独立固定，不能把 source node id 机械用于 public。
- 证实：M3 已生成的四轮缺少 runtime owner；建立 FL/FR/RL/RR 两级 pivot 后，现有 steer/compression/omega 可在不改物理状态契约的前提下驱动视觉并安全 reset。
- 证实：static merge 可按显式 v1 marker 排除动态 branch，并在 canonical/clone 间保持 world transform、对象独立与共享 geometry；仅保留 branch 不足以证明 wheel pivot/axis 正确。
- 证实：MX-5 public 与研究 source 字节一致时，可从 GLB primitive/accessor 独立重算 12 组 part bounds、四个 tire vertex centroids 和 parent roll axis；accessor index 不能从 mesh 顺序推导，必须显式锁定。
- 证实：MX-5 source root-origin 组合转动会产生 8.85mm tire centroid 漂移；unit host 下的 outer-Y/nested-X manual-matrix 重组可把零姿态/centroid 误差压到实验门槛内，并保持 suspension 的米制语义。
- 推翻：Material.017 rotor 不应留在 outer-only；隔离源码 attach 整个 wheel root，且模型没有 caliper。也推翻把 Three `attach()` 当作 `<1e-9` 精确 reparent 的假设。

## 当前最值得继续的方向

1. 建立真实 MX-5 GLTFLoader scene 的 Node/可注入 loader 测试，确认 sanitizer 后四个 roots/12 meshes、POSITION geometry 和 manual matrix 路径与同构 fixture 一致；
2. 在 AssetManager 副本路径验证 bind-before-static-merge、clone/cache、缺节点原子失败与 fallback，不通过就保持候选，不接 main/VehicleSystem；
3. M5/AMG 若要独立轮组应回到只读 source model 复制后建立可重复优化 pipeline；实际六车 visual loop 与真实 gamepad wrapper 身份仍等待 Browser URL policy 允许。
