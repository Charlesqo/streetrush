# 实验与测试日志

更新日期：2026-08-13

## 首轮环境与来源核对

### 新项目初始状态

- `E:\Projects\streetrush` 初始为空且不是 Git 仓库。
- 未发现当前项目 `AGENTS.md` 或既有 Codex 项目指令文件。
- 已初始化独立 `main` 分支 Git 仓库。

### Rust/WASM 工具链

- 初始未安装 `rustc`、`cargo`、`rustup`。
- 通过官方 `Rustlang.Rustup` 安装 Rust。
- 当前：`rustc 1.97.1`、`cargo 1.97.1`、`stable-x86_64-pc-windows-msvc`。
- 已安装目标：`x86_64-pc-windows-msvc`、`wasm32-unknown-unknown`。
- 工作区内置 Node：`v24.14.0`。

### NAS 基线

- clean HEAD：`5fdea8405c1951057eeb994635e5468273a71e62`。
- 脏工作区：28 modified、11 untracked tests、无 staged。
- 来源 `node_modules` 的 pnpm link/copy 结构损坏：21 个无写入测试中 13 个通过，另外 8 个在载入时统一因 `ERR_MODULE_NOT_FOUND: three` 受阻；这 8 个没有进入断言阶段，不能登记为代码失败。
- `dist/build-provenance.json` 记录上述 HEAD，38 个输入与当前脏工作区 hash 匹配；说明该脏快照曾构建，但不证明完整 `verify` 通过。
- 新项目逐文件比较 NAS clean commit：73 个 source blob，0 个 hash mismatch。
- 新项目重新执行 `pnpm install --frozen-lockfile`；第一次因 pnpm 子进程 PATH 中没有 `node` 而停在 esbuild postinstall，补入工作区内置 Node 路径后安装通过。
- 首次 `pnpm verify`：逻辑测试、六车物理 smoke/regression、Vite build、Cloudflare 静态检查和 secret guard 通过；资产 inventory 因新仓库还没有 HEAD 而失败。
- 创建 baseline HEAD 后第二次 `pnpm verify`：相同 20 个资产错误仍复现，表现为文件系统反斜杠路径和 manifest 正斜杠路径互相“缺失”。这推翻了仅由 HEAD 导致的初步假设。
- 最小修复：把 `path.relative()` 结果的系统分隔符归一为 `/`；新增单独回归。
- 修复后：`scripts/test-asset-license-check.mjs` 通过；完整 `pnpm verify` 退出码 0。Vite 保留既有大 chunk 警告，不是失败。

### C++ 物理核心

- 运行现有 `build/msvc-debug/Debug/vpc_tests.exe`：退出码 0，报告 16 个 suite PASS。
- 发现现有二进制时间早于当前测试源码；当前 `test_main.cpp` 还包含 `shared_wheel_force_assembly`，旧二进制未报告该 suite。
- 结论：旧二进制只验证其构建时快照；当前源码需复制到新项目或隔离构建后再声称全量通过。

### 六车物理数据

- 六车 identity gate 均为 true。
- 六车 evidence/model/validation gate 均为 false。
- MX-5 有 4 个 available acceptance targets，M5 G90 有 3 个，GT3 RS 有 1 个；其余整车结果仍受 owner、曲线、表面和同步 trace 缺失限制。

### 六车模型研究

- 检查 `final_research_index.md` 与 `final_research_audit.json`：6/6 车型有 14/14 标准报告、浏览器隔离轮组验证和源 hash 匹配。
- 机器结论：`researchEvidenceComplete=true`，`canonicalRuntimeAdapterImplemented=false`。
- 第一视觉实验候选：M3 生成轮；第二候选：MX-5 原层级轮组。

### 音频

- `vehicle-audio-lab/scripts/verify-banks.mjs` 只读复测：三族共 18 个 WAV 全部非静音，退出码 0；该脚本只检查 RMS/peak，不检查 loop、生命周期或听感。
- 检查 `multi_car_audio` 的 Node 运行时结果：7/7 场景通过。
- 检查 acceptance matrix：8 completed、2 partial、2 not completed；未完成项是目标设备性能/主观听感和六车 exact banks。

### 研究续跑与 workstreams

- 研究续跑记录证明共享 decoded bank、stale/abort、音频资源预算和多项物理 14 状态/事务 owner 接口形状；所有目标设备和目标车声明仍保持 fail-closed。
- `workstreams/controls_network` 有 Windows ENet loopback 原型；`physics_numerics` CSV 显示能量残差随 120/240/480 Hz 约减半，以及 unilateral road-drop 事件时间收敛；目前均保留参考。

## 首个 Rust 实验定义

问题：NAS 已提交固定步调度能否在同一 Rust 逻辑中同时由原生程序与 WebAssembly 调用，并在 60/30/24/20/15 FPS 情形复现现有 JS contract？

可观测量：每个渲染帧率下 60 秒输入对应的物理步数、模拟秒数、剩余 accumulator；native 与 WASM 的逐 case 差异。

停止条件：

- Rust 单元测试覆盖负数、上限、过大帧差和 accumulator 上限；
- 原生探针通过 60/30/24/20 FPS 保持 60 秒、15 FPS 明确限制为 45 秒的 oracle；
- `wasm32-unknown-unknown` 构建成功；
- Node 实例化生成的 `.wasm` 并得到与原生相同的 case 结果。

## Rust 固定步共享核心结果

- `cargo test --workspace`：6 个 core 单元测试通过，0 失败。
- `cargo clippy --workspace --all-targets -- -D warnings`：通过。
- `cargo clippy -p streetrush-core --target wasm32-unknown-unknown -- -D warnings`：通过。
- `cargo run -p streetrush-native`：
  - 60/30/24/20 FPS：各 7200 physics steps，60.000000000 秒，remainder 0；
  - 15 FPS：5400 steps，45.000000000 秒，remainder 0；
  - 退出码 0。
- 首次 wasm32 build 被 `unsafe_code=deny` 拒绝 9 个 raw ABI 稳定符号属性；把 `allow(unsafe_code)` 限定在 `wasm_exports` 模块后构建通过，没有开放 unsafe block。
- `scripts/test-core-wasm.mjs`：raw WASM 成功实例化；60/30/24/20/15 FPS 的 60 秒序列及负数、0、小帧、超大帧和不规则帧序列与 JS 逐步一致，退出码 0。
- 加入 Rust workspace 后重新运行完整 `pnpm verify`：原有逻辑、六车物理、构建、静态资产、secret guard 和资产清单全部通过；Vite 仍只有既有的大 chunk 警告。
- 生成物仅存在于忽略的 `target/`：debug native executable 约 159 KiB，debug WASM 约 1.59 MiB；不提交构建产物。

结论：假设得到支持。固定步调度是一个足够小、接口清楚且能跨原生/WASM 复用的首个 Rust owner 候选；但游戏主循环仍使用 JS，下一次 owner 切换必须先验证 WASM 加载失败和初始化时序，不能只凭编译成功替换。

## 固定步输入脉冲实验结果

问题：NAS 脏工作区的 fixed-update 输入脉冲和 finite/reset 改动分别修复了哪些可独立复现的当前基线失败，是否能拆成比现有大 diff 更小的安全批次？

可观测量：一次 render frame 内多次 physics step 对 shift/toggle/reset 脉冲的消费次数；NaN/Infinity 进入车辆 update、reset 和 telemetry 后的状态；对应 NAS 测试在 clean baseline 上的失败类别。

停止条件：先复制或重写最小失败测试；按共同根因聚类；只采用能让失败测试通过且不改变无关玩法的最小代码；完整 `pnpm verify` 和 Rust/WASM 对照保持通过。

- 差异拆分：NAS `src/vehicle.js` 的 181 行差异同时包含 finite guard、reset 清理、fallback texture 释放和 destroy 幂等，暂缓整批采用；输入脉冲可独立切出。
- 最小失败测试：键盘 `KeyE`、触屏 reset、手柄 reset 均先经历两个 `0.4 * FIXED_DT` render frames，再由第三帧形成 physics step。
- clean baseline 结果：退出码 1；首个失败为第二个键盘 sub-fixed frame，期望 `true`、实际 `false`，证明脉冲在无 physics step 时已被消费。
- 修复后：三类来源均在前两帧和 physics frame 保持 `true`；`consumeFixedPulses()` 后立即为 `false`，再一次 defer update 仍为 `false`。
- 回归：`pnpm test:input`、完整 `pnpm verify`、`cargo test --workspace` 和 `scripts/test-core-wasm.mjs` 均退出码 0；六车 physics smoke/regression 保持通过。

结论：fixed-update 输入脉冲是有直接失败证据的独立根因，已用小于 NAS 原 diff 的范围整合。finite/reset 尚未得到同等粒度的失败分类，不能和本批混合。

## 六车 reset-only 实验结果

问题：clean vehicle reset 究竟遗漏了哪些运行状态；只补 reset 完整性是否足以消除污染，还是必须同时加入 update-time finite guard？

可观测量：六车 reset 后的传动、转向、引擎负载、轮胎接触、telemetry 数值和标志；分别记录 assertion failure 与异常，而不是把所有失败归为“非有限值”。

停止条件：先写不依赖 NAS 新增内部字段的 reset-only 测试并在 clean code 上失败；若修复后六车现有物理回归保持通过，再独立设计 NaN/Infinity 输入测试，避免把资源释放改动混入车辆状态批次。

- 测试来源与变化：参考 NAS 未跟踪 `scripts/test-vehicle-finite.mjs`，重写为只使用 clean baseline 已存在字段的 `scripts/test-vehicle-reset.mjs`；所有污染值均为有限值。
- clean 结果：退出码 1；`mx5,m3e30,gt3rs,lp700,amggt3,m5g90` 六车失败形状一致。
- 已经正确清理：刚体线/角速度、wheel omega、gear/reverse、reverse hold、shift timer、engine RPM、纵向速度历史、平滑加速度、stuck timer。
- 证实遗漏：steer angle、engine load、四轮接触/悬挂缓存，以及 vehicle/wheel telemetry 的数值、surface、ABS/TCS/stability 标志与 contact point。
- 最小修复后：`pnpm test:vehicle-reset` 为 6/6 PASS；该测试已加入 `pnpm verify`。
- 回归：完整 `pnpm verify`、既有六车 smoke/regression、`cargo test --workspace` 和 `scripts/test-core-wasm.mjs` 均退出码 0。

结论：reset 完整性是独立于 finite guard 的真实缺陷；只补现有 owner 状态即可修复，没有理由在本批扩大到无效数值恢复或资源生命周期。

## 六车 invalid input/dt 实验结果

问题：无效 `input`/`dt` 和已污染车辆标量分别如何扩散为非有限刚体或 telemetry，最小边界清理应放在 JS vehicle owner 还是未来 Rust 接口前？

可观测量：六车对 `null` input、NaN/±Infinity 控制量、NaN/±Infinity/0/极大 `dt` 的异常类型和首个非有限字段；将“拒绝/替换调用参数”与“恢复已污染内部状态”分开统计。

停止条件：先建立只覆盖调用参数的最小失败矩阵；若同一 sanitize 规则能让六车通过且不改变正常 120 Hz 结果，再考虑内部状态 poison 和刚体恢复，不能一次加入所有 NAS guard。

- 第一版 finite-only 矩阵：6/6 车型失败；`null` 抛出 `TypeError`，其余失败扩散到 wheel omega、engine/steer 标量、telemetry，并在 world step 后污染刚体位置、旋转和速度。
- 仅检查 `Number.isFinite` 不足：给有效油门/转向建立配对 oracle 后，`Number.MIN_VALUE`/`Number.MAX_VALUE` 也产生与 `0.25 * FIXED_DT`/50 ms 规范值不同的输出。
- 最终矩阵：缺失/非有限输入、有限越界控制量、truthy 非布尔脉冲、NaN/±Infinity/0/最小正数/最大 `dt`，共 15 类；每类在新车辆上与相同初始状态的规范参数执行结果对照。
- clean 失败：配对版本覆盖 6/6 车型，失败阶段包括 `fixedUpdate`、`worldStep` 和 `sanitizedOracle`。
- 最小修复：入口 sanitize 数值、严格布尔字段并规范 `dt`；没有改变算法主体，没有加入内部 poison recovery。
- 修复后：15 × 6 = 90 个 case 通过；测试加入 `pnpm verify`。完整回归保持六车既有 120 Hz 指标，Rust 单测与 JS/WASM 对照也通过。

结论：防毒应先放在当前 JS vehicle owner 的公开调用边界；这既保护现有网页，也定义了未来 Rust FFI 输入契约。内部状态与刚体 recovery 是另一个故障模型，保持候选而非本批范围。

## 网页 Rust/WASM scheduler owner 实验结果

问题：网页能否在不阻塞现有启动的前提下选择 Rust/WASM scheduler owner，并在 WASM 缺失、编译/实例化失败或导出不完整时确定性回退到 JS？

可观测量：owner 标识、初始化完成时点、常量握手、逐帧 step/remainder、每一种失败注入后的 fallback 原因，以及主循环开始前 owner 是否已经固定。

停止条件：先实现可注入 loader 和 JS fallback 的独立测试；成功路径必须实例化真实 Rust `.wasm`，失败路径不得发出未处理 rejection；只有双路径对照通过后才修改 `main.js` owner。

- loader：JS/WASM 同形状态化接口；exact 常量握手、必需导出检查、invalid plan 防护、1.5 秒初始化超时和结构化 fallback reason。
- 可复现生成：package scripts 调用 `scripts/build-core-wasm.mjs`；从干净源码构建 release WASM 到忽略目录，当批 scheduler-only 产物为 2,533 bytes。
- Node 成功路径：真实 Rust WASM 在不规则帧序列上与 JS 的 steps/remainder/alpha 逐帧一致。
- Node 失败路径：404 fetch、永不完成的 instantiate、`CompileError`、空 exports、fixed-dt 契约不匹配都得到 JS owner；各 fallback 在独立帧序列继续与 JS oracle 一致。
- main owner 切换：删除主循环 accumulator/step-budget 所有权；比赛、暂停、模态和返回车库都 reset scheduler owner；owner 在场景加载期间并行初始化、首帧前固定。
- 构建：Vite 处理 30 个模块；2,533-byte WASM 小于默认 4 KiB inline 门槛，被编码进 main bundle；不产生需提交的独立二进制。
- 实际浏览器成功路径：`data-physics-scheduler-owner=rust-wasm`、无 fallback、无新增 warning/error；点击开始后 `race-active`，HUD 可见、菜单隐藏、比赛计时推进到 `00:00.858`。
- 实际浏览器失败注入：missing-WASM 得到 `javascript` + `wasm-instantiate-failed` 并完成加载。Vite dev server 对未知路径回 SPA HTML，因此不是 HTTP 404；该差异已记录而未伪装为 fetch failure。
- 完整回归：`pnpm verify`、Rust fmt check、native/WASM Clippy `-D warnings` 和 6 个 Rust 单测全部通过；仍只有既有 Vite 大 chunk warning。

结论：同一 Rust 调度核心已成为真实网页主循环 owner，同时原生探针仍使用同一 crate；失败回退、启动时序和运行时可观测性都有自动与浏览器证据。Rust 不再只是编译空壳。

## AudioContext 单飞恢复实验结果

问题：NAS 音频 pause/resume/recovery 脏改动中，哪些现有 baseline 生命周期会导致 AudioContext、oscillator 或 gain owner 泄漏、错误恢复或状态不同步？

可观测量：init/start/stop/pause/resume 的调用序列，visibility/pagehide 后 context 状态，重复 resume、初始化失败和车辆切换后的活跃节点/连接数；将 WebAudio 模拟测试与浏览器限制分开记录。

停止条件：先从 NAS `scripts/test-audio.mjs` 和 `src/audio.js` 拆出最小失败序列；只采用能用 owner 状态断言证明的变化，完整网页、六车、Rust/WASM 回归必须继续通过。

- 拆分：把 context init/recovery 与 pause gate 分开；本批测试不要求 `setPaused()`，避免一次吸收 NAS 87 行 audio diff。
- clean 失败：两个并发 `init()` 创建 1 个 context、1 套节点，但发出 2 次 `resume()`；首个断言退出码 1，实际 2、期望 1。
- 追加边界：初次 resume rejection 不得拒绝 init；statechange 挂起与连续 update 只能共享一次恢复；失败 500 ms 内不重试，之后可重试；mute gain、enabled 和节点对象保持不变。
- 最小实现：`resumeContext(force)` 只为 suspended/interrupted context 工作，使用 promise 单飞并将同步/异步 resume 失败转换为 `false`；context 创建仍只发生在 `init()` 用户手势路径。
- 修复后：针对性测试退出码 0，并进入 `pnpm verify`；完整逻辑、六车物理、真实 Rust/WASM owner、构建和资产检查全部通过。

结论：AudioContext recovery 是独立且有失败证据的 owner 问题；不需要重建 oscillator graph，也不应借恢复改变用户 mute 意图。pause gate 尚未验证，继续保持候选。

## 音频 pause gate 实验结果

问题：比赛 pause/modal/visibility 路径是否继续让 engine/road/wind/tire 参数追随冻结后的 stale telemetry，并可能在恢复时错误触发换挡瞬态？

可观测量：pause gate gain，暂停前后各 AudioParam target 数量，tone/noise 临时 source 数，previous gear/reverse，重复 pause/resume 幂等，以及 main 的 paused/modal/active 三种路径。

停止条件：先在 audio owner 层复现 stale telemetry 更新；只在 owner 通过后接 main lifecycle，避免把倒计时消息、renderer 或其他 NAS main diff 带入。

- owner clean 失败：首次调用 `setPaused(true)` 抛 `TypeError`；baseline 完全没有 pause owner。
- fake graph 扩展：记录 AudioParam cancel、创建的 oscillator 和 buffer source；它只服务测试，不改变产品代码。
- 最小实现：单独 pause gain 位于 compressor 后；pause/resume 使用 `setTargetAtTime` 和 0.06 秒时间常量；paused update、tone、noise 和 transient 全部不执行。
- stale 防护：恢复时 previous gear 置空、reverse 归 false；第一次恢复 telemetry 不生成暂停期间积累的假换挡声音。
- main 接线：显式 helper 同步 audio owner 和 `data-audio-paused`；paused/受阻 modal 分支不再调用 update，active 分支重新打开 gate。
- 实际浏览器：开始比赛 `false`，打开比赛菜单 `true`，继续比赛 `false`；同时 `data-physics-scheduler-owner=rust-wasm`，console 0 warning/error。
- 回归：`pnpm test:audio-context`、`pnpm test:audio-pause` 和完整 `pnpm verify` 均通过；六车物理、Rust/WASM 和资产门禁保持绿色。

结论：pause 是音频参数与瞬态的 owner 边界，不等同于 context suspend；用独立 gain gate 可保留已有节点图并避免恢复爆音/假换挡。NAS main 的其他 400 行改动仍未混入。

## 音频 bank 协调器实验结果

问题：`multi_car_audio` 的权威 runtime/data/schema 能否裁剪成与现有 `ProceduralAudio` 并存的最小 bank adapter，并对缺 bank、加载失败和切车 stale 给出确定性 fallback？

可观测量：bank eligibility、profile/vehicle 映射、promise owner、abort signal、单调 request id、晚到 value 的 dispose、active/pending bank id、fallback reason；exact 六车 bank 缺失必须显式报告。

停止条件：只追踪 7/7 Node 场景的直接依赖；只采用接口和内存 fixture；一车 success、缺失回退、失败重试、可取消 fetch 和不可取消 decode 晚到均通过前，不接可听链路。

- 来源定位：Node 入口是 `tools/test-runtime-contract.mjs`，直接导入 29,559-byte runtime、3,660-byte Street Rush adapter 和 1,964-byte routing invariants；它另读两份约 29 KiB 数据及所有真实 bank WAV。
- 原始状态：来源目录由无提交外层仓库覆盖且整体 untracked；主 runtime SHA-256 为 `C60A8CC740913ACFD04D1BE3E976428AA1C0C5B6417829D896277F1818621B2A`。profiles、manifest、源测试哈希分别为 `52A7B6323FB279936B5F4EF4197BBFCD4EFF2717187F42069522E2A3F19114C2`、`CC3798FA6B81B7CA44AFC2B8065AFA382603D359EC7A299153E11C7FE9CDBCB7`、`B5A7C3DA05B559E6A26A94C6ACC417C53F9D59CC27A7135DDD61E2BB5D6203B5`。
- 失败优先：契约测试先加入，首次运行因 `src/audio-bank-coordinator.js` 不存在而以 `ERR_MODULE_NOT_FOUND` 失败。
- 最小采用：复制并收窄纯选择规则；新协调器只接收注入的 `loadBank()`，不拥有 WebAudio 图。每次 setProfile 先 abort pending、释放 active，再以 request id 决定是否发布；不可取消的晚到 value 也调用 `dispose()`。
- fixture 结果：批准 candidate 可选、未批准 candidate 被拒；现有 6/6 配置在无详细 profile 时走 procedural；HTTP-like 首次失败降级、第二次重试 ready；slow I4 被 fast V8 替换后 signal 已 aborted，晚到 I4 被销毁，最终 active 保持 V8；dispose 中止 pending。
- 数据判断：六份权威 profile 都没有 exact bank，使用 family candidate/proxy；因此 data/schema 仍为候选，WAV 未复制，本批不改变实际可听输出。

结论：最小发布协议值得采用，并已形成独立可回退边界；完整 runtime 的 AudioContext/node graph 暂时没有足够证据替换已工作的 procedural owner。

## 严格音频 bank loader 实验结果

问题：在不复制真实大 WAV 的条件下，能否为协调器加入严格的小型 manifest/layer loader，提前固定 HTTP、JSON、loop approval、decode 后释放和错误分类契约？

可观测量：manifest/WAV fetch 次数与顺序、assetVersion URL、AbortSignal、层数、candidate bank/layer 双重 loop gate、decode 完成后的 value dispose、错误 code；保持当前 procedural 可听 owner 不变。

停止条件：使用内存 bytes 与 fake decode；缺层、坏 JSON/HTTP、bank 或任一 layer 未批准必须 fail closed；prototype 不因缺 candidate-only loop 元数据被误拒；成功/失败/abort/release 通过总回归后提交。

- 真实抽查：Mazda BP-ZE candidate manifest 为 schema v2、6 层、bank/layer 全部 loop-approved，SHA-256 `90BEC41E53072B8AC932EC4C357A5BB37571EB3B2AE9687565AB37A7EA4903D8`；基础 V8 prototype 为 6 层且没有 loop，SHA-256 `CC4FD3532EA4F29E814978875AB66958DBF4B4CD6A0D907C86E7DE3816E19994`。
- 失败优先：`scripts/test-audio-bank-loader.mjs` 在实现加入前因缺少模块以 `ERR_MODULE_NOT_FOUND` 退出 1。
- fixture：成功路径只使用 4-byte 内存值，检查 manifest → WAV 顺序、`assetVersion=fixture-v1`、同一 signal、一次 decode 和 dispose 幂等；没有把占位 bytes 描述成音频质量证据。
- 失败聚类：manifest HTTP/JSON/空层；candidate quality/bank loop/layer loop；层字段/WAV HTTP/decode；fetch 前 abort 与 decode 已开始后的 abort。每类都有稳定 code，candidate metadata 错误只产生一次 manifest fetch、零 decode。
- prototype 对照：没有 loop 的 source V8 fixture 成功，证明 candidate gate 没有扩成所有 bank 的错误硬要求。
- 组合结果：真实 coordinator 发布 loader value 后切到无 bank profile，active value 被 dispose 且 layer 引用清空；loader 不自行决定发布。

结论：manifest/decode 边界已能 fail closed 并在 stale 后释放引用；但没有真实 WAV、共享缓存、source node 或目标设备证据，所以仍不接管可听输出。

## 六车资产请求生命周期实验结果

问题：当前 AssetManager 在六车快速切换、并发 preload、失败重试与车库重入下，是否存在 stale visual 发布、缓存长期持有或 shared GLTF 被错误释放？

可观测量：fetch/prepare promise owner、request-level abort、preload token/timeout、fallback 与 GLTF visual 所有权、六车 stalled slot；将 bounded cache、late loader result 与已证明泄漏分开。

停止条件：先扩展 `scripts/test-assets.mjs` 的内存 fixture；只修复有具体失败证据的请求隔离，不复制 NAS dirty 的整套资源图；自动回归后尝试实际六车页面循环并诚实记录受阻范围。

- 来源复核：NAS dirty `assets.js` 相对 HEAD `+335/-12`，包含 shared abort 修正、preload token/timeout、visual LRU、late result 与 reference-aware disposal；dirty SHA-256 `89D224FA0E8FCDBA87296B584E05BEB7F829845B68AD93201D371F44C01FFFFB`。
- clean 失败 1：一辆 10 ms timeout 调用 shared LoadingManager abort，另一辆 1 s 健康请求同时收到 `shared loading manager aborted`。
- clean 失败 2：preload fetch 没有 signal；同 id formal load 与邻车 preload 重复，不能取消只属于该车的 HTTP。
- clean 失败 3：六车各调度一轮 stalled preload 后，6 个 signal 都不存在，`preloadScheduled` 永久为 6。
- 最小修复：移除 formal load 的全局 abort；加入 per-id scheduled token/request owner、AbortController、timeout、identity-safe cleanup 和 `fetchCar()` 的同 id cancel。没有加入缓存回收/纹理遍历。
- 修复结果：10/10 asset tests 通过；六车 stalled signals 全部 aborted，scheduled/request maps 清空；timeout 后健康 GLTF 成功，失败车型可重试；既有 fallback 只释放自有资源、shared GLTF 不释放。
- 有界缓存判断：当前车表固定 6 辆，visual cache 上界也是 6；没有内存预算或重复动态车型证据支持立刻引入 LRU。该判断不是证明长期资源成本足够，只是拒绝无证据扩展本批。
- 实际浏览器：初始 MX-5 为 `READY`、`01 / 06`、start enabled、`rust-wasm`、无 fallback；可见“下一辆车”控件触发 M3 `02 / 06 LOADING`。后续 reload/控件操作被 Browser URL policy 拒绝，无法完成六车 READY 循环；因此只保留部分证据，不计为 6/6 浏览器通过。
- 完整回归：`pnpm verify` 通过；资产测试由 8 增为 10，六车物理、audio、Rust/WASM、build、secret 与 license inventory 均保持绿色。

结论：共享 abort 与无界 stalled preload 是两个已修复的 request-owner 缺陷；late GLTF result 和资源图回收仍需独立失败实验，不能把 NAS 大 diff 整批当答案。

## late GLTF 安全回收实验结果

问题：GLTFLoader 在外层 request 已 timeout 后晚到的 scene 是否仍被静默保留；不引入完整 reference graph 时，能否只回收“从未进入 cache、prepare 或 scene”的 late template？

可观测量：timeout owner settle 时点、late scene identity、car/visual/pending caches、scene parent、geometry/material/texture dispose 次数、与健康 cache/scene 的资源 identity 重叠。

停止条件：先用完全独立资源的 late scene 复现；共享任一资源必须零释放；只实现无需 deferred ownership 推断的即时安全路径，完整回归后提交。

- clean 失败：timeout request 已从 pending/car/visual cache 消失后，独立 late scene 的 geometry/material/texture dispose 均为 0；测试退出 1。
- 对照：另一个 late scene 与已知 visual 共用同一 geometry/material/texture，clean 的三类 dispose 也为 0，作为不得误释放的 guard。
- 最小实现：raw load promise 只在 outer timeout 后观察 scene；收集 mesh geometry、material 及嵌套 texture identity，与当前 scene、car cache、visual cache 合并集合比较；使用 WeakSet 保证 dispose 幂等。
- 通过：独立 late scene 得到 `{geometry:1, material:1, texture:1}`；共享对照保持全 0；scene 未挂载且未进入 cache。
- 保守条件：任何 pending car/visual 都直接保留，资源任一重叠也整棵保留。本批没有队列化到 pending 结束后再判断，因此把“可能残留”显式留作未来 reference graph 需求，而不是扩大释放。
- 回归：12/12 assets、完整 `pnpm verify` 通过；build 30 modules，main bundle 约 452.27 KiB，仍只有既有 >500 KiB chunk warning。

结论：可证明独立的 late result 已有安全回收路径；无法证明独立的结果仍 fail-safe，不把内存优化置于共享资源正确性之上。

## 六车内部数值污染恢复实验结果

问题：公开调用边界已能阻止坏 input/dt，但若车辆内部标量、wheel cache 或 Rapier body 已经变成 NaN/Infinity，下一帧能否确定性恢复，还是必须 reset/rebuild？

可观测量：首次污染字段、fixedUpdate/world.step 后扩散路径、reset 前后 body pose/velocity、owner scalar/wheel/telemetry 有限性；使用 paired rig 比较局部 fallback、reset 和 Rapier setter-normalized 三条路径。

停止条件：只参考 NAS finite 测试的内部污染部分；每个污染 rig 必须与显式 oracle 从同一确定性状态逐字段一致；不混入外部 input/dt 或未测试 config/collider；健康六车回归不能改变。

- 来源：NAS 未跟踪 `scripts/test-vehicle-finite.mjs`，8,853 bytes，SHA-256 `11774364003300A3AAE79DEC422A9FD4F0AA762EA47D2FBF3D2582047B69A163`。其 reset 与 invalid caller 部分已由本仓库两个更小测试覆盖。
- 初版误差：最初统一假设 4 种坏 body setter 都需 reset，得到 48/54 失败；检查发现 `setRotation(NaN)` 在 Rapier 中没有留下非有限 rotation，强制 reset oracle 本身错误。
- 校正基线：setter 后实际读取 body 决定 oracle。5 个 scalar/cache 簇 × 6 车为 30/30 失败；translation、linvel、angvel 3 类 × 6 为 18/18 失败；rotation 6/6 由 Rapier 保持有限并正常推进。总计 48/54 真实失败。
- telemetry 设计：车辆移到 20 m 高、无地面接触，避免 contactPoint 被下一次 ray hit 偶然覆盖；由此 6/6 证明悬空 cache 不自愈。
- 最小实现：owner scalars/timers/history/gear/reverse/wheel omega 在使用前恢复；contactPoint 只在非有限时清零；body pose/velocity 非有限或 body velocity squared overflow 时 reset+return；输出 telemetry 非有限也 reset+return。
- 修复结果：`scalar=30 body=24 rapier-normalized=6 total=54`；污染路径与各自显式 oracle 逐字段容差 `1e-9 * max(1, |expected|)` 一致。
- 健康回归：既有 15 × 6 = 90 外部边界、六车 smoke/regression 指标、完整 `pnpm verify`、Rust/WASM、audio、assets、build 与门禁均通过。

结论：owner scalar/cache 可局部恢复，真正非有限 Rapier pose/velocity 可用现有 reset API 恢复，不需要立即 rebuild；Rapier 已拒绝的坏 rotation 不应触发无证据 reset。更深 config/collider 污染仍未覆盖。

## 固定 seed 六车确定性实验结果

问题：相同固定输入、同一车辆和相同状态事件序列重复运行时，JS/Rapier 车辆状态能否逐 tick 重现；reset、前进/倒车切换和换挡脉冲中哪个最早引入分歧？

可观测量：六车每 tick 的 50-field body/driveline/wheel/telemetry snapshot；9-field input trace hash；exact/1e-6 state hash；首个分歧 tick/field；reset sample 序列。

停止条件：3 类不同 trace 每车同进程重复 3 次逐值 exact；登记 baseline 后新 Node 进程再匹配；输入与状态 hash 分开；不得把同环境结果扩写为跨平台确定性。

- owner 顺序：runner 复制 `main.fixedUpdate` 的 manual reset 顺序；reset 后同一 tick 仍执行物理。toggle/shift/direction pulses 只持续一 tick。
- traces：seeded steady 720 ticks；manual shift + forward/brake/reverse 960 ticks；在 tick 300/600 reset 的 seeded replay 900 ticks。seed 为 `0x5eed0001`、`02`、`03`。
- canonical frame：50 个值以 big-endian IEEE-754 Float64 顺序进入 SHA-256；quantized 路径先四舍五入到 1e-6。输入 9 字段另有三个稳定 hash，六车共享相同 input bytes。
- 首次结果：每个 car/scenario 的 3 次运行没有 `firstDivergence`；缺 baseline 时按设计退出 2 并输出候选，而不是静默自我批准。
- baseline：用 apply_patch 登记 18 个 exact、18 个 quantized、18 个 input hash 及 reset samples；全新 Node 进程复跑 `PASS vehicle determinism cars=6 scenarios=3 repeats=3 traces=18`。
- reset 信息：MX-5/M3/GT3 RS 为 sample `1→3`，LP700 `2→4`，AMG GT3 `2→5`，M5 `2→4`；车型差异进入状态证据。
- 回归：加入 `pnpm verify` 后完整通过，secret guard versionable count 102；六车健康指标、90 外部边界、54 内部恢复、Rust/WASM scheduler、audio/assets/build 均保持绿色。

结论：当前环境内未发现确定性分歧；已有可定位输入变更与首个状态字段的 baseline，但还没有浏览器/平台或 Rust replay 一致性证据。

## Rust replay 数值契约实验结果

问题：能否把 replay 的 canonical Float64、1e-6 quantization 和增量 digest 作为 Rust 共享核心的纯函数，同时在 native 与 raw WASM 中逐值一致，而不迁移 JS/Rapier 模拟？

可观测量：特殊 Float64（±0、正常值、极值）的 canonical bits、quantized 值、rolling digest；native Rust、Node JS oracle、真实 WASM export 三方逐 push 一致；格式版本固定。

停止条件：Rust API 无状态、无分配、无 unsafe；native 单测和真实 WASM 对照通过；只有 digest owner 跨边界，不把 SHA-256 fixture 或 Rapier state 复制进 Rust。

- format v1：big-endian canonical `f64`；所有 NaN payload 归一为 quiet NaN `0x7ff8000000000000`，但 ±0/±Infinity 保留原 bits。
- quantization：Rust 实现 JS `Math.round` 的 half-to-`+∞` 与 signed-zero 语义；首轮测试促使修正“缩放下溢返回原值”的错误假设，最终 ±最小次正规数 / 最大 quantum 得到 ±0，与 JS 一致。
- 异常策略：value 或 quantum 非有限、quantum 非正时保持 value；有限 value / quantum 缩放溢出时保持原值，避免量化制造 infinity。
- digest：无状态 FNV-1a 64，逐个 canonical big-endian byte 更新；无分配、无全局状态，raw WASM `i64` 由 JS `BigInt.asUintN(64)` 解释。
- oracle：13 个特殊值逐 bits、quantized value、逐 push state 对照；两个不同符号/payload 的 NaN 得到同一 canonical bits。固定 exact `0248d9354f126505`，quantized `0603ecb87904c881`。
- 验证：Rust 13/13 单测；native probe 同时保留五种 scheduler case 并匹配上述摘要；workspace/all-target 和 wasm32 Clippy `-D warnings` 通过；release WASM 3,658 bytes，独立 JS oracle 对照通过。
- 边界：没有改变网页 owner 或现有 SHA-256 replay baseline；特殊向量证明数值 ABI，不代表 18 个实际六车 trace 已经跨边界运行。

结论：假设得到支持，且下溢 signed-zero 反例证明逐值对照确实增加了信息。Rust 已拥有可复用 replay 数值边界，但不是模拟 owner；下一步应连接实际 trace，而不是扩大算法范围。

## 真实六车 trace 的 Rust/WASM digest 实验结果

问题：现有 6 车 × 3 场景的 50-field trace 能否在生成时同时通过独立 JS 与真实 Rust/WASM FNV digest，并登记稳定 baseline，而不重复运行或复制一套车辆模拟？

可观测量：每个 trace 的 exact/quantized JS FNV 与 WASM FNV、首个不同 tick/field/value/state、现有 SHA-256/input hash 是否保持不变、WASM 缺失时独立测试是否明确失败。

停止条件：只复用一次 trace 生成；18/18 trace 的逐 push state 一致并登记 baseline；现有 54-run exact 重现和完整回归保持通过；不让 digest parity 伪装成浏览器/CPU 确定性证明。

- 接线：runner 仍只生成 3 个 repeats，第一份 reference frames 同时供 SHA-256 和 FNV；没有为 Rust 另跑车辆，也没有把 Rapier state 复制到 Rust。
- 比较粒度：6 车 × `(720+960+900)` ticks × 50 fields = 774,000 个位置；每个位置分别推进 exact/quantized JS 与 WASM state 并立即断言，因此最终 hash 相同之外还能定位首个 car/scenario/tick/field。
- JS oracle：抽成 `scripts/replay-digest-oracle.mjs`，特殊值测试和实际 trace 共用；固定 13-value 摘要继续钉住其 FNV/Float64 行为，避免两套 JS 实现漂移。
- baseline：新增独立 format v1 `vehicle-replay-fnv-baseline.json`，算法名、1e-6 quantum、50-field schema hash 和 18 × 2 digest 均登记；已有 SHA-256 baseline 文件没有修改。
- 失败边界：determinism package script 先从锁定源码重建 release WASM；runner 还用不存在路径执行一次 `assert.rejects`，证明缺 binary 会给出明确 build 指令而不是 fallback。
- 新进程验证：候选登记后重新启动 Node，得到 `PASS ... traces=18 wasmFnv=18`；原 18 SHA/input/reset baseline 同时匹配。
- 完整回归：`pnpm verify` 通过；54-run repeat、90 外部边界、54 内部恢复、audio/assets、scheduler/replay WASM、Vite build、secret 与 license inventory 保持绿色。WASM 仍为 3,658 bytes。

结论：Rust replay 数值契约已接触真实车辆状态，不再只由合成边界值证明；但模拟仍由 JS/Rapier 运行，FNV 也不是安全摘要，因此不能把结果外推成浏览器/平台确定性。

## Rust 比赛进度与计时规则核实验结果

问题：当前比赛计时的 tick、checkpoint 顺序、lap/sector/PB/medal 状态中，哪些是可由 Rust native/WASM 共享的纯状态机，哪些必须继续由 JS 持有 localStorage 和 UI 副作用？

可观测量：现有 9 个 timing 测试的输入事件与逐事件 snapshot；非法 checkpoint、fractional fixed steps、restart、invalid lap 和 PB persistence；JS 与 Rust 对同一序列的差异。

停止条件：先抽取并固定事件协议和允许误差；Rust native/raw WASM 对照通过前不改网页 owner；localStorage 只保留在 JS adapter；若状态机依赖浏览器副作用无法清晰拆分，则记录反证并转向 telemetry schema。

- 边界复核：纯状态为 status、exact clock、lap/sector start、checkpoint/sector progress 和 current-lap validity；identity、reason strings、record normalization/mutation、save、event object 与 DOM 消费均可独立留在 JS。
- red evidence：先构建并运行 shadow test，旧 3,658-byte WASM 退出 1，首错为 `missing timing export streetrush_timing_contract_version`。
- native：新增 generic `RaceProgress`，sector ordinals 严格递增且必须以 finish 结束；negative/non-finite delta 和越界 checkpoint 返回 typed error 并保持 snapshot；2 圈/3 checkpoint probe 为 11,700 ms gold。
- WASM：contract v1 采用 scalar functions/event bit flags，不分配 opaque handle、不使用全局 mutable state；duration rounding 固定 JS 正半值语义，checkpoint accepted/sector/lap/run 可组合。
- shadow oracle：同一 JS `RaceTimingSession` 与 WASM rule state 经 31 个 snapshots 对照，覆盖三次 `1000/3`、wrong checkpoint、重复 invalidation、invalid first lap、valid second lap、restart、两圈 valid PB 和 medal。
- owner 判断：Rust native 真正使用状态化 owner；WASM 目前只在测试 shadow 中决定纯规则，网页 `RaceTimingSession` 仍是 live owner。测试明确打印 persistence/reason/PB/UI 仍 JS-owned。
- 验证：Rust 17/17；native/WASM Clippy `-D warnings`；native scheduler/replay/timing probes；真实 WASM shadow；完整 `pnpm verify` 全通过。
- 构建反应：core 为 4,864 bytes，跨过 Vite 4 KiB inline limit 后产出独立 hashed `.wasm`（gzip 1.78 KiB）；构建 24 files，freshness/public assets/Cloudflare 检查通过，未破坏现有 scheduler loader。

结论：计时纯规则可以共享，假设得到支持；但 PB/persistence/event adapter 仍是明确未迁移面，shadow parity 不能被记录成网页 owner 切换。下一步先解决共享实例与 capability 所有权，再考虑 live timing adapter。

## shared-core 单实例 capability 实验结果

问题：现有 scheduler loader 能否演化为一次实例化的 shared-core capability owner，让 scheduler 与 timing 分别握手和回退，而不复制 fetch/timeout/instantiate 生命周期？

可观测量：同一启动的 fetch/instantiate 次数；scheduler-only、timing-only、完整、缺导出、contract mismatch 与 timeout 的分层结果；现有 scheduler frame parity；timing 31-snapshot parity；构建后的独立 WASM URL。

停止条件：一次实例化、能力失败互不误伤、现有结构化 fallback reason 保持；main live timing owner 仍不切换，直到 shared loader 和 shadow adapter 在失败注入下通过；若 capability 分层使 loader 明显复杂化，则保留单 owner loader 并记录成本。

- red evidence：新增测试先以 `ERR_MODULE_NOT_FOUND: src/shared-core-owner.js` 退出 1，证明聚合 owner 实现前没有假绿色。
- lifecycle：通用 loader 独占 URL、fetch、AbortController、timeout、instantiate 和 exports-object 检查；自定义 instantiate 的同步/异步错误统一保留 `wasm-instantiate-failed`，HTTP 与 timeout code 保持。
- capabilities：scheduler 继续检查 fixed dt/max frame/max steps/plan exports；race-progress 检查 timing contract v1 和 7 个 scalar exports。各自错误转为自己的 JS metadata fallback。
- 矩阵：full=两项 Rust/instantiate 1；timing missing=scheduler Rust；scheduler missing=timing Rust；两种 contract mismatch 只影响相应项；404 fetch 一次和永不完成 instantiate 一次都产生共享 load reason。
- fixture 修正：首次用 Proxy 隐藏 WebAssembly export 违反宿主对象不变量，错误被归类 instantiate failure；改用普通 exports 浅复制后得到预期 capability missing。该失败属于注入方法，不是产品 loader 缺陷。
- legacy：`loadPhysicsScheduler()` 保留，对真实 WASM frame parity 与 fetch/compile/timeout/missing/contract 五类回退全部通过。
- main：`physicsSchedulerPromise` 改为 shared capability promise；同一结果发布 scheduler owner 和 race-progress shadow owner/data/dev event。没有改变 `RaceTimingSession` 构造或 fixedUpdate 时序。
- timing：31-snapshot 测试从 shared wrapper 获取规则，额外断言同一实例同时提供 Rust scheduler 和 Rust timing；不再直接第二次 instantiate。
- 回归：完整 `pnpm verify` 通过；18 FNV traces、六车边界/恢复/物理、audio/assets 保持；build 33 modules、一个 4,864-byte WASM、24 files，secret guard 112 files。

结论：capability 分层没有造成跨能力耦合，且消除了继续扩展时的第二实例需求；网页 live timing 仍未切换，下一步可以在同一 loader 之上实验 state wrapper，而无需再改资源生命周期。

## RaceProgressSession 双路径 wrapper 实验结果

问题：能否用一个可注入的 JS `RaceProgressSession` 包装 scalar Rust/WASM capability，并与现有 `RaceTimingSession` 在同一 action 流双运行，从而把进度 mutation 的 owner 切换条件固定下来，同时不碰 PB/persistence/event adapter？

可观测量：start/restart/advance/invalidate/checkpoint 后的纯进度 snapshot；sector/lap/run outcome；WASM capability 和 JS fallback wrapper；重复 invalidation、错序 checkpoint、finish 后输入；existing record/save/event tests。

停止条件：wrapper 不直接访问 storage/DOM，不重复 instantiate；Rust 与 fallback 两条路径都匹配 legacy 事件序列；先只在测试注入，完整回归通过前不改 live `RaceTimingSession` mutation。

- red evidence：测试最初因缺少 `src/race-progress-session.js` 退出 1。
- API：`reset/start/restart/advance/invalidate/passCheckpoint/snapshot`；checkpoint 返回 rejected/accepted/ordinal/sector/lap/valid/run 的 compact outcome，不构造 UI/record event。
- injected core：WASM wrapper 取自已验证的 shared instance；JS fallback core 实现同一 7-rule surface，并保留 `{code,message}` fallback reason。
- action sequence：invalid run（3 × `1000/3`、错序、首次/重复 invalidation、invalid lap、valid finish）、restart 后 11,700 ms gold run、finished 后 advance/checkpoint/invalidate，以及非法 delta/index。
- 结果：WASM wrapper、fallback wrapper 与 legacy 在 34 个 snapshot/outcome 上一致；legacy summary 仍负责 valid/medal，wrapper 未读取 record/storage。
- 回归：新增测试进入 `pnpm verify`；9 timing tests、6-car medal、shared loader/replay/physics/audio/assets/build 全通过；WASM/模块数不变。

结论：纯进度 owner 已有双路径兼容层，可进入可选委托实验；但本批没有改 live `RaceTimingSession`，因此仍不声称网页计时由 Rust 驱动。

## RaceTimingSession 开发期 live shadow 实验结果

问题：`RaceTimingSession` 是否能把纯进度 mutation 委托给注入的 `RaceProgressSession`，同时完全保持现有 event/record/save/medal API，并在 WASM capability 失败时自动使用 JS fallback core？

可观测量：现有 9 timing tests 与 6-car medal tests；注入 WASM/fallback 后的完整 event/snapshot/record equality；save 次数/时机；main 新 session owner metadata；finish/restart/pause 时序。

停止条件：默认构造保持兼容；注入和 fallback 完整测试通过；不把 reason strings/PB/storage 移入 Rust；任何 event/save 差异先作为失败，不用 tolerance 掩盖。

- staging 发现：legacy checkpoint event snapshot 位于 `checkpointsPassed++` 之后、`completeSector/completeLap` 之前；atomic wrapper 会直接越过该可观测状态。本轮判断修正为先 shadow、暂不委托 mutation。
- red evidence：新测试在未实现注入时跑完 legacy 行为，但断言 `progressOwner=legacy` 得到 `undefined` 并退出 1。
- shadow：可选 `progressCore` 构造同配置 wrapper；default 完全不创建 shadow。每个 action 后比较纯 progress，checkpoint 后比较 rejected/accepted/ordinal/sector/lap/valid/run outcome。
- full fixture：invalid fractional run、错序、重复/第二原因 invalidation、invalid+valid lap、finished 后输入、restart 后 11,700 ms gold；共 35 个 action result。
- storage oracle 修正：首次期望写成 2，实际正确是 3（首场 final、restart 第一圈 PB、restart final）；三条 session 均为 3，测试修正而非产品代码。
- equality：legacy、Rust/WASM shadow、JS fallback shadow 的完整 events/snapshots/summary/record/save count 全相同；现有 9 timing 与 medal suites 通过。
- runtime policy：main 只在 DEV 注入 shadow，避免 production 每个 120 Hz tick 双运行和 JSON assertion；capability 仍一次加载并发布 owner metadata。
- 回归：完整 `pnpm verify` 通过；Vite 34 modules、WASM 4,864 bytes、24 build files，六车 deterministic/physics/recovery、audio/assets 保持绿色。

结论：可选 shadow 已把 shared rule 放进真实 session action 边界，并验证 adapter 不漂移；但 atomic/staged event 差异是实际接管阻碍，需先扩展 transaction 协议，不能仅把 shadow 改名为 owner。

## checkpoint staged progress transaction 实验结果

问题：checkpoint 规则能否拆成无 mutation 的 prepare result 与明确的 sector/lap/run commit 阶段，使 Rust/WASM progress owner 保留 legacy 的 checkpoint-event snapshot 时序？

可观测量：accepted 后 pre-sector snapshot、sector event 后 snapshot、lap event/final run snapshot；wrong/idle/finish；WASM/JS fallback staged state；旧 35-action full event equality。

停止条件：先让 staged wrapper 独立匹配 legacy 中间 snapshot；未证明 event/save 完整一致前不切 `RaceTimingSession`；ABI 增长和 120 Hz call 次数也记录，避免为形式接管增加无证据成本。

- red evidence：staged test 在旧 wrapper 上以 `TypeError: prepareCheckpoint is not a function` 退出 1。
- transaction：prepare 校验/flags 并只推进 checkpoint；sector/lap/run 各阶段明确 commit；finish 返回 compact outcome 并清 pending。pending 时拒绝其他 mutation，避免半事务被外部观察后继续推进。
- compatibility：旧 `passCheckpoint()` 仍存在，在内部执行完整 transaction；atomic 34-snapshot test 和 live-shadow 35-action test未改即可通过。
- intermediate oracle：使用 sector checkpoints `[2,3]`，确保有 accepted-but-no-sector 与 sector+lap 两类；分别与 checkpoint/sector/lap/run event 自带 snapshot 比较。
- first failure：lap finish prepare 时 wrapper `currentLapNumber=2`，legacy checkpoint snapshot 为 1；原因是 wrapper 用 checkpoints 推导，legacy 用已提交 `laps.length`。改为 `completedLaps` 在 commitLap 增加后，46/46 intermediate snapshots 通过。
- 双路径：真实 WASM 与 JS fallback 均通过 wrong checkpoint、invalid first lap、第二圈 finish、final run 和 transaction misuse guard。
- cost：没有 Rust/WASM 修改；module/WASM size 不变，checkpoint transaction 只编排已有 rule result，120 Hz advance 调用也不增。
- 回归：完整 `pnpm verify` 通过；六车 trace/physics/recovery、audio/assets、shared loader、build 均保持绿色。

结论：已知 checkpoint event staging 阻碍被建模和验证，且暴露并修正了 lap owner 的隐藏差异；下一步可以做 authoritative wrapper 实验，但仍必须以完整 event/save equality 阻止双写。

## authoritative RaceTimingSession progress owner 实验结果

问题：`RaceTimingSession` 能否在 authoritative 模式只让 `RaceProgressSession` 写纯进度，而 JS adapter 仅写 reasons/laps/record/events，同时保持 default legacy 和 JS fallback 两条路径？

可观测量：legacy vs WASM-owner vs fallback-owner 的完整 35-action result、event 中间 snapshot、summary/record、3 次 save；内部 legacy progress 字段是否停止 mutation；owner metadata；finished/restart 行为。

停止条件：禁止双写；默认无 core 构造继续 legacy；WASM/fallback owner 深比较完全一致；DEV 可先使用 authoritative+shadow diagnostic，production 切换需再通过实际浏览器或等价运行证据。

- red evidence：fixture 请求 owner 后实际仍为 `rust-wasm-shadow`，owner metadata 断言退出 1。
- modes：constructor 新增 `progressMode=shadow|owner`；没有 core 时仍 legacy。owner reset 只初始化旧字段，后续 progress mutation 全委托 wrapper；snapshot/getters 从 wrapper 读取。
- checkpoint：prepare 构造 checkpoint event；commitSector 返回 time 供 sector record adapter；commitLap 返回 `{timeMs,valid}` 供 lap/PB adapter；commitRun 后生成 summary/save；finish 清 transaction。
- no-double-write：两条 owner scenario 结束后旧 7-field progress state 仍是 idle/0/true reset tuple，而公开 snapshot 已完成 11,700 ms gold run。
- equality：legacy + 2 shadow + 2 owner 五条路径的 35 complete action results、nested event snapshots、summary、record、save count 完全一致。
- sparse-sector：`checkpointCount=3, sector=[2,3]` 的 1-lap fixture只有 2 个 sector events；WASM/fallback owner 与 legacy 全相同，覆盖 accepted-but-no-sector adapter 路径。
- compatibility：原 9 timing tests/default constructor 与 6-car medal tests不注入 core，继续通过；atomic/staged/shadow tests 继续通过。
- runtime：DEV main 注入 owner，并发布 session owner dataset；production build不注入，保留 legacy。shared scheduler/timing WASM 仍只实例化一次。
- 回归：完整 `pnpm verify` 通过；34 modules、4,864-byte WASM、六车 replay/physics/recovery、audio/assets/build 门禁均保持。

结论：开发期网页的纯比赛进度已有真实 Rust/WASM authoritative 路径与 JS fallback，且 PB/event adapter 单写已被测试证明；production 切换仍需 lifecycle soak/运行证据，当前不做无证据扩大。

## timing lifecycle 固定 seed soak 结果

问题：长序列随机但可重放的 race lifecycle 是否会暴露短 fixture 未覆盖的 staged transaction、restart、finished 输入或 PB/save 分歧？

可观测量：固定 seed action trace；legacy/WASM/fallback owner 每 action result/snapshot/record/save；首个 divergence action；有效/无效 run、wrong checkpoint、重复 invalidation、restart 与 finish 后噪声数量。

停止条件：多 seed 各增加不同顺序而非重复日志；先固定生成器与 action hash；所有路径 exact equality；失败按首个 action/field 聚类；不需要实际 DOM/物理即可先验证 session lifecycle。

- generator：xorshift32 seeds `0x71c30001..4`；每 seed 12 run，固定 3 个 half-run restart，并让 advance count/duration、wrong checkpoint 位置随 seed 变化。
- coverage：run `mod 3` 控制 invalid；同一次 invalid run 包含重复同 reason 和第二 reason；每完成 run 后再送 advance/checkpoint/invalidate 噪声。
- first candidate：action counts 319/342/316/343，rejected checkpoints 19/24/17/22；每 seed 12 completed、8 valid、22 writes，证明路径不是空转。
- equality：1,320 actions 中 legacy、Rust/WASM owner、fallback owner 的 result/snapshot/record/summary/write count 每一步 exact，无首个 divergence。
- baseline：登记四个 action SHA 和 result SHA，以及 event/run/PB 统计；全新 Node 进程复跑 `PASS ... seeds=4 actions=1320 completedRuns=48`。
- results：best lap 随 seed 为 2,356/1,656/1,772/2,344 ms；best race 为 6,145/6,960/4,110/6,800 ms；每 seed 15 starts、27 laps、5 invalidated events。
- 回归：加入 `pnpm verify` 后完整通过；timing short/staged/shadow、六车 replay/physics/recovery、audio/assets/build 全部保持绿色。

结论：长 session sequence 未发现 staged owner、PB 或 save 顺序漂移；timing 下一步的增量价值低于回到未整合 input lifecycle，因此 production 切换继续等待实际浏览器条件。

## gamepad identity 与 pointer blur 生命周期结果

问题：NAS dirty input 中 gamepad 对象身份重连与 pointer/blur terminal cleanup，哪些能在当前基线形成独立失败，哪些已被现有 `releaseAll`/pointer capture 测试覆盖？

可观测量：same index/new object、disconnect/reconnect、held/pulse edge rearm、multi-pointer owner、blur/visibility/pointercancel 后 hold/pulse/capture maps；keyboard/gamepad/touch source isolation。

停止条件：先读取来源实际 diff/test hash；只采用能复现当前失败的最小变化；不整批复制 input 大 diff；完整 input、six-car、Rust/WASM/timing soak 回归保持。

- 来源复核：NAS 两个 dirty tracked 文件相对 HEAD 为 input `+57/-10`、test `+142/-0`；dirty SHA-256 分别为 `C1247332D686F1199930A31517ABBF85AE2F1DACB331F62735B871678A8F1194` 和 `7C6BE736B046E22C7029EBD8B6BACE466FAF419A063ACDCD181E349367F1AC71`。
- 已有覆盖：disconnect/reconnect neutral rearm、`releaseAll`、window blur/pagehide/visibility、local/global pointerup/cancel/lostcapture、键盘 terminal 与 fixed-step pulse 均已通过；不重复复制这些 fixture。
- gamepad red：旧 pad 活跃后在同一 `getGamepads()` 槽位换成仍活跃的新对象，首帧 `driveIntent=1`，期望 neutral handshake 的 0。
- hold red：同一油门控件两根物理指针均捕获后触发元素 blur，`touch.throttle=0`，期望仍为 1；其他 brake/steer owner 未受影响。
- pulse red：reset pointer 仍捕获时触发元素 blur，pressed class 为 false，期望保持 true 直到 pointerup；中心 capture registry 并未释放，说明只是局部状态提前清理。
- 修复：跟踪 gamepad 引用并在替换时 rearm/reset button edges；hold blur 只清 keyboard pointer；pulse 移除非 terminal 的元素 blur cleanup。三条实际 terminal 与 window lifecycle release 不变。
- green：三个新增断言与既有 input suites 一起通过；完整 `pnpm verify` 保持 12 项资产、18 条六车 deterministic/WASM FNV、1,320-action timing soak、六车物理/恢复、音频与 production build 全绿；34 modules、4,864-byte shared WASM、24 build files 不变。
- 边界：fixture 没有证明目标浏览器 `Gamepad` wrapper 跨轮询的身份稳定性；若实测每帧换 wrapper，必须改用 index/id/连接 epoch 协议，不能继续按引用替换解释。

结论：三个来源候选都能形成独立失败且根因一致地落在输入 owner/lifecycle 边界；采用的是可解释的最小子集，不是整批认可 NAS dirty input。

## 六车 production GLB 结构 probe 结果

问题：六辆 production GLB 的实际 node/mesh/wheel/bounds 结构，与模型研究报告和当前 `AssetStore` 的通用 scale/offset 路径有哪些稳定差异？这些差异是否足以支持一个可测试的 wheel/灯光/相机 adapter，而不是按车型写视觉猜测？

可观测量：每车 GLB JSON 的 scene/node/mesh/skin/animation 数、name digest、static node TRS/accessor bounds、wheel/light 候选、config normalization、文件 SHA-256 和 research/source-model 关系。

停止条件：先做只读离线结构 probe 并固定 baseline；六车数据不足或命名不稳定时只记录参考，不改运行时；只有发现能复现当前 adapter 错位的明确 invariant，才写失败测试和最小 adapter。

- parser：依赖为零，验证 GLB magic/version/declared length/JSON chunk；遍历 default scene，组合 column-major node matrix/TRS，并变换每个 POSITION accessor min/max 的八角。
- method boundary：结果是 static conservative AABB，不 decode vertex、不执行 skin/morph/animation。六车无 skin，MX-5 有 1 animation，其余为 0。
- source identity：public 六车都与 NAS clean HEAD blob 相同。MX-5/M3/GT3/LP700 与研究 hash exact；M5/AMG 研究 hash 与 NAS `source-models`/素材库 exact，而 public manifest 明确标为 optimized derivative。
- derivative delta：M5 `5,806→28 nodes`、`1,169→28 meshes`，AMG `540→51 nodes`、`166→51 meshes`；triangle counts 各自仍为 790,738/302,492，public generator 是 glTF-Transform 4.4.1。
- name evidence：结果为 `cars=6 researchExact=4 wheelNamed=4`。LP700/M5 为 0；GT3 的 102 个 wheel hits 混入大量 `rubbertrim`，反证通用 regex binding。
- baseline：登记六车 byte hash、counts、extensions、node/mesh/material 与 candidate digests、bounds、target-length scale；新 Node 进程 exact 通过并加入 `verify`。
- source-status correction：NAS 4 GLB、2 texture、2 source GLB 的 raw diff 全是 `100755→100644`；旧的“相同大小但内容变了”判断来自误读 status，已推翻。

结论：结构 probe 有信息增量，且阻止了把 M5/AMG source node id 套到 public derivative；目前没有六车共享 wheel binding invariant，运行时只能从已存在且明确的生成轮组开始。

## M3 generated-wheel adapter 结果

问题：当前专为 M3 生成的四个轮胎/轮毂是否真的由 `VehicleSystem` 的 steer、compression 和 omega 驱动，且 clone/reset/异常数值下保持 owner 一致？

可观测量：生成对象层级与 FL/FR/RL/RR 顺序；front Y steer、四轮 suspension Y、nested X roll；fixed-step angle、render alpha、clone 后 binding、reset 和非有限值。

停止条件：只接现有 M3 generated set；不解析其他车嘈杂名字；不改变 tyre force/physics/replay schema；缺任一 pivot 时整套 adapter fail closed。

- source：M3 wheel binding 报告要求 generated outer-Y steer + nested-X roll；unresolved P0 明确指出当前 main 只同步 wrapper pose。
- red：旧 set 是 8 个 flat meshes，首错 `FL has a steer/suspension pivot`。
- hierarchy：生成 `visual-wheel-{FL,FR,RL,RR}-steer/roll`；primitive version/order 保存在可 clone userData，运行时 Object3D 引用重新按 name 发现。
- state：wheel previous/current visual angle 在 fixed update 用 omega 积分；render alpha 线性插值，长期角度 rebase；non-finite 自动归零；reset 明确清除。
- green：clone 后 4 bindings、axis/order、steer/compression/roll、fixedUpdate wiring、NaN/Infinity 和 reset 全通过；完整 `pnpm verify` 保持 18 条六车 WASM replay、1,320-action timing soak、六车物理/恢复、音频、12 asset tests、GLB baseline 和 production build 全绿。
- unresolved：source Brake_Disc/Brembo_Calipers 仍 static/baked steer；没有真实浏览器视觉证据，所以没有在本批隐藏或重分组。

结论：M3 generated wheels 现在有真实动态 owner，且范围严格受结构 marker 限制；这是可验证的小步，不代表其他五车轮组已经接入。

## static merge 显式动态 branch 分区结果

问题：`mergeStaticCarMeshes()` 能否显式排除动态 source branches，同时保持 clone、材质/几何所有权、draw-call 合并和变换契约？

可观测量：merge 前后节点 identity、dynamic/static mesh counts、world transform、material/geometry sharing 和 clone independence。

停止条件：先构造合成 scene 复现“动态节点被 merge 消失”；没有车型级 pivot/axis 证据就不加载 production node ids；M5/AMG public derivative 不得声称覆盖。

- red：9 static + 2 dynamic meshes 的 scene 中，旧 merge 完全吞掉带 v1 marker 的 `dynamic-FL-brake`；新增测试唯一失败为 `dynamic pivot survives static batching`。
- partition：只收集最外层 `{dynamicCarPart:{version:1,id}}` branch；其 meshes 排除在 static batches 外，并以原 parent world matrix 作为手动 base 深拷贝层级。
- result：9 个 static draw calls 合为 1，2 个 dynamic 保持 2，总 draw calls 为 3；branch world position 误差 `<1e-9`。
- ownership：canonical 与 instance 的 marker pivot 对象独立，geometry 继续共享；无 marker、unsupported static 和不足 8 个 static meshes 的原 fail-closed 行为不变。
- research gate：MX-5 报告要求按 tire centroid 新建 outer-Y/inner-X pivot；M3 有 baked front steer；GT3 只在 source hierarchy isolation 验证。保留 branch 不等于正确运动，因此没有给 production 模型添加 marker。
- regression：资产生命周期测试 13/13；完整 `pnpm verify` 通过，保持 18 条六车 deterministic/WASM replay、1,320-action timing soak、六车物理/恢复、34 modules、4,864-byte WASM 和 24-file build。

结论：通用资源分区机制有独立价值，但车型级 wheel manifest 是运行时接入的必要前置条件；M5/AMG 的 public derivative 仍需 source-copy 优化 pipeline，不能靠 marker 逆拆。

## MX-5 hash-scoped wheel manifest 实验设计

问题：能否为与 public GLB hash 完全一致的 MX-5 建立一个可离线验证、遇到 hash/name/part role 漂移即失败的 wheel manifest？

可观测量：四个 wheel roots、rim/tire/brake-disc part roles、各 part accessor bounds、tire centroid、outer steer/inner roll 轴、原始 world transform，以及 manifest 与 public GLB/research report 的双重 hash。

停止条件：先只生成/校验数据，不改 production runtime；任一 root/part/axis 无法由 GLB 和报告共同支持则保留为候选；通过后仍需纯 scene pivot fixture 才能考虑添加 marker。

## MX-5 hash-scoped wheel manifest 结果

问题：研究报告的四轮 mapping、part roles、tire centroid 和轴，能否由当前 public GLB 独立重算并在漂移时给出局部失败？

可观测量：public/report SHA；root/node/mesh/material；POSITION accessor/count；decoded raw-world bounds/vertex average；parent local-Z world axis；负例错误类别。

停止条件：不依赖外部研究目录运行；不改 runtime；public 与研究 source 必须 byte-identical；正式值由 primitive 实际字段得出，不从索引顺序猜测。

- source：public GLB 1,925,828 bytes，SHA-256 `a17b3b9edc0997ba77837ae4358e3dfe7b7aa7f59364d7c15b6fb01a3452d26b`；binding/validation 报告 SHA 分别为 `5879dc06...00a786`、`1e2f8db9...23544f`。
- red：初版把 FL rim POSITION accessor 猜成 24，真实 primitive 为 72；第一处失败直接推翻 accessor/mesh 顺序假设。
- decoder：从 GLB BIN bufferView 按 FLOAT VEC3/stride 读取 POSITION，组合 default scene TRS，逐顶点计算 exact world bounds 与 vertex-average centroid；sparse/non-float/out-of-scene/multi-parent fail closed。
- manifest：锁定 4 roots × 3 parts；accessors 为 FL `72/76/80`、FR `60/64/68`、RL `84/88/92`、RR `48/52/56`。
- cross-check：12 组 exact bounds 与研究报告在 1e-9 舍入下一致；四个 tire centroid 摘要 `9707b78576e4433d82dd8fbeef9f7cbf64a07337e96781fd78c0d45e58fe9dc3`。
- axes：四个 parent local-Z 映射 +X，最大误差 `8.6821e-8`；outer Y steer、nested X roll 和 tire-centroid pivot 作为显式契约登记。
- drift：source hash、root、material role、accessor、bounds、axis、pivot centroid 七类负例均按局部原因拒绝；六车 structure baseline 联合通过。
- regression：完整 `pnpm verify` 通过；13 项资产生命周期、18 条六车 deterministic/WASM replay、1,320-action timing soak、六车物理/恢复、34 modules、4,864-byte WASM 与 24-file build 保持。

结论：MX-5 manifest 足以成为纯 scene pivot 实验的输入，但仍未证明 Three `attach()` 后的 tire/rim/disc 运动归属，也没有 production runtime 授权。

## 下一实验

问题：用 MX-5 manifest 对一个与真实层级同构的 Three scene 建立 outer-steer/inner-roll pivots 时，能否在不依赖浏览器渲染的情况下保持零姿态 world transform，并得到正确的组合运动归属？

可观测量：attach 前后每个 part matrix/centroid；front steer + roll 下 tire/rim/rotor 轨迹；suspension Y；canonical/clone identity、geometry sharing 与 static merge 边界。

停止条件：先实现纯函数和合成/同构 fixture，不接 GLTFLoader/main；整个 source wheel root 必须 nested roll，模型无 caliper；任一零姿态 transform 漂移超过 1e-9 或 clone owner 不清晰就停止 runtime 接入。

## MX-5 host-space wheel pivot 结果

问题：manifest 驱动的 outer-Y/nested-X 重组是否比 source root-origin 组合旋转更稳定，并保持模型比例、资源与 clone owner？

可观测量：direct/bound tire vertex centroid；12 part world matrices；0.08m suspension delta；Three attach/manual reparent 误差；atomic failure；static batching。

停止条件：同构 fixture 必须使用 actual GLB root TRS、manifest centroids/runtime names 和 production scale；零姿态 matrix error `<1e-9`；不接 AssetManager production。

- ownership correction：隔离源码把整个 `Circle00x` root attach 到 nested spin；Material.017 是随轮 roll 的 rotor，GLB 没有 caliper。此前“disc outer-only”计划被推翻。
- red：source direct `rotateZ(0.72)` + front `rotateY(0.34)` 的最大 tire centroid drift 为 `0.008845718m`。
- scale boundary：outer container 必须位于未缩放 unit vehicle host，作为 normalized model sibling；若放进 scale=`0.015102163` 的 model，0.08m suspension 会缩为约 1.2mm。
- attach red：Three `attach()` 零姿态 matrix error `1.0395e-8`，未达到停止条件；manual `inverse(parentWorld) × childWorld` 且 source root 禁止 auto-update 后误差为 0。
- motion green：四 tire centroid 在 steer+roll 后最大误差 `<2.44e-16m`；12 part matrices 都旋转，front rim/rotor 偏置质心随 steer，rear 同轴质心在 X roll 下稳定；12 parts suspension delta 都是 `[0,0.08,0]m`。
- lifecycle：输出沿用 `calibrated-wheels` v1 marker；clone 对象独立但 geometry/material 共享，binder 新增 9 个 Group、0 GPU resources；缺 RR tire、非 unit host、重复绑定均在 mutation 前失败。
- merge：wheel roots 已脱离 normalized model 后，9 个 static body meshes 仍合成 1；wheel host 作为 sibling 保留。
- regression：完整 `pnpm verify` 通过；MX-5 manifest/pivot、13 项 assets、M3 visual wheels、18 条六车 replay、1,320-action timing soak、六车物理、34 modules、4,864-byte WASM、24-file build 均保持。

结论：纯 host-space 接口通过，可进入真实 GLTFLoader/AssetManager 副本验证；尚未接入 production，不能把同构 fixture 当成六车视觉运行证据。

## 下一实验

问题：真实 public MX-5 经当前 Three GLTFLoader 解析后，manifest runtime names、12 个 POSITION attributes 和 host-space binder 是否仍 exact；绑定失败能否让 AssetManager 原子 fallback？

可观测量：真实 loader Object3D names/types/counts；bind 前后 matrices/resources；normalize/ground/static merge；cache clone；缺节点/加载异常的 structured fallback。

停止条件：优先 Node/可注入 loader，不规避 Browser URL policy；若纹理解码环境阻塞，记录具体外部条件并改用 AssetManager 注入真实几何 scene；真实对象验证前不接 main/VehicleSystem。

## 真实 MX-5 loader / AssetManager / Rapier 结果

问题：同构 fixture 的结论能否在当前 Three 实际解析出的 scene 上成立，并保持 AssetManager fallback/cache 与 VehicleSystem owner？

可观测量：parse phase/error；runtime objects/geometry/animation；normalize/ground/static counts；canonical clone；缺 part/binder fallback；Rapier steer/compression/omega/reset。

停止条件：不伪造纹理解码，不改 main；默认 AssetManager 行为不变；任何失败不得污染 source scene 或 cache。

- Node boundary：未定义 `self` 时实际失败于 `GLTFParser.loadImageSource`；设置标准全局别名后 parse 完成，但缺 `createImageBitmap` 使 1 个嵌入 texture 可恢复失败。测试只使用完整返回的 geometry scene，并锁定 1 次 texture limitation。
- objects：4 个 `Circle002..005` Object3D、12 direct Mesh children exact；每轮 POSITION counts 1452/1920/40，materials 015/014/017；动画为 `Scene → Empty005.quaternion`。
- injection：AssetManager 只新增默认空的 manifest/binder options；真实 normalize 先 bind wheel sibling，再将其余 12 static source draw calls 合并；默认六车路径未启用。
- ground：真实值为 `shape:12`，不是预估 `wheel:4`；sanitized names 不匹配带点 regex，但 lowest shape 仍来自 tire。本批记录而不顺带修改。
- ownership：canonical/instance pivots 独立、geometry 共享；真实 tire centroid 对 pivot `<1e-8`；4 roots 都在 nested roll，manual matrix 被 clone 保留。
- fallback：删除 RR tire 或只给 manifest 不给 binder，都得到 structured fallback；visual/pending/car cache 清空，原 source roots 未 reparent。
- Rapier：真实 normalized instance 获得 4 bindings；fixed-step angle、front steer、四轮 compression、插值与 reset 全通过。
- regression：完整 `pnpm verify` 通过；13 assets、manifest/pivot/M3、18 条六车 replay、1,320-action timing、六车物理、34 modules、4,864-byte WASM、24-file build 保持。

结论：真实对象与 lifecycle 证据支持只给 MX-5 做 production 注入；浏览器纹理/视觉仍不能由 Node 测试替代，失败回退必须保留。

## 下一实验

问题：在 main 只注入 MX-5 manifest/binder 后，build identity、四 binding、六车切换/restart/cache clone 和 fallback 是否保持？

可观测量：main constructor options；production bundle modules/size；MX-5 canonical/instances；其他五车无 manifest；重复实例、reset/destroy/recreate；故障时 readiness source。

停止条件：单车 exact mapping，不建立通用名字猜测；其他五车 output deep/structural 不变；实际浏览器 URL policy 仍阻塞时用 Node lifecycle 增量测试，不伪报视觉验收。

## MX-5 production / 六车浏览器 smoke 结果

问题：测试中的 MX-5 binder 接入实际 main 后，六车切换、WASM owner、比赛 lifecycle 与失败边界是否仍成立？

可观测量：production factory identity；真实 loader/cache 双实例；Vite build；六车 READY/mounted id/binding count；scheduler/progress owner；计时、pause audio gate、reset invalidation、restart、返库与 console。

停止条件：只有 MX-5 启用 exact manifest；其他车 output 不猜测；自动化无法保持输入时如实记录，不用短 pulse 冒充实际驾驶。

- factory：`src/game-assets.js` 只登记 `mx5`，main 与 loader test 共用；missing part/binder 仍 structured fallback。
- lifecycle：两 cache instances pivots 独立、geometry 共享；A 的 steer/roll 不污染 B；双方 reset/destroy 通过。
- regression：完整 `pnpm verify` 通过；37 modules、4,864-byte WASM、24 files/77.06 MiB、221-file secret scan，现有六车物理、replay、timing、audio、asset tests 保持。
- browser garage：六车按顺序和 cache 回返都 `READY`、start enabled；M3/MX-5 分别 4 bindings，其他四车 0；MX-5 source=`manifest:mx5`；console warning/error 为 0。
- browser core：physics scheduler 与 race progress 都是 `rust-wasm` owner。
- browser race：倒计时后 time 增长；pause 前后固定在 `01:27.183` 且 audioPaused=true，resume 到 `01:28.033` 且 false；reset 显示 `RESET · LAP INVALID`，restart 后 VALID 且 `00:01.058`，返库 MX-5 仍 READY。
- input boundary：45 次自动化 GAS short pulse 与一次 button-internal pointer drag 后均 speed=0/rpm=900；该 surface 无可用 hold 语义，不能证明持续驾驶成功或失败。持续油门/转向、检查点和完赛保留为 P0 未验证。

结论：生产入口与关键 lifecycle 已有真实浏览器证据；下一验收应换用可保持输入的控制面，不继续重复短 pulse。

## Research salvage 结构与元数据结果

问题：新增 archive 是否内部一致、能被当前六车引用；其声明能否支持后续样本音频 pilot，而不把 prototype 冒充 production？

可观测量：selection→CARS；bank/analysis/loop；36 WAV headers/samples/hash；projection counts/owner；spring boundary。

停止条件：不听感猜测、不改 WAV、不推广 candidate claims；元数据矛盾先失败再只修项目副本。

- red 1：MX-5 `analysis.cylinders=6`，而 bank/game 都是 I4；测试在首个 bank 失败。
- red 2：横向检查发现 M5 V8 同样写 6；两者的六个 `expectedFiringFrequencyHz` 均按错误缸数派生。
- fix：MX-5 改 4 缸、M5 改 8 缸，并只重算对应 12 个 firing-frequency fields；WAV、bank、loop/source records 未变。
- reader boundary：physics projection 带 UTF-8 BOM，原生 `JSON.parse` 失败；test reader 只在解析边界剥离 BOM，保留 archive bytes。
- green：6 vehicles/banks、36 WAV/7,939,584 bytes；PCM16/mono/44.1k、2.5s、非静音、无 full-scale sample、prepared SHA-256 和 seam gates 全通过；21 physics fields count/owner/eligibility 与 coil-not-wheel-rate 边界通过。

结论：salvage 有明确价值并可安全版本化为候选输入；下一步只做一车 decoded bank pilot，失败必须回退当前程序化音频。

## MX-5 分层发动机 bank pilot 结果

问题：已验证的候选 WAV 能否通过当前严格 loader 接进 `ProceduralAudio`，在不破坏路/风/胎噪、pause gate 和程序化 fallback 的前提下形成真实可运行的 RPM/负载分层声音？

可观测量：复制文件 hash；manifest/六 WAV 获取与 decode；BufferSource/loop/playback rate/gain；程序化 engineGain；pause target freeze；切车 release；HTTP 失败；真实浏览器状态和 console。

停止条件：只接 MX-5 一车；candidate loop gate 或任一 decoded layer 不合格则原子拒绝；加载/attach 失败必须有声回退；不凭数学测试声称听感或录音真实性；其余五车不在同批机械铺开。

- asset：`bank.json` 与 6 个 2.5s PCM WAV 复制到 `public/audio-banks/mx5`，所有 SHA-256 与 salvage 一致；license inventory 明确增加 7 个 uncleared prototype blocker。
- player：三个 RPM anchors 以 cosine/sine 相邻混合，on/off load 以 sqrt 权重混合；播放速率限制 0.45–1.55。候选 bank 与每层 loop 都必须 approved，验证在 detach 前执行；六源 start/stop/disconnect 和 replacement/dispose 有断言。
- integration：bank ready 时程序化发动机降到 `0.0001`，但 exhaust/road/wind/tire 路径不被替换；pause 时主循环不更新 layer targets，全图由既有 pause gate 静音；切到无 bank 的 GT3/M3 释放 decoded layers 并恢复程序化。
- failure：fixture manifest HTTP 503 得到 `degraded/procedural`，播放器为空且 engineGain 继续有声；strict loader 原有 manifest/json/layer/decode/abort gates 保持。
- regression：完整 `pnpm verify` 全绿，含六车物理、18 deterministic replay traces、1,320-action timing soak、模型/轮组、Rust native/WASM；build 为 41 modules、4,864-byte WASM、31 files/78.34 MiB，233 个可版本化文件 secret scan。
- browser：初始 `pending-init`；开始手势后真实变为 `ready/family`，id=`bank.candidate.i4.mazda-b6-compatibility-proxy`。暂停/恢复保持 ready；切 M3 为 `procedural/none`，切回重新 ready；console 仅有 Vite debug，无 warning/error。
- evidence boundary：浏览器自动化没有听觉输出分析，也不能保持驾驶输入；本结果证明 decode/graph/state lifecycle，不证明循环无接缝、动态音色自然、设备响度合适或完整驾驶中的听感。

结论：当前接口值得保留，并足以作为其余五车的唯一扩展形状；扩展前最有信息量的是人耳/长时成本检查，而不是重复证明同一 loader 能读取更多同格式文件。

## 六车分层 bank 扩展与资源 soak 结果

问题：在不改变已通过的播放图形状时，把其余五个已验证候选显式接入，是否会出现同家族串车、manifest/version 漂移、切换资源累积或真实浏览器 decode 差异？

可观测量：selection/profile/bank 一一映射；42 个 runtime 文件与 archive hash；六车 manifest/version；多轮 fetch/attach/source stop；503 重试；浏览器 bank id、pause 和 console。

停止条件：只接归档已选的现有六车主 bank，不引入 alternate candidates；family 相同也必须逐车显式 id；所有文件登记为未清许可；若一车 browser decode 失败则保留程序化并不宣称六车完成。

- copy gate：新增五车 35 个文件全部 byte-identical；六车 runtime 总计 42 files/7,965,590 bytes。production test 逐车比较目录文件集合、manifest id/family/version/quality 和 archive SHA-256。
- mapping：MX-5/M3 虽同为 I4、AMG/M5 虽同为 V8，但 profile 各只列自己的 candidate id；六车都解析为唯一 `family` 结果。
- soak：4 rounds/25 successful attaches/175 successful fetches/150 sample sources；一次 LP700 manifest 503 先 degraded/procedural、下一请求 ready；最终全部 150 源 stopCalls=1 且 disconnectCalls=1。
- browser：MX-5、M3、GT3 RS、LP700、AMG GT3、M5 及回到 MX-5 均 `ready/family`，id 与映射一致；M5 pause/resume 保持 ready，audioPaused true→false；console warning/error=0。
- build/license：41 modules、4,864-byte WASM、66 files/84.67 MiB；inventory 52 files、public blockers=43、commercial blockers=45。增大的 blocker 数是诚实结果，不通过修改状态把 prototype 伪装成 cleared。

结论：六车音频运行时接线已完成，继续复制相同格式不会增加信息量。剩余声音工作转为人耳听感、后台/移动设备成本、长期资源观测和许可替换；程序化路径继续作为每车失败回退。
