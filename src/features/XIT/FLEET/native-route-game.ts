import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { encodeAddress } from '@src/infrastructure/prun-api/data/flight-test-collector';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import { getStarNaturalId, starsStore } from '@src/infrastructure/prun-api/data/stars';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import type { NativeRouteRecord, NativeRouteWaypointRecord } from './native-route-registry';
import { DEFAULT_WAYPOINT_FUEL_PERCENT, type NativeRouteStep } from './native-route-plan';
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
  const waypoints = server.waypoints.map((waypoint, index) => {
    const previous = local.waypoints[index];
    if (previous === undefined || !sameWaypoint(previous, waypoint)) {
      return waypoint;
    }
    // 时长描述的是「上一站 → 本站」：上一站改了，本站的旧时长同样失效。
    const previousOrigin = index === 0 ? undefined : local.waypoints[index - 1];
    const serverOrigin = index === 0 ? undefined : server.waypoints[index - 1];
    const sameOrigin =
      index === 0 ||
      (previousOrigin !== undefined &&
        serverOrigin !== undefined &&
        sameWaypoint(previousOrigin, serverOrigin));
    // 服务器目的地是暂时换不出名字的结构时，用本地同名航点的可读地址兜底。
    const location =
      waypoint.location === '未知航点' && typeof previous.location === 'string'
        ? previous.location
        : waypoint.location;
    // 时长失效判定：燃料档位必比；反应堆只在本地确实记录过（自然跃迁）时才比——
    // 系内/纯网关航段不写反应堆（写入时按默认 50%），不能因此判掉已算时长。
    const sameReactor =
      previous.reactorPercent === undefined || previous.reactorPercent === waypoint.reactorPercent;
    if (
      previous.flightHours === undefined ||
      previous.fuelPercent !== waypoint.fuelPercent ||
      !sameReactor ||
      !sameOrigin
    ) {
      return { ...waypoint, location };
    }
    return { ...waypoint, location, flightHours: previous.flightHours };
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

function toWaypoint(waypoint: RouteWaypointData): NativeRouteWaypointRecord {
  const target = resolveDestination(waypoint.destination);
  return {
    location: target.location,
    encoded: target.encoded,
    fuelPercent: percentOf(waypoint.fuelUsageFactor) ?? DEFAULT_WAYPOINT_FUEL_PERCENT,
    reactorPercent: percentOf(waypoint.reactorUsageFactor),
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
    return { kind: 'refuel', tank: step.fuel === 'FTL' ? 'FTL' : 'STL' };
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
