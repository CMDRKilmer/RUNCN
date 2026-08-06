import { getBuildingBuildMaterials, isRepairableBuilding } from '@src/core/buildings';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { getBuildingLastRepair } from '@src/infrastructure/prun-api/data/sites';
import { cxStore } from '@src/infrastructure/fio/cx';
import { workforcesStore } from '@src/infrastructure/prun-api/data/workforces';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { userData } from '@src/store/user-data';
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

// 获取材料的 BUY(Ask) 价格,强制对齐 PRUNplanner 的 BUY-only 策略,
// 不跟随 userData.settings.pricing.method 的设置。
function getBuyPrice(material: PrunApi.Material): number | undefined {
  if (!cxStore.fetched) {
    return undefined;
  }
  const exchange = cxStore.prices.get(userData.settings.pricing.exchange);
  const ask = exchange?.get(material.ticker)?.Ask;
  return ask == null ? undefined : ask;
}

// 维修成本公式来自 MoonSugarTravels / prun-mcp / PRUNplanner:
// RepairAmount(material, age) = input − floor((input × (180 − min(180, age))) / 180)
// 等价于 ceil(input × age / 180),但 floor-减法形式避免 ceil 浮点误差。
// PRUNplanner 测试样例:calculateAmountAtDay(100, 100) = 56。
// 维修价格强制用 BUY(Ask),对齐 PRUNplanner 算法。
export function calcRepairCost(
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
//     repairPrice 强制用 BUY(Ask) 价,对齐 PRUNplanner。
//   amortizedRepair(D) = totalRepair(D) / (D + 1)
//   profit(D) = avgRevenue(D) − amortizedRepair(D),D=0 时 hardcode 为 0
// 最后修正 r[0].profit = r[1].profit(与 PRUNplanner L125-127 一致)。
// 取 profit 最大的 D* 作为推荐维修触发间隔。
export interface OptimalRepair {
  optimalDay: number;
  // 在 optimalDay 处,D 天一个周期能拿到的日均净利润(货币/天)。
  optimalDailyProfit: number;
  // 在 optimalDay 处的总维修成本(摊销前),全站合计。
  optimalRepairCost: number | undefined;
  // 当前 age 下的一次性维修成本,全站合计。
  currentRepairCost: number | undefined;
  // 在每个 D 上的日均净利润曲线(便于面板展示)。
  profitCurve: { day: number; profit: number }[];
}

// 单元(building/site)的 sweep 输入:per-day 净产值 + 全建材料。
export interface RepairUnit {
  dailyRevenue: number;
  fullMaterials: PrunApi.MaterialAmount[];
  ageDays: number;
}

// 整站(或多建筑)统一 sweep:把多个建筑看作一个整体,
// 按"所有建筑同时维修一次"的视角跑一次 sweep。
// 与 PRUNplanner PlanRepairAnalysis 的语义一致:每个 building 单独计算
// 的 optimalDay 在数学上对线性求和结果等价(边际最优与规模无关),
// 但本函数明确按"整体一次维修"建模,把 22 栋建筑的不同 ticker / 不同 age
// 一起考虑,返回单一 overall optimalDay。
export function calculateOptimalRepair(
  units: RepairUnit[],
  currentRepairCosts?: (number | undefined)[],
): OptimalRepair | undefined {
  const positive = units.filter(u => u.dailyRevenue > 0);
  if (positive.length === 0) {
    return undefined;
  }
  // 全站每日总收益(per-day 总产值)。
  const totalDailyRevenue = positive.reduce((s, u) => s + u.dailyRevenue, 0);
  // PRUNplanner 计算逐日 profit 并扫出 max。逐天推到数组是因为 chart 渲染需要。
  const profitCurve: { day: number; profit: number }[] = [];
  let cumulativeRevenue = 0;
  for (let day = DAY_MIN; day <= DAY_MAX; day++) {
    const efficiency = efficiencyAtDay(day);
    cumulativeRevenue += efficiency * totalDailyRevenue;
    const avgRevenue = cumulativeRevenue / (day + 1);
    // 全站同时维修:每栋建筑各自的 D 天维修成本相加。
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
      // 价格缺失,无法评估该点。
      profitCurve.push({ day, profit: NaN });
      continue;
    }
    const amortizedRepair = totalRepair / (day + 1);
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
  // 在最优 day 的全站总维修成本。
  let optimalRepairCost = 0;
  for (const u of positive) {
    const c = calcRepairCostTotal(bestDay, u.fullMaterials);
    if (c !== undefined) {
      optimalRepairCost += c;
    }
  }
  // 当前 age 下的一次性维修成本(全站合计),优先用 caller 已算值,否则重算。
  let currentRepairCost = 0;
  if (currentRepairCosts !== undefined) {
    for (const c of currentRepairCosts) {
      if (c !== undefined) {
        currentRepairCost += c;
      }
    }
  } else {
    for (const u of units) {
      const c = calcRepairCostTotal(u.ageDays, u.fullMaterials);
      if (c !== undefined) {
        currentRepairCost += c;
      }
    }
  }
  return {
    optimalDay: bestDay,
    optimalDailyProfit: bestProfit,
    optimalRepairCost,
    currentRepairCost,
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

// 计算站点级别的日均劳动力成本(所有 workforce needs × BUY 价)。
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

// PRUNplanner WORKFORCE_CONSUMPTION_MAP:每个等级的每个工人每日需要多少材料(单位)。
// 数据来源:PRUNplanner frontend src/features/planning/calculations/workforceCalculations.ts
// (前端硬编码,因为 game 不直接暴露 per-tier consumption rates)。
// 字段 lux1/lux2 标识该材料是否作为奢侈品消耗;rprun 不消费奢侈品,故忽略 lux 字段。
// 注意:满足度折减在 WORKFORCE_CONSUMPTION_MAP 里通过 baseNeed × (consuming/required) 处理,
// 详见 PRUNplanner calculateSingleWorkforceConsumption。我们这里用 full consumption (capacity>=required 时),
// 等价于 PRUNplanner 的「满满足度」假设。
const WORKFORCE_CONSUMPTION_MAP: Record<string, { ticker: string; need: number }[]> = {
  PIONEER: [
    { ticker: 'DW', need: 4 / 100 },
    { ticker: 'RAT', need: 4 / 100 },
    { ticker: 'OVE', need: 0.5 / 100 },
    { ticker: 'PWO', need: 0.2 / 100 },
    { ticker: 'COF', need: 0.5 / 100 },
  ],
  SETTLER: [
    { ticker: 'DW', need: 5 / 100 },
    { ticker: 'RAT', need: 6 / 100 },
    { ticker: 'EXO', need: 0.5 / 100 },
    { ticker: 'PT', need: 0.5 / 100 },
    { ticker: 'REP', need: 0.2 / 100 },
    { ticker: 'KOM', need: 1 / 100 },
  ],
  TECHNICIAN: [
    { ticker: 'DW', need: 7.5 / 100 },
    { ticker: 'RAT', need: 7 / 100 },
    { ticker: 'MED', need: 0.5 / 100 },
    { ticker: 'HMS', need: 0.5 / 100 },
    { ticker: 'SCN', need: 0.1 / 100 },
    { ticker: 'SC', need: 0.1 / 100 },
    { ticker: 'ALE', need: 1 / 100 },
  ],
  ENGINEER: [
    { ticker: 'DW', need: 10 / 100 },
    { ticker: 'MED', need: 0.5 / 100 },
    { ticker: 'FIM', need: 7 / 100 },
    { ticker: 'HSS', need: 0.2 / 100 },
    { ticker: 'PDA', need: 0.1 / 100 },
    { ticker: 'VG', need: 0.2 / 100 },
    { ticker: 'GIN', need: 1 / 100 },
  ],
  SCIENTIST: [
    { ticker: 'DW', need: 10 / 100 },
    { ticker: 'MED', need: 0.5 / 100 },
    { ticker: 'MEA', need: 7 / 100 },
    { ticker: 'LC', need: 0.2 / 100 },
    { ticker: 'WS', need: 0.05 / 100 },
    { ticker: 'NST', need: 0.1 / 100 },
    { ticker: 'WIN', need: 1 / 100 },
  ],
};

const WORKFORCE_LEVEL_KEYS: Record<string, string> = {
  PIONEER: 'PIONEER',
  SETTLER: 'SETTLER',
  TECHNICIAN: 'TECHNICIAN',
  ENGINEER: 'ENGINEER',
  SCIENTIST: 'SCIENTIST',
};

// 计算单座生产建筑的 per-day 劳动力货币成本。
// 利用 site.buildOptions.options[ticker].workforceCapacities 获取每建筑各等级工人数
// (这是 live API 提供的精确 per-building 工人需求,避开了 Workforce[] 是站点聚合的限制),
// 再用 PRUNplanner 的 WORKFORCE_CONSUMPTION_MAP × BUY 价算出货币成本。
// 与 calcSiteWorkforceCost 不同:本函数输出 per-building,无需再按建筑数均摊。
function calcPerBuildingWorkforceCost(
  building: PrunApi.Platform,
  site: PrunApi.Site,
): number | undefined {
  const option = site.buildOptions.options.find(x => x.ticker === building.module.reactorTicker);
  if (!option) {
    return undefined;
  }
  let total = 0;
  for (const cap of option.workforceCapacities) {
    const mapKey = WORKFORCE_LEVEL_KEYS[cap.level];
    const consumption = mapKey ? WORKFORCE_CONSUMPTION_MAP[mapKey] : undefined;
    if (!consumption) {
      continue;
    }
    const workers = cap.capacity;
    if (workers <= 0) {
      continue;
    }
    for (const { ticker, need } of consumption) {
      const material = materialsStore.getByTicker(ticker);
      if (!material) {
        // 没有该材料的 metadata,价格缺失;放弃累加部分值以避免低估成本。
        return undefined;
      }
      const price = getBuyPrice(material);
      if (price === undefined) {
        // 价格缺失;放弃累加部分值以避免低估成本。
        return undefined;
      }
      total += workers * need * price;
    }
  }
  return total;
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

    // 预计算站点的劳动力成本,用于分摊到生产建筑。
    // 用 BuildOption.workforceCapacities(per-building 工人需求)× WORKFORCE_CONSUMPTION_MAP(per-worker 日消费率)
    // 精确计算每建筑劳动力货币成本,不再按建筑数均摊。
    // 这与 PRUNplanner usePlanCalculation.ts::building.dailyRevenue 中的
    //   workforceDailyCost × building.amount 一致(都是 per-building × per-day)。
    // 注意:WORKFORCE_CONSUMPTION_MAP 不考虑满足度折减,等价于满满足度假设。
    // 满满足度基地两者一致;不满满足度基地 rprun 会高估劳动力成本(低估 dailyRevenue) → 倾向推迟维修日。
    const siteWorkforceCost = calcSiteWorkforceCost(site);

    // 整站统一 sweep:先按建筑收集所有数据,再跑一次 calculateOptimalRepair。
    // 这样 22 栋不同 ticker / 不同 age 的建筑被作为一个整体,
    // 返回一个 overall optimalDay(整站同时维修一次的最优周期)。
    interface BuildingData {
      building: PrunApi.Platform;
      fullMaterials: PrunApi.MaterialAmount[];
      ageNowDays: number;
      condition: number;
      lastRepair: number;
      adjustedDailyRevenue: number | undefined;
      constructionCost: number | undefined;
      currentRepairCost: number | undefined;
    }
    const buildingDataList: BuildingData[] = [];
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

      // 1. 原始生产净收入(不含 condition 因子,由 production-revenue.ts 已处理)
      const rawDailyRevenue = params.resolveBuildingDailyRevenue?.(building, site);

      // 2. 建筑建设成本(BUY 价)
      const constructionCost = calcConstructionCost(fullMaterials);

      // 3. 调整 dailyRevenue,严格对齐 PRUNplanner usePlanCalculation.ts L428-432:
      //    dailyRevenue = incomeMag×runs − inputMag×runs − constrMag/180 − wfMag
      //    即建筑摊销(constrMag/180)与劳动力成本(wfMag)都是「成本」,需从生产净收入中扣除。
      //    rawDailyRevenue 已是 (incomeMag − inputMag) × maxDailyRuns。
      //    劳动力用 per-building BuildOption.workforceCapacities × WORKFORCE_CONSUMPTION_MAP 计算。
      //    优先使用精确 per-building;若数据缺失则 fallback 到旧版「站点总量按建筑数均摊」。
      let adjustedDailyRevenue: number | undefined = rawDailyRevenue;
      if (rawDailyRevenue !== undefined && constructionCost !== undefined) {
        let workforcePortion = 0;
        const perBuildingWFCost = calcPerBuildingWorkforceCost(building, site);
        if (perBuildingWFCost !== undefined) {
          workforcePortion = perBuildingWFCost;
        } else if (siteWorkforceCost !== undefined) {
          // Fallback:按「需要劳动力的建筑数」均摊站点 workforce needs。
          // 这保留了旧行为,使 BuildOption 缺失的旧建筑仍能计算。
          const workforceBuildingCount = site.platforms.filter(isRepairableBuilding).length;
          if (workforceBuildingCount > 0) {
            workforcePortion = siteWorkforceCost / workforceBuildingCount;
          }
        }
        adjustedDailyRevenue = rawDailyRevenue - workforcePortion - constructionCost / 180;
      }
      const currentRepairCost =
        fullMaterials.length > 0 ? calcRepairCostTotal(ageNowDays, fullMaterials) : undefined;
      buildingDataList.push({
        building,
        fullMaterials,
        ageNowDays,
        condition,
        lastRepair,
        adjustedDailyRevenue,
        constructionCost,
        currentRepairCost,
      });
    }

    // 整站统一 sweep:把所有有效建筑放入一次 sweep。
    const units: RepairUnit[] = buildingDataList
      .filter(b => b.adjustedDailyRevenue !== undefined && b.fullMaterials.length > 0)
      .map(b => ({
        dailyRevenue: b.adjustedDailyRevenue!,
        fullMaterials: b.fullMaterials,
        ageDays: b.ageNowDays,
      }));
    const currentRepairCosts = buildingDataList.map(b => b.currentRepairCost);
    const optimal = calculateOptimalRepair(units, currentRepairCosts);

    // 把整站 sweep 结果写到每个成员上。
    for (const b of buildingDataList) {
      const triggerDay = optimal?.optimalDay ?? Infinity;
      const daysUntilTrigger = Math.max(0, triggerDay - b.ageNowDays);
      const triggerTimestamp = now + daysUntilTrigger * MS_PER_DAY;
      entries.push({
        naturalId,
        target,
        ticker: b.building.module.reactorTicker,
        condition: b.condition,
        lastRepair: b.lastRepair,
        ageDays: b.ageNowDays,
        dailyRevenue: b.adjustedDailyRevenue,
        currentRepairCost: b.currentRepairCost,
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
