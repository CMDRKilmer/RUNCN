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
  // 离港/进近各自的距离（km，用于按段速度分别计时）。
  departKm?: number;
  approachKm?: number;
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
// flow = STL 燃料流量（u/s，用于着陆/离港燃料的流量缩放；飞船数据缺流量时回退）：
//   fuelSaving 0.0075、标准 0.015、glass 0.015、advanced 0.02、hyperthrust 0.03（均 BLU 蓝图实测；
//   旧值 hyperthrust 0.02 错误——BP-OHMI 超推力显示"每秒0.03单位燃料"）。
const STL_ENGINE_SPEED: Record<
  string,
  { vBase: number; k: number; vSat: number; fuelC: number; flow: number }
> = {
  STL_ENGINE_HYPERTHRUST: { vBase: 418187, k: 0.756, vSat: 90800, fuelC: 2.81e-5, flow: 0.03 }, // HCB 实测
  // fuelSaving（2026-08-27 OOG LCB 实测修正）：旧借值 167000/0.885/74500（v0.1≈21.8k）
  // 严重低估——OOG 实测离港/进近按统一段模型反推巡航 v0.1≈65k、饱和 ~69.8k。
  STL_ENGINE_FUEL_SAVING: { vBase: 246530, k: 0.578, vSat: 69754, fuelC: 5.2e-6, flow: 0.0075 }, // OOG LCB 实测
  STL_ENGINE_STANDARD: { vBase: 216000, k: 0.465, vSat: 75200, fuelC: 2.85e-5, flow: 0.015 }, // BP-OHMI 实测（≈advanced）
  STL_ENGINE_ADVANCED: { vBase: 216000, k: 0.465, vSat: 75200, fuelC: 2.85e-5, flow: 0.02 }, // BP-OHMI(AEN) 实测
  STL_ENGINE_GLASS: { vBase: 357000, k: 0.648, vSat: 74500, fuelC: 2.84e-5, flow: 0.015 }, // BP-OHMI(玻璃) 实测
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
export function ftlSpeedFor(ship: ShipPerformance, reactor: number): number {
  const ftlMax = Math.max(0.1, ship.ftlMaxSpeed);
  const r = Math.max(0.001, reactor);
  const a = ftlSpeedExponentA(ftlMax);
  const k = a * (1 + FTL_SPEED_B_RATIO * r);
  return ftlMax * Math.pow(r, k);
}

// FTL 充能时间（秒/跳）：charge = (emitterChargeTime ÷ minReactorUsage) × r。
// 缺蓝图参数时回退到 90×r（HYR 校准值）。
export function ftlChargeSecondsFor(ship: ShipPerformance, reactor: number): number {
  const m = ship.minReactorUsage;
  const eT = ship.emitterChargeTime;
  if (m !== undefined && eT !== undefined && m > 0) {
    return (eT / m) * reactor;
  }
  return 90 * reactor;
}

// FTL 燃料系数（每 pc·r）：C_F = 0.00293 × 反应堆功率(GW)。缺功率时回退 HYR 21.4。
export function ftlFuelCFor(ship: ShipPerformance): number {
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
export function stlSpeedFor(ship: ShipPerformance, fuel: number): number {
  const p = stlEngineParams(ship.stlEngineOption);
  const f = Math.max(0.001, fuel);
  return Math.min(p.vBase * Math.pow(f, p.k), p.vSat);
}

// ---- 离港/进近段速度（2026-08-27 重构：段燃料 Q 驱动 + 逐引擎 Weibull 标定）----
// 💥 重大发现：离港/进近段速度不由巡航速度决定，而由"段中可用的 STL 燃料量"决定！
//   实测（BP-OHMI 多引擎×多油箱，HRT→Euu，同引擎同航线）：
//     油箱越小 → 段速度越慢（standard f=0.05 离港：小型1500→5.7k、中型3500→12.3k、
//     大型8000→19.3k km/s），饱和段速度与油箱无关 → 段速度是"段燃料"的函数。
//   段燃料：Q_离港 = 0.49×罐×f；Q_进近 = 0.49×罐×f + 进近差(8)。
//   模型：v_seg = V_SAT_seg × (1 − exp(−(Q/Q0)^k))（Weibull 饱和曲线，2-5% 误差）。
//   各引擎 V_SAT（离/进近饱和，油箱无关）与 Weibull 参数（Q0/k）2026-08-27 实测标定：
//     standard:      离 20938/94.6/1.216；进 38607/181/1.17   （3 油箱全档最全）
//     fuelSaving:    离 18130/31.5/1.3；  进 33298/95/1.45    （OOG 中型+大型）
//     advanced:      离 20937/105.9/1.2；进 38534/221.2/1.436 （大型油箱）
//     hyperthrust:   离 20937/193.6/1.636；进 38534/328.2/1.217（大型油箱）
//     glass:         离 12820/174.2/2.059；进 23447/256.5/1.303（大型油箱）
//   ★ G 力修正：段速度饱和值 ∝ (G/8)^0.3（HCB G15 1.218×、OOG G10 1.089× vs G8 实测），
//   即 v = V_SAT_G8 × (G/8)^0.3 × (1−exp(−(Q/Q0)^k))。
//   ⚠️ 旧"统一段模型（段=巡航比例）"只在大型油箱+特定引擎下偶然成立（HCB/OOG 罐大、
//   Q 充足段速度接近饱和），小型油箱（新手船 STS 1500 罐）彻底推翻 → 需按此重构。
interface StlSegmentCurve {
  vSat: number;
  q0: number;
  k: number;
}
const STL_SEGMENT_CURVES: Record<string, { depart: StlSegmentCurve; approach: StlSegmentCurve }> = {
  STL_ENGINE_FUEL_SAVING: {
    depart: { vSat: 18130, q0: 31.5, k: 1.3 },
    approach: { vSat: 33298, q0: 95, k: 1.45 },
  },
  STL_ENGINE_STANDARD: {
    depart: { vSat: 20938, q0: 94.6, k: 1.216 },
    approach: { vSat: 38607, q0: 181, k: 1.17 },
  },
  STL_ENGINE_ADVANCED: {
    depart: { vSat: 20937, q0: 105.9, k: 1.2 },
    approach: { vSat: 38534, q0: 221.2, k: 1.436 },
  },
  STL_ENGINE_HYPERTHRUST: {
    depart: { vSat: 20937, q0: 193.6, k: 1.636 },
    approach: { vSat: 38534, q0: 328.2, k: 1.217 },
  },
  STL_ENGINE_GLASS: {
    depart: { vSat: 12820, q0: 174.2, k: 2.059 },
    approach: { vSat: 23447, q0: 256.5, k: 1.303 },
  },
};
const DEFAULT_STL_SEGMENT_CURVE = STL_SEGMENT_CURVES.STL_ENGINE_STANDARD;

// 段速度（km/s）：v = V_SAT_G8 × (G/8)^0.3 × (1 − exp(−(Q/Q0)^k))，Q 由 STL 罐容量×f 决定。
// G 修正：段速度饱和值 ∝ (G/8)^0.3（HCB G15 1.218×、OOG G10 1.089× vs G8 实测）。
// 缺罐数据时回退饱和段速度（V_SAT，保守取上限——大多数跨星系船都有蓝图罐数据）。
const STL_SEGMENT_G_REF = 8;
const STL_SEGMENT_G_EXP = 0.3;
function stlSegmentSpeedFor(
  ship: ShipPerformance,
  fuel: number,
  curve: StlSegmentCurve,
  approach: boolean,
): number {
  const tank = ship.stlFuelCapacity;
  if (tank === undefined || tank <= 0) {
    return curve.vSat;
  }
  const q = approach
    ? STL_TANK_FUEL_COEF * tank * fuel + STL_APPROACH_EXTRA
    : STL_TANK_FUEL_COEF * tank * fuel;
  let vSat = curve.vSat;
  const g = ship.maxGFactor;
  if (g !== undefined && g > 0) {
    vSat *= Math.pow(g / STL_SEGMENT_G_REF, STL_SEGMENT_G_EXP);
  }
  return vSat * (1 - Math.exp(-Math.pow(q / curve.q0, curve.k)));
}

function stlSegmentCurveFor(ship: ShipPerformance): {
  depart: StlSegmentCurve;
  approach: StlSegmentCurve;
} {
  const p = STL_SEGMENT_CURVES[ship.stlEngineOption ?? ''];
  return p ?? DEFAULT_STL_SEGMENT_CURVE;
}

// 离港段速度（km/s @ f）：由段燃料 Q=0.49×罐×f 驱动。
export function stlDepartSpeedFor(ship: ShipPerformance, fuel: number): number {
  return stlSegmentSpeedFor(ship, fuel, stlSegmentCurveFor(ship).depart, false);
}

// 进近段速度（km/s @ f）：由段燃料 Q=0.49×罐×f+8 驱动。
export function stlApproachSpeedFor(ship: ShipPerformance, fuel: number): number {
  return stlSegmentSpeedFor(ship, fuel, stlSegmentCurveFor(ship).approach, true);
}

// STL 燃料系数（每 km·滑块）按引擎取。
export function stlFuelCFor(engineOption: string | undefined, fallback: number): number {
  const p = stlEngineParams(engineOption);
  return p.fuelC ?? fallback;
}

// 船体条件修正系数：<阈值时线性衰减（80%→0 性能衰减 20%，50%→50%）。
export function conditionFactor(condition: number): number {
  if (condition >= CONDITION_THRESHOLD) {
    return 1;
  }
  return Math.max(0.2, condition / CONDITION_THRESHOLD);
}

// 跨星系 STL 分段燃料（2026-08-26 新手船/HCB + 2026-08-27 WCB/OOG LCB 实测 + FIO 行星环境）：
// - 离港 = 0.49 × STL罐 × min(f, f_cap)（7 次验证；省油引擎离港燃料随 f 饱和，
//   OOG LCB 四档实测 87@0.05 / 141@0.1+，f_cap ≈ 10.96×流量：标准 0.015→0.164 无实际影响）
// - 进近 ≈ 0.49 × STL罐 × f + 进近差（不饱和；OOG LCB 178@f0.1 精确吻合，与引擎无关）
// - 起飞（行星出发特有）= 船体系数 × 0.455 × √(半径_km × P^(+0.2))   ★3 点 ±3%
// - 着陆 = 船体系数 × 0.47 × √(半径_km × P^(-0.2))    ★终极模型（WCB 7 行星 ±0.7u）
//   实测 WCB 7 行星（Boucher/Ashland/LS-231a/UQ-328b/Mimar/Euu/Sabaton）着陆燃料 =
//   0.578×√(着陆距离km)，着陆距离 = 0.66×R×P^(-0.2)（厚大气→短着陆段，进近段更长）。
//   起飞与着陆 P 指数符号相反（厚大气→起飞长/着陆短），起飞+着陆 ≈ 84 恒定（WCB f=0.1）。
//   推翻"大气阈值"假说：Euu/Mimar/Sabaton 着陆低是距离短所致（LS-231a P1.98 着陆 42
//   更高直接证伪阈值）；"G 重力模型"是距离与 g/P 巧合相关的假象。
// ⚠️ 已知局限：罐模型仅对自然跃迁航线成立；网关航线（跃门）的离港/进近显著更低
//   （WCB Sabaton 进近 117/Mimar 90 vs 模型 171.5），结构不同待研究。
// 跨星系（有跃迁）航线：stlFuel = 0.49×罐×min(f, f_cap) + 0.49×罐×f + 进近差 + 着陆 + 起飞。
// 空间站无大气：到站无着陆、出发无起飞（起降段相互独立，R 缺失只影响自身段）。
// 同星系航线仍用 C_F×f×d（转移段占比大，已校准）。
const STL_TANK_FUEL_COEF = 0.49; // 每段（离港/进近）= 0.49×罐×f
const STL_DEPARTURE_F_SAT_COEF = 10.96; // 离港 f 饱和系数：f_cap = 系数×流量（OOG LCB 0.0075→0.0822 实测）
const STL_APPROACH_EXTRA = 8; // 进近差近似（新手船 3.5-6.5、WCB 5.5-7.5、HCB 10-14 取中上，偏重船更安全）
const STL_LANDING_DIST_C = 0.47; // 着陆燃料系数：fuel = C×√(R_km × P^-0.2)（WCB 实测 7 点 ±0.7u）
const STL_LANDING_P_EXP = 0.2; // 气压缩短着陆段指数（着陆距离 = 0.66×R×P^-0.2）
const STL_TAKEOFF_FUEL_C = 0.455; // 起飞燃料系数：fuel = C×√(R_km × P^+0.2)（3 点 ±3%）
const STL_TAKEOFF_P_EXP = 0.2; // 大气延长起飞段指数（起飞距离 = 0.62×R×P^0.2，厚大气冲出更长）
const STL_LANDING_G_REF = 8; // 船体系数基准 G（新手船/WCB）
const STL_LANDING_G_EXP = 0.6; // 回退 G 指数（无流量数据时：HCB 1.456≈(15/8)^0.6）
const STL_LANDING_G_EXP_SOFT = 1 / 6; // 弱 G 修正指数（有流量时，配合流量主导）
const STL_LANDING_FLOW_REF = 0.015; // 着陆燃料流量基准（WCB 标准引擎 u/s）

// 着陆船体系数（2026-08-27 OOG LCB 实测修正）：
// - 主因子 = stlFuelFlowRate / 0.015（流量主导）：OOG LCB 省油引擎 0.0075 → 0.5，
//   Euu 着陆实测 16 vs WCB(G8/标准引擎) 30 —— 同行星同 f=0.1 同距离，仅流量差 2 倍。
//   纯 G 模型对省油船失效（G=10 预测 35 实测 16，方向反了：G 更高燃料反而更少）。
// - 辅因子 = (G/8)^(1/6)（弱 G 修正）：把纯流量模型对 HCB(G15) 的 8% 低估补回
//   （HCB 1.333→1.481 ≈ 旧 G 标定 1.456；WCB/新手船 G=8 无影响）。
// - 无流量数据回退旧 G 模型；流量优先用飞船数据（Ship.stlFuelFlowRate），
//   缺失时回退引擎表流量（stlFlowRateFor）。
export function stlLandingFactor(ship: ShipPerformance): number {
  const g = ship.maxGFactor;
  const flow = stlFlowRateFor(ship);
  if (flow !== undefined && flow > 0) {
    const gSoft =
      g !== undefined && g > 0 ? Math.pow(g / STL_LANDING_G_REF, STL_LANDING_G_EXP_SOFT) : 1;
    return (flow / STL_LANDING_FLOW_REF) * gSoft;
  }
  if (g !== undefined && g > 0) {
    return Math.pow(g / STL_LANDING_G_REF, STL_LANDING_G_EXP);
  }
  return 1;
}

// 离港燃料的 f 饱和上限（省油引擎实测：OOG LCB 离港 87@0.05 / 141@f≥0.1 饱和，
// f_cap = 0.49×罐 到 141 的拐点 ≈ 10.96×流量）。标准/超推力引擎 f_cap≈0.16-0.22，
// 常规滑块（≤0.1）不触发；无流量数据不饱和。
export function stlDepartureFSat(ship: ShipPerformance): number {
  const flow = stlFlowRateFor(ship);
  if (flow !== undefined && flow > 0) {
    return Math.max(0.05, STL_DEPARTURE_F_SAT_COEF * flow);
  }
  return 1;
}

// STL 燃料流量（u/s）：飞船数据优先（Ship.stlFuelFlowRate），缺失时按 STL 引擎类型
// 回退引擎表流量（省油 0.0075 / 标准 0.015 / glass 0.015 / advanced·超推力 0.02）。
function stlFlowRateFor(ship: ShipPerformance): number | undefined {
  if (ship.stlFuelFlowRate !== undefined && ship.stlFuelFlowRate > 0) {
    return ship.stlFuelFlowRate;
  }
  return stlEngineParams(ship.stlEngineOption).flow;
}

export interface ModelSettings {
  // 可校准系数（默认标定值）。
  stlTimeC?: number;
  stlFuelC?: number;
  ftlFuelC?: number;
  // 目的地行星半径（km；空间站/未知→undefined → 无着陆段）。
  landingRadius?: number;
  // 目的地行星气压（大气缩短着陆段；P^-0.2，缺省按 1）。
  landingPressure?: number;
  // 出发行星半径（km；空间站/未知→undefined → 无起飞段）。
  departureRadius?: number;
  // 出发行星气压（大气延长起飞段；P^+0.2，缺省按 1）。
  departurePressure?: number;
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

  // STL 时间（小时）：跨星系离港/进近分别用段速度（统一段模型：进近 0.52×巡航、
  // 离港按巡航未饱和程度 0.28~0.42×巡航）；v(f) = min(V_BASE×f^K, V_SAT) 查引擎表。
  const d = metrics.stlDistanceKm;
  const v = stlSpeedFor(ship, fuel);
  const vDepart = stlDepartSpeedFor(ship, fuel);
  const vApproach = stlApproachSpeedFor(ship, fuel);
  const departKm = metrics.departKm;
  const approachKm = metrics.approachKm;
  let stlHours = 0;
  if (departKm !== undefined && departKm > 0) {
    stlHours += departKm / (vDepart * 3600);
  }
  if (approachKm !== undefined && approachKm > 0) {
    stlHours += approachKm / (vApproach * 3600);
  }
  if (stlHours > 0) {
    stlHours /= cond;
  } else if (d !== undefined && d > 0) {
    stlHours = d / (v * 3600) / cond;
  }
  // STL 燃料：跨星系（有跃迁）用罐模型。
  // 着陆 = 船体系数 × 0.47 × √(半径_km × P^-0.2)（仅行星目的地，有大气减速）
  // 起飞 = 船体系数 × 0.455 × √(半径_km × P^+0.2)（仅行星出发地，有大气冲出）
  // 空间站无大气：到站无着陆、出发无起飞；两段相互独立（R 缺失只影响自身段）。
  // 同星系用 C_F×f×d（转移段，已校准）。
  const cF = settings.stlFuelC ?? stlFuelCFor(ship.stlEngineOption, 3.05e-5);
  const isCrossSystem = (metrics.natPc ?? 0) > 0 || (metrics.gwPc ?? 0) > 0;
  const tank = ship.stlFuelCapacity;
  let stlFuel: number;
  if (isCrossSystem && tank !== undefined && tank > 0) {
    const R = settings.landingRadius;
    const R0 = settings.departureRadius;
    const hasLanding = R !== undefined && R > 0;
    const hasTakeoff = R0 !== undefined && R0 > 0;
    const lf = settings.stlLandingFactor ?? stlLandingFactor(ship);
    const P =
      settings.landingPressure !== undefined && settings.landingPressure > 0
        ? settings.landingPressure
        : 1;
    const landing = hasLanding
      ? STL_LANDING_DIST_C * Math.sqrt(R * Math.pow(P, -STL_LANDING_P_EXP))
      : 0;
    const P0 =
      settings.departurePressure !== undefined && settings.departurePressure > 0
        ? settings.departurePressure
        : 1;
    const takeoff = hasTakeoff
      ? STL_TAKEOFF_FUEL_C * Math.sqrt(R0 * Math.pow(P0, STL_TAKEOFF_P_EXP))
      : 0;
    // 离港（f 饱和）+ 进近（不饱和）+ 进近差 + 着陆 + 起飞。
    const fDep = Math.min(fuel, stlDepartureFSat(ship));
    stlFuel =
      STL_TANK_FUEL_COEF * tank * fDep +
      STL_TANK_FUEL_COEF * tank * fuel +
      (settings.stlApproachExtra ?? STL_APPROACH_EXTRA) +
      lf * (landing + takeoff);
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
