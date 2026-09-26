# Cloudflare 与车辆模型核查（2026-09-26）

## 现有产物符合 Pages 尺寸限制

当前构建约 143.53 MiB，共 120 个文件，最大单文件约 18.38 MiB。Pages 的 25 MiB 限制针对单个文件；总目录超过 25 MiB 不代表不可部署。现有六辆发布 GLB 均小于上限，无须为了当前部署继续压缩模型。限制依据：[Cloudflare Pages 官方说明](https://developers.cloudflare.com/pages/platform/limits/)。

核查时 `https://street.charlesq.net` 与 `https://street-rush.pages.dev` 均返回 HTTP 200，入口引用 `game-BhnpfkpF.js`；当时本地 `dist` 引用 `game-CEHygnC9.js`，两者不是同一入口产物。这里只确认 HTTP 可访问，未验证完整线上游戏或中国大陆不同网络的速度。尚未确认原项目是 Git 集成还是 Direct Upload，本次没有部署。

## “压缩后车炸开”包含两个问题

M5、AMG 优化模型使用 `KHR_mesh_quantization` 的 normalized Int16 顶点。旧加载路径直接在整数属性中烘焙世界变换，超出可表示范围的坐标发生溢出/回绕，导致车体折叠。用真实模型在内存中复现，旧路径将 M5、AMG 的约 5.055 m、4.720 m 车长均压成约 2 m；当前加载器先转 Float32 再变换，尺寸与正确参考一致。此机制已在现有 `src/assets.js` 修正，本次没有改模型或加载器。

优化同时合并了结构：M5 节点由 5806 减至 28，AMG 由 540 减至 51；两者三角形数未减少。AMG 原有独立车轮与卡钳节点已不在优化副本中。顶点变换修复不能恢复这些语义结构；当前生产 wheel manifest 注册 MX5、GT3RS、LP700，AMG 仍是候选，不能称六车轮组全部修复。

本次做了二进制结构检查、旧/新加载路径数值对照及已有结构/轮组测试，未重新完成六车浏览器动态视觉验收。未找到可据以完整复现的原优化命令，不能臆测具体压缩 CLI 参数。

## 原始大模型以后如何保留

M5 原 GLB 约 36.27 MiB、AMG 约 31.48 MiB，确实超过 Pages 的单文件限制。可以选择：

- 原文件放 R2，Pages 游戏加载资源域名：可逐字节保留模型，需实际修改资源 URL 逻辑并配置自定义域名及 CORS。当前加载器拼接 `/cars/`，只填入完整 URL 不会自动正确接入。`r2.dev` 有限流，不作为正式资源方案。[R2 公开访问](https://developers.cloudflare.com/r2/buckets/public-buckets/)、[CORS](https://developers.cloudflare.com/r2/buckets/cors/)。
- 无损拆成 glTF、外部图片和多个小于 25 MiB 的 buffer，保留节点、材质、几何数据后仍放 Pages。检查显示两份原模型存在按完整 bufferView 拆包的条件；M5 只抽出图片仍不足以满足限制，必须拆 buffer。这尚未转换和验证，拆包也不减少总下载量或渲染开销。[glTF 规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)。

换回原始模型还需要核对轮组、旋转轴和卡钳归属，不能只换文件就宣称完成。当前先保留现有模型；将来若网站慢，应分别测下载耗时与游戏帧率，再决定资源加载或渲染优化。
