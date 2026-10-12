// 链上货物按下游优先度装载（不按比例缩放）回归脚本 ——
// 锁定的行为契约：
//   ① 比例装载（出发地装载用）：所有 item 按同一比例缩放；超载（剩余量=0）时直接 return
//     true 不写 cargo（视为「整批都装不下，跳过」，符合 set 返 0 的语义）。
//   ② 优先装载（环线链上输送用）：按 dest 优先度（越小越优先）逐条装填，超载 item 部分装入；
//     完全装不下的 item 跳过（不载人）。剩余舱容 0 时所有未装 item 一律跳过。
//
// 用法：node scripts/verify-chain-fit-priority.mjs
// 退出码：0 = 全部通过；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
//
// 模块直接 import 生产代码 src/features/XIT/FLEET/chain-fit.ts（无 Vue/DOM 依赖）——
// Node ≥ 22.18 原生剥离 TS 类型标注，无需 loader 重定向。

import {
  pushItemsProportional,
  pushItemsPrioritised,
} from '../src/features/XIT/FLEET/chain-fit.ts';

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

// 标准密度材料：1 单位 = 1 kg + 1 L（便于人工算账）。
const std = (ticker, amount) => ({ weight: amount, volume: amount });
// 轻量：1 单位 = 1 kg + 10 L（按体积吃掉舱容）。
const fat = (ticker, amount) => ({ weight: amount, volume: amount * 10 });

// 场景 1：链上 3 条 item（舱容 100/100），每条 50/50；priority=A=0, B=1, C=2。
// 装载顺序：A(50/50) → 剩余 50/50；B(50/50) 装得下 → 装载 → 剩余 0/0；C 跳过。
// 总装载 2 条，A 和 B 各 50，C 跳过。
{
  const state = { weight: 0, volume: 0, free: { weight: 100, volume: 100 }, cargo: [] };
  const items = [
    { ticker: 'X', amount: 50, dest: 'A' },
    { ticker: 'X', amount: 50, dest: 'B' },
    { ticker: 'X', amount: 50, dest: 'C' },
  ];
  const clipped = pushItemsPrioritised(items, state, std, { A: 0, B: 1, C: 2 });
  assertEq('cap-fits-one/cargo 长度 = 2', 2, state.cargo.length);
  assertEq('cap-fits-one/A 装载 50', 50, state.cargo.find(x => x.dest === 'A')?.amount);
  assertEq('cap-fits-one/B 装载 50', 50, state.cargo.find(x => x.dest === 'B')?.amount);
  assertEq(
    'cap-fits-one/C 跳过（cargo 中无 C）',
    0,
    state.cargo.filter(x => x.dest === 'C').length,
  );
  assertEq('cap-fits-one/A.amount 保持', 50, items[0].amount);
  assertEq('cap-fits-one/B.amount 保持', 50, items[1].amount);
  assertEq('cap-fits-one/C.amount 清零（未装入）', 0, items[2].amount);
  assertEq('cap-fits-one/clipped=true（C 被截断）', true, clipped);
}

// 场景 2：priority 全部未提供 → 按入参顺序（items 已在 dest 顺序排好），B 同样装得下。
{
  const state = { weight: 0, volume: 0, free: { weight: 100, volume: 100 }, cargo: [] };
  const items = [
    { ticker: 'X', amount: 50, dest: 'A' },
    { ticker: 'X', amount: 50, dest: 'B' },
  ];
  const clipped = pushItemsPrioritised(items, state, std, {});
  assertEq('no-priority/cargo 长度 = 2', 2, state.cargo.length);
  assertEq('no-priority/A 装载 50', 50, state.cargo[0].amount);
  assertEq('no-priority/B 装载 50', 50, state.cargo[1].amount);
  assertEq('no-priority/clipped=false', false, clipped);
}

// 场景 3：舱容只够部分装入：item.amount=100，剩余 30；裁到 30。
{
  const state = { weight: 0, volume: 0, free: { weight: 30, volume: 30 }, cargo: [] };
  const items = [{ ticker: 'X', amount: 100, dest: 'A' }];
  const clipped = pushItemsPrioritised(items, state, std, {});
  assertEq('partial/amount 裁到 30', 30, items[0].amount);
  assertEq('partial/cargo 装载 30', 30, state.cargo[0].amount);
  assertEq('partial/clipped=true', true, clipped);
}

// 场景 4：舱容充足：所有 item 完整装载、clipped=false。
{
  const state = { weight: 0, volume: 0, free: { weight: 1000, volume: 1000 }, cargo: [] };
  const items = [
    { ticker: 'X', amount: 10, dest: 'A' },
    { ticker: 'X', amount: 20, dest: 'B' },
    { ticker: 'X', amount: 30, dest: 'C' },
  ];
  const clipped = pushItemsPrioritised(items, state, std, { A: 0, B: 1, C: 2 });
  assertEq('all-fit/cargo 长度 = 3', 3, state.cargo.length);
  assertEq('all-fit/A 装载 10', 10, state.cargo.find(x => x.dest === 'A')?.amount);
  assertEq('all-fit/B 装载 20', 20, state.cargo.find(x => x.dest === 'B')?.amount);
  assertEq('all-fit/C 装载 30', 30, state.cargo.find(x => x.dest === 'C')?.amount);
  assertEq('all-fit/clipped=false', false, clipped);
}

// 场景 5：比例装载：所有 item 按同一比例缩放。
{
  const state = { weight: 0, volume: 0, free: { weight: 100, volume: 100 }, cargo: [] };
  const items = [
    { ticker: 'X', amount: 100, dest: 'A' },
    { ticker: 'X', amount: 100, dest: 'B' },
  ];
  // 总量 200，但仓 100；按比例 0.5 → 各 50
  const clipped = pushItemsProportional(items, state, std);
  assertEq('prop/A 装载 50', 50, items[0].amount);
  assertEq('prop/B 装载 50', 50, items[1].amount);
  assertEq('prop/cargo 总重 = 100', 100, state.weight);
  assertEq('prop/clipped=true', true, clipped);
}

// 场景 6：比例装载超载 = 0：剩余舱容 0 → 整批直接 return true，items 不被改写、cargo 不追加。
{
  const state = { weight: 0, volume: 0, free: { weight: 0, volume: 0 }, cargo: [] };
  const items = [
    { ticker: 'X', amount: 100, dest: 'A' },
    { ticker: 'X', amount: 100, dest: 'B' },
  ];
  const clipped = pushItemsProportional(items, state, std);
  assertEq('prop-zero/items[0].amount 不被改写（保持 100）', 100, items[0].amount);
  assertEq('prop-zero/items[1].amount 不被改写（保持 100）', 100, items[1].amount);
  assertEq('prop-zero/cargo 未追加', 0, state.cargo.length);
  assertEq('prop-zero/clipped=true', true, clipped);
}

// 场景 7：体积顶缺：fat 物质 50 个，每个 1kg + 10L；仓 (100kg, 20L)；体积先到顶。
{
  const state = { weight: 0, volume: 0, free: { weight: 100, volume: 20 }, cargo: [] };
  const items = [{ ticker: 'X', amount: 50, dest: 'A' }];
  pushItemsPrioritised(items, state, fat, {});
  assertEq('vol-cap/amount 裁到 2', 2, items[0].amount);
  assertEq('vol-cap/cargo 装载 2', 2, state.cargo[0].amount);
}

// 场景 8：链上优先装载 vs 比例装载——同一组输入：
//   优先装载：最重要的下游（A, priority=0）拿满，剩余装 B 的部分，C 全跳。
//   比例装载：A=B=C=26（同步削减）。
//   这一条是「按下游优先度装载」vs「按比例缩放装载」对外契约差异的核心断言，
//   防回归：未来别把 pushItemsPrioritised 退回 pushItemsProportional。
{
  const state = { weight: 0, volume: 0, free: { weight: 80, volume: 100 }, cargo: [] };
  const items = [
    { ticker: 'X', amount: 50, dest: 'A' },
    { ticker: 'X', amount: 50, dest: 'B' },
    { ticker: 'X', amount: 50, dest: 'C' },
  ];
  // 比例：总量 150 → 80/150 = 0.533 → 各 26 (向下取整)
  pushItemsProportional(items, state, std);
  assertEq('prior-vs-prop/比例装载 A 26', 26, items.find(x => x.dest === 'A').amount);
  assertEq('prior-vs-prop/比例装载 B 26', 26, items.find(x => x.dest === 'B').amount);
  assertEq('prior-vs-prop/比例装载 C 26', 26, items.find(x => x.dest === 'C').amount);
  // 重置 state 与 items 以重新装载
  state.cargo = [];
  state.weight = 0;
  state.volume = 0;
  items.forEach(it => (it.amount = 50));
  // 优先装载：priority A=0, B=1, C=2。
  pushItemsPrioritised(items, state, std, { A: 0, B: 1, C: 2 });
  // 期望：A 满 50 (剩余 30)，B 部分 30，C 跳过
  assertEq('prior-vs-prop/优先装载 A 满 50', 50, state.cargo.find(x => x.dest === 'A')?.amount);
  assertEq('prior-vs-prop/优先装载 B 部分 30', 30, state.cargo.find(x => x.dest === 'B')?.amount);
  assertEq(
    'prior-vs-prop/优先装载 C 跳过（cargo 中无 C）',
    0,
    state.cargo.filter(x => x.dest === 'C').length,
  );
  assertEq('prior-vs-prop/cargo 长度 = 2', 2, state.cargo.length);
}

console.log('\nPASS ' + passes + '/' + (passes + fails));
if (fails > 0) {
  process.exit(1);
}
