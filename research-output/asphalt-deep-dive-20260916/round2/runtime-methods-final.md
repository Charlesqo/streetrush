# 第二轮运行时诊断方法复审

2026-09-16。仅只读审查 `round2/runtime/scene-lab.js`，未控制浏览器、执行附件原型或修改实验代码 / src。

审查版本 SHA-256：`3d731b15a82fd522db34045846cd01082119af4161851c0dfcb3b6f4fe2ba52b`。

**代码层面的判断：可以开始受控GPU诊断。** 未发现新的必然使DFG配对或固定ROI探针历史失效的实现缺陷。下列结论针对方法，不是GPU结果通过的声明。

## 1. 有限域DFG配对接线正确

- 使用真实主路geometry/material组、真实normal/roughness贴图；候选克隆保留原材质属性、贴图引用与UV变换。
- 候选显式调用原onBeforeCompile，保留原随机采样、neutral/gain与AOV挂钩；仅替换lights physical chunk中的DFG函数。缓存key与legacy区分。
- 原DFG改名DFGLegacy，域外调用原函数；域内按NdotV和**最终effective roughness**查表，未把纹理参数均值当逐像素roughness。
- LUT以little-endian float32解码成RG Float DataTexture，Nearest采样并手动四点双线性插值；DataTexture默认不翻Y、不生成mipmap、无颜色空间转换，符合该表布局。
- 范围判断为NdotV `[.025,1]`、roughness `[.6,1]`，与表相同。读回normal与roughness产生的域覆盖率使用相同条件；两种DFG不会修改这些输入，因此legacy测得的覆盖率可以用于候选。
- 每个legacy/候选配对使用同一环境texture，没有在切材质时capture；记录captureCount与环境UUID。
- 直接光两项继续按原BRDF计算；候选改变环境single / multiple scattering以及间接漫反射的能量分配。这些均属于替换DFG函数的实际后果，不能只称“提高环境高光”。
- finally先display恢复原选中材质，再dispose候选及LUT；没有发现正常完成路径把已dispose候选留在road上的问题。

需要保持的归因边界：

1. 这是“**有限域替换＋域外旧公式**”这一候选的测量，不是全参数域DFG替换效果。
2. `referenceDomainFraction`是像素覆盖率，不是受影响镜面能量比例。不能用它对整bin结果做简单除法外推。
3. Nv=.025、roughness=.6边界可能制造新的空间亮度分界。全bin高通RMS增长可能包含这些边界，不能直接解释为颗粒反光恢复。若要评价细节，追加域内留边距的共同ROI，例如Nv>.035且roughness>.62，并确保中心和邻点都处于有效域；或至少把边界覆盖区单独标明。
4. 平均亮度 / 分项变化可用于定位责任；本候选还不具备生产材质的完整域、连续边界和运动稳定性验收。

## 2. 探针控制已覆盖主要污染来源

### 生产行为历史

- 所有捕获前恢复mode=0、measure=false及正常显示状态，避免把诊断AOV烘成环境。
- startingCaptureCount与每轮captureCount记录修正了“第0轮永远是boot”的错误语义。
- 每轮记录capture前后的LOD级别；捕获后重算主相机road mask并比对哈希，若ROI变化则停止比较。
- AOV读回不重新capture，因此各分项不会改变环境输入。
- 该阶段记录的是原场景环境历史与原LOD行为的合成结果；记录LOD不等于已经量化其独立贡献。

### 冻结LOD历史

- 前一阶段最后的主相机AOV已将LOD状态置于middle机位；设置autoUpdate=false后，捕获期间与主相机测量期间的可见级别保持一致。
- 四轮均实际capture，比较0→3可以检查固定几何下继续迭代环境是否仍变化。
- **这两段不是相同初始环境的严格双臂实验。** 冻结LOD段继承已迭代过的生产历史环境，且冻结的是middle相机可见级别，而不是每个probe相机自动选级。故不能直接相减两段漂移百分比，再宣布其差值全部来自LOD。
- 若冻结段仍发生变化，可以支持“固定几何时环境历史仍起作用”；若冻结段变化很小，不能反推生产段漂移全由LOD造成，因为它可能已经收敛。
- 更严格量化LOD贡献需两次从同一独立初始环境重建：一段保持自动LOD，一段固定同一组visibility。当前方法适合先检验是否存在残余历史问题。

正常源码中这些LOD均默认autoUpdate=true，finally统一恢复true适用于本fixture；若以后加入原本手动更新的LOD，需要逐对象保存并恢复原值。

## 3. 之前的问题已修复或已正确标注

- 场景材质图像检查移到首次capture前；对未完成图像等待load，捕获失败图像及缺失image；HDR本身由setSkyRotation内loadAsync等待。
- mask PNG、数量与哈希进入结果，并明确称为保守mask：整块排除透明卡片与叠层，而不是模拟透明孔洞。
- matrix和DFG记录实际使用环境状态，支持区分boot基线与后续历史。
- 法线输出已命名viewNormalEncoded；新增NdotV避免把view-space RGB直接解释成世界方向。
- road数据AOV跳过雾，Float读回使用NoToneMapping；最终观感仍使用原管线。
- 闭合检查是逐距离bin的均值闭合，语义正确；不能升级称为逐像素闭合。
- 真实赛道UV已替代上一轮镜像横向UV的独立平面，避免直接转用平面数值。

## 4. GPU运行后最少核验项

这些是结果有效性检查，不要求新增大规模测试矩阵：

1. 浏览器shader/GL日志没有编译错误、缺图或纹理格式错误；检查实际太阳position-target方向。
2. 每个bin的四项和接近total；记录最大相对闭合误差。
3. DFG配对的directDiffuse、directSpecular应基本不变；若明显变化，先查场景/LOD/阴影/采样状态，而非归因DFG。
4. 分别报告环境镜面变化、间接漫反射变化、总光照变化和域覆盖率；不要把环境分项增长等同于全画面提升。
5. 查看保守mask，确认没有大量排除意外卡片、天空、墙面，且各轮ROI哈希一致。
6. 检查probeFrozenLOD四轮level数组完全一致；否则“固定几何”条件未成立。
7. probe历史后再跑matrix/DFG时，以captureCount/UUID标明源状态；若需要与原boot结果对齐，应重新加载而不是复用已改变环境。

剩余限制：无车辆/物理、单帧静态测试、保守裸路ROI、单环境位置。后处理比较是整条默认画布与HDR/MSAA/GTAO/OutputPass的差异，仍不能单独归因GTAO。高通指标不能替代运动稳定性和视觉质量判断。

## 状态

- PASS_CODE_REVIEW：当前DFG配对与probe控制可用于上述限定条件的诊断。
- GPU_RESULT_PENDING：本次复审没有亲自运行或读取这一版本的GPU结果。
- NOT_PRODUCTION_ACCEPTANCE：没有确认生产部署、运动画质、物理等价或设备性能。
