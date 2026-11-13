// 标签栏拖拽顺序对账回归脚本 —— 带退出码，可自动判定成败。
//
// 用法：node --experimental-strip-types scripts/test-tab-order.mjs
//
// 背景（PR #60 审查）：删除过屏幕后 `userData.tabs.order` 仍保留已删 ID（sync.ts
// 只追加不删除），但标签栏渲染的是过滤后的列表。把 Sortable 的 DOM 索引直接套到
// 完整清单上会错位：`[deleted, A, B]` 里把 B 拖到 A 前，实际移动的是保存的 A。
//
// 锁定的行为契约：拖拽后的可见顺序按 screen id 写回，只重排「仍在的屏幕」的槽位，
// 已删除 ID 原位保留；结果与输入顺序一致时不应产生无谓改动。
import assert from 'node:assert/strict';
import { reconcileTabOrder } from '../src/features/basic/screen-tab-bar/order.ts';

let pass = 0;
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
};

// 把不在 isPresent 里的 ID 视为「已删除的屏幕」。
const present = ids => id => ids.includes(id);

check('审查示例：已删 ID 在首位时，拖 B 到 A 前只重排 A/B', () => {
  // 旧实现按索引移动会动到 deleted 或 A，可见顺序不变。
  const got = reconcileTabOrder(['deleted', 'A', 'B'], ['B', 'A'], present(['A', 'B']));
  assert.deepEqual(got, ['deleted', 'B', 'A']);
});

check('已删 ID 在中间时保持原位', () => {
  const got = reconcileTabOrder(['A', 'deleted', 'B'], ['B', 'A'], present(['A', 'B']));
  assert.deepEqual(got, ['B', 'deleted', 'A']);
});

check('多个已删 ID 分散时都保持原位、相对次序不变', () => {
  const got = reconcileTabOrder(
    ['d1', 'A', 'd2', 'B', 'C', 'd3'],
    ['C', 'A', 'B'],
    present(['A', 'B', 'C']),
  );
  assert.deepEqual(got, ['d1', 'C', 'd2', 'A', 'B', 'd3']);
});

check('没有已删 ID 时就是普通的整表重排', () => {
  const got = reconcileTabOrder(['A', 'B', 'C'], ['C', 'A', 'B'], present(['A', 'B', 'C']));
  assert.deepEqual(got, ['C', 'A', 'B']);
});

check('顺序没变时输出与输入完全一致（不产生无谓写入）', () => {
  const before = ['d1', 'A', 'B'];
  const got = reconcileTabOrder(before, ['A', 'B'], present(['A', 'B']));
  assert.deepEqual(got, before);
  assert.equal(got.join('|'), before.join('|'));
});

check('拖拽结果漏掉的仍在屏幕按原顺序补回，不丢标签', () => {
  const got = reconcileTabOrder(['A', 'B', 'C'], ['C', 'A'], present(['A', 'B', 'C']));
  assert.deepEqual(got, ['C', 'A', 'B']);
});

check('拖拽结果含不属于当前清单的 ID 时忽略，不凭空插入', () => {
  const got = reconcileTabOrder(['A', 'B'], ['ghost', 'B', 'A'], present(['A', 'B']));
  assert.deepEqual(got, ['B', 'A']);
});

check('拖拽结果里的重复 ID 只保留一次', () => {
  const got = reconcileTabOrder(['A', 'B', 'C'], ['B', 'B', 'A', 'C'], present(['A', 'B', 'C']));
  assert.deepEqual(got, ['B', 'A', 'C']);
});

check('刚删除屏幕：新出现的可见顺序里不含它，它仍留在原槽位', () => {
  // before = [A, B, C]，B 刚被删除；可见顺序变成 [C, A]。
  // 可见槽位（索引 0、2）按新顺序填 C、A，已删的 B 保持索引 1。
  const got = reconcileTabOrder(['A', 'B', 'C'], ['C', 'A'], present(['A', 'C']));
  assert.deepEqual(got, ['C', 'B', 'A']);
});

console.log(`\n${pass} 项通过`);
