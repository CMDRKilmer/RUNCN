import { createEntityStore } from '@src/infrastructure/prun-api/data/create-entity-store';
import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';
import { createMapGetter } from '@src/infrastructure/prun-api/data/create-map-getter';
import { request } from '@src/infrastructure/prun-api/data/request-hooks';

const store = createEntityStore<PrunApi.Experts>({ selectId: x => x.siteId });
const state = store.state;
const requestedSites = reactive(new Set<string>());

onApiMessage({
  CLIENT_CONNECTION_OPENED() {
    requestedSites.clear();
  },
  EXPERTS_EXPERTS(data: PrunApi.Experts) {
    store.setOne(data);
    store.setFetched();
  },
});

const getBySiteId = (value?: string | null) => {
  const result = getMap(value);
  if (result !== undefined) {
    return result;
  }
  if (!value) {
    return undefined;
  }
  if (requestedSites.has(value)) {
    return undefined;
  }
  requestedSites.add(value);
  request.experts(value);
  return undefined;
};

const getMap = createMapGetter(state.all, x => x.siteId);

export const expertsStore = {
  ...state,
  getBySiteId,
};
