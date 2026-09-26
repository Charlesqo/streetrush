# 原型素材来源

此目录用于独立的界面预览，不接入游戏运行链。车辆和赛道背景均来自项目自身现有截图，复制时没有修图、重新生成或替换车辆资产。预览中的速度、圈时、成绩等动态字段属于静态演示数据，不能视作实跑记录。

## 背景图片

源目录：`E:\Projects\streetrush\streetrush\research-output\vehicle-render-review-20260920`。

| 原型文件 | 源文件 | 尺寸 |
| --- | --- | --- |
| assets/mx5.png | mx5-settled-hero-2x.png | 1524 × 1304 |
| assets/m3e30.png | m3e30-hero-2x.png | 1524 × 1304 |
| assets/gt3rs.png | gt3rs-hero-2x.png | 1524 × 1304 |
| assets/lp700.png | lp700-hero-2x.png | 1524 × 1304 |
| assets/amggt3.png | amggt3-hero-2x.png | 1524 × 1304 |
| assets/m5g90.png | m5g90-hero-2x.png | 1524 × 1304 |
| assets/drive.png | mx5-chase-2x.png | 1524 × 1304 |

该目录的 `capture-manifest.json` 标注采集日期为 2026-09-20；截图来自当前项目 localhost 场景的 renderreview 模式，使用既有 hero / chase 相机，FOV 58，原始 PNG canvas 导出，未修图。两倍审阅分辨率越过生产像素预算，不代表生产性能。除 MX-5 settled 画面经过 10 秒正常预览外，其他车辆对照画面在生成后暂停，不能据此判断悬架、地面接触和车辆物理。

全部七张图均不含原有 UI。Hero 画面为同一赛道起终点线的前侧视角；drive 为 MX-5 尾随视角。

## 车辆展示数据

源文件：`E:\Projects\streetrush\streetrush\src\config.js` 的 `CARS` 数组。下列字段按项目配置原样记录，不表示对现实车辆规格或游戏物理结果的独立核验。

| id | name | power | mass | torque | speed | drivetrain |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| mx5 | MAZDA MX-5 NA | 116 | 990 | 136 | 185 | RWD |
| m3e30 | BMW M3 E30 | 200 | 1200 | 240 | 230 | RWD |
| gt3rs | PORSCHE GT3 RS | 525 | 1450 | 465 | 296 | RWD |
| lp700 | LAMBORGHINI LP700 | 700 | 1680 | 690 | 350 | AWD |
| amggt3 | MERCEDES AMG GT3 | 550 | 1285 | 650 | 310 | RWD |
| m5g90 | BMW M5 G90 | 727 | 2435 | 1000 | 305 | AWD |

项目赛道名称为“龙湾国际赛道”，配置总圈数为 3。

## 额外检查，未复制

`research-output/render-foundation-audit-20260920/normal-mx5-race.png` 为 1028 × 880，不含 UI。相机更高、车辆更小，起跑龙门架横贯顶部。它与所选 chase 图片都是接近方形的画幅，并非现成全宽画面；在 16:9 容器中直接 cover 裁切都会损失上下视野。所选 drive 更适合展示车辆姿态，normal-mx5-race 更适合保留较多前方赛道，实际使用应以构图测试决定。

驾驶页实际使用 drive-wide.png，来源 research-output/render-foundation-audit-20260920/normal-mx5-race.png。原图 1028×880，无 UI，原样复制。
