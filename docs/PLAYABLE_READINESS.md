# 可玩版本就绪表

更新日期：2026-08-14。这里回答三个问题：当前已经有什么、还缺什么、接下来怎样把它做成可稳定游玩的一局。范围是本地可玩版本和长期开发基础，不把部署、商业化或继续搜集新研究当作当前阻塞项。

状态含义：**已有**表示生产入口已使用且有自动证据；**部分**表示代码或资料存在但未完整进入生产；**缺失**表示尚无实现；**待实测**表示自动证据不能代替真实浏览器或设备操作。

## 总结

项目已经不是空架子：它有一条可运行的 Three.js/Rapier 单人赛道、六车车库、三圈计时、奖牌/PB、重开与暂停、键盘/手柄/触控输入、程序化音频，以及能同时运行原生和 WASM 的 Rust workspace。`pnpm verify` 已覆盖构建、六车资产、物理、计时、输入、音频生命周期、回放和确定性。

真实浏览器关键路径已经实证：六车都能 READY，MX-5 能开始、暂停/恢复、手动重置、无效圈快速重开并返回车库，且 Rust/WASM scheduler 与 progress owner 正常。当前还不能把“完整一局已玩完”视为实证，因为自动化控制面不能保持油门/转向长按，尚未真实驾驶到完赛；六车视觉细节和样本音频也仍不齐。持续驾驶/完赛是 P0 剩余验收，后两项影响完成度而不阻止先玩。

## 全项目状态

| 方面 | 状态 | 当前已有 | 尚未完成 / 证据边界 | 对先玩起来的影响 |
| --- | --- | --- | --- | --- |
| 游戏循环 | 已有，关键路径实测通过 | 车库选车、倒计时、三圈、检查点顺序、无效圈、分段/圈速/PB、奖牌、完赛、快速重开；浏览器已验证开始、计时、暂停、重置、重开、返库 | 尚未通过持续驾驶完成三圈，完赛/PB 仍只有自动证据 | 持续驾驶到完赛是剩余 P0 验收 |
| 赛道 | 已有 | 一条约 2.13 km 封闭赛道、路面/路肩/草地/护栏、10 检查点、刹车点和转向提示 | 没有第二赛道；当前也不需要 | 不阻塞 |
| 六车加载 | 已有，浏览器 READY 通过 | 六个生产 GLB、缩放/落地校准、缓存、相邻预载、超时/中止/失败回退、结构与资产检查；浏览器逐车切换和返回 MX-5 cache 均成功 | 仍需逐车视觉检查材质、朝向、相机和长时内存 | 不阻塞；视觉验收未完 |
| 车轮视觉 | 部分 | M3 使用生成轮组；MX-5 使用真实模型的 exact manifest/pivot，并接入生产配置；两者由 VehicleSystem 驱动转向、悬挂和滚动 | GT3 RS、LP700、AMG GT3、M5 的模型轮组仍为静态；MX-5 仍需浏览器视觉确认 | 不阻塞驾驶；影响六车完成度 |
| 车辆物理 | 已有（simcade） | Rapier 刚体、四轮射线、弹簧/阻尼、防倾、轮胎、ABS/TCS、AT/MT、RWD/AWD、路面差异、六车参数与回归 | 不是工程级实车复现；高阶研究数据没有直接替换生产参数，复杂物理仍在 JS | 不阻塞；主车手感需要实际试玩调校 |
| 输入 | 已有，部分实测 | 键盘、手柄包装、Pointer Events 多点触控、横屏提示、全屏、pause 时 releaseAll；浏览器触控 reset 已到达比赛并使当前圈无效 | 当前浏览器自动化只能发短脉冲，不能保持油门/转向；键盘/手柄/手机实际试玩矩阵未完成 | 持续驾驶输入是验收阻塞；其他设备随后验证 |
| 音频 | 部分 | 生产有六车差异化程序化发动机声、风/路/胎噪、换挡瞬态、暂停/恢复；bank 选择、严格 loader、取消/失败回退已有测试；浏览器 pause gate 在暂停时为 true、恢复后为 false | decoded sample bank 播放与负载/RPM 分层没有接入 `ProceduralAudio`；本轮未做人耳听感验收 | 不阻塞先玩；明显影响质感 |
| Rust 原生/WASM | 已有共享骨架 | Cargo workspace、`streetrush-core`、原生 probe、raw WASM；固定步、输入、计时/进度、遥测/回放数据切片有 native/WASM 对照 | Three/Rapier 车辆动力学仍由 JS 拥有；不要为形式重写。生产计时/物理的更多 owner 迁移需逐段证明 | 不阻塞 |
| 确定性/回放 | 已有核心证据 | 固定步、固定种子、多车 replay、长序列 timing lifecycle、异常数值和 reset 回归 | 还没有玩家可操作的回放 UI；浏览器长时资源占用需观察 | 不阻塞先玩；是长期稳定性工作 |
| 资源生命周期 | 已有自动证据和短 smoke | GLB pending/cache/preload、加载中止、fallback、视觉资源释放、音频请求所有权都有测试；浏览器六车切换、MX-5 cache 回返、restart 通过 | 后台/恢复、长时循环后的内存和 WebAudio 节点数未实测 | 不阻塞短局，长时继续验证 |
| 构建 | 已有 | `pnpm dev`、`pnpm build`、Rust/WASM 构建与一键 `pnpm verify` | 当前不把部署、发布标签和公共授权当作本地可玩阻塞 | 不阻塞本地游玩 |
| 浏览器 smoke | 部分通过 | 本地 Vite 页面零 console warning/error；六车 READY；MX-5 四 wheel bindings；Rust/WASM owners；暂停冻结、恢复、reset invalidation、快速重开、返库均通过 | 自动化无法保持驾驶输入，尚未跑到检查点/完赛；只观察了 MX-5 车库画面 | 持续驾驶/完赛仍是 P0 |
| 公共发布 | 受阻但非当前目标 | 有尺寸、秘密与素材清单门禁 | Lamborghini 授权未知；两车为 CC BY-NC-SA，商业发布不可用 | 不影响本地制作，不在当前优先级 |

## 六辆车逐车状态

| 车辆 | 模型/加载 | 物理差异 | 车轮动画 | 生产声音 | 样本声音候选 |
| --- | --- | --- | --- | --- | --- |
| MX-5 NA | 生产 GLB，真实 loader 结构已锁定 | 990 kg、116 hp、RWD、较软悬挂 | 真实四轮 exact binding 已接生产，待浏览器观察 | I4 程序化 | B6 兼容代理，非精确录音 |
| BMW M3 E30 | 生产 GLB | 1200 kg、200 hp、RWD | 生成四轮已接生产 | I4 程序化 | S14 家族候选 |
| Porsche GT3 RS | 生产 GLB | 1450 kg、525 hp、RWD、高抓地 | 未绑定，模型轮静态 | Flat-6 程序化 | 992 家族候选 |
| Lamborghini LP700 | 生产 GLB | 1680 kg、700 hp、AWD | 未绑定，模型轮静态 | V12 程序化 | L539 家族候选 |
| Mercedes-AMG GT3 | 优化生产 GLB | 1285 kg、550 hp、RWD、最高抓地 | 未绑定，模型轮静态 | V8 程序化 | M159 非精确代理 |
| BMW M5 G90 | 优化生产 GLB | 2435 kg、727 hp、AWD | 未绑定，模型轮静态 | V8 程序化 | S68 非精确代理 |

## `research-salvage` 的价值

这个目录有意义，但定位应保持为候选输入，而不是一次性应用的补丁。当前共 91 个文件、8,779,760 bytes。

- 音频：六辆车各一套候选 bank，每套包含三个 RPM 锚点的 on/off-load 六个 44.1 kHz 单声道循环，共 36 个 WAV；bank manifest 已标记 loop approved。它们足以做第一版样本发动机声，但都是 prototype/generated，其中 MX-5、AMG、M5 明确是非精确代理。
- 运行时代码：包含 decoded buffer registry、分层 playback-rate、RPM/负载 blend 和旧 Street Rush adapter。当前项目已经采用了更小的 bank coordinator 与严格 loader；真正缺少的是把已解码层接到当前 master/pause/fallback 图中。旧 adapter 不应整包覆盖当前音频生命周期。
- 物理：projection 只有 21 个通过原研究筛选的字段，且多数和 `src/config.js` 重合；AMG 为 0 项。MX-5 弹簧推导是 coil rate，不是 wheel rate，缺 motion ratio、安装角、预载、bump stop 和完整力曲线，因此不能直接替换车辆悬挂。
- 采用条件：样本音频集成时只复制 `selection.json`、六个 `bank.json` 和实际 WAV 到生产资源目录，并为每辆车显式登记；物理值只有在生产 owner、单位、工况和误差测试都明确时才逐字段采用。

## 2026-08-14 浏览器 smoke 证据

- 本地 `http://127.0.0.1:5173/?devtools=1` 正常打开；车库 MX-5 模型、赛道、UI 和开始按钮可见，console 无 warning/error。
- 六车按顺序切换均得到 `READY`、正确 mounted id、正确名称和 enabled start；M3/MX-5 各 4 个 visual bindings，GT3/LP700/AMG/M5 为 0，返回 MX-5 后来源仍为 `manifest:mx5`。
- 页面实际使用 `physicsSchedulerOwner=rust-wasm`、`raceProgressCoreOwner=rust-wasm`；开始后倒计时结束，比赛计时递增。
- 暂停前后计时保持 `01:27.183` 且 `audioPaused=true`；恢复后为 `01:28.033` 且 `audioPaused=false`。
- 触控 reset 后显示 `RESET · LAP INVALID`、圈状态 `INVALID`、快速重开按钮出现；重开后圈状态回到 `VALID`、计时从 `00:01.058` 重新开始。返回车库后 MX-5 仍 READY。
- 限制：45 次自动化短油门 pulse 未形成持续输入，速度仍为 0。这说明该控制面不能替代按住操作，不说明游戏输入失败；持续油门/转向和完整一局仍待人工或支持 keydown/keyup 的驱动验收。

## 剩余工作与顺序

### P0：证明一局真的能玩

1. **已完成**：构建并启动当前生产入口；本轮实际使用 Rust/WASM owner，车库未被阻断。
2. **部分完成**：MX-5 的车库载入、开始、暂停/恢复、重置、重开和返库通过；仍需持续油门/转向/制动并跑到完赛，检查人耳声音与动态轮组。
3. **部分完成**：六个 GLB 都 READY 且可开始；仍需逐车观察材质、朝向、相机并实际起步。

### P1：完成六车表现

1. 给剩余四车建立真实模型结构 manifest；只有 exact mapping 通过真实 loader 后才接轮组，不用名字猜测。
2. 从 salvage 接一辆主车的 decoded bank 到当前音频图，验证切车取消、暂停/恢复、decode 失败回到程序化，再扩到六车。
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
