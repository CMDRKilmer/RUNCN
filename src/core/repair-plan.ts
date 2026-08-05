import { getBuildingBuildMaterials, isRepairableBuilding } from '@src/core/buildings';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { getBuildingLastRepair } from '@src/infrastructure/prun-api/data/sites';
import { getMaterialPrice } from '@src/infrastructure/fio/cx';
import { timestampEachMinute } from '@src/utils/dayjs';

const MS_PER_DAY = 86400000;

// 修复间隔扫描范围,与 PRUNplanner 一致:从修满后的第 0 天到第 180 天。
const DAY_MIN = 0;
const DAY_MAX = 180;

// Sigmoid 效率公式来自 MoonSugarTravels 退化研究,被 PRUNplanner 采用。
// η(D) = 0.33 + 0.67 / (1 + e^((1789/25000) × (D − 100.87)))
// D = 距上次维修的天数,η ∈ [0.33, 1]。
// 时间线:0-30 天几乎满状态;60 天开始明显下降;90 天跌破 80%;180 天接近 33% 下限。
function efficiencyAtDay(days: number): number {
  return 0.33 + 0.67 / (1 + Math.exp((1789 / 25000) * (days - 100.87)));
}

// 维修成本公式来自 MoonSugarTravels / prun-mcp / PRUNplanner:
// RepairAmount(material, age) = input − floor((input × (180 − min(180, age))) / 180)
// 等价于 ceil(input × age / 180),但 floor-减法形式避免 ceil 浮点误差。
// PRUNplanner 测试样例:calculateAmountAtDay(100, 100) = 56。
export function calcRepairCost(
  ageDays: number,
  fullMaterials: PrunApi.MaterialAmount[],
): { material: PrunApi.Material; amount: number; price: number | undefined }[] {
  const clamped = Math.max(0, Math.min(DAY_MAX, ageDays));
  const recoverable = DAY_MAX - clamped;
  return fullMaterials.map(({ material, amount }) => {
    const repairAmount = amount - Math.floor((amount * recoverable) / DAY_MAX);
    const price = getMaterialPrice(material);
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

// 给定 per-building per-day 净产出与全建材料,扫描 D ∈ [DAY_MIN, DAY_MAX],
// 返回日均净利润最大的 D 作为推荐维修间隔。
// 模型(完全照搬 PRUNplanner PlanRepairAnalysis.vue::calculateRep):
//   efficiency(D) = 0.33 + 0.67 / (1 + e^((1789/25000) × (D − 100.87)))
//   dailyRevenue(D) = efficiency(D) × dailyRevenue
//   cumulativeRevenue(D) = Σ_{d=0..D} dailyRevenue(d)
//   avgRevenue(D) = cumulativeRevenue / (D + 1)
//   repairAmount(material, D) = input − floor((input × (180 − min(180, D))) / 180)
//   totalRepair(D) = Σ amount × repairPrice(ticker)
//     此处 repairPrice 跟随 userData.settings.pricing.method(由 getMaterialPrice 提供),
//     与 PRUNplanner 显式 "BUY" 不完全一致,但用户已确认采用跟随设置。
//   amortizedRepair(D) = totalRepair(D) / (D + 1)
//   profit(D) = avgRevenue(D) − amortizedRepair(D),D=0 时 hardcode 为 0
// 最后修正 r[0].profit = r[1].profit(与 PRUNplanner L125-127 一致)。
// 取 profit 最大的 D* 作为推荐维修触发间隔。
export interface OptimalRepair {
  optimalDay: number;
  // 在 optimalDay 处,D 天一个周期能拿到的日均净利润(货币/天)。
  optimalDailyProfit: number;
  // 在 optimalDay 处的总维修成本(摊销前)。
  optimalRepairCost: number | undefined;
  // 当前 age 下的一次性维修成本。
  currentRepairCost: number | undefined;
  // 在每个 D 上的日均净利润曲线(便于面板展示)。
  profitCurve: { day: number; profit: number }[];
}

export function calculateOptimalRepair(
  ageDays: number,
  dailyRevenue: number,
  fullMaterials: PrunApi.MaterialAmount[],
): OptimalRepair | undefined {
  if (dailyRevenue <= 0) {
    return undefined;
  }
  // PRUNplanner 计算逐日 profit 并扫出 max。逐天推到数组是因为 chart 渲染需要。
  const profitCurve: { day: number; profit: number }[] = [];
  let cumulativeRevenue = 0;
  for (let day = DAY_MIN; day <= DAY_MAX; day++) {
    const efficiency = efficiencyAtDay(day);
    cumulativeRevenue += efficiency * dailyRevenue;
    const avgRevenue = cumulativeRevenue / (day + 1);
    const repairCost = calcRepairCostTotal(day, fullMaterials);
    if (repairCost === undefined) {
      // 价格缺失,无法评估该点。
      profitCurve.push({ day, profit: NaN });
      continue;
    }
    const amortizedRepair = repairCost / (day + 1);
    // PRUNplanner 原始写法:第 0 天 hardcode profit=0,以避免摊销分母异常。
    const profit = day === 0 ? 0 : avgRevenue - amortizedRepair;
    profitCurve.push({ day, profit });
  }
  if (profitCurve.length < 2) {
    return undefined;
  }
  // 修正第 0 天的 profit,用第 1 天的值代替(与 PRUNplanner 一致)。
  profitCurve[0].profit = profitCurve[1].profit;
  // 找最大 profit 对应的 day。注意 PRUNplanner 用 === 比较,
  // findIndex 找到第一个最大值;我们用 === 同等行为。
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
  // 在最优 day 的总维修成本。
  const optimalRepairCost = calcRepairCostTotal(bestDay, fullMaterials);
  return {
    optimalDay: bestDay,
    optimalDailyProfit: bestProfit,
    optimalRepairCost,
    currentRepairCost: calcRepairCostTotal(ageDays, fullMaterials),
    profitCurve,
  };
}

export interface RepairPrediction {
  naturalId: string;
  target: string;
  ticker: string;
  condition: number;
  lastRepair: number;
  ageDays: number;
  // 该建筑 per-day 净产出货币(由调用方计算,通常来自 core/production-revenue)。
  // 与 RepairPredictionParams.dailyRevenue 相同时 sweep 才有意义。
  dailyRevenue: number | undefined;
  // 当前 age 下的维修成本。
  currentRepairCost: number | undefined;
  // PRUNplanner 模型下的最优维修间隔天数(从 0 开始)。
  optimalDay: number | undefined;
  // 在最优间隔下的日均净利润(货币/天)。
  optimalDailyProfit: number | undefined;
  // 在最优间隔处的总维修成本。
  optimalRepairCost: number | undefined;
  // 距离下次触发维修还需的天数。已超过触发间隔时为 0。
  daysUntilTrigger: number;
  // 预测的触发维修时间戳(ms)。
  triggerTimestamp: number;
}

export interface RepairPredictionParams {
  // 每座建筑的 per-day 净产出,由调用方提供。
  // RepairPrediction.dailyRevenue 字段直接来自该函数返回的逐建筑值。
  resolveBuildingDailyRevenue?: (
    building: PrunApi.Platform,
    site: PrunApi.Site,
  ) => number | undefined;
}

// 返回建筑的全建材料(用于维修成本公式 floor(BuildingCost × D / 180))。
// 优先用 site.buildOptions 的严格全建材料,fallback 到 rprun 既有
// getBuildingBuildMaterials(reclaimable + repair 合并估算)。
function getFullBuildMaterials(building: PrunApi.Platform, site: PrunApi.Site) {
  const strict = site.buildOptions.options.find(x => x.ticker === building.module.reactorTicker)
    ?.materials.quantities;
  if (strict) {
    return strict;
  }
  return getBuildingBuildMaterials(building, site);
}

export function calculateRepairPredictions(
  sites: PrunApi.Site[] | undefined,
  params: RepairPredictionParams,
): RepairPrediction[] | undefined {
  if (!sites) {
    return undefined;
  }
  const now = timestampEachMinute.value;
  const entries: RepairPrediction[] = [];
  for (const site of sites) {
    const target = getEntityNameFromAddress(site.address) ?? '';
    const naturalId = getEntityNaturalIdFromAddress(site.address) ?? '';
    for (const building of site.platforms.filter(isRepairableBuilding)) {
      const fullMaterials = getFullBuildMaterials(building, site);
      const hasBuildOption = site.buildOptions.options.some(
        x => x.ticker === building.module.reactorTicker,
      );
      if (!hasBuildOption) {
        console.warn(
          '[REPP] No buildOption for',
          building.module.reactorTicker,
          '@',
          site.siteId,
          '(using fallback)',
        );
      }
      const lastRepair = getBuildingLastRepair(building);
      const ageNowDays = Math.max(0, (now - lastRepair) / MS_PER_DAY);
      const condition = Math.max(0.33, building.condition);
      const dailyRevenue = params.resolveBuildingDailyRevenue?.(building, site);
      const optimal =
        fullMaterials.length > 0 && dailyRevenue !== undefined
          ? calculateOptimalRepair(ageNowDays, dailyRevenue, fullMaterials)
          : undefined;
      const triggerDay = optimal?.optimalDay ?? Infinity;
      const daysUntilTrigger = Math.max(0, triggerDay - ageNowDays);
      const triggerTimestamp = now + daysUntilTrigger * MS_PER_DAY;
      entries.push({
        naturalId,
        target,
        ticker: building.module.reactorTicker,
        condition,
        lastRepair,
        ageDays: ageNowDays,
        dailyRevenue,
        currentRepairCost: optimal?.currentRepairCost,
        optimalDay: optimal?.optimalDay,
        optimalDailyProfit: optimal?.optimalDailyProfit,
        optimalRepairCost: optimal?.optimalRepairCost,
        daysUntilTrigger,
        triggerTimestamp,
      });
    }
  }
  // 触发时间从近到远,无触发信息的放末尾。
  entries.sort((a, b) => a.triggerTimestamp - b.triggerTimestamp);
  return entries;
}
