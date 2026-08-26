import { routesStore } from '@src/infrastructure/fio/routes';
import { systemBodiesStore } from '@src/infrastructure/prun-api/data/system-bodies';
import { getStarPosition, distance3d, resolveSystemId } from './route-model';

// 航线规划与航线指标（XIT FTC 燃料计算器使用）。
// 输入起终点（任意 naturalId：空间站/行星/星系），规划两条候选航线：
// - 自然：仅内置恒星跃迁连接（SYSTEM_STARS_DATA / star-connections.json）
// - 网关：内置连接 + 已观测/配对的网关连接（打开星图后自动建图）
// 时间模型用真实服务器数据校准：
// - 自然跃迁（充能+跃迁）等效速度 2.26 pc/h
// - 网关跃迁 3.0 pc/h，另加锁定+衰减 20min/段；网关跃迁不消耗 FTL 燃料
// 燃料/时长的绝对数值由 fuel-model.ts 根据飞船实时性能（质量/加速度/船体
// 条件/FTL 最大航速）计算；本文件只提供航线结构与几何指标（pc、STL 距离）。

const NAT_PC_PER_H = 2.26;
const GW_PC_PER_H = 3.0;
const GW_LOCK_HOURS = 20 / 60;
// 恒星坐标单位 → pc（游戏 ParsecLength=12，已用真实网关跃迁校准）。
const PARSEC_LENGTH = 12;

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

// 行星/空间站到本星恒星的近似距离（游戏坐标单位，与恒星坐标同源）。
export function liftOffKm(bodyNatural: string | undefined): number | undefined {
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

// 提取飞船性能模型所需的航线指标：STL 起降距离（观测或估算）、自然/网关 pc、自然跳数/网关段数。
export function routeMetrics(route: PlannedRoute): {
  stlDistanceKm: number | undefined;
  natPc: number;
  gwPc: number;
  gwCount: number;
  natJumpCount: number;
  // 目的地实体 naturalId（跨星系时用于 FIO 行星环境查询，精确着陆燃料）。
  toBody?: string;
  // 出发地实体 naturalId（跨星系时用于 FIO 行星环境查询，判断起飞段）。
  fromBody?: string;
} {
  const depart = liftOffKm(route.fromBody);
  const approach = liftOffKm(route.toBody);
  let natPc = 0;
  let gwPc = 0;
  let gwCount = 0;
  let natJumpCount = 0;
  for (const leg of route.legs) {
    if (leg.viaGateway) {
      gwPc += leg.pc;
      gwCount++;
    } else {
      natPc += leg.pc;
      natJumpCount++;
    }
  }
  const stlDistanceKm =
    depart !== undefined && approach !== undefined ? depart + approach : undefined;
  return {
    stlDistanceKm,
    natPc,
    gwPc,
    gwCount,
    natJumpCount,
    toBody: route.toBody,
    fromBody: route.fromBody,
  };
}
