# StreetRush Agent Rules

## 物理系统：权威来源与必读顺序

涉及物理系统（包括车辆物理、运行链或完成状态）的任务，必须按以下顺序阅读相关权威来源，并据此裁决：

1. `vehicle_physics_design_baseline_cn_v2.0 (1).docx`：规范性 baseline。
2. `vehicle_physics_v2_4_standalone_closeout` 的 active scope、host boundary 和 executable reference。
3. [docs/VEHICLE_PHYSICS_BASELINE.md](docs/VEHICLE_PHYSICS_BASELINE.md)：项目内规范、审计快照和未决定项。
4. [docs/PROJECT_MAP.md](docs/PROJECT_MAP.md)：生产运行链与 ownership。
5. [docs/TESTING_AND_COMPLETION.md](docs/TESTING_AND_COMPLETION.md)：状态语义、测试门和完成口径。

## 生产运行链

`index.html → src/main.js → input → fixed-step scheduler → VehicleSystem → vehicle-v24 runtime → Rapier → afterPhysics → HUD/audio/camera/race timing`

当前审计快照中，生产 `main.js` 显式请求 `v24-active`。这只证明接线模式，不证明完整 v2.4 等价；完成状态以三份 `docs/` 文档中的规范矩阵和验收门为准。

## 不可违反

- 禁止静默缩减 v2.0 强制 baseline 或 v2.4 accepted semantics。
- 禁止用更简单的数学模型替换 accepted 模型后仍称为 v2.4。
- 禁止把存在、接线、selected golden PASS 或 synthetic fixture 冒充 production/target PASS。
- 缺真实数据时使用 `SKIP_TARGET_DATA`；工具未运行时使用 `NOT_RUN`，不得伪造 PASS。
- 禁止覆盖、回退、移动或整理用户及其他并行任务的改动。
- 所有 backend/模式选择以 baseline 文档中的显式决定为准；`UNDECIDED` 不得被代理静默决定、删除或降级。

## 任务间通信边界

- 允许读取和列出其他任务。
- 主任务严格禁止向其他 Codex 主任务发送消息，也禁止通过发送消息的方式开启新的主任务。
- 子代理禁止通过向主对话发送消息的方式汇报进度或结果，应通过子代理自身的结果返回机制提交结果。

## 子代理配置约定

- 用户提到使用“luna max”子代理时，必须指定模型 `gpt-5.6-luna` 和 `max` 推理强度，调用参数格式为 `{"model":"gpt-5.6-luna","thinking":"max"}`。若子代理工具使用不同字段名，应按其实际参数定义传入相同配置；不得静默替换为其他模型或推理强度。
