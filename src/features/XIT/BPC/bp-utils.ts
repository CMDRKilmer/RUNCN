// 造船蓝图配件全市场比价工具。
//
// 读取玩家蓝图的物料清单（BOM），统计每种配件在各 CX 交易所的买入价，
// 给出「单交易所总价」「最优混合采购总价」。
//
// 价格源（与 ARB 一致的读取约定，ToS 安全，不主动开 CXOB 缓冲窗）：
//   1. 若玩家已打开过该 (ticker, 交易所) 的实时订单簿（cxobStore），取其
//      最低卖一价（聚合该价位挂单量，遇到 MM 无限量订单即止）。
//   2. 否则回退到 FIO 15 分钟聚合价（cxStore.Ask + Supply）。
//
// 币种按 1:1 比较，不做汇率换算（同 ARB 的约定）；各交易所总价仍以本币种展示。

import { cxStore } from '@src/infrastructure/fio/cx';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { isFiniteOrder } from '@src/core/orders';

export interface BpcExchange {
  code: string;
  currency: string;
}

export interface BpcPricePoint {
  // 单价。
  price: number;
  // 该价位上的可买量（实时盘为聚合挂单量，FIO 为 Supply）。
  amount: number;
  // 是否来自玩家已打开的实时订单簿。
  live: boolean;
}

export interface BpcComponent {
  ticker: string;
  name: string;
  // 蓝图需求量。
  amount: number;
  // 交易所代码 -> 价格点。无该交易所价格时不包含此 key。
  prices: Map<string, BpcPricePoint>;
  // 全市场最便宜的交易所。
  bestExchange?: string;
  bestPrice?: number;
  bestAmount?: number;
  bestLive: boolean;
}

export interface BpcExchangeTotal {
  code: string;
  currency: string;
  // 该交易所采购全部「有价」配件的总价（本币种）。
  total: number;
  // 该交易所无报价的配件数。
  missing: number;
  // 该交易所是否凑齐全部配件。
  complete: boolean;
}

export interface BpcTotals {
  exchanges: BpcExchangeTotal[];
  // 最便宜的单交易所（complete 优先，再比 total）。
  cheapestSingle?: BpcExchangeTotal;
  // 最优混合：每种配件都按全市场最低价采购，1:1 合计。
  mixedTotal: number;
  // 任意交易所都没有报价的配件数。
  mixedMissing: number;
}

// 屏蔽列表：玩家不想在 BPC 中看的交易所（CI2/NC2 是 AI 主导、流动性差）。
const BPC_EXCLUDED_EXCHANGES = new Set(['CI2', 'NC2']);

// 六个 CX 交易所（去除屏蔽列表），按代码排序，各带本币种。
export function getBpcExchanges(): BpcExchange[] {
  return (exchangesStore.all.value ?? [])
    .slice()
    .filter(x => !BPC_EXCLUDED_EXCHANGES.has(x.code))
    .sort((a, b) => a.code.localeCompare(b.code))
    .map(x => ({ code: x.code, currency: x.currency.code }));
}

// 把实时订单簿的卖单聚合为「价位 -> 总量」，遇到 MM 无限量订单即止
// （与 ARB levelsFromOrders 同约定）。
function aggregateSellLevels(orders: PrunApi.CXBrokerOrder[]): Map<number, number> {
  const totals = new Map<number, number>();
  for (const order of orders) {
    if (!isFiniteOrder(order)) {
      break;
    }
    const price = order.limit.amount;
    totals.set(price, (totals.get(price) ?? 0) + order.amount);
  }
  return totals;
}

// 读取某 (ticker, 交易所) 的买入价（我们可拿到的最便宜卖单）。
// 实时盘优先；无实时盘则回退 FIO Ask。无数据返回 undefined。
function readBuyPrice(ticker: string, exchange: BpcExchange): BpcPricePoint | undefined {
  const orderBook = cxobStore.getByTicker(`${ticker}.${exchange.code}`);
  if (orderBook !== undefined) {
    const levels = aggregateSellLevels(orderBook.sellingOrders);
    if (levels.size > 0) {
      let bestPrice = Infinity;
      let bestAmount = 0;
      for (const [price, amount] of levels) {
        if (price < bestPrice) {
          bestPrice = price;
          bestAmount = amount;
        }
      }
      return { price: bestPrice, amount: bestAmount, live: true };
    }
  }
  const fio = cxStore.prices?.get(exchange.code)?.get(ticker);
  if (fio?.Ask !== undefined && fio.Ask !== null && fio.Ask > 0) {
    return { price: fio.Ask, amount: fio.Supply ?? 0, live: false };
  }
  return undefined;
}

// 把蓝图 BOM 聚合为按 ticker 合计的需求数（防御性处理同 ticker 多条目）。
export interface BpcMaterialNeed {
  ticker: string;
  name: string;
  amount: number;
}

export function collectBlueprintNeeds(blueprint?: PrunApi.Blueprint): BpcMaterialNeed[] {
  if (!blueprint) {
    return [];
  }
  const quantities = blueprint.billOfMaterial?.quantities ?? [];
  if (quantities.length === 0) {
    return [];
  }
  const byTicker = new Map<string, BpcMaterialNeed>();
  for (const item of quantities) {
    const ticker = item.material?.ticker;
    if (!ticker) {
      continue;
    }
    const amount = item.amount ?? 0;
    const existing = byTicker.get(ticker);
    if (existing) {
      existing.amount += amount;
    } else {
      byTicker.set(ticker, { ticker, name: item.material?.name ?? ticker, amount });
    }
  }
  return Array.from(byTicker.values());
}

// 计算每种配件在各交易所的买入价及全市场最优价。
export function computeComponents(
  needs: BpcMaterialNeed[],
  exchanges: BpcExchange[],
): BpcComponent[] {
  return needs.map(need => {
    const prices = new Map<string, BpcPricePoint>();
    let bestExchange: string | undefined;
    let bestPrice: number | undefined;
    let bestAmount: number | undefined;
    let bestLive = false;
    for (const exchange of exchanges) {
      const point = readBuyPrice(need.ticker, exchange);
      if (!point) {
        continue;
      }
      prices.set(exchange.code, point);
      if (bestPrice === undefined || point.price < bestPrice) {
        bestPrice = point.price;
        bestExchange = exchange.code;
        bestAmount = point.amount;
        bestLive = point.live;
      }
    }
    return {
      ticker: need.ticker,
      name: need.name,
      amount: need.amount,
      prices,
      bestExchange,
      bestPrice,
      bestAmount,
      bestLive,
    };
  });
}

// 计算各交易所总价、最便宜单交易所、最优混合总价。
// 若传入 selectedTickers，只计算被选中配件的合计。
export function computeTotals(
  components: BpcComponent[],
  exchanges: BpcExchange[],
  selectedTickers?: Set<string>,
): BpcTotals {
  const selected = selectedTickers
    ? components.filter(c => selectedTickers.has(c.ticker))
    : components;

  const exchangeTotals: BpcExchangeTotal[] = exchanges.map(exchange => {
    let total = 0;
    let missing = 0;
    for (const component of selected) {
      const point = component.prices.get(exchange.code);
      if (!point) {
        missing++;
        continue;
      }
      total += point.price * component.amount;
    }
    return {
      code: exchange.code,
      currency: exchange.currency,
      total,
      missing,
      complete: missing === 0,
    };
  });

  let cheapestSingle: BpcExchangeTotal | undefined;
  for (const et of exchangeTotals) {
    if (!et.complete) {
      continue;
    }
    if (!cheapestSingle || et.total < cheapestSingle.total) {
      cheapestSingle = et;
    }
  }

  let mixedTotal = 0;
  let mixedMissing = 0;
  for (const component of selected) {
    if (component.bestPrice === undefined) {
      mixedMissing++;
      continue;
    }
    mixedTotal += component.bestPrice * component.amount;
  }

  return { exchanges: exchangeTotals, cheapestSingle, mixedTotal, mixedMissing };
}
