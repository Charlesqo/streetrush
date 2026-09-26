# StreetRush 声音研究与收集交付

独立目录：`research-output/audio-20260907`。2026-09-07完成本轮研究与有界收集；没有修改游戏代码或生产资源，没有接入、购买或对外发消息。用户确认不要求误粘贴的模型/材质制作，也理解本环境无法主观试听。

**从 [声音资料室 index.html](index.html) 开始**：本地音频、原始/预览比较、六车档案、关键参考、手动获取和缺口在一起。没有自动播放或远程播放器，参考链接复用单个窗口。浏览器可记录采用/拒绝理由并导出JSON。

## 实际交付

- 6份逐车档案：核对目标身份、动力、传动、工况、录音位置及不能混用的版本。
- 共用资源采集44条，经过第二轮编辑筛选保留**32条首选候选**，另有**12条未入选**保留原件；首选含设计原料，不能等同于32条成品游戏声音。
- 32份本轮技术预览WAV；1条按固定时间编排的第二版素材走查音频与对应cue表（首版亦保留）。重采样/衰减/裁切只发生在工作副本，原始ZIP/7z/音频不改。
- 12条关键参考，含1份已经保存的Miata公开HQ预览（CC BY4.0、年款未知、不是原始文件）。其余商业demo/实车视频保留原站链接，不把观看权当作游戏授权。
- 厂家来源索引、商业文件表和EULA副本、价格/交付版本冲突、10项优先手动获取资源、署名表、机器可读JSON/CSV和预览变更记录。

**目前没有任何一辆车获得准确目标版本、完整多负载多机位且已验证可用的发动机套库。** 这一项仍为 `SKIP_TARGET_DATA`。LP700已找到同款不同年、值得优先试听采购的来源；其它车已留下明确参照与下一步获取路线。没有用通用发动机补成假“六车齐全”。

## 首选候选分布

| 类别 | 数量 | 解释 |
| --- | ---: | --- |
| 车体细节 | 3 | 主观听感待验证；用途与限制见catalog |
| 场地环境 | 4 | 主观听感待验证；用途与限制见catalog |
| 轮胎滑移 | 3 | 主观听感待验证；用途与限制见catalog |
| 环境风 | 3 | 主观听感待验证；用途与限制见catalog |
| 路面设计原料 | 1 | 主观听感待验证；用途与限制见catalog |
| 碰撞设计原料 | 7 | 主观听感待验证；用途与限制见catalog |
| 机械设计原料 | 3 | 主观听感待验证；用途与限制见catalog |
| 游戏反馈 | 8 | 主观听感待验证；用途与限制见catalog |

## 文件入口

| 文件/目录 | 内容 |
| --- | --- |
| [catalog.json](catalog.json) / [catalog.csv](catalog.csv) | **最终编辑首选**、未入选原因、许可、实际文件与预览区间；优先使用此表 |
| [vehicles/profiles.json](vehicles/profiles.json) | 六车身份与声音需求矩阵 |
| [vehicles/references.json](vehicles/references.json) / [reference-cues.csv](vehicles/reference-cues.csv) | 参照链接、关键段落/建议窗口及时间点核实等级 |
| [手动获取清单](reports/MANUAL_ACQUISITION.zh-CN.md) | 具体商品、推荐理由、适用范围、价格、操作步骤和询价文字（未发送） |
| [品质参照与缺口](reports/QUALITY_AND_GAPS.zh-CN.md) | 选定作品、已达到的部分、差距、状态语义 |
| [预览走查](previews/shared-review-v2.wav) / [时间表](previews/shared-review-v2.cues.json) | 本轮真实文件编排的短音频；不是游戏混音或车型demo |
| [预览技术验证](reports/PREVIEW_VERIFICATION.zh-CN.md) / [处理参数](reports/preview-processing.json) | 样本峰值、时长、衰减、裁切、SHA256；不含主观听感判断 |
| [署名表](ATTRIBUTION.zh-CN.md) | CC0/CC BY具体作者和来源；Miata预览额外署名见下 |
| shared/originals/ | 原始公开下载文件及完整小型ZIP/7z |
| shared/previews/selected/ | 从原始包中挑出的未再处理成员，提取命令留档；不把整个包都称为精选 |
| previews/audition/ | 本轮新制作的技术预览副本 |
| [车辆商品获取报告](vehicles/acquisition/REPORT.zh-CN.md) / [获取台账](vehicles/acquisition/catalog.json) | 原始商品PDF/HTML、许可、手动下载阻塞和Miata HQ预览 |
| [共用采集原账](shared/catalog.json) / [共用采集报告](shared/REPORT.zh-CN.md) | 初轮44项与原始采集记录，包含后续未入选项；**不覆盖最终编辑筛选** |
| [来源索引](evidence/sources.json) / [项目身份只读快照](evidence/project-identity-snapshot.json) | 事实与证据范围，不是新的车辆版本决定 |
| tools/ | 可复现建表、预览处理及静态资料室构建脚本 |

## 最值得先看的三项

1. [Herutsu Isolated Tire Skids](https://www.asoundeffect.com/sound-library/isolated-tire-skids/)：US$45未税，厂家称独立胎声；先确认轻滑、重滑与循环潜力。
2. [Pole Aventador 2014](https://pole.se/product/lamborghini-aventador-2014/)：Complete US$249，先听同take engine/exhaust/cabin；这是2014 LP700-4，不是2011准确录音。保留厂商和商城文件数差异。
3. [Porsche官方992 GT3 RS整圈](https://newsroom.porsche.com/en_US/2022/products/porsche-911-gt3-rs-dream-lap-nuerburgring-nordschleife-30037.html)：只作声学状态参照；普通992 GT3手动库不能顶替RS PDK。

MX-5年款/市场仍未冻结；AMG GT3要保留赛事BoP和消音配置；M5 G90需S68涡轮、混动电驱、纯电/发动机过渡及车内声效开关，不能以F10/F90补齐。

## 本地预览与复现

直接用浏览器打开index.html即可（数据已内嵌）。若所在浏览器限制本地音频，可在本目录运行一个本地服务：

```sh
python3 -m http.server 8766 --bind 127.0.0.1 --directory /Volumes/Storage/streetrush/research-output/audio-20260907
```

然后打开 http://127.0.0.1:8766/ 。服务只读取本研究目录；与游戏服务无关。

不必重跑所有检查。若修改源选项，才依次运行tools/build_research.py、tools/prepare_previews.py、tools/finalize_delivery.py、tools/build_review.py；处理参数和脚本均保留。原始素材只读使用。

Miata HQ预览的额外署名：**Miata Start and Stop.mp3 — TurboTheSergal**，来源 https://freesound.org/people/TurboTheSergal/sounds/523351/ ，[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。本轮保存公开转码预览，未修改；原始320kbps文件需登录下载。无法确认NA1.6身份。

所有主观听感统一 `LISTENING_NOT_RUN`。源账中的ffprobe `DECODE_OK`只表示容器/编解码信息可读；本轮新增ffmpeg检查覆盖预览区间，不承诺长源文件每一帧或真实峰值都已验证。时间表里的原作者章节、本地编排时点、建议抽查窗口严格分开。
