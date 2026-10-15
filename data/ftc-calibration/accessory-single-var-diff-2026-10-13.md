# 配件 → 性能：单变量对照（真实蓝图数据，离线可得）

来源：`prun-blueprint-dump.json`（13 份蓝图，2026-10-13 实机导出）。
**方法**：这 13 份蓝图天然构成一组对照 —— 找出「除一个 selection 外完全相同」的蓝图对，
即可**离线**归因该配件对 performance 的影响，**无需再发服务器请求**。
（这补上了原计划里依赖 BTF 扫描的那部分：能离线的先离线做掉。）

## 单变量对照结果

| 蓝图对 | 唯一差异 | performance 变化 |
|---|---|---|
| BP-FRVZ-6104 → 新手船 | `STL_ENGINE`: STL_ENGINE_FUEL_SAVING → STL_ENGINE_STANDARD | mass: 825.8→827.8; acc: 121.09→151; ftl: 0.001094586567409856→0.0010936963431707758 |
| LCB 轻板 → OOG LCB | `GRAVITY_SHIELD`: NONE → GRAVITY_SHIELD_BASIC | mass: 1115.3→1115.4; acc: 89.66→89.65 |
| 新手船STS → 新手船 | `GRAVITY_SHIELD`: GRAVITY_SHIELD_BASIC → (none) | mass: 827.9→827.8; acc: 150.98→151 |
| WCB-STS → WCB | `GRAVITY_SHIELD`: GRAVITY_SHIELD_BASIC → (none) | mass: 1271→1270.9; acc: 98.35→98.36 |

## ⚠️ 关键发现 1：`GRAVITY_SHIELD_BASIC` 只影响质量（+0.1t），且对照方向互相矛盾

`LCB 轻板`(无) vs `OOG LCB`(有) → 质量 1115.3 → 1115.4
`新手船STS`(有) vs `新手船`(无) → 质量 827.9 → 827.8
`WCB-STS`(有) vs `WCB`(无) → 质量 1271.0 → 1270.9

三对都是「有 → 质量略大」，量级 **0.1t**，在浮点/取整噪声边缘。**不要**据此写任何公式 ——
它的唯一可靠结论是：**该配件对飞行性能模型消费的 6 个量（速度/燃料/充能/G/罐）无影响**。
（这也解释了它为何在 `STL_SEGMENT_CURVES` / `ftc-compute` 里都不该出现。）

## ⚠️ 关键发现 2：`STL_ENGINE_FUEL_SAVING ↔ STL_ENGINE_STANDARD` 的影响是**加速度**不是速度

`BP-FRVZ-6104`(FUEL_SAVING) vs `新手船`(STANDARD)：质量 825.8→827.8、加速度 **121.09→151**、ftl 几乎不变。

⇒ 换 STL 引擎会改 `acceleration`（推力/质量比），而**段速度模型并不直接消费 acceleration**
（它消费的是引擎表 `STL_ENGINE_SPEED` 的标定曲线）。这与 fuel-model 的设计一致，
但意味着：**引擎对段速度的影响"藏在"标定表里，而不是从蓝图性能推出来的** ——
所以修正引擎相关常数只能靠 BTF 实测，不能靠读蓝图。

## 关键发现 3：13 份蓝图覆盖的配件档位（用于设计后续 BTF 扫描）

按 selection type 汇总出现过的 option（来自实测，非文档）：

- `CARGO_BAY`: CARGO_BAY_HIGH_LOAD, CARGO_BAY_HUGE, CARGO_BAY_LARGE, CARGO_BAY_MEDIUM, CARGO_BAY_SMALL, CARGO_BAY_TINY
- `COMMAND_BRIDGE`: COMMAND_BRIDGE_MK1, COMMAND_BRIDGE_MK2
- `CREW_QUARTERS`: CREW_QUARTERS_MEDIUM, CREW_QUARTERS_SMALL, CREW_QUARTERS_STANDARD, CREW_QUARTERS_TINY
- `FTL_FIELD_CONTROLLER`: FTL_FIELD_CONTROLLER
- `FTL_FIELD_EMITTER_LARGE`: FTL_FIELD_EMITTER_LARGE
- `FTL_FIELD_EMITTER_MEDIUM`: FTL_FIELD_EMITTER_MEDIUM
- `FTL_FIELD_EMITTER_SMALL`: FTL_FIELD_EMITTER_SMALL
- `FTL_FUEL_TANK`: FTL_FUEL_TANK_LARGE, FTL_FUEL_TANK_MEDIUM, FTL_FUEL_TANK_SMALL
- `FTL_REACTOR`: FTL_REACTOR_HYPER_POWER, FTL_REACTOR_QUICK_CHARGE, FTL_REACTOR_STANDARD
- `GRAVITY_SHIELD`: GRAVITY_SHIELD_BASIC, NONE
- `HABITATION_MODULE`: HABITATION_MODULE_COLONY_SHIP
- `HEAT_SHIELD`: HEAT_SHIELD_ADVANCED
- `HIGH_G_SEATS`: HIGH_G_SEATS_ADVANCED, HIGH_G_SEATS_BASIC, NONE
- `HULL_TYPE`: HULL_PLATES_ADVANCED, HULL_PLATES_BASIC, HULL_PLATES_LIGHTWEIGHT
- `RADIATION_SHIELD`: RADIATION_SHIELD_SPECIALIZED
- `REPAIR_DRONES`: NONE, REPAIR_DRONES_LARGE
- `STL_ENGINE`: STL_ENGINE_FUEL_SAVING, STL_ENGINE_HYPERTHRUST, STL_ENGINE_STANDARD
- `STL_FUEL_TANK`: STL_FUEL_TANK_LARGE, STL_FUEL_TANK_MEDIUM, STL_FUEL_TANK_SMALL
- `STRUCTURE`: STRUCTURAL_SPACECRAFT_COMPONENT
- `VORTEX_FUEL_TANK`: VORTEX_FUEL_TANK_STANDARD
- `VORTEX_REACTOR`: VORTEX_REACTOR_STANDARD
- `WHIPPLE_SHIELD`: WHIPPLE_SHIELD_ADVANCED

## 对步骤 6 的意义
- **可以不靠 BTF 修正的**：无 —— 上述对照只给出「哪些配件无影响」，没给出任何**新常数**；
- **必须靠 BTF 的**：引擎 f 曲线（缺陷#3）、转移段速度量级。蓝图性能只提供输入（质量/G/罐/ftl），
  不提供任何段速度或燃料系数。
