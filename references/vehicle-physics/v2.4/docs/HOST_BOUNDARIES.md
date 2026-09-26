# Host boundaries

下面这些能力需要真实游戏/世界 host；本 standalone 包会显式拒绝或降格声明，不伪造输入。

## 必须由 world 提供

- scene query、contact point、contact normal、separation、surface/material identity。
- 低速 `FRICTION_CONTACT` 所需的 free contact velocity 与 Delassus/effective-mass response。
- moving/rotating ground point velocity，以及 world wind 到 body/reference-point frame 的变换。
- 可用于 Aero 的 track ground plane、footprint validity/quality 与 kerb/单轮台阶处理。
- 最终将净 chassis/world impulse 交给 Rapier 或其他 rigid-body world solver 的 adapter。
- Rapier-owned chassis 6-DOF pose/linear-angular velocity、完整 mass/inertia，以及 physics substep 调度。

## Standalone 中的显式 reduced 假设

- handling reference 要求 forward relative flow；reverse Aero 需要另一个 fallback backend。
- contact normal 是 body 表达的 flat-road `[0,0,1]`；`road_heights_m` 是每角 reduced height signal，不等于完整 scene geometry。
- Aero ground clearance 是 chassis datum + heave/pitch proxy，结果标记为 `REDUCED_FLAT_ROAD_CHASSIS_DATUM_PROXY`。
- fixture 的 platform closure 是 reduced quasi-static evidence host，不是 chassis heave/roll/pitch inertia owner。若一个大步不存在可接受的单边接触静态闭合，而 120/240 Hz 子步可闭合，fixture 抛出 `RigidBodyDynamicsHostRequired`；不会制造隐藏 pitch inertia 或接受 contact mode cycle。
- synthetic K&C、Tire、Aero、Engine 和 actuator 参数只验证结构，不代表目标车。
- 低速停车/原地 hold 若进入 accepted `FRICTION_CONTACT`，抛出 `FrictionContactHostRequired`，而不是用 epsilon slip 或大制动力伪造静摩擦。

## 集成时必须保持

- world 与 vehicle solver 不得在 nonlinear residual 中交替写 canonical rigid-body state。
- normal authority 必须在 rigid contact reaction 与 compliant TireVerticalLaw 中二选一。
- handling Tire wrench 与 low-speed contact reaction 必须互斥。
- road wrench、Aero wrench、brake internal reaction 各写一次；axle/CoP 等等效分解只能做诊断，不能再次施力。
- ABS/TCS/ESC 只改 actuator authority；Driver FSM 只输出 command。
