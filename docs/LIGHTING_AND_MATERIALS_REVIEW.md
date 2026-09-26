# 光照与材质实机检查

日期：2026-09-06 至 2026-09-07。检查对象是任务开始时的工作树与本轮修改后的正常游戏入口。

[打开六车交互对比](verification/lighting-20260906/index.html) · [完整统计 JSON](verification/lighting-20260906/measurements.json) · [源文件 SHA-256](verification/lighting-20260906/source-sha256.json)

## 问题与修正

- 原赛道使用 `MeshLambertMaterial`，只有颜色贴图，未参与 PBR 的粗糙度、法线与环境高光计算。材质库中的扫描材质没有进入生产入口。原 UV 又把曲线参数长度配给弧长采样的几何，局部尺寸不一致。
- 现在使用 Poly Haven Asphalt 01 的 1K diffuse / OpenGL normal / ARM，按实际渲染中心线累计距离铺设 2.1 m 方形材质。颜色设为 sRGB，法线和 ARM 为非颜色数据，metalness=0；ARM 的 G 通道控制粗糙度、R 通道提供微表面遮蔽。没有水膜清漆或镜面反射层。舍弃了中途过于均匀的程序颗粒方案。
- 车辆原来反射室内 RoomEnvironment，环境却是室外。现在可见天空、阳光方向和场地 PMREM 一致；启动时从真实静态场景生成 256 分辨率反射，捕获时隐藏车辆。
- 按源材质名称区分车漆、玻璃、橡胶、塑料/碳纤维和金属。纠正 LP700 玻璃/金属接近 1 的粗糙度，以及 GT3 部分塑料/橡胶的金属响应。保留原有颜色、涂装和贴图；不对未知 atlas 一刀切覆盖。透明薄玻璃保留 alpha，取消高成本整场景 transmission prepass。
- 启用统一太阳投影：桌面 2048 阴影图、触摸设备 1024，范围约 56 m，光空间像素对齐；静止时缓存，触摸设备最多 30 Hz 更新。阴影跟随已提交的视觉姿态，不写物理状态。
- 柔化车底接地遮蔽，加半分辨率 GTAO 与去噪，用于轮拱、车底和环境接缝层次。GTAO 复用主颜色 pass 的深度，避免第二次绘制整车法线；只有颜色目标使用 2× MSAA，后处理目标不使用 MSAA。启动时在同一 HDR 目标上预编译场景材质，减少新景物进入视野时的编译峰值。
- 原车库文字遮罩一直覆盖比赛画面。比赛时移除全屏遮罩，HUD 改用局部底色和文字阴影。

## 性能条件

Codex 应用内浏览器，ANGLE / Metal，Apple M4，1280×720，固定渲染比例 1。正常比赛状态，真实 GLTF 车辆、120 Hz 原有物理调度；静止组位于起点，模拟仍在运行。每次先预热 3 秒，再记录 12 秒。测量时恢复正常 rAF，关闭动态分辨率；其余检查限制 5 FPS。截图在采样结束后拍摄，计时文字不同。

GPU 耗时使用 `EXT_disjoint_timer_query_webgl2`；拒绝 disjoint 结果。统计包含所有图形 pass，绘制次数包含发生更新的阴影和后处理。整帧间隔受浏览器调度、物理及其他本机负载影响，不能直接当成物理显示器帧率或外推到其他设备。保存的是每组统计值与样本数量，不是逐帧时间序列。

每次采样窗口暂停其他工具操作，但本机其他应用负载及浏览器调度未受控。最终补正 Standard → Physical 转换的 `PHYSICAL` define 后复测六车，出现明显波动，下表保留这轮最新值，没有沿用较好看的旧数字。原版与新版在不同时间采样，不能把差值全部归因于本轮代码。上一轮完整六车结果另存于 `measurements.json` 的 `earlierRows` 及 `earlier-after-*.json`，其 GPU 均值依次为 2.57 / 2.78 / 3.50 / 3.07 / 3.42 / 4.97 ms。

| 车辆 | GPU 平均 ms | GPU P95 ms | 整帧平均 ms | 整帧 P95 ms | 绘制次数 |
|---|---:|---:|---:|---:|---:|
| Mazda MX-5 NA | 2.51 → 7.71 | 2.86 → 18.08 | 6.67 → 18.02 | 8.20 → 33.50 | 167 → 99 |
| BMW M3 E30 | 3.20 → 4.83 | 5.04 → 6.16 | 6.81 → 13.88 | 8.40 → 21.10 | 170 → 103 |
| Porsche GT3 RS | 1.72 → 5.72 | 2.16 → 7.27 | 10.31 → 13.82 | 13.90 → 19.40 | 190 → 193 |
| Lamborghini LP700 | 1.13 → 4.93 | 1.48 → 6.75 | 6.76 → 14.94 | 8.20 → 24.10 | 135 → 137 |
| Mercedes-AMG GT3 | 1.49 → 4.89 | 1.82 → 6.93 | 6.92 → 16.39 | 8.70 → 29.50 | 132 → 136 |
| BMW M5 G90 | 1.56 → 7.46 | 1.82 → 12.07 | 6.67 → 17.71 | 8.40 → 28.00 | 104 → 110 |

MX-5 行驶组（倒计时预热后约 8 秒加速、4 秒松油门）GPU 平均：原版 **2.53 ms**，上一轮 **3.22 ms**，最终复测 **4.43 ms**；整帧 P95 为 **8.30 / 9.20 / 31.00 ms**，P99 为 **9.10 / 10.20 / 44.50 ms**。启动预编译后曾取得较低的 P99，但最新复测没有复现，不能宣称已经消除卡顿。保留两轮记录，未将额外波动确定归因为热降频、其他应用或着色器编译。这是正常入口的短程驾驶渲染检查，不是车辆物理完整性或目标车辆标定验证。

新增画质有实际 GPU 成本。MX-5/E30 去掉 transmission prepass 后减少了重复绘制，绘制次数从 167/170 降至 99/103；这不等于最终 GPU 耗时一定下降。当前证据足以表明有成本及明显波动，尚不足以精确分离代码增量与跨时段本机负载的影响，也不能承诺所有车、分辨率或长期驾驶下的帧率。

新增三张贴图共 3,063,517 bytes（约 2.92 MiB）。它们替代了运行时旧沥青颜色图的读取，旧文件仍保留在仓库。1K 只限定本轮贴图；没有引入 4K/8K 贴图。GPU 缓冲显存没有实测，不用下载体积冒充显存。

## 验证

- PASS：`node scripts/test-render-materials.mjs`，真实赛道 UV 尺度、材质源对象/共享批次/贴图/颜色/几何保留、玻璃 alpha 与阴影/折射行为。
- PASS：`node scripts/test-assets.mjs`（13 tests）。
- PASS：`node scripts/test-track-markers.mjs`、`node scripts/test-vehicle-visual-wheels.mjs`。
- PASS：真实 MX-5、GT3、LP700 loader 与生产 factory / 轮子绑定 / 缓存克隆生命周期检查。Node loader 测试存在其已声明的纹理解码限制；实机外观另由浏览器截图检查。
- PASS：原版与新版赛道 position / normal / index 数组逐元素相同；UV 是有意改变项。车辆物理、输入、调度等已有 JS 实现与任务快照逐文件相同，车辆物理、输入、调度和遥测实现未改。
- PASS：`node scripts/build-core-wasm.mjs` 与 `node node_modules/vite/bin/vite.js build`。使用已安装工具直接执行构建步骤；没有把 pnpm 的依赖管理失败当作通过。
- PASS：素材 inventory（55 files）。这不改变既有素材的公开/商业发布限制。
- PASS：六车正常游戏入口 GLTF 加载、同机位截图与统计条件检查；最后的首次行驶预编译检查未发现浏览器 error/warn。
- NOT_RUN：真实移动设备性能、完整物理验收、长期全赛道性能 soak。

新增材质检查已加入 `package.json` 的 `test:render-materials` 和 `verify` 链。完整 `verify` 未重跑，不将局部检查冒充全项目完成。

## 下一步可选优化

- 优先研究静态环境与动态车辆的阴影分开缓存，或按移动量降低重绘频率；当前桌面车辆一移动就会更新近车阴影图。需要检查快速转向时的阴影滞后。
- 将 GTAO 分辨率、采样数和阴影分辨率做成独立画质档。当前桌面固定半分辨率 16 samples；先调整这些比扩大整条渲染链更容易控制成本。
- 远处城市使用 [LOD](https://threejs.org/docs/pages/LOD.html) / 合批 / 更紧的可见范围，降低几何和绘制负担；实际收益需要结合远景与驾驶场景评估。
- 画质优先项：路面补丁、轮胎磨痕、路缘污渍等局部材质变化，以及更有层次的环境几何。它们能改善目前仍较简化的场景。
- 尚未采用局部反射探针、[级联太阳阴影 CSM](https://threejs.org/docs/pages/CSM.html)、体积光。局部探针适合让车漆随场地位置变化；级联阴影用于改善远近覆盖；体积光适合有雾或尘的明确氛围。需要针对画面目标选择，不能预设叠加后必然更好。

按用户最新要求，停止重复已确认的视觉检查；这些是后续候选项，本轮没有继续叠加新效果或声称已完成上述优化。

## 复核入口与边界

当前游戏：`http://127.0.0.1:5173/?renderreview`。日常预览 5 FPS；“测量 12 秒”/“行驶采样”会预热、恢复正常刷新率并自动回到 5 FPS；反引号可切换测试面板。正常产品入口不受这个开发预览上限影响。基准源快照位于 `scratch/lighting-review-20260906/baseline/`，本轮用端口 5176 运行；两边使用同一检查工具。

反射是静态场地 PMREM，不会随车辆移动逐帧捕捉局部倒影。没有 SSR、光追或体积光。GTAO 是屏幕空间近似，车底遮蔽也有近似范围。环境几何保持原有简化场景；本轮不宣称达到大型商业游戏的完整场景资产质量。

来源：[Three.js PBR 材质](https://threejs.org/docs/pages/MeshStandardMaterial.html)、[PMREM](https://threejs.org/docs/pages/PMREMGenerator.html)、[太阳方向光](https://threejs.org/docs/pages/DirectionalLight.html)、[GTAO](https://threejs.org/docs/pages/GTAOPass.html)。沥青：[Asphalt 01](https://polyhaven.com/a/asphalt_01)，[CC0](https://polyhaven.com/license)；作者 Charlotte Baglioni / Dario Barresi，来源、校验和与授权记录已加入素材清单和 `licenses/evidence/polyhaven-asphalt-01.txt`。
