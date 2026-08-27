// 环线各段预计飞行时间（XIT FLEET 环线）。
//
// 为环线的每一段（出发地→第1站、站→站、末站→归航）计算飞船预计飞行时间：
// - 飞行时间使用 FTC 的最优燃油计划（fuel-model 扫描 + 平衡点，与 FTC 面板一致）；
// - 下游基地用"未来预计位置"计算时间：每段出发时刻 = 起点时刻 + 前序各段
//   飞行时长累计，用该时刻预测天体在轨道上的位置计算同星系/网关段的起降距离
//   （飞船到达前，天体已沿轨道移动，位置随时间变化）。
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
} from '@src/features/XIT/FTC/fuel-model';
import type { FuelOption, ShipPerformance } from '@src/features/XIT/FTC/fuel-model';
import {
  ensureShipBlueprint,
  fetchPlanetEnv,
  shipPerformanceFor,
} from '@src/features/XIT/FTC/ftc-compute';
import { gameNow } from '@src/infrastructure/fio/orbit';

/** 环线的一个航段：从 `from` 到 `to` 的预计飞行。 */
export interface ChainFlightLeg {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  // 是否成功算出时长（无航线/无有效滑块组合时为 false）。
  ok: boolean;
  error?: string;
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
  // 各段飞行时长合计（小时）。
  totalHours: number;
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
      // 第一轮：出发/到达位置都按出发时刻预测（到达时刻未知）。
      let metrics = routeMetrics(route, { departMs: departAtMs, arriveMs: departAtMs });
      let option = await bestOptionFor(perf, metrics, prices);
      // 第二轮：用"出发时刻 + 该段时长"的到达时刻重算到达天体位置——
      // 下游基地要用飞船到达时的未来预计位置计算航程。
      if (option) {
        const arriveAtMs = departAtMs + option.totalHours * 3600000;
        metrics = routeMetrics(route, { departMs: departAtMs, arriveMs: arriveAtMs });
        option = await bestOptionFor(perf, metrics, prices);
      }
      if (!option) {
        leg.error = '未能生成有效滑块组合';
        legs.push(leg);
        continue;
      }
      const hours = option.totalHours;
      leg.ok = true;
      leg.route = route;
      leg.metrics = metrics;
      leg.option = option;
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
    ok: legs.every(l => l.ok),
    shipRegistration: ship.registration,
    legs,
    totalHours,
  };
}
