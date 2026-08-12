# Street Rush 车辆数据基线

更新日期：2026-07-28  
机器可读台账：[`data/vehicle-data.json`](../data/vehicle-data.json)

## 这份台账解决什么

它不直接改 `src/config.js`，也不声称把六辆车“模拟准确”了。它先把四类东西分开：

1. **厂家事实**：只收厂家官网和厂家技术表。
2. **厂家数据推导值**：例如用轮胎规格算出的名义几何半径，或 `Cd × 迎风面积`。
3. **游戏调校量**：例如公开资料缺失时使用的 `cdA`、抓地系数、悬挂和制动力。
4. **当前模拟测量**：生产 `VehicleSystem` 在统一条件下跑出来的结果。

没有找到可靠的一手数据就记为 `null / unknown`，不拿论坛、百科、媒体实测或相近年款补空白。`config.speed` 目前只用于车库数字显示，不限制物理极速；`config.power` 当前也没有被 `VehicleSystem` 使用，真正进入动力计算的是 `config.torque`。

## 先看结论

| 车辆 | 型号口径 | 已确认的当前数据 | 主要问题 | 优先级 |
|---|---|---|---|---:|
| MX-5 NA | **尚未锁定市场/年份**；暂拟 1990 北美 1.6 5MT | 116 pk、135 Nm、五挡身份；约 975 kg 只能由 Mazda 的四代对比反推 | 当前齿比和终传与 Mazda 官方 **2005 NB** 技术表完全相同，不能当成 NA 已验证数据；几何、轮胎、CdA、0–100 和极速仍未知 | 1 |
| 911 GT3 RS | 992，EU/Germany，MY P 08/2022 | 1450 kg DIN、525 PS、465 Nm、3.2 s、296 km/h、完整几何/轮胎/传动/aero | `cdA 0.78` 更接近老款 991.2；二挡、轮胎半径也偏离 992；模拟 0–100 为 5.79 s | 2 |
| BMW M5 | G90 sedan，2024 EU；305 需 M Driver's Package | 2435 kg DIN、727 hp、1000 Nm、3.5 s、完整几何/轮胎/传动/aero | 终传 3.15 应为 3.308；`cdA 0.70` 应约为 0.816；模拟 0–100 为 6.35 s | 3 |
| BMW M3 | E30 基础 2.3、200 PS、5MT | 质量、功率、扭矩、轴距、轮距、轮胎、全部齿比、终传、6.7 s、235 km/h | 机械基线基本正确；模拟 0–100 为 9.53 s，说明问题主要在动力/轮胎/起步模型 | 4 |
| Aventador | 2011 LP 700-4 coupé | 厂家历史页确认 700 CV、2.9 s、350 km/h、AWD 身份 | 没有接受到完整的一手精确技术表；质量、扭矩、几何、轮胎、传动和 CdA 暂时都不能冒充厂家事实 | 5 |
| AMG GT3 | 2019 evolution/current Customer Racing | 404 kW、650 Nm、3.0 s、六挡序列式、1285 kg（受 BoP 影响）、前后轮胎 | 车重不是固定常数；传动细节、几何、CdA、极速公开资料缺失；模拟 0–100 为 5.34 s | 6 |

优先级不是按“哪辆车最差”排，而是按“先修后能给后续调校提供多少可靠基准”排。MX-5 是 hero car，却恰好是型号口径最混乱的一辆；它应先锁定市场、年份和变速箱，再谈手感。

## 当前配置与一手基线

### Mazda MX-5 NA

- 当前：`990 kg / 116 / 136 Nm / 2.27 m / 1.42 m / 0.29 m / 3.136… / 4.30 / cdA 0.66 / 显示 185 km/h`。
- Mazda Nederland 只足以确认第一代 NA（1990–1993）1.6、116 pk、135 Nm、五挡手动。该页面的 960 kg 是**含车手的杯赛车最低重量**，不能作为街车整备质量。
- Mazda USA 说 2016 手动挡 2332 lb，比 1990 原版重 182 lb，因此只能得到约 `975.22 kg` 的反推 sanity check；它不是某一配置的直接技术表。
- 当前 `[3.136, 1.888, 1.330, 1.000, 0.814]` 和 `4.300` 与 Mazda 官方 **2005 MX-5（NB）** 五挡数据完全相同。这证明了来源串代风险，而不是证明 NA 也相同。
- 结论：在拿到精确 NA 市场技术表前，除功率/扭矩身份外，其余字段保留为游戏调校量。

### BMW M3 E30

- 厂家精确表：`1200 kg`、`200 PS`、`240 Nm`、轴距 `2.562 m`、前/后轮距 `1.412 / 1.433 m`、`205/55 VR15`。
- 厂家传动：`[3.72, 2.40, 1.77, 1.26, 1.00]`，终传 `3.25`。当前配置完全一致。
- 厂家性能：`0–100 6.7 s`、`235 km/h`。当前 `speed: 230` 只差显示数值，但模拟 0–100 为 `9.53 s`。
- 轮胎规格推导名义半径 `0.30325 m`；当前 `0.31 m` 高约 `2.23%`。
- `cdA 0.68` 没有在接受的一手精确表中找到，仍是调校量。

### Porsche 911 GT3 RS

- 目标锁定为 992：`1450 kg DIN`、`525 PS`、`465 Nm`、轴距 `2.457 m`、轮距 `1.630 / 1.582 m`。
- 轮胎 `275/35 ZR20 / 335/30 ZR21`，名义半径约 `0.35025 / 0.36720 m`；当前单值 `0.335 m` 分别低约 `4.35% / 8.77%`。
- 厂家传动 `[3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84]`、终传 `4.27`；当前二挡 `2.29` 偏低约 `3.78%`。
- 厂家 `Cd 0.39`、迎风面积 `2.21 m²`，推导 `cdA 0.8619`。当前 `0.78` 低约 `9.5%`。
- 老款 2019 991.2 的 `Cd 0.36 × 2.14 m² ≈ 0.7704`，与当前 `0.78` 非常接近。因此当前车辆明显混入了老一代 aero 口径。
- 厂家 `0–100 3.2 s`；当前模拟 `5.79 s`。

### Lamborghini Aventador LP 700-4

- Lamborghini 官网确认：2011 年 LP 700-4、6.5 L V12、700 CV、AWD；0–100 `2.9 s`、极速 `350 km/h`。
- 本轮严格拒绝了非厂家域名上的“厂家 PDF 镜像”，所以没有把常见的质量、轮距、轮胎和传动数字写成已确认事实。
- 当前模拟 `0–100 5.28 s`。`speed: 350` 与厂家 headline 相同，但它只是一项显示数据。
- 后续若没有可归档的一手技术表，合理做法是把质量、传动和 `cdA` 明确标成“游戏版 LP 700-4 调校”，而不是伪装成精确原车值。

### Mercedes-AMG GT3

- Mercedes-AMG Customer Racing 确认：404 kW（约 549.3 PS）、650 Nm、0–100 `3.0 s`、6.3 L V8、六挡序列式。
- 厂家手册给出 `1285 kg`，并明确注明“取决于 BoP 分类”。因此当前质量数值可以保留，但文案和测试基线必须附 BoP 条件。
- 厂家轮胎 `325/680-18 / 325/705-18`，外径推导半径 `0.340 / 0.3525 m`；当前 `0.33 m` 分别低约 `2.94% / 6.38%`。
- 公开一手资料没有给轮距、轴距、逐挡齿比、终传、CdA 或统一极速。这些当前都属于游戏调校量。
- 厂家 `0–100 3.0 s`；当前模拟 `5.34 s`。

### BMW M5 G90

- 厂家精确表：`2435 kg DIN`、`727 hp`、`1000 Nm`、轴距 `3.006 m`、前/后轮距 `1.684 / 1.660 m`。
- 轮胎 `285/40 ZR20 / 295/35 ZR21`，名义半径 `0.3680 / 0.36995 m`；当前 `0.36 m` 略小。
- 厂家齿比 `[5.000, 3.200, 2.143, 1.720, 1.297, 1.000, 0.833, 0.640]`，终传 `3.308`。当前五挡/七挡小偏差，但终传 `3.15` 低约 `4.78%`。
- 厂家 `Cd 0.32`、迎风面积 `2.55 m²`，推导 `cdA 0.816`；当前 `0.70` 低约 `14.22%`。
- 厂家 `0–100 3.5 s`。极速标准为 `250 km/h`，选装 M Driver's Package 才是 `305 km/h`；当前 UI 必须保留这个条件。
- 当前模拟 `0–100 6.35 s`。

## 统一模拟快照

命令：

```sh
pnpm calibrate
```

条件：生产 `VehicleSystem`、平坦沥青、AT、全油门、120 Hz 固定步长、60 秒。

| 车辆 | 0–100 | 0–200 | 60 秒速度 / 峰值 |
|---|---:|---:|---:|
| MX-5 NA | 12.61 s | — | 128 / 128 km/h |
| M3 E30 | 9.53 s | — | 155 / 155 km/h |
| 911 GT3 RS | 5.79 s | 21.63 s | 216 / 216 km/h |
| Aventador LP700 | 5.28 s | 16.84 s | 228 / 228 km/h |
| AMG GT3 | 5.34 s | 15.15 s | 228 / 228 km/h |
| M5 G90 | 6.35 s | 23.88 s | 207 / 215 km/h |

六辆车的 0–100 都显著慢于已有厂家值，不像六组独立数据错误，更像共同的动力传递、起步抓地、换挡或扭矩曲线模型问题。先解决共同模型，再逐车微调，收益高于直接给每辆车堆补偿系数。

## 接下来怎样用

1. **锁车型**：先锁 MX-5 的年份和市场；其他车保持上面列出的明确版本。
2. **先校机械量**：质量、轴距、前后轮距、前后轮半径、逐挡齿比、终传。这些不该用“手感”覆盖。
3. **再校纵向模型**：功率/扭矩曲线、传动效率、起步抓地、换挡时间、驱动形式。仅对齐 0–100 不够，还应对齐 80–120、100–200 和逐挡红线车速。
4. **最后调手感量**：轮胎峰值抓地、滑移曲线、方向响应、差速器、悬挂、制动和辅助系统。厂家通常不会公开这些完整曲线，它们应诚实标成 simcade 调校。
5. **高性能车别只用常数 `cdA`**：992 GT3 RS 和 GT3 赛车有明显下压力与可调空气动力。当前标量阻力模型可以先做 simcade，但不能声称等价于原车空气动力学。

## 一手来源

- [BMW M3 E30 厂家技术表（BMW Group PressClub）](https://www.press.bmwgroup.com/italy/article/attachment/T0015168IT/31610)
- [BMW M3 E30 车型历史（BMW Group Classic）](https://www.bmwgroup-classic.com/en/models/bmw-classics/product-description-page.ad-239-1.bmw-m3-e30.html)
- [BMW M5 G90 厂家规格表（BMW Group PressClub）](https://www.press.bmwgroup.com/global/article/attachment/T0443252EN/621216)
- [BMW M5 G90 发布资料（BMW Group PressClub）](https://www.press.bmwgroup.com/global/article/detail/T0443252EN/the-all-new-bmw-m5?language=en)
- [Porsche 992 GT3 RS 厂家技术表（Porsche Newsroom）](https://download.newsroom.porsche.com/dam/jcr%3A1d390f77-93c3-49c0-89c7-634f5f02b26a/S22_3515_en.pdf)
- [Porsche 992 GT3 RS 发布资料（Porsche Newsroom）](https://newsroom.porsche.com/de/2022/produkte/porsche-911-gt3-rs-weltpremiere-29178.html)
- [Porsche 991.2 GT3 RS 2019 技术表，仅用于排查串代](https://newsroom.porsche.com/dam/jcr%3Ae00c2789-42c7-4dab-a818-a732003194b0/2019_911_GT3_RS_Technical_Specifications.pdf)
- [Mercedes-AMG GT3 产品页](https://customerracing.mercedes-amg.com/en/mercedes-amg-gt3)
- [Mercedes-AMG GT3 / GT4 厂家手册](https://customerracing.mercedes-amg.com/media/files/e64bc3b65b061813a1b8754734dce54aa0a9ff63.pdf?dl=)
- [Lamborghini V12 历史](https://www.lamborghini.com/en-en/news/lamborghini-v12-an-engine-that-made-history)
- [Lamborghini 历史里程碑](https://www.lamborghini.com/en-en/history/milestones)
- [Mazda Nederland 第一代 NA 杯赛车说明](https://nl.mazda-press.com/news/2017/conrad-nieuwe-naamgevende-hoofdsponsor-mazda-max5-cup/)
- [Mazda USA 2016 MX-5 press kit（用于 1990 质量反推）](https://news.mazdausa.com/download/2016_Mazda_MX-5_Press_Kit.pdf)
- [Mazda USA 2005 MX-5 技术表，仅用于排查串代](https://news.mazdausa.com/download/cur_mspeed_specs.pdf)

