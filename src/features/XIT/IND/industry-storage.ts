import type { FioBuilding } from '@src/features/XIT/PLAN/fio-buildings';
import type { PlannedBuilding } from '@src/features/XIT/PLAN/tile-state';

interface Capacity {
  weight: number;
  volume: number;
}

const BASE_STORAGE = { weight: 1500, volume: 1500 };
const WAREHOUSE_CAPACITIES: Record<string, Capacity> = {
  STA: { weight: 2500, volume: 2500 },
  STO: { weight: 5000, volume: 5000 },
  STV: { weight: 2500, volume: 7500 },
  STW: { weight: 7500, volume: 2500 },
  STE: { weight: 10000, volume: 10000 },
};

export interface IndustryWarehouses {
  area: number;
  buildings: PlannedBuilding[];
}

export function getIndustryWarehouses(
  catalog: FioBuilding[],
  counts: Partial<Record<string, number>>,
) {
  const options: (Capacity & { ticker: string; count: number; area: number })[] = [];
  const buildings: PlannedBuilding[] = [];
  const capacity = { ...BASE_STORAGE };
  let area = 0;
  for (const [ticker, storage] of Object.entries(WAREHOUSE_CAPACITIES)) {
    const building = catalog.find(x => x.Ticker === ticker);
    if (building === undefined) {
      continue;
    }
    const requested = counts[ticker] ?? 0;
    const count = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 0;
    options.push({ ticker, count, area: building.AreaCost, ...storage });
    if (count > 0) {
      buildings.push({ ticker, count, recipes: [] });
      area += building.AreaCost * count;
      capacity.weight += storage.weight * count;
      capacity.volume += storage.volume * count;
    }
  }
  return { options, area, buildings, capacity };
}

function daysToCapacity(capacity: Capacity, rate: Capacity) {
  const weight = rate.weight > 0 ? capacity.weight / rate.weight : Infinity;
  const volume = rate.volume > 0 ? capacity.volume / rate.volume : Infinity;
  const days = Math.min(weight, volume);
  const limiting = weight <= volume ? 'weight' : 'volume';
  return { days, limiting };
}

export function estimateIndustryStorage(
  capacity: Capacity,
  flows: ReadonlyMap<string, number>,
  getMaterial: (ticker: string) => Capacity | undefined,
) {
  const supplies = { weight: 0, volume: 0 };
  const products = { weight: 0, volume: 0 };
  for (const [ticker, amount] of flows) {
    if (Math.abs(amount) < 1e-8) {
      continue;
    }
    const material = getMaterial(ticker);
    if (
      material === undefined ||
      !Number.isFinite(material.weight) ||
      !Number.isFinite(material.volume) ||
      material.weight < 0 ||
      material.volume < 0
    ) {
      return undefined;
    }
    const rate = amount > 0 ? supplies : products;
    rate.weight += Math.abs(amount) * material.weight;
    rate.volume += Math.abs(amount) * material.volume;
  }

  return {
    products,
    fill: daysToCapacity(capacity, products),
    rotation: daysToCapacity(capacity, {
      weight: Math.max(supplies.weight, products.weight),
      volume: Math.max(supplies.volume, products.volume),
    }),
  };
}
