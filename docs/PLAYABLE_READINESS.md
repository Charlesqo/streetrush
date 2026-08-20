# 可玩版本就绪表

更新日期：2026-08-14。这里回答三个问题：当前已经有什么、还缺什么、接下来怎样把它做成可稳定游玩的一局。范围是本地可玩版本和长期开发基础，不把部署、商业化或继续搜集新研究当作当前阻塞项。

状态含义：**已有**表示生产入口已使用且有自动证据；**部分**表示代码或资料存在但未完整进入生产；**缺失**表示尚无实现；**待实测**表示自动证据不能代替真实浏览器或设备操作。

## 总结

项目已经不是空架子：它有一条可运行的 Three.js/Rapier 单人赛道、六车车库、三圈计时、奖牌/PB、重开与暂停、键盘/手柄/触控输入、六车分层候选样本声及逐车程序化回退，以及能同时运行原生和 WASM 的 Rust workspace。`pnpm verify` 已覆盖构建、六车资产、物理、计时、输入、音频加载/播放/回退生命周期、回放和确定性。

真实浏览器关键路径已经实证：六车都能 READY，MX-5 能开始、暂停/恢复、手动重置、无效圈快速重开并返回车库，GT3 RS 与 LP700 也能开始、暂停/恢复、返库和缓存往返，且 Rust/WASM scheduler 与 progress owner 正常；六套候选 WAV 也都已被浏览器真实获取、解码和逐车发布，车库回环后能重新加载。当前还不能把“完整一局已玩完”视为实证，因为自动化控制面不能保持油门/转向长按，尚未真实驾驶到完赛；生产动态轮组是 4/6，AMG 已有真实 loader 候选但未接生产且精确卡钳受优化合并阻断，M5 尚无候选；人耳听感、后台/移动设备成本和设备矩阵也仍不齐。持续驾驶/完赛是 P0 剩余验收，其余项目影响六车完成度而不阻止先玩。

## 完整目标与完成定义

当前长目标是把“单人三圈计时赛作为一款可反复游玩的六车赛车游戏”所需准备做完整。它不是只做一个技术 demo，也不以增加赛道、AI 对手、联网、部署或商业包装来不断扩大范围。所有项目保持四种状态：已完成、部分完成、未完成、受阻；只有生产入口实际使用并有自动或浏览器证据，才算已完成。

| 完成域 | 已经具备 | 仍需做到才算这一域完整 |
| --- | --- | --- |
| 一局闭环 | 选车、倒计时、驾驶状态、检查点、三圈、奖牌/PB、暂停、重置、重开、返库都有实现和自动测试 | 用可保持输入的键盘/手柄/触控真实跑过检查点和三圈完赛；确认失败、无效圈、PB 保存和再次开局的可见结果 |
| 六车可用 | 六车均能加载、READY、获得独立物理参数并开始；加载失败有 fallback | 六车逐台实驾，确认朝向、落地、碰撞、相机、材质、性能和起步；不能只凭文件结构判定 |
| 六车动态视觉 | M3 生成轮组、MX-5 精确模型轮组、GT3 RS split 精确轮组和 LP700 四材质/16 部件三角切分已有生产运行时 owner；后三者均通过真实 loader，且浏览器报告 4 bindings。AMG 优化 GLB 的 4 材质/16 部件候选也已通过真实 loader、中心/计数、原子失败和 Rapier owner 对照 | AMG 候选尚未进入生产/浏览器；优化器把卡钳并入大型 palette mesh，当前只可让盘随轮滚动、卡钳保持原静态模型。M5 尚无当前优化 GLB 映射；仍需人工近看生产动态轮组及灯光、刹车件和车身动态 |
| 六车声音 | 所有车的六层候选 bank 已显式登记、接入并有逐车程序化失败回退；六车浏览器解码、M5 暂停恢复和多轮切换释放通过 | 人耳验证循环接缝、负载/RPM 过渡、响度与真实性；实测后台恢复和移动设备成本；候选授权未解决前保持本地试验状态 |
| 驾驶与物理 | 六车 simcade 参数、四轮射线、悬挂/轮胎、ABS/TCS、AT/MT、路面和完整数值回归都在 | 以主车实驾校准起步、制动、转向、抓地极限和恢复；研究数据只有单位、owner、工况和误差门槛明确时才采用 |
| 输入与设备 | 键盘、手柄、触控、横屏、全屏、失焦/断连/rearm 和 fixed-pulse 契约有测试 | 建立至少键盘、常见手柄、手机横屏三类人工矩阵；完成持续按键、同时转向/油门、后台恢复和触控多指实测 |
| Rust 共享核心 | Cargo workspace、原生 probe、raw WASM，以及固定步、比赛进度、遥测/回放数值契约已实用化 | 保持同一核心的 native/WASM 一致；按证据迁移更多纯状态规则。原生目标还不是完整渲染游戏，不能把 probe 当成最终原生版本 |
| 稳定性与可诊断性 | 资产取消/超时/late dispose、音频 stale/fallback、reset、异常数值、固定 seed、长序列 timing soak 都有门禁 | 浏览器长时六车切换/重开/后台恢复，观察内存、WebAudio 节点和帧耗时；建立玩家可取用的遥测/回放入口和失败聚类 |
| 内容与体验 | 一条 2.13 km 赛道、路线提示、HUD、奖牌目标和说明已在 | 完成真实试玩后的目标时间、相机、提示、默认辅助和声音平衡调整；第二赛道、AI/联网不是本阶段完成条件，只记录为未来候选 |
| 工程与资料 | 一键 verify、来源台账、实验日志、资产清单、构建/秘密门禁均有 | 每批继续保持小提交和来源记录；公共/商业发布受素材授权阻塞，但发布、部署与商业包装不是当前执行目标 |

## 全项目状态

| 方面 | 状态 | 当前已有 | 尚未完成 / 证据边界 | 对先玩起来的影响 |
| --- | --- | --- | --- | --- |
| 游戏循环 | 已有，关键路径实测通过 | 车库选车、倒计时、三圈、检查点顺序、无效圈、分段/圈速/PB、奖牌、完赛、快速重开；浏览器已验证开始、计时、暂停、重置、重开、返库 | 尚未通过持续驾驶完成三圈，完赛/PB 仍只有自动证据 | 持续驾驶到完赛是剩余 P0 验收 |
| 赛道 | 已有 | 一条约 2.13 km 封闭赛道、路面/路肩/草地/护栏、10 检查点、刹车点和转向提示 | 没有第二赛道；当前也不需要 | 不阻塞 |
| 六车加载 | 已有，浏览器 READY 通过 | 六个生产 GLB、缩放/落地校准、缓存、相邻预载、超时/中止/失败回退、结构与资产检查；浏览器逐车切换和返回 MX-5 cache 均成功 | 仍需逐车视觉检查材质、朝向、相机和长时内存 | 不阻塞；视觉验收未完 |
| 车轮视觉 | 部分 | M3 使用生成轮组；MX-5 使用 schema v1 exact manifest；GT3 RS 使用 schema v2 split tire/rim/disc/caliper；LP700 使用 schema v3 四材质 triangle split；四车均接生产并由 VehicleSystem 驱动转向、悬挂和滚动。AMG 已有 hash-scoped schema v3 候选及真实 loader/Rapier 证据 | AMG 仍未 production/browser opt-in，且卡钳被优化合并、只能暂留静态；M5 尚无候选。MX-5/GT3/LP700 运行 owner 已由浏览器确认，但动态画面仍需人工近看 | 不阻塞驾驶；影响六车完成度 |
| 车辆物理 | 已有（simcade） | Rapier 刚体、四轮射线、弹簧/阻尼、防倾、轮胎、ABS/TCS、AT/MT、RWD/AWD、路面差异、六车参数与回归 | 不是工程级实车复现；高阶研究数据没有直接替换生产参数，复杂物理仍在 JS | 不阻塞；主车手感需要实际试玩调校 |
| 输入 | 已有，部分实测 | 键盘、手柄包装、Pointer Events 多点触控、横屏提示、全屏、pause 时 releaseAll；浏览器触控 reset 已到达比赛并使当前圈无效 | 当前浏览器自动化只能发短脉冲，不能保持油门/转向；键盘/手柄/手机实际试玩矩阵未完成 | 持续驾驶输入是验收阻塞；其他设备随后验证 |
| 音频 | 部分 | 六车六层 decoded bank 均已接入 RPM/负载混合，逐车保留程序化发动机、风/路/胎噪和换挡瞬态回退；浏览器六车加载/解码/回环、M5 暂停恢复、4 轮六车资源 soak 和 503 重试通过 | 尚无人耳听感、系统后台恢复和移动设备成本验收；候选 WAV 授权未清 | 不阻塞先玩；仍影响声音可信度与公共发布 |
| Rust 原生/WASM | 已有共享骨架 | Cargo workspace、`streetrush-core`、原生 probe、raw WASM；固定步、输入、计时/进度、遥测/回放数据切片有 native/WASM 对照 | Three/Rapier 车辆动力学仍由 JS 拥有；不要为形式重写。生产计时/物理的更多 owner 迁移需逐段证明 | 不阻塞 |
| 确定性/回放 | 已有核心证据 | 固定步、固定种子、多车 replay、长序列 timing lifecycle、异常数值和 reset 回归 | 还没有玩家可操作的回放 UI；浏览器长时资源占用需观察 | 不阻塞先玩；是长期稳定性工作 |
| 资源生命周期 | 已有自动证据和短 smoke | GLB pending/cache/preload、加载中止、fallback、视觉资源释放、音频请求所有权都有测试；浏览器六车切换、MX-5 cache 回返、sample bank 切车释放/切回重载和 restart 通过 | 后台/恢复、长时循环后的内存和 WebAudio 节点数未实测 | 不阻塞短局，长时继续验证 |
| 构建 | 已有 | `pnpm dev`、`pnpm build`、Rust/WASM 构建与一键 `pnpm verify`；当前为 44 modules、4,864-byte WASM、66 files/84.69 MiB | 候选通用化后 main 为 509.72 kB、secret scan 为 277 files；仍有既有大 chunk warning。当前不把部署、发布标签和公共授权当作本地可玩阻塞 | 不阻塞本地游玩；后续按实际加载收益判断拆包 |
| 浏览器 smoke | 部分通过 | 本地 Vite 页面零 console warning/error；六车 READY；MX-5、GT3、LP700 均有四 wheel bindings；Rust/WASM owners；暂停冻结、恢复、reset invalidation、快速重开、返库及 GT3/LP700 cache 往返均通过 | 自动化无法保持驾驶输入，尚未跑到检查点/完赛；材质、轮组运动和相机仍缺人工视觉验收 | 持续驾驶/完赛仍是 P0 |
| 公共发布 | 受阻但非当前目标 | 有尺寸、秘密与素材清单门禁 | 当前 public blockers=43、commercial blockers=45；42 项六车候选音频文件和 Lamborghini 模型未清，另有两车非商业限制 | 不影响本地制作，不在当前优先级 |

## 六辆车逐车状态

| 车辆 | 模型/加载 | 物理差异 | 车轮动画 | 生产声音 | 样本声音候选 |
| --- | --- | --- | --- | --- | --- |
| MX-5 NA | 生产 GLB，真实 loader 结构已锁定 | 990 kg、116 hp、RWD、较软悬挂 | 真实四轮 exact binding 已接生产，待动态视觉观察 | 六层 B6 兼容代理 + 程序化回退 | 非精确、生成型候选；浏览器 decode 通过，听感/授权未验收 |
| BMW M3 E30 | 生产 GLB | 1200 kg、200 hp、RWD | 生成四轮已接生产 | 六层 S14 家族候选 + 程序化回退 | 浏览器 decode 通过，精确版本/听感/授权未验收 |
| Porsche GT3 RS | 生产 GLB，真实 loader 结构已锁定 | 1450 kg、525 hp、RWD、高抓地 | split schema v2 精确四轮已接生产；tire/rim/disc roll，caliper 留在 carrier；浏览器运行 owner 通过 | 六层 992 flat-six 候选 + 程序化回退 | 浏览器 decode 通过，非当前资产精确录音 |
| Lamborghini LP700 | 生产 GLB，与研究/素材 runtime exact | 1680 kg、700 hp、AWD | schema v3 四材质/16 部件三角切分已接生产；真实 loader、浏览器 4 bindings 与 cache 往返通过 | 六层 L539 候选 + 程序化回退 | 浏览器 decode 通过，SVJ 派生且非精确 |
| Mercedes-AMG GT3 | glTF-Transform 4.4.1 优化生产 GLB | 1285 kg、550 hp、RWD、最高抓地 | 生产仍静态；schema v3 候选已从当前优化 GLB 精确切出 tire/rim/rim-blur/disc 四轮，真实 loader/Rapier 通过；卡钳受 palette merge 阻断，候选未接生产 | 六层 M159 兼容代理 + 程序化回退 | 浏览器 decode 通过，非精确且授权未验收 |
| BMW M5 G90 | 优化生产 GLB | 2435 kg、727 hp、AWD | 未绑定，模型轮静态 | 六层 S68 兼容代理 + 程序化回退 | 浏览器 decode 通过，非精确且授权未验收 |

## `research-salvage` 的价值

这个目录有意义，但定位应保持为候选输入，而不是一次性应用的补丁。当前共 91 个文件、8,779,760 bytes。

- 音频：六辆车各一套候选 bank，每套包含三个 RPM 锚点的 on/off-load 六个 44.1 kHz 单声道循环，共 36 个 WAV；bank manifest 已标记 loop approved。它们足以做第一版样本发动机声，但都是 prototype/generated，其中 MX-5、AMG、M5 明确是非精确代理。
- 运行时代码：包含 decoded buffer registry、分层 playback-rate、RPM/负载 blend 和旧 Street Rush adapter。当前项目已重新实现较小的 `LayeredEngineBankPlayer` 并把 MX-5 接到现有 master/pause/fallback 图；没有整包覆盖旧 adapter。shared decoded registry 是否值得采用，留给六车长时切换的内存证据决定。
- 物理：projection 只有 21 个通过原研究筛选的字段，且多数和 `src/config.js` 重合；AMG 为 0 项。MX-5 弹簧推导是 coil rate，不是 wheel rate，缺 motion ratio、安装角、预载、bump stop 和完整力曲线，因此不能直接替换车辆悬挂。
- 采用进度：六车各复制 `bank.json` 和六个 WAV，共 42 个运行时文件/7,965,590 bytes，逐字节 hash 与 archive 一致；每辆车只登记自己的显式 family candidate，不按相同 I4/V8 家族猜测。物理值仍只有在生产 owner、单位、工况和误差测试都明确时才逐字段采用。
- 验证结果：`pnpm test:research-salvage` 实读六 bank、36 WAV（7,939,584 bytes）、prepared hashes、loop gates、格式/非静音/非满幅，以及 21 个物理字段。测试先抓到 MX-5 I4 和 M5 V8 的 `analysis.json` 都误写为 6 缸并使用错误点火频率；当前项目副本已改为 4/8 缸并重算相关字段，WAV 与 bank claims 未变。

## 2026-08-14 浏览器 smoke 证据

- 本地 `http://127.0.0.1:5173/?devtools=1` 正常打开；车库 MX-5 模型、赛道、UI 和开始按钮可见，console 无 warning/error。
- 六车按顺序切换均得到 `READY`、正确 mounted id、正确名称和 enabled start；初次 baseline 中 M3/MX-5 各 4 个 visual bindings，GT3/LP700/AMG/M5 为 0，返回 MX-5 后来源仍为 `manifest:mx5`。随后 GT3 production 批次把 GT3 升级为 4 个 bindings，证据见下节。
- 页面实际使用 `physicsSchedulerOwner=rust-wasm`、`raceProgressCoreOwner=rust-wasm`；开始后倒计时结束，比赛计时递增。
- 暂停前后计时保持 `01:27.183` 且 `audioPaused=true`；恢复后为 `01:28.033` 且 `audioPaused=false`。
- 触控 reset 后显示 `RESET · LAP INVALID`、圈状态 `INVALID`、快速重开按钮出现；重开后圈状态回到 `VALID`、计时从 `00:01.058` 重新开始。返回车库后 MX-5 仍 READY。
- 限制：45 次自动化短油门 pulse 和一次按钮内 pointer drag 都未形成持续输入，速度仍为 0。这说明该控制面没有可用的按住语义，不说明游戏输入失败；持续油门/转向和完整一局仍待人工或支持 keydown/keyup 的驱动验收。

## 2026-08-14 MX-5 样本音频浏览器证据

- 初始车库在 AudioContext 尚未因用户手势创建前报告 `pending-init`；开始比赛后真实获取 manifest 和 6 个 WAV，WebAudio 解码完成并发布 `bank.candidate.i4.mazda-b6-compatibility-proxy`，状态为 `ready/family`。
- 样本播放器使用三个 RPM 锚点和 on/off-load 两层混合；激活时只静音原程序化发动机主声道，路噪、风噪、胎噪和现有全局 master/pause gate 保持。
- 暂停时 `audioPaused=true` 且 bank 继续保持 `ready`，恢复为 false；切到 M3 后状态为 `procedural`、bank id 清空并释放 decoded value，切回 MX-5 后重新加载并恢复 `ready`。
- HTTP 503、manifest/loop 不合格和 attach 失败都有自动失败路径，结果是保留程序化发动机而不是让整车静音；实际浏览器 console warning/error 为 0。
- 证据边界：自动混合断言不能代替听感。循环接缝、转速过渡、响度、音色真实性和手机性能仍未验收；该 bank 是非精确生成型候选，不能据此声称拥有可公开发布的 MX-5 实录。

## 2026-08-14 六车样本音频扩展证据

- production registry 把六个 vehicle id 显式映射到六个 bank id、family、asset version 和独立 URL；测试逐车把 profile 解析到唯一候选，并核对 production/archive 文件集合与 SHA-256。
- 4 轮六车 runtime soak 完成 25 次成功 attach、175 次实际文件读取和 150 个 BufferSource；插入一次 LP700 manifest HTTP 503 后先回退程序化、随后重试成功。dispose 后 150 个样本源都恰好 stop/disconnect 一次。
- 真实浏览器按 MX-5→M3→GT3 RS→LP700→AMG GT3→M5→MX-5 顺序全部为 `ready/family` 且 bank id 正确；M5 比赛内暂停为 `audioPaused=true`、恢复为 false，bank 始终 ready；console warning/error 为 0。
- 许可边界同步扩大：机器清单覆盖 52 个素材文件，42 个候选音频文件都明确为 `UNKNOWN-GENERATED-PROTOTYPE`，所以 public/commercial 门禁仍按预期阻止发布。

## 2026-08-14 GT3 RS 轮组 production/browser 证据

- `PRODUCTION_WHEEL_MANIFESTS` 现在只显式登记已通过真实 loader 的 `mx5` 与 `gt3rs`；LP700、AMG、M5 没有因名称相似或研究报告存在而被猜测接入。
- 真实 GT3 GLB 生产工厂验证四个 wheel binding、缓存双实例对象独立/geometry 共享、VehicleSystem/Rapier owner、reset，以及缺 RR caliper 时结构化原子 fallback；MX-5 schema v1 回归保持通过。
- 真实浏览器从 MX-5→M3→GT3 切换得到 `mountedCarId=gt3rs`、`visualWheelBindingCount=4`、`visualWheelSource=manifest:gt3rs`。开始 GT3 比赛后 Rust/WASM scheduler、race progress/timing owner 与 flat-six bank 同时 ready。
- GT3 比赛暂停时 `audioPaused=true`，恢复后为 false 且计时继续；退出车库后 MX-5→GT3 缓存往返仍分别得到 `manifest:mx5`/`manifest:gt3rs` 和 4 bindings；console warning/error 为 0。
- 证据边界：浏览器诊断证明生产接线和生命周期，不代替人眼判断 tire/rim/disc/caliper 的动态画面、材质、转向方向、悬挂幅度或相机遮挡；这些仍列入逐车实驾验收。

## 2026-08-14 LP700 三角切分候选证据

- production、模型研究 isolation 与素材 runtime 三份 11,269,432-byte GLB SHA-256 均为 `6489a809...c85d8a`。模型没有四个独立轮分支，而是 `Disk/Frein/Jante/Pneu` 四个各覆盖全车四轮的网格；直接套 schema v1/v2 或名字猜测都不成立。
- 失败优先测试先稳定得到 `unsupported wheel manifest schema 3`。候选独立模块随后按 tire triangle centroid 做 18 轮 k-means，再用相同四个 cluster 切分四种材质；manifest 锁定源名字/材质、每轮 675 个 tire triangles、四种 split vertex counts 和 2 µm pivot 容差。
- 真实 GLTFLoader 得到 4 source meshes→16 split meshes，四种材质整体 bounds 误差 `<1e-8`；组合转向/正反滚动轮心误差 `<1e-8`；clone geometry 共享、实例对象独立、VehicleSystem/Rapier、悬挂和 reset 通过。
- 故意把 Jante 计数改错会在任何 scene mutation 前失败：没有 `calibrated-wheels`、四个源网格仍可见，临时 split geometries 已 dispose。Node 实测新增 geometry 6,654,336 bytes，单次切分约 48–64 ms，13 个纹理限制仍只代表 Node image decode 缺失。
- 候选阶段 splitter 放在 production 未导入的独立模块。一次试放通用 binder 曾使 main chunk 498.37→504.45 kB；隔离后恢复 498.37 kB、84.68 MiB，证明 opt-in 边界有效。随后独立 production/browser 批次才显式加入 registry/dispatcher。
- production browser：GT3→LP700 从点击到 mounted/4 bindings/start enabled 约 284 ms；车库截图未见明显轮组缺洞或错位。比赛中 Rust/WASM scheduler/progress/timing、V12 bank 和 `manifest:lp700` 同时 ready；pause/resume 为 `audioPaused true→false`。
- 三轮 GT3↔LP700 cache 往返约 280–294 ms，双方始终为正确 manifest/4 bindings，LP700 bank 保持 ready，console warning/error=0。自动截图分辨率不足以判断刹车细节、旋转方向和悬挂幅度，因此这些仍是人工近看项；production opt-in 因当前证据保留。
- 最终完整 `pnpm verify` 通过：44 modules、508.99 kB main、4,864-byte WASM、66 files/84.69 MiB、275-file secret scan；六车物理/音频、18 deterministic traces、1,320-action timing soak 与资产许可门禁均保持。

## 2026-08-14 AMG GT3 优化派生轮组候选证据

- 当前 public/NAS committed AMG 为 9,636,232 bytes、SHA-256 `af1f9580...cbf7`；研究 source/material runtime 为 33,004,208 bytes、SHA-256 `649ec857...451f`。生产文件由 glTF-Transform 4.4.1 把 `540 nodes/166 meshes` 优化为 `51/51`，302,492 triangles 保持，因此没有复用 source node id 或 source pivot。
- 失败优先证据先推翻三个假设：既有 schema 3 只接受 LP700 固定角色；AMG 前轮 tire 实际为 1,152 triangles 而非假定的统一 1,200；source 前轮中心 `±0.826071` 与当前生产 `±0.815443` 相差约 10.6 mm。候选改为角色/运动声明和逐轮计数，并锁定当前生产几何中心，容差 2 µm。
- 真实 GLTFLoader 从 `EXT_Disc`、palette rim、rim-blur 和 tyre 四个全车网格切出 16 parts；每轮 disc/rim/rim-blur 分别为 `1,344/24,306/7,200` vertices，轮胎为前 `3,456`、后 `3,744`。整体 indices 全部守恒，转向、正反滚动、悬挂/reset、clone sharing/instance isolation 与 VehicleSystem/Rapier owner 通过。
- 原子失败测试故意破坏 rim 计数后得到无 wheel container、源 mesh 可见且临时 geometry 已释放；候选新增 geometry 2,642,304 bytes，Node 本轮约 88.3 ms。36 个 texture decode limitations 是 Node 环境限制，不当作浏览器材质通过。
- 受阻项：source 有独立 caliper，但优化 public 已移除 `EXT_Calipers*` 材质并并入大型 palette mesh；当前没有可验证的 exact partition，候选显式只让 disc/rim/tire roll，原模型卡钳继续静态。重新评估条件是取得可复现的 dynamic-partition 优化 pipeline，或为 palette mesh 建立带真实 loader/视觉对照的精确分区。
- 未完成项：`amggt3` 仍不在 production registry，尚未做真实浏览器 mounted/4 bindings、画面、比赛、音频、暂停/恢复和 cache soak。完整候选回归通过：44 modules、509.72 kB main、4,864-byte WASM、66 files/84.69 MiB、277-file secret scan；M5 仍没有优化 GLB 轮组候选。

## 剩余工作与顺序

### P0：证明一局真的能玩

1. **已完成**：构建并启动当前生产入口；本轮实际使用 Rust/WASM owner，车库未被阻断。
2. **部分完成**：MX-5 的车库载入、开始、暂停/恢复、重置、重开和返库通过；GT3 的开始、暂停/恢复、返库和缓存往返也通过。仍需持续油门/转向/制动并跑到完赛，检查人耳声音与动态轮组。
3. **部分完成**：六个 GLB 都 READY 且可开始；仍需逐车观察材质、朝向、相机并实际起步。

### P1：完成六车表现

1. **GT3 RS 与 LP700 production/browser 接线已完成**；**AMG exact 当前生产几何候选已通过真实 loader，但 production/browser 接线未做，卡钳精确分区受优化合并阻断**；**M5 仍无候选**。下一批先用 AMG 做显式 production/browser 保留或撤回决策，再建立 M5 当前优化 GLB 映射；不按名字或 source node id 猜测。
2. **六车运行时接入已完成**：六个 decoded bank 已用同一显式接口接入并验证逐车加载、暂停、切换释放、回环重载和 HTTP 失败回退；剩余是人耳听感、后台/移动设备成本和授权验收，不再重复扩展同格式 bank。
3. 用键盘、常见手柄和一台手机完成一局；记录可重复的设备矩阵和性能降级结果。

### P2：让手感和长期核心继续变好

1. 以 MX-5 为主车做加速、制动、极速、定圆和实际试玩调校；研究物理只作为可追溯 oracle。
2. 继续把确定的规则/状态 owner 迁到 Rust，共享 native/WASM；Three 渲染、WebAudio 与已工作的 Rapier 路径按收益决定是否保留。
3. 做浏览器长时六车切换、固定种子回放和资源观测；相同失败聚类，不用重复日志代替结论。

## 当前验证命令

```powershell
pnpm test:wheel-loader
pnpm verify
pnpm dev
```

自动测试通过只证明代码与数据契约；只有 P0 的真实浏览器路径完成后，才把“当前构建可玩”从准备状态改为已验证。
