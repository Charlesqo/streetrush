# 龙湾赛道环境资产 · 制作中

本轮独立保存，不接入游戏。完整资产组仍未通过美术验收。此前 r01–r06 场景保留为布局草稿，不能作为最终交付。

## 当前可检查的成果

**当前重点：路肩斜面、齿纹和材质近景，以及可编辑的曲线路径。** 美术目标保留；参数可用不算美术达标。路边 r02 被用户指出形状和防护网问题，现已生成 r03 替代样段。完整区域与其他设施仍待统一制作。

- [当前成果总览](index.html)
- [路肩实图、参数与参照](review/kerb.html)：实际近景、灰模和直线／弯道／S 弯。
- [原生曲线路肩](scene/longwan_kerb_procedural.blend)：Blender Geometry Nodes，路径、长度、宽度、横坡、齿纹独立可调，贴图打包。
- [路肩编辑说明](review/KERB_GENERATOR_USAGE.md)：不需要额外插件。
- [路肩网格导出](models/longwan_kerb_examples_realtime.glb)：保留评估后的实体网格、UV 和 PBR。
- [路边 r03](review/roadside.html)：24 m 道路、路肩、排水、碎石、草地、成型护栏与带内倾顶部的实体防护网。
- [路边编辑场景](scene/longwan_roadside_editable.blend) · [路边导出](models/longwan_roadside_realtime.glb)

**维修库采用经过实模检查的原生建筑组件重建。** 对这个单体已完成三角度渲染与独立实时预览检查。

- [当前实图、优秀作品参照与差距](review/native-building.html)：离线可打开的阶段审阅页。
- [可编辑维修库](scene/longwan_pit_building_native.blend)：原生 UV/PBR，完整建筑体量、内部分层和楼梯，贴图内嵌。
- [实时模型副本](models/longwan_pit_building_realtime.glb)：米、Y 向上；材质贴图内嵌。体积处理报告见 [native-runtime-pack.json](review/native-runtime-pack.json)。
- [原始编码导出](models/longwan_pit_building_native.glb)：保留原始贴图编码的导出，约 251 MB。
- [正面](previews/native_garage_front.png)、[近景](previews/native_garage_near.png)、[背面](previews/native_garage_rear.png)：实际 Blender Cycles 渲染。
- [质量判断](review/NATIVE_BUILDING_ASSESSMENT.md)：已达到的部分、未解决的部分和验证边界。

在此文件夹运行 `python3 viewer/serve.py`，然后打开 `http://127.0.0.1:8768/viewer/native.html` 查看真实 GLB。支持三视角、光照切换与线框。静止时不持续渲染，Ctrl-C 关闭服务。

## 原始资源与编辑

建筑立面基础来自 **Poly Haven / James Ray Cock / Modular Factory Facade，CC0**。原始模型及 19 张贴图完整保留在 `sources/native-models/modular_factory_facade/`。本轮完成组合、墙体背面、楼板、内部交通、结构与赛道标识等改造，不把源作者的几何或纹理称为原创。

- [完整来源清单](sources/source-manifest.json)
- [下载尺寸与校验记录](review/native-factory-acquisition.json)
- [原生材质检查](review/native-factory-material.png)、[同机位白模检查](review/native-factory-clay.png)
- `source/build_native_garage.py`：重建编辑脚本。
- `source/export_native_garage.py`：从编辑场景导出独立建筑。
- `source/pack_native_runtime.py`：只改变运行副本的图像编码，保留原始文件。

旧场景、旧模型、各轮图像均保留；旧文档中的计划性“交付视角”“最终评估”不代表文件已完成，历史说明已存入 `review/README-prototype-history.md`。当前范围与后续优先级以 [PLAN.md](PLAN.md) 为准。

游戏集成、碰撞、目标游戏帧率：**NOT_RUN**。独立预览可以加载和显示材质，不等于通过整套美术或游戏生产验收。
