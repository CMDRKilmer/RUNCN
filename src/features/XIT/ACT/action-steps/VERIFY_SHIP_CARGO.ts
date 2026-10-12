import { act } from '@src/features/XIT/ACT/act-registry';
import { AssertFn } from '@src/features/XIT/ACT/shared-types';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { sleep } from '@src/utils/sleep';

interface Data {
  registration: string;
  // ticker → 期望剩余上限（<= N 即认为 OK）；0 表示不允许存在任何单位；缺省 = 任意剩余。
  verifyRemaining?: Record<string, number>;
}

// 单次轮询间隔。
const POLL_INTERVAL_MS = 500;
// 总等待上限（避免船卡住时无限阻塞）。
const VERIFY_TIMEOUT_MS = 30_000;

export const VERIFY_SHIP_CARGO = act.addActionStep<Data>({
  type: 'Verify Ship Cargo',
  description: data => {
    const tickers = Object.keys(data.verifyRemaining ?? {});
    return `验证 ${data.registration} 货舱空出：${tickers.length > 0 ? tickers.join('、') : '（无 ticker 约束）'}`;
  },
  execute: async ctx => {
    const { data, log, setStatus, complete, fail } = ctx;
    const assert: AssertFn = ctx.assert;
    const { registration } = data;
    const remaining = data.verifyRemaining ?? {};
    assert(registration, `Verify Ship Cargo 缺少飞船注册号`);

    setStatus(`等待 ${registration} 货舱空出...`);

    // 船可能仍在飞或在港；以 cargo store 可用为唯一条件，refresh 由 storages 自然处理。
    const findShipStore = () => {
      const ship = shipsStore.getByRegistration(registration);
      if (!ship) {
        return undefined;
      }
      // 飞船货舱是 addressableId = ship.id 的 SHIP_STORE 类型 store。
      const stores = storagesStore.getByAddressableId(ship.id) ?? [];
      return stores.find(s => s.type === 'SHIP_STORE');
    };

    // 解析 ticker → store 里实际数量的查找闭包。
    const remainingAmount = (store: PrunApi.Store, ticker: string): number => {
      let total = 0;
      for (const item of store.items) {
        if (item.quantity?.material.ticker === ticker) {
          total += item.quantity.amount;
        }
      }
      return total;
    };

    const allCleared = (store: PrunApi.Store): boolean => {
      for (const [ticker, cap] of Object.entries(remaining)) {
        const amt = remainingAmount(store, ticker);
        if (amt > cap) {
          return false;
        }
      }
      return true;
    };

    const deadline = Date.now() + VERIFY_TIMEOUT_MS;
    for (;;) {
      const store = findShipStore();
      if (store && allCleared(store)) {
        log.info(`${registration} 货舱已清空指定物资`);
        complete();
        return;
      }
      if (Date.now() > deadline) {
        const storeDesc =
          store === undefined
            ? '（未读到货舱数据）'
            : Object.entries(remaining)
                .filter(([ticker, cap]) => remainingAmount(store, ticker) > cap)
                .map(([ticker, cap]) => `${ticker}=剩${remainingAmount(store, ticker)}/${cap}`)
                .join('、');
        fail(
          `${registration} 货舱未在 ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s 内清空指定物资：${storeDesc}。` +
            `请检查 MTRA 是否成功落库后重试。`,
        );
        return;
      }
      await sleep(POLL_INTERVAL_MS);
    }
  },
});
