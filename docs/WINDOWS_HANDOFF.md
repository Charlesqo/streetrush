# Windows 继续开发交接 — 2026-09-08

本文件是迁移说明，不表示已经复制到 Windows 或完成 Windows 验证。

## 复制当前工作目录

来源为 /Volumes/Storage/streetrush。保留完整工作目录，包括 .git、尚未提交/未跟踪的文件、public、src、scripts、crates、apps、data、docs、licenses、art-output、scratch、research 和源素材目录。不能仅重新 clone 或只复制已提交文件，否则会漏掉本次场景与诊断成果。

可排除可重建的平台依赖和缓存：node_modules、target、dist、.pnpm-store、.wrangler、.DS_Store。src/generated 可重新生成。不要把 Mac 的 node_modules 和 Rust target 当作 Windows 可直接复用的构建环境。

Windows 旧目录若有独立改动，先复制到新目录核对，勿直接覆盖。开始复制前停止两端正在写入此项目的任务，避免复制一半时文件又变化；保留 Mac 原目录直到 Windows 正常启动。

## Windows 启动

已有开发环境可复用。需要项目兼容的 Node（本项目组合要求 Node >=22.12）、pnpm 11.9.0、Rust/rustup。rust-toolchain.toml 已声明 stable 和 wasm32-unknown-unknown；构建脚本已处理 cargo.exe。

在复制后的项目根运行：

```powershell
pnpm install --frozen-lockfile
pnpm dev
```

如缺少 Rust WASM target，执行 `rustup target add wasm32-unknown-unknown`。开发入口会先构建共享核心 WASM；不要为跳过安装而删除这一步。常规入口是 http://127.0.0.1:5173/。

## 已接入与待办

- 正常游戏已经接入龙湾全圈环境：17 段路肩、护墙和防护网、缓冲区、维修区、看台、树木；原始美术保留。
- 正常游戏没有误加的全局 10 FPS 限制。circuitreview / pitpreview 仅为开发检查页，5 FPS，静止自动停绘。
- 最近用户要求先诊断闪烁和性能，暂不大改。诊断结论及下一步见 TRACK_FLICKER_PERFORMANCE_DIAGNOSIS.md，数据在 scratch/track-diagnosis-20260908/。
- 白线亚像素覆盖、整批场景提交、阴影重画、后处理和 CPU 步骤开销是接下来检查的方向。跨帧抗锯齿尚未实现，不能声称问题已解决。
- 项目有其他任务的既有改动，禁止回退或覆盖。车辆物理必须遵守根 AGENTS.md 和对应规范；本轮未替换物理模型，也没有新的全套 target 验收结论。

## 已知平台差异

游戏运行链未发现本次场景对 /Volumes 或 /Users 绝对路径的依赖。部分离线美术生成脚本仍写死 Mac 路径、使用 sips 或 /tmp 输入，尤其 scripts/build-longwan-assets.py 和 scratch 下 Blender 辅助脚本；Windows 若要重新生成美术，需要单独适配。已有 public/scenery/longwan 派生素材可直接用于游戏，不必先重跑这些脚本。

仓库中的 RELEASE.md 等旧文档包含历史 Mac 路径，README 也记载旧 Windows 目录 E:\Projects\streetrush。它们不能替代对当前 Windows 实际根目录的核对。

文件名扫描未发现 Windows 非法名称。旧实验快照 scratch/lighting-review-20260906/baseline/public 是指向 /Volumes/Storage/streetrush/public 的符号链接；迁移后如继续使用该旧快照，需要重新指向 Windows 当前 public。它不在正常游戏入口中。
