import { exchangeBurn } from './burn-totals';
import { exchangeBurnNeeds } from './burn-purchase';
import type { BurnReportSection } from './utils';
import { getPlanetBurn, getResupplyDays, type BurnValues } from '@src/core/burn';
import {
  ensureGameRouteDefinitions,
  gameRouteDefinitions,
  gameRouteReadFailed,
  liveNativeRoutes,
} from '@src/features/XIT/FLEET/native-route-live';
import { readOriginStock } from '@src/features/XIT/FLEET/native-route-purchase';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { userDataStore } from '@src/infrastructure/prun-api/data/user-data';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';

export function useExchangeBurn(
  code: string | undefined,
  filterBurn: (burn: BurnValues) => BurnValues,
  targetDays: () => number | undefined = () => getResupplyDays() ?? 10,
) {
  const exchangeCode = code?.toUpperCase();
  const origin = computed(() => exchangesStore.getNaturalIdFromCode(exchangeCode)?.toUpperCase());
  watch(
    [origin, () => userDataStore.companyId],
    ([location, companyId]) => {
      if (location !== undefined && companyId) {
        void ensureGameRouteDefinitions();
      }
    },
    { immediate: true },
  );
  const warehouse = computed(() => warehousesStore.getByEntityNaturalId(origin.value));
  const burn = computed(() => {
    const location = origin.value;
    if (
      location === undefined ||
      gameRouteDefinitions.value === undefined ||
      sitesStore.all.value === undefined
    ) {
      return undefined;
    }
    const storeId = warehouse.value?.storeId;
    const stockReady =
      storeId === undefined
        ? warehousesStore.fetched.value
        : storagesStore.getById(storeId) !== undefined;
    return exchangeBurn(
      location,
      liveNativeRoutes.value,
      naturalId => {
        const site = sitesStore.getByPlanetNaturalIdOrName(naturalId);
        if (site === undefined) {
          return undefined;
        }
        const base = getPlanetBurn(site);
        return {
          siteId: site.siteId,
          burn: base === undefined ? undefined : filterBurn(base.burn),
        };
      },
      stockReady ? readOriginStock(location) : undefined,
    );
  });

  const needs = computed(() => {
    const days = targetDays();
    if (burn.value === undefined || days === undefined || !Number.isFinite(days)) {
      return undefined;
    }
    return exchangeBurnNeeds(burn.value, Math.max(0, days));
  });

  const section = computed<BurnReportSection | undefined>(() => {
    if (origin.value === undefined) {
      return undefined;
    }
    return {
      exchangeCode,
      planetName: `CX ${exchangeCode}`,
      naturalId: '',
      siteId: '',
      storeId: warehouse.value?.storeId ?? '',
      burn: burn.value ?? {},
    };
  });

  const notice = computed(() => {
    if (section.value === undefined) {
      return '请输入有效的交易所代码，例如 XIT BURN CX AI1。';
    }
    if (gameRouteDefinitions.value === undefined) {
      return gameRouteReadFailed.value ? '读取游戏航线失败。' : '正在读取游戏航线。';
    }
    if (burn.value === undefined) {
      return '正在读取航线基地的 BURN 数据。';
    }
    return '';
  });

  return { section, needs, notice };
}
