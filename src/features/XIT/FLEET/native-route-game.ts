import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { encodeAddress } from '@src/infrastructure/prun-api/data/flight-test-collector';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import { getStarNaturalId, starsStore } from '@src/infrastructure/prun-api/data/stars';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import type { NativeRouteRecord, NativeRouteWaypointRecord } from './native-route-registry';
import {
  DEFAULT_WAYPOINT_FUEL_PERCENT,
  hoursInvalidatedBySettingChange,
  type NativeRouteStep,
  type RouteTank,
} from './native-route-plan';
import type { RouteData, RouteStepData, RouteWaypointData } from './native-route-socket';
import type { RouteExecutionRow } from './native-route-rte';

export interface RunningNativeRoute {
  route: RouteData;
  shipId?: string;
}

export interface RunningRoutes {
  entries: RunningNativeRoute[];
  // RTE 有执行行，但既没解析出航线号也没能按航班推断出航线。
  unresolved: number;
}

// RTE 行 → 正在执行的航线。行里有航线号就直接配对；只有船时按该船当前航班
// （出发地→目的地连续航点）或停靠位置推断，多个航线同时命中则不猜。
export function matchRunningRoutes(routes: RouteData[], rows: RouteExecutionRow[]): RunningRoutes {
  const byNaturalId = new Map(
    routes
      .filter(x => typeof x.naturalId === 'string' && x.naturalId !== '')
      .map(x => [x.naturalId.toUpperCase(), x]),
  );
  const entries: RunningNativeRoute[] = [];
  const seen = new Set<string>();
  let unresolved = 0;
  for (const row of rows) {
    const route =
      (row.naturalId === undefined ? undefined : byNaturalId.get(row.naturalId.toUpperCase())) ??
      findRouteByName(routes, row.text);
    if (route === undefined) {
      const inferred = row.shipId === undefined ? undefined : inferRoute(row.shipId, routes);
      if (inferred === undefined) {
        unresolved++;
        continue;
      }
      push(inferred, row.shipId);
      continue;
    }
    push(route, row.shipId);
  }
  return { entries, unresolved };

  function push(route: RouteData, shipId: string | undefined) {
    const key = `${route.id}|${shipId ?? ''}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    entries.push({ route, shipId });
  }
}

// 行里没有航线号时，用航线名（玩家文本、非本地化）兜底；重名航线不猜。
function findRouteByName(routes: RouteData[], text: string) {
  const matches = routes.filter(x => {
    const name = typeof x.name === 'string' ? x.name.trim() : '';
    return name.length >= 2 && text.includes(name);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function inferRoute(shipId: string, routes: RouteData[]): RouteData | undefined {
  const ship = shipsStore.getById(shipId);
  if (ship === undefined) {
    return undefined;
  }
  const flight = flightsStore.all.value?.find(x => x.shipId === ship.id && !x.aborted);
  if (flight !== undefined) {
    const matches = routes.filter(route => routeHasLeg(route, flight.origin, flight.destination));
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (ship.address === null) {
    return undefined;
  }
  const matches = routes.filter(route =>
    routeWaypoints(route).some(x => destinationMatches(x.destination, ship.address!)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function routeWaypoints(route: RouteData) {
  return Array.isArray(route.waypoints) ? route.waypoints : [];
}

// 航线按顺序飞航点，循环航线末站回到首站；两种衔接都算一条航段。
function routeHasLeg(route: RouteData, origin: PrunApi.Address, destination: PrunApi.Address) {
  const points = routeWaypoints(route);
  if (points.length < 2) {
    return false;
  }
  for (let i = 0; i < points.length; i++) {
    const next = points[(i + 1) % points.length];
    if (
      destinationMatches(points[i]!.destination, origin) &&
      destinationMatches(next!.destination, destination)
    ) {
      return true;
    }
  }
  return false;
}

function destinationMatches(destination: unknown, address: PrunApi.Address) {
  const target = resolveDestination(destination);
  const encoded = encodeAddress(address);
  if (same(encoded, target.encoded)) {
    return true;
  }
  const naturalId = getEntityNaturalIdFromAddress(address);
  return same(naturalId, target.location);
}

function same(a: string | undefined, b: string | undefined) {
  return a !== undefined && b !== undefined && a.trim().toUpperCase() === b.trim().toUpperCase();
}

interface RouteLocation {
  location: string;
  encoded?: string;
}

// 航点目的地可能是编码字符串，也可能是结构化地址；统一成「展示位置 + 编码地址」。
function resolveDestination(destination: unknown): RouteLocation {
  if (typeof destination === 'string') {
    return { location: decodeRouteDestination(destination), encoded: destination };
  }
  if (isAddress(destination)) {
    return {
      location: getEntityNaturalIdFromAddress(destination) ?? '未知航点',
      encoded: encodeAddress(destination),
    };
  }
  return { location: findDestinationText(destination) ?? '未知航点' };
}

function isAddress(value: unknown): value is PrunApi.Address {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { lines?: unknown }).lines)
  );
}

function findDestinationText(value: unknown, depth = 0): string | undefined {
  if (depth > 3 || value === null || typeof value !== 'object') {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string' && item.includes('|')) {
        return decodeRouteDestination(item);
      }
      const text = findDestinationText(item, depth + 1);
      if (text !== undefined) {
        return text;
      }
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const names = knownEntityNames();
  for (const key of ['naturalId', 'name', 'bodyId', 'planetId', 'stationId', 'id']) {
    const text = record[key];
    if (typeof text === 'string' && text !== '') {
      return names.get(text) ?? text;
    }
  }
  for (const nested of Object.values(record)) {
    const text = findDestinationText(nested, depth + 1);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
}

// 航点 destination 是游戏内部的编码地址（"{系统}|PLA|STA,{天体}"）；用本地已知的
// 星级/空间站/基地/仓库地址把实体 id 换回 naturalId。换不出来时保留末段，至少可读。
export function decodeRouteDestination(destination: string): string {
  const parts = destination.split('|');
  if (parts.length < 2) {
    return destination;
  }
  const tail = parts.at(-1) ?? '';
  const bodyId = tail.includes(',') ? (tail.split(',').at(-1) ?? tail) : tail;
  return knownEntityNames().get(bodyId) ?? bodyId;
}

function knownEntityNames() {
  const stars = starsStore.all.value;
  const stations = stationsStore.all.value;
  const sites = sitesStore.all.value;
  const warehouses = warehousesStore.all.value;
  if (
    namesCache !== undefined &&
    namesCache.stars === stars &&
    namesCache.stations === stations &&
    namesCache.sites === sites &&
    namesCache.warehouses === warehouses
  ) {
    return namesCache.map;
  }
  const names = new Map<string, string>();
  for (const star of stars ?? []) {
    names.set(star.systemId, getStarNaturalId(star));
  }
  const add = (address?: PrunApi.Address) => {
    for (const line of address?.lines ?? []) {
      if (line.entity !== undefined) {
        names.set(line.entity.id, line.entity.naturalId);
      }
    }
  };
  for (const station of stations ?? []) {
    add(station.address);
  }
  for (const site of sites ?? []) {
    add(site.address);
  }
  for (const warehouse of warehouses ?? []) {
    add(warehouse.address);
  }
  namesCache = { stars, stations, sites, warehouses, map: names };
  return names;
}

let namesCache:
  | {
      stars: PrunApi.Star[] | undefined;
      stations: PrunApi.Station[] | undefined;
      sites: PrunApi.Site[] | undefined;
      warehouses: PrunApi.Warehouse[] | undefined;
      map: Map<string, string>;
    }
  | undefined;

// 游戏里的航线（可能是在游戏 UI 手动建的）转成 FLEET 展示用的记录。
export function gameRouteRecord(route: RouteData, shipId: string | undefined): NativeRouteRecord {
  const name = typeof route.name === 'string' ? route.name.trim() : '';
  const naturalId = typeof route.naturalId === 'string' ? route.naturalId : '';
  const ship = shipsStore.getById(shipId);
  return {
    routeId: route.id,
    naturalId,
    name: name === '' ? naturalId : name,
    shipId: shipId ?? '',
    shipLabel: ship === undefined ? '' : ship.name || ship.registration,
    chainName: '',
    createdAt: 0,
    waypoints: routeWaypoints(route).map(toWaypoint),
  };
}

// 展示记录以**游戏航线定义**为准（玩家可能在原生 RT 里改过航点/步骤/档位）；
// 本地记录只保留仍然匹配的估算值（预计飞行时长）与船/产业链元数据。
export function mergeRouteRecord(
  route: RouteData,
  shipId: string | undefined,
  local: NativeRouteRecord | undefined,
): NativeRouteRecord {
  const server = gameRouteRecord(route, shipId ?? local?.shipId);
  if (local === undefined) {
    return server;
  }
  // 时长是按生成时那艘船的质量、引擎、状况与罐容量算的：航线改派给别的船后不再成立。
  const sameShip = local.shipId === '' || server.shipId === '' || local.shipId === server.shipId;
  const stale = sameShip
    ? staleLegIndexes(local.waypoints, server.waypoints)
    : new Set(server.waypoints.map((_, index) => index));
  const waypoints = server.waypoints.map((waypoint, index) => {
    const previous = local.waypoints[index];
    if (previous === undefined || !sameWaypoint(previous, waypoint)) {
      return waypoint;
    }
    // 服务器目的地是暂时换不出名字的结构时，用本地同名航点的可读地址兜底。
    const location =
      waypoint.location === '未知航点' && typeof previous.location === 'string'
        ? previous.location
        : waypoint.location;
    const flightHours = stale.has(index) ? undefined : previous.flightHours;
    if (flightHours === undefined) {
      return { ...waypoint, location };
    }
    return { ...waypoint, location, flightHours };
  });
  return {
    ...server,
    // 服务端名称是空/默认的 RT 号时，沿用向导写入的产业链名。
    name: server.name === server.naturalId && local.name !== '' ? local.name : server.name,
    shipId: server.shipId !== '' ? server.shipId : local.shipId,
    shipLabel: server.shipLabel !== '' ? server.shipLabel : local.shipLabel,
    chainName: local.chainName,
    createdAt: local.createdAt,
    waypoints,
  };
}

// 服务器航线（玩家可能改过）与本地记录的差异 → 需要作废预计时长的航段下标。
// 时长描述的是「上一站 → 本站」：除了本段自身的档位、换站与上游装卸货量，**上游**的
// 燃料/反应堆档位或补油步骤也会改变出发余量，受影响的下游段一并作废（直到油罐补满）。
function staleLegIndexes(
  local: readonly NativeRouteWaypointRecord[],
  server: readonly NativeRouteWaypointRecord[],
) {
  const stale = new Set<number>();
  // 只有「补满」能切断下游作废：固定数量的补油（`limited`）充多少上游就决定多少。
  const refills = (step: NativeRouteStep) => step.kind === 'refuel' && step.limited !== true;
  const invalidateFrom = (index: number, tanks: readonly RouteTank[]) => {
    if (tanks.length === 0) {
      return;
    }
    for (const leg of hoursInvalidatedBySettingChange(
      server,
      index,
      server.length,
      tanks,
      refills,
    )) {
      stale.add(leg);
    }
  };
  for (let index = 0; index < server.length; index++) {
    const previous = local[index];
    const current = server[index];
    if (previous === undefined || current === undefined || !sameWaypoint(previous, current)) {
      // 航点换了地方：飞到它的那段距离、跃迁方式都变了，消耗随之改变，之后的余量也跟着变。
      // 两段都要清——本段（飞到它）即使本站补满也不成立；从它起飞的下游段则一路作废到
      // 两个油罐都补满（首站是出发地，它换了等于第 1 段换起点）。
      if (index > 0) {
        stale.add(index);
      }
      invalidateFrom(index + 1, ['STL', 'FTL']);
      continue;
    }
    // 起飞质量由上游装载/卸载步骤决定：货量改了，时长/燃料都不再成立。
    if (index > 0 && cargoSignature(local, index - 1) !== cargoSignature(server, index - 1)) {
      stale.add(index);
    }
    // 燃料档位必比；反应堆只在本地确实记录过（自然跃迁）时才比——系内/纯网关航段不写
    // 反应堆（写入时按默认 50%），不能因此判掉已算时长。
    if (previous.fuelPercent !== current.fuelPercent) {
      invalidateFrom(index, ['STL']);
    }
    if (
      previous.reactorPercent !== undefined &&
      previous.reactorPercent !== current.reactorPercent
    ) {
      invalidateFrom(index, ['FTL']);
    }
    // 走网关还是自然跃迁换了一条路：距离、时长与消耗都不同（本地没记录过就是未知，不判定）。
    if (
      previous.useGateways !== undefined &&
      current.useGateways !== undefined &&
      previous.useGateways !== current.useGateways
    ) {
      invalidateFrom(index, ['STL', 'FTL']);
    }
    // 着陆改成了飞掠（或反之）：这一段落地的时间/燃料变了，从本站起飞的那段也跟着变。
    if (
      previous.landing !== undefined &&
      current.landing !== undefined &&
      previous.landing !== current.landing
    ) {
      stale.add(index);
      invalidateFrom(index + 1, ['STL', 'FTL']);
    }
    // 补油步骤在本站执行（飞往下一站之前）：改的是下游各段的出发余量。
    const changedTanks = changedRefuelTanks(previous, current);
    if (changedTanks.length > 0) {
      invalidateFrom(index + 1, changedTanks);
    }
  }
  return stale;
}

// 该航点补油步骤的签名（油罐 + 是否固定数量）：补满与定量的出发余量不同，
// 玩家把游戏里的「补满」改成定量也必须算作变化。
function refuelSignature(waypoint: NativeRouteWaypointRecord) {
  const signature = new Map<RouteTank, boolean>();
  for (const step of waypoint.steps) {
    if (step.kind === 'refuel') {
      signature.set(step.tank, step.limited === true);
    }
  }
  return signature;
}

// 该航点上变化的补油油罐：增删步骤、改定量/补满都会改变下游出发余量。
function changedRefuelTanks(a: NativeRouteWaypointRecord, b: NativeRouteWaypointRecord) {
  const before = refuelSignature(a);
  const after = refuelSignature(b);
  const changed: RouteTank[] = [];
  for (const tank of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(tank) !== after.get(tank)) {
      changed.push(tank);
    }
  }
  return changed;
}

export type RouteStopState = 'pending' | 'transit' | 'arrived' | 'done';

// 已确定的航段位置（按 航线号|船 缓存）：到港后航班从 flightsStore 消失，而 A→B→A
// 这类首末同址的航线会同时命中第 0 站与归航站——靠它把「归航已跑完」与「还没出发」分开。
const resolvedStopIndexes = new Map<string, number>();

function stopStateKey(record: NativeRouteRecord, ship: PrunApi.Ship | undefined) {
  const route = record.naturalId.trim().toUpperCase() || record.routeId;
  return `${route}|${ship?.id ?? record.shipId}`;
}

function waypointMatchesAddress(waypoint: NativeRouteWaypointRecord, address: PrunApi.Address) {
  const naturalId = getEntityNaturalIdFromAddress(address);
  if (
    naturalId !== undefined &&
    typeof waypoint.location === 'string' &&
    waypoint.location.trim().toUpperCase() === naturalId.trim().toUpperCase()
  ) {
    return true;
  }
  const encoded = encodeAddress(address);
  return (
    encoded !== undefined &&
    typeof waypoint.encoded === 'string' &&
    waypoint.encoded.trim().toUpperCase() === encoded.trim().toUpperCase()
  );
}

// 用飞船的当前航班（或在港位置）匹配航点，得到逐站状态；与「运行中」表格同一套标记。
// 游戏 UI 手动创建的航线只有编码地址，换不出 naturalId 时用编码地址直接比对航班。
// 环线的首站与归航站是同一地点：先用「上一站 → 目的地」的连续航段定位，
// 否则归航/回港时永远命中第 0 站，进度会重置成 1/N。
export function routeStopStates(
  record: NativeRouteRecord,
  ship: PrunApi.Ship | undefined,
): RouteStopState[] {
  const flight =
    ship === undefined
      ? undefined
      : flightsStore.all.value?.find(x => x.shipId === ship.id && !x.aborted);
  const address = ship?.address;
  const key = stopStateKey(record, ship);
  let index = -1;
  if (flight !== undefined) {
    index = record.waypoints.findIndex(
      (waypoint, i) =>
        i > 0 &&
        waypointMatchesAddress(waypoint, flight.destination) &&
        waypointMatchesAddress(record.waypoints[i - 1]!, flight.origin),
    );
    if (index < 0) {
      index = record.waypoints.findIndex(x => waypointMatchesAddress(x, flight.destination));
    }
    if (index >= 0) {
      resolvedStopIndexes.set(key, index);
    }
  } else if (address != null) {
    // 在港（航班已结束）：取「上一次确定位置之后」的第一个匹配点，归航完成后不会退回第 0 站。
    const remembered = resolvedStopIndexes.get(key);
    index = record.waypoints.findIndex(
      (x, i) => (remembered === undefined || i >= remembered) && waypointMatchesAddress(x, address),
    );
    if (index < 0) {
      index = record.waypoints.findIndex(x => waypointMatchesAddress(x, address));
    }
  }
  return record.waypoints.map((_, i): RouteStopState => {
    if (index < 0) {
      return 'pending';
    }
    if (i < index) {
      return 'done';
    }
    if (i > index) {
      return 'pending';
    }
    return flight === undefined ? 'arrived' : 'transit';
  });
}

// 「当前/总站数」进度文本：由逐站状态推出，与表格标记同一口径。
export function routeProgressText(record: NativeRouteRecord, ship: PrunApi.Ship | undefined) {
  const states = routeStopStates(record, ship);
  const index = states.findIndex(x => x === 'arrived' || x === 'transit');
  const reached = states.filter(x => x === 'done').length;
  const current = index < 0 ? Math.min(reached + 1, record.waypoints.length) : index + 1;
  return `${current}/${record.waypoints.length}`;
}

function sameWaypoint(a: NativeRouteWaypointRecord, b: NativeRouteWaypointRecord) {
  if (typeof b.encoded === 'string') {
    return typeof a.encoded === 'string'
      ? a.encoded.trim().toUpperCase() === b.encoded.trim().toUpperCase()
      : sameLocation(a.location, b.location);
  }
  // 服务器的目的地换不出可读地址时只能按航点序号对齐（local 与 server 按 index 配对）。
  if (b.location === '未知航点') {
    return true;
  }
  return sameLocation(a.location, b.location);
}

function sameLocation(a: string, b: string) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a.trim().toUpperCase() === b.trim().toUpperCase()
  );
}

// 截至 departureIndex 的装载/卸载步骤摘要（ticker + 数量/容量标记）。
// 起飞质量直接影响转移段速度与起降燃料，上游货量变了就要作废下游时长。
function cargoSignature(waypoints: readonly NativeRouteWaypointRecord[], departureIndex: number) {
  const parts: string[] = [];
  for (let index = 0; index <= departureIndex; index++) {
    for (const step of waypoints[index]?.steps ?? []) {
      if (step.kind === 'refuel') {
        continue;
      }
      const amount = step.capacity ? 'cap' : step.amount;
      parts.push(`${index}:${step.kind}:${step.ticker}:${amount}`);
    }
  }
  return parts.join('|');
}

function toWaypoint(waypoint: RouteWaypointData): NativeRouteWaypointRecord {
  const target = resolveDestination(waypoint.destination);
  return {
    location: target.location,
    encoded: target.encoded,
    fuelPercent: percentOf(waypoint.fuelUsageFactor) ?? DEFAULT_WAYPOINT_FUEL_PERCENT,
    reactorPercent: percentOf(waypoint.reactorUsageFactor),
    // 走网关还是自然跃迁决定实际航线：时长按它算出来的，改了就作废。
    useGateways: waypoint.preferences?.useGateways,
    landing: waypoint.landing,
    steps: (waypoint.steps ?? [])
      .map(toStep)
      .filter((step): step is NativeRouteStep => step !== undefined),
  };
}

function percentOf(factor: number | undefined) {
  if (typeof factor !== 'number' || !Number.isFinite(factor)) {
    return undefined;
  }
  return Math.min(100, Math.max(1, Math.round(factor * 100)));
}

function toStep(step: RouteStepData): NativeRouteStep | undefined {
  if (step.type === 'REFUEL') {
    // 补满（CAPACITY）是默认；玩家改成固定数量后出发油量与上游消耗有关，必须记下来。
    // 上限缺失时按「非补满」处理：宁可多作废时长，也不要把不保证满罐当成边界。
    const limited = step.maximum?.type !== 'CAPACITY';
    return {
      kind: 'refuel',
      tank: step.fuel === 'FTL' ? 'FTL' : 'STL',
      limited: limited ? true : undefined,
    };
  }
  if (step.type !== 'LOAD' && step.type !== 'UNLOAD') {
    return undefined;
  }
  const ticker = step.material?.ticker;
  if (ticker === undefined) {
    return undefined;
  }
  // CAPACITY（装载=装满 / 卸船=全部）没有绝对数量，标记出来避免按 0 吨计算。
  const capacity = step.maximum?.type === 'CAPACITY' || step.minimum?.type === 'CAPACITY';
  const amount = capacity ? 0 : (step.maximum?.units ?? step.minimum?.units ?? 0);
  return {
    kind: step.type === 'LOAD' ? 'load' : 'unload',
    ticker,
    amount,
    capacity: capacity || undefined,
  };
}
