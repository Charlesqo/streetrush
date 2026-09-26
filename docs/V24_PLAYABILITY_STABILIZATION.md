# v24-active 可玩性稳定记录

最新反馈跟进：用户已确认方向正确，随后报告直线跑偏和高速刹车甩尾。已用真实 LP700、生产 TrackSystem 和 W/S 事件跑到 140 km/h，保存修前失败与修后完整逐固定步数据；按 active unified reference 修复了悬架 KC 前束/外倾缺少左右侧镜像的问题。最终实车试验 2252 步，10/10 直线制动门槛通过；完整 CSV、根因、修改文件和命令见 [直线高速制动记录](verification/straight-line/README.md)。仅该项目自动验证通过，等待手感验收，不代表游戏或完整 v2.4 完成。

本记录只覆盖 2026-08-31 当前 working tree 的可玩性修复，不代表完整 v2.0/v2.4 等价或游戏完成。AMG GT3 / M5 模型与车轮视觉不在范围内。原有用户修改保留；没有 reset、checkout 覆盖、依赖安装或全仓格式化。

用户方向反馈后的纠正：上轮方向 PASS 使用了错误的左右基准，已撤回。当前转向策略为 `streetrush-playability-v2-driver-view`，按真实 ChaseCamera 屏幕右轴先复现 FAIL、修正后 7 场景组 / 100 checks PASS。下文 335 checks 是反馈前的历史执行记录，不是纠正后重跑结果。修前/修后原始结果见 `docs/verification/v24-steering-feedback.json`；实际驾驶手感仍待用户。

## 权威与边界

按顺序使用项目内只读权威资料：

1. `references/vehicle-physics/v2.0/vehicle_physics_design_baseline_cn_v2.0 (1).docx`
2. `references/vehicle-physics/v2.4/README.md`、`REFERENCE_RUNTIME.md` 及其指向的 active scope、host boundary、executable reference
3. `docs/VEHICLE_PHYSICS_BASELINE.md`
4. `docs/PROJECT_MAP.md`
5. `docs/TESTING_AND_COMPLETION.md`

保留 `v24-active` 和 Rapier world/body 的权威 ownership，不改变未决定的 backend 路线。转向设备映射、车速辅助与机械 rack 分开；本轮修订的驾驶辅助策略不冒充 standalone steering 数值等价。参考数据不重录。

## 本任务编辑边界

以下文件本轮有局部编辑；部分文件及整个 `src/vehicle-v24/` 在开始时已有用户修改或尚未追踪，不能把整份 git diff 归为本任务：

- `src/input.js`：设备语义、trigger deadzone、设备重连。
- `src/vehicle-v24/steering.js`：唯一物理 handedness seam、车速辅助。
- `src/vehicle-v24/powertrain.js`：方向意图、离合器边界、ESC 门槛、扭矩诊断。
- `src/vehicle-v24/runtime.js`：输入/力矩/辅助制动 telemetry 与求解诊断。
- `src/vehicle-v24/suspension.js`：核对 anti-roll；保留原有恢复力方向。
- `src/vehicle.js`：telemetry 初始化、映射与清理。
- `src/main.js`：仅 devtools 下的生产 fixed-step 链记录与同口径 telemetry。
- `scripts/test-input.mjs`：键盘/触摸/手柄回归。
- `scripts/test-vehicle-v24-playability.mjs`：可玩性行为回归。
- `scripts/test-vehicle-v24-runtime.mjs`：把独立脚刹与持续 S 倒车请求的断言分开；刹停容差由 5 km/h 收紧至 0.05 km/h，不再依赖怠速推力延迟停车。
- `scripts/test-vehicle-v24-golden.mjs`：明确 selected-reference 与 steering parity 边界。
- `scripts/test-vehicle-v24.mjs`：聚合行为回归且保留 referenceParity 的独立状态。
- `docs/V24_PLAYABILITY_STABILIZATION.md`：本记录。
- `docs/verification/v24-playability-production-baseline.json`：真实生产赛道的修复前零输入 telemetry。
- `docs/verification/v24-playability-production-idle.json`：修复后的生产零输入断言和原始样本。
- `docs/verification/v24-playability-working-tree.txt`：继续实施时的完整 working-tree 状态（不冒充开工前快照）。
- `docs/verification/v24-playability-production-keys.json`：生产 W/S 输入链通过样本，以及 A/D 短按未跨采样帧的原始事件与限制。
- `docs/verification/v24-playability-results.json`：命令、退出码、套件数量、关键测量值和状态边界。
- `docs/verification/v24-steering-feedback.json`：方向用户反馈后的红/绿回归、完整修后 JSON 输出和生产版本核对；取代旧记录中的驾驶左右 PASS。

## 根因与对应修复

1. 方向（用户反馈后纠正）：主代理上轮误把 legacy `+X/right` 名称当作驾驶视角的右边，删除了本来必要的 command-to-rack 负号；测试也用了同一个错误基准。实际追尾相机以 +Y 为上、沿 +Z 看前方，屏幕右向为 -X。现在恢复 `oracleCommand = -clamp(streetRushCommand, -1, 1)`，保留固定的 oracle-to-host 机械角度映射；设备语义到 rack 的权威转换仍只在 steering.js，不在 main 或 VehicleSystem 再取反。测试改用真正 `ChaseCamera.snap` 的相机四元数求屏幕右轴。仅改测试基准时，右输入向屏幕左移 0.25798 m，明确 FAIL；修正符号后左右均通过。
2. 高速几乎不转：设备层限幅与 `8.5/(speed²+25)` 叠加。移除重复的设备速度映射，单独保留递减速度辅助、有限 rack 速率/加速度与渐进机械比；没有完全取消高速限制。方向纠正没有改变这条速度辅助曲线。当前策略显式标记 `streetrush-playability-v2-driver-view`，不称为 standalone steering 数值等价。
3. 撞后失去驾驶：FORWARD 状态遭碰撞反弹时，负车速曾被误当作玩家正在倒车，W 变成刹车；改为同时服从已选方向与意图。另一个离合器分支在预测发动机越过零速后仍声称 LOCKED，导致错误残差/事务 abort；现在求解零速边界对应的有限冲量，不在求解后覆盖 RPM 或 wheel omega。
4. 刹车偏航：ESC 原来只看 yaw error，可在低速、少接地点或无有效转向请求时单侧制动。现要求速度超过 5 m/s 并渐入、至少 3 轮接地、有效转向请求。基础脚刹保留同轴左右完全相同的容量。anti-roll 原符号产生恢复力，已保留，不列为根因。测试中也没有用自动 reset 掩盖恢复失败。
5. 无输入偷跑分两层：trigger 的 5% deadzone 原来只参与设备活动判断，没有进入实际踏板数值；现在实际输入也归零/重映射，重连沿用 neutral rearm 并修正菜单重连脉冲。更主要的动力来源已在真实生产赛道证明：输入全零仍有约 39 Nm 轮端驱动。旧 launch-clutch 接合量随微小车速增加，形成接触微扰 → 接合 → 怠速/旋转储能传递 → 加速 → 更大接合的循环。无起步意图且低于当前挡位同步怠速车速时，现在只分离自动离合器容量请求；正常给油起步和路速下发动机制动保留。

车身/墙体碰撞仍由 Rapier 负责；没有改写 body velocity、wheel omega、RPM，也没有新增偷偷 reset。墙体回归使用真正 Rapier 固定碰撞体（friction 0.35、restitution 0.04）。未把未证实的墙面摩擦/轮胎 ray 错误当成根因，也没有改碰撞层来掩盖问题。

## 实际命令与结果

| 命令 | 实际结果 |
| --- | --- |
| `node scripts/test-input.mjs` | PASS，8 个输出分组；含键盘/触摸语义、trigger deadzone、重连握手 |
| `node scripts/test-vehicle-v24.mjs` | 历史执行 exit 0，8 suites / 335 checks；其中旧方向断言基准错误，方向 PASS 已撤回；纠正后未重跑总套件 |
| `node scripts/test-vehicle-v24-playability.mjs` | 本次定点执行两次：只纠正相机基准时 exit 1，复现右输入向左；修正代码后 exit 0，7 场景组 / 100 checks PASS |
| `node --check src/main.js` | PASS，exit 0 |
| `git -c core.whitespace=cr-at-eol diff --check -- src/input.js src/main.js src/vehicle.js scripts/test-input.mjs` | PASS，exit 0；只覆盖已追踪的任务文件 |
| `git -c core.whitespace=cr-at-eol diff --check` | exit 2：非任务文件 `docs/MATERIAL_LIBRARY_AUDIT.md` 两行、`docs/VEHICLE_DATA.md` 一行空白警告；未改它们 |
| `node_modules/.bin/vite --host 127.0.0.1 --port 4173 --strictPort` | 续接时已恢复运行，session 57700；Vite 7.3.6 ready，仅绑定 127.0.0.1:4173 |

正式 `pnpm dev`/完整构建本轮没有重新验证，记 `NOT_RUN`；浏览器使用已有 generated wasm，实测 scheduler owner 为 `rust-wasm`、fallback 为 null。未安装依赖。

反馈前的 335 checks 分布：contract 17、selected-reference 24、Rapier host 53、runtime 102、playability 100、legacy isolation 30、determinism 4、performance 5。这些数量保留为历史，不代表驾驶方向已正确；纠正后的最新定点回归为 100 checks。selected-reference 的 PASS 只限其声明范围；完整 reference parity 仍为 `PARTIAL`，目标标定为 `SKIP_TARGET_DATA`。

旧 runtime 刹车测试持续发送倒车意图却断言 3 秒内不得倒车；去掉怠速推力后约 2.75 秒即停稳，持续 S 随后正常进入倒车。已把独立脚刹与 S 意图分开验证，并把停车容差从 5 km/h 收紧到 0.05 km/h，没有恢复故障来迎合旧时间假设。

## 关键自动测量

以下是方向纠正后重新运行的测量：速度由静止正常给油达到，没有设置车身速度。转向保持 0.5 秒，横移沿开始时生产 ChaseCamera 的屏幕右轴测量（正为画面右，负为画面左），不再使用 legacy `+X/right` 名称：

| 起始速度 | 左输入横移 | 右输入横移 | 接地/自动 reset |
| --- | --- | --- | --- |
| 7.2 km/h | -0.258 m | +0.257 m | 4 轮 / 0 |
| 57.6 km/h | -0.694 m | +0.692 m | 4 轮 / 0 |
| 144 km/h | -0.760 m | +0.786 m | 4 轮 / 0 |

- 对称脚刹容量：前轴 759.5/759.5 Nm，后轴 465.5/465.5 Nm；实际制动最大 yaw rate 0.0091 rad/s，横移约 0.027 m，ESC 未单侧介入。
- 低速 ESC、接地点不足、无有效转向请求的门槛测试 PASS；ARB 恢复力测试 PASS。
- 无输入 3 秒：最大速度 0.00178 km/h，轮端驱动传递全程 0 Nm。
- 固定墙接触 4 点后：保持 W、刹车、S 倒车脱离、W 再前进全部 COMMITTED；离墙倒车约 -2.06 m/s，再前进约 2.95 m/s，自动 reset 为 0。

## 生产页面证据与待验收项

真实页面 `http://127.0.0.1:4173/?devtools` 使用 `TrackSystem`（1024 samples）、生产 InputController、main fixed scheduler、VehicleSystem、v24-active、Rapier、afterPhysics；观察到 V24 唯一施力、legacyForceCalls=0。

方向纠正后本轮再次从正常“开始比赛”进入，DOM telemetry 在 fixedStep 6348 报告 `streetrush-playability-v2-driver-view`、`rust-wasm` scheduler、`TrackSystem`、Rapier/V24 和 afterPhysics。这个无转向输入的样本只证明修正版实际加载，不算生产左右操纵 PASS。下面 W/S 与零输入数据为此前保存的生产证据，不用于替代纠正后的 A/D 验收。

- 修复前零输入：6.3015 km/h，轮端实际驱动 39.404 Nm。独立 10 秒物理复现增长至 6.3871 km/h、前进 13.3183 m。
- 修复后生产零输入：0.00225 km/h，driveIntent/throttle/轮端驱动全为 0；原始 DOM telemetry 已保存。
- W 的 keydown/keyup 跨越实际物理步，随后 afterPhysics 记录 driveIntent=1、rawThrottle=1、轮端驱动约 102.72 Nm；S 对应 service-brake 请求约 291.66 Nm、实际反力矩约 28.61 Nm。两条输入链 PASS。
- 浏览器自动事件的 `isTrusted=false` 已如实保留，不冒充实体硬件认证。A/D 极短自动按键在同一采样间隔内完成，收到事件但未采到持续转向命令，不计 PASS；持续生产 A/D、高速操纵与生产墙体完整手感场景记 `NOT_RUN`/待用户。物理左右方向回归的 PASS 不替代这些生产操纵场景。

当前结论：按真实相机左右基准的本轮 100 项定点回归通过，旧方向 PASS 已撤回；生产持续 A/D 和驾驶手感等待用户重新验收。用户未确认高速转向、刹车、撞墙恢复以前，不宣布游戏完成；收到反馈后继续同一任务修复。

## 前次交接记录（方向反馈前，历史）

- 再次执行 `test -d src/vehicle-v24`，exit 0。启动前 `lsof -nP -iTCP:4173 -sTCP:LISTEN` 为 exit 1（无监听）。直接 Vite 首次因沙箱绑定限制报 EPERM，经一次正常权限申请后启动成功；没有安装依赖或触发 Cargo 构建。
- 用一次只读 Node 命令解析四份结果 JSON：全部成功；汇总仍为 8 suites / 335 checks，生产键盘为 PARTIAL，手感验收为 WAITING_FOR_USER；报告与结果引用的 23 个文件全部存在。此步骤只核对已保存结果，没有重复运行物理测试。
- 首次浏览器加载因服务未监听失败；其错误页被 Browser Use 的 data: URL 策略限制。恢复服务后，在正常 HTTP 新页载入成功，没有更改浏览器安全策略。
- 已显示并保留 `http://127.0.0.1:4173/?devtools`，页面为 MAZDA MX-5 NA / READY / 开始比赛。此为试玩交接，不新增任何操纵 PASS，也不把打开页面等同于手感验收。

## 方向纠正后的本次交接

- 实施文件仅为 steering.js 的命令映射/策略标识及 playability 测试的驾驶相机左右基准；没有改其他动力、碰撞、输入设备或视觉模型代码。
- `v24-steering-feedback.json` 已保存修前 exit 1 与修后 exit 0 的完整结构化输出；新旧 JSON 均解析成功，6 条低/中/高速方向记录都使用实际 ChaseCamera 右轴；旧结果已标记为历史并撤回方向验收。
- 当前游戏页已确认运行纠正版本并显示、保留给用户。latest observed fixedStep 48060 的键盘记录仍为空，因此没有把该页面标为 A/D 实际复试通过。
- 等待用户重新确认方向与驾驶手感；从这个节点继续，不重新研究，不重复运行历史 335 项来代替手感。
