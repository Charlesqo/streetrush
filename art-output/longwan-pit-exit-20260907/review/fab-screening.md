# Fab 素材筛选记录：Longwan 维修区出口

- 日期：2026-09-07（Asia/Shanghai）
- 场景边界：96 m 主直道 + 维修区出口；车库/控制室/岗亭/护栏/防护网/地表；不扩展为城市。
- 浏览范围：只复用现有 Chrome Fab 标签页 `1013186978`（`https://www.fab.com/`），没有新建标签页。
- 判定口径：`网页核实`只表示详情页明确显示的规格/许可/格式；没有拿到文件或打开源文件的，一律标为`待验证`，不把网页预览或商家宣传当作实模 PASS。
- 新指示后已暂停下载、领取、购买、添加到库以及接受新许可。

## 精选 6 项

### 1. Road Essentials - Modular Roads, Bridges & Guardrails

- URL：<https://www.fab.com/listings/597854da-9725-4871-905e-a9ec04bdd15f>
- 适用：96 m 主直道和维修区出口的可拼接道路底座；还可提供护栏、混凝土隔离墩、路面补丁/积水、标志和路边小设施。
- 页面规格：当前版本 v1.4；Unreal Engine；评分 4.9/5（9 条）；标称 spline-ready 模块道路，支持道路标线、污渍和裂缝强度调整；包含 3 种 guardrail、concrete barriers、asphalt patches、puddles、signs、17 个桥部件、5 个 master material + ORM；更新说明提到 Smart Road Markings 和 Utility Boxes。
- 许可/价格：详情页仍是“选择许可”，未显示可确认的许可或当前价格；搜索页显示起始价 ¥335.50。不要购买或接受新条款。
- 质量状态：`网页核实 / 待验证`。与目标最贴合，但还没有实际文件，尺寸、材质实例和碰撞需在项目内复核。

### 2. Racing Pit Lane and Garage

- URL：<https://www.fab.com/listings/589e3eb2-56cf-4412-b1ff-36da40d43559>
- 适用：维修区出口的车库/控制区/岗亭语义和机电道具；建议只截取一段 pit wall + garage bay，避免引入完整赛道环境。
- 页面规格：Unreal Engine；评分 5.0/5（2 条）；25 个高质量 mesh，可模块化平铺；列出 road section、garage door、ceiling lights、fire extinguisher、pit wall、pit wall comms module、toolbox/cart、tyres（slick/wet）、walkie talkie、wheel gun 等。
- 许可/价格：详情页许可仍需选择；搜索页显示起始价 ¥134.16。未购买。
- 质量状态：`网页核实 / 待验证`。设施清单和目标用途很强，但没有拿到文件，不能据此判定 Forza/ACC 级实模。

### 3. Asphalt Fresh（Quixel Megascans）

- URL：<https://www.fab.com/listings/d656c99c-e792-4880-b832-7835dd450395>
- 适用：主直道新铺沥青基底；可与裂缝/补丁贴花叠加，保持 96 m 直道的连续微表面。
- 页面规格：扫描面积 2×2 m；4096 px/m；texture set + GLTF；Basecolor、Normal、AO、Cavity、Specular、Roughness、Bump、Displacement、Gloss 等图；页面显示源包 `asphalt_fresh_sfrofg0a_8k.zip` 为 345.34 MB。
- 许可：页面明确显示 Fab `标准许可证`（<https://www.fab.com/eula>）；AI 使用为否。
- 库存状态：Fab 商品页显示“已保存在我的库中”，但直接访问 `https://www.fab.com/library?q=Asphalt+Fresh` 返回 0 个结果；库存索引存在冲突，暂不把它当作已确认的可下载库存。
- 质量状态：`网页核实 / 待验证`。真实扫描材质信号强，但包较大；按新指示没有下载。

### 4. 干枯草地合集（Quixel Megascans，用户库）

- URL：<https://www.fab.com/library/assets/ed833bba-88a4-4a7b-b0fb-888421fbd32a>
- 适用：主直道两侧和维修区出口外缘的干草、碎石过渡带；控制密度，避免形成开放自然环境。
- 页面规格：高分辨率、统一 PBR 校准的 3D 扫描资产；仅 Unreal Engine；兼容 4.25–4.27 和 5.0–5.3；Asset package；Windows/macOS；页面标注已下架但仍可下载/导出。
- 许可：页面链接到 Unreal Marketplace 内容许可（<https://www.unrealengine.com/eula/content?setlang=zh-cn>）；AI 使用为是。
- 库存/下载状态：用户库中有明确条目；点击库内“下载”只展开“访问虚幻引擎文件和添加素材到库中”的入口，没有显示可直接下载的文件名或大小；没有继续点击。
- 质量状态：`网页核实 / 待验证`。扫描资产适合路缘，但 UE-only 且未检查实际 mesh、LOD、实例化成本。

### 5. [FREE] Weathered Asphalt（Baso Assets）

- URL：<https://www.fab.com/listings/70092d2c-d4ba-4af6-87a0-066af859c091>
- 适用：维修区出口、路肩和裂缝/旧沥青过渡块；可作为局部破损层，不建议直接覆盖整条 96 m 主直道。
- 页面规格：OBJ；25,000 poly；Diffuse 和 Normal 均 8192×8192；同时提供 GLTF/GLB/USDZ；源包 `free-weathered-asphalt.zip` 90.34 MB（GLTF 77.88 MB、GLB 77.87 MB、USDZ 23.07 MB）；评分 5.0/5（1 条）。
- 许可：Creative Commons Attribution (CC BY 4.0)（<https://creativecommons.org/licenses/by/4.0/>）；AI 使用为是。
- 质量状态：`网页核实 / 待验证`。规格和 photogrammetry 标签满足裂缝/混凝土方向，但文件未落盘，不能标实模 PASS。

### 6. Chain Link Fence（ashton3ddesigns）

- URL：<https://www.fab.com/listings/bd43abe2-889a-4e8e-9ff0-a141dd0bf489>
- 适用：维修区出口外侧防护网/围界；页面描述为老化、锈蚀链式围栏，必要时在项目内替换为更现代的金属材质。
- 页面规格：FBX 源包 33.48 MB；GLTF 25.80 MB；GLB 25.79 MB；USDZ 9.78 MB；FBX/GLTF/GLB/USDZ；描述写明 Blender 制作、Quixel Mixer 贴图、面向 Unreal Engine 5；评分 5.0/5（2 条）。
- 许可：Creative Commons Attribution (CC BY 4.0)（<https://creativecommons.org/licenses/by/4.0/>）；AI 使用为是。
- 质量状态：`网页核实 / 待验证`。文件小且用途明确，但锈蚀外观和未公开的 poly/LOD 数据需要实际检查。

## 已查看但未列入精选

- 用户库中的 `Megascans - Abandoned Factory`：<https://www.fab.com/library/assets/cbccadfe-e41c-4cb1-b575-ff64adb2796a>。高分辨率 PBR 表面扫描、UE Asset package、兼容 4.23–4.27/5.0–5.3、Unreal Marketplace 内容许可；页面标注已下架但可下载/导出。更偏旧工业废墟，未作为现代车库首选。
- 用户库中的 `采石场合集`：<https://www.fab.com/library/assets/3e83631f-d75b-4b1d-befe-57dc114a68b1>。高分辨率 PBR 扫描、UE-only、兼容 4.25–4.27/5.0–5.3、Unreal Marketplace 内容许可；可补充路缘碎石/混凝土色差，但不是主道路材质。
- 搜索页还将 Quixel `Modular Metal Guardrail Kit` 标为“已保存在我的库中”，详情为 6413 px/m、0.16×1.42×0.8 m、closed mesh、FBX/GLB/GLTF/USDZ；但 `https://www.fab.com/library?q=Modular+Metal+Guardrail+Kit` 返回 0 个结果，所以库存状态未确认，未列为可直接取用的库存包。

## 下载与拦截记录（准确区分网站行为和自动审批）

在用户此前授权自主找下载素材的阶段，使用 `mcp__cua_repl.js` 对现有 Fab 标签页执行过两次实际下载尝试；新指示到达后已完全停止，不重复尝试：

1. Weathered Asphalt：先点击页面“下载”，再点击下载面板中的“下载 OBJ 素材”（`free-weathered-asphalt.zip`，90.34 MB）。页面随后显示 `content-download-emp.distro.on.epicgames.com 已被屏蔽`、`此页面已被 Chrome 屏蔽`、`ERR_BLOCKED_BY_CLIENT`。没有取得文件。
2. Chain Link Fence：先点击页面“下载”，再点击下载面板中的“下载 FBX 素材”（`chain-link-fence.zip`，33.48 MB）。页面随后显示 `emp-fastly-stitched.epicgamescdh.com 已被屏蔽`、`此页面已被 Chrome 屏蔽`、`ERR_BLOCKED_BY_CLIENT`。没有取得文件。

这是 Chrome/网站下载链路返回的页面级屏蔽，具体原因只显示为 `ERR_BLOCKED_BY_CLIENT`；没有绕过，也没有猜测更深层原因。此次没有调用 `functions.exec` 的 `require_escalated`，没有触发自动 approval review，因此不存在“自动审批拒绝”；两次失败均来自 Chrome 显示的上述网站下载屏蔽。没有发生购买、付款、添加到库或接受新许可。

结论状态：6 项均为候选审查结果；除页面明确给出的规格和许可外，文件质量、LOD、碰撞、材质实例和 Unreal 导入结果均为 `待验证`，没有任何生产/实模 PASS。
