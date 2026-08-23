import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { userDataStore } from '@src/infrastructure/prun-api/data/user-data';

// MM 订单没有数量字段。
export function isFiniteOrder(
  order: PrunApi.CXBrokerOrder,
): order is PrunApi.CXBrokerOrder & { amount: number } {
  return order.amount !== null;
}

// 交易所挂单价位步长（CXOS 压价同款）：按价格档位取下一档的步进。
export function getPriceStep(price: number) {
  if (price >= 10000) {
    return 100;
  }
  if (price >= 1000) {
    return 10;
  }
  return 1;
}

// 挂单限价：压过（排除自己后）第 rank 名卖价一档，使新订单成为卖价第 rank 名。
// 无卖单可参考时返回 undefined；rank 超出盘口深度时钳到最深一档。
export function getSellLimitPrice(
  asks: PrunApi.CXBrokerOrder[],
  rank: number,
  ownTraderId?: string | null,
) {
  const others = asks.filter(x => x.trader.id !== ownTraderId);
  const index = Math.min(Math.max(rank, 1) - 1, others.length - 1);
  if (index < 0) {
    return undefined;
  }
  const base = others[index].limit.amount;
  const target = base - getPriceStep(base);
  return target > 0 ? target : base;
}

// 如果任一生产线有循环订单，则视所有生产线都有循环订单。
const hasRecurringOrders = computed(() => {
  if (userDataStore.subscriptionLevel !== 'PRO') {
    return false;
  }
  return productionStore.all.value?.some(line => line.orders.some(x => x.recurring)) ?? false;
});

export function getRecurringOrders(line: PrunApi.ProductionLine) {
  return hasRecurringOrders.value
    ? line.orders.filter(x => !x.started && x.recurring)
    : line.orders.filter(x => !x.started);
}
