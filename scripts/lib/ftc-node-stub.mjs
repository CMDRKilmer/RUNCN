// ftc-compute.ts（FTC 计算编排层）在 Node 下的最小测试替身。
//
// 仅服务于 scripts/verify-ftc-input-consistency.mjs 的「门控集成用例」：
// scripts/lib/ftc-node-loader.mjs 的 resolve 钩子把编排层的浏览器侧依赖
// （vue / @src/* / ./route-planner / ./route-model / ./ftc-fuel-settings）
// 全部重定向到本文件，fuel-model.ts 保留真实实现（纯函数，无浏览器依赖）。
//
// ⚠️ 明确的局限性（避免误读测试结论）：
//   - 浏览星系（browseSystems）、行星环境 JSON（fetchPlanetEnv）、蓝图异步等待
//     （ensureShipBlueprint 的 6s 轮询）在真实环境里都是异步/有副作用的路径，
//     这里一律走「立即返回」的替身 —— 因此本用例覆盖的是
//     「missingModelInputs 判定 → 门控 → 是否写入滑块」这一段编排逻辑，
//     **不**覆盖 DOM 写入、store 真实行为、开窗策略。
//   - 生产代码**没有**为可测性做任何改动（无注入点、无测试开关）。
import { SHIP, DEPART_KM, APPROACH_KM } from './ftc-node-fixtures.mjs';

let currentShip;
let currentBlueprint;
const routes = new Map();

export const sliderWrites = [];
export const reactorWrites = [];

export function stubSetShip(ship) {
  currentShip = ship;
}

export function stubSetBlueprint(blueprint) {
  currentBlueprint = blueprint;
}

export function stubSetRoute(from, to, route, metrics) {
  routes.set(`${from}|${to}`, { route, metrics });
}

export function stubResetWrites() {
  sliderWrites.length = 0;
  reactorWrites.length = 0;
}

// 截图实测飞船（标准引擎 / 罐 3500 / G8 / 空重 1271t），由 fixtures 提供唯一来源。
export const STUB_SHIP = {
  registration: 'STUB-01',
  blueprintNaturalId: 'BP-STUB',
  mass: SHIP.mass,
  operatingEmptyMass: SHIP.operatingEmptyMass,
  acceleration: SHIP.acceleration,
  thrust: 0,
  condition: SHIP.condition,
  stlFuelFlowRate: SHIP.stlFuelFlowRate,
  reactorPower: 0,
  idStlFuelStore: undefined,
  idFtlFuelStore: undefined,
};

// 蓝图性能（字段口径与 blueprintInfoFor 一致：ftlMaxSpeed 是 pc/s）。
export function stubBlueprint(stlFuelCapacity = SHIP.stlFuelCapacity) {
  return {
    performance: {
      ftlMaxSpeed: 2.84 / 3600,
      stlFuelCapacity,
      minReactorUsage: 0.3,
      emitterChargeTime: 135,
      maxGFactor: 8,
    },
    selections: [
      { type: 'STL_ENGINE', option: SHIP.stlEngineOption, amount: 1, modifiers: [] },
      {
        type: 'FTL_REACTOR',
        option: 'FTL_REACTOR_STUB',
        amount: 1,
        modifiers: [{ type: 'FTL_POWER', value: 2400 }],
      },
    ],
  };
}

export function stubMetrics(overrides = {}) {
  return {
    stlDistanceKm: DEPART_KM + APPROACH_KM,
    departKm: DEPART_KM,
    approachKm: APPROACH_KM,
    natPc: 0,
    gwPc: 0,
    gwCount: 0,
    natJumpCount: 0,
    fromBody: 'zv-307a',
    toBody: 'ANT',
    ...overrides,
  };
}

// ---- 以下为被替换模块的导出面 ----

// 'vue'：编排层只用了 ref。
export const ref = value => ({ value });

// '@src/utils/sleep'
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// '@src/infrastructure/prun-api/data/ships'
export const shipsStore = {
  getByRegistration: () => currentShip,
};

// '@src/infrastructure/prun-api/data/blueprints'
export const blueprintsStore = {
  getByNaturalId: () => currentBlueprint,
};

// '@src/infrastructure/prun-api/data/storage'（无油罐 → remaining 全 0）
export const storagesStore = {
  getByAddressableId: () => undefined,
};

// '@src/infrastructure/prun-ui/buffers'
export const showBuffer = async () => {};

// '@src/infrastructure/fio/orbit'
export const hasSystemData = () => true;
export const exportStationOrbits = () => [];

// './route-planner'（几何由测试用例直接给定，绕开真实轨道数据）
export const planRoutes = (from, to) => {
  const entry = routes.get(`${from}|${to}`);
  if (entry === undefined) {
    throw new Error(`stub 未配置航线 ${from}→${to}（请先调 stubSetRoute）`);
  }
  return { natural: entry.route, gateway: undefined };
};
export const routeMetrics = route => route.metrics;
// './route-planner' 的 findNativeFlightPlan：编排层用它回传「服务器当前计划实测总时长」，
// Node 替身没有 flightPlansStore → 恒 undefined（面板不显示该提示），与浏览器行为一致。
export const findNativeFlightPlan = () => undefined;

// './route-model'
export const resolveSystemId = () => undefined;

// './ftc-fuel-settings'（写入即记录，供断言「是否进入写入路径」）。
// 2026-09-23 起键为**航线级**（`船|起点|终点|gw|nat`，见 ftcRouteKey）：写入方传的是
// 拼好的键，故这里记录 key（而不是船名）—— 断言据此确认写入落在哪条航线上。
export const setFtcFuelSlider = (routeKey, value) => {
  sliderWrites.push({ key: routeKey, value });
};
export const setFtcReactorUsage = (routeKey, value) => {
  reactorWrites.push({ key: routeKey, value });
};

// 航线键构造器：格式是 ftc-compute（lastFtcCompute.key）与 ftc-fuel-settings（持久化键）
// 之间的**共享契约**，替身必须同格式，否则这里服务的脚本里「写入键」与真实实现不一致。
// 真实实现由 verify-ftc-route-key.mjs / verify-ftc-slider-cache.mjs 直接驱动；两处的断言
// 都写字面键串（如 'STUB-01|ZV-307A|ANT|nat'），格式漂移会被断言抓住。
export const ftcRouteKey = (ship, from, to, useGateway) =>
  `${ship}|${from.trim().toUpperCase()}|${to.trim().toUpperCase()}|${useGateway ? 'gw' : 'nat'}`;
