import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import {
  getLocationLineFromAddress,
  isSameAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { calculatePlanetBurn } from '@src/core/burn';
import { isRepairableBuilding } from '@src/core/buildings';
import { getBuildingLastRepair, sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { workforcesStore } from '@src/infrastructure/prun-api/data/workforces';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { fixed0, fixed01 } from '@src/utils/format';
import { userData } from '@src/store/user-data';

export interface DispatchBaseConfig {
  resupply: boolean;
  repair: boolean;
  days: number;
  repThreshold: number;
  repAdvance: number;
  consumablesOnly: boolean;
  includeConsumables: boolean;
  cxBuy: boolean;
  ship?: string;
}

export interface DispatchShip {
  ship: PrunApi.Ship;
  exchangeCode: string;
  warehouseStore?: PrunApi.Store;
  cargoStore?: PrunApi.Store;
}

export function computeResupplyBill(
  data: { useBaseInv?: boolean; consumablesOnly?: boolean; includeConsumables?: boolean },
  planet: string | undefined,
  days: number | undefined,
): Record<string, number> | undefined {
  if (!planet || days === undefined || isNaN(days)) return undefined;
  const site = sitesStore.getByPlanetNaturalIdOrName(planet);
  if (!site) return undefined;
  const workforce = workforcesStore.getById(site.siteId)?.workforces;
  const production = productionStore.getBySiteId(site.siteId);
  if (workforce === undefined || production === undefined) return undefined;
  const stores = storagesStore.getByAddressableId(site.siteId);
  const planetBurn = calculatePlanetBurn(
    production,
    workforce,
    (data.useBaseInv ?? true) ? stores : undefined,
  );
  const bill: Record<string, number> = {};
  for (const ticker of Object.keys(planetBurn)) {
    const matBurn = planetBurn[ticker];
    if (matBurn.dailyAmount >= 0) continue;
    // Filter by primary demand, mirroring OOG's MaterialFilter semantics:
    // 'Workforce' → consumablesOnly, 'Production' → includeConsumables=false.
    if (data.consumablesOnly && matBurn.workforce === 0) continue;
    if (!data.consumablesOnly && data.includeConsumables === false && matBurn.input === 0) {
      continue;
    }
    const consumed = days * -matBurn.dailyAmount;
    const need = Math.max(0, Math.ceil(consumed - matBurn.inventory + 1));
    if (need > 0) bill[ticker] = need;
  }
  return bill;
}

export function computeRepairBill(
  site: PrunApi.Site,
  thresholdDays: number,
  advanceDays: number,
): Record<string, number> {
  const parsedGroup: Record<string, number> = {};
  for (const building of site.platforms) {
    if (!isRepairableBuilding(building)) continue;
    const lastRepair = getBuildingLastRepair(building);
    const date = (new Date().getTime() - lastRepair) / 86400000;
    if (date + advanceDays < thresholdDays) continue;
    const buildingMaterials: Record<string, number> = {};
    for (const mat of building.reclaimableMaterials) {
      const ticker = mat.material.ticker;
      buildingMaterials[ticker] = (buildingMaterials[ticker] ?? 0) + mat.amount;
    }
    for (const mat of building.repairMaterials) {
      const ticker = mat.material.ticker;
      buildingMaterials[ticker] = (buildingMaterials[ticker] ?? 0) + mat.amount;
    }
    const adjustedDate = date + advanceDays;
    for (const ticker of Object.keys(buildingMaterials)) {
      const amount =
        adjustedDate > 180
          ? buildingMaterials[ticker]
          : Math.ceil((buildingMaterials[ticker] * adjustedDate) / 180);
      parsedGroup[ticker] = (parsedGroup[ticker] ?? 0) + amount;
    }
  }
  return parsedGroup;
}

export function getShipsAtCX(): DispatchShip[] | undefined {
  const ships = shipsStore.all.value;
  if (!ships) {
    return undefined;
  }

  const exchanges = exchangesStore.all.value ?? [];
  const warehouses = warehousesStore.all.value ?? [];
  const result: DispatchShip[] = [];

  for (const ship of ships) {
    const shipAddress = ship.address ?? undefined;
    const location = getLocationLineFromAddress(shipAddress);
    if (location?.type !== 'STATION') {
      continue;
    }

    // Addresses canonicalize stations to their system naturalId — compare entity
    // ids (via isSameAddress / location.entity.id), never naturalIds.
    const exchange = exchanges.find(
      x =>
        isSameAddress(shipAddress, x.address) ||
        getLocationLineFromAddress(x.address)?.entity.id === location.entity.id,
    );
    if (!exchange) {
      continue;
    }

    const warehouse = warehouses.find(
      x =>
        isSameAddress(shipAddress, x.address) ||
        getLocationLineFromAddress(x.address)?.entity.id === location.entity.id,
    );
    const warehouseStore = warehouse
      ? storagesStore
          .getByAddressableId(warehouse.warehouseId)
          ?.find(x => x.type === 'WAREHOUSE_STORE')
      : undefined;
    const cargoStore = storagesStore
      .getByAddressableId(ship.id)
      ?.find(x => x.type === 'SHIP_STORE');

    result.push({
      ship,
      exchangeCode: exchange.code,
      warehouseStore,
      cargoStore,
    });
  }

  return result;
}

export function billTotals(entries: Record<string, number>) {
  let weight = 0;
  let volume = 0;
  for (const [ticker, amount] of Object.entries(entries)) {
    const mat = materialsStore.getByTicker(ticker);
    if (mat) {
      weight += mat.weight * amount;
      volume += mat.volume * amount;
    }
  }
  return { weight, volume };
}

export function mergeBills(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!a && !b) {
    return undefined;
  }
  const result: Record<string, number> = { ...(a ?? {}) };
  if (b) {
    for (const [ticker, amount] of Object.entries(b)) {
      result[ticker] = (result[ticker] ?? 0) + amount;
    }
  }
  return result;
}

export function combinedBaseBill(
  naturalId: string,
  config: DispatchBaseConfig,
  site: PrunApi.Site,
): Record<string, number> | undefined {
  if (!config.resupply && !config.repair) {
    return undefined;
  }

  let resupply: Record<string, number> | undefined;
  if (config.resupply) {
    resupply = computeResupplyBill(
      {
        useBaseInv: true,
        consumablesOnly: config.consumablesOnly,
        includeConsumables: config.includeConsumables,
      },
      naturalId,
      config.days,
    );
    // Burn data not loaded yet.
    if (resupply === undefined) {
      return undefined;
    }
  }

  let repair: Record<string, number> | undefined;
  if (config.repair) {
    repair = computeRepairBill(site, config.repThreshold, config.repAdvance);
  }

  return mergeBills(resupply, repair);
}

// Groups rows assigned to the same ship together: when a base is assigned a
// ship that already has an earlier base in `order`, it moves immediately
// after that ship's last grouped row instead of staying wherever it was.
export function regroupByShip(order: string[], shipOf: Map<string, string>): string[] {
  const result: string[] = [];
  const lastIndexForShip = new Map<string, number>();
  for (const id of order) {
    const ship = shipOf.get(id);
    if (ship && lastIndexForShip.has(ship)) {
      const insertAt = lastIndexForShip.get(ship)! + 1;
      result.splice(insertAt, 0, id);
      for (const [otherShip, index] of lastIndexForShip) {
        if (index >= insertAt) {
          lastIndexForShip.set(otherShip, index + 1);
        }
      }
      lastIndexForShip.set(ship, insertAt);
    } else {
      result.push(id);
      if (ship) {
        lastIndexForShip.set(ship, result.length - 1);
      }
    }
  }
  return result;
}

export function fitDaysForShip(
  shipId: string,
  bases: { naturalId: string; config: DispatchBaseConfig; site: PrunApi.Site }[],
  cargoStore: PrunApi.Store,
): number | undefined {
  const sharing = bases.filter(x => x.config.ship === shipId);

  let repairWeight = 0;
  let repairVolume = 0;
  for (const base of sharing) {
    if (!base.config.repair) {
      continue;
    }
    const bill = computeRepairBill(base.site, base.config.repThreshold, base.config.repAdvance);
    const totals = billTotals(bill);
    repairWeight += totals.weight;
    repairVolume += totals.volume;
  }

  const freeWeight = cargoStore.weightCapacity - cargoStore.weightLoad - repairWeight;
  const freeVolume = cargoStore.volumeCapacity - cargoStore.volumeLoad - repairVolume;
  if (freeWeight < 0 || freeVolume < 0) {
    return 0;
  }

  // Quick check that burn data is loaded for every resupply base.
  for (const base of sharing) {
    if (!base.config.resupply) {
      continue;
    }
    if (
      !computeResupplyBill(
        {
          useBaseInv: true,
          consumablesOnly: base.config.consumablesOnly,
          includeConsumables: base.config.includeConsumables,
        },
        base.naturalId,
        1,
      )
    ) {
      return undefined;
    }
  }

  let lo = 0;
  let hi = 999;
  while (lo < hi) {
    const mid = lo + Math.ceil((hi - lo) / 2);
    let weight = 0;
    let volume = 0;
    let fits = true;
    for (const base of sharing) {
      if (!base.config.resupply) {
        continue;
      }
      const entries = computeResupplyBill(
        {
          useBaseInv: true,
          consumablesOnly: base.config.consumablesOnly,
          includeConsumables: base.config.includeConsumables,
        },
        base.naturalId,
        mid,
      )!;
      const totals = billTotals(entries);
      weight += totals.weight;
      volume += totals.volume;
      if (weight > freeWeight || volume > freeVolume) {
        fits = false;
        break;
      }
    }
    if (fits) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

export function formatBurnDays(days: number) {
  if (days > 999) return '∞';
  if (days >= 10) return fixed0(Math.floor(days));
  return fixed01(days);
}

export function burnDaysClass(days: number) {
  const flooredDays = Math.floor(days);
  return {
    [C.Workforces.daysMissing]: flooredDays <= userData.settings.burn.red,
    [C.Workforces.daysWarning]: flooredDays <= userData.settings.burn.yellow,
    [C.Workforces.daysSupplied]: flooredDays > userData.settings.burn.yellow,
  };
}
