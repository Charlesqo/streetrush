# 从 NFS Heat 看 Street Rush 的整体风格

2026-09-22 · 只读研究。没有安装或执行外部 skill，没有修改游戏，没有制作新的游戏方案。

## 本轮结论

按用户补充，以 NFS21《Need for Speed Heat／热度》为主要研究对象。前面展示的项目旧 AI 方案已排除，不再作为候选；“先换成暖白、石墨和朱红”也不作为决定。

Heat 值得研究的是整套表现如何成立：车辆构图、场景光线、字体、颜色含义、界面形状和状态变化互相配合。Street Rush 目前缺少这些关系，继续拼不同游戏的局部控件会加重问题。

这是审美与适配判断，不是已经验证的改版效果。当前尚未选定最终色值、字体或视觉稿。

## 资料的身份

| 资料 | 身份与使用范围 |
|---|---|
| [Marc Sodermanns / Creative Pixels：Heat 项目案例](https://creative-pixels.de/project/need-for-speed-heat) | 参与项目的 UX 设计师公开的制作过程。包含原型、色彩、字体与 HUD 区域图；规范图不能误称为最终游戏截图。 |
| [Sailesh Vaghela：Heat](https://saileshvaghela.com/nfsheat) | 参与 HUD 和活动反馈的 UI 美术公开的游戏录像及说明。已观察中央提示片段；其他片段不能据此声称完整逐帧分析。 |
| [Kemal Akay：Heat](https://kemalakay.com/?portfolio=nfs-heat) | UI 技术美术公开的项目截图与工作范围。已查看角色/车辆、白天 HUD、夜晚 HUD 三个样本。 |
| [Interface In Game：Heat](https://interfaceingame.com/games/need-for-speed-heat/) | 游戏界面采集站，非 EA 官方站。用于核对成品画面，包括车库、发车倒计时、暂停和回库结算。 |
| [Tim Colin：暂停菜单灯光](https://timothycolin.artstation.com/projects/yb5KoQ) | 灯光作者说明自己负责暂停菜单照明与场景设置，注明原始 mockup 作者。用于核对菜单确实涉及 3D 灯光工作；本次未把其所有展示图当成已视觉验收。 |
| [iamgraphicartist：Heat](https://www.iamgraphicartist.com/portfolio/work/nfsheat) | 过场与宣传片设计、动效创意团队的作品。属于同一游戏的表现设计背景，不能据此把宣传片所有效果当作实际 HUD。 |

排除了搜索结果中的 fan art、网站重设计、早期概念稿和模组；没有把它们当作发售版本证据。

## 原项目明确写出的规则

Creative Pixels 的公开规范将电蓝关联到正向反馈与氮气、黄色关联到奖励/新内容、玫红关联到危险/热度。字体图列出 DIN Pro Condensed 的不同字重及斜体，以及 Eurostile 数字。它还展示了 HUD 区域规划，并描述了菜单构图与车辆镜头共同设计的过程。[项目原文](https://creative-pixels.de/project/need-for-speed-heat)

Sailesh 将 Heat 的视觉主题概括为夜间与霓虹，解释了自己参与的中央消息、逃脱反馈和活动 HUD。[作者说明](https://saileshvaghela.com/nfsheat)

这两条一起说明：色彩既参与品牌气质，也对应玩家的具体状态。不能只抽出紫色、粉色和发光效果。

## 从实际画面观察到的关系

下列是本次观察与判断，不是把原作者的话重新包装成通用规则。

### 1. 车库：3D 场景本身承担了大量风格

![Heat 车库成品截图](https://interfaceingame.com/wp-content/uploads/need-for-speed-heat/need-for-speed-heat-garage.jpg)

[截图出处：Interface In Game](https://interfaceingame.com/screenshots/need-for-speed-heat-garage/)

车、人物、车间灯具、地面光带、墙面图案和 UI 都在同一个画面里。车的轮廓和姿态是主体，导航与参数围绕它安排。UI 普通状态主要使用黑白，场景提供了许多有色的光线。

它也有大卡片和侧栏，不能把“卡片多”本身当成错误。更值得看的是：这些组件的字形、图标尺度、对齐和选中状态一致。该截图也相当密集，不能把所有条目照搬到仅有六辆车的 Street Rush。

对当前游戏的启发：选车界面的镜头位置、车辆占比、车身背景是否干净，应该和文字布局一起定。不要依赖一张偶然的驾驶视角截图，再用全屏蒙层把它压暗。

### 2. 白天和夜晚：核心仪表保持同一身份

![Heat 白天 HUD，作者公开截图](https://kemalakay.com/wp-content/uploads/2019/12/nfsheat05-e1575282493907.png)

![Heat 夜间 HUD，作者公开截图](https://kemalakay.com/wp-content/uploads/2019/12/nfsheat02-e1575282558825.png)

[截图出处：Kemal Akay](https://kemalakay.com/?portfolio=nfs-heat)

不同环境下仍可识别相同的速度表、导航位置、数字气质与反馈颜色。常态信息大多是独立文字、弧线和局部读数，没有把每个数据都包成一个完整面板。

对 Street Rush 的启发：先定稳定的读数形态和位置，再测试亮天空、阴影和路面背景。当前的“灰字＋透明底＋很多细线”既不形成鲜明风格，也不保证可读性。

这不是建议复制导航和氮气表。Street Rush 当前玩法需要圈数、计时、速度和挡位，应围绕自己的玩法建立同样一致的仪表语言。

### 3. 发车：空心字和强光并非禁用元素

![Heat 发车倒计时成品截图](https://interfaceingame.com/wp-content/uploads/need-for-speed-heat/need-for-speed-heat-race-intro.jpg)

[截图出处：Interface In Game](https://interfaceingame.com/screenshots/need-for-speed-heat-race-intro/)

倒计时使用巨大的空心数字和明亮图形，场景里的赛事屏幕、路边标志也有相近的色彩和图形。这种夸张有具体时机：发车。

因此，我前面“去掉空心字、去掉发光”的概括过于粗糙。Street Rush 的问题在于把装饰强度长期放在问候标题、普通状态和每个检查点上。应该为强表现安排时机，并让整个游戏的相关图形互相呼应。

### 4. 暂停和结算：镜头也是界面的一部分

已观察 [暂停菜单录屏](https://interfaceingame.com/screenshots/need-for-speed-heat-pause-menu/) 的不同画面：车辆、背景图形与镜头共同构成菜单空间。

已观察 [夜间回库结算录屏](https://interfaceingame.com/screenshots/need-for-speed-heat-end-gameplay-sequence/) 中的 REP 收益及热度倍率阶段：同一辆车处在专门的灯光环境中，结果数字拥有明显的展示时刻。这是回库结算样本，不应误称为普通比赛完赛页，也没有测量其完整动画时间轴。

对 Street Rush 的启发：结算可以有情绪和力度，但主角应该是结果、车辆和纪录。换成一个巨大的“漂亮收车”标题，再把成绩缩小，并不能产生同样的表现力。

## 怎样避免“缝合”

这里提出的是后续设计约束，尚未实施。

1. **确定一个主参考。** 本轮以 Heat 为主线。GT7、DiRT、Forza 的资料用于检查判断，不把它们各取一个控件放进同一稿。
2. **从游戏气质定义整套规则。** 当前是日间封闭赛道的三圈挑战。可以研究 Heat 白天赛事的活力与车迷文化，但不因此新增夜间城市、警方、声望或氮气玩法。
3. **字体先成体系。** 中文标题、英文车名和计时数字需要专门配对；在选车、HUD、结算中验证同一套字族与字重关系。不能让拉丁字体回退后的中文偶然承担整张画面的风格。
4. **颜色说明状态。** 为默认、选中、成绩改善、无效、警告指定稳定角色；装饰色的使用不能覆盖这些角色。暂不直接复制 Heat 色值。
5. **图形只采用一套构成规则。** 选中条、按钮、分隔线、事件标题应共享可解释的角度、粗细与间距。圆形仪表和矩形导航可以共存，但应有清晰用途，不能仅因为每个单独看着酷。
6. **控制表现强度。** 选车允许展示车；驾驶优先看路；发车、完圈、纪录和结算可以短时增强视觉。这三种状态要看得出是同一个游戏。
7. **同时看 3D 背景。** 菜单相机和灯光会直接影响最终风格。若此轮只允许 UI 工作，预览就必须诚实使用当前游戏画面，不借用商业游戏的高质量车辆渲染来制造提升错觉。

## Street Rush 当前最需要检查的视觉问题

| 当前表现 | 下一次视觉稿要解决的问题 |
|---|---|
| 巨大的空心中文问候＋小号窄体车名 | 建立中文、英文、数字之间的尺度和字重关系，让车名与任务占主位。 |
| 荧光黄同时用于按钮、计时目标、状态和装饰 | 为亮色限定清楚角色，避免所有区域同时吸引注意。 |
| 左侧大面积灰蓝蒙层 | 用合理镜头和局部文字底色保证可读性，减少对整个场景的染色。 |
| 细线、胶囊、圆形工具、切角按钮混用 | 制定形状与线条规则；不是一律删成方框，也不是每块都加特色。 |
| 车辆在菜单里相对小，背景设施较抢眼 | 为菜单单独选择构图，让实际车辆资产承担视觉主体。 |
| 8–10px 状态小字很多 | 必要信息获得足够面积；其余按状态收起。风格不能依赖难读的小字密度。 |

证据对应上一轮实际游戏审查，以及 [当前样式](E:/Projects/streetrush/streetrush/src/style.css)、[菜单内容](E:/Projects/streetrush/streetrush/index.html)。这轮没有重新运行游戏，避免把旧 AI 预览当成当前生产界面。

## 其余参考与 skills 的位置

- 已视觉查看 [Hesham Hasan 的 DiRT Rally 2.0 项目](https://www.heshamhasan.com/dirt-rally-2) 中主菜单、设置、车辆条目、维修区及人物页。窄体字、细线与少量洋红能形成一致性；背景模糊和磁贴布局不能自动视为适合本项目。
- 前一轮查看了 [GT7 官方页面](https://www.gran-turismo.com/us/products/gt7/) 的品牌中心和车辆维护截图。它支持“颜色有角色、场景与界面共同构图”的观察，并不证明 Street Rush 应改成 GT7 风格。
- 阅读 [Territory Studio 的 Forza Motorsport 6 案例](https://territorystudio.com/project/forza/) 作为原团队制作方法资料；该页面含设计发展过程，未把全部内容认证为发售版实机。
- 阅读 [NFS Unbound HUD 作者说明](https://saileshvaghela.com/nfsunbound) 作为系列内部对照；Heat 与 Unbound 的图形语言不能混为一套。
- 上一轮找到的 game-ui-frontend、Impeccable 等 skill 仍可用作审查材料。本轮更清楚地看到：它们不能直接代替艺术方向，“禁止大字／禁止发光／越少越高级”也不能变成机械规则。没有执行这些 skill。

## 下一轮应交付什么

先给一套连续的选车、HUD、结算视觉样张，使用相同的车辆、当前游戏背景和一致的字体/图形规则，再讨论颜色微调。该套样张必须能回答“为什么这三页属于同一个游戏”。

本轮只完成研究与取舍记录，不宣布风格定稿，不接入游戏。
