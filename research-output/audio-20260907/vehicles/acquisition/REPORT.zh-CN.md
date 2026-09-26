# 车辆声音研究获取报告

采集日期：2026-09-07（Asia/Shanghai）。本批只做独立声音资料核验，不涉及游戏接入、物理运行链或参数裁决。没有试听条件，所有听感字段均为 `LISTENING_NOT_RUN`。公开下载总量约 4.02 MB，低于 200 MB 上限；没有购买、登录、验证码绕过或对外发消息。

完整资源索引、每个本地文件的 SHA-256、来源许可和阻塞状态见 `catalog.json`。PDF 的文本抽取结果在 `extracted/`，可复现实验脚本是 `reproduce_extraction.py`。

## 1. Lamborghini Aventador：Pole 与 Sonniss 的版本冲突

Pole 的[产品页](https://pole.se/product/lamborghini-aventador-2014/)明确写的是意大利 2014 Lamborghini Aventador LP 700-4 Coupe，6.5 L L539 V12、690 hp、7-speed ISR 半自动变速箱，96 kHz/24-bit。页面给出的可采购版本是：

| 版本 | 页面价格 | 页面规模 | 文件表抽取结果 |
|---|---:|---:|---:|
| Spotting Files | USD 99 | 83 files，839 MB | 83 行，合计 00:23:10.996 |
| Complete Library | USD 249 | 286 clips，31.4 GB | 286 行，合计 18:15:00.099 |

页面真实文件表链接是：[Complete PDF](https://pole.se/wp-content/uploads/2024/01/Lamborghini-Aventador-Sound-File-List.pdf) 和 [Spotting v2 PDF](https://pole.se/wp-content/uploads/2019/01/Lamborghini-Aventador-Sound-File-List-Spotting-v2.pdf)。本地副本分别为 `raw/pole-lamborghini-complete-filelist.pdf` 和 `raw/pole-lamborghini-spotting-v2.pdf`。

Spotting 表中的代表性文件名和时长如下，完整文件名与时长在 `extracted/pole-lamborghini-spotting-v2.txt`：

| 文件名 | 时长 |
|---|---:|
| `Lamborghini Aventador - t1 - SLOW - Away - Exterior 1.wav` | 00:12.862 |
| `Lamborghini Aventador - t1 - SLOW - Drive Accelerate - Engine.wav` | 00:29.265 |
| `Lamborghini Aventador - t1 - SLOW - Drive Stop - Interior.wav` | 00:19.496 |
| `Lamborghini Aventador - t1 - SLOW - Reverse - Exhaust.wav` | 00:24.119 |
| `Lamborghini Aventador - t7 - IDLE - Steady - Interior.wav` | 00:15.202 |

Complete 表包含多麦克风、外部与 onboard 组合，例如 `...t1 - EXT - SLOW - By - D100.wav`、`...t1 - EXT - SLOW - Start Away Stop Up Reverse Away By Stop Off - EXTERIOR 1 - Mix.wav`、`...t1 - ONBRD - SLOW - Start Drive Stop Reverse Drive Stop Off - ENGINE - Center - DPA4061.wav`，这些行的时长均为 04:26.927。PDF 中的每一行都保留了 LP 700-4、采样率、位深、声道和录音机字段。

Pole 的[EULA 页面](https://pole.se/shop/eula/)和页面链接的 [EULA PDF](https://drive.google.com/file/d/1dN-yVRuu7MV0X1jxt9rzYz-Ru7UkiF5P/view?usp=drive_link)已保存。关键条款是全球、非独占、免版税许可；可用于无限数量的个人或商业项目且无需署名；只能放在一个本地硬盘并额外做一个个人备份；不得放到 network drive、分享给未授权用户或以未同步音频形式复制；单用户使用，多工作站/多人需要 multi-user license；禁止用素材训练或开发 AI。版权仍归 Pole，许可需购买证明，不能把素材库本身转售或转许可。

Pole 的[公开 SoundCloud 预览](https://soundcloud.com/polepositionproduction/sets/lamborghini-aventador-sound-library-audio-demo-preview-montage)只保留流媒体链接。页面列出五条试听轨道，显示 `all-rights-reserved`，没有作者明确提供的下载链接，因此没有提取或保存 SoundCloud 音频。

同一标题在[Sonniss 产品页](https://sonniss.com/sound-effects/lamborghini-aventador-2014/)出现另一组页面值：USD 249、366 files、27.48 GB、96 kHz/24-bit，卖家显示为 Pole Position。其公开 [tracklist PDF](https://cdn.sonniss.com/storage/2025/02/Lamborghini-Aventador-2014-Sheet1.pdf)有 366 行，抽取合计 16:07:38.000；例如 `lamborghini_aventador_t10_ext_fast_by_CSS5.wav` 和 `lamborghini_aventador_t10_onbrd_start_fast_drive_decelerate_to_slow_stop_off_engine_center_DPA4061.wav` 都是 01:42。这里保留 Pole 的 286/31.4 GB 与 Sonniss 的 366/27.48 GB 两个原始主张，不自行判定哪个是“完整库”。Sonniss 的[许可页](https://sonniss.com/license/)同样规定购买后全球、非独占、免版税许可、个人/商业项目无需署名、一个本地盘加一个备份、不得网络共享或重新销售素材库，并明确禁止 AI 训练。

车辆标识要单独保留：源文件写的是 `2014` 与 `LP 700-4`；项目目标所指游戏年份是 `2011`。因此这是 2014 车型录音对 2011 游戏目标的年份差异，不能把源资料静默改称 2011，也不能把 LP 700-4 省略成无年份的“Lamborghini”。

## 2. Sounding Sweet：Porsche 992 GT3

通过 [www.sweetsfx.com 的产品导航](https://www.sweetsfx.com/sound-libraries/)和 Porsche 分类页核实到正确产品页：[Porsche 992 GT3](https://www.sweetsfx.com/product/porsche-992-gt3/)。页面当前可见价格（GBP、不含 VAT）是：Short & Sweet £79；Standard Pack £199；Ultimate 版本显示 `Call for Price`。用户给出的短文件表 URL 少了 `SSFX-P992GT3_` 前缀，正确链接是 [SSFX-P992GT3_Short_and_Sweet_FileList.pdf](https://www.sweetsfx.com/wp-content/uploads/2026/02/SSFX-P992GT3_Short_and_Sweet_FileList.pdf)。

| 版本 | 文件数/页面容量 | 文件表抽取时长 |
|---|---|---:|
| Short & Sweet | 52；1.37 GB compressed / 1.46 GB uncompressed | 00:46:13.000 |
| Standard Pack | 233；7.89 GB compressed / 8.42 GB uncompressed | 03:27:21.000 |

两个 PDF 已保存到 `raw/sweetsfx-p992gt3-short-and-sweet-filelist.pdf` 和 `raw/sweetsfx-p992gt3-standard-filelist.pdf`，对应文本在 `extracted/`。关键表项包括：

| 文件名 | 时长 |
|---|---:|
| `VEHCar_Porsche 992 GT3_001a_Slow General Driving_SSFX_Onboard Air Intake DPA 4062 L.wav` | 02:59 |
| `VEHCar_Porsche 992 GT3_001a_Slow General Driving_SSFX_Onboard Exhaust DPA 4062 C.wav` | 02:59 |
| `VEHCar_Porsche 992 GT3_002a_Slow General Driving_SSFX_Onboard Interior Ambeo Stereo.wav` | 01:18 |
| `VEHCar_Porsche 992 GT3_013a_Revs Showoff_SSFX_Onboard Engine Contact L.wav` | 00:25 |
| `VEHCar_Porsche 992 GT3_016a_Ignition On Idle Off_SSFX_External AT BP4025 Stereo.wav` | 00:30 |
| `VEHCar_Porsche 992 GT3_023a_Fast Passby_SSFX_External DPA 4017.wav` | 00:35 |

产品页和 PDF 的描述都明确为普通 GT3：`F6, Manual, Stock, 4.0L`。页面说 Standard Pack 有 interior ambisonic surround、Reaper/Pro Tools sessions，Short & Sweet 没有 surround。这里绝不能写成 `992 GT3 RS` 或 `PDK`。

已保存 [Sounding Sweet EULA](https://www.sweetsfx.com/licensing/)。条款是 Sounding Sweet Limited 授予的非独占、不可转让许可；订单中的工作站/用户数决定范围；付款清算后权利才转移；初始 99 年并自动续期；可把素材嵌入、修改并发布在游戏、影视等 Product 中，但不得把素材本身作为 standalone product 转售，不得把原始或衍生素材放进供第三方下载的音效库，也不得分享、借出或再许可，备份需要书面许可。免费包产品页本身虽然是 £0.00，但 EULA 没有对该免费包单独写出许可条款，报告不把它推断成 unrestricted sample license。

通过网站导航还确认了明确的 [Sweet SFX Free Sample Volume One](https://www.sweetsfx.com/product/sweet-sfx-free-sample-volume-one/)：£0.00、99 个 WAV、2.2 GB compressed / 2.4 GB uncompressed、download only。公开 [免费包文件表](https://www.sweetsfx.com/wp-content/uploads/2025/11/SSFX-Free_Pack_FileList.pdf)已保存，但页面没有暴露无需订单/登录即可取得的音频文件 URL，而且整包超过 200 MB 上限；因此只保存产品页和文件表，没有拿音频样本。其免费样本许可需要采购前向 Sounding Sweet 核实。

## 3. Mazda Miata MX5 NBFL 1.6 Stock

目标页是 [Sonniss Mazda Miata MX5 NBFL 1.6 Stock](https://sonniss.com/sound-effects/mazda-miata-mx5-nbfl-1-6-stock/)，卖家显示 `soundholder`。直接产品页读到 USD 70、149 files、4.63 GB、96 kHz/24-bit、232 min；另一个分类/缓存页出现 USD 49 的 30% off 值，两个页面值都保留，采购时应以当前 checkout 为准。公开 [tracklist PDF](https://cdn.sonniss.com/storage/2025/02/Mazda-Miata-MX5-NBFL-1.6-Stock-Sheet1.pdf)有 149 行，抽取合计 03:52:34.000。

代表性文件名和时长包括：

| 文件名 | 时长 |
|---|---:|
| `Mazda Miata MX5 NBFL 1.6 Stock - 01 - INT - Cabin - on idle off stereo.wav` | 00:40 |
| `Mazda Miata MX5 NBFL 1.6 Stock - 04 - ONB - Designed - accelerations.wav` | 07:57 |
| `Mazda Miata MX5 NBFL 1.6 Stock - 05 - ONB - Designed - RPM ramps.wav` | 06:16 |
| `Mazda Miata MX5 NBFL 1.6 Stock - 08 - ONB - Designed - 2k RPM loop.wav` | 00:29 |
| `Mazda Miata MX5 NBFL 1.6 Stock - Foley - 22 - INT - gloves compartment.wav` | 00:14 |

页面描述包含同步 cabin、3 个 engine microphones、air intake、2 个 exhaust microphones、30 个 exterior files 和 22 个 foley files。这里的 `NBFL 1.6` 是 NB/NBFL 代际参考，不能冒充 NA；报告不做跨代等价结论。

Soundholder 的[原厂域名](https://soundholder.com/)目前能解析但返回缺失 WordPress 主题文件的 PHP fatal error，没有可验证的产品页或原厂许可文本。因此当前可采购、可核查的实际链接是 Sonniss listing；[Sonniss soundholder vendor page](https://sonniss.com/vendors/soundholder/)用于确认卖家身份。Sonniss EULA 条款见上节，适用于在 Sonniss 购买的库。

## 4. Freesound 单条资源

[Miata Start and Stop.mp3](https://freesound.org/people/TurboTheSergal/sounds/523351/)页面显示作者 TurboTheSergal，上传日期 2020-06-22，描述为从车内录制的 Mazda MX5/Miata 启动与熄火；页面元数据为 0:13.881、544.9 KB、44.1 kHz、320 kbps、mono，车辆年份和代际未说明。页面链接 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 并要求署名。

原始下载端点的正常请求返回 302 到 `/home/login/`，所以没有登录或绕过访问控制。页面公开提供的 static HQ preview 已保存为 `raw/freesound-523351-preview-hq.mp3`，实际是约 317 KB、ffprobe 报告平均约 186.9 kbps 的 MPEG、44.1 kHz mono（可能为变码率）；catalog 将它标为 `PREVIEW_ONLY`，不能当作 original。若需原文件，手动步骤是：登录 Freesound 账号 -> 打开上述 sound page -> 点击页面 Download；本批未执行这一步。页面、preview 和任何听感判断都标为 `LISTENING_NOT_RUN`。

## 本地文件与复现

`raw/` 保存公开原始 PDF、HTML 和 Freesound preview；`extracted/` 保存由 PDF 生成的文本；`catalog.json` 包含具体 URL、标题、类型、本地路径、许可证、状态、备注和 SHA-256。用项目提供的 bundled Python 和 `pdfplumber` 运行：

```bash
/Users/charles/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  research-output/audio-20260907/vehicles/acquisition/reproduce_extraction.py
/Users/charles/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 \
  research-output/audio-20260907/vehicles/acquisition/build_catalog.py
```

脚本输出的行数、总时长和 catalog 哈希应与本报告及当前目录内容一致。网页价格、销售状态、EULA 页面和免费包条件可能变化，采购前应重新打开原始链接核对。
