import { cxStore } from '@src/infrastructure/fio/cx';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { materialCategoriesStore } from '@src/infrastructure/prun-api/data/material-categories';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';

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

// Distinct material category names (human-readable), sorted. Used by the category filter.
export function getCategories(): string[] {
  const categories = materialCategoriesStore.all.value ?? [];
  return categories.map(x => x.name).sort();
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
export function computeOpportunities(): ArbOpportunity[] {
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
        bestBuy = {
          exchange: exchange.code,
          currency: exchange.currency,
          price: quote.ask,
          supply: quote.supply ?? 0,
          live: quote.live,
        };
      }
      if (quote.bid !== null && quote.bid > 0 && quote.bid > bestSell.price) {
        bestSell = {
          exchange: exchange.code,
          currency: exchange.currency,
          price: quote.bid,
          demand: quote.demand ?? 0,
          live: quote.live,
        };
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
      category: materialCategoriesStore.getById(material.category)?.name ?? material.category,
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
