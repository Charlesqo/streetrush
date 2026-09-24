# 素材授权台账

审查日期：2026-08-14；Lamborghini 模型与项目合成音频补充核验：2026-09-24。机器可核验清单在 `licenses/assets.json`，随网页构建发布的署名在 `public/THIRD_PARTY_NOTICES.txt`，导入时的许可证记录保存在 `licenses/evidence/`。

这份台账只记录当前能找到的来源和许可证证据，不把下载页自动当作完整权利保证。车辆品牌、标志和外观可能另有商标或商业外观问题，模型许可证并不等于品牌方授权。

## 当前结论

| 素材 | 证据 | 免费公开预览 | 商业发布 |
| --- | --- | --- | --- |
| BMW M3 E30 / Mazda MX-5 / Porsche GT3 RS | Sketchfab 导出许可证文本，CC BY 4.0 | 可，必须署名 | 可，必须署名 |
| BMW M5 G90 / Mercedes-AMG GT3 | Sketchfab 导出许可证文本，CC BY-NC-SA 4.0 | 可，必须署名并遵守相同方式共享修改版 | **不可** |
| Lamborghini Aventador LP700 | Sketchfab 页面与 GLB 内嵌 metadata 均指向 David_Holiday、CC BY 4.0；见 `licenses/evidence/lamborghini-source-license.md` | 可，必须署名 | 可，必须署名 |
| 两张赛道路面贴图 | Downtown City MegaKit `License_Standard.txt`，CC0 1.0 | 可 | 可 |
| 六车分层 prototype engine banks | 项目使用 MIT 许可的 Engine Simulator 合成；36 个 WAV 和 6 个 bank 清单的生成证据见 `licenses/evidence/generated-engine-audio.md` | 可随游戏分发 | 可随游戏分发 |

M5 G90 与 AMG GT3 的发布 GLB 是优化后的派生文件；原始 GLB 保留在 `source-models/`。这不会解除署名、非商业和相同方式共享要求。六车 bank 是本项目生成的候选音色，不能称作目标车辆的精确录音。生成这些音色时使用的外部 `.mr` 脚本是另一类源文件；公开整个源代码仓库前需单独处理其许可状态。

## 自动检查

```bash
pnpm check:assets
pnpm check:assets:public
pnpm check:assets:commercial
```

- `check:assets` 检查清单覆盖、文件 SHA-256 和署名是否齐全；它用于开发阶段，应当通过。
- `check:assets:public` 是免费公开发布的运行时素材门禁。当前运行时素材应通过。
- `check:assets:commercial` 是收费、广告、赞助或其他商业发布门禁。当前仍会阻止两辆 CC BY-NC-SA 车辆。

清单状态依据模型来源与音频生成证据更新。运行时素材门禁不覆盖 Git 历史、研究目录中的第三方源文件或车型商标。

## 发布前人工复核

1. 打开每个来源页，确认作者、许可证和模型标识仍与台账一致，并保存日期和页面快照。
2. 确认页面内能访问 `THIRD_PARTY_NOTICES.txt`，且产品界面或发布页有明显的“第三方署名”入口。
3. 商业化前替换 M5 G90、AMG GT3，并对所有真实车型的品牌与商标风险复核。
4. 每次替换或重新压缩 GLB 后运行资产检查；SHA 变化会强制重新审查。
