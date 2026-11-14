// native-route-btf.ts（原生 RT 的 BTF 试飞）在 Node 下的测试替身。
//
// 仅服务 scripts/verify-native-route-btf.mjs：scripts/lib/native-route-btf-loader.mjs 的
// resolve 钩子把 socket 试飞 / 蓝图 / 地址解析 / FTC / 提示重定向到本文件，
// fuel-model 与 native-route-plan 保留真实实现（纯函数，无浏览器依赖）。
//
// ⚠️ 局限性：服务器的判定与 status 取值不在覆盖范围——calculateTestFlight 返回什么完全由用例给定。

const DEFAULT_PERFORMANCE = {
  stlFuelFlowRate: 0.0075,
  stlFuelCapacity: 3500,
  minReactorUsage: 0.58,
};

let fuel = { stlRemaining: 0, ftlRemaining: 0, stlCap: 0, ftlCap: 0 };
let responses = [];

// 每次试飞请求的入参；未携带的字段记为 '<missing>'（undefined 顶掉基线默认值正是要抓的 bug）。
export const requests = [];

export function stubReset(nextFuel, plans) {
  fuel = { stlRemaining: 0, ftlRemaining: 0, stlCap: 0, ftlCap: 0, ...nextFuel };
  responses = [...plans];
  requests.length = 0;
}

// ---- 以下为被替换模块的导出面 ----

export async function calculateTestFlight(
  _origin,
  _destination,
  _blueprintId,
  _timeout,
  overrides,
) {
  requests.push({
    stlFuel: 'stlFuel' in overrides ? overrides.stlFuel : '<missing>',
    ftlFuel: 'ftlFuel' in overrides ? overrides.ftlFuel : '<missing>',
    payload: overrides.payload,
    reactorUsageFactor: overrides.reactorUsageFactor,
  });
  return responses.length > 0 ? responses.shift() : undefined;
}

export const encodeAddress = () => 'encoded-address';
export const resolveEntity = async () => ({ lines: [] });
export const setTestFlightSample = () => {};
export const blueprintsStore = { getByNaturalId: () => ({ id: 'bp-1' }) };
export const ensureShipBlueprint = async () => true;
export const shipFuelRemainingFor = () => fuel;
export const shipPerformanceFor = () => DEFAULT_PERFORMANCE;
export const summarizeNativeFlightPlan = () => ({ totalSeconds: 3600, stlFuel: 10, ftlFuel: 2 });
export const sleep = async () => {};
export const recordTransitSpeedSample = () => {};
