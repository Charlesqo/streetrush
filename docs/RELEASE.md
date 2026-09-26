# 仓库与发布护栏

## 工作区边界

当前 Windows 整合仓库是 `E:\Projects\streetrush\streetrush`，拥有独立 Git 历史。外层 `E:\Projects\streetrush` 还包含素材库、UI 原型和其他工作材料，并不是这个 Git 仓库。历史 Mac 来源与其他只读来源见 `docs/SOURCE_INVENTORY.md`；不要回写来源工程或素材库。

网页游戏、C++ 物理和 C++ 音频是不同范围；C++ 实验不属于这个隔离副本。所有版本命令都应先确认：

```bash
git rev-parse --show-toplevel
git status --short --branch
```

输出必须是包含本项目 `package.json`、`Cargo.toml` 的实际 Git 根目录。在当前 Windows 工作区中应为 `E:\Projects\streetrush\streetrush`；其他机器或独立 checkout 可使用自己的根路径。不要在外层工作资料目录提交、推送，或用 `git add .` 将未筛选的研究大文件一并加入。

原始只读来源保持不变。GitHub 只保存已提交的内容；未跟踪研究资料、可编辑美术工程和外层工作材料需要各自的备份，不能将一次 main 推送称为整个工作目录的完整备份。

独立 Studio 仓库已用 `.gitignore` 和 `pnpm check:secrets` 阻止常见密钥、环境文件和令牌进入可提交集合。扫描器只报告路径和规则，不打印秘密值。发布门禁还会用 `pnpm check:git-release` 确认仓库根、提交基线和干净工作区。

## 可复现安装与验证

需要 Node.js 22.12 或更高的兼容版本、`package.json` 声明的 pnpm 11.9.0，以及满足 `Cargo.toml` 要求的 Rust/Cargo（目前至少 1.97）。`rust-toolchain.toml` 声明了 `wasm32-unknown-unknown`；构建会先编译共享核心 WASM。云端构建也须显式准备这些工具，或上传本地/CI 已生成的 `dist`。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm-workspace.yaml` 明确允许锁定依赖中的 `esbuild` 安装脚本。`verify` 运行当前 `package.json` 列出的输入、音频、模型、调度、回放、车辆等检查，再构建并检查 Cloudflare 文件限制、产物一致性、秘密文件和素材台账；以实际命令结果为准，不能把构建成功等同于整套验证成功。

`dist/` 不提交。`check:cloudflare` 验证单文件大小、文件数量、构建记录中的源码指纹和 Git 提交，以及 `public/` 与 `dist/` 的静态文件是否逐字一致。音频 bank 清单在 `.gitattributes` 固定使用 LF，避免 Windows 换行转换造成 SHA-256 误报。

## 发布门禁

```bash
pnpm check:release:public
pnpm check:release:commercial
```

当前素材门禁状态：

- 免费公开发布的运行时素材门禁已可通过：Lamborghini 模型按 CC BY 4.0 署名，六车发动机 WAV 为项目内合成输出。
- 商业发布仍被 BMW M5 G90 与 Mercedes-AMG GT3 的 CC BY-NC-SA 4.0 阻塞。
- 许可尚未核实的八份第三方 `.mr` 引擎定义/派生文件已从整理后的 main 及可达历史排除；生成的 WAV、清单和来源记录仍保留。不要把旧历史或本地备份 bundle 合并/上传回来。
- main 的现有模型不超过 GitHub 普通 Git 文件上限；本地 Codex 检查点对象和未跟踪美术大文件不等于 main 历史。只推需要的分支，不能使用 `git push --mirror` 把本地检查点一并公开。

技术检查变绿不代表可以发布。只有在资产台账、人工设备试玩、变更摘要、干净 Git 状态和回滚构建都准备好后，才进入部署。部署 CLI 版本和远端项目也应固定并记录；本仓库目前故意不提供“一键直传生产”的命令。
