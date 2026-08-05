// 给定 PrUn API ProductionLine,严格照搬 PRUNplanner productionRevenue 算法。
// 算法来源:PRUNplanner frontend usePlanCalculation.ts::dailyRevenue (L489-493):
//
//   dailyIncome = Σ outputs.amount × priceSELL
//   dailyCost   = Σ inputs.amount  × priceBUY
//   dailyRevenue = (dailyIncome − dailyCost) × maxDailyRuns
//   maxDailyRuns = TOTAL_MS_DAY × line.efficiency / template.duration.ms
//
// 其中 PRUNplanner 的 priceSELL = Bid, priceBUY = Ask(来自配置的 CX exchange)。
// 这里直接读 cxStore 原始字段,避免被 userData.settings.pricing.method 覆盖。

import { cxStore } from '@src/infrastructure/fio/cx';
import { userData } from '@src/store/user-data';

const TOTAL_MS_DAY = 86400000;

function getAskPrice(ticker: string): number {
  if (!cxStore.fetched) {
    return 0;
  }
  const exchange = cxStore.prices.get(userData.settings.pricing.exchange);
  return exchange?.get(ticker)?.Ask ?? 0;
}

function getBidPrice(ticker: string): number {
  if (!cxStore.fetched) {
    return 0;
  }
  const exchange = cxStore.prices.get(userData.settings.pricing.exchange);
  return exchange?.get(ticker)?.Bid ?? 0;
}

// 给定 PrUn API ProductionLine,计算 per-building per-day net production revenue。
// 仅当该 line 有活跃 order(已 started、未 halted)且对应 template 可找到时返回数值。
// 否则返回 undefined(由调用方降级)。
//
// 注意:用户选择"仅按生产配方计算",因此不含 PRUNplanner 的 workforceDailyCost 与
// (1/180) × constructionCost 两项,与 PRUNplanner 略有差异。
export function calculateProductionRevenue(line: PrunApi.ProductionLine): number | undefined {
  const activeOrder = line.orders.find(o => o.started !== null && !o.halted);
  if (!activeOrder) {
    return undefined;
  }
  const template = line.productionTemplates.find(t => t.id === activeOrder.recipeId);
  if (!template) {
    return undefined;
  }
  const durationMs = template.duration.millis;
  if (durationMs <= 0) {
    return undefined;
  }
  const maxDailyRuns = (TOTAL_MS_DAY * line.efficiency) / durationMs;
  const dailyIncome = template.outputFactors.reduce(
    (sum, f) => sum + f.factor * getBidPrice(f.material.ticker),
    0,
  );
  const dailyCost = template.inputFactors.reduce(
    (sum, f) => sum + f.factor * getAskPrice(f.material.ticker),
    0,
  );
  return (dailyIncome - dailyCost) * maxDailyRuns;
}
