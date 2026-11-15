// 造船 / 购物车比价在 Node 下的最小测试替身。
//
// 仅服务于 scripts/test-bpc-totals.mjs：scripts/lib/bpc-node-loader.mjs 的 resolve
// 钩子把 bp-utils.ts 的两个浏览器侧依赖（cxobStore / isFiniteOrder）重定向到这里，
// 让真实实现里的 computeTotals 能在 Node 里被直接驱动。
//
// ⚠️ 局限性：computeTotals 是纯函数，不读 cxobStore —— 这里只为让模块能加载。
// 本替身**不**模拟订单簿，也不覆盖 readBuyPrice / computeComponents 的行为。
export const cxobStore = {
  all: { value: [] },
  getByTicker: () => undefined,
  get: () => undefined,
};

export function isFiniteOrder() {
  return false;
}

// cbuy-inventory.ts 在模块顶层 import 这三个 store（只在函数体内调用），
// 其 deductNeeds 是纯函数、不读它们；这里仅为让模块能加载。
const emptyStore = {
  fetched: { value: false },
  all: { value: [] },
  getNaturalIdFromCode: () => undefined,
  getByEntityNaturalId: () => undefined,
  getById: () => undefined,
  getByAddressableId: () => undefined,
};

export const exchangesStore = emptyStore;
export const warehousesStore = emptyStore;
export const storagesStore = emptyStore;
