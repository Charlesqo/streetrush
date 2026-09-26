**StreetRush 驾驶机制与手感研究**

研究日期：2026-09-09。对象是当前工作树的生产 `v24-active` 路径。用户要求先广泛研究赛车游戏应该有的机制，再对发现的问题查公开方案。本轮没有修改游戏源码、车辆配置、参考模型或验收基线；新增的只有研究说明、探针和结果。

结论：当前系统已经有车轮、发动机、刹车、转向和轮胎受力的结构，但不少机制仍使用共用示例参数，有些配置没有进入生产计算，有些子系统在同一步结束时并不相互一致。不能凭模块名称认定已经具备相应驾驶体验，也不能把玩家的失控反馈归为操作问题。此次发现涉及整套驾驶机制，不止刹车。

**一 从玩家驾驶体验看 应该具备什么**

下表是对这个项目的基础驾驶要求与源码现状的比较。它不是要求游戏实现所有实车细节，更不要求每个游戏使用同一物理算法。有关车轮受力、质量属性和转向的常见工程结构，可对照 [PhysX Vehicles](https://nvidia-omniverse.github.io/PhysX/physx/5.4.2/docs/Vehicles.html)。

| 机制 | 玩家应该能感受到什么 | 当前实际实现与缺口 |
|---|---|---|
| 油门和刹车输入 | 能逐渐加力、减力；紧急切换有可预期响应；两踏板是否可同时操作应有明确规则 | 键盘、触摸、手柄有滤波。所有设备共用 W/S 式方向语义，两踏板同时非零被当作冲突，驱动油门归零 |
| 发动机与油门 | 转速、挡位、负载影响动力；收油有发动机制动；踩油门不一定等于轮上得到相同动力 | 有独立发动机角速度、通用扭矩曲线、油门执行器、怠速、限转和收油负扭矩；没有逐车型完整发动机映射，发动机惯量统一 |
| 离合器与变速箱 | 起步、升降挡、重新给油应有连续且合理的扭矩变化 | 有自动离合、AT/MT、齿比、换挡阶段和倒挡；离合计算之后轮速又被轮胎和制动改变，没有整步重新闭合 |
| 驱动轮 | 后驱的后轴、前驱的前轴、四驱的前后轴应有可辨认的动力行为 | 每轮有 driven 标记和独立转速。当前六车是四辆 RWD、两辆 AWD；有 FWD 代码分支但无 FWD 车型 |
| 差速器 | 弯内外轮可以不同转速；单侧失去抓地时动力分配合理；限滑特性影响出弯和漂移 | 有理想开式映射；后驱后轮各一半，四驱四轮各四分之一。无 LSD、前后可调分配或扭矩矢量分配 |
| 脚刹与手刹 | 正常脚刹以可控制的减速为主；手刹有单独的后轴锁止作用 | 独立四轮脚刹容量、后轮手刹、有限制动反力存在。脚刹并不是直接把车身速度调小 |
| 前后制动平衡 | 刹车时考虑前后轮承载能力；后轴不能无缘无故先失去方向稳定性 | 基础前后 62:38，四轮有效接地时随前轴载荷增加，最高 86:14；所有车共享该策略，无逐车基础制动偏置 |
| 转向机构 | 输入先改变车轮方向，再由轮胎力让车转弯；低速灵活，高速细腻；反打来得及且能保持足够角度 | 有 rackQ/rackRate、有限转向速度、速度辅助和左右 Ackermann 转角。属于位置指令模型，不是完整动态方向盘、转向柱与齿条系统 |
| 方向盘与回正 | 键盘松手回中；方向盘硬件应有转角校准与可用反馈；不同设备的因果关系明确 | 有键盘回中和手柄平滑。没有专用方向盘硬件校准、实际 FFB 输出接线；计算出的 handwheelTorque 不驱动 rack 动力学 |
| 轮胎朝向 | 前后轮的转角、前束、外倾和接触路面方向应该一致，并体现在画面上 | 物理中每轮有接触切向、转向与 toe，camber 进入轮胎力；视觉中两前轮都画同一个平均转角，后轮画零转角，不画完整最终物理姿态 |
| 轮胎抓地与失滑 | 前轮先失去侧向抓地表现为推头，后轮先失去表现为甩尾；失滑后仍有摩擦，有可理解的恢复过程 | 有载荷相关峰值、滑动段、纵横向联合滑移、瞬态与低速接触约束。全车共用一套轮胎曲线，车型主要缩放 μ；部分看似可调的刚度实际无效 |
| 纵横向抓地分配 | 加速、制动和转弯共享轮胎能力；越靠近极限越需要渐进收放 | Tire 中有二维联合滑移，但制动改变轮速后不重求该轮胎解，所以整个制动步骤没有保证联合状态一致 |
| 重心与转动惯量 | 前置、中置、后置布局和车重分布影响转向、制动和救车；高低重心影响载荷转移 | 有 Rapier 质量、重心与惯量，但来自均匀碰撞盒；六车前后重心都在轴距中间，静态轴荷近 50:50。缺少车型独立重心/惯量数据 |
| 悬架与载荷转移 | 刹车前轴增载、加速后轴增载、转弯外侧增载；起伏和压路肩的反应连续 | 四角弹簧、压缩/回弹阻尼、防倾杆和简化 K&C 有效。映射中的完整位置、机构和 Jacobian 没有进入完整几何闭合；没有独立非簧载动力学 |
| 路面与轮胎接触 | 沥青、草、砂石、路肩抓地不同；轮子有空间尺寸，跨边缘不会像单点开关 | 每轮射线提供接地点和法线，表面 μ 有区别；没有接触斑或轮胎宽度的几何包络，v24 滚阻未采用配置中的表面 rolling 倍率 |
| ABS/TCS/ESC | ABS 防抱死、TCS 控制驱动打滑、ESC 控制失稳；辅助应帮助保持可控制性 | 三种辅助都存在且自动介入；滑移估计、目标偏航和制动分配有明显简化，没有用户可选强度或独立关闭设置 |
| 空气动力 | 高下压力赛车的高速弯与刹车行为应随速度变化，并有前后气动平衡 | 生产只传 cdA，实际为速度反向阻力。没有向下的赛车下压力、前后气动平衡、离地高度气动映射；六系数接口存在不代表已经接入 |
| 驾驶反馈 | 玩家能看出车头与运动方向的差别，听出负载变化和轮胎接近极限，判断何时松油或反打 | 有随速 FOV、追尾相机平滑、加减速镜头、轮胎声音、烟和胎痕。相机没有显式速度方向/车身侧滑融合；发动机音色负载用踏板值而非实际发动机负载 |
| 时间连续性 | 同样输入在不同渲染帧率下尽量得到相同驾驶反应；极限工况不能靠瞬间重置掩盖 | 120 Hz 固定物理步与插值已存在；整车耦合和时间步收敛未由模块残差证明。生产验证页仍走默认 legacy 路径 |

需要强调两个游戏行为：一是直线制动不应要求车身和四轮先处于数学上完全对称的状态，正常小扰动也应可控制；二是“能踩油门救车”不等于所有甩尾都能全油门救回。少量油门抵消收油减速、改变后轴载荷，和大量油门造成后轮空转，是不同作用。后驱、四驱、差速器及当前失滑程度都应影响结果。这是本项目建议验收的操作因果关系，不是把某款商业游戏当作唯一标准。

更深层的胎温、胎压、磨损、燃油质量变化、刹车热衰退、机械损伤、混动能量、空气动力失速或动态天气，可作为之后的玩法和模拟深度。它们不是当前基础驾驶失控的首要补救。应先使基础操纵稳定、连续、有车型差异。

**二 现有三条操作链具体怎样工作**

油门：设备输入 → 踏板滤波 → 前进/倒车意图 → TCS 对正扭矩限额 → 约 55 ms 发动机负载响应 → 通用扭矩曲线 → 有限离合器 → 齿轮/终传/开式差速映射 → 各轮角速度 → 轮胎力 → Rapier 车身。

刹车：设备输入 → 踏板滤波/方向状态机 → 前后制动容量 → TCS/ESC 请求叠加 → ABS 调制整个脚刹通道 → 加上独立后轮手刹容量 → 有限反力减慢车轮。问题在执行顺序：本步轮胎力在这些制动反力应用之前已经算完。

转向：键盘有限速率或手柄曲线 → 随速衰减 → 二阶 rack 位置响应 → 虚拟转角 → 左右 Ackermann 差异 → 悬架 toe 修正 → 路面接触坐标系 → 轮胎横向力与力矩 → 车身偏航。没有直接由转向输入设置车身朝向，但存在会另外施加车轮制动的 ESC。

代码位置：[输入](E:/Projects/streetrush/streetrush/src/input.js:421)、[动力和制动](E:/Projects/streetrush/streetrush/src/vehicle-v24/powertrain.js:210)、[转向](E:/Projects/streetrush/streetrush/src/vehicle-v24/steering.js:46)、[生产调度](E:/Projects/streetrush/streetrush/src/vehicle-v24/runtime.js:235)。

**三 发现后进一步查证的问题与公开方案**

**1 车辆质量布局没有按车型建立。已由代码和运行采样确认。**

`createBody()` 创建均匀长方体，整体下移 0.09 m，再设置车重。其惯量由碰撞盒宽度、高度、模型 targetLength 决定，没有车型独立的 COM 和惯量张量。车轮前后又对称分布在 ±wheelbase/2，因此静态均为约 50:50。六辆车运行采样的 localCom 均为 `(0, -0.09, 0)`；平地静止四角载荷也相等。重心高度会随模型 groundOffset 与悬架静止姿态变化，不是专门的车辆物理标定。

这并不表示物理没有重心，而是车辆布局特征尚未表达。均匀盒惯量可以作为起始估算，但不应成为所有车型最终质量模型。建议将质量、前后 COM、重心高度、惯量作为独立数据，再用静态轴荷和俯仰/侧倾响应验证。源码：[车身和车轮建立](E:/Projects/streetrush/streetrush/src/vehicle.js:181)。对照：[PhysX 独立刚体质量参数](https://nvidia-omniverse.github.io/PhysX/physx/5.4.2/_api_build/struct_px_vehicle_rigid_body_params.html)。

**2 油门和刹车不支持独立重叠。已由代码和函数探针确认。**

InputController 对所有设备设置 `directionConflict = rawThrottle > 0 && rawBrake > 0`。状态机进入该分支后 driveThrottle 保持零，前进中只输出脚刹。探针给定车速 25 m/s、两踏板均为 1、conflict=true，得到 driveThrottle=0、serviceBrake=1。即使伪造 conflict=false，前进油门分支也输出 driveThrottle=1、serviceBrake=0，仍未建立独立两通道。

这直接排除了同时给油抵消部分减速、左脚刹车等操作，并且轻微踏板残余值也可能触发。它可以是刻意的简化控制规则，但不能同时宣称已经完整保留赛车踏板语义。建议分离方向选择和两个独立踏板通道，让倒挡状态机不承担油门/制动仲裁。源码：[输入冲突](E:/Projects/streetrush/streetrush/src/input.js:469)、[方向状态机](E:/Projects/streetrush/streetrush/src/vehicle-v24/powertrain.js:210)。公开对照中，PhysX 分开定义踏板通用命令和各驱动形式的变速箱命令：[Commands](https://nvidia-omniverse.github.io/PhysX/physx/5.4.2/docs/Vehicles.html#commands)。

**3 有驱动轮，但没有赛车差速器特性。已确认的范围缺失，不是开式差速器本身有错。**

当前开式映射允许左右轮速不同，属于实际动力关系。缺的是 LSD、不同前后驱动比例，以及加速/收油时不同的限滑特性。这些机制会影响弯内轻载轮打滑、弯外轮牵引、动力甩尾和救车。所有四驱都固定 25%×4，无法表达不同四驱系统的行为。

可研究 [Jolt VehicleDifferential.cpp](https://raw.githubusercontent.com/jrouwe/JoltPhysics/master/Jolt/Physics/Vehicle/VehicleDifferential.cpp) 的简化限滑分配；如果沿用项目既定有限容量约束思路，更合适的物理对照是 [Chrono 四驱轴系及差速锁容量](https://api.projectchrono.org/classchrono_1_1vehicle_1_1_ch_shafts_driveline4_w_d.html)。两者复杂度和语义不同，不能直接互换后仍宣称原 reference 等价。源码：[当前差速映射](E:/Projects/streetrush/streetrush/src/vehicle-v24/powertrain.js:463)。

**4 轮胎模型有内容，但车型轮胎配置部分失效。已确认。**

v24 使用 `tire.js` 中固定 LOAD_FIELDS，所有车型共用峰值、滑动段、载荷敏感性和松弛长度，仅由当前载荷、有效半径和 μ 缩放区分。`config.tire.longStiffness`、`lateralStiffness` 和 `rollingResistance` 在 legacy 读取，在 v24 没有读取。v24 滚阻系数固定 0.012，路面 rolling 倍率同样未采用。因此改这些配置可能看到数字变化，却没有改变玩家正在运行的轮胎响应。

此外 LOAD_NODES 只到 8000 N，高于此值直接按 8000 N 查表；高载荷仍影响别处，不代表接地力无限保持合理外推。本轮 LP700 复合制动样本已出现约 8900 N 的单轮载荷，轮胎曲线确实超出该表域。

建议先建立生产真正消费的逐车/逐轴轮胎资产，明确坐标、滑移定义、峰值与滑动域，再检查失滑恢复曲线。不要再把 legacy 刚度当成 v24 有效调节杆。[Chrono Tire models](https://api.chrono.projectchrono.org/wheeled_tire.html) 特别区分模型、参数、接触算法与实测验证，且提示不同模型滑移定义和坐标不能混用。源码：[固定轮胎表](E:/Projects/streetrush/streetrush/src/vehicle-v24/tire.js:22)、[实际传入轮胎的配置](E:/Projects/streetrush/streetrush/src/vehicle-v24/runtime.js:283)。

**5 车速转向辅助和稳定系统未形成一致的极限行为。已确认结构问题，影响程度需按工况分解。**

键盘从零到满输入约需 0.57 秒，从满左到满右约需 0.59 秒，再叠加 rack 动态响应；高速输入幅度又被削减。当前没有把反打救车与普通入弯转向分开处理，也没有利用车身侧滑来决定反打可用范围。这意味着“更灵敏”与“高速不失控”不能只靠改一个转向倍率解决。

ESC 目标为 `speed * curvature`，没有抓地或横向加速度上限，也不使用车身侧滑角。MX-5 在 140 km/h、满输入稳态下虚拟转角约 6.19°，该几何目标对应约 7.37 g 横向加速度。这是控制器所追逐的几何目标，并非车辆实际能够达到的加速度。目标不可达时，正常抓地饱和也可能被当成需要继续纠正的偏航误差。

公开工程对照支持按命令和速度设置转向响应：[PhysX steering response](https://nvidia-omniverse.github.io/PhysX/physx/5.1.1/_build/physx/latest/struct_px_vehicle_steer_command_response_params.html)。实际稳定性控制研究则通常同时考虑偏航和侧滑：[主动转向与独立制动的研究](https://arxiv.org/abs/2210.10225)。建议首先限定可实现目标，区分入弯不足、后轴失稳和驾驶者反打，再决定助力策略；不建议直接给 yaw 写值掩盖轮胎问题。源码：[转向响应](E:/Projects/streetrush/streetrush/src/vehicle-v24/steering.js:20)、[ESC](E:/Projects/streetrush/streetrush/src/vehicle-v24/powertrain.js:400)。

**6 ABS/TCS 使用的滑移观测比轮胎模型粗糙。已确认。**

轮胎计算使用每个接地点相对地面的速度，包含车身角速度和轮胎方向。辅助系统却用所有轮共同的车身纵向速度计算 `(omega*R-bodyLongSpeed)/max(abs(bodyLongSpeed),0.5)`。转弯、侧滑、单轮低载、倒车时，这不等于该轮实际的行进方向滑移。TCS 又取驱动轮最大正滑移，单轮超过 0.52 时正驱动扭矩目标便归零；没有按该轮有效载荷筛选发动机限扭依据。ABS 也没有统一处理正反行进下的制动滑移方向。

因此有“油门命令仍在，动力已被切掉”的机制通路，但本轮没有把用户每一次救车失败都归因于 TCS。建议辅助读取与轮胎共享的每轮运动学观测，明确接地、正反向和低速有效域，并记录每次限扭原因。公开对照：[PhysX TireSpeedState](https://nvidia-omniverse.github.io/PhysX/physx/5.4.2/_api_build/struct_px_vehicle_tire_speed_state.html)。源码：[辅助滑移及 TCS](E:/Projects/streetrush/streetrush/src/vehicle-v24/powertrain.js:370)。

**7 制动分配在失去单轮载荷时会回跳，ESC 又未保证有实际控制余量。已确认路径并在复合制动样本出现。**

动态前后分配要求四轮全部接地。任一轮 normalLoad=0，分配退回 62:38，而失去后轮载荷时尤其不应无条件增加后轴制动要求。LP700 样本中前轴比例在 t=0.10 s 约为 79.8%，t=0.25 s 一后轮载荷归零后退回 62%，后轴名义制动份额由约 20.2% 回到 38%。这不是总制动力提升，而是把固定制动容量重新移回后轴。

ESC 永远只选两个后轮之一，且请求先与驾驶者制动相加，再按 per-wheel serviceLimit 截断。满刹且基准分配已经用尽后轮容量时，ESC 即使报告有制动请求，也可能没有增加任何实际制动能力；轮胎本身饱和时更不能由容量请求推断纠偏力矩。

建议研究连续的制动分配退化策略，区分有效载荷与接触身份，按所需偏航力矩、每轮剩余附着和制动余量分配控制；不能只看 ESC 图标或请求是否非零。Bosch 的公开描述明确以实际运动与目标运动比较，并由减扭及独立轮制动实现纠偏：[ESP 工作原理](https://www.bosch-mobility.com/en/solutions/driving-safety/electronic-stability-program/)。赛车制动偏置本身的稳定性作用也可对照 [iRacing Ferrari 488 GT3 EVO 手册](https://s100.iracing.com/wp-content/uploads/2023/09/Ferrari-488-GT3-EVO-2020-Manual-V2.pdf)。源码：[分配](E:/Projects/streetrush/streetrush/src/vehicle-v24/powertrain.js:305)、[请求及容量截断](E:/Projects/streetrush/streetrush/src/vehicle-v24/powertrain.js:419)。

**8 子系统的局部求解成功不代表制动后的整车状态一致。已确认。**

runtime 先做离合器预测，再逐轮求 Tire，之后再施加 brake active set，最终 wheelOmega 还被限制到 ±420。轮胎解和离合器残差对应的轮速都不是最终制动后的轮速。四轮 Tire 的车身有效质量响应也是各自局部计算，并没有统一处理其共同车身状态的交叉影响。把这些局部残差取最大值不能成为全车方程残差。

本轮某些明显甩尾步骤仍记录约 1e-8 或更小的局部残差，符合“算式求解完成，但未证明整车正确”的区别。此处是违反项目既定耦合合同的结构缺口；尚未通过单变量修复证明它对当前甩尾贡献多少。

应依照项目 active reference，在同一步 candidate 中闭合发动机、离合器、车轮、制动、接触反力与车身响应，并分别检查守恒、容量和时间步收敛。公开 [Jolt WheeledVehicleController.cpp](https://raw.githubusercontent.com/jrouwe/JoltPhysics/master/Jolt/Physics/Vehicle/WheeledVehicleController.cpp) 解释了刚性动力耦合为何采用隐式求解；其纵横向约束阶段还继续处理制动冲量、接触点速度和可用摩擦，值得研究，但不应把 Jolt 等同于项目完整 reference。源码：[Tire 之后才应用刹车](E:/Projects/streetrush/streetrush/src/vehicle-v24/runtime.js:274)。

**9 空气动力和悬架几何的名称超出了当前实际接线。已确认。**

生产 main 没有传 aeroAsset；aero.js 默认只产生反向阻力和零气动力矩，没有赛车下压力。K&C map 返回位置、弹簧长度、阻尼器长度、防倾坐标等量，但运行时主要用其 toe/camber，路面查询仍沿固定 anchor 射线，没有用完整 map 生成最终轮心路径。因此不能把这些模块名称理解为已经有了完整空气动力平台或真实机构悬架。

建议先建立适合每辆车的基础下压力与前后平衡，再按已选择的悬架路线补几何、载荷和止挡行为；详细 aero map、轮跳等可按玩法需要继续扩展。现有权威文档中这些路线还有 UNDECIDED，本轮不替用户改变决定。源码：[生产构造](E:/Projects/streetrush/streetrush/src/main.js:636)、[气动 fallback](E:/Projects/streetrush/streetrush/src/vehicle-v24/aero.js:29)、[K&C 使用](E:/Projects/streetrush/streetrush/src/vehicle-v24/suspension.js:131)。

**10 玩家收到的反馈没有完整对应到实际物理。已确认接线差异，主观影响未做盲测。**

视觉车轮两前轮共享平均转角，不表现实际 Ackermann 和 toe；轮胎物理中的 camber 也没有对应到完整视觉轮姿。发动机声音负载采用 telemetry.throttle，因此 TCS 限扭、离合滑动时仍可能听见较强的“踩油门”音色。镜头只按车头方向追随，未显式呈现车头方向与速度方向的差别；这可能影响玩家识别侧滑的时机，但需要实际画面比较证明程度。

还有一个当前不会直接导致车身甩尾、却会影响未来 FFB 的明确问题：runtime 把 pneumaticTrail 作为 mechanicalTrail 传给转向反馈，而 Tire 的 Mz 已经包含 `-Fy*trail`，反馈再次减去 `trail*Fy`，同一气动拖距被重复计入。此反馈目前只存入过滤值，不反过来控制 rack，所以不能列为本次甩尾根因。

Criterion 的公开 [Vehicle Feel Masterclass](https://www.gdcvault.com/play/1025295/Vehicle-Feel-Masterclass-Balancing-Arcade) 明确把相机与操控辅助作为车辆手感的一部分；公开 [Just Cause 4 车辆物理演讲](https://www.gdcvault.com/play/1026035/Vehicle-Physics-and-Tire-Dynamics) 也讨论适合设计者调校的轮胎及驾驶辅助。它们说明“正确物理”和“可读、可控制的游戏反馈”都需要设计；其街机处理不能自动当作本项目已授权的物理替代。此轮取得演讲摘要及部分幻灯片索引，未完整观看演讲。源码：[车轮视觉](E:/Projects/streetrush/streetrush/src/vehicle.js:921)、[声音负载](E:/Projects/streetrush/streetrush/src/audio.js:404)、[相机](E:/Projects/streetrush/streetrush/src/effects.js:24)、[拖距重复传递](E:/Projects/streetrush/streetrush/src/vehicle-v24/runtime.js:348)。

**11 现有验证还不能回答所有基础驾驶问题。已确认接线和覆盖差异。**

main 显式 v24-active，而 validation.js 创建 VehicleSystem 时不指定模式，仍默认 legacy。部分制动测试同样测试旧路径；不能用旧模型 PASS 支持生产新模型手感。已存在的部件、方向和直线测试可以保留，但应补充微扰稳定性、输入切换、推头/甩尾恢复、左右对照、不同路面，以及跨速度和帧率的实际生产输入测试。

源码：[验证页构造](E:/Projects/streetrush/streetrush/src/validation.js:47)、[默认模式](E:/Projects/streetrush/streetrush/src/vehicle.js:94)。项目已有 [测试与完成标准](E:/Projects/streetrush/streetrush/docs/TESTING_AND_COMPLETION.md)，本次发现与其中“局部 PASS 不代表整车完成”的原则一致。

**四 本轮有限实验的作用与边界**

本次进行了 24 个平地行驶探针：12 个直线/带转向对照，12 个六车直线及微扰对照。使用生产 VehicleSystem + v24-active + Rapier，但地面是研究 FlatTrack，不是用户当时的完整游戏赛道；没有走浏览器硬件输入、镜头或声音。第二组只复用了生产踏板滤波函数与 W/S 意图，仍不是完整 InputController 事件链。

全部从静止给油获得车速，没有直接设置行进速度、轮速或 RPM。每步保留记录；自动 reset 次数为零。没有运行完整 Python reference、全仓验收或用户手感验收，相关结果均为 NOT_RUN；车型真实标定仍为 SKIP_TARGET_DATA。

| 车型 | 理想直线约 180 km/h 制动 最大车头变化 | 140 km/h 极小转向后松回再刹 最大车头变化 | 微扰工况速度大于 20 km/h 时最大侧滑角 |
|---|---:|---:|---:|
| MX-5 | 2.71° | 145.48° | 44.61° |
| M3 E30 | 0.24° | 23.56° | 2.08° |
| GT3 RS | 0.07° | 42.02° | 3.77° |
| LP700 | 0.03° | 5.39° | 0.50° |
| AMG GT3 | 0.08° | 135.93° | 43.38° |
| M5 G90 | 0.01° | 1.19° | 0.16° |

微扰输入为 steer=0.02 保持 0.5 秒，随后刹车阶段输入转向为零。开始刹车时车头只改变约 0.21–0.40°。这组证据表明部分车辆的近直线制动会放大小扰动；不能把所有车都称为已经复现相同故障，也不能因为理想直线结果较好就否定用户“所有车直线一踩刹车就转”的反馈。

车头变化不自动等于侧滑失控，所以表中同时列侧滑角。M5 理想直线探针在 9 秒上限时仍约 6 km/h，不能称为刹停 PASS。另一个较大转向对照中，MX-5/LP700 收回转向后滑行能够恢复，而改为刹车后都出现大侧滑；它是复合工况证据，不替代用户的直线场景。

探针：[第一组](E:/Projects/streetrush/streetrush/scratch/handling-research-20260909/probe.mjs)、[六车直线与微扰](E:/Projects/streetrush/streetrush/scratch/handling-research-20260909/straight-probe.mjs)。结果：[第一组摘要](E:/Projects/streetrush/streetrush/scratch/handling-research-20260909/summary.json)、[六车摘要](E:/Projects/streetrush/streetrush/scratch/handling-research-20260909/straight-summary.json)。同目录保存所有逐步 JSON，以及 [14 个源码文件的 SHA-256](E:/Projects/streetrush/streetrush/scratch/handling-research-20260909/source-manifest.json)。

**五 后续研究和实施的依赖顺序**

优先建立可靠的共同基础：方向与独立踏板语义、车型重心/惯量、每轮接触和滑移观测、制动/轮胎/动力闭合、辅助系统实际控制余量。这里有确定缺口，也最容易同时影响直线、转向和救车。

随后建立可辨认的车型行为：逐车基础制动偏置、逐轴轮胎、前后驱动比例和需要的差速器、悬架前后平衡、下压力。缺少精确实测数据时可以有明确标注的游戏调校，但不能把共用示例参数称为实车验证。

再完善玩家可读的反馈：视觉轮姿与物理一致，声音反映实际发动机负载，镜头帮助识别车头与运动方向，辅助介入可辨认。这些工作服务于判断和操作，不能替代修复物理和控制缺陷。

本轮到研究结论为止，没有实施上述改动，也没有因公开方案存在而更换现有模型或决定尚未选择的 backend。
