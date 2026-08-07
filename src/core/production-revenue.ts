// 给定 PrUn API ProductionLine,计算 per-line per-day 净产出货币值。
//
// 数据来源区分:
//   - 活跃订单(queued orders + recurring orders)→ 用 order.outputs/inputs.amount × capacity × msInDay / totalDuration
//   - productionTemplates(每个建筑最多2个,executor 等无 orders 的建筑用 templates)
//     → 用 template.outputFactors/inputs 的 factor × line.efficiency × msInDay / duration
//
// 价格读取:统一走 userData.settings.pricing.method,与 FINPR / XIT FIN RP 对齐,
// 默认 VWAP7D(可选 ASK / BID / AVG / VWAP7D / VWAP30D)。旧版硬编码 Bid/Ask spread
// 会把买卖价差全算成亏损,与用户期望的"实际成交均价"语义不一致——已修正。
//
// 返回 per-line(含 capacity 个并行槽位)的日产值;调用方按 building 数拆分时需除以 line.capacity。

import { getPrice } from '@src/infrastructure/fio/cx';
import { sumBy } from '@src/utils/sum-by';
import { getRecurringOrders } from '@src/core/orders';

const MS_PER_DAY = 86400000;

// 按用户定价方法(pricing.method)读 ticker 单价。
// 缺失价格(忽略列表 / 未上市)返回 0,与 getPrice 自身行为一致。
function getMaterialPrice(ticker: string): number {
  return getPrice(ticker) ?? 0;
}

// 从 order 的 amount/duration 算 per-line per-day 净产值(照搬 FINPR 算法)。
// 注意:照搬 FINPR::getRecurringOrders——只用 queued(!started) orders。
// started order 是「正在跑的批次」，其 duration 是当前 batch 的剩余/总时间，
// 会被反复加进 totalDuration;FINPR 故意排除以避免重复计算。
function revenueFromOrders(line: PrunApi.ProductionLine): number | undefined {
  // 跳过无 duration 的 queued orders(避免 totalDuration 变 Infinity 导致 perDayAmount=0)。
  const orders = getRecurringOrders(line).filter(o => o.duration?.millis != null);
  const totalDuration = sumBy(orders, x => x.duration?.millis ?? 0);
  if (totalDuration <= 0 || !isFinite(totalDuration) || orders.length === 0) {
    return undefined;
  }
  let dailyIncome = 0;
  let dailyCost = 0;
  for (const order of orders) {
    if (!order.duration) {
      continue;
    }
    for (const mat of order.outputs) {
      const perDayAmount = (mat.amount * line.capacity * MS_PER_DAY) / totalDuration;
      dailyIncome += perDayAmount * getMaterialPrice(mat.material.ticker);
    }
    for (const mat of order.inputs) {
      const perDayAmount = (mat.amount * line.capacity * MS_PER_DAY) / totalDuration;
      dailyCost += perDayAmount * getMaterialPrice(mat.material.ticker);
    }
  }
  return dailyIncome - dailyCost;
}

// 从 productionTemplates 算 per-line per-day 净产值(RESOURCES 建筑无 orders,用 templates)。
// 公式(PRUNplanner usePlanCalculation.ts):
//   per-template per-ms rate = (Σ outputs×price − Σ inputs×price) × line.efficiency / template.duration
//   其中 template.outputFactors.factor 是不含 efficiency 的绝对产出量
//   (experts.ts L22 证实:order.outputs.amount / factor = orderSize,即 factor 不含 efficiency)
//   line.efficiency 是当前建筑 totalEfficiency(condition+experts+COGC),与 sweep 起点的
//   PRUNplanner totalEfficiency 语义一致。
//   per-line per-day = per-template × line.capacity × msInDay
function revenueFromTemplates(line: PrunApi.ProductionLine): number | undefined {
  const templates = line.productionTemplates;
  if (templates.length === 0) {
    return undefined;
  }
  let total = 0;
  for (const template of templates) {
    const durationMs = template.duration.millis;
    if (durationMs <= 0) {
      continue;
    }
    let perTemplateIncome = 0;
    let perTemplateCost = 0;
    for (const f of template.outputFactors) {
      perTemplateIncome += f.factor * getMaterialPrice(f.material.ticker);
    }
    for (const f of template.inputFactors) {
      perTemplateCost += f.factor * getMaterialPrice(f.material.ticker);
    }
    const perMs = ((perTemplateIncome - perTemplateCost) * line.efficiency) / durationMs;
    total += perMs * line.capacity * MS_PER_DAY;
  }
  return total;
}

export function calculateProductionRevenue(line: PrunApi.ProductionLine): number | undefined {
  // 优先用活跃订单(FINPR/BURN 同源算法);无订单时回退到 templates。
  return revenueFromOrders(line) ?? revenueFromTemplates(line);
}
