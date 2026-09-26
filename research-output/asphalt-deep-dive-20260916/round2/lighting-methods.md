# 第二轮：平面诊断迁回完整视觉赛道的方法审计

2026-09-16。阅读了上一轮 `runtime/lab.js`、原 `track.js`、`track-environment.js`、`assets.js` / `longwan-venue.js`、`dev-straight-art.js`、`rendering.js` 与 Three r180 shader。没有控制浏览器、修改 src 或运行物理。另用原 `TrackSystem.createStrip` 做了 CPU 几何核查，见 `lighting-geometry-audit.json`。

## 最重要的新发现：上一轮平面与真实主路的 UV 横向朝向相反

这不是猜测。真实赛道 U 沿里程增加；V 从 `side*-7` 到 `side*+7` 增加。在主直道中段，tangent=+X、side=-Z，因此真实道路 **+U=+X、+V=-Z**。

上一轮平面直接使用 `uv=(x,z)`，因此 **+U=+X、+V=+Z**。两者几何法线都是+Y，Fine物理平铺尺度也都是约3m，但UV基底手性相反。

| 项目 | 上一轮平面 | 真实道路中段 t=.145 |
|---|---|---|
| 几何法线 | +Y | +Y |
| +U | +X | +X |
| +V | +Z | **-Z** |
| UV基底手性 `sign(cross(U,V)·N)` | -1 | +1 |
| Fine每块U/V尺寸 | 3m / 3m | 2.99997m / 3m |
| V的材质坐标 | z/3 | (7-z)/3 |
| U相位 | x/3，从平面起点0算起 | 实际渲染中心线累计弦长/3，包含赛道起点到机位的距离 |
| 路面高度 | y=0 | y=.015 |

Three r180 对两者都从 UV 导数生成 TBN（没有预计算 tangent），会遵循各自朝向。**这不是说某个UV手性本身非法，而是说它们不是相同的受光材料方向。** 相同的normal绿色分量，在旧平面指向+Z，在真实路面指向-Z；纹理图案和各通道的空间分布也被镜像并移相。尤其真实太阳有明确的-Z分量，不能忽略这个差异。

影响边界：

- 上一轮常数白环境、平法线 DFG 实验不受影响，仍有效。
- 平面内 plain vs mixed 的控制比较仍然控制了灯光与几何，可用于证明该特定平面条件下采样改变了外观。
- **平面材质的镜面占比、亮度、高频衰减百分比不能直接搬成真实道路的百分比。** 需要用真实道路 geometry 重测。不能只改一个normal绿色通道来补偿，因为源图UV身份和纹理相位也不同。
- 最可靠的迁移方式就是本轮重用原 buildVisuals + installStraightArt，避免手抄一张“差不多的平面”。

CPU几何还确认：t=.006、.055、.275的主直道并非严格z=0，闭合CatmullRom在两端有轻微偏移 / 转向。t=.006的局部U方向为 `[.999788,0,-.020614]`，局部每块U约2.970m；t=.055约2.999m，t=.275约3.004m。这些小幅形变也应继承原网格，不必另造路面去近似。

## 1. 完整视觉场景的装配范围

使用 `VisualTrack extends TrackSystem`、仅把 `buildPhysics` 设为空，保留原构造中的 buildVisuals，再调用原 AssetManager.loadScenery 和 installStraightArt，是合适的**视觉诊断装配**。不加载main/车辆/模拟，不意味着生产物理被替换，也不能称为生产驾驶验证。

装配至少保留：

1. 原 `TRACK_CONFIG`、THREE版本和renderer色彩配置。
2. 原 `createOutdoorLighting` 初始化出的源环境。
3. 原 TrackSystem 视觉网格与所有道路装饰。
4. `AssetManager.loadScenery()`，这里走 `buildLongwanVenue`，含整套pit建筑/铺装/服务区。
5. `installStraightArt`，再按main顺序对 track.group 与 assets.cityGroup 调 `prepareScenery`。
6. 带固定Object3D focus的 `setSkyRotation(-1.1,focus)`，确认真正的 DirectionalLight position-target 与 lighting.direction 一致。
7. 显式等待纹理完成，再编译 / 捕获 / 测量。

注意：`buildVisuals` 的 TextureLoader.load 是非await加载；loadScenery只直接等待venue与paving等自己负责的资源。不能把 `await assets.loadScenery()` 自动当成所有同步创建材质的草图、树图和原沥青图全部完成。建议在装配前挂 DefaultLoadingManager 计数，并遍历所有实际材质纹理核对 image.complete/naturalWidth 或图像数据尺寸；草GLTF使用自己的LoadingManager，其loadAsync应另等完成。程序编译完成不等于贴图完成。

## 2. 相机和采样足迹不能沿用旧平面掩码

旧lab的masks()假设y=0，x从0往前、|z|<=5.5，按世界x切3–8/8–20/20–50m。真实主路y=.015，世界起点不在0，方向略弯，而且paint、rubber、墙、树或其他物体可能覆盖路面像素。

建议：

- 对齐 `dev-circuit-review` 实际机位：position=track.pointAt(t).point+[0,1.7,0]；target=track.pointAt(t+24/length).point+[0,1,0]；FOV58，固定真实drawing buffer尺寸、aspect和projectionMatrix。
- 静态近看若使用`.65m`机位，也要继承对应offset/lookAhead/lookOffset。不能把旧lab的“near相机看平路”与“草带近看”混为同一视角。
- 1.7m视点到真实路面的垂直间距是1.685m；.65m机位为.635m。差值不大，但精确mip/像素对照要使用真实平面。
- 距离分箱使用当前机位相对赛道的沿路距离 / 实际命中点，不再使用绝对world.x。
- 最好输出road visibility/ID mask和深度/世界位置，只统计实际可见的新主路材质片段。透明叠层、白线、补片、建筑边缘应单列或剔除。
- 高通统计必须让中心及四个邻点都属于同一有效ROI和路面对象，并腐蚀1–2像素边缘。旧summarize只检查画面边缘，未检查邻点是否仍属于ROI；完整场景中会把paint、阴影边界和遮挡边缘算成“颗粒细节”。

矩阵metadata应保存：位置/quaternion或view matrix、projection matrix、FOV、near/far、viewport、drawing buffer、DPR/有效缩放；仅保存width/height不足以确认相同足迹。

## 3. AOV的语义必须保持明确

旧lab在 `<opaque_fragment>` 前修改outgoingLight。对无发光、无clearcoat的沥青 Standard 材质，四项和可以闭合，且已包含材质AO的影响；它不是未经AO的原始光照分量。

迁回完整场景后需要处理：

- **雾**在opaque之后执行。若开启雾，四个AOV各自又与雾颜色混合，直接相加会多算雾；normal、roughness、baseColor也被污染。数据AOV必须禁用fog或跳过其shader块；最终观感另走原雾。
- 同理数据AOV不能经ACES、sRGB输出或GTAO再当线性值。Float target + NoToneMapping + linear/no-output-transfer，读回后做统计。
- normalEncoded输出的是**view-space normal**。跨不同相机不要直接对比RGB均值。建议同时输出 `inverseTransformDirection(normal,viewMatrix)` 的world normal、`NdotV`、`NdotL`、half-vector夹角，才能判断太阳几何和法线方向。
- baseColor是已经经过map、材质color、vertex color、neutral/gain的diffuseColor；不是原BaseColor文件。应命名清楚。
- 在所有建筑材质上套同一四项拆分并不自动闭合：emissive、clearcoat、transmission及额外shader项不一定属于四个字段。沥青ROI可以要求闭合；整幅场景不能要求同一公式无条件闭合。
- 检查每个距离bin的闭合及逐像素误差，而不仅旧lab的第一个近距离bin均值。均值闭合可能掩盖正负误差抵消。
- 截图可保留其他场景物体，但统计必须经过真实road mask；否则不是路面材质测量。

建议单独记录材质AO、shadow factor、normalScale、roughness乘数与最终effective roughness。环境镜面AO来自computeSpecularOcclusion，不能把它与DFG导致的变化混在一起。

## 4. 太阳与阴影：上轮已找到的空visual问题只解决了一半

提供dummy Object3D使setSkyRotation正常更新太阳方向是必要的。完整场景还需要：

- 记录真实`sun.position-sun.target.position`，而不是仅记lighting.direction。
- 光照focus要与原review相机对应的track point一致；原review中dummy quaternion默认恒等，shadowLookAhead沿+Z，不能擅自改成沿道路+X后又叫原始相同阴影。
- 原sun.shadow.autoUpdate=false。物体、相机对应focus、LOD或阴影开关变更后，要明确设置needsUpdate；否则AOV可能读到旧阴影贴图。
- 固定shadow map尺寸、span112、lookAhead24、bias/normalBias；主机位阴影覆盖与先前截图一致。
- 上一轮平面receiveShadow=false且renderer.shadowMap.enabled=false。它的直接镜面占比不能用于有围墙/护栏/建筑遮挡的路段。
- 分开量“无遮挡路面”和“阴影路面”，避免一个混合均值把照明遮挡与材料响应混成一个原因。

无玩家车的诊断剔除了车影、车体遮挡与接触影，因此结论只涵盖无车视觉路面。探针原来就隐藏玩家车，这一方面与原捕获更接近；实际驾驶主画面的车影仍需后续核验。

## 5. 环境探针：冻结方法本身会决定实验是否有效

### 不能在AOV模式下捕获

captureVenue会渲染整个场景。若诊断uniform还停在roughness、normal或某个分项，新探针会把诊断颜色当成真实受光。所有capture / setSkyRotation前将所有注入材质的mode归零，恢复正常光照强度及渲染状态，捕获后再切AOV。

### 同一材质对照，应先固定探针

plain/mixed对照若每次都重新捕获，则同时改变材质和环境，不能把差值全归因于采样。最小双实验为：

1. **冻结探针的材质实验**：固定完整场景初次probe，只改路面采样，其他变量固定。
2. **允许重新捕获的整体行为实验**：明确报告这是材质对场地环境的反馈，以及光照历史的合成效果。

### 只保存scene.environment引用，不等于安全冻结

createOutdoorLighting闭包拥有`environment` render target；captureVenue完成后会dispose上一张。若保存旧texture引用、进行另一次capture、再把旧引用赋回scene.environment，保存对象可能已被dispose。`texture.clone()`通常也不是GPU渲染目标内容的深拷贝。

可靠做法是：不要在冻结阶段调用captureVenue；需要多历史分支时，用独立拥有的GPU纹理副本 / 明确的固定源环境生成每条分支，或者重建一份相同场景恢复基线。记录环境texture UUID、是否被dispose及每个分支的源环境。

### history test需要分离LOD与环境反馈

真实草和护栏使用THREE.LOD，hysteresis=.12。PMREM内部六次renderer.render会从probe位置更新LOD；回到主相机又更新一次。LOD选择在临界距离依赖之前visible状态，重复捕获可能同时改变环境输入和可见几何。

- 先测实际生产行为，记录每轮probe前后LOD当前级别；不能把全部漂移都叫“多一轮反弹”。
- 若要隔离旧环境反馈，应固定LOD集合再捕获；若要看真实行为则保留autoUpdate，并把这条限制写清。
- 捕获时原代码关闭阴影，不代表物体没有几何遮挡。诊断“保留阴影的probe”属于另一候选条件，不是同条件复测。
- 不同probe位置同时改变可见几何、局部视差与LOD。应明确这是位置对照，或在隔离试验中统一LOD。

## 6. 地面叠层和统计对象

完整场景包含主路y=.015、铺装路肩y=.012、白线y=.043、弯道橡胶y=.046、尘土y=.020、补片y=.024、pit apron y=.11等层；透明地面带还关闭depthWrite。不能用“看起来是路面”的矩形框不加区分统计。

主道路material为数组：剩余赛道originalRoadMaterial、主直道Megascans材质，按geometry.groups切分。`Megascans asphalt`名字同时可能用于其他铺装。建议用mesh/geometry group/material index唯一识别主路，不要仅按material.name选所有同名材质。

2K草底图、扫描草、原场景建筑和透明树卡会进入probe；它们的加载/LOD/透明状态应保持一致。`prepareScenery`会重设castShadow/receiveShadow，必须在安装完整直道后按原main顺序调用，避免只装物体没装阴影规则。

## 7. 后处理与高频统计的局限

旧captureTest把“直接ACES默认画布”对比“原HDR目标+GTAO+OutputPass”。默认画布AA和HDR4×MSAA、GTAO、输出路径都可能变化，这只能称**整条显示管线的差异**，不能单独给GTAO归因。

完整赛道建议最少做两层：

- 线性Float AOV：原几何/纹理/灯光，关闭fog/post，隔离材料与照明。
- 最终观感：同机位同有效输出分辨率，原HDR+MSAA+GTAO+OutputPass+fog；将候选和原版在同一条管线里比较。

若专测GTAO，保持同一HDR/MSAA/OutputPass，只改AO合成强度。平面测试里GTAO几乎没有几何可遮蔽，不足以预测护栏/墙脚/草带等真实接触处。

高通RMS不是“真实感得分”：锐化、错法线、阴影边、闪烁、贴图周期都可能提高它。至少同时报告平均亮度、低频变化、相对高频对比、normal角度/roughness统计；静态对比之后才用小幅相机平移序列检查高光是否稳定，而非用随机闪点当提升。

## 8. 最小可靠验收顺序

1. 完整视觉场景加载完成，固定draw buffer与主直道t=.145机位；保存实际太阳方向、shadow参数、主路mesh/材质/UV、资源完成状态。
2. 用平法线和已知+U/+V倾斜法线做很小的校准。真实主路应观察到+U沿+X、+V沿-Z；直接输出world normal，排除TBN手性混淆。
3. 正常材质模式捕获一次基线，立即记录/冻结probe、LOD和阴影状态；不在AOV模式捕获。
4. 原道路几何上plain/mixed比较，真实road ROI分为近中远与明/阴；每组分项闭合、normal/NdotV/NdotL、effective roughness与baseColor。
5. 加一次恒定粗糙度/平法线的材质控制，区分空间结构与光照；恒定白环境DFG结论继续沿用，不需要反复重做同一个证明。
6. 单独做probe历史与位置实验；复制/复原资源有明确ownership，避免已dispose基线引用。
7. 同一原生产显示管线做截图与短距离相机运动对照，注明无车辆/无物理；再决定下一项实现。

## 状态与不应转用的旧数字

- PASS_CPU_GEOMETRY：本地原createStrip生成的UV方向、尺度、位置已复核。
- 上轮恒定白环境DFG GPU验证继续有效。
- 空visual导致旧太阳方向错误的那批32组数字已撤回，不能复用。
- 修正太阳后重跑的平面数据仍属于镜像UV基底的受控平面结果；可说明机制，不能当作完整赛道占比。
- 本文件没有运行完整视觉场景GPU验证，也没有玩家驾驶/物理验收。
