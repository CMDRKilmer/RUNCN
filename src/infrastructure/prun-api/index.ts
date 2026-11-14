import { startRelay } from '@src/infrastructure/prun-api/relay';
import {
  initialApiLoadingComplete,
  listenPrunApi,
} from '@src/infrastructure/prun-api/prun-api-listener';
import { loadFallbackPlanetData, preloadFioResponses } from '@src/infrastructure/fio/fio-api';
import { watchUntil } from '@src/utils/watch';
import { companyStore } from '@src/infrastructure/prun-api/data/company';
import { alertsStore } from '@src/infrastructure/prun-api/data/alerts';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { uiDataStore } from '@src/infrastructure/prun-api/data/ui-data';
import { balancesStore } from '@src/infrastructure/prun-api/data/balances';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { starsStore } from '@src/infrastructure/prun-api/data/stars';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import { companyContextId } from '@src/infrastructure/prun-api/data/user-data';
import { context } from '@src/infrastructure/prun-api/data/screens';
import { fetchPrices } from '@src/infrastructure/fio/cx';
import { sleep } from '@src/utils/sleep';

export async function initializeApi() {
  startRelay();
  void fetchPrices();
  preloadFioResponses();
  listenPrunApi();
  const startupStores = [
    alertsStore,
    balancesStore,
    contractsStore,
    flightsStore,
    materialsStore,
    shipsStore,
    sitesStore,
    starsStore,
    storagesStore,
    warehousesStore,
  ];
  const ready = () =>
    uiDataStore.screens !== undefined &&
    companyStore.value !== undefined &&
    startupStores.every(x => x.fetched.value);

  // 政府管理视图（URL 带 `context=<管理机构 id>`）里，服务器只推政府 / 行星范围的
  // 数据，公司私有数据（COMPANY_DATA / SITE_DATA / STORAGE_DATA…）根本不下发。
  // 照旧全量等待会永远不返回 → features.init() 不执行 → 主题和所有功能都不加载
  // （现象就是「政府管理视图没加载到插件、主题覆盖不到」）。这种上下文退化为
  // 「等到界面数据就继续」，再用短超时兜底，让主题与插件照常起来。
  const isForeignContext = () =>
    context.value !== undefined &&
    companyContextId.value !== undefined &&
    context.value !== companyContextId.value;

  await watchUntil(() => ready() || isForeignContext());
  if (!ready()) {
    await Promise.race([watchUntil(() => uiDataStore.screens !== undefined), sleep(8000)]);
    console.warn(
      'refined-prun: 非公司上下文（政府管理视图），公司私有数据未下发，用已到的数据继续初始化',
    );
  }
  await loadFallbackPlanetData();
}

export function finishApiInitialization() {
  initialApiLoadingComplete.value = true;
}
