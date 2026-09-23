import { routesStore } from '@src/infrastructure/fio/routes';
import { stlSegmentsStore } from '@src/infrastructure/prun-api/data/system-bodies';
import { flightPlansStore } from '@src/infrastructure/prun-api/data/flight-plans';
import {
  getEntityNaturalIdFromAddress,
  getDestinationFullName,
} from '@src/infrastructure/prun-api/data/addresses';
import { starsStore, getStarName } from '@src/infrastructure/prun-api/data/stars';
import {
  conditionFactor,
  stlDepartSpeedFor,
  stlApproachSpeedFor,
  ftlSpeedFor,
  ftlChargeSecondsFor,
  ftlFuelCFor,
  stlLandingFactor,
  stlDepartureFSat,
} from './fuel-model';
import type { ShipPerformance, RouteStationReverse } from './fuel-model';
import {
  getStarPosition,
  distance3d,
  isSystemId,
  resolveSystemId,
  lookupStationInSystem,
} from './route-model';
// StationSystemLookup 是 StlRecordKey.lookup 的类型（见下方 stlRecordKeyFor）——
// 只作类型使用，故走 import type（不改运行时导入面）。
import type { StationSystemLookup } from './route-model';

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
  // 用于查服务器原生 STL 段记录（几何的**唯一**来源）。
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

// 提取飞船性能模型所需的航线指标：STL 起降距离（**只看服务器原生记录，无回退**）、
// 自然/网关 pc、自然跳数/网关段数。
// STL 起降几何**只信服务器下发的原生记录**（2026-09-23 用户拍板「不需要回退，永远等
// 服务器下发」）：服务器在起终点恒星连线上算跃迁点/转移段，离线无法精确复现；
// 自建轨道模型（旧 `liftOffKmAt`）与统计中位数常数（旧 `STL_EST_*`）都已删除 ——
// 宁可不动，也不写假值。查得规则：
// - 跨星系航线：离港按 (出发天体, 首跳目标星系)、进近按 (末跳来源星系, 目标天体)；
// - 同星系航线（legs 为空，无跳）：按 (出发天体, 目标天体) 查同星系表 —— 真实系内计划的
//   结构是**单段「转移」（TRANSIT）**（见下 ⚠️），故取记录里的 `transit` 作为整段路程。
// 两者查不到 → undefined → 下游 `missingModelInputs` 判缺 → 不写滑块，
// 等服务器下发该航线的原生段记录（SFC 推送门按几何签名放行重算）。
// ⚠️ **结构性**查不到（等再久也没有，由 missingModelInputs 给出提示）：
// ① 跨星系网关跃迁：不产生按跳的离港/进近键。
// ② 系内飞行（同星系）：真实段结构是单段「转移」（TRANSIT）（2026-09-23 用户 SFC 原生
//    计划实测 ZV-307a → ZV-307/Antares Station = 单段 101,655,808 km / 43分59秒 /
//    2655 单位 STL）。**2026-09-23 本轮起 `recordStlSegments` 会记录这一段**
//    （段名/字段已核实：`SegmentType` 含 'TRANSIT'、`FlightSegment.stlDistance` 同字段
//    —— 与离港/进近同口径，见 system-bodies.ts 文件头），于是 `transitKm` 有值；
//    该段口径已标定（2026-09-23，BTF 受控数据：燃料 = 0.98×罐×min(f,0.5)、时长 = d/v_转移，
//    见 fuel-model.ts 的「系内转移段标定」块）→ 拿到记录即可算、可写滑块，不再受口径约束。
//    ⚠️ 这与是否勾选「使用跃迁点」**无关**（判据是 `planRoutes` 对同星系两种模式都返回
//    `natural`（legs 为空），不是数字比较 —— 旧注释比的「101.7053M km，差 0.05%」已作废：
//    那是已删除的自建轨道模型的估算行，不是原生值）。
//    旧注释把「转移结构」归因给勾选、并声称「同星系直飞计划同样带原生 DEPARTURE/
//    APPROACH 段（实测 68.0562M + 33.6491M）」——那 68.0562M/33.6491M 是**本模型自己的
//    估算行**（FTC 面板标题写明「航线分段（模型估算）」），不是服务器原生值（2026-09-23 复核）。
// 另一条（旧成因②）**已修**：目的地/起点被 SFC 规范化成**星系 id**（空间站 → 所属星系，
// 如 ANT → ZV-307）时，记录键用的是实际天体/空间站 id（真实导出键 ZV-307A|ANT）→ 星系 id
// 直接查表命不中（5930 条记录里天体侧命中星系 id 的 = 0 条）。现在查表前先按内置
// stations.json + 游戏内站点把星系 id **反查**为唯一空间站 id（见 stlRecordKeyFor /
// route-model.lookupStationInSystem）；反查不唯一（同星系多站 / 无站点数据）时拒绝反查，
// 保持「不写滑块 + 提示」。⚠️ 反查只改**记录查表键**：PlannedRoute.fromBody/toBody 的
// 对外语义仍是「目的地实体」（fetchPlanetEnv / FTC.vue 的 nativePlan 匹配都依赖它）。

// 记录查表键：天体/空间站 id 原样使用；星系 id 先反查为唯一空间站 id（见上）。
export interface StlRecordKey {
  // 实际用于查 stlSegmentsStore 的键（天体/空间站 id）。
  key: string;
  // 本身是星系 id 时的反查结果（唯一守卫在 lookupStationInSystem 里，这里原样透传给
  // stationReverse，供缺失项文案区分「已反查」与「拒绝反查」）。
  lookup?: StationSystemLookup;
}

function stlRecordKeyFor(body: string | undefined): StlRecordKey | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (!isSystemId(body)) {
    return { key: body };
  }
  const lookup = lookupStationInSystem(body);
  if (lookup?.station !== undefined) {
    return { key: lookup.station, lookup };
  }
  return { key: body, lookup };
}

export function routeMetrics(route: PlannedRoute): {
  stlDistanceKm: number | undefined;
  // 飞行计划记录的原生 STL 路程（**无回退**：false 时几何缺失 → 判缺）。
  stlRecorded: boolean;
  // 离港/进近各自的值（用于展示）。
  departKm: number | undefined;
  approachKm: number | undefined;
  // 系内「转移」（TRANSIT）段的原生**整段**路程（km；只有真实系内结构才有）。
  // 与 departKm/approachKm 互斥：有转移段时不必也不该拆成两段。
  transitKm: number | undefined;
  // 转移段的原生耗时（秒；随船/f 变，仅运行时记录有值）。
  transitSeconds: number | undefined;
  // 飞行计划记录的原生离港/进近段耗时（秒，随飞船变，仅运行时记录有值；
  // 内置数据不含时长）。有值时航线段展示直接用（精确复现服务器时长）。
  departSeconds: number | undefined;
  approachSeconds: number | undefined;
  natPc: number;
  gwPc: number;
  gwCount: number;
  natJumpCount: number;
  // 目的地实体 naturalId（跨星系时用于 FIO 行星环境查询，精确着陆燃料）。
  toBody?: string;
  // 出发地实体 naturalId（跨星系时用于 FIO 行星环境查询，判断起飞段）。
  fromBody?: string;
  // 起点/终点文本本身是否就是星系 id（而非天体/空间站）。SFC 会把空间站目的地
  // 规范化成星系 id（如 ANT → ZV-307），此时原生段记录的键（按实际天体/空间站
  // 键控）需要先反查才能命中 —— 见下面的 stationReverse 与 stlRecordKeyFor。
  fromIsSystem: boolean;
  toIsSystem: boolean;
  // 记录查表实际用的键（反查后可能与 fromBody/toBody 不同；无该分量时 undefined）。
  fromLookup?: string;
  toLookup?: string;
  // 成因② 诊断：起终点里是星系 id 的分量及其反查结果（缺省 = 起终点都不是星系 id）。
  // station 有值 = 已按反查后的空间站 id 查表；undefined = 反查不唯一/无数据（拒绝反查）。
  stationReverse: RouteStationReverse[];
} {
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
  // 飞行计划记录的原生离港/进近段：出发按 (出发天体, 首跳目标星系)、
  // 进近按 (末跳来源星系, 目标天体)；同星系（无跳）按 (出发天体, 目标天体)。
  // 网关航线（legs 全 viaGateway）无记录。
  // ⚠️ 同星系表里真实会有的是**转移（TRANSIT）段**（整段路程，见 `transitKm`）——
  // DEPARTURE/APPROACH 拆分只出现在合成用例里（真实系内计划没有这两段）。
  // 天体侧分量（出发天体 / 目标天体）先反查：SFC 会把空间站目的地规范化成星系 id，
  // 反查成唯一空间站 id 后才可能命中服务器实际写下的键（星系侧分量是恒星 id，无需反查）。
  const fromRecordKey = stlRecordKeyFor(route.fromBody);
  const toRecordKey = stlRecordKeyFor(route.toBody);
  const firstLeg = route.legs[0];
  const lastLeg = route.legs[route.legs.length - 1];
  const sameSystemRec =
    fromRecordKey !== undefined && toRecordKey !== undefined && route.legs.length === 0
      ? stlSegmentsStore.getSameSystem(fromRecordKey.key, toRecordKey.key)
      : undefined;
  const departRec =
    (fromRecordKey !== undefined && firstLeg !== undefined && !firstLeg.viaGateway
      ? stlSegmentsStore.getDeparture(fromRecordKey.key, firstLeg.to)
      : undefined) ?? sameSystemRec?.depart;
  const approachRec =
    (toRecordKey !== undefined && lastLeg !== undefined && !lastLeg.viaGateway
      ? stlSegmentsStore.getApproach(lastLeg.from, toRecordKey.key)
      : undefined) ?? sameSystemRec?.approach;
  // 系内「转移」段（真实结构）：整段路程，直接当 d 用 —— 口径已标定（燃料 0.98×罐×min(f,0.5)、
  // 时长 d/v_转移），能不能写滑块只看记录与罐容量是否齐（见 fuel-model.missingModelInputs）。
  const transitRec = sameSystemRec?.transit;
  const transitKm = transitRec?.distanceKm;
  // 离港/进近几何 = 服务器原生记录（**唯一**来源，无回退）：取不到即 undefined。
  // 数据没到就保持不写滑块，等下一次信号（新的原生 STL 段入库 → 推送门签名变化 → 放行）。
  const departKm = departRec?.distanceKm;
  const approachKm = approachRec?.distanceKm;
  const twoLegRecorded = departRec !== undefined && approachRec !== undefined;
  const stlRecorded = twoLegRecorded || transitRec !== undefined;
  const stlDistanceKm =
    departKm !== undefined && approachKm !== undefined ? departKm + approachKm : transitKm;
  return {
    stlDistanceKm,
    stlRecorded,
    departKm,
    approachKm,
    transitKm,
    transitSeconds:
      transitRec !== undefined && transitRec.seconds > 0 ? transitRec.seconds : undefined,
    departSeconds: departRec !== undefined && departRec.seconds > 0 ? departRec.seconds : undefined,
    approachSeconds:
      approachRec !== undefined && approachRec.seconds > 0 ? approachRec.seconds : undefined,
    natPc,
    gwPc,
    gwCount,
    natJumpCount,
    toBody: route.toBody,
    fromBody: route.fromBody,
    // 纯文本判定（不查记录）：输入本身就是星系 id 时，同星系/跨星系键都拼不出
    // 服务器实际写下的天体键（真实导出里的键是天体/空间站，如 ZV-307A|ANT）。
    fromIsSystem: isSystemId(route.fromBody),
    toIsSystem: isSystemId(route.toBody),
    // 记录查表的实际键 + 星系 id 反查结果（诊断/文案用）。
    fromLookup: fromRecordKey?.key,
    toLookup: toRecordKey?.key,
    stationReverse: [fromRecordKey?.lookup, toRecordKey?.lookup].filter(x => x !== undefined),
  };
}

// ---- 完整航线段展示（严格按游戏 SFC 飞行计划表格）----
// 优先复用服务器下发的原生 FlightPlan（SHIP_FLIGHT_MISSION，flightPlansStore
// 已捕获），逐段列出 离港/跃迁/充能/进近/着陆 及目的地、耗时、距离、损伤、
// 燃料消耗——与 SFC 窗口表格完全一致。无原生计划时回退模型估算分段。

export interface RouteSegmentRow {
  type: string;
  typeKey: PrunApi.SegmentType;
  destination: string;
  durationMs: number;
  distanceKm?: number;
  distancePc?: number;
  damage: number;
  stlFuel?: number;
  ftlFuel?: number;
  // 是否来自服务器原生飞行计划（否则为模型估算）。
  native: boolean;
}

const SEGMENT_TYPE_LABEL: Record<string, string> = {
  TAKE_OFF: '起飞',
  DEPARTURE: '离港',
  TRANSIT: '转移',
  CHARGE: '充能',
  JUMP: '跃迁',
  FLOAT: '漂浮',
  APPROACH: '进近',
  LANDING: '着陆',
  LOCK: '锁定',
  DECAY: '衰减',
  JUMP_GATEWAY: '网关跃迁',
};

function segmentTypeLabel(type: string): string {
  return SEGMENT_TYPE_LABEL[type] ?? type;
}

// 目的地址文本：与游戏 SFC 表格一致（含 ORBIT 时加「（环绕轨道）」后缀）。
function segmentDestinationText(dest?: PrunApi.Address): string {
  if (!dest) {
    return '--';
  }
  const full = getDestinationFullName(dest);
  const hasOrbit = dest.lines?.some(l => l.type === 'ORBIT');
  return hasOrbit ? `${full}（环绕轨道）` : (full ?? '--');
}

// 从 flightPlansStore 查找匹配当前航线（起终点实体 naturalId）的原生计划，
// 多条时取出发时刻最新的一条。
export function findNativeFlightPlan(
  fromBody: string,
  toBody: string,
): PrunApi.FlightPlan | undefined {
  const plans = flightPlansStore.all.value;
  if (!plans || plans.length === 0) {
    return undefined;
  }
  const from = fromBody.toUpperCase();
  const to = toBody.toUpperCase();
  let best: PrunApi.FlightPlan | undefined;
  let bestDepart = -Infinity;
  for (const plan of plans) {
    const segs = plan.segments;
    if (segs.length === 0) {
      continue;
    }
    const origin = getEntityNaturalIdFromAddress(segs[0].origin)?.toUpperCase();
    const dest = getEntityNaturalIdFromAddress(segs[segs.length - 1].destination)?.toUpperCase();
    if (origin !== from || dest !== to) {
      continue;
    }
    const depart = segs[0].departure?.timestamp ?? 0;
    if (depart > bestDepart) {
      bestDepart = depart;
      best = plan;
    }
  }
  return best;
}

// 将原生 FlightPlan 的 segments 转为展示行（严格按 SFC 表格）。
export function buildNativeSegmentRows(plan: PrunApi.FlightPlan): RouteSegmentRow[] {
  return plan.segments.map(seg => ({
    type: segmentTypeLabel(seg.type),
    typeKey: seg.type,
    destination: segmentDestinationText(seg.destination),
    durationMs: (seg.arrival?.timestamp ?? 0) - (seg.departure?.timestamp ?? 0),
    distanceKm: seg.stlDistance ?? undefined,
    distancePc: seg.ftlDistance ?? undefined,
    damage: seg.damage,
    stlFuel: seg.stlFuelConsumption ?? undefined,
    ftlFuel: seg.ftlFuelConsumption ?? undefined,
    native: true,
  }));
}

// ---- 模型估算分段（无原生飞行计划时回退，格式与 SFC 表格一致）----
function starName(systemId: string): string {
  const star = starsStore.getByNaturalId(systemId);
  return star ? (getStarName(star) ?? systemId) : systemId;
}

// 按航线/指标/飞船性能估算完整分段。跨星系 STL 段用罐模型（与 fuel-model
// computeFuelOption 同源）；FTL 段按每跳 pc 分摊燃料与时间。
export function buildEstimatedSegmentRows(
  route: PlannedRoute,
  metrics: ReturnType<typeof routeMetrics>,
  ship: ShipPerformance,
  fuel: number,
  reactor: number,
  settings: {
    landingRadius?: number;
    landingPressure?: number;
    departureRadius?: number;
    departurePressure?: number;
    stlLandingFactor?: number;
    stlApproachExtra?: number;
  } = {},
): RouteSegmentRow[] {
  const rows: RouteSegmentRow[] = [];
  const cond = conditionFactor(ship.condition);
  // 离港/进近段速度（统一段模型，见 fuel-model.ts）。
  const vDepart = stlDepartSpeedFor(ship, fuel);
  const vApproach = stlApproachSpeedFor(ship, fuel);
  const vFtl = ftlSpeedFor(ship, reactor);
  const chargeSec = ftlChargeSecondsFor(ship, reactor);
  const ftlC = ftlFuelCFor(ship);
  const isCross = (metrics.natPc ?? 0) > 0 || (metrics.gwPc ?? 0) > 0;
  const tank = ship.stlFuelCapacity;

  // 记录的原生秒数合理性校验：stlSegmentsStore 不区分飞船/配置，可能混入其它船
  // 甚至旧配置的记录（如 OOG LCB 曾出现 71.6M km / 2h58m = 6708 km/s 的异常记录，
  // 而本船段模型速度 ~19.8k/33.9k km/s）。记录速度若偏离本船段模型速度过远
  // （<0.5× 或 >2×），判为非同船记录，回退模型时长。
  function recordedSeconds(
    seconds: number | undefined,
    distanceKm: number | undefined,
    segSpeed: number,
  ) {
    if (seconds === undefined || seconds <= 0 || distanceKm === undefined || distanceKm <= 0) {
      return undefined;
    }
    const speed = distanceKm / seconds;
    const ratio = speed / Math.max(1, segSpeed);
    if (ratio < 0.5 || ratio > 2) {
      return undefined;
    }
    return seconds;
  }

  // 跨星系 STL 罐模型细分（与 computeFuelOption 同源）：
  // 离港 ≈ 0.49×罐×min(f, f_cap)（省油引擎离港饱和）、进近 ≈ 0.49×罐×f + 进近差、
  // 着陆/起飞按行星半径气压。
  const fDep = stlDepartureFSat(ship);
  const stlDepartFuel =
    isCross && tank !== undefined && tank > 0 ? 0.49 * tank * Math.min(fuel, fDep) : undefined;
  const lf = settings.stlLandingFactor ?? stlLandingFactor(ship);
  const P =
    settings.landingPressure !== undefined && settings.landingPressure > 0
      ? settings.landingPressure
      : 1;
  const R = settings.landingRadius;
  const landingFuel =
    isCross && R !== undefined && R > 0 ? 0.47 * Math.sqrt(R * Math.pow(P, -0.2)) * lf : undefined;
  const approachExtra = settings.stlApproachExtra ?? 8;
  const stlApproachFuel =
    isCross && tank !== undefined && tank > 0 ? 0.49 * tank * fuel + approachExtra : undefined;

  // 离港段（起点 → 首跳恒星）。与游戏 SFC 表格一致：离港段 FTL 燃料 = 首跳充能
  // （自然航线离港时即为第一跳充电；网关无 FTL 燃料）。时长优先用飞行计划记录的
  // 原生秒数（服务器计算，含加速/转移动力学，比 d/v_cruise 精确）；无记录回退模型。
  const departKm = metrics.departKm;
  if (departKm !== undefined && departKm > 0) {
    const firstLeg = route.legs[0];
    const departFtl =
      firstLeg !== undefined && !firstLeg.viaGateway ? ftlC * reactor * firstLeg.pc : undefined;
    rows.push({
      type: '离港',
      typeKey: 'DEPARTURE',
      destination: `${route.fromBody ?? ''}（环绕轨道）`,
      durationMs:
        (recordedSeconds(metrics.departSeconds, departKm, vDepart) ??
          (departKm / (vDepart * 3600) / cond) * 3600) * 1000,
      distanceKm: departKm,
      damage: 0,
      stlFuel: stlDepartFuel,
      ftlFuel: departFtl,
      native: false,
    });
  }

  // 每条跃迁 + 充能。与游戏 SFC 表格一致：充能只存在于两跳之间（为下一跳充电），
  // 最后一跳后直接进近、无充能段；充能 FTL 燃料按下一跳距离分摊。
  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i];
    rows.push({
      type: leg.viaGateway ? '网关跃迁' : '跃迁',
      typeKey: leg.viaGateway ? 'JUMP_GATEWAY' : 'JUMP',
      destination: `${starName(leg.to)}（环绕轨道）`,
      durationMs: (leg.pc / vFtl) * 3600000,
      distancePc: leg.pc,
      damage: 0,
      native: false,
    });
    if (i < route.legs.length - 1) {
      const nextLeg = route.legs[i + 1];
      const chargeFuel = nextLeg.viaGateway ? 0 : ftlC * reactor * nextLeg.pc;
      rows.push({
        type: '充能',
        typeKey: 'CHARGE',
        destination: `${starName(leg.to)}（环绕轨道）`,
        durationMs: chargeSec * 1000,
        damage: 0,
        ftlFuel: chargeFuel,
        native: false,
      });
    }
  }

  // 进近段（末跳恒星 → 终点）。时长优先用飞行计划记录的原生秒数。
  const approachKm = metrics.approachKm;
  if (approachKm !== undefined && approachKm > 0) {
    rows.push({
      type: '进近',
      typeKey: 'APPROACH',
      destination: `${route.toBody ?? ''}（环绕轨道）`,
      durationMs:
        (recordedSeconds(metrics.approachSeconds, approachKm, vApproach) ??
          (approachKm / (vApproach * 3600) / cond) * 3600) * 1000,
      distanceKm: approachKm,
      damage: 0,
      stlFuel: stlApproachFuel,
      native: false,
    });
  }

  // 着陆段（终点行星表面）。
  if (landingFuel !== undefined && R !== undefined) {
    rows.push({
      type: '着陆',
      typeKey: 'LANDING',
      destination: route.toBody ?? '',
      durationMs: 0,
      damage: 0,
      stlFuel: landingFuel,
      native: false,
    });
  }

  return rows;
}
