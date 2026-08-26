// 飞船性能驱动的燃料/时间模型（纯本地，不依赖标定锚点/飞行数据）。
//
// 游戏飞行计算在服务器（SHIP_FLIGHT_CALCULATE_TEST_FLIGHT），客户端无公式；
// 本模型用真实服务器数据校准的经验公式 + 飞船实时性能参数动态计算。
//
// STL 速度（引擎特性表，蓝图试航多档 f 实测校准，2026-08-26）：
//   v(f) = min(V_BASE_engine × f^K_engine, V_SAT_engine)
//   —— 整条曲线（含速度上限 V_SAT）由 STL 引擎类型决定，与飞船质量/G力无关：
//      引擎类型仅 5 种，每种校准一次即可，无需每艘飞船校准。
//      实测：hyperthrust(HCB)→V_SAT 90800；advanced/glass(BP-OHMI)→V_SAT 74500。
//      （曾尝试 V_SAT=7500×sqrt(加速度) 通用公式，被 glass 船 G27/a36.9 却 vSat74500 推翻：
//       glass 与 advanced 的 G/a 完全不同但 vSat 相同 → vSat 由引擎而非 G 决定。）
//   T_stl = d / (v(f) × 3600)
//   STL 燃料：F = C_F_engine × f × d（线性，随引擎类型不同）
// 自然 FTL（蓝图性能驱动，2026-08-26 多船/多配置实测校准）：
//   速度 v = ftlMax×r^(a(1+1.5r))、充能 = (eT/m)×r 秒/跳、燃料 = 0.00293×功率×r×pc
// 网关 FTL：速度 3.0 pc/h 固定，燃料 0，每段 +20min 锁定/衰减。

export interface ShipPerformance {
  // 当前质量（含装载，t）。
  mass: number;
  operatingEmptyMass: number;
  // 最大加速度（m/s²，游戏已含推力/G力限制）。
  acceleration: number;
  // 引擎推力（N，用于 acceleration 缺失时推导）。
  thrust?: number;
  // FTL 最大航速（pc/h，满反应堆）。
  ftlMaxSpeed: number;
  // STL 燃料流量（未知时为 undefined，用标定默认）。
  stlFuelFlowRate?: number;
  reactorPower: number;
  // 船体条件 0–1（<0.8 时性能衰减）。
  condition: number;
  // 蓝图 STL 引擎选项（如 STL_ENGINE_HYPERTHRUST），用于查引擎特性表。
  stlEngineOption?: string;
  // 蓝图 STL 燃料罐容量（跨星系离港/进近燃料按罐比例算）。
  stlFuelCapacity?: number;
  // 蓝图最小反应堆使用量（= 发射器功率需求/反应堆功率，HYR 超跑 0.076、STD 新手船 0.302）。
  minReactorUsage?: number;
  // 蓝图发射器充能时间（秒，基础充能；充能时间 = eT/m × r）。
  emitterChargeTime?: number;
  // 蓝图最大 G力过载因子（加速度上限 maxGFactor×9.81）。
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
  // 目的地实体 naturalId（跨星系时用于 FIO 行星重力查询，精确着陆燃料）。
  toBody?: string;
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

// ---- STL 引擎特性表（v(f) = min(V_BASE×f^K, V_SAT)，km/s）----
// 整条曲线（V_BASE/K/V_SAT/C_F）由引擎类型决定，与飞船质量、G力、船板等配置无关
// （已用 advanced 引擎在 G8/G15 两种船板实测验证：vSat 相同，误差<0.15%）。
// 引擎类型仅 5 种，已全部实测确认（每种用任一该引擎的船校准一次）：
//   hyperthrust(HCB): f=0.05→43441、f=0.1→73359、f≥0.2 饱和 90800。
//   advanced/standard(BP-OHMI AEN): f=0.05→53611、f=0.1→74011、f≥0.2 饱和 75200（同参数）。
//   glass(BP-OHMI 玻璃): f=0.03→35401、f=0.05→53176、f≈0.1 饱和 74500。
//   fuelSaving: f=0.05→11540、f=0.1→22517、f≈0.45 饱和 74500，省油 C_F=5.2e-6。
const STL_ENGINE_SPEED: Record<string, { vBase: number; k: number; vSat: number; fuelC: number }> =
  {
    STL_ENGINE_HYPERTHRUST: { vBase: 418187, k: 0.756, vSat: 90800, fuelC: 2.81e-5 }, // HCB 实测
    STL_ENGINE_FUEL_SAVING: { vBase: 167000, k: 0.885, vSat: 74500, fuelC: 5.2e-6 }, // 实测（省油）
    STL_ENGINE_STANDARD: { vBase: 216000, k: 0.465, vSat: 75200, fuelC: 2.85e-5 }, // BP-OHMI 实测（≈advanced）
    STL_ENGINE_ADVANCED: { vBase: 216000, k: 0.465, vSat: 75200, fuelC: 2.85e-5 }, // BP-OHMI(AEN) 实测
    STL_ENGINE_GLASS: { vBase: 357000, k: 0.648, vSat: 74500, fuelC: 2.84e-5 }, // BP-OHMI(玻璃) 实测
  };
const DEFAULT_STL_SPEED = STL_ENGINE_SPEED.STL_ENGINE_HYPERTHRUST;
// 自然 FTL 模型（2026-08-26 多船/多配置实测校准，蓝图性能驱动）：
// - JUMP 速度：v = ftlMaxSpeed × r^(a(1+1.6r))，a = 0.40×ln(ftlMaxSpeed) − 0.10
//   实测 3 艘正常船 13 点（超跑/新手船/修改版HCB）平均误差 3.0%，b/a≈1.6 全船一致。
//   （早期“k 依赖反应堆类型”的 FTL_REACTOR_K 表被修改版 HCB 实测推翻。）
// - 充能时间：charge = (emitterChargeTime ÷ minReactorUsage) × r 秒/跳
//   5 配置精确验证（超跑/HCB=90、新手船=450 秒/单位 r）。
// - FTL 燃料：C_F = 0.00293 × 反应堆功率(GW)；fuel = C_F × r × 总pc
//   实测 HYR(7200GW)=21.45、STD(2400GW)=7.0，与功率成正比。
const FTL_FUEL_C_PER_GW = 0.00293; // 每 pc·r·GW
const FTL_SPEED_A_SLOPE = 0.4;
const FTL_SPEED_A_OFFSET = 0.1;
const FTL_SPEED_B_RATIO = 1.6;

// FTL 跃迁速度指数 a（曲线 v = ftlMax×r^(a(1+1.5r))，随 ln(ftlMax) 增长）。
function ftlSpeedExponentA(ftlMaxSpeed: number): number {
  const ftl = Math.max(0.1, ftlMaxSpeed);
  return Math.max(0.05, FTL_SPEED_A_SLOPE * Math.log(ftl) - FTL_SPEED_A_OFFSET);
}

// FTL 跃迁速度（pc/h）：v = ftlMax × r^(a(1+1.5r))。
function ftlSpeedFor(ship: ShipPerformance, reactor: number): number {
  const ftlMax = Math.max(0.1, ship.ftlMaxSpeed);
  const r = Math.max(0.001, reactor);
  const a = ftlSpeedExponentA(ftlMax);
  const k = a * (1 + FTL_SPEED_B_RATIO * r);
  return ftlMax * Math.pow(r, k);
}

// FTL 充能时间（秒/跳）：charge = (emitterChargeTime ÷ minReactorUsage) × r。
// 缺蓝图参数时回退到 90×r（HYR 校准值）。
function ftlChargeSecondsFor(ship: ShipPerformance, reactor: number): number {
  const m = ship.minReactorUsage;
  const eT = ship.emitterChargeTime;
  if (m !== undefined && eT !== undefined && m > 0) {
    return (eT / m) * reactor;
  }
  return 90 * reactor;
}

// FTL 燃料系数（每 pc·r）：C_F = 0.00293 × 反应堆功率(GW)。缺功率时回退 HYR 21.4。
function ftlFuelCFor(ship: ShipPerformance): number {
  const power = ship.reactorPower;
  if (power !== undefined && power > 0) {
    return FTL_FUEL_C_PER_GW * power;
  }
  return 21.4;
}
// 网关跃迁速度（pc/h）与每段锁定+衰减（h），真实服务器数据校准。
const GW_PC_PER_H = 3.0;
const GW_LOCK_HOURS = 20 / 60;
// 船体条件衰减阈值（<80% 性能下降）与衰减强度。
const CONDITION_THRESHOLD = 0.8;

// STL 引擎参数查表（引擎未命中时用 hyperthrust 校准值）。
function stlEngineParams(engineOption: string | undefined) {
  if (engineOption !== undefined) {
    const p = STL_ENGINE_SPEED[engineOption];
    if (p !== undefined) {
      return p;
    }
  }
  return DEFAULT_STL_SPEED;
}

// STL 巡航速度（km/s @ 燃料滑块 f）：饱和模型 v(f) = min(V_BASE×f^K, V_SAT)。
// 整条曲线查引擎表（引擎类型决定，非每船校准）；G力/质量不影响。
// 实测：hyperthrust f≥0.2 饱和 90800；advanced f≈0.45 饱和 74500；glass f≈0.1 饱和 74500。
function stlSpeedFor(ship: ShipPerformance, fuel: number): number {
  const p = stlEngineParams(ship.stlEngineOption);
  const f = Math.max(0.001, fuel);
  return Math.min(p.vBase * Math.pow(f, p.k), p.vSat);
}

// STL 燃料系数（每 km·滑块）按引擎取。
function stlFuelCFor(engineOption: string | undefined, fallback: number): number {
  const p = stlEngineParams(engineOption);
  return p.fuelC ?? fallback;
}

// 船体条件修正系数：<阈值时线性衰减（80%→0 性能衰减 20%，50%→50%）。
function conditionFactor(condition: number): number {
  if (condition >= CONDITION_THRESHOLD) {
    return 1;
  }
  return Math.max(0.2, condition / CONDITION_THRESHOLD);
}

// 跨星系 STL 分段燃料（2026-08-26 新手船/HCB + 2026-08-27 WCB 四船 14 航线实测 + FIO 行星环境）：
// - 离港 = 0.49 × STL罐 × f（7 次验证，与距离/航线无关；仅自然跃迁航线）
// - 进近 ≈ 0.49 × STL罐 × f + 进近差（小量：新手船 3.5-6.5、WCB 5.5-7.5、HCB 10-14，默认 8）
// - 着陆 = 船体系数 × 0.47 × √(半径_km × P^(-0.2))    ★终极模型（7/7 点 ±0.7u）
//   实测 WCB 7 行星（Boucher/Ashland/LS-231a/UQ-328b/Mimar/Euu/Sabaton）着陆燃料 =
//   0.578×√(着陆距离km)，着陆距离 = 0.66×R×P^(-0.2)（厚大气→短着陆段，进近段更长）。
//   推翻"大气阈值"假说：Euu/Mimar/Sabaton 着陆低是距离短所致（LS-231a P1.98 着陆 42
//   更高直接证伪阈值）；"G 重力模型"是距离与 g/P 巧合相关的假象。
// ⚠️ 已知局限：罐模型仅对自然跃迁航线成立；网关航线（跃门）的离港/进近显著更低
//   （WCB Sabaton 进近 117/Mimar 90 vs 模型 171.5），结构不同待研究。
// 跨星系（有跃迁）航线：stlFuel = 0.98 × 罐 × f + 进近差 + 着陆
// 同星系航线仍用 C_F×f×d（转移段占比大，已校准）。
const STL_TANK_FUEL_COEF = 0.98; // 离港+进近 = 0.98×罐×f
const STL_APPROACH_EXTRA = 8; // 进近差近似（新手船 3.5-6.5、WCB 5.5-7.5、HCB 10-14 取中上，偏重船更安全）
const STL_LANDING_DIST_C = 0.47; // 着陆燃料系数：fuel = C×√(R_km × P^-0.2)（WCB 实测 7 点 ±0.7u）
const STL_LANDING_P_EXP = 0.2; // 气压缩短着陆段指数（着陆距离 = 0.66×R×P^-0.2）
const STL_LANDING_G_REF = 8; // 船体系数基准 G（新手船）
const STL_LANDING_G_EXP = 0.6; // 船体系数 G 指数：HCB(G15) 1.456≈(15/8)^0.6、WCB(G8) 1.0
const STL_SEGMENTS_EXTRA = 40; // 无重力数据时的回退近似（旧常数）

// 着陆船体系数：新手船/WCB(G=8)为 1.0，HCB(G=15)实测 1.456 ≈ (15/8)^0.6。
// 新手船实测 0.94 偏低 6%（特例，疑轻船效应），G 力从蓝图读取（maxGFactor），无需每船校准。
export function stlLandingFactor(ship: ShipPerformance): number {
  const g = ship.maxGFactor;
  if (g === undefined || g <= 0) {
    return 1;
  }
  return Math.pow(g / STL_LANDING_G_REF, STL_LANDING_G_EXP);
}

export interface ModelSettings {
  // 可校准系数（默认标定值）。
  stlTimeC?: number;
  stlFuelC?: number;
  ftlFuelC?: number;
  // 跨星系 STL 分段燃料的进近差值+着陆近似（可校准）。
  stlSegmentExtra?: number;
  // 目的地行星半径（km，FIO /planet/{id}；undefined 时用 stlSegmentExtra 回退）。
  landingRadius?: number;
  // 目的地行星气压（大气缩短着陆段；P^-0.2，缺省按 1）。
  landingPressure?: number;
  // 着陆船体系数覆盖（默认 (G/8)^0.6）。
  stlLandingFactor?: number;
  // 进近差近似（默认 8）。
  stlApproachExtra?: number;
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
  const cond = conditionFactor(ship.condition);

  // STL 时间（小时）：T = d / (v(f) × 3600) / cond。
  // v(f) = min(V_BASE×f^K, V_SAT)，整条曲线查引擎表（引擎类型决定，与质量/G力无关）。
  const d = metrics.stlDistanceKm;
  const v = stlSpeedFor(ship, fuel);
  const stlHours = d !== undefined && d > 0 ? d / (v * 3600) / cond : 0;
  // STL 燃料：跨星系（有跃迁）用罐模型（离港+进近 = 0.98×罐×f + 进近差 + 着陆）。
  // 着陆 = 船体系数 × 0.47 × √(半径_km × P^-0.2)（FIO 半径/气压查询，失败回退旧常数；
  // ⚠️罐模型仅对自然跃迁航线成立，网关航线偏低。）
  // 同星系用 C_F×f×d（转移段，已校准）。
  const cF = settings.stlFuelC ?? stlFuelCFor(ship.stlEngineOption, 3.05e-5);
  const isCrossSystem = (metrics.natPc ?? 0) > 0 || (metrics.gwPc ?? 0) > 0;
  const tank = ship.stlFuelCapacity;
  let stlFuel: number;
  if (isCrossSystem && tank !== undefined && tank > 0) {
    const R = settings.landingRadius;
    if (R !== undefined && R > 0) {
      const lf = settings.stlLandingFactor ?? stlLandingFactor(ship);
      const P =
        settings.landingPressure !== undefined && settings.landingPressure > 0
          ? settings.landingPressure
          : 1;
      const landing = STL_LANDING_DIST_C * Math.sqrt(R * Math.pow(P, -STL_LANDING_P_EXP));
      stlFuel =
        STL_TANK_FUEL_COEF * tank * fuel +
        (settings.stlApproachExtra ?? STL_APPROACH_EXTRA) +
        lf * landing;
    } else {
      stlFuel = STL_TANK_FUEL_COEF * tank * fuel + (settings.stlSegmentExtra ?? STL_SEGMENTS_EXTRA);
    }
  } else {
    stlFuel = d !== undefined ? cF * fuel * d : 0;
  }

  // 自然 FTL：
  // - JUMP 速度 = ftlMax × r^(a(1+1.5r))，a = 0.40×ln(ftlMax) − 0.10
  // - 充能时间 = (emitterChargeTime ÷ minReactorUsage) × r 每跳
  // - FTL 燃料 = 0.00293 × 反应堆功率 × r × pc
  const r = Math.max(0.01, reactor);
  const natSpeed = ftlSpeedFor(ship, r);
  const natJumpHours = metrics.natPc > 0 && natSpeed > 0 ? metrics.natPc / natSpeed : 0;
  const chargeSeconds = ftlChargeSecondsFor(ship, r);
  const natChargeHours =
    (metrics.natJumpCount ?? 0) > 0 ? ((metrics.natJumpCount as number) * chargeSeconds) / 3600 : 0;
  const ftlFuelC = settings.ftlFuelC ?? ftlFuelCFor(ship);
  const ftlFuelNat = ftlFuelC * r * metrics.natPc;
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
