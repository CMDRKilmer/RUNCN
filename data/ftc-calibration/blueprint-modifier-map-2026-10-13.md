# 蓝图 performance 键 与 selection/modifier 的真实映射（实测）

来源：`prun-blueprint-dump.json`（2026-10-13 从游戏内 `BLU` 面板导出的 13 份蓝图 + 5 艘飞船原始数据）。
用途：取代 `ftc-compute.ts:140-149` 里靠**别名猜测**兜底的 `modifierValue('FTL_MAX_SPEED','FTL_SPEED')` 等写法。

## 结论 1：那 10 个别名**全部不存在**

`performance` 的真实键（13 份蓝图取并集，共 14 个）：

```
acceleration
accelerationMax
emitterChargeTime
ftlFuelCapacity
ftlFuelMaterial
ftlMaxSpeed
maxGFactor
maxOverchargeTime
minReactorUsage
operatingEmptyMass
stlFuelCapacity
storeCapacityVolume
storeCapacityWeight
totalVolume
```

`ftc-compute.ts` 猜的 `FTL_MAX_SPEED` / `FTL_SPEED` / `STL_FUEL_CAPACITY` / `STL_TANK_CAPACITY` /
`MIN_REACTOR_USAGE` / `FTL_REACTOR_USAGE` / `EMITTER_CHARGE_TIME` / `FTL_EMITTER_TIME` /
`MAX_G_FACTOR` / `G_FACTOR` —— **一个都不是 performance 键**（实测全为 false）。

`performance` 里对应的**真实键**是（小驼峰）：`ftlMaxSpeed`、`stlFuelCapacity`、`ftlFuelCapacity`、
`minReactorUsage`、`emitterChargeTime`、`maxGFactor`、`acceleration`、`accelerationMax`、
`operatingEmptyMass`、`totalVolume`、`storeCapacityWeight`、`storeCapacityVolume`、
`maxOverchargeTime`、`ftlFuelMaterial`。

## 结论 2：真正的机制是 `selection.modifiers[].type`（大写蛇形）

`modifier.type` 实际出现的**全部**取值（39 处 selection × 13 蓝图统计）：

| modifier.type | 出现次数 | 含义 |
|---|---|---|
| FTL_VOLUME_SPAN | 39 | 发射器 FTL 体积跨度 |
| POWER_REQUIREMENT | 39 | 发射器功率需求（→ minReactorUsage） |
| SHIELDING_GENERAL | 15 | 船板通用防护 |
| STL_USAGE | 13 | **STL 燃料流量（u/s）** ← 即 Ship.stlFuelFlowRate |
| STL_FUEL_CAPACITY | 13 | STL 罐容量 |
| CARGO_CAPACITY_VOLUME | 13 | 货舱容积 |
| CARGO_CAPACITY_WEIGHT | 13 | 货舱载重 |
| MAX_G_FACTOR | 13 | 最大 G 力因子（**每块船板**的值） |
| FTL_POWER | 12 | 反应堆功率（GW） |
| FTL_CHARGE_FACTOR | 12 | 充能系数 |
| FTL_FUEL_CAPACITY | 12 | FTL 罐容量 |
| SHIELDING_GRAVITY | 7 | 重力防护 |
| SHIELDING_HEAT | 3 | 隔热 |
| MAX_G_FACTOR_INCREASE | 3 | 高 G 座椅的 G 力追加 |
| SHIELDING_WHIPPLE | 2 | 惠普尔护盾 |
| SHIELDING_RADIATION | 2 | 防辐射 |
| VORTEX_FUEL_CAPACITY | 1 | 涡流罐容量 |

## 结论 3：`amount` 与 modifier 的关系 —— **不要自己乘**

⚠️ **关键坑**（我第一次算错过）：`HULL_TYPE` 的 `amount` 是**船板块数**（如 94 块），
而 `MAX_G_FACTOR=10` 是**每块**的值。`Σ(modifier.value × amount)` 得 940，
但 `performance.maxGFactor` = 10 —— **服务器的 performance 已经是结算后的结果**，
不是待求量。

```
LCB 轻板: HULL_TYPE=HULL_PLATES_LIGHTWEIGHT amount=94, MAX_G_FACTOR=10
         performance.maxGFactor = 10   ← 不是 94×10=940
         performance.operatingEmptyMass = 1115.3  ← 94 块板的重量已含在此
```

**推论**：`ftc-compute.ts` 现有做法（`componentModifiers[type] += value * sel.amount`）对
`MAX_G_FACTOR` 这类**每单位属性**是**错的**（会得 940 而非 10）。正确用法是
**优先直接读 `performance` 的既有键**，modifier 只用于 performance 没提供的量
（如 STL_USAGE → stlFuelFlowRate，已由 `Ship.stlFuelFlowRate` 提供）。

## 结论 4：`Ship` 对象已下发的字段（5 艘实船实测）

`ships` 数组含 `mass`/`operatingEmptyMass`/`acceleration`/`thrust`/`reactorPower`/
`emitterPower`/`stlFuelFlowRate`/`condition` 等。**关键**：`stlFuelFlowRate` 由服务器直接下发，
无需从 STL_USAGE 推断 —— 现有 `stlFlowRateFor()` 的引擎表回退**只在飞船无该字段时才该用**。

## 结论 5：selection 全表（22 类，含可选项）

### STL_ENGINE

| option | amount(样例) | modifiers |
|---|---|---|
| STL_ENGINE_FUEL_SAVING | 1 | STL_USAGE=0.0075 |
| STL_ENGINE_HYPERTHRUST | 1 | STL_USAGE=0.03 |
| STL_ENGINE_STANDARD | 1 | STL_USAGE=0.015 |

### STL_FUEL_TANK

| option | amount(样例) | modifiers |
|---|---|---|
| STL_FUEL_TANK_SMALL | 1 | STL_FUEL_CAPACITY=1500 |
| STL_FUEL_TANK_MEDIUM | 1 | STL_FUEL_CAPACITY=3500 |
| STL_FUEL_TANK_LARGE | 1 | STL_FUEL_CAPACITY=8000 |

### FTL_REACTOR

| option | amount(样例) | modifiers |
|---|---|---|
| FTL_REACTOR_STANDARD | 1 | FTL_POWER=2400, FTL_CHARGE_FACTOR=2 |
| FTL_REACTOR_QUICK_CHARGE | 1 | FTL_POWER=2000, FTL_CHARGE_FACTOR=10 |
| FTL_REACTOR_HYPER_POWER | 1 | FTL_POWER=7200, FTL_CHARGE_FACTOR=30 |
| NONE | 0 | — |

### FTL_FUEL_TANK

| option | amount(样例) | modifiers |
|---|---|---|
| FTL_FUEL_TANK_SMALL | 1 | FTL_FUEL_CAPACITY=300 |
| FTL_FUEL_TANK_LARGE | 1 | FTL_FUEL_CAPACITY=2000 |
| FTL_FUEL_TANK_MEDIUM | 1 | FTL_FUEL_CAPACITY=800 |
| NONE | 0 | — |

### VORTEX_REACTOR

| option | amount(样例) | modifiers |
|---|---|---|
| NONE | 0 | — |
| VORTEX_REACTOR_STANDARD | 1 | — |

### VORTEX_FUEL_TANK

| option | amount(样例) | modifiers |
|---|---|---|
| NONE | 0 | — |
| VORTEX_FUEL_TANK_STANDARD | 1 | VORTEX_FUEL_CAPACITY=10000 |

### CARGO_BAY

| option | amount(样例) | modifiers |
|---|---|---|
| CARGO_BAY_SMALL | 1 | CARGO_CAPACITY_VOLUME=500, CARGO_CAPACITY_WEIGHT=500 |
| CARGO_BAY_LARGE | 1 | CARGO_CAPACITY_VOLUME=2000, CARGO_CAPACITY_WEIGHT=2000 |
| CARGO_BAY_HUGE | 1 | CARGO_CAPACITY_VOLUME=5000, CARGO_CAPACITY_WEIGHT=5000 |
| CARGO_BAY_TINY | 1 | CARGO_CAPACITY_VOLUME=100, CARGO_CAPACITY_WEIGHT=100 |
| CARGO_BAY_HIGH_LOAD | 1 | CARGO_CAPACITY_VOLUME=1000, CARGO_CAPACITY_WEIGHT=3000 |
| CARGO_BAY_MEDIUM | 1 | CARGO_CAPACITY_VOLUME=1000, CARGO_CAPACITY_WEIGHT=1000 |

### HULL_TYPE

| option | amount(样例) | modifiers |
|---|---|---|
| HULL_PLATES_BASIC | 48 | SHIELDING_GENERAL=0, MAX_G_FACTOR=8 |
| HULL_PLATES_LIGHTWEIGHT | 94 | SHIELDING_GENERAL=-0.1, MAX_G_FACTOR=10 |
| HULL_PLATES_ADVANCED | 202 | SHIELDING_GENERAL=0.3, MAX_G_FACTOR=15 |

### HEAT_SHIELD

| option | amount(样例) | modifiers |
|---|---|---|
| NONE | 0 | — |
| HEAT_SHIELD_ADVANCED | 202 | SHIELDING_HEAT=1 |

### WHIPPLE_SHIELD

| option | amount(样例) | modifiers |
|---|---|---|
| NONE | 0 | — |
| WHIPPLE_SHIELD_ADVANCED | 202 | SHIELDING_WHIPPLE=1 |

### GRAVITY_SHIELD

| option | amount(样例) | modifiers |
|---|---|---|
| NONE | 0 | — |
| GRAVITY_SHIELD_BASIC | 1 | SHIELDING_GRAVITY=1 |

### RADIATION_SHIELD

| option | amount(样例) | modifiers |
|---|---|---|
| NONE | 0 | — |
| RADIATION_SHIELD_SPECIALIZED | 202 | SHIELDING_RADIATION=0.7 |

### REPAIR_DRONES

| option | amount(样例) | modifiers |
|---|---|---|
| NONE | 0 | — |
| REPAIR_DRONES_LARGE | 1 | SHIELDING_GENERAL=0.1 |

### HIGH_G_SEATS

| option | amount(样例) | modifiers |
|---|---|---|
| NONE | 0 | — |
| HIGH_G_SEATS_ADVANCED | 1 | MAX_G_FACTOR_INCREASE=12 |
| HIGH_G_SEATS_BASIC | 1 | MAX_G_FACTOR_INCREASE=5 |

### STRUCTURE

| option | amount(样例) | modifiers |
|---|---|---|
| STRUCTURAL_SPACECRAFT_COMPONENT | 407 | — |

### COMMAND_BRIDGE

| option | amount(样例) | modifiers |
|---|---|---|
| COMMAND_BRIDGE_MK1 | 1 | — |
| COMMAND_BRIDGE_MK2 | 1 | — |

### CREW_QUARTERS

| option | amount(样例) | modifiers |
|---|---|---|
| CREW_QUARTERS_SMALL | 1 | — |
| CREW_QUARTERS_MEDIUM | 1 | — |
| CREW_QUARTERS_STANDARD | 1 | — |
| CREW_QUARTERS_TINY | 1 | — |

### FTL_FIELD_CONTROLLER

| option | amount(样例) | modifiers |
|---|---|---|
| FTL_FIELD_CONTROLLER | 0 | — |

### FTL_FIELD_EMITTER_SMALL

| option | amount(样例) | modifiers |
|---|---|---|
| FTL_FIELD_EMITTER_SMALL | 0 | FTL_VOLUME_SPAN=250, POWER_REQUIREMENT=100 |

### FTL_FIELD_EMITTER_MEDIUM

| option | amount(样例) | modifiers |
|---|---|---|
| FTL_FIELD_EMITTER_MEDIUM | 0 | FTL_VOLUME_SPAN=500, POWER_REQUIREMENT=175 |

### FTL_FIELD_EMITTER_LARGE

| option | amount(样例) | modifiers |
|---|---|---|
| FTL_FIELD_EMITTER_LARGE | 0 | FTL_VOLUME_SPAN=1000, POWER_REQUIREMENT=300 |

### HABITATION_MODULE

| option | amount(样例) | modifiers |
|---|---|---|
| NONE | 0 | — |
| HABITATION_MODULE_COLONY_SHIP | 1 | — |
