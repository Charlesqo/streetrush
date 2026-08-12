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

## 待分批吸收的 NAS 脏改动

来源工作区无 staged 内容；有 28 个 tracked 修改和 11 个 untracked 测试，约 `+3108/-252`。二进制模型/纹理虽字节数相同但 Git 内容不同，必须单独审计哈希和结构。

建议批次：

1. finite/reset、fixed-update 输入脉冲与对应失败测试；
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

## 当前最值得继续的方向

1. 验证 clean baseline 的依赖、逻辑测试与构建，记录任何环境性失败；
2. 以 NAS 已提交 `src/physics-scheduling.js` 为 oracle，建立无第三方依赖的 Rust workspace、原生探针和 raw WASM 调用对照；
3. 完成后重新比较 NAS finite/input 脏改动，选择第一个有失败测试支持的稳定性批次。
