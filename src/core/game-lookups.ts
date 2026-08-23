import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { planetsStore } from '@src/infrastructure/prun-api/data/planets';
import { getStarNaturalId, starsStore } from '@src/infrastructure/prun-api/data/stars';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import { getMaterialName } from '@src/infrastructure/prun-ui/i18n';

// A function to compare two planets (to be used in .sort() functions)
export function comparePlanets(idOrNameA: string, idOrNameB: string) {
  const planetA = planetsStore.find(idOrNameA);
  const planetB = planetsStore.find(idOrNameB);
  if (planetA === planetB) {
    return 0;
  }
  if (!planetA) {
    return 1;
  }
  if (!planetB) {
    return -1;
  }

  const systemA = starsStore.getByPlanetNaturalId(planetA.naturalId);
  const systemB = starsStore.getByPlanetNaturalId(planetB.naturalId);
  if (!systemA) {
    return 1;
  }
  if (!systemB) {
    return -1;
  }

  if (systemA !== systemB) {
    const naturalIdA = getStarNaturalId(systemA);
    const naturalIdB = getStarNaturalId(systemB);
    const isSystemANamed = systemA.name !== naturalIdA;
    const isSystemBNamed = systemB.name !== naturalIdB;

    if (isSystemANamed && !isSystemBNamed) {
      return -1;
    }
    if (isSystemBNamed && !isSystemANamed) {
      return 1;
    }
    if (isSystemANamed && isSystemBNamed) {
      return systemA.name > systemB.name ? 1 : -1;
    }
    return naturalIdA > naturalIdB ? 1 : -1;
  }

  const isPlanetANamed = planetA.name !== planetA.naturalId;
  const isPlanetBNamed = planetB.name !== planetB.naturalId;

  if (isPlanetANamed && !isPlanetBNamed) {
    return -1;
  }
  if (isPlanetBNamed && !isPlanetANamed) {
    return 1;
  }

  return isPlanetANamed && isPlanetBNamed
    ? planetA.name > planetB.name
      ? 1
      : -1
    : planetA.naturalId > planetB.naturalId
      ? 1
      : -1;
}

export function extractPlanetName(text: string | null) {
  if (!text) {
    return text;
  }
  text = text
    // Clear parenthesis
    .replace(/\s*\([^)]*\)/, '')
    // Clear space between system and planet
    .replace(/(\d)\s+(?=[a-zA-Z])/, '$1')
    // Clear system name in named systems
    .replace(/.*\s-\s/, '');
  return (stationsStore.getNaturalIdFromName(text) ?? text) as string;
}

export function getMaterialNameByTicker(ticker?: string | null) {
  const material = materialsStore.getByTicker(ticker);
  return getMaterialName(material);
}
