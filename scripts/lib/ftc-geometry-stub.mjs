// route-planner.ts / route-model.ts / ftc-compute.ts（均为**真实**实现）在 Node 下的
// 几何替身。服务于 scripts/verify-ftc-geometry-source.mjs：
// 把几何来源（原生 STL 段记录、天体位置观测、恒星/空间站数据）换成用例可控的假数据，
// 从而在 Node 里驱动真实 routeMetrics / planRoutes / computeFtcPlan，断言
// 「STL 几何只取服务器下发的原生记录（自建轨道模型回退已删除）」。
//
// 复用 scripts/lib/ftc-node-stub.mjs（ships/blueprints/storage/buffers 等编排层替身），
// 只补几何侧导出。明确局限：本替身不覆盖真实 store 行为 —— system-bodies.ts 的真实
// 记录/持久化逻辑由 verify-ftc-geometry-source.mjs 的另一组用例驱动真实模块覆盖。
export * from './ftc-node-stub.mjs';
// 真实 system-bodies.ts 用 '@src/.../api-messages' 的 onApiMessage/onAnyApiMessage 注册
// 处理器；这里再导出**真实**模块，保证用例 dispatch 的合成 SHIP_FLIGHT_MISSION 能命中
// 真实记录逻辑（同一模块实例：解析到同一文件 URL）。
export * from '../../src/infrastructure/prun-api/data/api-messages.ts';

// ---- 原生 STL 段记录（真实 stlSegmentsStore 的替身）----
const departRecords = new Map();
const approachRecords = new Map();
const sameSystemRecords = new Map();

const key = (a, b) => `${a.toUpperCase()}|${b.toUpperCase()}`;

export function stubSetDepartureRecord(fromBody, toStar, rec) {
  departRecords.set(key(fromBody, toStar), rec);
}
export function stubSetApproachRecord(fromStar, toBody, rec) {
  approachRecords.set(key(fromStar, toBody), rec);
}
export function stubSetSameSystemRecord(fromBody, toBody, rec) {
  sameSystemRecords.set(key(fromBody, toBody), rec);
}
export function stubClearStlRecords() {
  departRecords.clear();
  approachRecords.clear();
  sameSystemRecords.clear();
}

export const stlSegmentsStore = {
  getDeparture: (fromBody, toStar) => departRecords.get(key(fromBody, toStar)),
  getApproach: (fromStar, toBody) => approachRecords.get(key(fromStar, toBody)),
  getSameSystem: (fromBody, toBody) => sameSystemRecords.get(key(fromBody, toBody)),
};

// ---- 天体位置观测（真实 systemBodiesStore 的替身）：只返回用例登记过的天体 ----
const bodyPositions = new Map();
export function stubSetBodyPosition(naturalId, position) {
  if (position === undefined) {
    bodyPositions.delete(naturalId.toUpperCase());
    return;
  }
  bodyPositions.set(naturalId.toUpperCase(), position);
}
export const systemBodiesStore = {
  getPosition: naturalId => bodyPositions.get(naturalId.toUpperCase()),
};

// 轨道离线预测不参与（自建轨道模型已删除，几何只取服务器原生记录）：
// 即使保留导出也不会被生产代码消费，强制返回 undefined 避免误用。
export const predictPosition = () => undefined;
export const gameNow = () => 0;

// ---- 恒星/空间站数据（route-model.ts 的 resolveSystemId 用）----
// 星系恒星固定在原点；天体位置（stubSetBodyPosition）到原点的距离曾是旧 `liftOffKmAt`
// 的回退值 —— 现在只在用例里充当**负对照**（观测齐备也不得影响 STL 几何）。
const stars = new Map([['ZV-307', { naturalId: 'ZV-307', position: { x: 0, y: 0, z: 0 } }]]);
export const starsStore = {
  getByNaturalId: naturalId => stars.get(naturalId.toUpperCase()),
  // 真实实现：行星 id 去掉末位字母查其所属恒星。
  getByPlanetNaturalId: naturalId => stars.get(naturalId.slice(0, -1).toUpperCase()),
};
export const getStarNaturalId = star => star.naturalId;
export const getStarName = star => star.naturalId;

// 空间站 → 星系映射（与 public/json/stations.json 一致：ANT 在 ZV-307）。
// getStationsInSystem 是真实 orbit.ts 的**反向索引**（route-model.lookupStationInSystem
// 用它反查「被 SFC 规范化成星系 id」的目的地）；这里同样只做枚举，不判唯一性 ——
// 唯一性守卫在生产代码里，替身复刻它就会掩盖问题。
const stationSystems = new Map([['ANT', 'ZV-307']]);
export const getStationSystem = naturalId => stationSystems.get(naturalId.toUpperCase());
export const getStationsInSystem = systemId => {
  const needle = systemId.toUpperCase();
  return [...stationSystems]
    .filter(([, system]) => system.toUpperCase() === needle)
    .map(([station]) => station);
};

// 游戏内运行时站点（真实 stationsStore）：默认空（只有内置 stations.json 生效）。
// 用例可登记「同星系多站」等情形，驱动 route-model 的唯一性守卫（≥2 个候选 → 拒绝反查）。
const runtimeStations = [];
export function stubSetRuntimeStations(list) {
  runtimeStations.length = 0;
  for (const st of list) {
    runtimeStations.push({
      address: { lines: [systemLineOf(st.systemId), stationLineOf(st.naturalId)] },
    });
  }
}
function systemLineOf(id) {
  return { type: 'SYSTEM', entity: { naturalId: id, name: id } };
}
function stationLineOf(id) {
  return { type: 'STATION', entity: { naturalId: id, name: id } };
}
export const stationsStore = {
  all: { value: runtimeStations },
  getByNaturalId: naturalId =>
    runtimeStations.find(x => x.address.lines[1].entity.naturalId === naturalId.toUpperCase()),
};
// 地址工具用**真实实现**（纯函数、无依赖，见 src/infrastructure/prun-api/data/addresses.ts）：
// route-model.lookupStationInSystem 靠它从运行时站点的 address 里取「空间站 id + 所属星系」，
// 用 () => undefined 替身会让「同星系多站 → 拒绝反查」这条守卫在 Node 里无法被驱动
// （所有候选项都会被丢掉，守卫恒为「0 候选」），断言会变成空气。
export * from '../../src/infrastructure/prun-api/data/addresses.ts';

// ---- 航线图（真实 planRoutes 的 dijkstra 用；同星系用例不访问邻居）----
export const routesStore = {
  getNeighbors: () => [],
  isGatewayEdge: () => false,
};

export const flightPlansStore = { all: { value: [] } };

// ---- 浏览星系 / 开窗（真实 browseSystems 会 showBuffer("MS <星系>") 并在 DATA_DATA
// 到达后关窗）----
// 刻意**不**把 browse 当 no-op：hasSystemData 只有在该星系被打开过之后才为 true，
// showBuffer 记录调用命令 —— 这样脚本才能断言「面板路径（browse:true）确实开窗取几何、
// SFC 联动（browse:false）确实不开窗」这条真实差异，而不是断言一条恒真的「两条路径同值」。
const browsedSystems = new Set();
export const browseCalls = [];
export function stubResetBrowseCalls() {
  browseCalls.length = 0;
  browsedSystems.clear();
}
export const hasSystemData = systemId => browsedSystems.has(systemId.toUpperCase());
export const showBuffer = async command => {
  browseCalls.push(command);
  const match = /^MS\s+(\S+)$/.exec(command);
  if (match !== null) {
    browsedSystems.add(match[1].toUpperCase());
  }
};
