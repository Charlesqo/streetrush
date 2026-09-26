# 龙湾赛道环境资产 · 本轮交付

按用户最新要求，当前版本完成组合、预览与导出后结束，不再开启下一轮。所有成果独立保存，本轮未接入游戏。美术差距如实保留，不宣称达到成熟赛车游戏的同等完成度。

## 直接打开

- [交付总览与六个实际视角](index.html)
- [96 m 可编辑组合场景](scene/longwan_region_editable.blend)
- [组合 GLB](models/longwan_region_realtime.glb)：24 个逻辑分组，2,294,727 个三角形，约 296 MB，贴图内嵌。
- [交付说明、来源与剩余差距](review/DELIVERY.md)

## 独立组件

- [原生曲线路肩](scene/longwan_kerb_procedural.blend) · [编辑说明](review/KERB_GENERATOR_USAGE.md)
- [维修库编辑源](scene/longwan_pit_building_native.blend)
- [路边编辑样段](scene/longwan_roadside_editable.blend)
- [全部原始素材及归属](sources/source-manifest.json)

组合包括维修楼、赛控塔、岗亭、看台、路肩、道路边缘、地表、排水、护栏、防护网与既定配套设施。可编辑对象、UV、材质和路肩节点保留在 Blender 文件中，GLB 保存评估后的网格。

## 独立实时预览

在此文件夹运行 python3 viewer/serve.py，再打开 http://127.0.0.1:8768/viewer/region.html。支持六个机位、光照切换与线框，静止时不持续绘制。Ctrl-C 关闭服务。

## 保留记录

原始来源在 sources/，派生材质在 materials/，可重建脚本在 source/。旧版场景、预览与组件说明保留为过程记录，旧 GLB 不代表本次组合。

[未取得的素材候选与判断](review/QUALITY_RESET.md) · [Fab 筛选记录](review/fab-screening.md)。候选未取得文件前均为待验证，不计入本版采用质量。

本轮游戏接线、碰撞、目标游戏帧率均为 NOT_RUN；独立浏览器能显示模型和材质不等于游戏生产性能验收。
