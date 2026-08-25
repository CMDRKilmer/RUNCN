import { routesStore } from '@src/infrastructure/fio/routes';
import { systemBodiesStore } from '@src/infrastructure/prun-api/data/system-bodies';
import { getStarPosition, distance3d, resolveSystemId } from './route-model';
import { ShipAnchor } from './anchor';

// 航线规划与燃料优化。
// 输入起终点（任意 naturalId：空间站/行星/星系），规划两条候选航线：
// - 自然：仅内置恒星跃迁连接（SYSTEM_STARS_DATA / star-connections.json）
// - 网关：内置连接 + 已观测/配对的网关连接（打开星图后自动建图）
// 时间模型用真实服务器数据校准：
// - 自然跃迁（充能+跃迁）等效速度 2.26 pc/h
// - 网关跃迁 3.0 pc/h，另加锁定+衰减 20min/段；网关跃迁不消耗 FTL 燃料
// 燃料估算复用飞船标定锚点：STL 燃料 ∝ 燃料滑块 f（线性）、∝ 距离；
// STL 时长 ∝ 质量^0.8·滑块^−0.85；自然 FTL 燃料 ∝ 反应堆 r、时长 ∝ 1/r。
// 无锚点时无法给出绝对燃料，提示先本地计算一次建立标定。

const NAT_PC_PER_H = 2.26;
const GW_PC_PER_H = 3.0;
const GW_LOCK_HOURS = 20 / 60;
// 恒星坐标单位 → pc（游戏 ParsecLength=12，已用真实网关跃迁校准）。
const PARSEC_LENGTH = 12;
// STL 转移（起降+进近）时间 ∝ 距离^STL_TIME_EXP，基准用真实服务器数据校准：
// HRT→MOR 142.5M km ≈ 1.5h（慢/快滑块 1.2~1.8h 的中间值）；
// HRT→BEN 256.5M km ≈ 2.5h（实测 1.9~3.2h），指数 ≈ 0.76（介于 sqrt 与线性之间）。
const STL_BASE_KM = 142.5e6;
const STL_BASE_HOURS = 1.5;
const STL_TIME_EXP = 0.76;

export interface PlannedLeg {
  from: string;
  to: string;
  pc: number;
  viaGateway: boolean;
}

export interface PlannedRoute {
  label: '自然' | '网关';
  systemIds: string[];
  legs: PlannedLeg[];
  totalPc: number;
  gatewayCount: number;
  // 起点/终点的原始输入实体 naturalId（空间站/行星/星系），
  // 用于 STL 起降距离估算（systemBodiesStore 按天体观测）。
  fromBody?: string;
  toBody?: string;
}

// 起降+进近的 STL 时间估算（无滑块概念的中等基准，小时）。
function estimateStlHours(stlKm: number | undefined): number {
  if (stlKm === undefined || stlKm <= 0) {
    return 0.9;
  }
  return STL_BASE_HOURS * Math.pow(stlKm / STL_BASE_KM, STL_TIME_EXP);
}

export interface RouteTime {
  ftlHours: number;
  stlHours: number;
  totalHours: number;
}

// 恒星坐标距离 → pc。
export function pcBetween(a: string, b: string): number | undefined {
  const pa = getStarPosition(a);
  const pb = getStarPosition(b);
  if (!pa || !pb) {
    return undefined;
  }
  return distance3d(pa, pb) / PARSEC_LENGTH;
}

// 按时间加权的最短路径（Dijkstra）。allowGateway=false 时排除网关边（纯自然）。
function dijkstra(from: string, to: string, allowGateway: boolean): string[] | undefined {
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const queue = new Map<string, number>();
  queue.set(from, 0);
  dist.set(from, 0);
  while (queue.size > 0) {
    let cur: string | undefined;
    let best = Infinity;
    for (const [n, d] of queue) {
      if (d < best) {
        best = d;
        cur = n;
      }
    }
    if (cur === undefined) {
      break;
    }
    queue.delete(cur);
    if (cur === to) {
      break;
    }
    for (const nx of routesStore.getNeighbors(cur)) {
      if (!allowGateway && routesStore.isGatewayEdge(cur, nx)) {
        continue;
      }
      const pc = pcBetween(cur, nx);
      if (pc === undefined) {
        continue;
      }
      const gw = allowGateway && routesStore.isGatewayEdge(cur, nx);
      const w = gw ? pc / GW_PC_PER_H + GW_LOCK_HOURS : pc / NAT_PC_PER_H;
      const nd = (dist.get(cur) ?? 0) + w;
      if (nd < (dist.get(nx) ?? Infinity)) {
        dist.set(nx, nd);
        prev.set(nx, cur);
        queue.set(nx, nd);
      }
    }
  }
  if (from !== to && !prev.has(to)) {
    return undefined;
  }
  const path: string[] = [];
  let n: string | undefined = to;
  while (n != null) {
    path.unshift(n);
    n = prev.get(n) ?? undefined;
  }
  return path;
}

function buildRoute(
  path: string[],
  label: '自然' | '网关',
  fromBody?: string,
  toBody?: string,
): PlannedRoute {
  const legs: PlannedLeg[] = [];
  let totalPc = 0;
  let gatewayCount = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];
    const pc = pcBetween(from, to) ?? 0;
    const viaGateway = routesStore.isGatewayEdge(from, to);
    if (viaGateway) {
      gatewayCount++;
    }
    legs.push({ from, to, pc, viaGateway });
    totalPc += pc;
  }
  return { label, systemIds: path, legs, totalPc, gatewayCount, fromBody, toBody };
}

/**
 * 规划起终点间的候选航线。返回 { natural, gateway }：
 * - natural 恒有（可达时）；gateway 仅在真实使用了网关且路线不同于自然时返回。
 * 起终点可为空间站/行星/星系 naturalId。
 */
export function planRoutes(
  fromNatural: string,
  toNatural: string,
): { natural?: PlannedRoute; gateway?: PlannedRoute } {
  const from = resolveSystemId(fromNatural);
  const to = resolveSystemId(toNatural);
  if (!from || !to) {
    return {};
  }
  const naturalPath = dijkstra(from, to, false);
  const gatewayPath = dijkstra(from, to, true);
  const result: { natural?: PlannedRoute; gateway?: PlannedRoute } = {};
  if (naturalPath !== undefined) {
    result.natural = buildRoute(naturalPath, '自然', fromNatural, toNatural);
  }
  if (gatewayPath !== undefined) {
    const gw = buildRoute(gatewayPath, '网关', fromNatural, toNatural);
    const nat = result.natural;
    const sameAsNatural =
      nat !== undefined &&
      gw.systemIds.length === nat.systemIds.length &&
      gw.systemIds.every((s, i) => s === nat.systemIds[i]);
    if (gw.gatewayCount > 0 && !sameAsNatural) {
      result.gateway = gw;
    }
  }
  return result;
}

// 航线基础时间估算（不依赖标定，中等滑块基准，STL 用校准指数模型）。
export function routeTime(route: PlannedRoute): RouteTime {
  let ftlHours = 0;
  for (const leg of route.legs) {
    ftlHours += leg.viaGateway ? leg.pc / GW_PC_PER_H + GW_LOCK_HOURS : leg.pc / NAT_PC_PER_H;
  }
  // STL 起降+进近：首尾原始实体（空间站/行星）→恒星，有观测时按距离估算。
  const depart = liftOffKm(route.fromBody);
  const approach = liftOffKm(route.toBody);
  const stlKm = depart !== undefined && approach !== undefined ? depart + approach : undefined;
  const stlHours = estimateStlHours(stlKm);
  return { ftlHours, stlHours, totalHours: ftlHours + stlHours };
}

// 行星/空间站到本星恒星的近似距离（游戏坐标单位，与恒星坐标同源）。
function liftOffKm(bodyNatural: string | undefined): number | undefined {
  if (bodyNatural === undefined) {
    return undefined;
  }
  const sys = resolveSystemId(bodyNatural);
  const star = sys !== undefined ? getStarPosition(sys) : undefined;
  const pos = systemBodiesStore.getPosition(bodyNatural);
  if (star !== undefined && pos !== undefined) {
    return distance3d(pos, star);
  }
  return undefined;
}

export interface FuelPlan {
  fuel: number;
  reactor: number;
  stlFuel: number;
  ftlFuel: number;
  stlHours: number;
  ftlHours: number;
  totalHours: number;
  fuelCost: number;
  timeCost: number;
  totalCost: number;
  // 是否基于飞船标定（true）或仅时间估算（false，燃料为 0）。
  calibrated: boolean;
  // 航线含自然跃迁段时，锚点能否外推其 FTL 燃料（锚点为网关航线时
  // ftlFuel=0 无法外推，需一条自然航线标定）。
  ftlCalibrated: boolean;
}

export interface OptimizeOptions {
  anchor?: ShipAnchor;
  shipMass?: number;
  stlPrice: number;
  ftlPrice: number;
  timeValue: number;
  fuels: number[];
  reactors: number[];
}

export const DEFAULT_FUELS = [0.05, 0.1, 0.3, 0.5, 0.8, 1];
export const DEFAULT_REACTORS = [0.25, 0.5, 0.75, 1];

/**
 * 对一条航线扫描滑块组合，求综合成本（燃料费+时间价值）最低的方案。
 * 燃料绝对值依赖飞船标定锚点；无锚点时返回纯时间估算（calibrated=false）。
 */
export function optimizeRoute(route: PlannedRoute, opts: OptimizeOptions): FuelPlan[] {
  if (!opts.anchor) {
    // 无标定：仅给出各滑块下的时间（燃料无法绝对量化）。
    const plans: FuelPlan[] = [];
    for (const fuel of opts.fuels) {
      for (const reactor of opts.reactors) {
        const time = routeTime(route);
        plans.push({
          fuel,
          reactor,
          stlFuel: 0,
          ftlFuel: 0,
          stlHours: time.stlHours,
          ftlHours: time.ftlHours,
          totalHours: time.totalHours,
          fuelCost: 0,
          timeCost: time.totalHours * opts.timeValue,
          totalCost: time.totalHours * opts.timeValue,
          calibrated: false,
          ftlCalibrated: false,
        });
      }
    }
    return plans.sort((a, b) => a.totalCost - b.totalCost);
  }

  const cal = opts.anchor.cal;
  const f0 = opts.anchor.fuel;
  const r0 = opts.anchor.reactor ?? 1;
  const m0 = opts.anchor.mass;
  const m = opts.shipMass;
  const massRatio = m0 !== undefined && m !== undefined && m0 > 0 ? Math.pow(m / m0, 0.8) : 1;

  // 距离分解：自然段 pc / 网关段 pc。
  let natPc = 0;
  let gwPc = 0;
  let gwCount = 0;
  for (const leg of route.legs) {
    if (leg.viaGateway) {
      gwPc += leg.pc;
      gwCount++;
    } else {
      natPc += leg.pc;
    }
  }

  // STL 距离：起降（首尾原始实体→恒星，有观测时），无观测时用锚点基准。
  const depart = liftOffKm(route.fromBody);
  const approach = liftOffKm(route.toBody);
  const stlKm =
    depart !== undefined && approach !== undefined
      ? depart + approach
      : cal.stlDistance > 0
        ? cal.stlDistance
        : 0;
  const stlRatio = cal.stlDistance > 0 ? stlKm / cal.stlDistance : 1;

  // 基准（标定滑块 f0/r0 下）。STL 燃料 ∝ 距离（线性），时间 ∝ 距离^0.76（真实校准）。
  const stlFuelBase = cal.stlFuel * stlRatio;
  const stlHoursBase = (cal.stlMs / 3600000) * Math.pow(stlRatio, STL_TIME_EXP);
  // 锚点是否含自然 FTL 段（ftlFuel>0）：仅此时可外推自然 FTL 燃料与反应堆缩放。
  const hasNatCalibration = cal.ftlFuel > 0 && cal.ftlDistance > 0;
  const ftlFuelPerPc = hasNatCalibration ? cal.ftlFuel / cal.ftlDistance : 0;
  // 自然段 FTL 时间用固定等效速度 2.26 pc/h（真实服务器数据校准），
  // 避免用网关锚点（3.0 pc/h）外推自然段导致偏快。
  const ftlHoursPerPc = 1 / NAT_PC_PER_H;
  // 网关 FTL 时间固定（速度恒定，不随滑块变化）。
  const gwHours = gwPc / GW_PC_PER_H + gwCount * GW_LOCK_HOURS;
  // 航线含自然段但锚点无法提供 FTL 燃料系数（锚点为网关航线）时，FTL 燃料无法外推。
  const ftlCalibrated = natPc === 0 || hasNatCalibration;

  const plans: FuelPlan[] = [];
  for (const fuel of opts.fuels) {
    const stlFuel = stlFuelBase * (fuel / f0);
    const stlHours = stlHoursBase * Math.pow(f0 / fuel, 0.85) * massRatio;
    for (const reactor of opts.reactors) {
      const ftlFuel = ftlFuelPerPc * natPc * (reactor / r0);
      // 反应堆对自然 FTL 速度的影响仅在锚点含自然段时按 r0/r 缩放。
      const ftlHoursNat = ftlHoursPerPc * natPc * (hasNatCalibration ? r0 / reactor : 1);
      const ftlHours = ftlHoursNat + gwHours;
      const totalHours = stlHours + ftlHours;
      const fuelCost = stlFuel * opts.stlPrice + ftlFuel * opts.ftlPrice;
      const timeCost = totalHours * opts.timeValue;
      plans.push({
        fuel,
        reactor,
        stlFuel,
        ftlFuel,
        stlHours,
        ftlHours,
        totalHours,
        fuelCost,
        timeCost,
        totalCost: fuelCost + timeCost,
        calibrated: true,
        ftlCalibrated,
      });
    }
  }
  return plans.sort((a, b) => a.totalCost - b.totalCost);
}
