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
  addresses: {},
};
export const userData = reactive({ actionPackages: [], triggers: [] });
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
export const encodeAddress = address => address?.encoded;
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
export const userDataStore = reactive({ companyId: '' });
// 客户端→服务器的请求按原样录下，供报文断言；真实发送在这里不发生。
export const socketMessages = [];
export function sendServerMessage(message) {
  socketMessages.push(message);
  return true;
}
export const resolveEntity = async naturalId => fixture.addresses[naturalId];
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
export const fixed0 = n => String(Math.round(n));
export const getInvStore = () => undefined;
export const tilesStore = {};
