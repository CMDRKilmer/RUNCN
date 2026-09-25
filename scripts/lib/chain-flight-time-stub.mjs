// 浏览器侧 / 编排侧依赖替身，服务 scripts/verify-chain-flight-time.mjs
// （见 scripts/lib/chain-flight-time-loader.mjs 的依赖图说明）。
//
// 被替换的**只有**这些位置：飞船/蓝图/油罐 store、开窗、sleep、vue、轨道/空间站归属、
// 航线图（routesStore）、恒星坐标。被测逻辑（chain-flight-time / transfer-geometry /
// route-planner / route-model / fuel-model / ftc-compute）全部保留真实实现。
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
//
// 关于 systemBodiesStore / predictPosition（A1 路径新增的可控面）：
//   transfer-geometry.ts 的真实输入：优先 systemBodiesStore.getPosition（静态观测），无
//   观测则回退 predictPosition(t0Ms)（按轨道模型算位置）。本替身提供两条独立注入：
//     stubSetBodyObservation(id, {x,y,z}) → systemBodiesStore.getPosition 返回静态坐标
//     stubSetOrbit(id, {centerStar, radius, periodMs, phaseAtT0}) → predictPosition 在 t0Ms
//       时刻算位置 = 恒星 + 半径 × 角度（开普勒**圆轨道简化**，与生产同公式但只用一项）
//   用例规则：要「t0Ms 影响 distanceKm」（⑩）→ 不登记观测，登记轨道；要「位置固定」
//   （②⑤⑧）→ 登记观测，轨道留空（predictPosition 走 fallback undefined → predictTransferGeometry
//   内部仍优先用 getPosition，不会回到 predictPosition）。
//   stubForcePredictFail(true) 让两条都返回 undefined → 真实 predictTransferGeometry 返回
//   undefined → 算法判定近似失败 → 走老「缺原生 STL 段记录」分支（场景 ①）。
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
// 2026-09-25：ftc-compute 的查表 API 由 getByAddressableId（键 = 可寻址地址，永远查不到
// store id → 余量恒 0）改为 getById（键 = store id）——替身必须补上该方法，否则「油罐
// 不可用」这条替身语义会变成调用即抛 TypeError（同为空实现，但覆盖面不同）。
export const storagesStore = {
  getById: () => undefined,
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

// ---- @src/infrastructure/prun-api/data/system-bodies（A1 新增可控面）----
// 再导出真实的 stlSegmentsStore / recordStlSegments / onApiMessage 等（保留真实记录/查表
// 链路 —— 夹具通过真实 SHIP_FLIGHT_MISSION 派发写入）。本替身只覆盖 systemBodiesStore，
// 提供可注入的位置查询（让 transfer-geometry.ts 不依赖真实 FIO 观测也能跑）。
export * from '../../src/infrastructure/prun-api/data/system-bodies.ts';

// A1 几何预测的输入：两端天体位置。两条独立注入面 —— 见文件头注释。
const observations = new Map();
const orbits = new Map();
let forcePredictFail = false;
export function stubSetBodyObservation(naturalId, position) {
  const key = naturalId.toUpperCase();
  if (position === undefined) {
    observations.delete(key);
    return;
  }
  observations.set(key, position);
}
// orbit = { centerStar: 'VH-331', radiusKm: 46_810_000, periodMs: 86_400_000,
//            phaseAtT0: 0 }：在 t0Ms 时刻位于 centerStar.position + radiusKm × (cos, sin)
// 沿 XY 平面（轨道模型简化）。
const T_REF = 1_700_000_000_000;
export function stubSetOrbit(naturalId, orbit) {
  const key = naturalId.toUpperCase();
  if (orbit === undefined) {
    orbits.delete(key);
    return;
  }
  orbits.set(key, orbit);
}
export function stubForcePredictFail(fail) {
  forcePredictFail = !!fail;
}
export function stubClearBodyInjection() {
  observations.clear();
  orbits.clear();
  forcePredictFail = false;
}
export const systemBodiesStore = {
  getPosition(naturalId) {
    if (forcePredictFail) {
      return undefined;
    }
    if (!naturalId) {
      return undefined;
    }
    return observations.get(naturalId.toUpperCase());
  },
};
export function predictPosition(naturalId, t0Ms) {
  if (forcePredictFail) {
    return undefined;
  }
  if (!naturalId) {
    return undefined;
  }
  const orbit = orbits.get(naturalId.toUpperCase());
  if (!orbit) {
    return undefined;
  }
  const center = stars.get(orbit.centerStar.toUpperCase());
  if (!center) {
    return undefined;
  }
  const angle = orbit.phaseAtT0 + (2 * Math.PI * (t0Ms - T_REF)) / orbit.periodMs;
  return {
    x: center.position.x + orbit.radiusKm * Math.cos(angle),
    y: center.position.y + orbit.radiusKm * Math.sin(angle),
    z: center.position.z,
  };
}

// ---- 空间站 → 星系映射（@src/infrastructure/fio/orbit 的 getStationSystem）----
// 真实来源 = public/json/stations.json 的 `s` 字段。
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

// ---- ./ftc-fuel-settings（ftc-compute 的写入面；⑥-加 用例监视调用次数）----
// A1 路径（几何预测近似）不调 setFtcFuelSlider / setFtcReactorUsage —— chain-flight-time.ts
// 走的是显示预估分支，不是 FTC 面板分支。这里提供调用计数器便于断言「预测路径 ≠ 写滑块」。
const sliderWriteCalls = [];
const reactorWriteCalls = [];
export function stubResetFtcWrites() {
  sliderWriteCalls.length = 0;
  reactorWriteCalls.length = 0;
}
export const sliderWrites = sliderWriteCalls;
export const reactorWrites = reactorWriteCalls;
export const ftcRouteKey = (ship, from, to, useGateway) =>
  `${ship}|${from.trim().toUpperCase()}|${to.trim().toUpperCase()}|${useGateway ? 'gw' : 'nat'}`;
export function setFtcFuelSlider(routeKey, value) {
  sliderWriteCalls.push({ key: routeKey, value });
}
export function setFtcReactorUsage(routeKey, value) {
  reactorWriteCalls.push({ key: routeKey, value });
}
