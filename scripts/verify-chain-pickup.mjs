// 环线出发地装货拆分回归脚本 ——
// 锁定的行为契约（chain-pickup.ts）：
//   ① 仓库优先取货：账单需求先由出发地仓库库存补足，仓库是跨站共享资源，按 order 先到先得。
//   ② 缺口转采购：普通物资装不上的部分一律进采购——不读「购买」开关（关闭开关不得静默丢货）。
//   ③ 组内产出永不采购：缺口只进 producedGap 供警告，且绝不计入装船账单。
//   ④ cxBill = 实际能装船的量；purchaseBill ⊆ cxBill；二者之差即「取货」。
//
// 用法：node scripts/verify-chain-pickup.mjs
// 退出码：0 = 全部通过；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
//
// 直接 import 生产代码 src/features/XIT/FLEET/chain-pickup.ts（纯函数，无 store/DOM 依赖），
// Node ≥ 22.18 原生剥离 TS 类型标注，无需 loader 重定向。
//
// 局限：本脚本只覆盖数量拆分口径，不覆盖舱容裁剪（那是 chain-fit.ts 的契约，见
// verify-chain-fit-priority.mjs），也不覆盖订单簿供应缩减（依赖 cxobStore）。

import { splitOriginPickup, stopPurchase } from '../src/features/XIT/FLEET/chain-pickup.ts';

let passes = 0;
let fails = 0;

function assertEq(label, expected, actual) {
  const e = JSON.stringify(expected);
  const a = JSON.stringify(actual);
  if (e === a) {
    console.log('  PASS ' + label);
    passes++;
  } else {
    console.log('  FAIL ' + label + '\n    expected=' + e + '\n    actual  =' + a);
    fails++;
  }
}

const NONE = new Set();

// 场景 1：普通物资仓库充足 → 全部取货，零采购。
{
  const r = splitOriginPickup({
    order: ['A1'],
    bills: new Map([['A1', { RAT: 100 }]]),
    originStock: { RAT: 100 },
    groupProduced: NONE,
  });
  assertEq('stock-covers/pickup', { RAT: 100 }, r.pickupByStop.get('A1') ?? {});
  assertEq('stock-covers/purchase', {}, stopPurchase({ RAT: 100 }, r.pickupByStop.get('A1'), NONE));
  assertEq('stock-covers/producedGap 空', {}, Object.fromEntries(r.producedGap));
}

// 场景 2：仓库只有一部分 → 能装的取货，剩余缺口转采购（不丢货）。
{
  const r = splitOriginPickup({
    order: ['A1'],
    bills: new Map([['A1', { RAT: 100 }]]),
    originStock: { RAT: 30 },
    groupProduced: NONE,
  });
  assertEq('partial-stock/pickup=30', { RAT: 30 }, r.pickupByStop.get('A1') ?? {});
  assertEq(
    'partial-stock/purchase=70（缺口转采购）',
    { RAT: 70 },
    stopPurchase({ RAT: 100 }, r.pickupByStop.get('A1'), NONE),
  );
}

// 场景 3：仓库无货 → 全额采购，不产生取货。
// 这是 PR 要修的核心：旧实现下未开启「购买」的站会既不取货也不采购，缺口静默消失。
{
  const r = splitOriginPickup({
    order: ['A1'],
    bills: new Map([['A1', { RAT: 100 }]]),
    originStock: {},
    groupProduced: NONE,
  });
  assertEq('no-stock/pickup 无该站', undefined, r.pickupByStop.get('A1')?.['RAT']);
  assertEq(
    'no-stock/purchase=100（全额采购，不静默丢货）',
    { RAT: 100 },
    stopPurchase({ RAT: 100 }, r.pickupByStop.get('A1'), NONE),
  );
}

// 场景 4：组内产出缺口永不采购，且只进 producedGap（不进装船账单）。
{
  const produced = new Set(['PCB']);
  const r = splitOriginPickup({
    order: ['A1'],
    bills: new Map([['A1', { PCB: 100, SEN: 50 }]]),
    originStock: { PCB: 40, SEN: 50 },
    groupProduced: produced,
  });
  assertEq('produced/pickup', { PCB: 40, SEN: 50 }, r.pickupByStop.get('A1') ?? {});
  assertEq('produced/PCB 缺口=60 记录', { PCB: 60 }, Object.fromEntries(r.producedGap));
  assertEq(
    'produced/PCB 不进采购',
    { SEN: undefined },
    (() => {
      const p = stopPurchase({ PCB: 100, SEN: 50 }, r.pickupByStop.get('A1'), produced);
      return { SEN: p.PCB };
    })(),
  );
  assertEq('produced/采购为空', {}, stopPurchase({ PCB: 100 }, r.pickupByStop.get('A1'), produced));
}

// 场景 5：仓库是跨站共享资源，按 order 先到先得（A1 拿满后 A2 拿不到）。
{
  const r = splitOriginPickup({
    order: ['A1', 'A2'],
    bills: new Map([
      ['A1', { RAT: 80 }],
      ['A2', { RAT: 80 }],
    ]),
    originStock: { RAT: 100 },
    groupProduced: NONE,
  });
  assertEq('shared/A1 拿满 80', 80, r.pickupByStop.get('A1')?.['RAT']);
  assertEq('shared/A2 只剩 20', 20, r.pickupByStop.get('A2')?.['RAT']);
  assertEq('shared/汇总 100', 100, r.pickupTotals['RAT']);
  assertEq(
    'shared/A2 缺口转采购 60',
    { RAT: 60 },
    stopPurchase({ RAT: 80 }, r.pickupByStop.get('A2'), NONE),
  );
}

// 场景 6：不修改调用方的 originStock（纯函数，不产生副作用）。
{
  const stock = { RAT: 100 };
  splitOriginPickup({
    order: ['A1'],
    bills: new Map([['A1', { RAT: 80 }]]),
    originStock: stock,
    groupProduced: NONE,
  });
  assertEq('pure/调用方库存不被改写', 100, stock.RAT);
}

// 场景 7：cxBill − purchaseBill 恰为取货量（「取货」行的展示口径）。
{
  const bills = new Map([
    ['A1', { RAT: 100, PCB: 60 }],
    ['A2', { RAT: 50 }],
  ]);
  const produced = new Set(['PCB']);
  const r = splitOriginPickup({
    order: ['A1', 'A2'],
    bills,
    originStock: { RAT: 70, PCB: 10 },
    groupProduced: produced,
  });
  const cxBill = { RAT: 150, PCB: 60 };
  const purchase = {};
  for (const id of ['A1', 'A2']) {
    const p = stopPurchase(bills.get(id), r.pickupByStop.get(id), produced);
    for (const [t, v] of Object.entries(p)) {
      purchase[t] = (purchase[t] ?? 0) + v;
    }
  }
  const take = {};
  for (const [t, v] of Object.entries(cxBill)) {
    const d = v - (purchase[t] ?? 0);
    if (d > 0) {
      take[t] = d;
    }
  }
  assertEq('split/purchase', { RAT: 80 }, purchase);
  assertEq('split/take = cxBill - purchase', { RAT: 70, PCB: 60 }, take);
  // 取货行的 RAT 必须与实际分配的取货量一致（不是缺口，也不是原始需求）。
  assertEq('split/take 与 pickupTotals 的普通物资一致', 70, r.pickupTotals['RAT']);
  // 组内产出无采购，故其「取货」= cxBill 全额，且缺口不在其中。
  assertEq('split/PCB 缺口不进 cxBill', 60, cxBill['PCB']);
  assertEq('split/PCB 缺口=50 单列于警告', 50, r.producedGap.get('PCB'));
}

console.log('');
console.log(`PASS ${passes}/${passes + fails}`);
process.exit(fails === 0 ? 0 : 1);
