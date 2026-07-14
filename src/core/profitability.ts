import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { workforcesStore } from '@src/infrastructure/prun-api/data/workforces';
import { sumMaterialAmountPrice } from '@src/infrastructure/fio/cx';
import { sumBy } from '@src/utils/sum-by';
import { mergeMaterialAmounts } from '@src/core/sort-materials';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { calcBuildingMarketValue, isRepairableBuilding } from '@src/core/buildings';
import { getRecurringOrders } from '@src/core/orders';

export interface ProfitabilityEntry {
  name: string;
  cost: number;
  workforceCost: number;
  materialCost: number;
  repairs: number;
  revenue: number;
  profit: number;
  margin: number;
}

export function calculateSiteProfitability(site: PrunApi.Site): ProfitabilityEntry | undefined {
  const production = productionStore.getBySiteId(site.siteId);
  const workforce = workforcesStore.getById(site.siteId);
  const workforceInputs: PrunApi.MaterialAmount[] = [];
  const productionInputs: PrunApi.MaterialAmount[] = [];
  const outputs: PrunApi.MaterialAmount[] = [];

  if (!workforce) {
    return undefined;
  }

  for (const need of workforce.workforces.flatMap(x => x.needs)) {
    workforceInputs.push({
      material: need.material,
      amount: need.unitsPerInterval,
    });
  }

  const msInADay = 86400000;

  if (production) {
    for (const line of production) {
      const queuedOrders = getRecurringOrders(line);
      const totalDuration = sumBy(queuedOrders, x => x.duration?.millis ?? Infinity);

      for (const order of queuedOrders) {
        for (const mat of order.inputs) {
          productionInputs.push({
            material: mat.material,
            amount: (mat.amount * line.capacity * msInADay) / totalDuration,
          });
        }

        for (const mat of order.outputs) {
          outputs.push({
            material: mat.material,
            amount: (mat.amount * line.capacity * msInADay) / totalDuration,
          });
        }
      }
    }
  }

  const workforceCost = sumMaterialAmountPrice(mergeMaterialAmounts(workforceInputs));
  const materialCost = sumMaterialAmountPrice(mergeMaterialAmounts(productionInputs));
  const revenue = sumMaterialAmountPrice(mergeMaterialAmounts(outputs));

  if (revenue === undefined || workforceCost === undefined || materialCost === undefined) {
    return undefined;
  }

  const cost = workforceCost + materialCost;

  let repairs = 0;
  const oneDayDegradation = 1 / 180;
  const calculatedMarketValue = new Map<string, number>();
  for (const building of site.platforms) {
    if (!isRepairableBuilding(building) || building.condition === 0) {
      continue;
    }

    const ticker = building.module.reactorTicker;
    let marketValue = calculatedMarketValue.get(ticker);
    if (marketValue === undefined) {
      marketValue = calcBuildingMarketValue(building, site);
      if (marketValue === undefined) {
        return undefined;
      }
      calculatedMarketValue.set(ticker, marketValue);
    }
    repairs += marketValue * oneDayDegradation;
  }

  const profit = revenue - cost - repairs;
  const margin = revenue !== 0 ? profit / revenue : 0;
  return {
    name: getEntityNameFromAddress(site.address)!,
    cost,
    workforceCost,
    materialCost,
    repairs,
    revenue,
    profit,
    margin,
  };
}
