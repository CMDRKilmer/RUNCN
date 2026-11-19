import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import type { NativeRouteStep } from './native-route-plan';
import type { NativeRouteRecord } from './native-route-registry';

// 出发地起飞前必须备好的物料：一组「装载」步骤的汇总。
// 「按容量装载」没有确定数量，无法下单，跳过。
export function billFromLoadSteps(steps: readonly NativeRouteStep[]) {
  const bill: Record<string, number> = {};
  for (const step of steps) {
    if (step.kind !== 'load' || step.capacity) {
      continue;
    }
    bill[step.ticker] = (bill[step.ticker] ?? 0) + step.amount;
  }
  return bill;
}

// 出发地（航点 0）起飞前必须备好的物料：航线的「装载」步骤。
export function nativeRouteOriginBill(record: NativeRouteRecord) {
  return billFromLoadSteps(record.waypoints[0]?.steps ?? []);
}

// 还差多少才够出航：清单扣掉出发地仓库现有库存。
export function billShortfall(
  bill: Readonly<Record<string, number>>,
  stock: Readonly<Record<string, number>>,
) {
  const shortfall: Record<string, number> = {};
  for (const [ticker, amount] of Object.entries(bill)) {
    const missing = amount - (stock[ticker] ?? 0);
    if (missing > 0) {
      shortfall[ticker] = missing;
    }
  }
  return shortfall;
}

// 出发地仓库库存：航线在空间站装载，买在同一个交易所的货就落进这个仓库。
// 库存没加载时按 0 处理——清单本身就是要备齐的东西。
export function readOriginStock(origin: string) {
  const station = stationsStore.getByNaturalId(origin);
  const store = station === undefined ? undefined : storagesStore.getById(station.warehouseId);
  const stock: Record<string, number> = {};
  for (const item of store?.items ?? []) {
    if (item.quantity) {
      const ticker = item.quantity.material.ticker;
      stock[ticker] = (stock[ticker] ?? 0) + item.quantity.amount;
    }
  }
  return stock;
}

// 出发地缺口采购包：清单扣掉仓库库存后只含 CX Buy（useCXInv:false 避免重复抵扣）。
// 出发地不是交易所、或已经备齐时不生成。单趟备货与循环 N 轮备货共用。
export function cxShortfallPackage(
  origin: string,
  bill: Readonly<Record<string, number>>,
): UserData.ActionPackageData | undefined {
  const exchange = origin === '' ? undefined : exchangesStore.getByNaturalId(origin)?.code;
  if (exchange === undefined) {
    return undefined;
  }
  const materials = billShortfall(bill, readOriginStock(origin));
  if (Object.keys(materials).length === 0) {
    return undefined;
  }
  const name = `购买 ${exchange}`;
  return {
    global: { name },
    groups: [{ type: 'Manual', name, materials }],
    actions: [{ type: 'CX Buy', name, group: name, exchange, useCXInv: false }],
  };
}

// 未运行的航线备货：只含出发地缺口的 CX 采购包（暂存到 XIT FLEETACT 执行）。
// 出发地不是交易所、或已经备齐时不生成。
export function nativeRoutePurchasePackage(
  record: NativeRouteRecord,
): UserData.ActionPackageData | undefined {
  const origin = record.waypoints[0]?.location.trim() ?? '';
  return cxShortfallPackage(origin, nativeRouteOriginBill(record));
}
