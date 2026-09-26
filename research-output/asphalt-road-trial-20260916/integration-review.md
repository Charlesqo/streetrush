# 路面环境响应试验接入：只读审查

2026-09-16。审查当前 `dev-straight-art.js`、`dev-circuit-review.js`、`rendering.js` 和主入口初始化顺序。没有改 src 或操作浏览器。

## 最小接入建议

1. **启动时共享 uniform 必须是原版 0。** 当前主入口先安装 straightArt（1403-1406 行），之后 `setSkyRotation` 内部捕获环境（1411 行），再 warmup，最后安装检查面板（1462-1464 行）。因此在 `installStraightArt` 内创建并挂钩、保持 0；到 `installCircuitReview` 已创建控制器后才设试验版 1，便能保证首次捕获与 fallback 的 clear 捕获使用原版。不要在安装素材时就默认设 1。

2. **三个材质必须共享同一个 `{value: ...}` 对象。** 每个 shader 的 uniform 引用该对象，不能各复制一个值。A/B 只改 value；不重新加载纹理、不置 `needsUpdate`、不重编译、不捕获环境。这样主路、Fresh 替代材质和铺装路肩保持同一模式。完整域 LUT 失败应明确报错／保留原版，不应显示“试验版”却静默回退。

3. **在 scan sampling 安装之后叠加 DFG 挂钩。** 当前三材质先执行 `installScanSurfaceSampling`（149-151 行）；新模块应保存并调用旧 `onBeforeCompile(shader,renderer)`，再替换 physical chunk。同时保存旧 cache key 的值／函数绑定，追加自身版本；避免新的 key 调自己。若后续又调用 `installScanSurfaceSampling`，它会覆盖新挂钩，因此安装顺序必须固定。当前这三个材质安装后没有额外 material.clone 路径，不必为本次扩大重构。

4. **保留原函数作为 uniform 分支，而非另写“近似原版”。** 原模式必须调用原 r180 DFG 函数；试验模式在同样的最终 normal、viewDir、effective roughness 上查完整域 LUT。轴顺序、Float 解码、无颜色转换、无 mip、采样边界／半纹素约定都应与表生成器一致。第一次捕获虽然 uniform=0，整段 shader 仍要能编译，LUT 也应已加载好。确认只替换一次函数，没有重复定义。

## 原场景按钮再次捕获：必须显式保护

当前“原场景 / 新素材”在切换资产后直接调用 `lighting.captureVenue(...)`。建议 controller 暴露一个同步 scope：

```text
saved = responseMode.value
responseMode.value = 0
try: lighting.captureVenue(position, vehicle)
finally: responseMode.value = saved
```

当前 `captureVenue` 是同步函数，`try/finally` 足够覆盖六面捕获及异常恢复。此 scope 不改变用户选择的模式、材质种类或 straightArt enabled 状态。

**只包装 `lighting.captureVenue` 对象属性不能覆盖所有路径。** `setPreset` 在 `rendering.js:124` 调用闭包内的 `captureVenue`，不会经过被替换的对象属性。对于当前检查入口，启动保持 0 + 原场景按钮显式 scope 是最小充分处理；若承诺未来切天空也受保护，应在 `captureVenue` 内部设统一 before/finally hook，而不是只 monkey-patch 返回对象的方法。

“每次使用原版响应捕获”不等于“所有场景切换共享完全相同的环境”。原场景／新素材切换了几何和材质，旧环境历史也仍存在。只需要保证同一场景里的原版／试验配对之间没有 capture；不要把跨场景对照称为单一 DFG 的受控 A/B。可以在诊断 dataset 记录 mode 和 environment UUID，便于检查这一点。

## 模式和按钮语义

- `setEnabled(false)` 只隐藏新资产，不改 response mode；再次开启恢复用户此前选择。
- `toggleAsphalt()` 只切 Fine/Fresh，不改 response mode，也不捕获环境。
- 原场景状态下应显示“原场景，路面试验未应用”，或禁用两个响应按钮；避免按钮显示试验已生效但画面使用原游戏沥青。
- 两个响应按钮建议明确标为“路面原版”“路面试验”。独立状态标签同时显示 Fine/Fresh 与响应模式，不依赖会被其他按钮覆盖的 heading。
- 响应切换可用现有 reset 恢复绘制、清空旧帧统计，但保留当前 view。reset 会停止 tour，适合在同一位置看 A/B；不要切换时跳回直道起点。

## 路面近看：选主路，而非护栏路肩

新增 `view={t:.145,offset:0,height:.28,lookAhead:3,lookOffset:0}` 可直接复用现有机位代码；相机仍是 FOV 58、near 0.1，target 会落在前方参考高度 0.05。主路顶面偏移为 0.015，所以实际离路面约 0.265 米。

这样看的仍是 roadMat／alternateMat；原“护栏根部”是 offset=10.7 的肩部位置，还叠加护栏阴影，不能替代主路颗粒对照。驾驶机位仍用“直道中段”t=.145、height=1.7、lookAhead=24，避免只在贴地角度通过。

## 本次最小验证清单

1. 新加载页面：首次环境捕获 mode=0，进入检查面板 mode=1；三个材质共享 uniform，编译和纹理无报错。
2. 同一近景和驾驶机位执行原版→试验→原版：最后原版与第一次一致，environment UUID／capture count 不变，asset 与 camera 不变。
3. 试验模式切 Fine/Fresh，再关／开新资产：模式保留；recapture 时临时为 0，结束后恢复 1；原场景时不误报生效。
4. 巡看中切响应按钮：停在当前机位可正常比较；切换后没有沿用动态帧率统计冒充材质性能。若要评价运动闪烁，另做同轨迹对照，不能从单帧高通增强或静止 5 FPS 推断通过。

归因边界：DFG 替换还会改变间接多次散射及间接漫反射分配；“试验版环境响应”比“仅增加高光”更准确。当前建议可供实现，尚未审查新模块的实际代码或实测成品。
