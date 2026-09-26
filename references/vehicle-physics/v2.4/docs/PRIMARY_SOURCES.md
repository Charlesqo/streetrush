# Primary-source index

本索引只列本次收尾实际用于核对系统边界的官方文档、官方源码和原始论文。它们支持接口与物理/数值语义，不替代本包自己的测试，也不证明本包已经接入相应引擎。

## Contact、normal solve 与 world ownership

| 来源 | 本包采用的事实 | 使用边界 |
|---|---|---|
| [NVIDIA PhysX Vehicle2](https://nvidia-omniverse.github.io/PhysX/physx/5.6.1/docs/Vehicles.html) | suspension load、Tire force、low-speed sticky constraint、drivetrain/brake 是分开的更新组件 | 不复制 PhysX 私有 solver |
| [Jolt VehicleConstraint source](https://github.com/jrouwe/JoltPhysics/blob/master/Jolt/Physics/Vehicle/VehicleConstraint.cpp) | 接触点 Jacobian/effective mass、无接触时关闭 ground constraints、suspension direction 与 contact normal 分离 | 不把其阶段顺序当作唯一算法 |
| [Jolt Wheel API](https://jrouwe.github.io/JoltPhysics/class_wheel.html) | contact position、point velocity、normal、slip、suspension length 与 lambda 是不同字段 | 轴与符号仍由本包声明 |
| [Chrono vehicle white paper](https://www.projectchrono.org/assets/white_papers/chronoVehicle_IJVP.pdf) | contact-driven rigid tire 与 force-element tire 是不同 normal ownership；Synchronize/Advance 分开交换与推进 | 不推导本包事务 API |
| [Rapier forces and impulses](https://rapier.rs/docs/user_guides/rust/rigid_body_forces_and_impulses/) | world rigid body 最终接收 force/impulse；force 与 impulse 的时间语义不同 | 本包尚未接入 Rapier owner |
| [Stewart–Trinkle implicit contact paper](https://www.cse.lehigh.edu/~trink/Papers/STAicra01.pdf) | 单边接触、Coulomb friction 与 implicit time stepping 需要显式可行性条件 | 不声称使用论文的完整求解器 |
| [An implicit time-stepping scheme for rigid body dynamics](https://iro.uiowa.edu/esploro/outputs/journalArticle/AN-IMPLICIT-TIME-STEPPING-SCHEME-FOR-RIGID/9984240862302771) | 无穿透与接触状态需要随离散步共同闭合 | 原始论文边界 |

## Tire、K&C 与 spatial load path

| 来源 | 本包采用的事实 | 使用边界 |
|---|---|---|
| [PhysX tire-speed state](https://nvidia-omniverse.github.io/PhysX/physx/5.3.0/_api_build/struct_px_vehicle_tire_speed_state.html) | Tire 速度来自最终 contact point rigid-body velocity 在 Tire 轴上的投影 | 不采用其内部 Tire 曲线 |
| [Chrono force-element tire](https://api.chrono.projectchrono.org/classchrono_1_1vehicle_1_1_ch_force_element_tire.html) | normal stiffness/damping 可独立于纵横向 Tire law | 本包只实现已冻结的 vertical interface |
| [MathWorks Independent Suspension K&C](https://www.mathworks.com/help/vdynblks/ref/independentsuspensionkandc.html) | mapped K&C 将 bounce/roll/steer 与 wheel pose/compliance 分开；mapped geometry 不等于显式 unsprung inertia | 不采用目标车辆参数 |
| [Modern Robotics: Jacobian statics](https://modernrobotics.northwestern.edu/nu-gm-book-resource/5-2-statics-of-open-chains/) | virtual work 给出 `tau = J^T F`；速度与 wrench 必须在一致 frame/point 表达 | 本包扩展为完整 spatial wrench |
| [SO(3) Jacobian paper](https://arxiv.org/abs/1812.01537) | rotation-vector rate 需经 SO(3) Jacobian 转为空间角速度 | 只采用几何恒等式 |

## Steering、brakes 与 drivetrain

| 来源 | 本包采用的事实 | 使用边界 |
|---|---|---|
| [MathWorks Steering System](https://www.mathworks.com/help/vdynblks/ref/steeringsystem.html) | angle-command 与 torque-command 是两种因果；road feedback 可包含轮胎六分量载荷 | 不宣称实现完整 EPS |
| [Chrono rack-pinion](https://api.projectchrono.org/classchrono_1_1vehicle_1_1_ch_rack_pinion.html) | pinion/rack 映射与 steering subsystem 生命周期是独立边界 | 本包使用自己的 map/transaction |
| [Jolt WheeledVehicleController source](https://raw.githubusercontent.com/jrouwe/JoltPhysics/master/Jolt/Physics/Vehicle/WheeledVehicleController.cpp) | brake torque 是 actuator 上限；实际 impulse 还受轮/地面状态限制；handbrake 是独立输入 | 不照搬其分阶段迭代 |
| [Chrono simple brake](https://api.projectchrono.org/10.0.0/classchrono_1_1vehicle_1_1_ch_brake_simple.html) | simple speed-opposing brake 不能表达 sticking；最大 torque 与 modulation 分开 | 本包低速 sticking 交给 world contact |
| [PhysX clutch parameters](https://nvidia-omniverse.github.io/PhysX/physx/5.6.0/_api_build/structPxVehicleClutchParams.html) | clutch authority 有限，取决于 engine 与 wheel-side speed difference | 本包用 lock/slip active set，而非相同公式 |
| [Simscape differential](https://www.mathworks.com/help/sdl/ref/differential.html) | 理想开式差速器允许两 side shafts 不同速并保持功率共轭 | 不包含 LSD/锁止逻辑 |

## Aero、spatial wrench 与 numerical evidence

| 来源 | 本包采用的事实 | 使用边界 |
|---|---|---|
| [MathWorks Aerodynamic Forces and Moments](https://www.mathworks.com/help/aeroblks/aerodynamicforcesandmoments.html) | Aero 输出是指定 reference point/frame 的六分量 wrench | 轴需转换到本包 x-forward/y-left/z-up |
| [Drake spatial vectors](https://drake.mit.edu/doxygen_cxx/group__multibody__spatial__vectors.html) | point shift 同时改变 moment；点速度含 `omega × r` | 不依赖 Drake runtime |
| [SAE nonlinear race-car aerodynamics](https://saemobilus.sae.org/papers/impact-non-linear-aerodynamics-racecar-behaviour-lap-time-simulation-2002-01-3332) | QSS Aero 可随 ride height 非线性变化，超数据域不能被“验证过”的外推替代 | 出版方摘要边界；无目标数据 |
| [SciPy root](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.root.html) 与 [least_squares](https://docs.scipy.org/doc/scipy/reference/generated/scipy.optimize.least_squares.html) | success/status/message、nfev、bounds 与 residual 是不同证据；solver termination 不能替代物理 gate | 本包另做 domain/capacity/mode gate |
| [ISO 22140](https://www.iso.org/standard/71467.html) | 目标车辆验证需要测量数据与明确比较方法 | synthetic suite 不能冒充车型认证 |

## 版本与证据规则

- 链接保留其页面版本；不同版本 API 不合并成同一实现事实。
- SAE、DOI、TNO 等出版页只使用页面或摘要明确支持的事实。
- 当前 package truth 仍由 v2.0 设计基准、v2.4 主动源码、当前回归输出和 manifest 共同构成；旧 README/pass count 不属于当前证据。
