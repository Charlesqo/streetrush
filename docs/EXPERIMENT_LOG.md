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

## 下一实验

问题：clean vehicle reset 究竟遗漏了哪些运行状态；只补 reset 完整性是否足以消除污染，还是必须同时加入 update-time finite guard？

可观测量：六车 reset 后的传动、转向、引擎负载、轮胎接触、telemetry 数值和标志；分别记录 assertion failure 与异常，而不是把所有失败归为“非有限值”。

停止条件：先写不依赖 NAS 新增内部字段的 reset-only 测试并在 clean code 上失败；若修复后六车现有物理回归保持通过，再独立设计 NaN/Infinity 输入测试，避免把资源释放改动混入车辆状态批次。
