# 成熟项目道路制作：本轮实际读到的内容与 StreetRush 的取舍

日期：2026-09-16。范围：公开一手资料、作者论文、当前道路材质代码的只读对照。未运行第三方代码，未修改游戏。以下 PDF 页码均为文件从 1 开始的物理页码，不是演讲页脚的页码。

## 结论

现在有比“换一张更好的贴图”更具体的路线：一条线解决颗粒的受光和可见性，另一条线制作整条道路的独特变化。它们还要共同通过距离过滤与运动检查。当前 Three.js 可以承载这些工作，公开资料没有提供必须换引擎或先上光追的证据。

本轮最重要的新证据是实际读到了 GT7 的道路专用材质讲义，以及赛道独特大范围贴图的制作讲义。先前交接包没有读到这两部分正文，因此这轮确实增加了内容，并非把已有清单换一种说法。

## 1. GT7：材质上确实有专门补回的信息

官方入口：[Polyphony publications](https://www.polyphony.co.jp/publications/)。

来源 [G1]：[CEDEC+KYUSHU 2022 道路与草地材质讲义](https://s3.amazonaws.com/gran-turismo.com/pdi_publications/CEDEC_KYUSHU_2022_gt7_raytracing_and_material.pdf)，114 页。已读道路章节第 58-113 页文字，视觉核对第 62、63、75、85、89、95、97、98 页。

Source-specific findings (within a concise source summary):

- Pages 62-75 contrast real surfaces with GT Sport, identify missing mesoscopic visibility and local shadows, and reject universal roughness/normal/contrast tweaks.
- Pages 76-81 explain why POM alone was insufficient and describe reference geometry plus offline ray-traced measurements.
- Pages 83-89 fit view-dependent shading-normal direction, roughness and visible AO. The curves are specific to measured geometry; they are not universal asphalt constants.
- Pages 92-95 use normal, AO and light direction for local shadow approximation: `clamp01(dot(N,L) - alpha*(1-AO) + 0.5)`. Approximate linearity was considered for mipmaps.
- Pages 97-100 show before/after road comparisons; page 111 lists generalization, LoD consistency and multiple scattering as unfinished directions.

### 对我们意味着什么（项目推论）

当前 `MeshStandardMaterial` 法线改变朝向，但扫描中的孔隙并没有成为真正能挡住太阳的几何。`aoMap` 影响间接项，GTAO 又没有扫描颗粒的深度，因此即使“灯亮了、法线也接上了”，仍可能缺少让颗粒显得有体积的直接光遮蔽。这是明确的新候选机制，尚不是已测根因。

值得做的原型是**道路专用的直接光微遮蔽**，然后才是依据参考拟合的视角响应。应保留原版同屏对照，分别查看直接漫反射、直接镜面和环境项。不能把修正系数简单乘到最终 RGB 上，否则会连天空、雾和其他贡献一起误伤；也不能重复乘已包含在现有 BRDF 的余弦项。

“视角相关”也不等于随便让远处更亮。它应由观察方向与几何法线决定，并与材质的微结构有关。横向、逆向、近远处都应连续。把距离作为替代因子会使同一块路随相机移动变色。

注意 AO 数值语义：常见 AO 贴图中 1 是无遮挡，0 是遮挡；“提高 AO 数值”不能翻译成“把 AO 阴影调得更重”。微结构的 AO 与护栏／建筑的大尺度遮挡必须分开。

## 2. GT7：重复感由整路内容层另行解决

来源 [G2]：[CEDEC 2022 赛道制作 Part 1](https://s3.amazonaws.com/gran-turismo.com/pdi_publications/CEDEC2022_gt7_course_making_part1.pdf)，69 页。已读第 44-69 页，视觉核对第 58、59、63、64 页。

Its unique road textures are generated from survey imagery, including vehicle panoramas when aerial capture is impractical. Pages 45-57 connect road marks and stains to photographed locations, estimate cameras, and project imagery onto the road mesh. Pages 58-61 correct source-image reflections and coverage; this is capture cleanup, not disabling Fresnel in the renderer. Pages 63-68 provide global-texture on/off comparisons.

### 对我们意味着什么（项目提案）

主直道约 641 米，内容规模远小于开放世界。先制作一个沿道路距离 s、横向偏移 t 展开的独特控制层，技术上比整套虚拟纹理系统简单得多。

可先用一张 2048×128 RGBA8 控制图承载四个状态，横跨约 23 米铺装宽度时，纵向约 0.313 米／像素、横向约 0.180 米／像素；含完整 mip 约 1.33 MiB。这个分辨率服务于道路状态，不承担亚毫米颗粒。具体四通道应根据内容确定，例如铺装批次、抛磨、积尘与维修遮罩；不是承诺直接采用某项目的通道布局。

绘制前先标出路肩、护栏底、维护入口、施工缝、行驶区域和制动区域。随机噪声只能扰动这些区域的边界与强弱，不能决定“哪里发生了什么”。材质状态要联合改变适当的颜色、粗糙度、法线权重，而不是只增加黑色污点。

这条路线不要求去真实赛道扫描。我们可以人工制作具有明确位置逻辑的控制层。公开案例证明的是独特内容层的职责，不是所有项目必须照搬其采集设备。

## 3. FH5：能证实制作组织，不能臆测未公开的反光算法

来源 [F1]：[Andrew Findlay，道路团队作者说明](https://andyf86.artstation.com/projects/5XkJ0w)。他明确列出 Substance 材质与贴花制作、引擎内道路 profile、不同道路类型的 blend-map presets，随后进行按场景语境的道路混合与贴花制作。这支持“先可复用道路类型，再按地点做细节”的流程；不揭示 BRDF 源码。

来源 [F2]：[Playground Games / Adobe 制作访谈](https://www.adobe.com/products/substance3d/magazine/forza-horizon-5-crafting-rich-and-diverse-mexican-biomes.html)，重点完整阅读 Wet road node。Their wetness tool consumes terrain/road height, a road mask and a flow map. Terrain shape guides accumulation, flow supplies orientation, and minimum/maximum outputs support changing conditions. This is a concrete authored-state workflow; it does not establish a special dry-asphalt glint method.

来源 [F3]：[Andrea Riccardi 地形作者说明](https://andreariccardi.artstation.com/projects/zDzELq)。Houdini rulesets configure material distribution and transitions. 来源 [F4]：[Theo Hodkin 沼泽地形作者说明](https://nonplus.artstation.com/projects/G8X3bN)。Procedural/scanned materials, DEM-driven distribution, and manual property painting are used together.

项目推论：制作主直道无需运行 Houdini。我们需要的是可编辑的地点规则与状态层，而非特定软件名称。护栏脚下的碎石／尘土应成为这种规则中的一项，并受到驾驶区域、维护出入口等约束。

证据限制：已定位 [FH5 EPC 官方演讲入口](https://www.sidefx.com/ja/learn/talks/how-proceduralism-helps-create-forza-horizon-5s-mexico/)，但本轮未取得可核对全文的字幕／幻灯片；不声称完整看过视频。Gaia Friedman 部分作品页面只返回站点登录界面，未把那些页面当作技术证据。

## 4. rFactor 2：可直接参考的数据分工

来源 [R1]：[Roads Materials](https://docs.studio-397.com/pages/viewpage.action?pageId=37945832)。It separates broad albedo/wetness inputs from densely repeated detail inputs, recommends reusing a few detail sets, and treats texture resolution as a content/performance decision. A sentence about frequency and individual stones is ambiguous; do not elevate it into a universal sampling rule.

来源 [R2]：[PBR Road / Curb usage](https://docs.studio-397.com/plugins/viewsource/viewpagesrc.action?pageId=37945939)，重点已读 Functional Switches、Using Asphalt Type Maps、Generating the Road Detail Map。It combines broad road-state masks with matched-scale detail maps. Rubber and dust use material profiles rather than color alone. The state-map generator uses material IDs, road coverage, height and painted detail controls. Detail blending may use a slightly different mask scale to reduce synchronized repetition. It also documents compromises, including limited marble normals.

来源 [R3]：[IBL Road & Curb technical reference](https://docs.studio-397.com/pages/viewpage.action?pageId=37945407)。Road Details RGBA stores dust, groove, wear and puddles; overlay RGBA changes albedo and roughness; the blend mask attenuates detail normal/AO/specular together. The reference exposes feature switches so peripheral roads need not pay for all effects. Parameters are engine-specific: its roughness adjustment centered on 0.5 is not Three.js's multiplicative material.roughness.

项目提案：我们的场景中，维护补片、道路标线、尘土和基底沥青需要明确覆盖关系。修补层不能只盖住颜色、却继续显示完整底层颗粒法线；相反，薄尘又可能只部分弱化底层细节。先定义覆盖关系，再决定独立贴花还是底材混合。

## 5. Uncharted 4：直接光微遮蔽有实际出货案例，也有局限

来源 [U1]：[官方公开演讲 PDF](https://www.advances.realtimerendering.com/other/2016/naughty_dog/NaughtyDog_TechArt_Final.pdf)，137 页；已读第 29-41 页文字并视觉核对第 36、37、40 页。

The shipped approximation uses AO and the normal/light angle to soften direct-light visibility around unresolved cracks. Page 37 gives `saturate(abs(dot(L,N)) + 2*AO*AO - 1)` multiplied into shadow visibility, while explicitly acknowledging inaccurate AO authoring and insufficient input information. Pages 38-40 fade micro-AO toward white at grazing views using the geometry normal; the technique is restricted according to how occlusion was baked. This is not a universal replacement for scene shadows or measured visibility.

项目推论：这是适合小规模对照的廉价候选，不是应立即全局开启的“画质开关”。我们的扫描 AO、法线和真实高度之间是否一致，需要先确认；若 AO 已含大块照明／阴影残留，直接加入太阳微遮蔽会放大错误。

## 6. 反重复与过滤：必须区分两种保真

来源 [B1]：[Burley 2019, On Histogram-preserving Blending](https://www.jcgt.org/published/0008/04/02/paper.pdf)，23 页。已读方法和讨论，视觉核对 PDF 第 11 页（期刊第 41 页）。Exponentiated weights reduce ghosting but can expose tile boundaries when too strong. Histogram correction addresses contrast distribution separately. Per-channel color handling can introduce hues; luminance-only blending is one proposed remedy. Normal-data robustness is discussed as an open comparison rather than proven by color examples. Reported timings concern CPU texture synthesis, not this game's GPU.

来源 [H1]：[Deliot / Heitz 作者页](https://eheitzresearch.wordpress.com/738-2/)。The author summary describes covariance-eigenspace channel transforms, inverse-distribution lookup filtering for mip-related color drift, and compressed-format considerations. Only the author summary was obtained this round, not the Google Drive chapter itself.

来源 [W1]：[Wu et al. 2019 论文](https://shuangz.com/projects/multires-sg19/multires-sg19.pdf)，14 页。已读引言、实现 §7、结果与限制 §8；视觉核对第 11 页。The method jointly prefilters displacement and reflectance, retaining multi-lobe directional statistics and corrections for visibility/interreflection. Its implementation uses offline Monte Carlo precomputation and a Mitsuba renderer; it is not a ready-made inexpensive WebGL shader. Large displacements expose limitations, and changing source geometry or BRDF requires recomputation. GT7 cites this as inspiration, not as identical runtime code.

### 当前代码的具体差距

`src/scan-surface-sampling.js` 只有平移、三角权重三次幂和普通加权；既没有直方图变换，也没有粗糙度／法线统计的专用 mip。把权重指数从 3 改成 4 或 8，只改变过渡宽度，不能自动补全前述工作。

这次建议比较三条受控路线，先分别评估，不同时增加污渍来掩盖结果：

1. 原始微结构普通平铺 + 独特宏观控制。用于判断源材质和基础着色能达到什么。
2. 仅对经过频率拆分的中尺度变化做统计保持随机化；细颗粒采用较少混合，通道之间维持同一物料身份。
3. 当前三样本方法保留为对照，输出权重与主导样本区域，检查重复块是否来自混合网格。

需要保存的是受光后表现，而不只是 RGB 直方图。两个结果即使颜色直方图相同，也可能有不同的颗粒排列、法线分布、孔隙遮蔽以及行驶时闪烁。

## 7. 对 Three.js 当前项目的明确取舍

| 候选工作 | 当前判断 | 进入下一步的条件 |
|---|---|---|
| 冻结并核对光照／探针基线 | 必须 | 由主任务的运行时诊断确认，不依据成熟项目截图猜参数 |
| 整路独特控制层 | 适合做 | 先明确施工和使用区域，保持微结构独立可检验 |
| 直接光微遮蔽 | 值得做小原型 | AO/normal/高度信息合理；对照真实微几何与多角度 |
| 视角相关的有效法线／粗糙度／微 AO | 有实质依据的后续候选 | 先用参考得到曲线，禁止复制 GT7 图中的数值 |
| 颜色统计保持随机化 | 条件采用 | 对当前源图确实有收益，mip、颜色和通道关联都检查 |
| 专用法线／BRDF 预过滤 | 若实时结果偏离参考则采用 | 明确现有 roughness 已表达的尺度，避免重复补偿 |
| POM / 位移 | 仅近景有明确需要时 | 不把它当作驾驶远处颗粒响应和整路独特性的解法 |
| 离散 glint | 暂不作默认方向 | 真实目标中有亚像素亮点，基础 BRDF 与过滤已通过 |
| SSR / 实时光追 | 当前无优先证据 | 出现明确的近场环境反射缺失且平台预算支持 |
| 换引擎／全套虚拟纹理 | 当前无依据 | 同内容实验实际证明现架构无法合理满足目标 |

来源 [G3]：[SIGGRAPH 2023 GT7 Rendering](https://s3.amazonaws.com/gran-turismo.com/pdi_publications/SIGGRAPH2023_RenderingTechBehindGT7.pdf)，141 页；已读 PDF 第 50-79 页文字。The 2023 talk describes forward rendering, special road/grass shaders and pre-integrated IBL. At that time, its stated policy excluded ray tracing during races; reflections used cube-map approximations outside the ray-traced path. This is a historical implementation boundary, not a claim about every 2026 GT7 mode.

## 阅读记录与文件

- `sources/`：六份从官方／作者／期刊地址下载的原 PDF；同名 `.txt` 是用于定位的文字提取，不代替视觉核对。
- `pages/`：上述关键页的未增强阅读截图，只用于证据核对，不是我们游戏的画面。
- 网页工具最初因 PDF 大小拒绝读取；随后使用已获允许的网络下载正常取得原文件，因此 GT7 正文已读，不再是“只有目录”。
- 所有方法建议仍需在 StreetRush 中验证；本轮没有声称任何一个成熟项目的性能数字能直接移植。
