# NAS 材质库审计

审计日期：2026-07-28  
素材库：`/Volumes/Charles/下载/赛车游戏 材质`  
结论：**有用，但只值得做一个很小的路面 A/B 实验；整库导入、8K/EXR 和直接替换现有贴图都不值得。**

## 可复现审计

仓库内的只读脚本会读取 ZIP 中央目录、最多 4 MiB 的 JSON/glTF 元数据，以及最多 256 KiB 的图片头。它不会解压整库、不会完整读取大贴图、不会写 NAS，也不会把素材复制到仓库。

```bash
python3 tools/audit_material_library.py
python3 tools/audit_material_library.py --format json
python3 tools/audit_material_library.py "/Volumes/Charles/下载/赛车游戏 材质"
```

本次运行结果：

- 4 个资产，34 个 ZIP，289 个文件。
- ZIP 总体积 `8,684,546,216` bytes（8.09 GiB）。
- 实测图片分辨率覆盖 1024²、2048²、4096²、8192²。
- 所有 ZIP 路径安全，无加密成员、符号链接或损坏的中央目录警告。
- JSON/glTF 中检测到的许可证、版权、作者、署名或权利字段：**0**。
- “重复”按 ZIP 中央目录的 `CRC32 + 未压缩大小` 检测，只能作为快速证据，不是抗碰撞哈希证明。主要重复项是每种分辨率包内反复携带的同一份 JSON；更大的浪费来自同一资产的多分辨率和 Standard/UE/EXR 多套替代版本。

| ID | 资产 | 物理扫描范围 | 类型 | 版本 | ZIP 合计 |
| --- | --- | ---: | --- | --- | ---: |
| `rh0ribp0` | Road Asphalt | 0.39 × 0.39 m | 可平铺路面 | 1K/2K/4K，Standard/UE/EXR | 695.33 MiB |
| `ugcmfivcw` | Asphalt Crack | 1 × 1 m | **不可平铺**裂纹贴花 | 1K/2K/4K/8K，Standard/UE/EXR | 859.30 MiB |
| `tjmgfelew` | Cracked Asphalt | 2 × 2 m | 可平铺旧路面 | 1K/2K/4K/8K，Standard/UE/EXR | 3.82 GiB |
| `tkynejer` | Lawn Grass | 2 × 2 m | 可平铺草地 | 1K/2K/4K/8K，Standard/UE/EXR | 2.75 GiB |

元数据列出了 AO、Base Color、Bump、Cavity、Displacement、Gloss、Normal、Roughness、Specular；裂纹另有 Opacity。UE 包将运行时需要的内容缩成 Base Color、Normal 和 ORM（红=AO、绿=Roughness、蓝=Metalness），裂纹的 Base Color 与 Opacity 合并为 RGBA PNG。这比 Standard 包的九至十张图更接近网页运行时需要。

## 对当前游戏是否真有意义

有意义的部分是**近车路面的微表面反光和少量局部裂纹**，不是物理，也不是“用了扫描材质就自动拟真”。

当前 `src/track.js` 有三个直接限制：

1. 路面使用 `MeshLambertMaterial`，只能显示 Base Color；Normal、Roughness 和 ORM 接上也不会产生正确的 PBR 效果。要试验必须先只把这一张路面材质改成 `MeshStandardMaterial`。
2. 路面 UV 沿赛道每 12 m 循环一次、横跨完整 14 m 只循环一次。`Road Asphalt` 的真实扫描范围只有 0.39 m；若不按米制重设 Repeat，它会被拉成约 12 × 14 m，细节比例错误。沿现有 UV 应约设为 `repeat.x = 12 / 0.39 = 30.77`、`repeat.y = 14 / 0.39 = 35.90`，再检查重复纹是否明显。整条赛道约 2130 m，仍需要低频颜色变化来打散重复。
3. 场外地面是 `CircleGeometry` 的径向 UV，再用 `repeat(36, 36)`。草地扫描图直接套上会产生方向扭曲、中心和边缘比例不一致；在改成世界空间平面 UV 或宏观混合前，草地不是高收益替换项。

物理表面的抓地、滚阻仍来自 `src/config.js` 的 `SURFACES` 和车辆接地点分类。扫描 JSON 只有尺寸、高度、颜色和贴图标定，没有摩擦系数；**不能拿它校准轮胎抓地**。Displacement 也不会改变 Rapier 的平面碰撞体。

性能上，1K 的 Base/Normal/ORM 三张图在 GPU 里按 RGBA8 加 mipmap 粗估约 16 MiB；8K 三张约 1 GiB，尚未计算解码峰值和其他资源。当前项目还要装载高密度车辆 GLB，初次试验没有理由超过 1K。JPEG/PNG 下载体积不等于 GPU 占用。

## 唯一建议的最小试验

先只在本地做 A/B；授权证据补齐前不要发布这些贴图。

### 1. 路面

使用 `road_asphalt_rh0ribp0_1k_ue_low.zip`，只取：

- `Textures/T_rh0ribp0_1K_B.jpg`
- `Textures/T_rh0ribp0_1K_N.jpg`
- `Textures/T_rh0ribp0_1K_ORM.jpg`

整个包 2.15 MiB，三张运行时图约 2.15 MiB。Base Color 设为 sRGB；Normal/ORM 保持非颜色数据；ORM 同一纹理可供 AO 与 Roughness 使用，路面 Metalness 保持 0。先验证 Normal 的 Y 方向，不能仅因包名含 `ue` 就盲目翻转。只替换路面材质，不动碰撞和车辆物理。

### 2. 稀疏裂纹贴花

使用 `asphalt_crack_ugcmfivcw_1k_ue_low.zip`，只取：

- `Textures/T_ugcmfivcw_1K_B-O.png`
- `Textures/T_ugcmfivcw_1K_N.jpg`
- `Textures/T_ugcmfivcw_1K_ORM.jpg`

整个包 901 KiB。它的 JSON 明确写着不可平铺，因此只能按约 1 m 的真实尺寸做少量、共享材质的实例化贴花，随机旋转/缩放并避开起终点；先用 alpha test 与 polygon offset 控制透明排序和闪烁。不要把它当作整条赛道的重复底图。

通过条件应同时满足：追车镜头下细节确实可见、没有明显周期条纹或摩尔纹、首次载入增量约 3.1 MiB、代表设备的 P95 帧时间没有明显退化。若只在静止截图里好看、行驶时看不见，就撤回 Normal/ORM，保留更便宜的 Base Color，而不是升级到 2K/4K。

## 明确不值得用

- 所有 `8k`、`8k_exr`、`8k_ue_raw`：网页内存和解码成本失衡，移动设备还可能触及最大纹理尺寸。
- 所有 EXR：当前没有 EXR 加载/色彩管线；高位深对这个明亮日景赛道没有对应收益。
- Standard 包内的 Bump、Displacement、Gloss、Specular、Cavity：与 Normal/Roughness/ORM 重叠，当前平面几何与碰撞也无法兑现位移价值。
- UE 包里的 `Plane` glTF 与 92-byte BIN：赛道已经有连续曲面网格，只需要贴图，不需要素材自带的测试平面。
- `cracked_asphalt_tjmgfelew` 作为整条赛道底图：2 m 裂纹图案会在约 2.13 km 赛道上高频重复，让专业赛道看起来像复制粘贴的破旧公路。若以后需要局部旧路面，可作为第二阶段遮罩混合，不应进入本次试验。
- `lawn_grass_tkynejer`：当前径向 UV、低角度追车镜头和 850 m 场地会放大平铺感；先修地面 UV/宏观颜色分区再考虑。
- 把 34 个 ZIP、原始 8K 图或未使用通道复制进 `public/`：既增加发布体积，也更接近被禁止的独立素材再分发。

AI 生成一张“看起来像沥青”的图不能自动解决米制比例、无缝平铺、Normal/Roughness 一致性、色彩标定和授权证据。这个库的优势恰好是扫描尺度与成套通道；AI 更适合以后生成低频污渍/颜色遮罩的候选稿，而不是替代这次底层验证。

## 授权结论

本地 ZIP 的文件名、Quixel 风格 ID、JSON 内容和 glTF `generator` **都不能证明取得了哪一种许可证**。授权取决于取得渠道、时间、账户方案和当时接受的条款，而不是文件格式；“非商业网页”也不会自动绕过这个问题。

- [Fab Standard License 官方摘要](https://www.fab.com/eula)允许商业或私人使用、修改、纳入项目，并明确不限制为 Unreal Engine；同时禁止把素材作为独立资源转售或免费再分发。
- [Fab 官方购买与下载文档](https://dev.epicgames.com/documentation/fab/purchasing-and-downloading-assets-in-fab)说明，下载时会显示产品名、许可证类型和格式；旧 Quixel/Bridge 取得内容通常继续适用取得时的旧许可证，Fab 权益需要以账户库记录为准。
- [Epic 的 Quixel Bridge 官方文档](https://dev.epicgames.com/documentation/en-us/unreal-engine/quixel-bridge-plugin-for-unreal-engine)明确说 Unreal Unlimited 下的 Megascans 是 UE-Only，只能与 Unreal Engine/Twinmotion 使用。若这批 ZIP 只来自该方案，Three.js 网页不在许可范围内。
- [Epic Content License Agreement 中文官方文本](https://www.unrealengine.com/eula/content?lang=zh-CN)同样把 Megascans 权利和取得时账户方案绑定，并把 Unreal Engine 方案列为 UE-Only。

因此当前门禁是：

1. 私下本地评估可以继续，不把素材接入公开构建。
2. 公开免费网页之前，为四个 ID 保存 Fab “My Library”/订单页中显示资产和 **Fab Standard License** 的账户证据、取得日期与页面快照；证据应放在不发布的 `licenses/evidence/`。
3. 如果只能证明 UE-Only、教育、内部评估，或仍无法证明取得方式，就不要在 Three.js 版本中使用；换成明确允许网页发布的素材。
4. 即使取得 Fab Standard，也只发布经过裁剪/转换、确实被游戏使用的运行时贴图，不发布原 ZIP、原始全通道包或素材浏览器。

这不是法律意见，而是基于本地证据与 2026-07-28 官方条款作出的发布工程门禁。
