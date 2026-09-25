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
// 网关 FTL：速度 3.0 pc/h 固定，燃料 0，每段 20 分钟锁定/衰变（GW_LOCK_HOURS）
//   + 6,000 ICA 网关使用费（GW_COST_PER_JUMP，见下方实测依据）。

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
  // 蓝图 STL 燃料罐容量（段燃料基准回退值）。
  stlFuelCapacity?: number;
  // 飞船当前 STL 罐余量（u，油罐 store 实测）。★2026-08-27 实测：服务器段燃料
  // Q = 0.49×当前STL余量×f（不是 0.49×罐容量×f）——罐不满时用余量，MTRA 转移油后
  // 段速度/时间/距离随之变化。缺省回退罐容量（罐满时两者一致，历史标定仍成立）。
  stlRemaining?: number;
  // 蓝图最小反应堆使用量（= 发射器功率需求/反应堆功率，HYR 超跑 0.076、STD 新手船 0.302）。
  minReactorUsage?: number;
  // 蓝图发射器充能时间（秒，基础充能；充能时间 = eT/m × r）。
  emitterChargeTime?: number;
  // 蓝图最大 G力过载因子（加速度上限 maxGFactor×9.81）。
  maxGFactor?: number;
}

// 航线距离指标（从 PlannedRoute 提取）。
export interface RouteMetrics {
  // 起降+进近的 STL 距离（km，游戏距离单位）。**首选**航线级记录（整条航线所有 STL 段
  // 之和，见 system-bodies.routeRecords）；无该记录时退回 departKm + approachKm
  // （系内「转移」结构时 = transitKm）。
  stlDistanceKm?: number;
  // 离港/进近各自的距离（km，用于按段速度分别计时）。
  departKm?: number;
  approachKm?: number;
  // 系内「转移」（TRANSIT）段的**整段**原生路程（km）：真实系内计划的结构，
  // 与 departKm/approachKm 互斥（见 route-planner.routeMetrics）。
  transitKm?: number;
  // 航线级 STL 总路程/总时长（整条航线所有 STL 段之和；首选几何来源，见
  // system-bodies.routeRecords）。诊断/展示用。
  routeKm?: number;
  routeSeconds?: number;
  // 转移段的原生耗时（秒，仅运行时记录有值）。**不参与计时**：它对应记录当时那条
  // 计划的 f/质量，跨 f/换船复用会把时长钉死、把成本最优解带偏（见 computeFuelOption 的 ⚠️）。
  transitSeconds?: number;
  // 自然跃迁总距离（pc）。
  natPc: number;
  // 网关跃迁总距离（pc）。
  gwPc: number;
  // 网关段数（每段含锁定 10s + 衰变 10s = 20s，并收 6,000 ICA 网关使用费）。
  gwCount: number;
  // 自然跃迁跳数（**跳数**，不是充能次数 —— 充能 = 为下一跳充电，次数 = 跳数 − 1）。
  natJumpCount?: number;
  // 目的地实体 naturalId（跨星系时用于 FIO 行星重力查询，精确着陆燃料）。
  toBody?: string;
  // 出发地实体 naturalId（诊断/缺失项提示用）。
  fromBody?: string;
  // 起点/终点文本本身是否就是星系 id（而非天体/空间站）：SFC 会把空间站目的地
  // 规范化成所属星系 id（ANT → ZV-307），此时原生段记录的键命不中 —— 只用于
  // missingModelInputs 的成因文案（见 route-planner.routeMetrics）。
  fromIsSystem?: boolean;
  toIsSystem?: boolean;
  // 成因② 诊断：起终点里是星系 id 的分量，其「反查为空间站 id」的结果
  // （route-planner.stlRecordKeyFor → route-model.lookupStationInSystem）。
  // station 有值 = 已按反查后的键查表；undefined = 候选 0 个/多于 1 个，拒绝反查
  // （查表必然命不中）。仅用于缺失项文案，不参与任何物理计算。
  stationReverse?: RouteStationReverse[];
}

// 成因② 的星系 id → 空间站 id 反查结果（见 route-model.lookupStationInSystem）。
export interface RouteStationReverse {
  // 原始星系 id（如 ZV-307）。
  systemId: string;
  // 唯一反查到的空间站 id（如 ANT）；不唯一/无候选时为 undefined。
  station?: string;
  // 候选空间站（诊断：不唯一时列出）。
  candidates: string[];
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
  // 该方案相对飞船当前剩余 STL/FTL 燃料的缺口（u；≤0 表示足够）。
  // 由 scanFuelOptions 在扫描时附加（不参与成本排序）。
  stlShortage: number;
  ftlShortage: number;
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
  {
    vBase: number;
    k: number;
    vSat: number;
    fuelC: number;
    flow: number;
    loadExp: number;
    landingLoadCoef: number;
  }
> = {
  STL_ENGINE_HYPERTHRUST: {
    vBase: 418187,
    k: 0.756,
    vSat: 90800,
    fuelC: 2.81e-5,
    flow: 0.03,
    loadExp: 0.5,
    landingLoadCoef: 2.2e-4,
  }, // HCB 实测
  // fuelSaving（2026-08-27 OOG LCB 实测修正）：旧借值 167000/0.885/74500（v0.1≈21.8k）
  // 严重低估——OOG 实测离港/进近按统一段模型反推巡航 v0.1≈65k、饱和 ~69.8k。
  STL_ENGINE_FUEL_SAVING: {
    vBase: 246530,
    k: 0.578,
    vSat: 69754,
    fuelC: 5.2e-6,
    flow: 0.0075,
    loadExp: 0.87,
    landingLoadCoef: 2.7e-4,
  }, // OOG LCB 实测
  STL_ENGINE_STANDARD: {
    vBase: 216000,
    k: 0.465,
    vSat: 75200,
    fuelC: 2.85e-5,
    flow: 0.015,
    loadExp: 0.6,
    landingLoadCoef: 2.2e-4,
  }, // BP-OHMI 实测（≈advanced）
  STL_ENGINE_ADVANCED: {
    vBase: 216000,
    k: 0.465,
    vSat: 75200,
    fuelC: 2.85e-5,
    flow: 0.02,
    loadExp: 0.6,
    landingLoadCoef: 2.2e-4,
  }, // BP-OHMI(AEN) 实测
  STL_ENGINE_GLASS: {
    vBase: 357000,
    k: 0.648,
    vSat: 74500,
    fuelC: 2.84e-5,
    flow: 0.015,
    loadExp: 0.6,
    landingLoadCoef: 2.2e-4,
  }, // BP-OHMI(玻璃) 实测
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
// 网关跃迁速度（pc/h）、每段锁定+衰变时长（h）、每段网关使用费（ICA）。
// 三者被 route-planner（路径权重）与 computeFuelOption（时长/成本）分别消费，故在这里
// 定义**唯一一份**再导出（本文件无任何 import，作常数宿主不会形成循环依赖）。
export const GW_PC_PER_H = 3.0;
// 网关跃迁段的锁定 + 衰变：服务器实测**各 10 分钟**（CDP 驱动游戏 BTF「蓝图试航模拟」
// 直采 ZV-194h → HRT，两组参数 f≈0.03/载重0 与 f≈0.05/载重3000t 完全一致；段名在 BTF 里
// 显示为「对锁」/「场衰」，对应 LOCK/DECAY）→ 合计 **20 分钟/网关段**，且与 f、载重无关。
// ⚠️ 2026-09-24 曾据「用户 SFC 截图读到 10 秒」误改为 20/3600，已按服务器实测回滚。
export const GW_LOCK_HOURS = 20 / 60;
// 网关使用费：实测 **6,000 ICA/段**（同一份原生计划：网关跃迁前的「锁定」段费用列
// 6,000 ICA；全航线 12,000 ICA / 2 段）。旧实现硬编码 gatewayCost = 0 → totalCost 漏掉
// 这笔支出；它不随 f 变化，故不影响最优 f（只是总额偏低）。
export const GW_COST_PER_JUMP = 6000;
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
// 整条曲线查引擎表（引擎类型决定，非每船校准）；G力/质量不影响（见 loadExp 载重修正）。
// 实测：hyperthrust f≥0.2 饱和 90800；advanced f≈0.45 饱和 74500；glass f≈0.1 饱和 74500。
export function stlSpeedFor(ship: ShipPerformance, fuel: number): number {
  const p = stlEngineParams(ship.stlEngineOption);
  const f = Math.max(0.001, fuel);
  return Math.min(p.vBase * Math.pow(f, p.k), p.vSat) * stlLoadFactor(ship);
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
// ---- 载重修正（2026-08-29 BTF 载重扫描重构，替代旧推力受限模型）----
// 旧「推力受限」模型只在加速度 < G×9.81 时减速，且 G 受限船完全不减速。
// 但 BTF 载重扫描（BP-OHMI standard G8，HRT→VH-331g / VH-192c）显示：
//   - G 受限区（600/1200t，a 恒 78.5）转移速度已降 19%/38% → 载重直接影响段速度，不只是推力受限；
//   - 节油引擎（OOG LCB 同款）载重指数 ≈0.87（四档几乎恒定），标准引擎 ≈0.6、超推力(HCB) ≈0.5。
// 统一改为按质量比的平滑模型（引擎表 loadExp 标定）：
//   v_load = v0 × (m0/m)^loadExp，m0=整备质量、m=当前质量（含载重+燃料）。
//   空载（m=m0）因子=1，不影响既有空载标定；载重使转移/离港/进近段速度整体下降。
//   实测对照（f=0.05）：fuelSaving 600/1200/1800/2400t 误差 ≤5%；标准引擎 1200t +5%、2400t +17%。
function stlLoadFactor(ship: ShipPerformance): number {
  const m = ship.mass;
  const m0 = ship.operatingEmptyMass;
  if (m === undefined || m0 === undefined || m0 <= 0 || m <= m0) {
    return 1;
  }
  const loadExp = stlEngineParams(ship.stlEngineOption).loadExp;
  return Math.pow(m0 / m, loadExp);
}
function stlSegmentSpeedFor(
  ship: ShipPerformance,
  fuel: number,
  curve: StlSegmentCurve,
  approach: boolean,
): number {
  // 段燃料基准：★2026-08-27 实测用「当前 STL 罐余量」而非罐容量
  // （MTRA 把 STL 从 3500 降到 100，段速度/时间随余量显著变化，Q=0.49×余量×f）。
  // 缺余量数据时回退罐容量（罐满时两者一致）。
  const tank = ship.stlRemaining ?? ship.stlFuelCapacity;
  if (tank === undefined || tank <= 0) {
    return curve.vSat * stlLoadFactor(ship);
  }
  const q = approach
    ? STL_TANK_FUEL_COEF * tank * fuel + STL_APPROACH_EXTRA
    : STL_TANK_FUEL_COEF * tank * fuel;
  let vSat = curve.vSat;
  const g = ship.maxGFactor;
  if (g !== undefined && g > 0) {
    vSat *= Math.pow(g / STL_SEGMENT_G_REF, STL_SEGMENT_G_EXP);
  }
  const v = vSat * (1 - Math.exp(-Math.pow(q / curve.q0, curve.k)));
  return v * stlLoadFactor(ship);
}

function stlSegmentCurveFor(ship: ShipPerformance): {
  depart: StlSegmentCurve;
  approach: StlSegmentCurve;
} {
  const p = STL_SEGMENT_CURVES[ship.stlEngineOption ?? ''];
  return p ?? DEFAULT_STL_SEGMENT_CURVE;
}

// 离港段速度（km/s @ f）：由段燃料 Q=0.49×STL余量×f 驱动
// （余量 = 当前 STL 罐余量，缺省回退罐容量）。
export function stlDepartSpeedFor(ship: ShipPerformance, fuel: number): number {
  return stlSegmentSpeedFor(ship, fuel, stlSegmentCurveFor(ship).depart, false);
}

// 进近段速度（km/s @ f）：由段燃料 Q=0.49×STL余量×f+8 驱动。
export function stlApproachSpeedFor(ship: ShipPerformance, fuel: number): number {
  return stlSegmentSpeedFor(ship, fuel, stlSegmentCurveFor(ship).approach, true);
}

// 系内「转移」（TRANSIT）段平均速度（km/s @ f）：引擎表 × f 曲线 × 质量曲线
// （标定块见 STL_TRANSIT_F_SAT 上方）。空载（m = 整备质量）时质量因子 = 1；
// f ≥ 0.5 饱和（与燃料同拐点）。引擎未标定时回退标准引擎参数。
// ⚠️ 2026-09-25：`computeFuelOption()` **不再走本函数**（改用 BTF 实测参考速度 + 质量幂律，
// 见 STL_INTRA_TRANSIT_SPEED_KM_S 上方）—— 本函数只在 500M km 量级被证伪（高估 ~2×）而
// 降级为诊断用：保留它是因为它承载「引擎 f 曲线」这条**尚未被参考速度口径覆盖**的信息
// （advanced/glass/hyperthrust 的转移段形状未实测），删掉会连带给 STL_TRANSIT_SPEED /
// DEFAULT_STL_TRANSIT_SPEED / STL_TRANSIT_MASS_EXP 三个常量找新家。
export function stlTransitSpeedFor(ship: ShipPerformance, fuel: number): number {
  const p = STL_TRANSIT_SPEED[ship.stlEngineOption ?? ''] ?? DEFAULT_STL_TRANSIT_SPEED;
  const f = Math.min(Math.max(fuel, 0.01), STL_TRANSIT_F_SAT);
  const m = ship.mass;
  const m0 = ship.operatingEmptyMass;
  const massFactor =
    m0 !== undefined && m0 > 0 && m !== undefined && m > 0
      ? Math.pow(m0 / m, STL_TRANSIT_MASS_EXP)
      : 1;
  return p.vSat * Math.pow(f / STL_TRANSIT_F_SAT, p.fExp) * massFactor;
}

// 系内「转移」段燃料（u）：罐口径 2×0.49×罐×min(f,0.5)（**与距离无关**，见标定块）。
export function stlTransitFuel(tank: number, fuel: number): number {
  return STL_TRANSIT_FUEL_GROSS * tank * Math.min(fuel, STL_TRANSIT_F_SAT);
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
// 同星系（系内）航线：燃料与时长各用一条**独立标定式**（见下方「系内转移段标定」）。
const STL_TANK_FUEL_COEF = 0.49; // 每段（离港/进近/转移单程）= 0.49×罐×f

// ---- 系内「转移」（TRANSIT）段标定（2026-09-23）----
// 数据：data/ftc-calibration/btf-load-sweep-2026-08-29.md（BP-OHMI-3472：标准/节油引擎、
// STL 罐满 1500、FTL 2000、状况 100%）：§1 载重扫描 7 点 + §2/§3 f 扫描 12 点 + §8 节油 6 点。
//
// 【燃料】F = 2 × 0.49 × 罐 × min(f, 0.5) —— 28 点最大误差 3.3%（§2 逐点 ≤0.7%）：
//   · **与距离无关**：§2 同一航线距离只漂移 0.35%（520.38M→522.22M km），燃料却随 f 变
//     9.9×；若 ∝ f×d，f=0.05 的实测 74u 要求系数 2.84e-6 km⁻¹（= 代码里 C_F 2.85e-5 的
//     1/10），而同一个 C_F 在该段上给 742u（**高 10.0×**）⇒ `C_F×f×d` 口径被证伪。
//   · **与载重无关**：§2 vs §3（同 f、载重 0 vs 3000t、同航线）最大差 2.2%；§1 载重
//     0→3000t 也只 74→76u（+2.7%，在取整噪声内）。
//   · **f 饱和点 0.5 与引擎无关**：§2（标准）与 §8（节油）在 f=1.0 处燃料与时长都与
//     f=0.5 逐位相同（731/731、740/740）⇒ 服务器把转移段的 f 夹到 0.5。
//   · 罐基准 = `stlRemaining ?? stlFuelCapacity`（与跨星系段同一基准；BTF 罐满 → 两者一致；
//     罐不满时的差异**未实测**）。2×0.49 的口径解释：转移段 = 两段 0.49×罐×f
//     （§5 单段「离港」实测 37u = 0.49×1500×0.05 ✓）。
//
// 【时长】v = V_SAT(引擎) × (min(f,0.5)/0.5)^k(引擎) × (整备质量/当前质量)^0.75：
//   · f 曲线（§2，标准引擎）：v(0.05)=11,580 → v(≥0.5)=87,036 km/s（k=0.84，12 点最大
//     误差 8.8%）；f≥0.5 饱和（与燃料同拐点）。旧「巡航速度」模型在此段形状全错
//     （只有 1.4× f 跨度、f≈0.2 就饱和，实测是 7.5× 跨度到 f=0.5）。
//   · 质量曲线（§1，f=0.05）：整备 1199t → 4199t 速度 11,577→4,351 km/s（逐点反推指数
//     0.51~0.78；取 0.75 时最大误差 9.4%；§3 交叉检验 ≤7.8%）。
//   · 节油引擎（§8）f 曲线更平缓（k=0.59、饱和 97,794 km/s）⇒ 引擎参数分表；
//     **未实测引擎**（advanced/glass/hyperthrust）回退标准引擎参数（已知局限：形状可信、
//     量级未标定）。
//   · t = d / (v × 3600) / 状况；距离按 1:1 线性（**未实测**：数据只有一个距离族，
//     仅能靠用户原生样本跨距离（101.66M vs 520M km）交叉校验）。
//   · 刻意**不用** metrics.transitSeconds：那是记录当时那条计划的 f/质量下的原生时长，
//     按当前 f 复用会把时长钉死（成本最优解会一路选最低 f），比估算更糟。
//
// ⚠️ 与用户原生样本的交叉验证（ZV-307a → ZV-307/Antares Station：101,655,808 km /
//   2,639 s / 2,655 u，船 AVI-06JVV 整备 1271t）：本标定式**能同时复现**这一对数字，
//   前提是该船 STL 罐 ≈ 8000（游戏大型罐）而非 FTC 面板显示的 3500：罐 8000 → f=0.339
//   → 燃料 2,655u（0.0%）、时长 2,600 s（−1.5%，质量 2300t 时）。罐 3500 下单段转移
//   燃料上限只有 0.98×3500×0.5 = 1,715u（−35.4%），且两个候选口径都要求 f > 0.5（与
//   §2/§3/§8 的 0.5 饱和互斥）⇒ 罐容量读数需用户复核（见报告）。
const STL_TRANSIT_F_SAT = 0.5; // 转移段 f 饱和点（与引擎无关：§2/§3/§8 三组 f=1.0 ≡ f=0.5）
const STL_TRANSIT_FUEL_GROSS = 2 * STL_TANK_FUEL_COEF; // 0.98 = 两段 0.49×罐×f 的口径
const STL_TRANSIT_MASS_EXP = 0.75; // 转移段时长质量指数（§1 载重扫描）
// 系内「转移」（TRANSIT）段的**参考速度**：BTF 实测 599,220,390 km / 21,780 s = 27,512 km/s，
// 该样本载重 0（质量 = 整备质量 1,271 t）。⚠️ 速度**随质量下降**，不是一个船无关常数 ——
// 用户实测（VH-192B → VH-192C，619,312,100 km / 40,781 s = 15,186 km/s，质量 2,727 t）
// 与 27512 × (1271/2727)^0.78 = 15,166 km/s 吻合到 0.1%。
// 来源：data/ftc-calibration/btf-scan-2026-09-24.json 组 4（VH-331g → HRT，同星系纯 TRANSIT）。
// ⚠️ 本常量**不是**船无关常数，只有配上质量幂律（下方 stlIntraTransitSpeedKmS）才完整：
// 单独拿它计时 = 重船偏快（2026-09-25 之前的 transfer-geometry.ts 就是这么错的）。
export const STL_INTRA_TRANSIT_SPEED_KM_S = 27512;
// 上述参考速度对应的**参考质量**（kg 无关，用吨即可，只参与比值）。
export const STL_INTRA_TRANSIT_SPEED_REF_MASS_T = 1271;
// 质量幂指数：由「质量比 2.145、速度比 1.812」解出 ≈0.78（与 BTF 标定式里转移段的 0.75 同源，
// 取实测 0.78 更贴合）。⚠️ 不要用段速度（离港/进近）的 `stlLoadFactor` 指数（`loadExp`
// 标准引擎 0.6）—— 那是**段速度**口径，与转移段不是同一个指数。
export const STL_INTRA_TRANSIT_MASS_EXP = 0.78;

// 系内「转移」（TRANSIT）段速度：参考速度 × (参考质量 / 当前质量)^0.78。
// 单一来源：fuel-model 与 transfer-geometry 都用它，禁止在调用点各自展开公式。
export function stlIntraTransitSpeedKmS(massT: number): number {
  return (
    STL_INTRA_TRANSIT_SPEED_KM_S *
    Math.pow(STL_INTRA_TRANSIT_SPEED_REF_MASS_T / Math.max(1, massT), STL_INTRA_TRANSIT_MASS_EXP)
  );
}

const STL_TRANSIT_SPEED: Record<string, { vSat: number; fExp: number }> = {
  // 标准引擎（§1~§4 最全）：载重 0 / 整备 1199t / f≥0.5 的实测平均速度（km/s）。
  STL_ENGINE_STANDARD: { vSat: 87036, fExp: 0.84 },
  // 节油引擎（§8，同航线同质量）：饱和更快（k 更小）。
  STL_ENGINE_FUEL_SAVING: { vSat: 97794, fExp: 0.59 },
};
const DEFAULT_STL_TRANSIT_SPEED = STL_TRANSIT_SPEED.STL_ENGINE_STANDARD;
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
// 着陆/起飞燃料载重系数（2026-08-29 BTF 载重扫描，按引擎在 STL_ENGINE_SPEED.landingLoadCoef 标定）：
//   landing_fuel = base × (1 + landingLoadCoef × 载重吨)
//   标准引擎 2.2e-4 两行星（VH-331g 40→66u / VH-192c 27→41u）均吻合（误差<1u）；
//   节油引擎 2.7e-4（VH-192c 14→23u 10 点、VH-331g 21→35u 收敛值；低载重略高）。
//   着陆/起飞段燃料均随载重增加、与 f 无关。
// ⚠️ 载重 = mass − operatingEmptyMass 含燃料重量（BTF 无燃料故等于纯载重；实船略高估，可接受）。
const STL_LANDING_LOAD_COEF = 2.2e-4; // 默认值（超推力/未识别引擎回退）

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

  // STL 时间（小时）= 离港段（离港段速度）+ 进近段（进近段速度）+ **其余**（转移段速度）。
  // 三段按航线的**总路程** d 分配（离港/进近段速度见 stlDepartSpeedFor / stlApproachSpeedFor；
  // 转移段速度见下方 transitSpeed，统一段模型）。
  const d = metrics.stlDistanceKm;
  const vDepart = stlDepartSpeedFor(ship, fuel);
  const vApproach = stlApproachSpeedFor(ship, fuel);
  const departKm = metrics.departKm;
  const approachKm = metrics.approachKm;
  // 「其余」必须显式算：混合航线（自然跃迁 + 网关跃迁）的 STL 段远多于「离港 + 进近」——
  // 实测 AVI-06JVV 的 zv-194h → HRT（勾网关）16 段原生计划里有 6 个 STL 段（起飞/离港/
  // 进近/3 个转移），而末跳是网关段时进近记录还查不到（getApproach 的键是「末跳起点
  // 星系|目标天体」）⇒ 旧实现只累加 departKm + approachKm，把进近 1h29m 与末尾到站
  // TRANSIT 3h59m 静默丢掉，总时长比服务器短约 4 小时（2026-09-24 用户实测）。
  // d 是**航线级**总路程（Σ 所有 STL 段，见 system-bodies.routeRecords），故按 d 分配余量。
  // 等价性：系内航线 depart/approach 都缺 → rest = d，与旧「系内」分支逐位相同；
  // 纯自然跨星系 depart + approach === d → rest = 0，同样逐位不变。
  // d 缺失（残缺输入，会被 missingModelInputs 拦下、不写滑块）时退回已知段之和，
  // 免得把已知的离港/进近静默记成 0。
  const totalKm = d ?? (departKm ?? 0) + (approachKm ?? 0);
  let stlHours = 0;
  if (totalKm > 0) {
    const depKm = Math.min(Math.max(0, departKm ?? 0), totalKm);
    const appKm = Math.min(Math.max(0, approachKm ?? 0), totalKm - depKm);
    const restKm = Math.max(0, totalKm - depKm - appKm);
    // 「其余」用**BTF 实测参考速度 + 质量幂律**（见 STL_INTRA_TRANSIT_SPEED_KM_S 上方标定块）：
    //   transitSpeed = 27512 × (参考质量 1271t / 当前质量)^0.78
    //   t = restKm / (transitSpeed × 3600) / 状况
    // **为什么必须带质量项**：2026-09-24 那版把 27,512 km/s 当「船无关常数」，用户实测立刻
    // 证伪（2,727t 船 15,186 km/s，慢 1.81× = 质量比 2.145 的 0.78 次方）—— 参考样本是载重 0
    // 的 1,271t 船，重船按幂律减速（与离港/进近段的 stlLoadFactor 同族，但指数不同）。
    // 刻意**不用** metrics.transitSeconds：那是记录当时那条计划的 f/质量下的原生时长，按
    // 当前 f 复用会把时长钉死（成本最优解会一路选最低 f）；改用「参考速度 + 质量幂律」保留了
    // 质量这条真实物理依赖，又不绑定单条记录的时刻。
    // 公式只此一份（stlIntraTransitSpeedKmS）：2026-09-25 的教训就是两处各自展开、
    // 只补了一处（transfer-geometry 漏质量项，重船时长偏快 1.5×）。
    const transitSpeed = stlIntraTransitSpeedKmS(ship.mass);
    stlHours =
      (depKm / (vDepart * 3600) + appKm / (vApproach * 3600) + restKm / (transitSpeed * 3600)) /
      cond;
  }
  // STL 燃料：跨星系（有跃迁）用罐模型。
  // 着陆 = 船体系数 × 0.47 × √(半径_km × P^-0.2)（仅行星目的地，有大气减速）
  // 起飞 = 船体系数 × 0.455 × √(半径_km × P^+0.2)（仅行星出发地，有大气冲出）
  // 空间站无大气：到站无着陆、出发无起飞；两段相互独立（R 缺失只影响自身段）。
  // 系内「转移」段 = 罐口径 2×0.49×罐×min(f,0.5)（**与距离无关**；标定块见 STL_TRANSIT_F_SAT）。
  // ★2026-08-27 实测：段燃料基准用「当前 STL 罐余量」而非罐容量
  // （Q = 0.49×余量×f；余量少 → Q 小 → 段燃料少且段速度慢）。缺余量回退罐容量。
  const cF = settings.stlFuelC ?? stlFuelCFor(ship.stlEngineOption, 3.05e-5);
  const isCrossSystem = (metrics.natPc ?? 0) > 0 || (metrics.gwPc ?? 0) > 0;
  const tank = ship.stlRemaining ?? ship.stlFuelCapacity;
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
    // 着陆/起飞载重项：base × (1 + 系数×载重)。系数按引擎（节油引擎载重敏感性更高）。
    // 载重 = 当前质量 − 整备质量。
    const load = Math.max(0, ship.mass - (ship.operatingEmptyMass ?? ship.mass));
    const landingLoadCoef =
      stlEngineParams(ship.stlEngineOption).landingLoadCoef ?? STL_LANDING_LOAD_COEF;
    stlFuel =
      STL_TANK_FUEL_COEF * tank * fDep +
      STL_TANK_FUEL_COEF * tank * fuel +
      (settings.stlApproachExtra ?? STL_APPROACH_EXTRA) +
      lf * (landing + takeoff) * (1 + landingLoadCoef * load);
  } else if (!isCrossSystem && tank !== undefined && tank > 0) {
    // 系内「转移」段（2026-09-23 标定）：F = 2×0.49×罐×min(f,0.5)，与距离/载重无关。
    stlFuel = stlTransitFuel(tank, fuel);
  } else {
    // 退化路径（罐容量/余量缺失，或跨星系缺罐）：只能用已证伪的 C_F×f×d 兜底，
    // 会被 missingModelInputs 判缺 → **不写入滑块**（宁可不动，也不写不准的值）。
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
  // 充能 = 为**下一跳**充电 → 次数 = 跳数 − 1（末跳后直接进近，无充能段）。旧值用
  // natJumpCount（= 跳数）多算一次充能，与 buildEstimatedSegmentRows 的「只在
  // i < legs.length - 1 加充能」口径不一致（后者本来就是对的）。
  const chargeCount = Math.max(0, (metrics.natJumpCount ?? 0) - 1);
  const natChargeHours = (chargeCount * chargeSeconds) / 3600;
  const ftlFuelC = settings.ftlFuelC ?? ftlFuelCFor(ship);
  const ftlFuelNat = ftlFuelC * r * metrics.natPc;
  // 网关 FTL：速度固定 3.0 pc/h，燃料 0，每段 +20 分钟锁定/衰变（GW_LOCK_HOURS）。
  const gwHours =
    metrics.gwPc > 0 ? metrics.gwPc / GW_PC_PER_H + metrics.gwCount * GW_LOCK_HOURS : 0;

  const ftlHours = natJumpHours + natChargeHours + gwHours;
  const totalHours = stlHours + ftlHours;
  const fuelCost = stlFuel * prices.stlPrice + ftlFuelNat * prices.ftlPrice;
  const timeCost = totalHours * prices.timeValue;
  // 网关使用费：6,000 ICA/段（GW_COST_PER_JUMP）。不随 f 变 → 不影响最优 f，只影响总额。
  const gatewayCost = metrics.gwCount * GW_COST_PER_JUMP;

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
    stlShortage: 0,
    ftlShortage: 0,
  };
}

// ---- 自动档位网格（无需玩家设置）----
// 燃料滑块 f：0.05 → 1，步长 0.05。STL 速度/燃料对 f 平滑单调（速度 f^K 饱和），
// 0.05 分辨率足以刻画快↔省油权衡曲线，无需手动输入档位组合。
export function autoFuelGrid(): number[] {
  const out: number[] = [];
  for (let f = 0.05; f <= 1.00001; f += 0.05) {
    out.push(Math.round(f * 100) / 100);
  }
  return out;
}

// 反应堆使用量 r：从 minReactorUsage（游戏滑块下限，蓝图性能）→ 1，步长 0.05。
// 缺蓝图数据时从 0.05 起。
export function autoReactorGrid(ship: ShipPerformance): number[] {
  const min =
    ship.minReactorUsage !== undefined && ship.minReactorUsage > 0 ? ship.minReactorUsage : 0.05;
  const out: number[] = [min];
  const start = Math.max(min + 0.05, Math.floor(min * 20 + 1) / 20);
  for (let r = start; r <= 1.00001; r += 0.05) {
    out.push(Math.min(1, Math.round(r * 100) / 100));
  }
  const uniq: number[] = [];
  for (const v of out) {
    if (uniq.length === 0 || v > uniq[uniq.length - 1] + 1e-9) {
      uniq.push(v);
    }
  }
  if (uniq[uniq.length - 1] !== 1) {
    uniq.push(1);
  }
  return uniq;
}

// 方案燃料总量（STL + FTL）。
function totalFuelOf(o: FuelOption): number {
  return o.stlFuel + o.ftlFuel;
}

// Pareto 前沿（时间 ↦ 燃料双目标）：返回不被其它方案在时间与燃料上都严格支配的方案，
// 按时间升序（首项最快/最费油，末项最慢/最省油）。
export function paretoFrontier(options: FuelOption[]): FuelOption[] {
  return options
    .filter(
      o =>
        !options.some(
          p =>
            p !== o &&
            p.totalHours <= o.totalHours &&
            totalFuelOf(p) <= totalFuelOf(o) &&
            (p.totalHours < o.totalHours || totalFuelOf(p) < totalFuelOf(o)),
        ),
    )
    .sort((a, b) => a.totalHours - b.totalHours);
}

// 平衡点退化判定阈值：燃料（u）/ 时间（h）维度的跨度小于该值即视为「无差异」。
// 1e-9 是浮点噪声量级——正常航线燃料跨度数百 u、时间跨度数十分钟，远超阈值，
// 因此非退化航线的选优结果不受影响（只用于识别恒等/全并列的退化输入）。
const BALANCE_TIE_EPS = 1e-9;

// 最省油方案：燃料总量最小；并列时取反应堆使用量最小；再并列取燃料滑块最小。
// 退化情形（燃料或时间在所有候选方案中无差异）的兜底——此时「折衷」无意义，
// 只能退到最省油端，绝不能退到最快端（f = 1 拉满）。
function cheapestFuelOption(options: FuelOption[]): FuelOption | undefined {
  let best: FuelOption | undefined;
  for (const o of options) {
    if (best === undefined) {
      best = o;
      continue;
    }
    const fuelDelta = totalFuelOf(o) - totalFuelOf(best);
    if (fuelDelta < -BALANCE_TIE_EPS) {
      best = o;
      continue;
    }
    if (fuelDelta > BALANCE_TIE_EPS) {
      continue;
    }
    const reactorDelta = o.reactor - best.reactor;
    if (reactorDelta < -BALANCE_TIE_EPS) {
      best = o;
      continue;
    }
    if (reactorDelta > BALANCE_TIE_EPS) {
      continue;
    }
    if (o.fuel < best.fuel) {
      best = o;
    }
  }
  return best;
}

// 平衡点：Pareto 前沿的拐点（knee）。
// 把「最快方案」（时间最短、燃料最多）与「最省油方案」（燃料最少、时间最长）连成一条线，
// 前沿上离这条线最远的点就是折衷平衡点——用尽量少的额外燃料换取尽量多的时间节省，
// 两端都不极端。未设置时间价值时的默认最优。
//
// ⚠️ 退化保护（2026-09-23 修复）：拐点算法要求两个方向都有真实差异。
// 若燃料在所有候选方案中恒等，归一化后每个点的 y 都是 0，|x + y - 1| 退化成 |x - 1|，
// 最大值恒落在 x = 0 的「最快方案」（f = 1 拉满）；更糟的是此时最快方案在 Pareto
// 过滤中支配其余全部方案，前沿只剩它自己（pareto.length === 1 → 直接返回）——
// 两条路径都返回 f = 1。用户实测「同星系飞空间站（ZV-307a → ZV-307）时燃料消耗
// 被自动写成 1」即此：进近段缺失 → stlDistanceKm undefined → 同星系分支 stlFuel
// 恒为 0（无燃料梯度）而段速度仍给出时间梯度。
// 因此：燃料或时间任一维度无差异时绝不返回最快方案，而是返回最省油方案。
// 反过来**不允许**用「极小 span 归一化」（旧代码的 Math.max(1e-9, span)）把无意义的
// 浮点噪声放大成满量程——那正是本 bug 的放大机制。
export function findBalanceOption(options: FuelOption[]): FuelOption | undefined {
  const pareto = paretoFrontier(options);
  if (pareto.length === 0) {
    return undefined;
  }
  const cheapest = cheapestFuelOption(options);
  // 退化判定用「全部候选方案」的跨度（比只看前沿更严格）：全域无差异 ⟹ 前沿也无差异。
  const allFuels = options.map(totalFuelOf);
  const fuelSpan = Math.max(...allFuels) - Math.min(...allFuels);
  const allHours = options.map(o => o.totalHours);
  const timeSpan = Math.max(...allHours) - Math.min(...allHours);
  // 燃料无差异：全无梯度（含 NaN 传播）→ 退到最省油端。
  if (!(fuelSpan > BALANCE_TIE_EPS)) {
    return cheapest ?? pareto[0];
  }
  // 时间无差异：同样无法做折衷（旧代码靠归一化恰好落到最省油端，但依赖并列顺序）。
  if (!(timeSpan > BALANCE_TIE_EPS)) {
    return cheapest ?? pareto[0];
  }
  if (pareto.length === 1) {
    return pareto[0];
  }
  const fastest = pareto[0];
  const slowest = pareto[pareto.length - 1];
  // 归一化基准保持修复前的「前沿」口径（tSpan/fSpan 均 > 阈值，不做任何放大）
  // ——非退化情形的选优结果与修复前逐位一致。
  const tSpan = slowest.totalHours - fastest.totalHours;
  const paretoFuels = pareto.map(totalFuelOf);
  const fMin = Math.min(...paretoFuels);
  const fSpan = Math.max(...paretoFuels) - fMin;
  // 归一化后：最快点 (0,1)、最省油点 (1,0)，连线 x+y=1；拐点 = 距连线最远的点。
  let best = fastest;
  let bestDist = -1;
  for (const o of pareto) {
    const x = (o.totalHours - fastest.totalHours) / tSpan;
    const y = (totalFuelOf(o) - fMin) / fSpan;
    const dist = Math.abs(x + y - 1);
    if (dist > bestDist) {
      bestDist = dist;
      best = o;
    }
  }
  return best;
}

/** 邻档对比的默认半径（档 = autoFuelGrid 的步长 0.05，即前后各 5 档 = 最优 ±0.25）。 */
export const NEARBY_FUEL_SPAN = 5;

// 邻档对比：以最优方案为中心，取**同一反应堆使用量**下燃料滑块前后各 span 档的方案。
// 复用 scanFuelOptions 已算出的全部组合，不重算。
//
// 反应堆**固定为最优值**（2026-09-24 用户拍板）：玩家要评估的是「只动燃料滑块」的代价，
// 若每档各取自身最优反应堆，相邻两行的差异就混入了反应堆变量，无法归因。
// 越界侧按实际可用档截断（最优落在网格端点或靠近端点时，一侧不足 span 档）。
export function nearbyFuelOptions(
  options: FuelOption[],
  best: FuelOption,
  span = NEARBY_FUEL_SPAN,
): FuelOption[] {
  const eps = 1e-9;
  const sameReactor = options
    .filter(o => Math.abs(o.reactor - best.reactor) < eps)
    .sort((a, b) => a.fuel - b.fuel);
  const idx = sameReactor.findIndex(o => Math.abs(o.fuel - best.fuel) < eps);
  if (idx < 0) {
    return [];
  }
  return sameReactor.slice(Math.max(0, idx - span), idx + span + 1);
}

// 扫描滑块组合，按综合成本（燃料费+时间价值）升序返回。
// 飞船当前剩余 STL/FTL 燃料（remaining）若传入，会给每条方案附加
// stlShortage/ftlShortage 缺口字段（max(0, 需油 - 剩余)）。
// 缺省 remaining 不传 → 缺口字段为 0，FTC 面板不再展示缺口警告。
export function scanFuelOptions(
  ship: ShipPerformance,
  metrics: RouteMetrics,
  fuels: number[],
  reactors: number[],
  prices: { stlPrice: number; ftlPrice: number; timeValue: number },
  settings: ModelSettings = {},
  remaining?: { stlRemaining: number; ftlRemaining: number },
): FuelOption[] {
  const plans: FuelOption[] = [];
  for (const fuel of fuels) {
    for (const reactor of reactors) {
      const opt = computeFuelOption(ship, metrics, fuel, reactor, prices, settings);
      if (remaining) {
        opt.stlShortage = Math.max(0, opt.stlFuel - remaining.stlRemaining);
        opt.ftlShortage = Math.max(0, opt.ftlFuel - remaining.ftlRemaining);
      }
      plans.push(opt);
    }
  }
  return plans.sort((a, b) => a.totalCost - b.totalCost);
}

// 模型必需输入的完整性检查（判定「结果是否可采信 / 可写入 SFC 滑块」）。
//
// 为什么必须检查（2026-09-23 实测 bug「SFC 自动拉条 ≠ FTC 面板结果」）：
// 同星系航线的 STL 燃料只有一个来源 —— stlDistanceKm（route-planner 的
// **首选**:航线级记录 routeKm，整条航线所有 STL 段之和；**回退**: departKm + approachKm，
// 系内真实结构时 = 「转移」（TRANSIT）段的整段路程 transitKm）。
// 它**只取服务器
// 原生记录**（航线级 / 同星系按键 (出发天体, 目标天体) / 跨星系按跳键，见
// system-bodies.recordStlSegments）；查不到就是 undefined —— **无回退**（2026-09-23 用户
// 拍板「不需要回退，永远等服务器下发」：自建轨道模型 `liftOffKmAt` 与内置统计中位数常数
// `STL_EST_*` 已删除）。
// 于是（修复前反复出现的问题）：
//   FTC 面板路径（browse=true，会浏览起终点星系）→ 轨道几何完整 → f = 0.2（正确）；
//   SFC 联动路径（browse=false，设计上不许开窗）→ approachKm undefined →
//   stlDistanceKm undefined → 同星系分支 stlFuel ≡ 0（燃料无梯度、时间仍有梯度）
//   → findBalanceOption 退化 → 修复前 f = 1、修复后 f = 0.05（都不是真最优）。
// 跨星系航线缺 STL 罐容量/余量时，罐模型（0.49×罐×f 段结构）无法使用，只能
// 退回同星系的 C_F×f×d 线性式，误差方向不确定 —— 同样不可采信。
// 系内航线同样需要罐：转移段燃料就是罐口径 2×0.49×罐×min(f,0.5)（2026-09-23 标定，
// 见 STL_TRANSIT_F_SAT 上方），没有罐就没有燃料梯度 → 两条分支都要检查罐。
// ⚠️ 跨星系分支也消费 stlDistanceKm（`stlHours` 的回退项 + `fuelEstimated`）：
// 首选是**航线级**记录（`routeKm`，整条航线所有 STL 段之和，见 system-bodies.routeRecords）；
// 该记录还没到时 `stlDistanceKm` 才退回 `departKm/approachKm`（按跳键，`#gw` 后缀见
// system-bodies，**仅回退**：混合航线的 APPROACH 段在中间、destination ≠ 最终目标，
// 按首/末跳拼键必然失配）→ 两者都拿不到同样 undefined → STL 时长被静默记 0。
// 故该类检查必须放在两条分支之外。
//
// 判缺成因与提示都要求**可操作**（说清玩家能做什么）——2026-09-23 用户实机日志
// （ZV-307a → ZV-307 勾了「使用跃迁点」）显示原来只有一句
// 「等服务器下发」，玩家无从下手：
//   ⚠️ 所有成因都是**数据未到**（「等再久也没有的结构性成因」= 错误认知，已删除）：
//      跨星系航线的几何由服务器计划写入航线级记录（键带 `#gw` 后缀表示含网关跃迁），
//      系内计划是用「转移」（TRANSIT）段记录 —— 生成一次计划都能等到。
//   ① 系内飞行（同一星系）：服务器计划用的是「转移」（TRANSIT）段（实测 2026-09-23
//      用户 SFC 原生计划 ZV-307a → ZV-307/Antares Station = 单段 101,655,808 km /
//      43分59秒 / 2655 单位 STL）。`recordStlSegments` 会记这一段
//      （段名/字段已核实：`SegmentType` 含 'TRANSIT'、字段就是 `FlightSegment.stlDistance`
//      —— 与离港/进近同口径，只有这一个候选段名），故 `transitKm` 有值时几何是**原生**的，
//      且该段的燃料/时长口径已于 2026-09-23 用 BTF 受控数据标定（见 STL_TRANSIT_F_SAT
//      上方）→ 拿到记录即可算、可写滑块。还没有记录时 → 生成一次计划即可。
//      ⚠️ **该段距离不是航线常数**（2026-09-23 第四轮复核）：同一航线不同计划的原生
//      stlDistance 会不同（`recordStlSegments` 每份计划都覆盖该键）。证据：BTF 同航线同船
//      同 f 的点间漂移（`data/ftc-calibration/btf-load-sweep-2026-08-29.md` 开头写明
//      「转移/离港/进近距离随轨道运动缓慢漂移」；HRT→VH-331g 报 520,267,630 → 522,220,425）；
//      且该值**大于两体轨道半径之和**（46.81M + 440.95M = 487.8M km）⇒ 是转移路径的弧长、
//      不是两点直线距离，故随计划时刻（相位）变化。文案因此**只打印本次读到的值**，禁止与
//      历史样本/模型估算做跨样本比较（旧文案把上一轮的「101,655,808 vs 101.7053M 差 0.05%」
//      拼到新样本 88.87M 上 —— 12.6% 与 0.05% 并存 = 自相矛盾；且 101.7053M 根本不是原生值，
//      是已删除的自建轨道模型的估算行 68.0562M+33.6491M）。
//      **与是否勾选「使用跃迁点」无关**（勾选不改变系内航线的路程：`planRoutes` 对同星系
//      两种模式都返回 natural；旧文案里「取消勾选改走直飞」是错误归因）；
//   ② 目的地是星系 id（SFC 把空间站目的地规范化成所属星系）：服务器记录按实际天体/
//      空间站 id 键控 → 星系 id 直接查表永远命不中。**2026-09-23 已修**：查表前先按
//      stations.json / 游戏内站点把星系 id 反查为**唯一**空间站 id（route-model.
//      lookupStationInSystem），反查成功后这条航线就能命中记录（见
//      route-planner.stlRecordKeyFor）；反查不唯一（同星系多站 / 无站点数据）时仍拒绝
//      反查，文案改为让玩家改目的地；
//   ③ 其余（含跨星系网关跃迁）：服务器还没为这条航线下发过原生段记录
//      → 生成一次计划等算完即可（网关航线的键带 `#gw` 后缀，与自然航线分开记录）。
//      网关**不**通配回退：通配键是自然口径（飞船 → 跃迁点），用于网关会高估 35-50%
//      （见 system-bodies.getDeparture）。
// ⚠️ 文案预算（2026-09-23 第四轮，用户实机日志里一条 500 字警告每次开 SFC 都刷屏）：
//   SFC 侧一条提示 = **≤2 句 + 一句动作指引**；口径细节（两口径互斥的数字、时长偏差倍数）
//   不在这里，见 docs/feature-patterns.md 的「FTC 几何」条目与 FTC 面板的输入不完整提示。
//   同时**只列真正成立的成因**：系内已从转移段拿到几何时「星系 id 查表没命中」不成立
//   （旧文案照样拼上去 → 同一条提示里既说「几何已按转移段记录」又说「仍未命中该航线的
//   记录」，自相矛盾）。
// 返回缺失项的中文描述；空数组 = 输入完整。
export function missingModelInputs(ship: ShipPerformance, metrics: RouteMetrics): string[] {
  const missing: string[] = [];
  const isCrossSystem = (metrics.natPc ?? 0) > 0 || (metrics.gwPc ?? 0) > 0;
  const dMissing = metrics.stlDistanceKm === undefined || !(metrics.stlDistanceKm > 0);
  // 系内（同星系）：原生「转移」（TRANSIT）段的几何（`transitKm`，recordStlSegments 记录）
  // 与**口径**（燃料罐口径 + 时长转移段式，2026-09-23 标定）都已就绪 → 拿到记录即可写滑块，
  // 不再有「口径未标定」这一条判缺。
  // stlDistanceKm（首选 = 航线级记录 routeKm；回退 = departKm + approachKm，
  // 系内转移结构时 = transitKm）无条件检查，undefined 或 0 都算缺：
  // - 同星系：时长 = d / v_转移（无 d 即无时间梯度；燃料与 d 无关但是时长需要它）；
  // - 跨星系：见上（时长静默归零）。
  // ⚠️ 2026-09-23 复核：系内计划的段结构是「转移」（TRANSIT）（实测 ZV-307a →
  // ZV-307/Antares Station = 单段 101,655,808 km），**与勾选「使用跃迁点」无关**（`planRoutes` 对同星系两种模式都返回 natural）。
  // 旧文案那句「101,655,808 vs 101.7053M，差 0.05%」比的是**已删除的自建轨道模型估算行**（68.0562M + 33.6491M），跨样本比较已作废。
  // 跨星系网关航线同理**不再强制判缺**（旧写法假定「网关结构不产生按跳键」是**错误认知**：
  // 服务器计划照常写出航线级记录，含网关跃迁时键带 `#gw` 后缀，见 system-bodies）。
  // 唯一判据就是有没有拿到几何 —— 拿不到即数据未到，等服务器下发。
  if (dMissing) {
    const bodies = [metrics.fromBody, metrics.toBody].filter(b => b !== undefined);
    const where = bodies.length > 0 ? bodies.join(' / ') : '起终点';
    // 成因分开说（2026-09-23 用户实机日志：ZV-307a → ZV-307 勾了「使用跃迁点」，
    // 原来只有一句「等服务器下发」，玩家无从下手）：
    // 系内 = 数据未到（原生段是「转移」，本模型已记录该段距离、口径也已标定）；
    // 跨星系（含网关）= 数据未到（航线级记录键带 `#gw` 后缀，见 system-bodies）；
    // 星系 id = 查表键（已在 2026-09-23 反查修复）；其余 = 数据未到。
    // ★文案预算（2026-09-23 第四轮）：≤2 句 + 一句动作指引；数字**现算**，不拼历史样本
    //   （旧文案把「101,655,808 vs 101.7053M 差 0.05%」拼到新样本 88.87M 上 = 自相矛盾）。
    const causes: string[] = [];
    const actions: string[] = [];
    const inSystem = !isCrossSystem;
    if (inSystem) {
      causes.push(
        '系内飞行（同一星系）：服务器计划用「转移」（TRANSIT）段，这条航线还没有原生记录；' +
          '换「使用跃迁点」不改变系内航线的路程',
      );
      // 操作在 systemIds 段里按「反查是否被拒」二选一给出（见下）。
    }
    const systemIds = [
      metrics.fromIsSystem === true ? metrics.fromBody : undefined,
      metrics.toIsSystem === true ? metrics.toBody : undefined,
    ].filter(b => b !== undefined);
    // 反查诊断（routeMetrics 对每个「本身就是星系 id」的分量给一条）：候选恰 1 个 = 已反查
    // （键对了，缺的只是记录）；候选 ≠1 / 无站点数据 = 拒绝反查（宁可不写也不猜）。
    // ⚠️ 声明在 `systemIds` 判定**之外**：下面给「系内动作」时还要用 `refused`。
    const reverse = metrics.stationReverse ?? [];
    const refused = reverse.filter(x => x.station === undefined);
    if (systemIds.length > 0) {
      // 成因② 分两种（2026-09-23 反查上线后），必须分开说，否则给出的操作是错的：
      //   已反查到唯一空间站 → 键已经对了，缺的是「服务器还没下发这条航线的记录」→
      //     操作是生成一次计划等算完（再说「改目的地」是误导）；
      //   反查不唯一/无站点数据 → 拒绝反查（宁可不写也不猜）→ 操作才是改目的地。
      // routeMetrics 对每个「本身就是星系 id」的分量都会给出一条 stationReverse
      // （station 有无值分别对应上述两种），故这里直接按它分类。
      // ⚠️ 系内也照给这两个操作（2026-09-23 标定后）：系内记录同样按 (出发天体, 目标天体)
      // 键控，反查成功后生成一次计划就能命中。
      const reversed = reverse.filter(x => x.station !== undefined);
      if (reversed.length > 0) {
        const pairs = reversed.map(x => `${x.systemId} → ${x.station}`).join('、');
        causes.push(
          `起终点里的 ${reversed.map(x => x.systemId).join(' / ')} 是星系 id：` +
            'SFC 会把空间站目的地规范化成所属星系 id，服务器记录按实际天体/空间站 id 键控' +
            `（已按 ${pairs} 反查后查表${dMissing ? '，仍未命中该航线的记录' : ''}）`,
        );
        actions.push('在 SFC 里为该航线生成一次飞行计划并等服务器算完');
      }
      if (refused.length > 0) {
        const why = refused
          .map(x =>
            x.candidates.length === 0
              ? `${x.systemId}（无空间站数据）`
              : `${x.systemId}（候选 ${x.candidates.join('、')}）`,
          )
          .join('；');
        causes.push(
          `起终点里的 ${refused.map(x => x.systemId).join(' / ')} 是星系 id（不是具体天体）：` +
            `服务器记录按实际天体/空间站 id 键控，星系 id 命不中，而这里无法反查出唯一空间站 ` +
            `id（${why}）—— 反查不安全，宁可不写也不猜`,
        );
        // 反查被拒时这条航线**只能**靠改目的地救（生成计划也没用：查表键推不出来）。
        // 系内同样成立（2026-09-23 口径标定后，系内记录按 (出发天体, 目标天体) 键控，
        // 目标端是星系 id 且推不出唯一空间站 → 永远命不中）。
        actions.push('把目的地改成具体天体/空间站');
      }
    }
    if (inSystem && refused.length === 0) {
      // 系内的有效操作是「生成一次计划」（系内记录按 (出发天体, 目标天体) 键控，生成后该键
      // 就能命中）；反查被拒时上面已经给了改目的地，不再重复。
      // ⚠️ 2026-09-23 回归修复：这一行原来嵌在 `systemIds.length > 0` 里 → 起终点**都不是**
      // 星系 id 的系内航线（最常见形状 zv-307a → ANT）只报成因、**不给任何操作**，连
      // 「否则请手动设置燃料滑块」的兜底都没有 —— 与本文档顶部契约「给出可操作文案」矛盾。
      // 回归用例：verify-ftc-gap-guidance.mjs ⑤「系内航线（尚无同星系记录）」。
      actions.push('在 SFC 里为该航线生成一次飞行计划并等服务器算完');
    }
    if (causes.length === 0) {
      // 走到这里只可能是跨星系（系内分支必然给出成因）且没有星系 id 分量。
      causes.push('服务器尚未为该航线下发原生 STL 段记录');
      actions.push('在 SFC 里为该航线生成一次飞行计划并等服务器算完');
    }
    // 同一操作可能由多条成因给出（系内 + 星系 id 反查）→ 去重，守住文案预算。
    const uniqueActions = [...new Set(actions)];
    const tail =
      uniqueActions.length > 0 ? ` —— ${uniqueActions.join('、')}，否则请手动设置燃料滑块` : '';
    missing.push(`起终点轨道距离（${where}）：${causes.join('；')}${tail}`);
  }
  // STL 罐容量/余量：两条分支都要（跨星系 = 离港/进近的 0.49×罐×f；系内「转移」段 =
  // 2×0.49×罐×min(f,0.5)，2026-09-23 标定）—— 没有罐就没有燃料梯度。
  const tank = ship.stlRemaining ?? ship.stlFuelCapacity;
  if (tank === undefined || !(tank > 0)) {
    missing.push('STL 罐容量（飞船蓝图性能）');
  }
  return missing;
}
