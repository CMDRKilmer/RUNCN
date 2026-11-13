// XIT CBUY 的仓库库存抵扣。
//
// 数据全部来自 PrUn 服务器推送的本地 store，不发起任何网络请求、不连接 FIO：
//   交易所仓库：exchangesStore -> warehousesStore -> storagesStore(WAREHOUSE_STORE)
//   基地仓库：  storagesStore.getByAddressableId(siteId) 中 type === 'STORE'
// 两处口径分别与 ACT runner/step-generator.ts 的 generateState()、REPD/entries.ts
// 的 getBaseInventory() 完全一致，保证 CBUY 算出的数量与 ACT 执行结果对齐。

import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';

export type CbuyInventory = Record<string, number>;

function summarize(store: PrunApi.Store | undefined): CbuyInventory {
  const result: CbuyInventory = {};
  for (const item of store?.items ?? []) {
    const quantity = item.quantity;
    if (!quantity) {
      continue;
    }
    const ticker = quantity.material.ticker;
    result[ticker] = (result[ticker] ?? 0) + quantity.amount;
  }
  return result;
}

// 交易所代码 -> 站点 naturalId -> warehouse -> WAREHOUSE_STORE。
// 与 ACT 的 state.WAR[exchange] 同源，因此扣完后必须把 ACT 的 useCXInv 关掉，
// 否则执行时还会再扣一次。
export function getExchangeWarehouseInventory(code?: string | null): CbuyInventory {
  if (!code) {
    return {};
  }
  const naturalId = exchangesStore.getNaturalIdFromCode(code);
  const warehouse = warehousesStore.getByEntityNaturalId(naturalId);
  return summarize(storagesStore.getById(warehouse?.storeId));
}

// 被维修基地自有的 STORE 库存（维修材料会从这里直接消耗，不必采购也不必运输）。
export function getBaseStoreInventory(siteId?: string | null): CbuyInventory {
  if (!siteId) {
    return {};
  }
  const store = storagesStore.getByAddressableId(siteId)?.find(x => x.type === 'STORE');
  return summarize(store);
}

// 三个 store 都由服务器推送，未就绪时应如实提示，不能把「还没有数据」当成「仓库没有库存」。
export function isCbuyInventoryReady(): boolean {
  return (
    exchangesStore.fetched.value === true &&
    warehousesStore.fetched.value === true &&
    storagesStore.fetched.value === true
  );
}

export interface CbuyNeed {
  ticker: string;
  name: string;
  amount: number;
}

export interface CbuyDeduction {
  ticker: string;
  name: string;
  /** 上游传来的完整需求（未扣任何库存） */
  gross: number;
  /** 基地仓库已抵扣的数量（仅 REPD 模式） */
  base: number;
  /** 交易所仓库已抵扣的数量 */
  exchange: number;
  /** 扣掉基地库存后、需要运到基地的完整数量（含交易所仓库原有的那部分） */
  transfer: number;
  /** 最终需要下单采购的数量 */
  net: number;
  /** 实际抵扣 / 出库的交易所代码：单市场模式统一为选定市场；分市场模式为各物料的
   *  最优价市场，无报价时退为有库存的交易所。ACT 生成时按此路由买 / 转，保证
   *  「在哪扣就在哪买 / 转」，避免数量错配（PR #60 审查 #220 / #223）。 */
  exchangeCode?: string;
}

// 解析某物料的实际出库交易所：优先用调用方指定的（单市场统一市场 / 分市场最优价）；
// 未指定（分市场且无报价）时，退而选一个仓库里真有该物料的交易所，保证纯转移行
// 能路由到供货仓库（PR #60 审查 #223）。
function resolveExchangeCode(
  ticker: string,
  preferred: string | undefined,
  byCode: Record<string, CbuyInventory>,
): string | undefined {
  if (preferred) {
    return preferred;
  }
  let best: string | undefined;
  let bestAmount = 0;
  for (const [code, inv] of Object.entries(byCode)) {
    const amount = Math.max(0, inv[ticker] ?? 0);
    if (amount > bestAmount) {
      bestAmount = amount;
      best = code;
    }
  }
  return best;
}

// 抵扣顺序：先扣被维修基地仓库（原本就在基地、不需要买也不需要运），
// 再扣「实际出库交易所」的仓库（不用买，但要随采购品一起运到基地）。
// 因此 transfer = gross - base，net = transfer - exchange，且 net + exchange = transfer。
// 第二参数由 `exchangeInventoryByCode` 改为「交易所代码 -> 库存」的映射，配合
// `outboundExchange` 让每种物料按其实际出库市场抵扣，而不是统一扣一个市场
// （PR #60 审查 #220）。
export function deductNeeds(
  needs: ReadonlyArray<CbuyNeed>,
  baseInventory: CbuyInventory,
  exchangeInventoryByCode: Record<string, CbuyInventory>,
  outboundExchange?: (ticker: string) => string | undefined,
): CbuyDeduction[] {
  return needs.map(need => {
    const gross = Number.isFinite(need.amount) ? Math.max(0, Math.ceil(need.amount)) : 0;
    const base = Math.min(gross, Math.max(0, baseInventory[need.ticker] ?? 0));
    const transfer = Math.max(0, gross - base);
    const preferred = outboundExchange ? outboundExchange(need.ticker) : undefined;
    const code = resolveExchangeCode(need.ticker, preferred, exchangeInventoryByCode);
    const exchangeInv = code ? (exchangeInventoryByCode[code] ?? {}) : {};
    const exchange = Math.min(transfer, Math.max(0, exchangeInv[need.ticker] ?? 0));
    return {
      ticker: need.ticker,
      name: need.name,
      gross,
      base,
      exchange,
      transfer,
      net: Math.max(0, transfer - exchange),
      exchangeCode: code,
    };
  });
}
