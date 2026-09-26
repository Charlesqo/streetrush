# StreetRush 共用音效研究交付

本批研究交付了 44 个精选音频文件，另记录 2 个未下载候选。所有内容只写入本目录；没有改动项目代码、运行链或其他研究输出。

下载原始文件总大小为 21,022,163 bytes（约 20.0 MiB），上限为 200 MiB。精选条目中 41 个为 CC0，3 个为 CC BY 3.0。原始 ZIP/7z 均保留在 [`originals/`](originals/)，从包中挑选文件的可复现命令在 [`tools/extract_selected.sh`](tools/extract_selected.sh)。本次只做归档解包，没有重采样、裁切、淡入淡出、归一化或混音，因此所有条目的 `source_start_s` 和 `source_end_s` 为 `null`。

完整机器可读目录在 [`catalog.json`](catalog.json)。其中 `items` 为 44 个精选条目，`research_candidates` 为具体但暂未下载的候选；每条都记录了来源页、许可页、原始路径、可用路径、技术状态、限制和 SHA-256。原始下载和来源页的抓取命令在 [`tools/download_sources.sh`](tools/download_sources.sh)，来源页本地证据在 [`evidence/pages/`](evidence/pages/)。

## 覆盖范围

| 类别 | 精选数 | 主要用途 |
|---|---:|---|
| `vehicle` | 12 | 点火、发动机循环、加速、车门、转向灯、道路交通 |
| `tire_skid` | 3 | 干沥青滑移、刹车尖叫和滑移过渡 |
| `surface` | 2 | 砂石、硬质路面滚动/触地参考层 |
| `wind` | 3 | 短风掠过和户外风噪底床 |
| `environment` | 5 | 远处交通、鸟鸣、观众喊声和鼓掌 |
| `mechanical` | 3 | 底盘、悬挂、换挡、车内异响候选 |
| `collision` | 7 | 金属擦撞、玻璃和车身 slam |
| `ui_feedback` | 9 | 点击、确认、错误、打开、倒计时、成功、失败和赛车混合反馈 |

## 来源与许可核查

来源页面抓取时没有遇到登录、验证码或付费墙。每个页面的 HTML 快照保存在 `evidence/pages/`，目录中的 `source_url` 指向对应的具体资源页，不使用泛搜索页。

- [Kenney Interface Sounds](https://kenney.nl/assets/interface-sounds) 和 [Kenney Impact Sounds](https://kenney.nl/assets/impact-sounds) 页面都明确标注 Creative Commons CC0；[Kenney 支持页](https://kenney.nl/support)说明其资产可用于商业项目、无需署名。分别保留了 `kenney_interface-sounds.zip` 与 `kenney_impact-sounds.zip`，精选 4 个 UI 和 2 个碰撞条目。
- OpenGameArt 的 [Car engine start 01](https://opengameart.org/content/car-engine-start-01)、[Car engine start up 02](https://opengameart.org/content/car-engine-start-up-02)、[Car door SFX](https://opengameart.org/content/cardoorsfx)、[Car blinker SFX](https://opengameart.org/content/car-blinker-sfx)、[Car 1 moving-car sound](https://opengameart.org/content/car-1-1)、[High traffic road sounds](https://opengameart.org/content/high-traffic-road-sounds)、[Short wind sound](https://opengameart.org/content/short-wind-sound)、[Wind](https://opengameart.org/content/wind)、[Bird chirping sounds](https://opengameart.org/content/bird-chirping-sounds)、[Ambient Bird Sounds](https://opengameart.org/content/ambient-bird-sounds)、[Crowd Shouting/Speaking Ambience](https://opengameart.org/content/crowd-shoutingspeaking-ambience)、[Applause in a large hall or church](https://opengameart.org/content/applause-in-a-large-hall-or-church)、[Metal Impact Sounds](https://opengameart.org/content/metal-impact-sounds)、[Glass Break](https://opengameart.org/content/glass-break)、[Mechanical Sounds](https://opengameart.org/content/mechanical-sounds)、[Different steps on wood, stone, leaves, gravel and mud](https://opengameart.org/content/different-steps-on-wood-stone-leaves-gravel-and-mud) 和 [100 CC0 metal and wood SFX](https://opengameart.org/content/100-cc0-metal-and-wood-sfx) 的具体页面均显示 CC0。
- 车辆滑移包来自 [Car Tire Skid Squealing](https://opengameart.org/content/car-tire-skid-squealing)，页面明确显示 CC-BY 3.0，并说明原始 Soundbible 音频经过裁切、归一化及淡入淡出。目录保留原始 `carskid.7z`，精选其三个文件；使用时应署名 Mike Koenig（Soundbible），并可注明 qubodup 的 OpenGameArt 提交页。
- 反馈音来自 [SuperTuxKart sound effects](https://opengameart.org/content/supertuxkart-sound-effects)、[Race Start Countdown](https://opengameart.org/content/race-start-countdown)、[Well Done](https://opengameart.org/content/well-done)、[Game Over Sound (Old School)](https://opengameart.org/content/game-over-soundold-school) 和 [Beep Tone Sound SFX](https://opengameart.org/content/beep-tone-sound-sfx)。这些页面都列出 CC0；Race Start Countdown 页面同时列出多种许可，本目录按其列出的 CC0 记录。Well Done 页面说明其许可在 2024-10-05 改为 CC0，文件名仍保留旧的 `CCBY3` 字样。

建议保留的可选致谢包括 Kenney、Brian MacIntosh（BMacZero 的金属/机械条目）、StarNinjas（观众喊声）、qubodup（Well Done 与滑移页的 OGA 提交），并按滑移资源的 CC BY 3.0 要求完成署名。许可判定以具体源页和 `catalog.json` 为准。

## 试听与技术检查边界

本轮没有播放试听音频，因此 44 个精选条目的 `listening_status` 全部为 `LISTENING_NOT_RUN`，不把技术可解码误报为听感合格。已用 ffprobe 对 `originals/` 中下载的音频和 `previews/selected/` 中的解包精选文件做技术检查：44/44 为 `DECODE_OK`，结果在 [`evidence/technical_check.tsv`](evidence/technical_check.tsv)，SHA-256 在 [`evidence/checksums.tsv`](evidence/checksums.tsv)。这一步只证明容器/编解码可读，不证明循环无缝、动态范围、空间感、噪声、音色适配或游戏内混音合格。

其中 `surface_gravel` 来自作者描述为脚步/建造音效的 CC0 包，明确标为车辆路面层的参考候选；`surface_moving_car` 是页面只标注为 moving car sound 的 CC0 移动车辆录音，没有拆分轮胎、发动机或距离层。`car_sound_effects_pack.zip` 页面明确说明是手机录音、64 kb/s 低质量，本目录只精选 4 个条目；`supertuxkart_sfx.mp3` 是约 82 秒的多类赛车音效混合音轨，没有把它拆成未经记录的伪单条素材。上述限制已同步写入目录条目。

## 未下载候选

`catalog.json.research_candidates` 记录了两个具体页面：

- [27 Metal Audio Samples (SFX)](https://opengameart.org/content/27-metal-audio-samples-sfx)，CC0，27 条未压缩 WAV。因为本批已覆盖多组金属碰撞，为避免冗余暂不下载。
- [Game voice](https://opengameart.org/content/game-voice)，CC0，页面提供倒计时、准备、获得新车、胜利等赛车语音候选及 11.7 MB 全包。由于语音需要产品音色和语言选择，先记录候选，待试听和产品决定后再收集。

它们不是精选文件，也没有伪造路径或 SHA-256；状态是 `RESEARCH_ONLY_NOT_DOWNLOADED`。
