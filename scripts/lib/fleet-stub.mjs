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
};
export const userData = reactive({ chainRuns: {}, actionPackages: [], triggers: [] });
export const sitesStore = {
  all: ref([]),
  getByPlanetNaturalId: id => sitesStore.all.value.find(x => x.siteId === id),
};
export const shipsStore = { all: ref([]), fetched: ref(true), getById: id => fixture.ships[id] };
export const flightsStore = { getById: () => undefined };
export const stationsStore = { getByNaturalId: () => undefined };
export const storagesStore = { getByAddressableId: () => [], getById: id => fixture.stores[id] };
export const productionStore = { getBySiteId: id => fixture.production[id] };
export const materialsStore = { getByTicker: () => ({ weight: 1, volume: 1 }) };
export const cxobStore = {
  getByTicker: id =>
    fixture.supply[id] === undefined ? undefined : { supply: fixture.supply[id] },
};
export const getPlanetBurn = id => fixture.burns[id];
export const getBaseProducts = id => fixture.products[id];
export const comparePlanets = (a, b) => a.localeCompare(b);
export const getBaseStorageAnalysis = site =>
  fixture.analyses[site?.siteId] ?? { suppliesCapDays: Infinity };
export const combinedBaseBill = id => ({ ...fixture.bills[id] });
export const getEntityNaturalIdFromAddress = address => address?.id;
export const getEntityNameFromAddress = address => address?.id;
export const getSystemLineFromAddress = () => undefined;
export const gameNow = () => 1_000_000;
export const windows = [];
export const showBuffer = async (command, options) => {
  windows.push({ command, options });
};
export const onApiMessage = () => {};
export const estimation = { calls: [], pending: null };
export async function estimateChainFlightTimes(input) {
  estimation.calls.push(input);
  if (estimation.pending !== null) {
    return estimation.pending;
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
