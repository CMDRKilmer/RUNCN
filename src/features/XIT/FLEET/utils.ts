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
import type { MaterialBurn } from '@src/core/burn';
import { clampTargetDays, getSuppliesCap } from '@src/features/XIT/FLEET/supplies-cap';
import { isRepairableBuilding } from '@src/core/buildings';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { workforcesStore } from '@src/infrastructure/prun-api/data/workforces';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { fixed0, fixed01 } from '@src/utils/format';
import { userData } from '@src/store/user-data';

export type BraAdvance = 'now' | '24' | '48';

export interface DispatchBaseConfig {
  resupply: boolean;
  repair: boolean;
  days: number;
  repAdvance: BraAdvance;
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

interface ResupplyFilter {
  useBaseInv?: boolean;
  consumablesOnly?: boolean;
  includeConsumables?: boolean;
}

function getPlanetBurnForResupply(data: ResupplyFilter, planet: string | undefined) {
  if (!planet) return undefined;
  const site = sitesStore.getByPlanetNaturalIdOrName(planet);
  if (!site) return undefined;
  const workforce = workforcesStore.getById(site.siteId)?.workforces;
  const production = productionStore.getBySiteId(site.siteId);
  if (workforce === undefined || production === undefined) return undefined;
  const stores = storagesStore.getByAddressableId(site.siteId);
  return calculatePlanetBurn(production, workforce, (data.useBaseInv ?? true) ? stores : undefined);
}

function isResupplyMaterial(mat: MaterialBurn, data: ResupplyFilter) {
  if (mat.dailyAmount >= 0) return false;
  // 两个独立开关:
  //   consumablesOnly       → 是否纳入 workforce 消耗的物资(消耗品)
  //   includeConsumables    → 是否纳入 production 消耗的物资(原料)
  // 默认两者都开,任何一类有需求就纳入。
  if (data.consumablesOnly === false && mat.workforce > 0 && mat.input === 0) {
    return false;
  }
  if (data.includeConsumables === false && mat.input > 0 && mat.workforce === 0) {
    return false;
  }
  return true;
}

// 基地过滤后净消耗物料的最小库存可用天数(与补给账单口径一致)。
// 库存口径与 BURN/ACT Resupply 对齐：只看 matBurn.inventory，不计
// remainingAllocation，使 fitDaysForShip 算出的饱和点与实际账单一致。
// 数据未加载时返回 undefined；无净消耗物料时返回 Infinity。
export function getBaseInventoryDays(data: ResupplyFilter, planet: string | undefined) {
  const planetBurn = getPlanetBurnForResupply(data, planet);
  if (!planetBurn) return undefined;
  let days = Infinity;
  for (const ticker of Object.keys(planetBurn)) {
    const mat = planetBurn[ticker];
    if (!isResupplyMaterial(mat, data)) continue;
    const dailyConsume = -mat.dailyAmount;
    if (dailyConsume <= 0) continue;
    const invDays = mat.inventory > 0 ? mat.inventory / dailyConsume : 0;
    days = Math.min(days, invDays);
  }
  return days;
}

export function computeResupplyBill(
  data: ResupplyFilter,
  planet: string | undefined,
  days: number | undefined,
): Record<string, number> | undefined {
  if (days === undefined || isNaN(days)) return undefined;
  const planetBurn = getPlanetBurnForResupply(data, planet);
  if (!planetBurn) return undefined;
  const site = planet ? sitesStore.getByPlanetNaturalIdOrName(planet) : undefined;
  if (!site) return undefined;
  // days 与 BURN/ACT Resupply 一致：总目标天数（补到第 N 天），
  // 不是「再补 N 天」。库存口径：只看 matBurn.inventory，不计 remainingAllocation。
  // suppliesCapDays：补后总天数不得超出此值，防止补给填满仓库导致产出无处存放；
  // analysis 未加载时不限制。超出则钳制到 cap。
  const targetDays = clampTargetDays(days, getSuppliesCap(site));
  if (targetDays <= 0) return {};
  const useBaseInv = data.useBaseInv ?? true;
  const bill: Record<string, number> = {};
  for (const ticker of Object.keys(planetBurn)) {
    const matBurn = planetBurn[ticker];
    if (!isResupplyMaterial(matBurn, data)) continue;
    const dailyConsume = -matBurn.dailyAmount;
    if (dailyConsume <= 0) continue;
    // 与 BURN/ACT Resupply 公式一致：days * dailyConsume - inventory。
    // inventory 已在 storage 计算时累加进 matBurn.inventory，无需再访问 store。
    const inventory = useBaseInv ? matBurn.inventory : 0;
    if (useBaseInv && inventory >= targetDays * dailyConsume) continue;
    const rawRequired = targetDays * dailyConsume - inventory;
    const required = Math.max(0, rawRequired);
    if (required <= 0) continue;
    bill[ticker] = Math.ceil(required);
  }
  return bill;
}

export function computeRepairBill(site: PrunApi.Site, advance: BraAdvance): Record<string, number> {
  // 维修材料直接读取 BRA 数据（repairMaterials 系列），不再自行按阈值/提前折算。
  const key =
    advance === '24'
      ? 'repairMaterials24'
      : advance === '48'
        ? 'repairMaterials48'
        : 'repairMaterials';
  const parsedGroup: Record<string, number> = {};
  for (const building of site.platforms) {
    if (!isRepairableBuilding(building)) continue;
    for (const mat of building[key] ?? []) {
      const ticker = mat.material.ticker;
      parsedGroup[ticker] = (parsedGroup[ticker] ?? 0) + mat.amount;
    }
  }
  // 扣除基地现成库存，只计算实际缺口（与 BRA 生成维修 ACT 的行为一致）。
  const baseStore = storagesStore.getByAddressableId(site.siteId)?.find(x => x.type === 'STORE');
  if (baseStore) {
    const inventory: Record<string, number> = {};
    for (const item of baseStore.items) {
      if (item.quantity) {
        inventory[item.quantity.material.ticker] = item.quantity.amount;
      }
    }
    for (const ticker of Object.keys(parsedGroup)) {
      const need = Math.max(0, parsedGroup[ticker] - (inventory[ticker] ?? 0));
      if (need > 0) {
        parsedGroup[ticker] = need;
      } else {
        delete parsedGroup[ticker];
      }
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
    repair = computeRepairBill(site, config.repAdvance);
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
    const bill = computeRepairBill(base.site, base.config.repAdvance);
    const totals = billTotals(bill);
    repairWeight += totals.weight;
    repairVolume += totals.volume;
  }

  const freeWeight = cargoStore.weightCapacity - cargoStore.weightLoad - repairWeight;
  const freeVolume = cargoStore.volumeCapacity - cargoStore.volumeLoad - repairVolume;
  if (freeWeight < 0 || freeVolume < 0) {
    return 0;
  }

  const fits = (days: number) => {
    let weight = 0;
    let volume = 0;
    for (const base of sharing) {
      if (!base.config.resupply) {
        continue;
      }
      const entries = computeResupplyBill(base.config, base.naturalId, days)!;
      const totals = billTotals(entries);
      weight += totals.weight;
      volume += totals.volume;
      if (weight > freeWeight || volume > freeVolume) {
        return false;
      }
    }
    return true;
  };

  // 各补给基地的库存可用天数(同时验证消耗数据已加载),
  // 以及账单饱和点:目标天数达到 suppliesCapDays 后该基地账单不再增长。
  // 与 computeResupplyBill 语义对齐：days 为总目标天数（补到第 N 天）。
  let saturation = 0;
  let hasResupply = false;
  for (const base of sharing) {
    if (!base.config.resupply) {
      continue;
    }
    hasResupply = true;
    const invDays = getBaseInventoryDays(base.config, base.naturalId);
    if (invDays === undefined) {
      return undefined;
    }
    // 与 computeResupplyBill 一致的补给容量上限(suppliesCapDays)。
    const cap = getSuppliesCap(base.site);
    saturation = Math.max(saturation, cap);
  }
  // 搜索上界:各基地 cap 中的最大值(此时所有基地都已补到各自的总天数上限)。
  let hi = hasResupply ? Math.max(0, saturation) : 999;

  if (fits(hi)) {
    return hi;
  }

  // 二分搜索最大补给天数，支持小数（参考 BURN act 的小数精度搜索）。
  let lo = 0;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Math.floor(lo * 100) / 100;
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
