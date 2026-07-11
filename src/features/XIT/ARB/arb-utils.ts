import { cxStore } from '@src/infrastructure/fio/cx';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { materialCategoriesStore } from '@src/infrastructure/prun-api/data/material-categories';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getMaterialCategoryName } from '@src/infrastructure/prun-ui/i18n';

export interface ArbOpportunity {
  ticker: string;
  name: string;
  category: string;
  buyExchange: string;
  buyCurrency: string;
  buyPrice: number;
  buyLive: boolean;
  sellExchange: string;
  sellCurrency: string;
  sellPrice: number;
  sellLive: boolean;
  profitPerUnit: number;
  profitPct: number;
  executableVolume: number | null;
  totalProfit: number | null;
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

// 把类别 id 解析为本地化显示名（找不到时回退到可读 name）。
export function resolveCategoryLabel(id: string): string {
  const localized = getMaterialCategoryName(id);
  if (localized) {
    return localized;
  }
  const fallback = materialCategoriesStore.getById(id)?.name;
  return fallback ?? id;
}

interface MarketQuote {
  ask: number | null;
  bid: number | null;
  supply: number | null;
  demand: number | null;
  live: boolean;
}

// Best ask/bid for a ticker on one exchange. cxob live order book takes
// precedence over the 15-minute FIO aggregate when the broker has been opened.
function readMarket(ticker: string, exchangeCode: string): MarketQuote {
  const fio = cxStore.prices?.get(exchangeCode)?.get(ticker);
  const orderBook = cxobStore.getByTicker(`${ticker}.${exchangeCode}`);
  const ask = orderBook?.ask?.price.amount ?? fio?.Ask ?? null;
  const bid = orderBook?.bid?.price.amount ?? fio?.Bid ?? null;
  return {
    ask,
    bid,
    supply: fio?.Supply ?? null,
    demand: fio?.Demand ?? null,
    live: orderBook !== undefined,
  };
}

// For every material, find the cheapest ask (buy target) and the highest bid
// (sell target) across all CX exchanges, then derive the arbitrage metrics.
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
    let bestBuy = {
      exchange: '',
      currency: '',
      price: Infinity,
      supply: 0,
      live: false,
    };
    let bestSell = {
      exchange: '',
      currency: '',
      price: -Infinity,
      demand: 0,
      live: false,
    };

    for (const exchange of exchanges) {
      const quote = readMarket(material.ticker, exchange.code);
      if (quote.ask !== null && quote.ask > 0 && quote.ask < bestBuy.price) {
        if (sourceExchange && exchange.code !== sourceExchange) {
          // 指定了出发地，只在该交易所买入
        } else {
          bestBuy = {
            exchange: exchange.code,
            currency: exchange.currency,
            price: quote.ask,
            supply: quote.supply ?? 0,
            live: quote.live,
          };
        }
      }
      if (quote.bid !== null && quote.bid > 0 && quote.bid > bestSell.price) {
        if (destExchange && exchange.code !== destExchange) {
          // 指定了目的地，只在该交易所卖出
        } else {
          bestSell = {
            exchange: exchange.code,
            currency: exchange.currency,
            price: quote.bid,
            demand: quote.demand ?? 0,
            live: quote.live,
          };
        }
      }
    }

    if (!Number.isFinite(bestBuy.price) || !Number.isFinite(bestSell.price)) {
      continue;
    }

    const profitPerUnit = bestSell.price - bestBuy.price;
    const profitPct = bestBuy.price > 0 ? profitPerUnit / bestBuy.price : 0;
    const executableVolume =
      bestBuy.supply > 0 && bestSell.demand > 0 ? Math.min(bestBuy.supply, bestSell.demand) : null;
    const totalProfit = executableVolume !== null ? profitPerUnit * executableVolume : null;

    opportunities.push({
      ticker: material.ticker,
      name: material.name,
      category: material.category,
      buyExchange: bestBuy.exchange,
      buyCurrency: bestBuy.currency,
      buyPrice: bestBuy.price,
      buyLive: bestBuy.live,
      sellExchange: bestSell.exchange,
      sellCurrency: bestSell.currency,
      sellPrice: bestSell.price,
      sellLive: bestSell.live,
      profitPerUnit,
      profitPct,
      executableVolume,
      totalProfit,
    });
  }

  return opportunities;
}
