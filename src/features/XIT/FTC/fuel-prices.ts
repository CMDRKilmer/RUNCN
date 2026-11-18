// 燃料单价：从 FIO 读取四大市场（AI1/CI1/IC1/NC1）报价，按**简单平均数**计价。
//
// 口径：
// - 数据源 `https://rest.fnar.net/exchange/all`（一次取全部物料 × 交易所，响应约 380 KB），
//   只保留 SF（STL 燃料）与 FF（FTL 燃料）× 四大市场；会话内缓存 10 分钟，避免反复拉取。
// - 每个市场取 FIO 的 `PriceAverage`（FIO 自己按成交滚动的均价）；缺失时回退买一 `Ask`，
//   再回退卖一 `Bid`。四市场 currencies 不同（AIC/CIS/ICA/NCC），按仓库既有约定
//   **1:1 不换汇**（与 BPC/BMAT/GOVH 同口径）。
// - 只对拿得到报价的市场求平均；缺价的市场不参与（返回值带明细供界面提示）。
// - 面板不再提供手填单价：单价始终取此处结果；取不到时成本列显示「未计价」。
import { ref } from 'vue';

const FIO_EXCHANGE_ALL = 'https://rest.fnar.net/exchange/all';
// 会话内缓存时长：FIO 的均价本身是滚动值，10 分钟足够新。
const CACHE_MS = 10 * 60 * 1000;

/** 四个玩家 CX 交易所（与 BPC/BMAT/ARB/SELL 的硬编码顺序一致）。 */
export const FUEL_EXCHANGES = ['AI1', 'CI1', 'IC1', 'NC1'] as const;

/** 燃料物料：STL = SF，FTL = FF。 */
export const FUEL_TICKERS = { stl: 'SF', ftl: 'FF' } as const;

export interface FuelMarketQuote {
  code: string;
  price: number;
}

export interface FuelAveragePrice {
  // 四市场平均数（只统计有报价的市场）；无任何报价时为 undefined。
  average?: number;
  markets: FuelMarketQuote[];
}

export interface FuelPricesState {
  stl: FuelAveragePrice;
  ftl: FuelAveragePrice;
  // 最近一次成功取数的时间（毫秒）；undefined = 还没取到过。
  fetchedAt?: number;
  loading: boolean;
  error?: string;
}

// FIO /exchange/all 的行结构（只列用到的字段）。
interface FioExchangeRow {
  MaterialTicker?: string;
  ExchangeCode?: string;
  PriceAverage?: number | null;
  Ask?: number | null;
  Bid?: number | null;
}

const empty = (): FuelAveragePrice => ({ markets: [] });

export const fuelPrices = ref<FuelPricesState>({
  stl: empty(),
  ftl: empty(),
  loading: false,
});

let cache: { at: number; rows: FioExchangeRow[] } | undefined;
let inflight: Promise<boolean> | undefined;

function marketPrice(row: FioExchangeRow | undefined) {
  const candidates = [row?.PriceAverage, row?.Ask, row?.Bid];
  return candidates.find((x): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0);
}

function averageOf(rows: FioExchangeRow[], ticker: string): FuelAveragePrice {
  const markets: FuelMarketQuote[] = [];
  for (const code of FUEL_EXCHANGES) {
    const row = rows.find(x => x.MaterialTicker === ticker && x.ExchangeCode === code);
    const price = marketPrice(row);
    if (price !== undefined) {
      markets.push({ code, price });
    }
  }
  if (markets.length === 0) {
    return { markets };
  }
  const sum = markets.reduce((total, x) => total + x.price, 0);
  return { average: sum / markets.length, markets };
}

// 同步读取当前均价（数据由 ensureFuelPrices 填充）。
// 仅供 verify-fuel-average.mjs 断言均价；面板用的是 fuelPrices 这个 ref 本身。
export function readFuelAverages() {
  return { stl: fuelPrices.value.stl, ftl: fuelPrices.value.ftl };
}

async function fetchRows(): Promise<FioExchangeRow[]> {
  // FIO 偶发慢响应：给 15 s 上界，避免面板「计算」被无限期挂住。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(FIO_EXCHANGE_ALL, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`FIO HTTP ${response.status}`);
    }
    const data = (await response.json()) as FioExchangeRow[];
    if (!Array.isArray(data)) {
      throw new Error('FIO 返回了非预期的数据格式');
    }
    const wanted = new Set<string>(Object.values(FUEL_TICKERS));
    return data.filter(
      x =>
        typeof x.MaterialTicker === 'string' &&
        wanted.has(x.MaterialTicker) &&
        typeof x.ExchangeCode === 'string' &&
        (FUEL_EXCHANGES as readonly string[]).includes(x.ExchangeCode),
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('FIO 请求超时');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// 取四市场均价（带缓存与并发合并）。返回是否拿到了至少一种燃料的报价。
export async function ensureFuelPrices(force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && cache !== undefined && now - cache.at < CACHE_MS) {
    return true;
  }
  if (inflight !== undefined) {
    return inflight;
  }
  fuelPrices.value = { ...fuelPrices.value, loading: true, error: undefined };
  inflight = (async () => {
    try {
      const rows = await fetchRows();
      cache = { at: Date.now(), rows };
      fuelPrices.value = {
        stl: averageOf(rows, FUEL_TICKERS.stl),
        ftl: averageOf(rows, FUEL_TICKERS.ftl),
        fetchedAt: cache.at,
        loading: false,
      };
      return (
        fuelPrices.value.stl.average !== undefined || fuelPrices.value.ftl.average !== undefined
      );
    } catch (error) {
      // 取数失败：保留上一次的结果，只记录错误文案（面板照旧按「未计价」处理）。
      fuelPrices.value = {
        ...fuelPrices.value,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      };
      return false;
    } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}
