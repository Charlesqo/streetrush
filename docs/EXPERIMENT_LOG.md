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
- 可复现生成：package scripts 调用 `scripts/build-core-wasm.mjs`；从干净源码构建 release WASM 到忽略目录，当前 2,533 bytes。
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

## 下一实验

问题：能否把 replay 的 canonical Float64、1e-6 quantization 和增量 digest 作为 Rust 共享核心的纯函数，同时在 native 与 raw WASM 中逐值一致，而不迁移 JS/Rapier 模拟？

可观测量：特殊 Float64（±0、正常值、极值）的 canonical bits、quantized 值、rolling digest；native Rust、Node JS oracle、真实 WASM export 三方逐 push 一致；格式版本固定。

停止条件：Rust API 无状态、无分配、无 unsafe；native 单测和真实 WASM 对照通过；只有 digest owner 跨边界，不把 SHA-256 fixture 或 Rapier state 复制进 Rust。
