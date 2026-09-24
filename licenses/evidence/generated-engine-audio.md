# 六车发动机音频：项目内合成输出

核验日期：2026-09-24。

- `public/audio-banks/` 中的 36 个 WAV 是为 StreetRush 使用 Engine Simulator 0.1.11a 渲染的三转速、两负载循环；另 6 个 `bank.json` 是项目生成的运行时清单。用户确认这些音频由本项目制作。
- `research-salvage/audio/candidates/*/source-record.json` 保存生成记录；`stems.json` 标明音频取自模拟器最终单声道输出。`pnpm test:research-salvage` 对六套 bank、36 个 WAV 的哈希、格式及循环进行核验。
- 没有将第三方实车录音包作为这些 WAV 的来源。它们只是车型音色候选，不是对应车辆的精确录音。
- Engine Simulator 软件以 MIT 许可证发布：https://github.com/ange-yaghi/engine-sim/blob/master/LICENSE 。本台账将生成的 WAV 与项目清单记为 `PROJECT-GENERATED`，允许随游戏分发。
- 若公开整个源代码仓库，`research-salvage/audio/candidates/` 中收录的外部 `.mr` 脚本须单独处理。上游脚本的许可状态不能由这些 WAV 的生成记录代替；这不影响对运行时合成 WAV 的分类。
