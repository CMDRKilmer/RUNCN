import { reactive, ref } from 'vue';
export default () => {};
export const fixture = {
  bills: {},
  burns: {},
  products: {},
  supply: {},
  ships: {},
  stores: {},
  production: {},
  analyses: {},
  materials: {},
  stations: {},
  exchanges: {},
  warehouses: {},
};
export const userData = reactive({ chainRuns: {}, actionPackages: [], triggers: [] });
export const sitesStore = {
  all: ref([]),
  getByPlanetNaturalId: id => sitesStore.all.value.find(x => x.siteId === id),
  getByPlanetNaturalIdOrName: id => sitesStore.all.value.find(x => x.siteId === id),
};
export const shipsStore = { all: ref([]), fetched: ref(true), getById: id => fixture.ships[id] };
export const flightsStore = { all: ref([]), getById: () => undefined };
export const stationsStore = {
  all: ref([]),
  getByNaturalId: id => fixture.stations[id],
};
export const exchangesStore = {
  all: ref([]),
  getByNaturalId: id => fixture.exchanges[id],
};
export const starsStore = { all: ref([]) };
export const warehousesStore = {
  all: ref([]),
  getByEntityNaturalId: id => fixture.warehouses[id],
};
export const getStarNaturalId = star => star.systemId;
// 航点地址编码只在按航班推断航线时参与匹配；本套契约不覆盖那条路径。
export const encodeAddress = () => undefined;
export const storagesStore = { getByAddressableId: () => [], getById: id => fixture.stores[id] };
export const productionStore = { getBySiteId: id => fixture.production[id] };
export const materialsStore = {
  getByTicker: ticker => fixture.materials[ticker] ?? { weight: 1, volume: 1 },
};
export const cxobStore = {
  getByTicker: id =>
    fixture.supply[id] === undefined ? undefined : { supply: fixture.supply[id] },
};
export const getPlanetBurn = id => fixture.burns[id];
export const getBaseProducts = id => fixture.products[id];
export const comparePlanets = (a, b) => a.localeCompare(b);
export const getBaseStorageAnalysis = site =>
  fixture.analyses[site?.siteId] ?? { suppliesCapDays: Infinity };
export const combinedBaseBill = (id, config) => {
  const bill = fixture.bills[id];
  return { ...(typeof bill === 'function' ? bill(config) : bill) };
};
export const getEntityNaturalIdFromAddress = address => address?.id;
export const getEntityNameFromAddress = address => address?.id;
export const getSystemLineFromAddress = () => undefined;
export const gameNow = () => 1_000_000;
export const windows = [];
export const showBuffer = async (command, options) => {
  windows.push({ command, options });
};
export const onApiMessage = () => {};
// 强制通道按真实 api-messages 的注册/派发语义实现：航线 socket 写入靠它收响应。
const forceHandlers = new Map();
export const onApiMessageForce = handlers => {
  for (const type of Object.keys(handlers)) {
    const list = forceHandlers.get(type) ?? [];
    list.push(handlers[type]);
    forceHandlers.set(type, list);
  }
};
export function dispatchForce(message) {
  let changed = false;
  for (const handler of forceHandlers.get(message.type) ?? []) {
    if (handler(message.data)) {
      changed = true;
    }
  }
  return changed;
}
export const companyContextId = { value: 'CTX' };
// 客户端→服务器的请求按原样录下，供报文断言；真实发送在这里不发生。
export const socketMessages = [];
export function sendServerMessage(message) {
  socketMessages.push(message);
  return true;
}
// 航点地址编码只在整条航线写入（writeRoute）里参与，本套契约不覆盖那条路径。
export const resolveEntity = async () => undefined;
export const sleep = () => Promise.resolve();
export const estimation = { calls: [], pending: null, result: null };
export async function estimateChainFlightTimes(input) {
  estimation.calls.push(input);
  if (estimation.pending !== null) {
    return estimation.pending;
  }
  if (estimation.result !== null) {
    return estimation.result(input);
  }
  return { ok: false, legs: [], totalHours: 0, approximatedLegs: 0 };
}
export const serializeStorage = store => store.id;
export const fixed0 = n => String(Math.round(n));
let nextId = 0;
export const createId = () => String(++nextId).padStart(10, '0');
export const stripDeletedActions = () => {};
export class HttpError extends Error {}
export const loadSession = () => ({ user: { companyCode: 'TEST' } });
export const transport = { pushes: [], fetches: 0, remote: null, pending: null };
export async function fetchChainSync() {
  transport.fetches++;
  return transport.remote;
}
export async function fetchChainSyncs() {
  transport.fetches++;
  return [];
}
export async function pushChainSync(key, doc, base) {
  transport.pushes.push({ key, doc: structuredClone(doc), base });
  if (transport.pending !== null) {
    await transport.pending;
  }
  return transport.result ?? { ok: true, updatedAt: 1000 + transport.pushes.length };
}
