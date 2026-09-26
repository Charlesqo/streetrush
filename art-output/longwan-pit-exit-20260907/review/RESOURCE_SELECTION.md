# 素材筛选与用途

本轮选择真实 PBR 扫描表面加自主构造模型。没有下载来历不清的建筑模型，也没有用参考作品截图充当材质。

| 资源 | 判断与用途 | 文件状态 |
|---|---|---|
| [Poly Haven Asphalt 01](https://polyhaven.com/a/asphalt_01) | 保留扫描颗粒、法线和粗糙度；原图偏棕，另制中性灰派生颜色图用于主赛道与维修通道。2m 平铺。 | 已取得 1K 原图，已用于实模渲染 |
| [Poly Haven Rough Concrete](https://polyhaven.com/a/rough_concrete) | 用于混凝土墙、基础和预制构件，削弱法线强度以免成为夸张石块。以构件尺度重定 UV，艺术用平铺 3.4m，原始 metadata 尺寸独立保留。 | 已取得 2K 全通道，已用于实模渲染 |
| [Poly Haven Dry Ground Rocks](https://polyhaven.com/a/dry_ground_rocks) | 适合干燥缓冲区基层。与真实几何小石子、非直线土边和草叶搭配，避免只有一张平面贴图。不是为轮胎摩擦标定的数据。 | 已取得 2K 全通道，已用于实模渲染 |
| [Poly Haven Floor Pavement](https://polyhaven.com/a/floor_pavement) | 限定用于后台设备/步行铺地，铺块尺寸与接缝保持在米尺度；避免挪到赛车主路面。 | 已取得 2K 全通道，已用于实模渲染 |
| [Kloofendal 48d Partly Cloudy, Pure Sky](https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky) | 现有项目已有来源证据的天空 HDR，用于环境照明与实时反射；本轮复制而不修改原文件。 | 已取得 2K HDR |

上述资源的原资产许可为 [Poly Haven CC0](https://polyhaven.com/license)，2026-09-07 核对官方声明。作者、物理尺寸原值、文件哈希和源 URL 见 `sources/source-manifest.json`；材料中 R/G/B 通道解释不能外推为其他库的约定。

图形与构造自制：车库、控制室、岗亭、看台、排水格栅、护栏、防护网、灯杆、龙门架、信号、工具车、轮胎架、五金，及涂层/橡胶/路面涂装 PBR。生成源码在 `source/build_scene.py`。深色涂层的边缘半径、螺栓和接缝属于实际几何。

当前锁定范围所需素材均已取得，没有必须请用户手动下载的阻塞项。未引入未经文件检查的付费模型，因此没有把网页宣传图质量记为模型 PASS。更高分辨率扫描并不自动提高成品，需要按目标镜头和性能预算决定。

已放弃的早期街区方案素材目录仍保留，正式可移交包另存原样副本，不依赖该早期目录。

## 参考图权利

`review/reference-hakone.jpg`：Chris Rojo 作品集中 Forza Motorsport 团队画面，© Xbox Game Studios，仅品质评估参照。

`review/reference-acc-pit.jpg`：Assetto Corsa Competizione 官方画面，Kunos/原权利人所有，仅品质评估参照。

参考图不是 CC0，不属于可复用游戏美术资产。GLB 和 Blender 场景不使用这些图。

实时预览依赖 Three.js（MIT），原许可随 `viewer/vendor/THREE-LICENSE.txt` 保存。

## 有限免费模型获取与本地材质复核（2026-09-07）

本轮从 Poly Haven 官方页面与 API 顺序取得 2K glTF 及其声明的 buffer/贴图依赖：`concrete_road_barrier`、`modular_chainlink_fence`、`modular_electric_cables`。三包实际合计 44,852,539 bytes，低于 180,000,000 bytes 限额；URI 全部解析到本地文件，文件 API MD5 与实际值一致，质量状态均为“待实模验证”。电缆模型的 glTF 含 8 个名称匹配 `box`/`junction` 的小组件节点/网格，适合作为设备区候选。原始 API metadata、官方页面和逐文件 URL/MD5/SHA-256/字节数/图像尺寸见 `review/free-model-acquisition.json`；未下载 8K 贴图集。

已读取并保留 `lawn_grass_tkynejer_2k_ue_mid.zip` 与 `asphalt_crack_ugcmfivcw_2k_ue_mid.zip` 的原始压缩包，并仅解压这两个 2K UE glTF 集合。总额外占用 67,466,993 bytes，低于 80,000,000 bytes。嵌入 JSON 与 ZIP 注释均没有 source、license、author 或 attribution 字段，不能仅凭文件名或 asset ID 推断 Quixel、Poly Haven 或其他供应商许可；来源与许可状态均为“UNVERIFIED”，质量状态为“待实模验证”。逐条 ZIP 内容、嵌入 metadata、真实字段存在性、图像尺寸和哈希见 `review/local-material-screening.json`。
