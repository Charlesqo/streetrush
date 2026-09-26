# 用户素材目录清点

已确认用户记忆中的目录是：

`/Volumes/Charles/下载/赛车游戏素材`

这与旁边的 `/Volumes/Charles/下载/赛车游戏 材质` 不同。后者约 8.1G、34 个 ZIP 材质包，按用户要求排除；没有修改或复制任何原始文件。

## 规模与结构

目标目录约 936M，排除 `.DS_Store` 后有 386 个文件、979,880,087 bytes：

- `runtime/city/downtown-city/`：339 个文件，约 93.7MB；153 个 glTF、153 个同名 `.bin`、29 个 PNG、3 个预览 JPG，以及 CC0 说明。
- `runtime/cars/`：6 个运行时 GLB，共 117,460,272 bytes。
- `archives/`：27 个文件，约 609MB；包含 12 个 ZIP、1 个 Lamborghini 源 RAR 和归档内已提取源文件。
- `extras/`：6 个 USDZ 与 2 个较大的重复 GLB。
- `licenses/`：5 个车辆授权文本；城市授权在城市包目录内。

对 153 个 glTF 的 `buffers` 和 `images` URI 做了逐项存在性检查：缺失 `.bin` 引用为 0，缺失纹理引用为 0。没有批量解压或渲染归档。

## 对龙湾主直道与维修区出口有用的候选

道路底板可看 `runtime/city/downtown-city/Exports/glTF (Godot)/Street_Asphalt_6x6.gltf`、`Street_Asphalt_9x9.gltf`、`Street_Asphalt_Curve_2Lane.gltf` 和 `Street_Asphalt_Curve_4Lane_Short.gltf`。它们各自需要同目录同名 `.bin`。直线/曲线道路与 `Street_*_noSidewalk.gltf` 可用来做模块化底板和尺度参照。

道路边缘候选包括 `Street_Curve_2Lane_Curb.gltf`、`Street_Curve_4Lane_Short_Curb.gltf`，以及 `Sidewalk_Straight_3m.gltf`、`Sidewalk_Straight_3m_Stripe.gltf`、`Sidewalk_NoCurb_3m.gltf` 和四种角部人行道。它们是城市道路构件，不能直接当作赛道 pit wall 或防撞墙。

混凝土材质有 `T_Concrete_Asphalt_BaseColor.png`、`T_Concrete_BaseColor.png`、`T_Concrete_Normal.png`、`T_Concrete_ORM.png`；金属混凝土有对应的 `T_MetalConcrete_BaseColor/Normal/ORM.png`。这些相关 PNG 为 2048×2048，并在 glTF 材质中按 BaseColor、Normal、ORM 组合引用。几何候选是 `Entrance_Concrete_2x1.gltf`、`Entrance_Concrete_2x2.gltf` 和 `Stairs_Entrance_Concrete.gltf`。

维修区设施小件可先核对 `Prop_Drain.gltf`、`Prop_ManholeCover.gltf`、`Prop_ACUnit.gltf`、`Prop_Bollard.gltf`、`Prop_Planter_Single.gltf` 和三个 `Stairs_Rails_*`。样本复杂度从排水口 20 顶点/30 索引、井盖 120 顶点/354 索引到楼梯扶手 888 顶点/1692 索引，整体明显是风格化模块包。

## 不能由该目录补齐的部分

城市导出目录中没有名为 `Fence`、`Guardrail`、`Barrier`、`CatchFence` 或 `Armco` 的专用赛道护栏/捕捉网；`Stairs_Rails_*` 是楼梯扶手，`Trim_Wall_Guard` 是建筑构件。README 还说明 Standard 城市包不是拼好的地图，碰撞体需要由项目或引擎添加。它没有龙湾专用的 pit wall、车库、信号、工具车、轮胎架或计时龙门架。

我查看了 `Preview_1.jpg` 和 `Preview_2.jpg`：内容是风格化 downtown 建筑、城市街道、路口、人行道和 decal 资源表，没有现代永久赛道设施。Preview_2 的 SOURCE 宣传文字不等于 Standard runtime 已包含完整 310+ 模型。

## 许可记录

`runtime/city/downtown-city/License_Standard.txt` 记录 Downtown City MegaKit Standard 为 CC0 1.0 Universal。Porsche GT3 RS、BMW M3 E30、Mazda MX-5 的本地文本记录 CC BY 4.0；BMW M5 G90、Mercedes-AMG GT3 记录 CC BY-NC-SA 4.0。Lamborghini Aventador 的 README 明确提示当前包没有清晰授权文本，公开发布前需要单独确认。归档材质近似目录没有做许可核验。

完整文件、候选路径、检查结果和许可证证据见同目录的 `user-asset-inventory.json`。
