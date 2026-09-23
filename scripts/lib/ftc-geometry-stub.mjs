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
// 航线级记录（2026-09-23 第 5 轮追加）：整条航线所有 STL 段之和，键 = (出发天体|目标天体[#gw])。
// 这是几何**首选**来源（生产见 system-bodies.routeRecords）—— 按首/末跳拼的
// depart/approach 键只作回退（混合航线的 APPROACH 段在中间、destination ≠ 最终目标，
// 按首末跳拼键必然失配）。默认空表 → getRoute 返回 undefined，既有用例行为不变。
const routeRecords = new Map();

// 网关航线记录的键后缀：与生产（system-bodies.ts 的 GW_KEY_SUFFIX）逐字一致。
// 网关离港/进近是**星系内绕行星**段（实测比自然口径低 35-50%），与自然口径几何不同 →
// 键必须区分，否则玩家切换「使用跃迁点」时两套几何互相覆盖。
const GW_KEY_SUFFIX = '#gw';

const key = (a, b) => `${a.toUpperCase()}|${b.toUpperCase()}`;

export function stubSetDepartureRecord(fromBody, toStar, rec) {
  departRecords.set(key(fromBody, toStar), rec);
}
export function stubSetApproachRecord(fromStar, toBody, rec) {
  approachRecords.set(key(fromStar, toBody), rec);
}
// 网关口径的离港/进近记录（键 = 自然键 + '#gw'，即生产写入端 `getDeparture(..., true)`
// 读得到的键）。
export function stubSetGatewayDepartureRecord(fromBody, toStar, rec) {
  departRecords.set(`${key(fromBody, toStar)}${GW_KEY_SUFFIX}`, rec);
}
export function stubSetGatewayApproachRecord(fromStar, toBody, rec) {
  approachRecords.set(`${key(fromStar, toBody)}${GW_KEY_SUFFIX}`, rec);
}
export function stubSetSameSystemRecord(fromBody, toBody, rec) {
  sameSystemRecords.set(key(fromBody, toBody), rec);
}
// 航线级记录（自然口径键 = 出发天体|目标天体）。
export function stubSetRouteRecord(fromBody, toBody, rec) {
  routeRecords.set(key(fromBody, toBody), rec);
}
// 航线级记录的网关口径键（= 自然键 + '#gw'，与生产 GW_KEY_SUFFIX 逐字一致）。
export function stubSetGatewayRouteRecord(fromBody, toBody, rec) {
  routeRecords.set(`${key(fromBody, toBody)}${GW_KEY_SUFFIX}`, rec);
}
export function stubClearStlRecords() {
  departRecords.clear();
  approachRecords.clear();
  sameSystemRecords.clear();
  routeRecords.clear();
}

// 查表口径与生产**逐位一致**（system-bodies.stlSegmentsStore）：
// - 自然（viaGateway=false）：精确键 → 通配回退（'BODY|*' / '*|BODY'，内置批量采集口径）；
// - 网关（viaGateway=true）：只认精确键 'BODY|STAR#gw'，**不回退通配**（通配键是自然口径，
//   用于网关必然高估）。
// ⚠️ 替身必须与生产同口径，否则「routeMetrics 有没有把 viaGateway 传下去」这类用例会因为
// 替身宽容而恒真（假绿）；网关口径的**生产**实现由 scripts/verify-ftc-gateway-stl.mjs
// 直接驱动真实 store（system-bodies.ts）断言。
export const stlSegmentsStore = {
  getDeparture: (fromBody, toStar, viaGateway = false) => {
    const k = key(fromBody, toStar);
    return viaGateway
      ? departRecords.get(`${k}${GW_KEY_SUFFIX}`)
      : (departRecords.get(k) ?? departRecords.get(`${fromBody.toUpperCase()}|*`));
  },
  getApproach: (fromStar, toBody, viaGateway = false) => {
    const k = key(fromStar, toBody);
    return viaGateway
      ? approachRecords.get(`${k}${GW_KEY_SUFFIX}`)
      : (approachRecords.get(k) ?? approachRecords.get(`*|${toBody.toUpperCase()}`));
  },
  getSameSystem: (fromBody, toBody) => sameSystemRecords.get(key(fromBody, toBody)),
  // 航线级总路程（首选几何来源）：自然/网关口径用键后缀区分，**无通配回退**
  // （不存在「通配航线」这种东西 —— 键两端都是具体天体）。
  getRoute: (fromBody, toBody, viaGateway = false) =>
    routeRecords.get(`${key(fromBody, toBody)}${viaGateway ? GW_KEY_SUFFIX : ''}`),
  get routeCount() {
    return routeRecords.size;
  },
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
// 追加恒星（真实实现由游戏 DATA_DATA["systems"] 填充；这里由用例按需登记坐标）。
// 默认仍只有 ZV-307 —— 既有用例的星系解析范围不变。
// 坐标是**合成**的（仓库里没有恒星坐标的内置数据），只用于让 planRoutes 的 pc 权重
// 可算；本文件的用例不断言 pc 数值。
export function stubSetStar(naturalId, position) {
  const id = naturalId.toUpperCase();
  stars.set(id, { naturalId: id, position });
}

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
// 追加「空间站 → 星系」映射（真实来源 public/json/stations.json 的 `s` 字段，另有 5 条：
// MOR→OT-580 / HRT→VH-331 / ARC→AM-783 / BEN→UV-351 / HUB→TD-203）。
// 默认只保留 ANT→ZV-307 —— 既有用例看到的候选集不变（station-reverse 的唯一性守卫用例
// 依赖「ZV-307 恰好 1 个候选」与「ANT 不是星系 id」）。
export function stubSetStation(stationNaturalId, systemId) {
  stationSystems.set(stationNaturalId.toUpperCase(), systemId.toUpperCase());
}

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

// ---- 航线图（真实 planRoutes 的 dijkstra 用）----
// 默认**空图**：既有用例（同星系航线，legs 为空）不访问邻居 → 行为逐位不变。
// 跨星系/网关用例按需注入：生产里这张图由 infrastructure/fio/routes.ts 维护
// （内置 star-connections.json + 观测到的 JUMP_GATEWAY 连接），本替身只接受静态注入 ——
// 用例应当先用**真实** routes.ts 观测一份 JUMP_GATEWAY 计划，再把观测到的连接注入这里
// （见 verify-ftc-gateway-stl.mjs ⑦），而不是手写一对「假网关边」。
const routeNeighbors = new Map();
const gatewayEdges = new Set();
const edgeKey = (a, b) => [a.toUpperCase(), b.toUpperCase()].sort().join('|');
// gateway: [[星系A, 星系B], ...]（无向）。注入的边**全部**是网关边 ——
// 与生产一致：自然（allowGateway=false）的 dijkstra 会跳过它们。
export function stubSetRouteGraph({ gateway = [] } = {}) {
  routeNeighbors.clear();
  gatewayEdges.clear();
  for (const [a, b] of gateway) {
    const ka = a.toUpperCase();
    const kb = b.toUpperCase();
    if (ka === kb) {
      continue;
    }
    gatewayEdges.add(edgeKey(a, b));
    for (const [from, to] of [
      [ka, kb],
      [kb, ka],
    ]) {
      const set = routeNeighbors.get(from) ?? new Set();
      set.add(to);
      routeNeighbors.set(from, set);
    }
  }
}
export const routesStore = {
  getNeighbors: id => [...(routeNeighbors.get(id.toUpperCase()) ?? [])],
  isGatewayEdge: (a, b) => gatewayEdges.has(edgeKey(a, b)),
};

// 原生飞行计划（真实 flightPlansStore 的替身）：默认**空表** —— findNativeFlightPlan 在
// 无计划时返回 undefined，既有用例行为逐位不变。用例按需注入（形状 = SHIP_FLIGHT_MISSION
// 的 FlightPlan：segments[].origin/destination 为 address、首段 departure.timestamp 用于
// 「多条时取最新」）。2026-09-24 追加：用于断言「原生计划匹配要用反查后的实体键
// （metrics.fromLookup/toLookup），用输入原文（星系 id）永远命不中」。
export const flightPlansStore = { all: { value: [] } };
export function stubSetFlightPlans(list) {
  flightPlansStore.all.value.length = 0;
  for (const plan of list) {
    flightPlansStore.all.value.push(plan);
  }
}

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
