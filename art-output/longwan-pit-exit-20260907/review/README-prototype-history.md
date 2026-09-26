> 当前状态：未通过美术质量验收，仅布局草稿。最新决定见 [质量重评](review/QUALITY_RESET.md)。本页的交付步骤不表示最终包已经完成。

# 龙湾赛道 · 主直道与维修区出口资产集

独立美术资产制作，2026-09-07。游戏源代码与现有资产未接入或替换。

## 打开成果

- `index.html`：双击打开总览、最终多角度图、参考作品并列和文件链接。
- `scene/longwan_pit_exit_editable.blend`：Blender 4.5 LTS 可编辑场景，贴图内嵌；集合可在 Asset Browser 中使用，也可从文件 Append。
- `scene/longwan_pit_exit.glb`：完整组合场景，glTF 2.0 / 米 / Y 向上，贴图内嵌。
- `models/`：按用途拆分的独立模型，导出清单见 `review/export-report.json`。
- `materials/`：完整原材质工作副本、派生颜色图及自制 PBR 图。
- `sources/pbr/`：下载/复制的原始素材；SHA256、作者、源网址与许可见 `sources/source-manifest.json`。
- `previews/`：实际模型渲染；`r01/r02/r03` 是过程检查图，`01–08` 为交付视角。

## 实时查看

在本目录执行：

```sh
python3 viewer/serve.py
```

浏览器访问 `http://127.0.0.1:8768/viewer/`。支持旋转、平移、缩放、选择单项资产及线框查看；静止时不循环绘制。关闭服务按 Ctrl-C。Three.js 依赖已经随包保存，运行不依赖远程 CDN。

## 这套包含什么

主直道样段长 96m、路宽 14m，完整地表底板约 112 × 76m，额外宽度用于样段边缘收口。与现有占位赛道名称和路宽相符；不是整条赛道。

- 三间车库的双层维修楼：立柱、门洞、导轨、卷帘、门槛、编号、二层窗框、阳台栏杆、屋檐结构、屋面设备、内室工作台及机电构造。
- 控制室、外部折返楼梯与平台、无线电天线；裁判岗亭及电气柜。
- 小型六排看台：座椅、开放式钢架、阶梯、栏杆和顶棚。
- 维修区预制隔离墙、成型金属护栏、防护网、灯杆、计时龙门架、信号、距离牌和保护柱。
- 工具车、轮胎架、灭火器等维修设施。
- 主路、维修通道、作业台面、排水槽与格栅、涂装、红白斜坡路缘、缓冲区、砾石与草地过渡。

建筑、设施和地表作为一组协调的资产设计。后续实际集成仍需按游戏资产预算制作 LOD/分区、配置碰撞与测试帧率，本轮状态 **NOT_RUN**，不会把独立预览成功当作游戏生产验收。

## 编辑与复现

`source/build_scene.py` 保存所有构造与材质参数，固定随机种子。Blender 内单位为米、Z 向上，导出时转为 glTF Y 向上。各模型本地原点与组合场景位置见导出清单。

```sh
/Applications/Blender.app/Contents/MacOS/Blender -b -t 3 --python source/build_scene.py -- --no-render
/Applications/Blender.app/Contents/MacOS/Blender -b -t 3 --python source/render_views.py
/Applications/Blender.app/Contents/MacOS/Blender -b -t 3 --python source/export_assets.py
```

重建脚本会生成到上述固定路径；已有手工编辑可另存为新 `.blend` 再运行。导出副本合并同一资产的构件以减少绘制调用，可编辑源场景保留分件。

## 材质、参照与验收

完整说明在 `review/RESOURCE_SELECTION.md`；视觉迭代在 `review/VISUAL_REVIEW.md`；最终达到的部分与差距在 `review/FINAL_ASSESSMENT.md`。参考图仅用于比较，不属于可复用模型或材质，未嵌入场景。

当前文件制作状态以 `review/bundle-verification.json` 和最终视觉评估为准。通道校验、文件存在、导出成功各有自己的证据范围，不能证明成品与成熟赛车游戏整体等质。
