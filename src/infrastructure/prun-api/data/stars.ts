import { onApiMessageForce } from '@src/infrastructure/prun-api/data/api-messages';
import { createEntityStore } from '@src/infrastructure/prun-api/data/create-entity-store';
import { createMapGetter } from '@src/infrastructure/prun-api/data/create-map-getter';
import { sendServerMessage } from '@src/infrastructure/prun-api/socket-io-middleware';
import { companyContextId } from './user-data';

const store = createEntityStore<PrunApi.Star>({ selectId: x => x.systemId });
const state = store.state;
export const starsVersion = ref(0);

function setStars(data: { stars: PrunApi.Star[] }) {
  store.setAll(data.stars);
  store.setFetched();
  starsVersion.value++;
}

// An explicit request may be answered outside the currently selected game context.
onApiMessageForce({ SYSTEM_STARS_DATA: setStars });

/** Request the game's authoritative star map. Call only from an explicit user action. */
export function requestStars(): boolean {
  return sendServerMessage({
    to: 'system-registry',
    messageType: 'SYSTEM_GET_STARS_DATA',
    payload: {},
    actionId: crypto.randomUUID(),
    contextId: companyContextId.value,
  });
}

export function getStarNaturalId(star: PrunApi.Star) {
  return star.address.lines[0].entity!.naturalId;
}

export function getStarName(star: PrunApi.Star) {
  return star.address.lines[0].entity!.name;
}

const getByNaturalId = createMapGetter(state.all, getStarNaturalId);
const getByName = createMapGetter(state.all, getStarName);

const find = (naturalIdOrName?: string | null) =>
  getByNaturalId(naturalIdOrName) ?? getByName(naturalIdOrName);

const getByPlanetNaturalId = (id?: string | null) => getByNaturalId(id?.slice(0, -1));

export const starsStore = {
  ...state,
  getByNaturalId,
  getByName,
  find,
  getByPlanetNaturalId,
};
