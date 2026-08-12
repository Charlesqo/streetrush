# 来源清单

更新日期：2026-08-13

状态只表示当前整合判断，不表示永久弃用：`当前使用`、`候选`、`参考`、`暂缓`、`受阻`。

| 来源 | 原始状态 | 可用成果 | 当前状态 | 重新评估条件 |
| --- | --- | --- | --- | --- |
| `Z:\Temp\street-rush-studio-continuation` | 独立 Git 仓库；`main`；HEAD `5fdea8405c1951057eeb994635e5468273a71e62`；另有 28 个 tracked 修改、11 个 untracked 测试 | 当前最成熟的六车 Three.js/Rapier 可玩产品、固定步调度、比赛计时、移动输入、资源加载、测试和授权记录 | clean HEAD：当前使用；脏工作区：候选 | 脏改动按 finite/input、音频、资产生命周期、计时/UI、二进制资产分批复制并回归 |
| `E:\Codex\street-rush` | 不是独立仓库；位于无提交历史的 `E:\Codex` 外层仓库，整个项目未跟踪 | 较早的六车实现、外部素材布局、V6/V8/V10 采样音频路径、较短的兼容对照 | 参考 | 需要核对旧调用兼容或采样音频来源时逐文件采用 |
| `E:\Codex\赛车游戏素材` | 无独立 Git 历史；约 215 MB 的资产快照 | 六车 GLB、18 层基础引擎 WAV、downtown city 模块和车辆授权记录 | 六车/音频：候选；城市：暂缓 | 生产适配器接口稳定；资产哈希、结构、授权和生命周期测试通过 |
| `E:\Codex\autonomous_runs\multi_car_model_research` | 无独立 Git 历史；六车 14/14 报告和浏览器隔离证据齐全 | 轮组结构、转向/滚动/悬挂所有权、灯光、碰撞体、相机、性能和逐车未决项 | 候选/参考 | 先以 M3 生成轮验证统一视觉适配器，再以 MX-5 验证保留原层级；其余车逐类接入 |
| `E:\Codex\autonomous_runs\multi_car_audio` | 不是独立仓库；外层 `E:\Codex` 无提交且该目录 untracked；包含候选、隔离副本、vendor 和重复构建，约 3.14 GB | 共享 AudioContext/decoded bank registry、切车取消、stale 防发布、fallback/retry、garage/reenter、dispose、六车 profile/manifest/schema 和浏览器契约 | bank 选择/发布协议：当前使用；data/schema/播放图：强候选；大 WAV/vendor：参考不复制 | 用小型 manifest/decode fixture 固定双重 loop gate 和释放后，再决定复制最小数据；目标设备与 exact bank 证据仍 fail-closed |
| `E:\Codex\autonomous_runs\multi_car_physics_data` | 位于无提交历史的 `E:\Codex`；六车证据包 | 身份绑定、字段 provenance、schema、冲突报告和验收目标 | 候选数据/参考 | 只采用 field-scoped eligible 数据；缺失 owner、曲线、表面和同步 trace 时不升级为目标车参数 |
| `E:\Codex\vehicle-audio-lab` | 位于无提交历史的 `E:\Codex`；内含 Engine Simulator detached HEAD `80a9075...` | 离线 Engine Simulator 导出器和 V6/V8/V10 基础 bank 生成方法 | 参考 | 需要重导或原生音频工具时复制最小接口；不复制 build/third-party 整树 |
| `E:\Codex\vehicle-physics-core` | 位于无提交历史的 `E:\Codex`；C++20 研究核心 | TMeasy/Fiala、共享质量/垂向/14 速度研究模型、能量账本、测试和 CSV 实验 | 强候选/参考 oracle | 移植前固定输入输出、误差与状态所有权；不得把 generic fixture 当目标车验证 |
| `E:\Codex\research_continuation_20260810` | 位于无提交历史的 `E:\Codex`；隔离复现实验集合 | 音频资源生命周期反证、物理 14 状态/轮胎事务 owner、trace/数据契约和大量 audit JSON | 参考/oracle 候选 | 每次只采用有明确问题、可观测量和停止条件的最小实验；避免复制重复 build 输出 |
| `E:\Codex\workstreams` | 位于无提交历史的 `E:\Codex`；三个早期 workstream | ENet loopback、F1TENTH/轨迹规划参考、引擎管线元数据、物理 CSV | 参考/暂缓 | 网络同步、AI 轨迹或引擎工具成为近期瓶颈时重新审查许可证和接口 |
| `E:\Codex\esp32_low_latency` | 由研究记录直接引用；位于无提交历史的 `E:\Codex`；含大量 vendored/build 文件 | 手柄/网络控制固件和 host-side control tests | 暂缓 | 原生程序需要实体控制器或网络输入协议时，先隔离自有 control core 与第三方树 |

## 已确认的重复与边界

- NAS 与旧 `street-rush` 同源；NAS 的计时、移动输入、恢复 UI、资源管理、遥测和测试矩阵明显更新，旧项目不作为基线。
- `multi_car_audio` 已覆盖 `vehicle-audio-lab` 的基础 bank 路线并加入运行时状态机；离线导出器仍保留工具参考价值。
- `research_continuation_20260810` 和 `workstreams/physics_numerics` 大量验证 `vehicle-physics-core`，但不是生产核心的替代品。
- 模型研究的 `researchEvidenceComplete=true` 只表示研究证据齐全；`canonicalRuntimeAdapterImplemented=false`，六车生产视觉绑定仍未完成。
- 物理数据包六车 identity gate 已建立，但 evidence/model/validation gate 全部仍为 false；当前游戏标量不能填补缺失证据。
