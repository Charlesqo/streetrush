# Vehicle Physics v2.4 standalone closeout

这是按 `vehicle_physics_design_baseline_cn_v2.0` 恢复并收束的独立可执行参考包。它合并了 v2.2 的跨系统骨架与 v2.3 已接受的 Tire/K&C 语义；原始压缩包没有被修改。

本包的目标是闭合“接入真实游戏/物理世界以前”的实现与验证，不声称已经接入 Rapier、真实 scene query、真实路面响应或目标车辆标定数据。

## 当前主动路径

- `engine_calibration_reference/unified_vehicle_fixture.py`：同一步整车耦合、两种悬架后端、两种转向因果、离合/制动/法向接触 active set、Aero、完整事务。
- `engine_calibration_reference/accepted_tire_adapter.py`：已接受 Tire v1.7 steady/Mz + v1.8 transient 策略。
- `engine_calibration_reference/tire_host_contract.py`：Contact/Suspension 到 Tire 的唯一主动 host contract。
- `engine_calibration_reference/chassis_suspension_reference.py`：K&C、SO(3)、JᵀW、spring/damper/ARB/compliance reference。
- `engine_calibration_reference/aero_reference_v1_9.py`：六分量 QSS Aero 与 reference-point shift。
- `engine_calibration_reference/engine_model.py`、`powertrain_controller.py`：Engine、Gearbox、理想无损开式差速器和 owner transaction。
- `engine_calibration_reference/vehicle_controls_reference.py`：Service/Parking Brake、ABS/TCS/ESC authority 与 Driver direction FSM。

`engine_calibration_reference/tire_v2_final/` 是随旧包保留的历史实现，不在 v2.4 主动 import 路径中，不能当作当前 Tire 真相。

## 明确完成范围

- Tire v1.7/v1.8 accepted handling path、AIRBORNE 清 patch、FRICTION/HANDLING 互斥、完整 contact-power ledger。
- final wheel pose → contact point → contact tangent frame → point-relative velocity → Tire wrench 的同一步链。
- mapped K&C massless 与 dynamic unsprung 两个 suspension backend；mapped CONTACT 用速度级 Jacobian 求 `qdot`，AIRBORNE 用 massless BE 且严格 `Fz=0`。
- position-command 与 torque-driven steering；完整 spatial JᵀW road reaction。
- Aero v1.9 六维 wrench、reference-point `ω×r` velocity、CG shift 与反力矩账本。
- Engine/Gearbox/理想 open differential、service/parking brake、ABS/TCS/ESC、direction FSM。
- Engine/Gearbox/Steering/Tire/Mechanical 五 owner 的 preflight、exactly-once commit、abort 和 post-commit group rollback。

详见 [实现范围](docs/IMPLEMENTED_SCOPE.md)、[架构](docs/ARCHITECTURE.md)、[Host 边界](docs/HOST_BOUNDARIES.md)、[Primary sources](docs/PRIMARY_SOURCES.md) 与 [验证记录](docs/VALIDATION.md)。

## 运行

发布分发名是 `engine-calibration-reference`，Python import 包名是
`engine_calibration_reference`；`vehicle-physics-v2-4-*` 仅是两个 console
script 的用户入口名。

包依赖 Python、NumPy 与 SciPy。安装态默认 validation 只运行随 wheel 提供的
package tests，不依赖源码树外部目录：

```bash
python -m engine_calibration_reference.run_v2_4_validation
```

源码 closeout 还可显式运行独立 upstream tests（需 pytest）：

```bash
python -m engine_calibration_reference.run_v2_4_validation --source-upstream
```

33 工况矩阵的独立入口为：

```bash
python -m engine_calibration_reference.run_v2_4_maneuver_matrix
```

两个入口默认都只向 stdout 输出 JSON；只有显式传入 `--json-out PATH`
（matrix 另有 `--markdown-out PATH`）才写结果文件。validation 可用
`--maneuver-json PATH` 校验并附接已生成的矩阵摘要。最终回归命令和逐套结果
统一记录在 `docs/VALIDATION.md`；不要引用旧 README 或旧 manifest 中的 pass
count 作为本包证据。
