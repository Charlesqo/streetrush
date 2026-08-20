# 晴空环线 · Street Rush 1.0 范围（当前构建）

本仓库以现有 Three.js/Rapier 可玩版本为产品基线，正在逐步建立 Rust 共享核心。网页渲染、UI、移动输入和音频暂时保留；跨运行时的状态、规则、计时、遥测、回放和工具逻辑将按可验证的小切片迁入 Rust。

使用 Three.js、Rapier 和现有六辆 GLB 车辆制作的单人浏览器 3D 赛车小游戏。当前版本定位为“拟真骨架、容易上手”的 simcade：一条按当前 Catmull-Rom 赛道几何测得约 2.13km 的现代封闭赛道、三圈计时、六辆差异化车辆和完整车库/比赛/完赛流程。`package.json` 的 `1.0.0` 是本隔离包的版本元数据，界面里的 `v0.3` 保留为系统基线编号。

线上地址：<https://street.charlesq.net>

这个目录是从原项目复制出的独立 Studio 工作区。原始项目和素材库没有被修改。发布版只打包游戏实际使用的六辆车和两张赛道贴图；BMW M5 G90 与 Mercedes-AMG GT3 使用了网页传输优化副本，未覆盖的原始模型保存在 `source-models/`。

当前已做、未做和通向可玩版本的顺序见 `docs/PLAYABLE_READINESS.md`；1.0 范围见 `docs/SCOPE.md`，仓库与发布流程见 `docs/RELEASE.md`，素材授权状态见 `docs/ASSET_LICENSES.md`。Lamborghini 模型目前没有可验证许可证，因此新的公开发布被门禁阻止；商业发布还必须解决 Lamborghini 未知授权，并替换两辆 CC BY-NC-SA 车辆。

## 工作区边界

- `E:\Projects\streetrush`：唯一可写的长期整合仓库，拥有独立 Git 历史。
- `Z:\Temp\street-rush-studio-continuation` 和 `E:\Codex` 下列入 `docs/SOURCE_INVENTORY.md` 的项目都是只读来源。
- 来源代码必须先复制到本仓库，再修改副本并记录原始状态和差异。
- C++ 车辆物理、音频和模型研究是 Rust/网页接口的 oracle 与候选，不直接回写来源工程。

任何外部实验结果都必须通过明确、可测试的接口进入；研究 fixture 不自动升级为目标车辆或生产结论。

## Rust 共享核心

```powershell
cargo test --workspace
cargo run -p streetrush-native
cargo build -p streetrush-core --target wasm32-unknown-unknown
node scripts/test-core-wasm.mjs
pnpm test:scheduler-owner
pnpm build
```

首个共享切片拥有 120 Hz 固定步调度、50 ms 帧上限和六步 catch-up 契约。原生探针、raw WASM 与网页 owner 都和 JavaScript oracle 对照；网页在 WASM 加载、超时、实例化、导出或契约失败时确定性回退到 JS。车辆物理仍留在已验证的网页基线，等待独立输入输出和误差门槛后再迁移。

## v0.3 系统

- 120Hz 固定物理步长与渲染插值，不同屏幕刷新率下保持一致手感。
- Rapier 动态车身、四轮射线接地、弹簧/阻尼、防倾杆、组合纵横向抓地与路面差异。
- 发动机扭矩曲线、离合接合、AT/MT、RWD/AWD、ABS、TCS和轻度稳定辅助。
- S 先制动，停车后继续按住进入倒档；W 在倒车时先制动并恢复前进档。
- 统一赛道数据生成路面、路肩、缓冲区、实体护栏、检查点和安全重置方向。
- 车辆模型校准、解析缓存与相邻车辆后台预载；加载新车时保留当前车辆。
- 速度 FOV、加减速镜头惯性、路肩/非铺装震动、胎印、胎烟与尘土。
- 分层程序化发动机声浪以及按速度/滑移触发的风噪和路噪。
- 自适应渲染分辨率、实例化赛道设施和开发性能面板。

## 启动

需要 Node.js 22+ 与 pnpm 11.9.0；首次使用可先运行 `corepack enable`。以下命令均在本仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

浏览器打开 `http://127.0.0.1:5173/`。

## 操作

- `WASD` / 方向键：油门、制动/倒车、转向
- `Space`：手刹
- `C`：自动 / 手动档切换
- `Q` / `E`：手动降档 / 升档
- `R`：回到最近的安全赛道位置
- `P`：显示性能面板
- `Enter`：从车库开始比赛
- 手柄：左摇杆转向、RT油门、LT制动、A手刹、LB/RB换挡、Y重置、Start/Menu 开局与暂停/恢复
- 手机横屏：左侧按住 LEFT / RIGHT 转向，右侧 GAS / BRAKE 支持与转向同时按住
- 手机辅助键：手刹、重置、AT/MT 切换和手动升降档

触控驾驶使用 Pointer Events 和独立指针捕获，可同时保持转向与踏板输入。默认自动挡不会显示手动升降档按钮，切换到 MT 后才显示。手机竖屏开始比赛时会显示横屏提示；转回横屏后自动恢复驾驶界面。手机和电脑都可通过顶部的 `FULLSCREEN` 按钮选择是否全屏；不支持整页全屏的 iPhone Safari 可添加到主屏幕后无地址栏运行。

## 验证

```bash
pnpm verify
```

`verify` 会逐车验证静止稳定、加速、刹停和按住制动进入倒档，然后重新构建并检查 Cloudflare 文件限制、产物新鲜度、秘密文件和素材台账。物理校准数据可另运行 `pnpm calibrate`。

## 部署

先运行与发布性质对应的门禁：

```bash
pnpm check:release:public
# 或
pnpm check:release:commercial
```

当前门禁会因为素材授权阻塞而失败；不要使用跳过检查或允许脏工作区的参数绕过。授权清理、设备试玩、干净版本标签、回滚构建和固定的部署 CLI 都准备好之后，再按 `docs/RELEASE.md` 执行部署。

现有线上域名：

- <https://street.charlesq.net>
- <https://street-rush.pages.dev>
