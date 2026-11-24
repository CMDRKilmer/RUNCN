import { computed, ref, watch } from 'vue';
import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';
import { userDataStore } from '@src/infrastructure/prun-api/data/user-data';
import { sleep } from '@src/utils/sleep';
import { collectNativeRoutes, type RunningRoutes } from './native-route-game';
import { nativeRouteRecords } from './native-route-registry';
import { hasPendingRouteRequest, socketGetRoutes, type RouteData } from './native-route-socket';

export const gameRouteDefinitions = ref<RouteData[]>();
export const gameRunningRoutes = ref<RunningRoutes>();
export const gameRouteReadFailed = ref(false);

watch(
  () => userDataStore.companyId,
  () => {
    gameRouteDefinitions.value = undefined;
    gameRunningRoutes.value = undefined;
    gameRouteReadFailed.value = false;
  },
  { flush: 'sync' },
);

onApiMessage({
  SHIP_ROUTES_ROUTES(data: { routes?: RouteData[] }) {
    if (Array.isArray(data.routes)) {
      gameRouteDefinitions.value = data.routes;
    }
  },
  SHIP_ROUTES_ROUTE(route: RouteData) {
    const routes = gameRouteDefinitions.value;
    if (routes !== undefined) {
      gameRouteDefinitions.value = routes.some(x => x.id === route.id)
        ? routes.map(x => (x.id === route.id ? route : x))
        : [...routes, route];
    }
  },
});

let pendingRead: { companyId: string; request: Promise<void> } | undefined;

export function ensureGameRouteDefinitions(): Promise<void> {
  const companyId = userDataStore.companyId;
  if (!companyId || gameRouteDefinitions.value !== undefined) {
    return Promise.resolve();
  }
  if (pendingRead?.companyId === companyId) {
    return pendingRead.request;
  }

  gameRouteReadFailed.value = false;
  const needsRead = () =>
    userDataStore.companyId === companyId && gameRouteDefinitions.value === undefined;
  const request = (async () => {
    // Wait for RT writes or an existing list request before sharing the socket response channel.
    while (needsRead() && hasPendingRouteRequest()) {
      await sleep(250);
    }
    if (needsRead()) {
      const routes = await socketGetRoutes();
      if (needsRead()) {
        gameRouteDefinitions.value = routes;
      }
    }
  })()
    .catch(() => {
      if (needsRead()) {
        gameRouteReadFailed.value = true;
      }
    })
    .finally(() => {
      if (pendingRead?.request === request) {
        pendingRead = undefined;
      }
    });
  pendingRead = { companyId, request };
  return request;
}

export const liveNativeRoutes = computed(() => {
  const definitions = gameRouteDefinitions.value;
  const executions = gameRunningRoutes.value;
  if (definitions === undefined || executions === undefined) {
    return collectNativeRoutes(nativeRouteRecords.value, executions, definitions);
  }
  // RTE can lag a refresh from either panel. Always read waypoint data from the latest definitions.
  const definitionsById = new Map(definitions.map(x => [x.id, x]));
  const entries = executions.entries.flatMap(x => {
    const route = definitionsById.get(x.route.id);
    return route === undefined ? [] : [{ ...x, route }];
  });
  return collectNativeRoutes(nativeRouteRecords.value, { ...executions, entries }, definitions);
});
