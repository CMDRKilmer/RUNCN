// 浏览器侧 / 编排侧依赖替身，服务 scripts/verify-chain-flight-time.mjs
// （见 scripts/lib/chain-flight-time-loader.mjs 的依赖图说明）。
//
// 被替换的**只有**这些位置：飞船/蓝图/油罐 store、开窗、sleep、vue、轨道/空间站归属、
// 航线图（routesStore）、恒星坐标。被测逻辑（chain-flight-time / route-planner /
// route-model / fuel-model / ftc-compute / system-bodies）全部保留真实实现。
//
// 明确局限（别把这里的绿当成端到端绿）：
//   - 恒星坐标、航线图、空间站归属是**合成**数据（真实来源：游戏 DATA_DATA 的恒星、
//     infrastructure/fio/routes.ts 观测到的 JUMP_GATEWAY 连接、public/json/stations.json）。
//     本替身只保证 planRoutes / resolveSystemId 在 Node 里走到真实分支，不断言这些数据本身。
//   - 浏览星系（showBuffer）、行星环境 JSON（fetchPlanetEnv）、油罐余量一律走「立即返回」
//     的空实现 → FTC 面板的 DOM 写入、开窗策略、真实 store 行为**不在覆盖范围内**。
//   - gameNow 是常量（真实实现 = Date.now() + 飞行计划标定的偏差）：脚本一律显式传
//     startAtMs，只有「缺省起点时刻」那一条用例依赖这个常量。
//   - 原生 STL 段记录**不是**替身：stlSegmentsStore 由真实 system-bodies.ts 提供，夹具通过
//     真实 SHIP_FLIGHT_MISSION 派发写入（写入键与查表键都是生产实现）。
export * from '../../src/infrastructure/prun-api/data/addresses.ts';

// ---- vue（编排层只用 ref）----
export const ref = value => ({ value });

// ---- 通用 ----
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---- 飞船 / 蓝图 / 油罐（真实 ftc-compute.shipPerformanceFor 的输入）----
let currentShip;
let currentBlueprint;

export function stubSetShip(ship) {
  currentShip = ship;
}
export function stubSetBlueprint(blueprint) {
  currentBlueprint = blueprint;
}
export const shipsStore = {
  getByRegistration: () => currentShip,
};
export const blueprintsStore = {
  getByNaturalId: () => currentBlueprint,
};
// 油罐不可用 → stlRemaining = 0 → shipPerformanceFor 里落到 undefined
// （真实实现在飞船未停靠/油罐 store 未就绪时同样返回 0，见 ftc-compute）。
export const storagesStore = {
  getByAddressableId: () => undefined,
};

// ---- 开窗（browseSystems）----
export const showBuffer = async () => {};

// ---- @src/infrastructure/fio/orbit ----
// 与夹具 T0 一致；「缺省起点时刻」用例断言 legs[0].departAtMs 等于它。
const STUB_GAME_NOW = 1_700_000_000_000;
export const gameNow = () => STUB_GAME_NOW;
export const hasSystemData = () => true;
export const exportStationOrbits = () => [];

// 空间站 → 星系映射（真实来源 = public/json/stations.json 的 `s` 字段）。
// 本脚本的夹具全部用行星 id（不走空间站反查），故默认为空 —— 保留注入能力只为
// 对应真实导出面，避免 loader 需要再改。
const stationSystems = new Map();
export function stubSetStation(stationNaturalId, systemId) {
  stationSystems.set(stationNaturalId.toUpperCase(), systemId.toUpperCase());
}
export const getStationSystem = naturalId => stationSystems.get(naturalId.toUpperCase());
export const getStationsInSystem = systemId => {
  const needle = systemId.trim().toUpperCase();
  if (needle === '') {
    return [];
  }
  return [...stationSystems].filter(([, system]) => system === needle).map(([station]) => station);
};

// ---- @src/infrastructure/fio/routes（planRoutes 的 dijkstra 用）----
// 真实来源：内置 star-connections.json + 观测到的 JUMP_GATEWAY 连接。这里只接受静态注入：
// natural（自然跃迁边）与 gateway（网关边，allowGateway=false 时被 dijkstra 跳过）。
const routeNeighbors = new Map();
const gatewayEdges = new Set();
const edgeKey = (a, b) => [a.toUpperCase(), b.toUpperCase()].sort().join('|');

function addEdge(a, b, isGateway) {
  const ka = a.toUpperCase();
  const kb = b.toUpperCase();
  if (ka === kb) {
    return;
  }
  if (isGateway) {
    gatewayEdges.add(edgeKey(a, b));
  }
  for (const [from, to] of [
    [ka, kb],
    [kb, ka],
  ]) {
    const set = routeNeighbors.get(from) ?? new Set();
    set.add(to);
    routeNeighbors.set(from, set);
  }
}

export function stubSetRouteGraph({ natural = [], gateway = [] } = {}) {
  routeNeighbors.clear();
  gatewayEdges.clear();
  for (const [a, b] of natural) {
    addEdge(a, b, false);
  }
  for (const [a, b] of gateway) {
    addEdge(a, b, true);
  }
}

export const routesStore = {
  getNeighbors: id => [...(routeNeighbors.get(id.toUpperCase()) ?? [])],
  isGatewayEdge: (a, b) => gatewayEdges.has(edgeKey(a, b)),
};

// ---- @src/infrastructure/prun-api/data/stars ----
// 真实来源 = 游戏 DATA_DATA["systems"]。这里只登记用例用到的恒星坐标；
// getByPlanetNaturalId 与生产同口径（行星 id 去掉末位字母查所属恒星）。
const stars = new Map();
export function stubSetStar(naturalId, position) {
  const id = naturalId.toUpperCase();
  if (position === undefined) {
    stars.delete(id);
    return;
  }
  stars.set(id, { naturalId: id, position });
}
export const starsStore = {
  getByNaturalId: naturalId => stars.get(naturalId.toUpperCase()),
  getByPlanetNaturalId: naturalId => stars.get(naturalId.slice(0, -1).toUpperCase()),
};
export const getStarNaturalId = star => star.naturalId;
export const getStarName = star => star.naturalId;

// ---- @src/infrastructure/prun-api/data/stations（游戏内运行时站点）----
export const stationsStore = {
  all: { value: [] },
  getByNaturalId: () => undefined,
};

// ---- @src/infrastructure/prun-api/data/flight-plans ----
// 空表：route-planner 的原生计划分段展示（buildEstimatedSegmentRows）不在本脚本覆盖范围。
export const flightPlansStore = { all: { value: [] } };

// ---- ./ftc-fuel-settings（ftc-compute 的写入面；本脚本不驱动写滑块路径）----
export const ftcRouteKey = (ship, from, to, useGateway) =>
  `${ship}|${from.trim().toUpperCase()}|${to.trim().toUpperCase()}|${useGateway ? 'gw' : 'nat'}`;
export const setFtcFuelSlider = () => {};
export const setFtcReactorUsage = () => {};
