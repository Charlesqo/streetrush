# Tire V2 可执行参考（vendored historical / not active）

> v2.4 说明：当前 Unified 主动路径使用上级目录中的
> `accepted_tire_adapter.py` + `tire_v2_reference_v1_7.py`/
> `tire_v2_reference_v1_8.py`。本目录没有随包携带它原先声明的测试与
> validation output，下面的旧命令/路径仅作来源记录，不能当作当前验收入口。

这不是某条真实轮胎的标定，也不是商用 TMeasy/MF-Tyre 的替代品。它用于验证 `TIRE_V2_SYSTEM_DESIGN_CN_v0.1.md` 中的模型结构、符号、状态所有权、两种 suspension adapter、联合滑移和求解器耦合是否自洽。

## 文件

- `tire_model.py`：载荷敏感的五参数纯滑移曲线、广义联合滑移、独立 camber 瞬态、`Mx/My/Mz`、有效滚动半径、距离域一阶动态、零速接地变形、法向柔性接口与切线。
- `adapters.py`：`MAPPED_KC_MASSLESS` 与 `DYNAMIC_UNSPRUNG` 到同一 Tire 输入的适配；强制 `RIGID_NORMAL` / `COMPLIANT_TIRE_VERTICAL` 互斥。
- `coupled_solver.py`：轮速—轮胎状态的隐式残差，以及用于反证的显式/瞬时稳态版本。
- `test_tire_v2.py`：原历史源包中的 20 项测试；当前目录未随附。
- `validate.py`：原历史源包中的扫描/数值实验入口；当前目录未随附。
- `validation_output/*`：原历史源包的结果目录；当前目录未随附。

## 运行

原历史源包曾以 `tire_v2_reference.test_tire_v2` 和
`tire_v2_reference.validate` 为入口；这些模块不在当前交付中，不能在本包
运行。当前 accepted Tire 路径及其验证入口以根目录 `README.md` 为准。

## 当前验证结论

- 4 kN → 8 kN 时，纵向峰值摩擦系数从 `1.10` 降到 `1.00`，不是按载荷机械翻倍。
- `sx=sy=0.12` 时同时得到 `Fx=3035.5 N`、`Fy=3035.5 N`，横向力保留纯横滑的 `72.88%`；容量由一条方向相关联合曲线产生，不是末端投影。
- 硬摩擦椭圆启用边界的数值导数跳变约为本模型同位置局部导数变化的 `1063x`。该倍数取决于样例参数和差分间隔，只作为负面对照。
- 经过一个 relaxation length，10/30/50 m/s 的归一化响应均为 `0.632120559`，跨速度差为零。
- camber 不再硬塞进侧偏的 `Ly`：合成样例中 `Lγ=0.04 m`、`Ly=0.46 m`，经过 `0.10 m` 后两者分别建立 `91.79%` 与 `19.54%`；各自在自己的一个 relaxation length 后仍严格得到 `0.632120559`。这两个长度只用于验证状态分离，必须由目标胎数据替换。
- 瞬时稳态轮胎与轮惯量显式耦合时，60 Hz / 120 Hz 后半段力峰峰值为 `7039 N / 1507 N`；240 Hz 才稳定。隐式残差在三档都收敛到 `2453.988 N`。
- 接近静止时，状态从相对位移建立 4.13 kN 接地力，之后相对速度为零保持 0.5 s，漂移为 `0 N`；全过程无速度除零。
- 前进/倒车相同横向状态下 `Mz` 严格反号；稳态滑移网格不产能。transient 卸载允许瞬时返回弹性储能，但闭合 state 循环的净 contact work 必须非正。
- 样例 build–hold–reverse 循环净功为负，并不构成全局被动性证明：加权交叉偏导负面对照明确显示经验型各向异性 force field 没有自动满足标量储能的可积条件。生产版必须选能量一致的 potential/brush transient，或设置声明有效域内的周期搜索、运行时能量监视和失败门，不能把 `grossContactLossProxy` 当证明。
- 两套 suspension backend 生成相同最终接触样本时，Tire 输入和输出逐字段相同。

这些数值只证明实现结构和数值命题，不证明样例参数代表任何量产胎。真实交付仍需 Flat-Trac/道路数据、参数有效域和整车相关性验证。
