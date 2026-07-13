import { castArray } from '@src/utils/cast-array';
import { PlatformProduction, PlanetProduction } from '@src/core/production';

interface ProductionFilters {
  production: boolean;
  inactive: boolean;
  queue: boolean;
  notQueued: boolean;
}

const LOW_EFFICIENCY_THRESHOLD = 0.8;

export function getPlanetMinEfficiency(planet: PlanetProduction): number {
  if (planet.production.length === 0) {
    return 1;
  }
  return Math.min(...planet.production.map(x => x.efficiency));
}

export function getPlanetMinCondition(planet: PlanetProduction): number {
  if (planet.production.length === 0) {
    return 1;
  }
  return Math.min(...planet.production.map(x => x.condition));
}

export function isLowEfficiency(line: PlatformProduction): boolean {
  return line.efficiency < LOW_EFFICIENCY_THRESHOLD;
}

export function matchesProductionFilter(
  lines: Arrayable<PlatformProduction>,
  filters: ProductionFilters,
) {
  let activeCapacity = 0;
  let inactiveCapacity = 0;
  let queuedOrders = 0;

  for (const line of castArray(lines)) {
    activeCapacity += line.activeCapacity;
    inactiveCapacity += line.inactiveCapacity;
    queuedOrders += line.queuedOrders.length;
  }

  if (activeCapacity > 0 && filters.production) {
    return true;
  }
  if (inactiveCapacity > 0 && filters.inactive) {
    return true;
  }
  if (queuedOrders > 0 && filters.queue) {
    return true;
  }
  if (queuedOrders === 0 && filters.notQueued) {
    return true;
  }

  return false;
}
