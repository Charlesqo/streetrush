# v2.4 validation record

本记录只验收 `v2.4-standalone-closeout`：即真实游戏/物理世界接入以前的独立
闭环。它不把 Rapier 6DOF、scene query、真实低速接触响应或目标车辆标定数据
伪装成已完成，也不引用 v2.0/v2.1/v2.2 的旧 pass count 作为当前证据。

机器可读证据随包位于：

- `engine_calibration_reference/data/maneuver_matrix_v2_4.json`
- `engine_calibration_reference/data/validation_manifest_v2_4.json`
- 人类可读逐工况表：[MANEUVER_MATRIX.md](MANEUVER_MATRIX.md)

## Reproducible commands

在源码包根目录运行：

```bash
python -m engine_calibration_reference.run_v2_4_maneuver_matrix \
  --case-timeout 30 \
  --json-out engine_calibration_reference/data/maneuver_matrix_v2_4.json \
  --markdown-out docs/MANEUVER_MATRIX.md

python -m engine_calibration_reference.run_v2_4_validation \
  --source-upstream \
  --maneuver-json engine_calibration_reference/data/maneuver_matrix_v2_4.json \
  --json-out engine_calibration_reference/data/validation_manifest_v2_4.json
```

安装后的默认入口不依赖源码树的 `tests/upstream_reference`：

```bash
vehicle-physics-v2-4-validate
vehicle-physics-v2-4-maneuvers
```

## Recorded environment and suites

最终源码回归环境为 Python 3.12.13、NumPy 2.3.5、SciPy 1.17.0、pytest
8.4.2。依赖版本不是物理规格；支持范围以 `pyproject.toml` 为准。

| Gate | Recorded result |
|---|---|
| Compile all package Python sources | PASS; 52 files |
| Current/compatible import allowlist | PASS; 24 modules |
| Current top-level public API | 78 symbols; historical v2.1 exports removed |
| Package unittest | PASS; 99 run, 1 skip, 1 expected failure |
| v2.4 standalone assertions within package suite | PASS; 25/25 |
| Source-only upstream pytest | PASS; 109 passed, 2 skipped, 2 xfailed |
| Maneuver matrix | PASS; 33 cases: 31 PASS, 2 EXPECTED_HOST_BOUNDARY, 0 FAIL, 0 TIMEOUT |

矩阵 JSON 的 SHA-256 是
`da141d1efec12f9abd28de081a596db91a875cd8f7a2dc3b393861b7ea2d51b3`。
全部 PASS case 的最大 scaled residual 是 `3.809468256085954e-11`；每个
PASS record 都含 solver method、attempts、nonlinear evaluation count、peak row
和 exactly-once transaction 证据。

## Physics and transaction evidence

- accepted Tire 路径在 final contact frame 中消费 contact-point velocity 和完整
  wrench；同一步 effective radius 在 host/Tire 两侧一致。AIRBORNE 会清 patch，
  且 road wrench 严格为零。
- 映射悬架的单角 AIRBORNE 对照得到 `Fz=[0, 7288.74, 6229.07,
  983.46] N`、离地 gap `0.002058 m`、scaled residual `8.436e-13`；该角
  spring/damper/ARB 内力仍保留，说明“无路面反力”没有错误地删除悬架内部力。
- mapped CONTACT 使用速度级法向 Jacobian 行；gap、法向速度、原始求解 Fz、
  complementarity 与几何质量均进入 telemetry。CONTACT 的米制 gap row 与
  AIRBORNE 的牛顿制 zero-force row 使用不同 residual scale。
- 15 m/s parking-brake 对照使有限离合从 LOCKED 切到 `SLIP_POSITIVE`，离合
  impulse 为 `-3.75 N·s`，等于容量边界，scaled residual `2.21e-14`；parking
  channel 仍独立于 service/ABS channel。
- 两种转向因果、split-μ、理想开式差速器不同侧轮速、两种 suspension backend
  以及 60/120/240 Hz 均进入矩阵。120/240 Hz 的 F→R full-brake driver case
  三步都提交且 direction FSM 同 vehicle transaction 绑定。
- Engine、Gearbox、Steering、四 Tire 与 Mechanical owner 先 preflight，再
  exactly-once commit；任一 owner 的注入式 post-commit fault 都恢复整个五-owner
  group。Engine/Gearbox 两-owner 路径同样验证 rollback。

## Expected host boundaries

矩阵中只有以下两个非 PASS，且二者都是显式
`RigidBodyDynamicsHostRequired`，不是数值失败或 XFAIL：

| scenario | backend | Hz | transaction evidence |
|---|---|---:|---|
| `service_brake_full` | `MAPPED_KC_MASSLESS` | 60 | no commit; all opened owners abort |
| `step_driver_F_to_R_full_brake` | `MAPPED_KC_MASSLESS` | 60 | vehicle and driver intent do not advance |

单个 60 Hz 大步下，该瞬时全制动命令需要真实 chassis heave/pitch/6DOF 惯性宿主；
reduced-planar fixture 不制造一个虚假的 quasi-static unilateral-contact 平衡。
120/240 Hz 对应 case 均 PASS。真实低速 friction contact 则以
`FrictionContactHostRequired` 停在 world-contact host 边界。

## Accounted skip and expected-failure ledger

| Kind | Test | Reason |
|---|---|---|
| package expected failure | `test_engine_behavior_reference_v2_0.TestTrialCommitAndModes.test_naive_post_integration_rpm_clamp_conserves_angular_impulse` | 负面对照：朴素积分后 RPM clamp 不守恒角动量 |
| package skip | `test_engine_behavior_reference_v2_0.TestTrialCommitAndModes.test_target_low_speed_start_stall_fixture` | 未提供目标低速燃烧/起动机/熄火 fixture |
| upstream xfail | `test_chassis_suspension_reference.py::test_matrix_combined_roll_lateral_additive_superposition_is_not_exact` | 加性 K&C 叠加不能表示嵌入的 combined-load cross term |
| upstream xfail | `test_tire_v2_reference_v1_7.py::test_standstill_bore_torque_not_core` | accepted handling Tire 明确不含 standstill turn-slip/bore/parking-torque state |
| upstream skip | `test_chassis_suspension_reference.py::test_matrix_offline_hardpoint_chrono_crosscheck_requires_external_reference_fixture` | 未提供 target hardpoint/Chrono fixture |
| upstream skip | `test_tire_v2_reference_v1_7.py::test_target_tire_measurement_fit` | 未提供 target-tire measured/TIR fixture |

这些 outcome 不授权扩展 LSD/locked differential、Tire thermal/wear、active 或
unsteady Aero。它们与真实 game/world integration、target-car calibration 一样，
继续留在明确边界之外。

## Distribution gate

PASS。使用 Python 3.12.13、pip 26.2.1、setuptools 84.0.0、wheel 0.48.0，
在独立临时源码副本中无联网、无依赖安装地构建 wheel/sdist。结构检查确认：

- wheel 携带 3 个 synthetic/provisional runtime data 文件、矩阵 JSON、最终
  validation manifest、13 个 package test modules 与两个 console-script entry；
- sdist 另带 6 个 docs、4 个 source-only upstream test files、README、
  `REFERENCE_RUNTIME.md`、requirements/pyproject/MANIFEST provenance；
- wheel/sdist/最终 zip 均不含 `__pycache__`、`.pyc`、`.pytest_cache`、build 或
  dist cache；
- wheel `--no-deps` 安装到全新临时 target 后，从源码目录外导入，确认实际
  import 来自 installed target；默认 validation PASS，仍为 99 tests、1 skip、
  1 expected failure，且不依赖 top-level upstream test tree。
