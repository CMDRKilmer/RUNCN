// 环线出发地装货拆分（纯函数，无 store / DOM 依赖）：
// 把各站账单拆成「出发地仓库取货」与「CX 采购」两部分。
//
// 契约：
//   1. 每个 ticker 的账单需求先由出发地仓库库存补足（`pickup`），剩余为缺口。
//   2. 普通物资的缺口一律转 CX 采购（`buy`）——不读「购买」开关，否则关闭开关会让
//      缺口静默消失（账单要求卸货，但 MTRA 按实际库存装不满，基地实收少于计划）。
//   3. 组内产出（`groupProduced`）的缺口永不采购，只回报给调用方用于警告。
//   4. 仓库库存是跨站共享资源，按 `order` 顺序消耗，先到先得。
//
// 局限：只做数量拆分，不判断舱容；装不下的部分由规划阶段的舱容模拟裁剪。

export interface OriginPickupInput {
  // 站 visit 顺序（naturalId）。
  order: string[];
  // 每站账单：naturalId → ticker → 需求数量。
  bills: Map<string, Record<string, number>>;
  // 出发地空间站仓库库存（ticker → 数量），会被本函数消耗。
  originStock: Record<string, number>;
  // 组内产出的 ticker：缺口只警告，不采购。
  groupProduced: Set<string>;
}

export interface OriginPickupResult {
  // naturalId → ticker → 从仓库取货的数量。
  pickupByStop: Map<string, Record<string, number>>;
  // ticker → 按站汇总的取货量（用于展示）。
  pickupTotals: Record<string, number>;
  // ticker → 组内产出无法由仓库补足的缺口（用于警告，不得进装船账单）。
  producedGap: Map<string, number>;
}

export function splitOriginPickup(input: OriginPickupInput): OriginPickupResult {
  const remainingStock = new Map(Object.entries(input.originStock));
  const pickupByStop = new Map<string, Record<string, number>>();
  const pickupTotals: Record<string, number> = {};
  const producedGap = new Map<string, number>();
  for (const id of input.order) {
    const bill = input.bills.get(id);
    if (bill === undefined) {
      continue;
    }
    for (const [ticker, need] of Object.entries(bill)) {
      if (need <= 0) {
        continue;
      }
      const stock = remainingStock.get(ticker) ?? 0;
      const pickup = Math.min(need, stock);
      if (pickup > 0) {
        const byTicker = pickupByStop.get(id) ?? {};
        byTicker[ticker] = (byTicker[ticker] ?? 0) + pickup;
        pickupByStop.set(id, byTicker);
        pickupTotals[ticker] = (pickupTotals[ticker] ?? 0) + pickup;
        remainingStock.set(ticker, stock - pickup);
      }
      const gap = need - pickup;
      if (gap > 0 && input.groupProduced.has(ticker)) {
        producedGap.set(ticker, (producedGap.get(ticker) ?? 0) + gap);
      }
    }
  }
  return { pickupByStop, pickupTotals, producedGap };
}

// 站点装船账单拆成「采购」与「取货」：返回采购量（cxBill 由调用方按站累加）。
// 组内产出永不采购；普通物资只采购仓库装不上的缺口。
export function stopPurchase(
  amounts: Record<string, number>,
  stopPickup: Record<string, number> | undefined,
  groupProduced: Set<string>,
): Record<string, number> {
  const purchase: Record<string, number> = {};
  for (const [ticker, amount] of Object.entries(amounts)) {
    if (amount <= 0 || groupProduced.has(ticker)) {
      continue;
    }
    const buy = amount - (stopPickup?.[ticker] ?? 0);
    if (buy > 0) {
      purchase[ticker] = buy;
    }
  }
  return purchase;
}
