# 本轮交付说明

按用户最新要求，完成当前版本的组合、预览、导出后结束制作，不再启动下一轮。当前版本独立保存，未接入赛车游戏。

## 交付内容

- `scene/longwan_region_editable.blend`：96 m 主直道与维修区出口组合，保留可编辑对象、材质及四段路肩的原生曲线修改器，贴图打包。
- `models/longwan_region_realtime.glb`：按逻辑资产分组的导出副本，内嵌 PBR 贴图，米制、Y 向上。具体三角形与字节数见 `region-export.json`、`region-runtime-pack.json`。
- `scene/longwan_pit_building_native.blend`、`scene/longwan_roadside_editable.blend`、`scene/longwan_kerb_procedural.blend`：建筑、路边和曲线路肩独立编辑源。
- `previews/region_01_overall.png` 至 `region_06_ground.png`：实际场景的整体、驾驶侧、维修作业区、赛控、看台和地表视角。
- `materials/`、`sources/`、`source/`：材质及通道、完整原始来源、可重建的制作脚本。原始素材未被覆盖；旧版场景和预览保留。

区域包括三工位维修楼、赛控塔、裁判岗亭、小型看台、维修区隔离墙、成型钢护栏、防护网、可变斜面及齿纹路肩、排水、碎石与草地，配套信号、距离牌、照明、门架、工具车、轮胎架、灭火器、电气柜和空调等设施。

## 本轮实际做出的改善

- 维修楼采用经过原生模型检查的砖墙、门窗和卷帘组件，补足楼板、楼梯、屋面与设施；赛控塔和岗亭通过砖墙基座呼应建筑。
- 路肩有真实横坡和纵向齿纹，长宽、横坡、齿纹及路径分别可控；已实测直线、转弯、S 弯和已暴露参数范围。
- 防护网有 H 形立柱、内倾顶部、实体网丝、夹具、连接板、基础和背撑。96 m 拼接处去掉重复端柱，并补足护栏搭接。
- 作业区、通行区、草地和排水位置有具体分工；地面保留细节贴图并增加较大范围的变化。采用真实草簇补充边缘形状。
- 看台重新调整座椅密度与座高，采用连续成型座椅，并补充屋面、支柱、支撑、雨水管和护栏。

## 参照与尚存差距

参照仍为 [Assetto Corsa Competizione 官方作品](https://assettocorsa.gg/assetto-corsa-competizione/) 与 [Forza Motorsport / Hakone / Chris Rojo](https://chrisrojo.com/forza)。审阅页将参考图和实际成果并列；参考图只用于评价，不计入可用素材。

当前版本不能称为与成熟赛车游戏同等的美术完成度。主要差距是：大片草地和远景仍显简单，地表沉积与修补缺少足够自然的局部变化，部分材质重复可见，新旧构件的磨损程度还不完全协调，岗亭和部分小设施仍偏简化。预览是独立区域样段，也没有完整关卡的周边场景密度。这些差距保留在交付判断中，不以参数通过、文件数量或渲染成功代替美术结论。

## 来源与编辑

- 建筑基础：Poly Haven / James Ray Cock / Modular Factory Facade，CC0；本轮完成组合和补建，源作者的 UV、几何与材质贡献保留署名。
- 路肩涂层：Poly Haven / Rob Tuytel / Painted Concrete 02、Concrete Floor Painted，CC0；原始通道保留，本轮重新配色和组合磨损。
- 草地表面：Poly Haven / Charlotte Baglioni / Leafy Grass，CC0。
- 草簇：Poly Haven / Rob Tuytel、Rico Cilliers / Grass Medium 01，CC0，使用原始 LOD 单草簇，不使用展示散布球。
- 护栏与围网金属：ambientCG Metal038，CC0，属于程序化 PBR，不能称实拍扫描。
- 其他已取得材质、路障和电气组件：详见 `sources/source-manifest.json` 与各素材的 provenance。未取得的 Fab 候选保持待验证，不计入交付质量。

曲线路肩的原生编辑说明见 `KERB_GENERATOR_USAGE.md`；GLB 保存生成后的网格，Blender 节点保留在 .blend 中。原始生成流程为 `build_region.py`，本轮可见问题的收尾修正为 `finish_region.py`，导出为 `export_region.py`，图像编码处理为 `pack_native_runtime.py`。

游戏接线、碰撞、目标设备游戏帧率均为 **NOT_RUN**；本轮按要求不接游戏。独立浏览器检查只证明已列视角下的模型、贴图与光照显示，不证明游戏生产性能。
