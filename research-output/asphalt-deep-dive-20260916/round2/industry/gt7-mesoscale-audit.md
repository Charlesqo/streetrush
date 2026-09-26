# 第二轮：GT7 微结构修正究竟改了什么，怎样与 Three.js 区分职责

2026-09-16。只读研究；没有改动正式 shader、src 或运行场景。PDF 页码从文件第 1 页计算。本轮补看 GT7 第 79-100 页图表，与上一轮的文字提取交叉核对，并重新读取当前 Three.js r180 的实际光照实现。

## 1. 对 GT7 方法的精确解释

来源：[GT7 2022 官方材质讲义](https://s3.amazonaws.com/gran-turismo.com/pdi_publications/CEDEC_KYUSHU_2022_gt7_raytracing_and_material.pdf)。下面是这一来源的精简事实摘要，后文明确区分本项目推导与提案。

Pages 79-81 introduce explicit mesogeometry and a ray-tracing tool that varies camera/light directions. Pages 83-89 measure view-conditioned normal distributions and visible AO, then fit shading-normal direction, roughness and AO changes. Page 85 restricts those choices to the measured structures. Page 89 shows curves against `dot(V,Ngeometry)`, not production equations or coefficients. Pages 92-95 separately approximate local light visibility from normal, mesoscopic AO and light direction, comparing candidates with ray-traced shadows. The published expression is `sat(dot(N,L)-alpha*(1-AO)+0.5)`. Pages 97-100 show combined before/after results; they do not isolate each correction's contribution.

因此，它处理两类遗漏：

| 问题 | 修正对象 | 不应混淆成 |
|---|---|---|
| 斜看微结构时，原本藏在沟槽里的面不再可见 | 有效着色朝向、有效粗糙度、可见微 AO | 所有角度降低 roughness；或按相机距离加亮 |
| 微结构会挡住射向沟槽的光，平面法线贴图没有这个几何遮挡 | 随光源方向变化的局部可见性近似 | 给整幅图增加 AO；把原 N·L 再乘一次 |

**真实几何在此是离线标定参考。** 上述修正并不自动让运行时平面获得轮廓、深度、自交关系、接触或 UV 位移。它用便宜的着色响应近似部分几何造成的外观，不能据此声称替代所有 POM 或真实位移需求。

**不能照抄的部分：** 法线朝视线偏转量、有效粗糙度随视角的曲线、微 AO 随视角的变化以及阴影系数。公开页没有足够数据重建其原始拟合，也没有给出本项目扫描素材对应的标定。给我们的高粗糙度 Fine 贴图强塞一条 GT7 曲线，等于换了一种无依据的参数调整。

尤其不能把组合对照图中更强的远处反光全部归功于微阴影：如果一个操作只乘以 0-1 的可见性系数，它不可能单独增加线性镜面亮度。

## 2. Uncharted 4 与 Wu：相邻问题，不是同一算法

来源：[Uncharted 4 官方演讲](https://www.advances.realtimerendering.com/other/2016/naughty_dog/NaughtyDog_TechArt_Final.pdf)，第 29-41 页。Its micro-shadowing approximates direct-light visibility using AO and light/normal angle. Page 37 gives `sat(abs(dot(N,L))+2*AO^2-1)` multiplied into shadow visibility, with explicit limitations of the AO/normal data. Its separate view-angle AO fade uses geometry normals and is restricted to appropriate baked-occlusion content. It is a production approximation, not a measured material-specific visible-NDF fit.

来源：[Wu et al. 2019](https://shuangz.com/projects/multires-sg19/multires-sg19.pdf)，本轮重点第 4-8 页、公式 6-14。It jointly reduces displacement and reflectance. Multi-lobe distributions preserve orientation variation; a spatial/angular correction matches effective reflectance between original and reduced geometry. The ratio's denominator already contains the reduced representation's visibility and base scattering. The effective-reflectance definition includes cosine weights and view-dependent visible projected area. The work further models interreflection and LoD interpolation. This is not equivalent to multiplying a scalar AO-derived shadow function into an existing GGX shader.

本项目由此可学到的原则是：**补剩余误差，而不是把所有叫“遮蔽”的项叠上去。** 如果新拟合的目标已经包括 GGX 的微表面遮挡，再乘现有 Smith 项就会重复。若从论文拿到的是包含余弦积分的有效响应，也不能把它当普通 BRDF 后继续照常乘同一个余弦。

## 3. Three.js r180 当前已经算了什么

已对照本地 `node_modules/three`，并核对固定 r180 一手源码：[光照 BRDF](https://raw.githubusercontent.com/mrdoob/three.js/r180/src/renderers/shaders/ShaderChunk/lights_physical_pars_fragment.glsl.js)、[逐光源累计](https://raw.githubusercontent.com/mrdoob/three.js/r180/src/renderers/shaders/ShaderChunk/lights_fragment_begin.glsl.js)。

在当前非金属 Standard 主路径，可将直接光概括为：

`Ldirect = Clight * Sscene * mu * ( Cdiffuse/pi + F * D * Vsmith )`

- `mu = max(dot(Ns,L),0)`，已经在 `RE_Direct_Physical` 的 irradiance 中乘入。
- `D` 描述 BRDF 的微表面方向分布；其 alpha 是 perceptual roughness 的平方。
- `Vsmith` 已经包含该微表面模型的 masking-shadowing 和 BRDF 分母相关项；不能额外再插一个同尺度 Smith G。
- `Sscene` 来自场景阴影贴图，已乘进逐光源颜色。

这是一条源码展开关系，不是说所有直接光情况都可忽略几何法线／着色法线差异。

### 最容易接错的变量

`lights_fragment_begin` 中 `geometryNormal = normal`，它发生在 `normal_fragment_maps` 之后。**这个名字里的 geometry 并不保证它是未扰动几何法线；在此它已经是扫描法线扰动后的 Ns。**

如果用 GT7 的 `dot(V,Ng)` 或 U4 的可见 AO 衰减，应显式保留未扰动基底法线（当前普通道路路径的 `nonPerturbedNormal`），不要直接因为变量名字而选择 `geometryNormal`。逐光源 `direction`、着色法线和 view direction 还必须在同一坐标系；现有路径主要使用 view space。

### AO 与 GTAO 的职责

本地 `aomap_fragment` 的 AO 会调制间接漫反射，并对环境镜面使用 `computeSpecularOcclusion`；它不直接给太阳制造扫描孔隙阴影。当前 GTAO 从场景深度重建，不知道普通 normal map 中每颗骨料的几何深度。

这不能推出“再加微阴影绝对不会重复”。源 AO 若包括建筑、整体照明或其他大尺度遮挡，或者 roughness 已经拟合整块骨料的总响应，新项仍可能与现有效果重叠。我们需要的是颗粒层面的独立输入，而不是借现成灰度图一律多乘一遍。

## 4. 两个公式的边界核对：已经算出的有限事实

本目录 `formula-sanity.py` 为我们自己写的标量代数检查；运行结果在 `formula-sanity.json`。没有跑 GPU、没有测当前材质，也没有证明物理正确。

把二者**假设成已有直接光的额外可见性乘数**，会得到：

| 条件 | GT7 公开式 | U4 公开式 |
|---|---:|---:|
| AO=1，N·L=0.1 | 0.6，与 alpha 无关 | 1 |
| AO=1，N·L=0.5 | 1 | 1 |
| alpha=0 | 仍为 sat(N·L+0.5) | 无该参数 |

这不证明 GT7 的成品实现有错。它证明的是：**不能把讲义中的独立公式直接理解为 Three.js 的无条件附加乘数，也不能用 alpha=0 当“关闭开关”。** 讲义没有提供完整 BRDF 接入上下文，平面极限必须由我们自己的实验保证。

如果需要原型开关，应使用独立权重 `k`，例如 `mix(1,M,k)`，保证 k=0 严格回到原样。不要把调参变化与真正的开关对照混在一起。

## 5. 一个有限、可否决的候选

**候选：只在太阳直接光路径增加独立可调的微结构可见性项，先以 U4 形式作为廉价基线。** 不同时改光强、粗糙度、法线尺度、曝光、反重复或宏观污渍，也不先启用视角粗糙度拟合。

设计表达式：

`Mraw = sat(abs(dot(Ns,L)) + 2*Ameso*Ameso - 1)`

`M = mix(1, Mraw, k), k in [0,1]`

接入概念是：太阳的 `directLight.color` 在场景 shadow 后、`RE_Direct` 前再乘 M。现有 `mu` 和 GGX 保留各一次，环境项保持原样；不是在最终 `outgoingLight` 上乘 M。这里只是接入方案，未写进游戏。

选择它的原因有限：白 AO 和 k=0 的退化边界清楚，能用来测试缺少方向性细遮蔽是否造成颗粒发平。它的误差形式也清楚，因此容易否决。它不是从公开资料直接推出的“最佳沥青模型”。

### 可验证参考怎么做

1. 先用已知几何的小型沟槽／骨料测试面，固定局部 BRDF，分别渲染有／无微结构光遮挡；保持同一相机可见面、同一基础反射和同一采样。
2. 以光照贡献比 `YwithLightOcclusion / YwithoutLightOcclusion` 形成遮蔽参考；分母足够亮时才使用比值，避免黑位除法噪声。也保存绝对能量误差。
3. 这两条参考支路都包含同样的 BRDF、余弦与相机可见性。如此比较的是额外微几何挡光，不是把总反光差异全部塞进 M。
4. 用与参考几何一致的 normal/AO 制作扁平材质，再对照候选；真实扫描须先确认 AO 与高度／法线的相容性。若没有一致高度或可解释微几何，记录“缺素材参考”，不要假称完成物理标定。
5. 训练／调参只用部分角度，留出不同太阳方向、相机俯角和距离验证。先关闭随机混合与 GTAO 隔离因素，再逐一恢复。

这份参考定义是本项目提案，并非声称复原了 GT7 内部测量器。

### 明确否决条件

- 平法线、白微 AO 或 k=0 不能回到基础实现；背光面出现新增光；结果依赖错误坐标系。
- 需要同步加亮太阳、抬曝光或降低全路 roughness 才能掩盖新项导致的过暗。
- 相比参考只增加静态黑点，没有改善随光向变化的遮蔽位置；或没有降低保留角度上的误差。
- 线性镜面已经太弱，新项只是继续削弱它，却被当成“反射修复”。此候选只能针对微遮蔽缺失，不能承包整个问题。
- 开启真实微几何时仍套同一个微阴影，或 AO 含大尺度遮挡导致护栏／墙脚再次加黑。
- 距离增大或恢复 mip／随机采样后发生能量跳变、格子包络、移动闪烁，收益仅存在贴地静帧。
- 一个固定 k 不能在同材质多光向下工作，而必须按镜头补参数。此时应换参考模型／输入／近似结构，不是继续增加控制旋钮。

## 6. 视角拟合什么时候进入

只有基底 normal、roughness、光照与过滤已经正常，且不同视角的真实微几何参考仍表现出系统差异时，再拟合：`Ns_effective(V,Ng)`、`r_effective(V,Ng)`、`A_visible(V,Ng)`。

必须先定义拟合目标是方向分布、平均反射曲线还是完整多角度图像，不能同时拿一条 roughness 曲线补太阳能量错误和缺失孔隙。它与距离过滤引入的有效粗糙度变化也应分开标定，最终再检查组合结果。

目前公开材料能支持这种研究路线，不能提供适用于 Fine/Fresh 的现成系数。本轮产物是更准确的候选与边界，不是已验证的正式材质方案。
