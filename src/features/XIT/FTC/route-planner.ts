import { routesStore } from '@src/infrastructure/fio/routes';
import { predictPosition, gameNow } from '@src/infrastructure/fio/orbit';
import {
  systemBodiesStore,
  stlSegmentsStore,
} from '@src/infrastructure/prun-api/data/system-bodies';
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
// 优先实时观测（SFC 飞行计划标定，最准）；无观测时用轨道离线预测
// （行星轨道全量内置；空间站轨道内置后亦可离线预测，无需游戏内观测）。
export function liftOffKm(bodyNatural: string | undefined): number | undefined {
  if (bodyNatural === undefined) {
    return undefined;
  }
  const sys = resolveSystemId(bodyNatural);
  const star = sys !== undefined ? getStarPosition(sys) : undefined;
  if (star === undefined) {
    return undefined;
  }
  const pos = systemBodiesStore.getPosition(bodyNatural) ?? predictPosition(bodyNatural, gameNow());
  if (pos !== undefined) {
    return distance3d(pos, star);
  }
  return undefined;
}

// 跨星系 STL 起降统计估算（无飞行计划记录时回退）：
// 实测内置数据（2018 离港 + 1082 进近）中位数：离港≈70M、进近≈68M km。
// 远优于"行星到本星系恒星"距离（liftOffKm）——那是本地轨道距离，不是到
// 跃迁点的航程（跳点在恒星连线方向 ~75M 处），低估数倍。
// 空间站/常飞天体通常已有通配记录（BODY|* / *|BODY），不落到此兜底。
const STL_EST_DEPARTURE_KM = 70e6;
const STL_EST_APPROACH_KM = 68e6;

// 提取飞船性能模型所需的航线指标：STL 起降距离（原生记录优先，估算回退）、
// 自然/网关 pc、自然跳数/网关段数。
// 原生 STL 路程 = 离港段 + 进近段（跃迁点在起终点恒星连线上，段距离由服务器
// 计算，离线无法精确复现）——优先用飞行计划记录的原生值（与飞船无关），
// 无记录时回退：跨星系航段用内置数据统计估算，同星系/网关段用本地轨道距离。
export function routeMetrics(route: PlannedRoute): {
  stlDistanceKm: number | undefined;
  // 是否使用了飞行计划记录的原生 STL 路程（否则为统计/轨道估算）。
  stlRecorded: boolean;
  // 离港/进近各自的值（用于展示）。
  departKm: number | undefined;
  approachKm: number | undefined;
  natPc: number;
  gwPc: number;
  gwCount: number;
  natJumpCount: number;
  // 目的地实体 naturalId（跨星系时用于 FIO 行星环境查询，精确着陆燃料）。
  toBody?: string;
  // 出发地实体 naturalId（跨星系时用于 FIO 行星环境查询，判断起飞段）。
  fromBody?: string;
} {
  const departLift = liftOffKm(route.fromBody);
  const approachLift = liftOffKm(route.toBody);
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
  // 飞行计划记录的原生离港/进近距离：出发按 (出发天体, 首跳目标星系)、
  // 进近按 (末跳来源星系, 目标天体)。网关航线（legs 全 viaGateway）无记录。
  const firstLeg = route.legs[0];
  const lastLeg = route.legs[route.legs.length - 1];
  const departRec =
    route.fromBody !== undefined && firstLeg !== undefined && !firstLeg.viaGateway
      ? stlSegmentsStore.getDeparture(route.fromBody, firstLeg.to)
      : undefined;
  const approachRec =
    route.toBody !== undefined && lastLeg !== undefined && !lastLeg.viaGateway
      ? stlSegmentsStore.getApproach(lastLeg.from, route.toBody)
      : undefined;
  // 离港/进近估算：记录（精确）优先；跨星系航段回退统计中位数；其余用本地轨道距离。
  const departKm =
    departRec?.distanceKm ??
    (route.fromBody !== undefined && firstLeg !== undefined && !firstLeg.viaGateway
      ? STL_EST_DEPARTURE_KM
      : departLift);
  const approachKm =
    approachRec?.distanceKm ??
    (route.toBody !== undefined && lastLeg !== undefined && !lastLeg.viaGateway
      ? STL_EST_APPROACH_KM
      : approachLift);
  const stlRecorded = departRec !== undefined && approachRec !== undefined;
  const stlDistanceKm =
    departKm !== undefined && approachKm !== undefined ? departKm + approachKm : undefined;
  return {
    stlDistanceKm,
    stlRecorded,
    departKm,
    approachKm,
    natPc,
    gwPc,
    gwCount,
    natJumpCount,
    toBody: route.toBody,
    fromBody: route.fromBody,
  };
}
