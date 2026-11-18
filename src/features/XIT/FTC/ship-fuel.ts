// 飞船当前剩余 STL / FTL 燃料（从飞船油罐 store 实测）。
//
// 单列成模块是为了让公式模型（formula-plan / chain-flight-time）不必 import 旧的
// ftc-compute 编排模块；ftc-compute 仍按原路径 re-export，旧调用方无需改动。
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';

export interface ShipFuelRemaining {
  stlRemaining: number;
  ftlRemaining: number;
  stlCap: number;
  ftlCap: number;
}

export function shipFuelRemainingFor(s: PrunApi.Ship): ShipFuelRemaining {
  // ⚠️ 必须用 getById（键 = store id），**不是** getByAddressableId（键 = 仓库可寻址地址 /
  // siteId / warehouseId）：两者键类型不同，传 store id 进后者永远查不到 → 余量恒 0
  // （用户 2026-09-25 实测症状「当前油量 STL 0/0 ｜ FTL 0/0」+ 假缺口警告的根因）。
  // 飞船同时有 stlFuelStoreId 与 idStlFuelStore 两个字段（见 ships.types.d.ts），与
  // QuickRefuelDialog.vue 同口径：优先前者、回退后者（实测两者都下发，留回退防缺字段）。
  // getById 对 undefined/未 fetched 入参安全（create-entity-store.ts 内 `!id` 判空）。
  const stlStore = storagesStore.getById(s.stlFuelStoreId ?? s.idStlFuelStore);
  const ftlStore = storagesStore.getById(s.ftlFuelStoreId ?? s.idFtlFuelStore);
  const sumQty = (store?: PrunApi.Store) =>
    store?.items
      .filter(i => i.type === 'INVENTORY')
      .reduce((sum, i) => sum + (i.quantity?.amount ?? 0), 0) ?? 0;
  return {
    stlRemaining: sumQty(stlStore),
    ftlRemaining: sumQty(ftlStore),
    stlCap: stlStore?.weightCapacity ?? 0,
    ftlCap: ftlStore?.weightCapacity ?? 0,
  };
}
