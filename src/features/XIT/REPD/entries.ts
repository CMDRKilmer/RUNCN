// XIT REPD「维修到期」看板的数据层。
//
// 全部取自游戏客户端内存，不发起任何网络请求：
//   - 建筑状况 / 上次维修 / 维修材料（含 +24h、+48h 两档）：SHIP_SITES 的 platforms
//   - 基地现成库存：STORAGE_STORAGES
//   - 价格：插件既有的价格缓存（与物料悬浮窗、FLEET 维修列同源）
//
// 到期口径照搬 PRUNplanner 的 FIO Repair 页：年龄（天）+ 目标日 ⇒ 剩余天数。
// 唯一的差别是目标日的来源——PRUNplanner 从「匹配的 plan 的 Repair Analysis」取，
// 游戏里没有 plan，这里改用 core/repair-plan.ts 已移植的同款算法算出整站最优间隔，
// 或用户在 XIT REPD 左侧「维修设置」栏里设定的固定天数。

import { getBaseAlias } from '@src/core/base-aliases';
import { getBuildingBuildMaterials, isRepairableBuilding } from '@src/core/buildings';
import { calculateSiteOptimalDay, calculateTypeOptimalDay } from '@src/core/repair-plan';
import { mergeMaterialAmounts } from '@src/core/sort-materials';
import { getPrice } from '@src/infrastructure/fio/cx';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { getBuildingLastRepair, sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { userData } from '@src/store/user-data';

const MS_PER_DAY = 86_400_000;

// 与 PRUNplanner 一致：维修满额需要 180 天的折旧量。
const REPAIR_DAY_MAX = 180;

// 整站最优间隔的缓存时长。该算法要跑 181 天 × 每栋建筑的产量收益扫描，
// 逐帧重算代价太高，10 分钟内复用结果。
const OPTIMAL_TTL_MS = 10 * 60 * 1000;

// 没算出结果时的重试间隔：等生产/价格数据到位后再算。
const OPTIMAL_RETRY_MS = 15 * 1000;

export type RepairBoardStatus = 'overdue' | 'soon' | 'later';

export interface RepairBoardSettings {
  useOptimal: boolean;
  targetDays: number;
  dueSoonDays: number;
  arrivalDays: number;
  subtractStore: boolean;
}

export interface RepairBoardType {
  ticker: string;
  count: number;
  /** 该类型中最老建筑的年龄，天 */
  ageDays: number;
  /** 该类型中最低的状况，0~1 */
  condition: number;
  /** 该建筑类型自有的最优维修间隔（天）；关闭最优或算不出时为固定天数 */
  targetDay: number;
  /** 该类型的目标日是否来自最优间隔算法 */
  targetIsOptimal: boolean;
  /** 距离该类型自有目标日还有多少天，负数表示已逾期 */
  dueIn: number;
}

export interface RepairBoardBase {
  siteId: string;
  naturalId: string;
  name: string;
  alias: string | undefined;
  /** 可维修建筑数量（资源采集 + 生产） */
  buildingCount: number;
  /** 建筑类型数量 */
  typeCount: number;
  /** 按到期日升序排列的建筑类型明细 */
  types: RepairBoardType[];
  ageDays: number;
  condition: number;
  targetDay: number;
  /** 目标日是否来自最优间隔算法 */
  targetIsOptimal: boolean;
  dueIn: number;
  status: RepairBoardStatus;
  /** 抵达当日的完整维修材料账单 */
  bill: PrunApi.MaterialAmount[];
  /** 扣掉基地现成库存后实际要运的量 */
  load: PrunApi.MaterialAmount[];
  /** 实际要运的货物重量（吨） */
  loadWeight: number;
  /** 实际要运的货物体积（m³） */
  loadVolume: number;
  /** 账单货币成本，缺价时为 undefined */
  billCost: number | undefined;
  /** 每多等一天的额外成本，缺价时为 undefined */
  waitingPerDay: number | undefined;
}

// 整站最优间隔按 siteId 缓存；按类型算的最优间隔按 siteId + 建筑代号缓存。
// 两者共用同一套 TTL：算不出来时只短暂缓存，等生产/价格数据到位再重试。
const optimalCache = new Map<string, { at: number; value: number | undefined }>();
const typeOptimalCache = new Map<string, { at: number; value: number | undefined }>();

export function repairStatus(dueIn: number, dueSoonDays: number): RepairBoardStatus {
  if (dueIn < 0) {
    return 'overdue';
  }
  return dueIn <= dueSoonDays ? 'soon' : 'later';
}

export function getRepairBoardSettings(): RepairBoardSettings {
  const settings = userData.settings.repairBoard;
  return {
    useOptimal: settings?.useOptimal ?? true,
    targetDays: settings?.targetDays ?? 90,
    dueSoonDays: settings?.dueSoonDays ?? 7,
    arrivalDays: settings?.arrivalDays ?? 0,
    subtractStore: settings?.subtractStore ?? true,
  };
}

function getOptimalDay(siteId: string, now: number) {
  const cached = optimalCache.get(siteId);
  // 算不出来（价格/生产数据还没加载完）时只缓存很短时间，否则整块看板会在
  // 页面刚加载的那一分钟里全部回退成固定天数，并且一直错十分钟。
  const ttl = cached?.value === undefined ? OPTIMAL_RETRY_MS : OPTIMAL_TTL_MS;
  if (cached && now - cached.at < ttl) {
    return cached.value;
  }
  const value = calculateSiteOptimalDay(siteId);
  optimalCache.set(siteId, { at: now, value });
  return value;
}

// 每种建筑类型单独跑一次 sweep：产能收益、建设成本都不同，最优间隔自然不同。
// 算不出时与整站一样回退到设置里的固定天数（由调用方决定）。
function getTypeOptimalDay(siteId: string, ticker: string, now: number) {
  const key = `${siteId}|${ticker}`;
  const cached = typeOptimalCache.get(key);
  const ttl = cached?.value === undefined ? OPTIMAL_RETRY_MS : OPTIMAL_TTL_MS;
  if (cached && now - cached.at < ttl) {
    return cached.value;
  }
  const value = calculateTypeOptimalDay(siteId, ticker);
  typeOptimalCache.set(key, { at: now, value });
  return value;
}

function sumCost(amounts: PrunApi.MaterialAmount[]) {
  let total = 0;
  for (const { material, amount } of amounts) {
    const price = getPrice(material.ticker);
    if (price === undefined) {
      return undefined;
    }
    total += price * amount;
  }
  return total;
}

// 基地自家仓库的现有数量，用于把账单折算成真正的缺口。
function getBaseInventory(siteId: string): Record<string, number> {
  const store = storagesStore.getByAddressableId(siteId)?.find(x => x.type === 'STORE');
  const inventory: Record<string, number> = {};
  for (const item of store?.items ?? []) {
    if (item.quantity) {
      inventory[item.quantity.material.ticker] = item.quantity.amount;
    }
  }
  return inventory;
}

// 计算某基地在「飞船 N 天后抵达」时的完整维修材料账单。
//
// offsetDays = 0 时直接用游戏下发的原生 repairMaterials（与 BRA 面板「现在」
// 完全一致，也与 FLEET 的维修账单同源）：服务器已经算好的整数值，没有取整残差。
//
// offsetDays > 0 才用 180 天折旧公式投影：
//   RepairAmount = input − floor(input × (180 − min(180, age + offset)) / 180)。
// 不用游戏的 repairMaterials24 / repairMaterials48：实测这两档并不是 +24h / +48h
// 账单（24h 那档与「现在」完全相同），会导致偏移一档就与 XIT REP 对不上。
function computeBill(
  site: PrunApi.Site,
  offsetDays: number,
  now: number,
  tickers?: ReadonlySet<string>,
) {
  const amounts: PrunApi.MaterialAmount[] = [];
  const useNative = offsetDays === 0;
  for (const building of site.platforms.filter(isRepairableBuilding)) {
    // 勾选过滤：REPD 明细只把勾中的建筑类型计入购物清单。
    // 传入空集合 = 一类都没选，账单为空；不传 = 整站全量（左侧总览口径）。
    if (tickers && !tickers.has(building.module.reactorTicker)) {
      continue;
    }
    if (useNative) {
      for (const { material, amount } of building.repairMaterials ?? []) {
        if (amount > 0) {
          amounts.push({ material, amount });
        }
      }
      continue;
    }
    const ageDays = Math.max(0, (now - getBuildingLastRepair(building)) / MS_PER_DAY);
    const day = Math.min(REPAIR_DAY_MAX, ageDays + offsetDays);
    const recoverable = REPAIR_DAY_MAX - day;
    for (const { material, amount } of getBuildingBuildMaterials(building, site)) {
      const need = amount - Math.floor((amount * recoverable) / REPAIR_DAY_MAX);
      if (need > 0) {
        amounts.push({ material, amount: need });
      }
    }
  }
  return mergeMaterialAmounts(amounts);
}

function calculateBase(
  site: PrunApi.Site,
  now: number,
  settings: RepairBoardSettings,
): RepairBoardBase | undefined {
  const buildings = site.platforms.filter(isRepairableBuilding);
  if (buildings.length === 0) {
    return undefined;
  }

  const optimalDay = settings.useOptimal ? getOptimalDay(site.siteId, now) : undefined;
  const targetDay = optimalDay ?? settings.targetDays;

  const byTicker = new Map<string, { ages: number[]; conditions: number[] }>();
  let maxAge = 0;
  let minCondition = 1;
  let waitingPerDay: number | undefined = 0;

  for (const building of buildings) {
    const ageDays = Math.max(0, (now - getBuildingLastRepair(building)) / MS_PER_DAY);
    const ticker = building.module.reactorTicker;
    const bucket = byTicker.get(ticker);
    if (bucket) {
      bucket.ages.push(ageDays);
      bucket.conditions.push(building.condition);
    } else {
      byTicker.set(ticker, { ages: [ageDays], conditions: [building.condition] });
    }
    if (ageDays > maxAge) {
      maxAge = ageDays;
    }
    if (building.condition < minCondition) {
      minCondition = building.condition;
    }

    // 每日等待成本：每栋未满 180 天的建筑每天多出 1/180 的建设成本。
    if (waitingPerDay !== undefined) {
      if (ageDays >= REPAIR_DAY_MAX) {
        continue;
      }
      const buildCost = sumCost(getBuildingBuildMaterials(building, site));
      waitingPerDay =
        buildCost === undefined ? undefined : waitingPerDay + buildCost / REPAIR_DAY_MAX;
    }
  }

  const types: RepairBoardType[] = [...byTicker].map(([ticker, bucket]) => {
    const typeAge = Math.max(...bucket.ages);
    // 关键：每种建筑类型跑自己的 sweep，不再整站共用一个目标日。
    // 关闭「按插件算出的最优间隔」或该类型算不出时，回退到设置里的固定天数。
    const typeOptimal = settings.useOptimal
      ? getTypeOptimalDay(site.siteId, ticker, now)
      : undefined;
    const typeTargetDay = typeOptimal ?? settings.targetDays;
    return {
      ticker,
      count: bucket.ages.length,
      ageDays: typeAge,
      condition: Math.min(...bucket.conditions),
      targetDay: typeTargetDay,
      targetIsOptimal: typeOptimal !== undefined,
      dueIn: typeTargetDay - typeAge,
    };
  });
  types.sort((a, b) => {
    const diff = a.dueIn - b.dueIn;
    return diff !== 0 ? diff : a.ticker.localeCompare(b.ticker);
  });

  const bill = computeBill(site, settings.arrivalDays, now);

  let load = bill;
  if (settings.subtractStore) {
    const inventory = getBaseInventory(site.siteId);
    load = bill
      .map(x => ({
        material: x.material,
        amount: Math.max(0, x.amount - (inventory[x.material.ticker] ?? 0)),
      }))
      .filter(x => x.amount > 0);
  }

  const dueIn = targetDay - maxAge;

  return {
    siteId: site.siteId,
    naturalId: getEntityNaturalIdFromAddress(site.address) ?? site.siteId,
    name: getEntityNameFromAddress(site.address) ?? '',
    alias: getBaseAlias(site.siteId),
    buildingCount: buildings.length,
    typeCount: types.length,
    types,
    ageDays: maxAge,
    condition: minCondition,
    targetDay,
    targetIsOptimal: optimalDay !== undefined,
    dueIn,
    status: repairStatus(dueIn, settings.dueSoonDays),
    bill,
    load,
    loadWeight: load.reduce((sum, x) => sum + (x.material.weight ?? 0) * x.amount, 0),
    loadVolume: load.reduce((sum, x) => sum + (x.material.volume ?? 0) * x.amount, 0),
    billCost: sumCost(bill),
    waitingPerDay,
  };
}

export function calculateRepairBoard(now: number): RepairBoardBase[] | undefined {
  const sites = sitesStore.all.value;
  if (sites === undefined) {
    return undefined;
  }
  // 库存未就绪时同样先不渲染，避免先显示完整账单再跳变成扣减后的缺口。
  if (!storagesStore.fetched.value) {
    return undefined;
  }
  const settings = getRepairBoardSettings();
  const bases: RepairBoardBase[] = [];
  for (const site of sites) {
    const base = calculateBase(site, now, settings);
    if (base) {
      bases.push(base);
    }
  }
  bases.sort((a, b) => {
    const diff = a.dueIn - b.dueIn;
    return diff !== 0 ? diff : a.name.localeCompare(b.name);
  });
  return bases;
}

export interface RepairOffsetBill {
  /** 该偏移天数下需要搬运的材料（已按设置扣基地库存） */
  load: PrunApi.MaterialAmount[];
  /** 货币成本，缺价时 undefined */
  cost: number | undefined;
  weight: number;
  volume: number;
}

// 按「飞船 N 天后才抵达」重算某基地的维修账单（与 calculateBase 同一套公式）。
export function calculateBillAtOffset(
  siteId: string,
  offsetDays: number,
  subtractStore: boolean,
  now: number,
  tickers?: ReadonlySet<string>,
): RepairOffsetBill | undefined {
  const site = sitesStore.getById(siteId);
  if (!site) {
    return undefined;
  }

  const bill = computeBill(site, offsetDays, now, tickers);
  let load = bill;
  if (subtractStore) {
    const inventory = getBaseInventory(siteId);
    load = bill
      .map(x => ({
        material: x.material,
        amount: Math.max(0, x.amount - (inventory[x.material.ticker] ?? 0)),
      }))
      .filter(x => x.amount > 0);
  }

  return {
    load,
    cost: sumCost(load),
    weight: load.reduce((sum, x) => sum + (x.material.weight ?? 0) * x.amount, 0),
    volume: load.reduce((sum, x) => sum + (x.material.volume ?? 0) * x.amount, 0),
  };
}
