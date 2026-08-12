# 仓库与发布护栏

## 工作区边界

原始只读来源是 `/Users/charles/Documents/street-rush-game/street-rush-studio/`。当前可写副本是 `/Users/charles/Documents/New project/street-rush-studio-continuation/`，它有自己的独立 Git 历史；外层 `New project` 仍是包含无关项目的混杂工作区。原始项目和素材库不在本副本内回写。

网页游戏、C++ 物理和 C++ 音频是不同范围；C++ 实验不属于这个隔离副本。所有版本命令都应先确认：

```bash
git rev-parse --show-toplevel
git status --short --branch
```

输出的仓库根必须等于 `/Users/charles/Documents/New project/street-rush-studio-continuation`。不要从外层 `New project` 根目录或它的上级目录执行 `git add .`、提交或推送。

原始只读来源保持不变；本项目不会修改它。外层混杂工作区也不属于本仓库，不能从那里提交、推送或管理 Street Rush。

独立 Studio 仓库已用 `.gitignore` 和 `pnpm check:secrets` 阻止常见密钥、环境文件和令牌进入可提交集合。扫描器只报告路径和规则，不打印秘密值。发布门禁还会用 `pnpm check:git-release` 确认仓库根、提交基线和干净工作区。

## 可复现安装与验证

要求 Node.js 22 或更高版本，以及 `package.json` 声明的 pnpm 版本。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm-workspace.yaml` 明确允许锁定依赖中的 `esbuild` 安装脚本，避免首次安装停在交互式构建批准。`verify` 依次运行六车物理烟测、Vite 构建、Cloudflare 限制与产物新鲜度、秘密扫描和素材清单校验。

`dist/` 不提交。`check:cloudflare` 会验证单文件大小、文件数量、源码是否比 `dist/index.html` 更新，以及 `public/` 与 `dist/` 的静态文件是否逐字一致。

## 发布门禁

```bash
pnpm check:release:public
pnpm check:release:commercial
```

当前两个命令都应当在授权步骤失败，而不是被绕过：

- 免费公开发布被 Lamborghini 模型的未知授权阻塞。
- 商业发布还被 Lamborghini 模型的未知授权，以及 BMW M5 G90 与 Mercedes-AMG GT3 的 CC BY-NC-SA 4.0 阻塞。

技术检查变绿不代表可以发布。只有在资产台账、人工设备试玩、变更摘要、干净 Git 状态和回滚构建都准备好后，才进入部署。部署 CLI 版本和远端项目也应固定并记录；本仓库目前故意不提供“一键直传生产”的命令。
