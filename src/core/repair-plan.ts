// 维修计划 sweep 算法:扫描每 D ∈ [0, 180] 天的维修间隔,
// 找到日均净利润最大的 D 作为最优维修间隔 (optimalDay)。
// 严格照搬 PRUNplanner PlanRepairAnalysis.vue::calculateRep 的 sigmoid 效率模型与
// 维修成本公式,见 REPP 历史实现 ebc8d5f3。
//
// 本模块仅保留 sweep 计算,不再导出 REPP UI 相关的 RepairPrediction / 触发时间戳。
// 调用方(如 PlanetRow)用 sweep 出的 optimalDay 与基地最大 age 比较即可。

import { cxStore } from '@src/infrastructure/fio/cx';
import { userData } from '@src/store/user-data';
import { workforcesStore } from '@src/infrastructure/prun-api/data/workforces';
import { timestampEachMinute } from '@src/utils/dayjs';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';

const MS_PER_DAY = 86400000;

// 修复间隔扫描范围,与 PRUNplanner 一致:从修满后的第 0 天到第 180 天。
const DAY_MIN = 0;
const DAY_MAX = 180;

// Sigmoid 效率公式来自 MoonSugarTravels 退化研究,被 PRUNplanner 采用。
// η(D) = 0.33 + 0.67 / (1 + e^((1789/25000) × (D − 100.87)))
// D = 距上次维修的天数,η ∈ [0.33, 1]。
function efficiencyAtDay(days: number): number {
  return 0.33 + 0.67 / (1 + Math.exp((1789 / 25000) * (days - 100.87)));
}

// 获取材料的 BUY(Ask) 价格,强制对齐 PRUNplanner 的 BUY-only 策略。
function getBuyPrice(material: PrunApi.Material): number | undefined {
  if (!cxStore.fetched) {
    return undefined;
  }
  const exchange = cxStore.prices.get(userData.settings.pricing.exchange);
  const ask = exchange?.get(material.ticker)?.Ask;
  return ask == null ? undefined : ask;
}

// 维修成本公式来自 PRUNplanner:
// RepairAmount(material, age) = input − floor((input × (180 − min(180, age))) / 180)
function calcRepairCost(
  ageDays: number,
  fullMaterials: PrunApi.MaterialAmount[],
): { material: PrunApi.Material; amount: number; price: number | undefined }[] {
  const clamped = Math.max(0, Math.min(DAY_MAX, ageDays));
  const recoverable = DAY_MAX - clamped;
  return fullMaterials.map(({ material, amount }) => {
    const repairAmount = amount - Math.floor((amount * recoverable) / DAY_MAX);
    const price = getBuyPrice(material);
    return { material, amount: repairAmount, price };
  });
}

export function calcRepairCostTotal(
  ageDays: number,
  fullMaterials: PrunApi.MaterialAmount[],
): number | undefined {
  const entries = calcRepairCost(ageDays, fullMaterials);
  let total = 0;
  for (const { amount, price } of entries) {
    if (price === undefined) {
      return undefined;
    }
    total += amount * price;
  }
  return total;
}

// 计算建筑的总建设成本(全建材料 × BUY 价)。
function calcConstructionCost(fullMaterials: PrunApi.MaterialAmount[]): number | undefined {
  let total = 0;
  for (const { material, amount } of fullMaterials) {
    const price = getBuyPrice(material);
    if (price === undefined) {
      return undefined;
    }
    total += amount * price;
  }
  return total;
}

// 计算站点级日均劳动力货币成本(所有 workforce needs × BUY 价,按 day 摊销)。
// REPP 原版有 per-building 精细路径(BuildOption.workforceCapacities);
// 这里用整站总量按可维修建筑数均摊,精度足够用于三色判定。
function calcSiteWorkforceCost(site: PrunApi.Site): number | undefined {
  const workforce = workforcesStore.getById(site.siteId);
  if (!workforce) {
    return undefined;
  }
  let total = 0;
  for (const wf of workforce.workforces) {
    for (const need of wf.needs) {
      const price = getBuyPrice(need.material);
      if (price === undefined) {
        return undefined;
      }
      total += need.unitsPerInterval * price;
    }
  }
  return total;
}

// 计算单条 ProductionLine 的 per-day 净产值(委托给 core/production-revenue)。
import { calculateProductionRevenue } from '@src/core/production-revenue';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { isRepairableBuilding, getBuildingBuildMaterials } from '@src/core/buildings';
import { getBuildingLastRepair } from '@src/infrastructure/prun-api/data/sites';

export interface OptimalRepair {
  optimalDay: number;
}

export interface RepairUnit {
  dailyRevenue: number;
  fullMaterials: PrunApi.MaterialAmount[];
  ageDays: number;
}

// 整站(或多建筑)统一 sweep:把多个建筑看作一个整体,
// 按"所有建筑同时维修一次"的视角跑一次 sweep。
// 与 PRUNplanner PlanRepairAnalysis 的语义一致。
export function calculateOptimalRepair(units: RepairUnit[]): OptimalRepair | undefined {
  const positive = units.filter(u => u.dailyRevenue > 0);
  if (positive.length === 0) {
    return undefined;
  }
  const totalDailyRevenue = positive.reduce((s, u) => s + u.dailyRevenue, 0);
  const profitCurve: { day: number; profit: number }[] = [];
  let cumulativeRevenue = 0;
  for (let day = DAY_MIN; day <= DAY_MAX; day++) {
    const efficiency = efficiencyAtDay(day);
    cumulativeRevenue += efficiency * totalDailyRevenue;
    const avgRevenue = cumulativeRevenue / (day + 1);
    let totalRepair = 0;
    let hasAllPrices = true;
    for (const u of positive) {
      const c = calcRepairCostTotal(day, u.fullMaterials);
      if (c === undefined) {
        hasAllPrices = false;
        break;
      }
      totalRepair += c;
    }
    if (!hasAllPrices) {
      profitCurve.push({ day, profit: NaN });
      continue;
    }
    const amortizedRepair = totalRepair / (day + 1);
    const profit = day === 0 ? 0 : avgRevenue - amortizedRepair;
    profitCurve.push({ day, profit });
  }
  if (profitCurve.length < 2) {
    return undefined;
  }
  // 修正第 0 天的 profit,用第 1 天的值代替(与 PRUNplanner 一致)。
  profitCurve[0].profit = profitCurve[1].profit;
  let bestDay = 0;
  let bestProfit = -Infinity;
  for (const { day, profit } of profitCurve) {
    if (Number.isFinite(profit) && profit > bestProfit) {
      bestProfit = profit;
      bestDay = day;
    }
  }
  if (!isFinite(bestProfit)) {
    return undefined;
  }
  return { optimalDay: bestDay };
}

// 为单个基地计算整站 optimalDay。
// 严格沿用 REPP 算法的口径:per-building dailyRevenue − workforce share − constructionCost/180。
// 仅当所有建筑都有价格/订单数据时返回数值,否则 undefined(调用方应回退为绿色)。
export function calculateSiteOptimalDay(siteId: string): number | undefined {
  const site = sitesStore.getById(siteId);
  if (!site) {
    return undefined;
  }
  const repairable = site.platforms.filter(isRepairableBuilding);
  if (repairable.length === 0) {
    return undefined;
  }
  const siteWorkforceCost = calcSiteWorkforceCost(site);
  const workforceShare =
    siteWorkforceCost !== undefined ? siteWorkforceCost / repairable.length : 0;

  const now = timestampEachMinute.value;
  interface BuildingData {
    dailyRevenue: number | undefined;
    fullMaterials: PrunApi.MaterialAmount[];
    ageDays: number;
  }
  const buildingDataList: BuildingData[] = [];
  for (const building of repairable) {
    const fullMaterials = getBuildingBuildMaterials(building, site);
    const lines = productionStore.getBySiteId(site.siteId);
    const line = lines?.find(l => l.type === building.module.reactorName);
    let rawDailyRevenue: number | undefined;
    if (line && line.capacity > 0) {
      const perLine = calculateProductionRevenue(line);
      if (perLine !== undefined) {
        rawDailyRevenue = perLine / line.capacity;
      }
    }
    const constructionCost = calcConstructionCost(fullMaterials);
    let adjustedDailyRevenue: number | undefined;
    if (rawDailyRevenue !== undefined && constructionCost !== undefined) {
      adjustedDailyRevenue = rawDailyRevenue - workforceShare - constructionCost / 180;
    }
    const lastRepair = getBuildingLastRepair(building);
    const ageDays = Math.max(0, (now - lastRepair) / MS_PER_DAY);
    buildingDataList.push({ dailyRevenue: adjustedDailyRevenue, fullMaterials, ageDays });
  }
  const units: RepairUnit[] = buildingDataList
    .filter(b => b.dailyRevenue !== undefined && b.fullMaterials.length > 0)
    .map(b => ({
      dailyRevenue: b.dailyRevenue!,
      fullMaterials: b.fullMaterials,
      ageDays: b.ageDays,
    }));
  return calculateOptimalRepair(units)?.optimalDay;
}
