# engine_calibration_reference package

当前验收入口是 `unified_vehicle_fixture.py` 与根目录的 v2.4 文档：

- [`../README.md`](../README.md)
- [`../docs/IMPLEMENTED_SCOPE.md`](../docs/IMPLEMENTED_SCOPE.md)
- [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
- [`../docs/HOST_BOUNDARIES.md`](../docs/HOST_BOUNDARIES.md)
- [`../docs/VALIDATION.md`](../docs/VALIDATION.md)

## 当前主动模块

`unified_vehicle_fixture`、`accepted_tire_adapter`、`tire_host_contract`、Tire v1.7/v1.8、`chassis_suspension_reference`、`aero_reference_v1_9`、Steering V2/transaction、Engine、Powertrain 与 controls。

## Compatibility / historical references

`run_v2_4_validation.py` 的 `CURRENT_IMPORT_MODULES` 还包含当前仍受回归约束的
兼容/校验模块；该 allowlist 不等同于上面的主动整车闭环列表。

以下文件为了旧 baseline 回归和 API compatibility 保留，但不是 v2.4 整车主动 host：

- `integrated_closeout.py`：v2.1 reduced longitudinal reference。
- `whole_vehicle_fixture.py`：v2.0 synthetic longitudinal oracle。
- `final_cross_system_closeout.py`：未被当前入口引用的早期 v2.2 candidate。
- `run_v2_0_reference_audit.py`、`run_v2_1_closeout_audit.py`、`run_v2_2_final_closeout.py`：历史产物生成器，不是 v2.4 validation runner。
- `tire_v2_final/`：vendored historical implementation；当前 Unified 不 import。

旧 `IMPLEMENTATION_CLOSEOUT_V2_1.md`、`IMPLEMENTATION_CLOSEOUT_V2_2.md` 和旧 runner 中的 pass count、缺失 `results/`、`reference_regressions/`、本机 Downloads 路径只属于历史记录，不能用作 v2.4 证据。
