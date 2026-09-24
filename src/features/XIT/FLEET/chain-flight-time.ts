// 环线各段预计飞行时间（XIT FLEET 环线）。
//
// 为环线的每一段（出发地→第1站、站→站、末站→归航）计算飞船预计飞行时间：
// - 飞行时间使用 FTC 的最优燃油计划（fuel-model 扫描 + 平衡点，与 FTC 面板一致）；
// - 每段出发时刻 = 起点时刻 + 前序各段飞行时长累计（供面板显示到达时刻与到港预测）；
// - STL 几何只取服务器原生记录、与时刻无关（见 route-planner.routeMetrics）：几何缺失的段
//   显式判缺（ok = false + missingInputs 成因全文）。⚠️ 旧注释曾写「下游基地用未来预计位置
//   预测天体位置算起降距离」——那是已删除的自建轨道模型（两轮重算几何）的行为，现已作废：
//   唯一例外是**环线预估**在系内航线缺前向记录时可用反方向原生记录近似（显式标注，
//   见 reverseTransitApproximation）。
//
// 与 FTC 面板共享同一套性能/航线/燃料模型，结果口径一致（balance 方案总时长）。
// 注意：这里只估算"飞行"时长，不包含各站的卸货/提取停留时间。

import { planRoutes, routeMetrics } from '@src/features/XIT/FTC/route-planner';
import type { PlannedRoute } from '@src/features/XIT/FTC/route-planner';
import {
  scanFuelOptions,
  autoFuelGrid,
  autoReactorGrid,
  findBalanceOption,
  missingModelInputs,
} from '@src/features/XIT/FTC/fuel-model';
import type { FuelOption, ShipPerformance } from '@src/features/XIT/FTC/fuel-model';
import {
  ensureShipBlueprint,
  fetchPlanetEnv,
  shipPerformanceFor,
} from '@src/features/XIT/FTC/ftc-compute';
import { gameNow } from '@src/infrastructure/fio/orbit';
// 系内航线的原生「转移」（TRANSIT）段记录：反向近似几何的唯一来源（见
// reverseTransitApproximation）。与 route-planner 同一个 store API —— 不新建表、不新增持久化。
import { stlSegmentsStore } from '@src/infrastructure/prun-api/data/system-bodies';

// 时长来自**近似几何**（反方向原生记录）的来源标注：面板据此告诉玩家这段时长是近似值，
// 而不是原生前向记录。
type ChainFlightApproximation = {
  kind: 'reverse-record';
  // 实际查表用的键（= 本段起终点互换；未经星系 id 反查时就是起终点原文）。
  from: string;
  to: string;
  distanceKm: number;
};

/** 环线的一个航段：从 `from` 到 `to` 的预计飞行。 */
export interface ChainFlightLeg {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  // 是否成功算出时长（无航线/无有效滑块组合/模型必需输入残缺时为 false）。
  ok: boolean;
  error?: string;
  // 输入残缺时的**成因全文**（中文，来自 fuel-model.missingModelInputs），供面板 title 展示。
  // 此时 ok = false、error = '缺原生 STL 段记录'、hours = 0。
  missingInputs?: string[];
  // 时长来自**近似几何**（反方向原生记录），非原生前向记录。
  approximated?: ChainFlightApproximation;
  // 该段航线（自然/网关）与指标。
  route?: PlannedRoute;
  metrics?: ReturnType<typeof routeMetrics>;
  // 该段 FTC 最优方案（平衡点；设了时间价值时为总成本最优）。
  option?: FuelOption;
  // 预计飞行时长（小时，= 该段最优方案总时长）。
  hours: number;
  // 预计出发/到达时刻（毫秒，游戏世界时间）。
  departAtMs: number;
  arriveAtMs: number;
}

/** 一条环线（一艘船）的各段飞行时间预估。 */
export interface ChainFlightEstimate {
  ok: boolean;
  shipRegistration: string;
  legs: ChainFlightLeg[];
  // 各段飞行时长合计（小时；只累加 ok 段 —— 判缺段按 0 计，由 ok = false 标出）。
  totalHours: number;
  // 其中借反方向原生记录近似出时长的段数（> 0 时汇总文案须标注「近似」）。
  approximatedLegs: number;
}

export interface ChainFlightTimeInput {
  ship: PrunApi.Ship;
  // 出发地 naturalId（环线起点，也是归航终点）。
  origin: string;
  // 按到访顺序排列的站点。
  stops: { naturalId: string; planetName: string }[];
  // 起始时刻（毫秒，游戏世界时间）；缺省为当前游戏时刻。
  startAtMs?: number;
  // 价格（可选；0 时平衡点不依赖价格）。
  stlPrice?: number;
  ftlPrice?: number;
  timeValue?: number;
  // 是否走网关航线（缺省 false：环线实际用自然航线飞行）。
  useGateway?: boolean;
}

// 单个航段的 FTC 最优方案：与 FTC 面板同一逻辑——自动扫描燃料滑块 f
// （0.05→1 步长 0.05）；仅在存在自然跃迁时扫描反应堆 r（全程系内/纯网关
// 无自然跃迁，反应堆不影响时长与燃料，网格固定为 [1]）。
// 最优 = 平衡点：设了时间价值（₳/小时）时按总成本（燃料费+时间价值）最优，
// 未设时用 findBalanceOption 的 Pareto 拐点（与 FTC 面板完全一致）。
async function bestOptionFor(
  perf: ShipPerformance,
  metrics: ReturnType<typeof routeMetrics>,
  prices: { stlPrice: number; ftlPrice: number; timeValue: number },
): Promise<FuelOption | undefined> {
  // 跨星系航线的起/终点行星环境（内置 JSON）：着陆/起飞燃料影响总燃料，
  // 进而影响平衡点选择（对飞行时长影响很小，但保持与 FTC 面板口径一致）。
  const isCross = (metrics.natPc ?? 0) > 0 || (metrics.gwPc ?? 0) > 0;
  const [landingEnv, departEnv] = await Promise.all([
    isCross && metrics.toBody !== undefined ? fetchPlanetEnv(metrics.toBody) : undefined,
    isCross && metrics.fromBody !== undefined ? fetchPlanetEnv(metrics.fromBody) : undefined,
  ]);
  const reactorRelevant = (metrics.natPc ?? 0) > 0 || (metrics.natJumpCount ?? 0) > 0;
  const options = scanFuelOptions(
    perf,
    metrics,
    autoFuelGrid(),
    reactorRelevant ? autoReactorGrid(perf) : [1],
    prices,
    {
      landingRadius: landingEnv?.radiusKm,
      landingPressure: landingEnv?.pressure,
      departureRadius: departEnv?.radiusKm,
      departurePressure: departEnv?.pressure,
    },
  );
  if (options.length === 0) {
    return undefined;
  }
  const tv = prices.timeValue;
  return tv > 0 ? options[0] : (findBalanceOption(options) ?? options[0]);
}

// 反方向原生记录近似的结果：近似路程 + 写进 ChainFlightLeg.approximated 的来源标注。
type ReverseTransitApproximation = { km: number; record: ChainFlightApproximation };

// 反方向原生「转移」（TRANSIT）段近似：系内航线缺前向几何时，用**反方向**原生记录的路程
// 代替本段整段路程。只服务环线**预估**（见文件头）。
//
// 为什么可用：
// - 转移段弧长由两体轨道几何（出发天体 → 目标天体）主导，相近相位下几乎相同：标定数据
//   data/ftc-calibration/btf-load-sweep-2026-08-29.md 里同航线同船同 f 的点间漂移仅 0.4%
//   （HRT→VH-331g 报 520,267,630 → 522,220,425 km；同处距离漂移也见 fuel-model.ts 的
//   「系内转移段标定」块）。
// - 系内转移段的燃料是**罐口径**（2 × 0.49 × 罐 × min(f, 0.5)，**与距离无关**，见
//   fuel-model 的 STL_TRANSIT_F_SAT 标定块）⟹ 近似只改「整段路程 d」，只影响时长项
//   （t = d / v_转移）；每个 f 的燃料值与原生记录下逐位相同，不会被污染。
//
// ⚠️ 局限（必须让玩家看得见，见 ChainFlightLeg.approximated）：
// - 计划时刻不同 → 两天体轨道相位不同 → 路程与真实值有偏差（反方向记录的相位来自它被写下
//   的那一刻，不是本段出发时刻的），故这是**近似值**；
// - 因此**不得**用于写玩家滑块：FTC 那条路径（ftc-compute.computeFtcPlan / SFC 联动）仍按
//   missingModelInputs 严格判缺、宁可不写（2026-09-23 用户拍板）。本近似只存在于环线预估
//   （面板展示 + 多船时间均衡 + 到港库存预测），且必须在 UI 上显式标注。
//
// 三条成立条件（任一不成立即返回 undefined → 调用方按判缺处理）：
// ① 系内航线（route.legs.length === 0）：跨星系的 STL 几何按跳拼键（离港/进近/航线级），
//    反方向记录是另一条航线的整段路程，代不得；
// ② 前向几何确实缺失（stlDistanceKm undefined 或 ≤ 0）—— 有前向记录就不该走近似；
// ③ 反方向原生记录存在且有整段路程（getSameSystem(to, from)?.transit?.distanceKm > 0）。
function reverseTransitApproximation(
  route: PlannedRoute,
  metrics: ReturnType<typeof routeMetrics>,
  from: string,
  to: string,
): ReverseTransitApproximation | undefined {
  if (route.legs.length !== 0) {
    return undefined;
  }
  if (metrics.stlDistanceKm !== undefined && metrics.stlDistanceKm > 0) {
    return undefined;
  }
  // 查表键优先用 routeMetrics 反查后的键（fromLookup/toLookup）：SFC 会把空间站目的地规范化
  // 成所属星系 id，而服务器记录按实际天体/空间站 id 键控，星系 id 直接查表命不中（见
  // route-planner 的 stlRecordKeyFor 与 system-bodies 的 stationReverse 说明）；没有该分量时
  // 就是本段起终点原文。
  const reverseFrom = metrics.toLookup ?? to;
  const reverseTo = metrics.fromLookup ?? from;
  const km = stlSegmentsStore.getSameSystem(reverseFrom, reverseTo)?.transit?.distanceKm;
  if (km === undefined || !(km > 0)) {
    return undefined;
  }
  return {
    km,
    record: { kind: 'reverse-record', from: reverseFrom, to: reverseTo, distanceKm: km },
  };
}

// 计算一条环线各段的预计飞行时间（按到访顺序逐段累计）。
export async function estimateChainFlightTimes(
  input: ChainFlightTimeInput,
): Promise<ChainFlightEstimate> {
  const { ship, origin, stops } = input;
  const startAtMs = input.startAtMs ?? gameNow();
  const prices = {
    stlPrice: input.stlPrice ?? 0,
    ftlPrice: input.ftlPrice ?? 0,
    timeValue: input.timeValue ?? 0,
  };
  const useGateway = input.useGateway ?? false;

  // 计算前确保飞船蓝图加载（决定 FTL 航速/充能/燃料罐/STL 引擎/最大 G 等性能）。
  await ensureShipBlueprint(ship);
  const perf = shipPerformanceFor(ship);

  const nameOf = new Map<string, string>();
  nameOf.set(origin.toUpperCase(), origin);
  for (const stop of stops) {
    nameOf.set(stop.naturalId.toUpperCase(), stop.planetName || stop.naturalId);
  }
  const nodeName = (id: string) => nameOf.get(id.toUpperCase()) ?? id;

  const legs: ChainFlightLeg[] = [];
  let elapsedMs = 0;
  for (let i = 0; i <= stops.length; i++) {
    const from = i === 0 ? origin : stops[i - 1]!.naturalId;
    const to = i === stops.length ? origin : stops[i]!.naturalId;
    const departAtMs = startAtMs + elapsedMs;
    const leg: ChainFlightLeg = {
      from,
      to,
      fromName: nodeName(from),
      toName: nodeName(to),
      ok: false,
      hours: 0,
      departAtMs,
      arriveAtMs: departAtMs,
    };
    // 起点与终点相同（如站点重复/归航即出发地）：无航程。
    if (from.toUpperCase() === to.toUpperCase()) {
      leg.ok = true;
      legs.push(leg);
      continue;
    }
    try {
      const planned = planRoutes(from, to);
      const route = useGateway ? (planned.gateway ?? planned.natural) : planned.natural;
      if (!route) {
        leg.error = '航线不可达（需恒星位置数据）';
        legs.push(leg);
        continue;
      }
      // STL 起降几何只取服务器原生记录，与时刻无关（自建轨道模型回退已删除），
      // 故一轮计算即可 —— 旧实现按预测到达时刻重算第二轮几何，现已无意义。
      const metrics = routeMetrics(route);
      // 模型必需输入（fuel-model.missingModelInputs）：**先判缺、再算方案**。
      // ⚠️ 为什么单看「有没有 option」不够（本函数 2026-09-24 修的 bug）：
      // 几何缺失时 computeFuelOption 不报错，它只是把 metrics.stlDistanceKm 当 0 →
      // totalKm = 0 → stlHours = 0；系内航线又没有自然跃迁（natPc/gwPc = 0）⟹
      // totalHours === 0，而 findBalanceOption 对「燃料/时间无梯度」的退化输入只会退到最省油端
      // （见 fuel-model 的退化保护注释），绝不报错。于是旧实现把这种 0 小时写成了 ok = true：
      // 面板「飞行」列被 formatFlightDuration(0) 显示为「--（与出发同一时刻到达）」、
      // 循环里的 elapsedMs 原地不动（后续段都在"出发时刻"算几何）、汇总只累加第 1 段，更糟的是
      // 多船时间均衡（chain-planner.planTimeBalancedSegments 的 complete 门 = 所有段 est.ok）与
      // 到港库存预测（chain-planner 的 arrivalHoursByNaturalId）都把这些 0 当真值消费。
      // 现在：输入残缺即显式判缺（ok = false + 成因全文），宁可面板写「缺原生 STL 段记录」。
      const missing = missingModelInputs(perf, metrics);
      const approximation =
        missing.length > 0 ? reverseTransitApproximation(route, metrics, from, to) : undefined;
      // 近似只补「整段路程」，故 option 要用**近似后的 metrics** 重算（罐口径的燃料不变）。
      const usedMetrics =
        approximation === undefined
          ? metrics
          : { ...metrics, stlDistanceKm: approximation.km, transitKm: approximation.km };
      // 近似补上几何后必须**再判一次**：missingModelInputs 的两条判据相互独立，反方向记录
      // 补不了 STL 罐容量/余量（例：蓝图性能未到）。此时退回判缺，绝不让近似掩盖残缺。
      const unresolved =
        approximation === undefined ? missing : missingModelInputs(perf, usedMetrics);
      if (unresolved.length > 0) {
        leg.error = '缺原生 STL 段记录';
        leg.missingInputs = unresolved;
        leg.ok = false;
        leg.hours = 0;
        leg.arriveAtMs = departAtMs;
        legs.push(leg);
        continue;
      }
      const option = await bestOptionFor(perf, usedMetrics, prices);
      if (!option) {
        leg.error = '未能生成有效滑块组合';
        legs.push(leg);
        continue;
      }
      const hours = option.totalHours;
      leg.ok = true;
      leg.route = route;
      leg.metrics = usedMetrics;
      leg.option = option;
      if (approximation !== undefined) {
        leg.approximated = approximation.record;
      }
      leg.hours = hours;
      leg.arriveAtMs = departAtMs + hours * 3600000;
      elapsedMs += hours * 3600000;
    } catch (e) {
      leg.error = e instanceof Error ? e.message : String(e);
    }
    legs.push(leg);
  }

  const totalHours = legs.reduce((sum, l) => sum + (l.ok ? l.hours : 0), 0);
  return {
    // est.ok 语义不变：所有段都算出来了（含近似段）；有判缺段时 ok = false。
    ok: legs.every(l => l.ok),
    shipRegistration: ship.registration,
    legs,
    totalHours,
    approximatedLegs: legs.filter(l => l.approximated !== undefined).length,
  };
}
