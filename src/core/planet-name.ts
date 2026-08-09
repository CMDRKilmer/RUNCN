import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { planetsStore } from '@src/infrastructure/prun-api/data/planets';

// Natural id -> the name the player actually reads: their own nickname for a planet they
// have a base on, the catalogue name otherwise. Idempotent (a name passed in comes back
// out) and falls back to the input, so a display string is never empty.
export function getPlanetName(naturalIdOrName: string): string {
  const site = sitesStore.getByPlanetNaturalIdOrName(naturalIdOrName);
  const name = getEntityNameFromAddress(site?.address);
  return name ?? planetsStore.find(naturalIdOrName)?.name ?? naturalIdOrName;
}
