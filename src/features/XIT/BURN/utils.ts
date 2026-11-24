import type { MaterialBurn, PlanetBurn } from '@src/core/burn';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { sortMaterials } from '@src/core/sort-materials';

export function getSortedTickers(burn: PlanetBurn) {
  const materials = Object.keys(burn.burn).map(materialsStore.getByTicker);
  return sortMaterials(materials.filter(x => x !== undefined));
}

export type BurnReportRow = Pick<MaterialBurn, 'remainingAllocation' | 'workforce'> & {
  [K in 'input' | 'output' | 'inventory' | 'dailyAmount' | 'daysLeft']: number | undefined;
};

export type BurnReportSection = Omit<PlanetBurn, 'burn'> & {
  burn: Record<string, BurnReportRow>;
  exchangeCode?: string;
};

export function countDays(burn: Record<string, Pick<BurnReportRow, 'dailyAmount' | 'daysLeft'>>) {
  let days = 1000;
  for (const { dailyAmount, daysLeft } of Object.values(burn)) {
    if (dailyAmount !== undefined && dailyAmount < 0 && daysLeft !== undefined && daysLeft < days) {
      days = daysLeft;
    }
  }
  return days;
}
