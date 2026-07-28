import { cxStore } from '@src/infrastructure/fio/cx';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { materialCategoriesStore } from '@src/infrastructure/prun-api/data/material-categories';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getMaterialCategoryName } from '@src/infrastructure/prun-ui/i18n';
import { isFiniteOrder } from '@src/core/orders';

export interface ArbOpportunity {
  // Stable row key: ticker + buy side + sell side.
  key: string;
  ticker: string;
  name: string;
  category: string;
  buyExchange: string;
  buyCurrency: string;
  buyPrice: number;
  buyQuantity: number;
  buyLive: boolean;
  sellExchange: string;
  sellCurrency: string;
  sellPrice: number;
  sellQuantity: number;
  sellLive: boolean;
  profitPerUnit: number;
  profitPct: number;
  executableVolume: number;
  totalProfit: number;
}

export interface ArbExchange {
  code: string;
  currency: string;
}

// The six CX exchanges, sorted by code. Each carries its native faction currency.
export function getArbExchanges(): ArbExchange[] {
  return (exchangesStore.all.value ?? [])
    .slice()
    .sort((a, b) => a.code.localeCompare(b.code))
    .map(x => ({ code: x.code, currency: x.currency.code }));
}

// Distinct material category ids, sorted. Used by the category filter. id 是 i18n
// 缓存的 key（见 i18n.ts 的 `categoryNameById`）。
export function getCategories(): string[] {
  const categories = materialCategoriesStore.all.value ?? [];
  return categories.map(x => x.id).sort();
}

// 把类别 id 解析为本地化显示名。
// 直接走 PrUn 的 getMaterialCategoryName（内部已带 i18n + store 兜底），
// 与 MarketView 用同一份逻辑，避免双轨。
export function resolveCategoryLabel(id: string): string {
  return getMaterialCategoryName(id) ?? id;
}

interface PriceLevel {
  exchange: string;
  currency: string;
  price: number;
  amount: number;
  live: boolean;
}

// Aggregate live order book orders into distinct price levels. Stops at the
// first MM order (no finite amount) and ignores anything beyond it, matching
// the convention used by the CXOB depth bars feature.
function levelsFromOrders(exchange: ArbExchange, orders: PrunApi.CXBrokerOrder[]): PriceLevel[] {
  const totals = new Map<number, number>();
  for (const order of orders) {
    if (!isFiniteOrder(order)) {
      break;
    }
    const price = order.limit.amount;
    totals.set(price, (totals.get(price) ?? 0) + order.amount);
  }
  const levels: PriceLevel[] = [];
  for (const [price, amount] of totals) {
    levels.push({
      exchange: exchange.code,
      currency: exchange.currency,
      price,
      amount,
      live: true,
    });
  }
  return levels;
}

// Buy-side levels (sell orders we can take). Sell-side levels (buy orders we
// can fill). cxob live order book takes precedence; FIO 15-min aggregate is the
// fallback when the broker has not been opened.
function readBuyLevels(ticker: string, exchange: ArbExchange): PriceLevel[] {
  const orderBook = cxobStore.getByTicker(`${ticker}.${exchange.code}`);
  if (orderBook !== undefined) {
    const levels = levelsFromOrders(exchange, orderBook.sellingOrders);
    if (levels.length > 0) {
      return levels;
    }
  }
  const fio = cxStore.prices?.get(exchange.code)?.get(ticker);
  if (fio?.Ask !== undefined && fio.Ask !== null && fio.Ask > 0) {
    return [
      {
        exchange: exchange.code,
        currency: exchange.currency,
        price: fio.Ask,
        amount: fio.Supply ?? 0,
        live: false,
      },
    ];
  }
  return [];
}

function readSellLevels(ticker: string, exchange: ArbExchange): PriceLevel[] {
  const orderBook = cxobStore.getByTicker(`${ticker}.${exchange.code}`);
  if (orderBook !== undefined) {
    const levels = levelsFromOrders(exchange, orderBook.buyingOrders);
    if (levels.length > 0) {
      return levels;
    }
  }
  const fio = cxStore.prices?.get(exchange.code)?.get(ticker);
  if (fio?.Bid !== undefined && fio.Bid !== null && fio.Bid > 0) {
    return [
      {
        exchange: exchange.code,
        currency: exchange.currency,
        price: fio.Bid,
        amount: fio.Demand ?? 0,
        live: false,
      },
    ];
  }
  return [];
}

// For every material, enumerate every profitable (buy level × sell level)
// combination across the CX exchanges. Each price level carries its own
// available quantity, so each combination becomes its own row with an
// executable volume capped by the tighter side.
// Currency comparison is 1:1 per the feature spec (no FX conversion).
// `sourceExchange` / `destExchange` 如果指定则只在该交易所寻找买入/卖出机会。
export function computeOpportunities(
  sourceExchange?: string,
  destExchange?: string,
): ArbOpportunity[] {
  const materials = materialsStore.all.value;
  if (!materials || !cxStore.fetched) {
    return [];
  }

  const exchanges = getArbExchanges();
  const opportunities: ArbOpportunity[] = [];

  for (const material of materials) {
    const buyLevels: PriceLevel[] = [];
    for (const exchange of exchanges) {
      if (sourceExchange && exchange.code !== sourceExchange) {
        continue;
      }
      for (const level of readBuyLevels(material.ticker, exchange)) {
        if (level.amount > 0) {
          buyLevels.push(level);
        }
      }
    }
    if (buyLevels.length === 0) {
      continue;
    }

    const sellLevels: PriceLevel[] = [];
    for (const exchange of exchanges) {
      if (destExchange && exchange.code !== destExchange) {
        continue;
      }
      for (const level of readSellLevels(material.ticker, exchange)) {
        if (level.amount > 0) {
          sellLevels.push(level);
        }
      }
    }
    if (sellLevels.length === 0) {
      continue;
    }

    for (const buy of buyLevels) {
      for (const sell of sellLevels) {
        if (sell.price <= buy.price) {
          continue;
        }
        const profitPerUnit = sell.price - buy.price;
        const profitPct = buy.price > 0 ? profitPerUnit / buy.price : 0;
        const executableVolume = Math.min(buy.amount, sell.amount);
        opportunities.push({
          key: `${material.ticker}|${buy.exchange}|${buy.price}|${sell.exchange}|${sell.price}`,
          ticker: material.ticker,
          name: material.name,
          category: material.category,
          buyExchange: buy.exchange,
          buyCurrency: buy.currency,
          buyPrice: buy.price,
          buyQuantity: buy.amount,
          buyLive: buy.live,
          sellExchange: sell.exchange,
          sellCurrency: sell.currency,
          sellPrice: sell.price,
          sellQuantity: sell.amount,
          sellLive: sell.live,
          profitPerUnit,
          profitPct,
          executableVolume,
          totalProfit: profitPerUnit * executableVolume,
        });
      }
    }
  }

  return opportunities;
}
