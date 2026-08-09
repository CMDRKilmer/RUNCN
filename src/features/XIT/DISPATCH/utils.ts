import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import {
  getLocationLineFromAddress,
  isSameAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { computeResupplyBill } from '@src/features/XIT/ACT/material-groups/resupply/bill';
import { computeRepairBill } from '@src/features/XIT/ACT/material-groups/repair/bill';
import type { MaterialFilter } from '@src/features/XIT/ACT/material-groups/resupply/config';

export interface DispatchBaseConfig {
  resupply: boolean;
  repair: boolean;
  days: number;
  repThreshold: number;
  repAdvance: number;
  materialFilter: MaterialFilter;
  cxBuy: boolean;
  offloadJson: boolean;
  agent: boolean;
  ship?: string;
}

export interface DispatchShip {
  ship: PrunApi.Ship;
  exchangeCode: string;
  warehouseStore?: PrunApi.Store;
  cargoStore?: PrunApi.Store;
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
      { type: 'Resupply', useBaseInv: true },
      naturalId,
      config.days,
      config.materialFilter,
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
        { type: 'Resupply', useBaseInv: true },
        base.naturalId,
        1,
        base.config.materialFilter,
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
        { type: 'Resupply', useBaseInv: true },
        base.naturalId,
        mid,
        base.config.materialFilter,
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
