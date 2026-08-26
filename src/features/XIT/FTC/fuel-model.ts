// 飞船性能驱动的燃料/时间模型（纯本地，不依赖标定锚点/飞行数据）。
//
// 游戏飞行计算在服务器（SHIP_FLIGHT_CALCULATE_TEST_FLIGHT），客户端无公式；
// 本模型用真实服务器数据校准的经验公式 + 飞船实时性能参数动态计算：
// - STL 时间 = d / (v_cruise × f^1.4)，v_cruise 由引擎类型决定
//   （超跑 + hyperthrustEngine：v_cruise ≈ 150,000 km/s @ f=1.0）
// - STL 燃料 ∝ 燃料滑块 f × STL 距离（线性，跨飞船按 stlFuelFlowRate 缩放）
// - STL 时间含质量^0.8 与船体条件修正
// - 自然 FTL：速度 = 飞船 ftlMaxSpeed × 反应堆 r，燃料 ∝ r × 距离
// - 网关 FTL：速度 3.0 pc/h 固定，燃料 = 0，每段 +20min 锁定/衰减
// 飞船动态：质量（装载）、加速度、FTL 最大航速、船体条件实时参与计算。
// 绝对系数为标定默认（可校准），滑块间相对优化不受系数误差影响。

export interface ShipPerformance {
  // 当前质量（含装载，t）。
  mass: number;
  operatingEmptyMass: number;
  // 最大加速度（m/s²）。
  acceleration: number;
  // FTL 最大航速（pc/h，满反应堆）。
  ftlMaxSpeed: number;
  // STL 燃料流量（未知时为 undefined，用标定默认）。
  stlFuelFlowRate?: number;
  reactorPower: number;
  // 船体条件 0–1（<0.8 时性能衰减）。
  condition: number;
  // 蓝图 STL 引擎选项（如 STL_ENGINE_HYPERTHRUST），用于查 v_cruise 表。
  stlEngineOption?: string;
  // 蓝图最大 G力过载因子（用于 v_cruise 经验公式）。
  maxGFactor?: number;
}

// 航线距离指标（从 PlannedRoute 提取）。
export interface RouteMetrics {
  // 起降+进近的 STL 距离（km，游戏距离单位）。
  stlDistanceKm?: number;
  // 自然跃迁总距离（pc）。
  natPc: number;
  // 网关跃迁总距离（pc）。
  gwPc: number;
  // 网关段数（每段含锁定+衰减 20min）。
  gwCount: number;
  // 自然跃迁跳数（每跳含充能 CHARGE 段）。
  natJumpCount?: number;
}

export interface FuelOption {
  fuel: number;
  reactor: number;
  stlFuel: number;
  ftlFuel: number;
  stlHours: number;
  ftlHours: number;
  totalHours: number;
  fuelCost: number;
  timeCost: number;
  gatewayCost: number;
  totalCost: number;
  // 燃料绝对量为标定估算（true）；false 表示缺关键数据仅能报时间。
  fuelEstimated: boolean;
}

// ---- 标定常量（来自两艘飞船同航线 HRT→VH-331g 实测）----
// 超跑 BP-SYKQ（hyperthrustEngine）：v_cruise=150,000 km/s @ f=1.0
// OOG LCB（fuelSavingEngine）：v_cruise=112,500 km/s @ f=1.0
// STL 时间 = d / (v_cruise × f^1.4) × massScale / cond
const REF_MASS = 1088;
const STL_CRUISE_HYPERTHRUST = 150000; // km/s @ f=1.0
// OOG LCB fuelSavingEngine v_cruise（由 STL_ENGINE_CRUISE 表引用）。
const STL_FUEL_EXP = 1.4; // 燃料滑块对巡航速度的指数
// 默认 STL 巡航速度（hyperthrust），其他引擎按蓝图引擎类型取不同常数。
const STL_CRUISE_BASE = STL_CRUISE_HYPERTHRUST;
// STL 燃料系数（每 km·滑块）：F = C_F × f × d。
// 标定自超跑 MIN (f=0.0764, d=341.8M km, fuel=16u) 与 OOG LCB 默认 (f=0.525, d=338.5M, fuel=173u)。
// 取平均以兼容两种引擎。
const STL_FUEL_C = (16 / (0.0764 * 341.8e6) + 173 / (0.525 * 338.5e6)) / 2; // ≈ 7.93e-7
// 自然 FTL 模型（BP-OHMI-3472 蓝图试航实测校准，glass 引擎+标准反应堆）：
// - FTL 燃料 ≈ FTL_FUEL_C × r × pc（含充能段；旧默认 0.25 严重低估）
// - 充能时间 = CHARGE_SECONDS × r（每跳固定充能；实测 4m53s@r≈0.68、6m12s@r≈0.83 → 基准≈440s@r=1）
const FTL_FUEL_C = 7.1; // 每 pc·r（BP-OHMI 实测：CHARGE 4.75u/pc@r=0.68 + DEPARTURE）
const FTL_CHARGE_SECONDS = 440; // 每跳充能基准（秒 @ r=1.0）
// 网关跃迁速度（pc/h）与每段锁定+衰减（h），真实服务器数据校准。
const GW_PC_PER_H = 3.0;
const GW_LOCK_HOURS = 20 / 60;
// 船体条件衰减阈值（<80% 性能下降）与衰减强度。
const CONDITION_THRESHOLD = 0.8;

// STL 巡航速度（km/s @ f=1.0）。
// 实测（同航线 HRT→VH-331g，蓝图试航模拟）：
// - standardEngine / advancedEngine / glassEngine 差异<1% → v_cruise 由
//   飞船整体性能决定（质量/加速度/G力），引擎类型主要影响燃料流速。
// - hyperthrustEngine 明显更快（超跑，G力 27）。
// - fuelSavingEngine（OOG LCB，G力 10）介于两者之间。
// 因此 v_cruise 用 G力经验公式近似（飞船试航后按 G力/性能校准）：
//   v_cruise ≈ V_G8 × (G / 8)^k
// 其中 V_G8 为 G力=8 的参考（BP-OHMI ≈ 61,750 km/s），k 为 G力指数。
const STL_CRUISE_G8 = 61750; // km/s @ G力=8（BP-OHMI 实测）
const STL_CRUISE_G_EXP = 0.9; // G力指数（近似，从 3 组数据拟合）

// v_cruise（km/s @ f=1.0）：优先用实测引擎表（精确），
// 未知引擎/组合用 G力经验公式近似（BP-OHMI G=8 为基准）。
function vCruiseFor(engineOption: string | undefined, maxGFactor?: number): number {
  const table: Record<string, number> = {
    STL_ENGINE_HYPERTHRUST: 150000, // 超跑（G=27）
    STL_ENGINE_FUEL_SAVING: 112500, // OOG LCB（G=10）
    STL_ENGINE_STANDARD: STL_CRUISE_G8,
    STL_ENGINE_ADVANCED: STL_CRUISE_G8,
    STL_ENGINE_GLASS: STL_CRUISE_G8,
  };
  if (engineOption && table[engineOption] !== undefined) {
    return table[engineOption];
  }
  if (maxGFactor !== undefined && maxGFactor > 0) {
    return STL_CRUISE_G8 * Math.pow(maxGFactor / 8, STL_CRUISE_G_EXP);
  }
  return STL_CRUISE_BASE;
}

// 船体条件修正系数：<阈值时线性衰减（80%→0 性能衰减 20%，50%→50%）。
function conditionFactor(condition: number): number {
  if (condition >= CONDITION_THRESHOLD) {
    return 1;
  }
  return Math.max(0.2, condition / CONDITION_THRESHOLD);
}

export interface ModelSettings {
  // 可校准系数（默认标定值）。
  stlTimeC?: number;
  stlFuelC?: number;
  ftlFuelC?: number;
  // 参考 STL 燃料流量（用于跨飞船按 stlFuelFlowRate 缩放）。
  refFlowRate?: number;
  // 参考质量（时间质量缩放基准）。
  refMass?: number;
}

// 计算一组 (燃料滑块, 反应堆) 的燃料消耗与时间。
export function computeFuelOption(
  ship: ShipPerformance,
  metrics: RouteMetrics,
  fuel: number,
  reactor: number,
  prices: { stlPrice: number; ftlPrice: number; timeValue: number },
  settings: ModelSettings = {},
): FuelOption {
  const cF = settings.stlFuelC ?? STL_FUEL_C;
  const cFF = settings.ftlFuelC ?? FTL_FUEL_C;
  const refMass = settings.refMass ?? REF_MASS;
  const cond = conditionFactor(ship.condition);

  // 质量缩放（当前质量 vs 参考），船体修正。
  const massScale = Math.pow(ship.mass / refMass, 0.8);
  // STL 时间（小时）：T = d_km / (v_cruise × f^1.4 × 3600) × massScale / cond。
  // v_cruise 优先按蓝图 G力经验公式，回退引擎查表。
  const d = metrics.stlDistanceKm;
  const vCruise = vCruiseFor(ship.stlEngineOption, ship.maxGFactor);
  const stlHours =
    d !== undefined && d > 0
      ? ((d / (vCruise * Math.pow(fuel, STL_FUEL_EXP) * 3600)) * massScale) / cond
      : 0;
  // STL 燃料（∝ f × d；跨飞船按流量相对缩放）。
  const flowScale =
    ship.stlFuelFlowRate !== undefined && (settings.refFlowRate ?? 0) > 0
      ? ship.stlFuelFlowRate / (settings.refFlowRate as number)
      : 1;
  const stlFuel = d !== undefined ? cF * fuel * d * flowScale : 0;

  // 自然 FTL：
  // - JUMP 时间 = pc / (ftlMaxSpeed × r)
  // - 充能时间 = CHARGE_SECONDS × r 每跳（实测充能时间 ∝ r）
  // - FTL 燃料 = FTL_FUEL_C × r × pc（实测 ∝ r × 距离）
  const r = Math.max(0.01, reactor);
  const natSpeed = Math.max(0.1, ship.ftlMaxSpeed) * r;
  const natJumpHours = metrics.natPc > 0 && natSpeed > 0 ? metrics.natPc / natSpeed : 0;
  const natChargeHours =
    (metrics.natJumpCount ?? 0) > 0
      ? ((metrics.natJumpCount as number) * FTL_CHARGE_SECONDS * r) / 3600
      : 0;
  const ftlFuelNat = cFF * r * metrics.natPc;
  // 网关 FTL：速度固定 3.0 pc/h，燃料 0，每段 +20min 锁定/衰减。
  const gwHours =
    metrics.gwPc > 0 ? metrics.gwPc / GW_PC_PER_H + metrics.gwCount * GW_LOCK_HOURS : 0;

  const ftlHours = natJumpHours + natChargeHours + gwHours;
  const totalHours = stlHours + ftlHours;
  const fuelCost = stlFuel * prices.stlPrice + ftlFuelNat * prices.ftlPrice;
  const timeCost = totalHours * prices.timeValue;
  // 网关现金费用（目前无记录，预留 0）。
  const gatewayCost = 0;

  return {
    fuel,
    reactor,
    stlFuel,
    ftlFuel: ftlFuelNat,
    stlHours,
    ftlHours,
    totalHours,
    fuelCost,
    timeCost,
    gatewayCost,
    totalCost: fuelCost + timeCost + gatewayCost,
    fuelEstimated: d !== undefined && d > 0,
  };
}

export const DEFAULT_FUELS = [0.05, 0.1, 0.3, 0.5, 0.8, 1];
export const DEFAULT_REACTORS = [0.25, 0.5, 0.75, 1];

// 扫描滑块组合，按综合成本（燃料费+时间价值）升序返回。
export function scanFuelOptions(
  ship: ShipPerformance,
  metrics: RouteMetrics,
  fuels: number[],
  reactors: number[],
  prices: { stlPrice: number; ftlPrice: number; timeValue: number },
  settings: ModelSettings = {},
): FuelOption[] {
  const plans: FuelOption[] = [];
  for (const fuel of fuels) {
    for (const reactor of reactors) {
      plans.push(computeFuelOption(ship, metrics, fuel, reactor, prices, settings));
    }
  }
  return plans.sort((a, b) => a.totalCost - b.totalCost);
}
