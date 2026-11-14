// 舰船耐久（维修阈值）分级的回归脚本 —— 带退出码，可自动判定成败。
//
// 用法：node --experimental-strip-types scripts/test-ship-condition.mjs
//
// 背景（2026-11-14）：XIT FLT 的船况告警一直用内联的 `>= 0.8 && <= 0.83` / `< 0.8`，
// FLEET 左侧船名列表要复用同一套阈值。为避免两处各改一半，判定收敛到
// `src/utils/ship-condition.ts` 的 shipConditionLevel()，本脚本锁定边界值。
import assert from 'node:assert/strict';

const { shipConditionLevel } = await import('../src/utils/ship-condition.ts');

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

// 维修临界：耐久 < 0.80。
check('0.79 为维修临界', () => assert.equal(shipConditionLevel(0.79), 'danger'));
check('0.5 为维修临界', () => assert.equal(shipConditionLevel(0.5), 'danger'));
check('0 为维修临界', () => assert.equal(shipConditionLevel(0), 'danger'));

// 临近维修：0.80 ~ 0.83（含两端）。
check('0.80 为临近维修', () => assert.equal(shipConditionLevel(0.8), 'warn'));
check('0.815 为临近维修', () => assert.equal(shipConditionLevel(0.815), 'warn'));
check('0.83 为临近维修', () => assert.equal(shipConditionLevel(0.83), 'warn'));

// 正常：> 0.83。
check('0.831 为正常', () => assert.equal(shipConditionLevel(0.831), 'ok'));
check('1 为正常', () => assert.equal(shipConditionLevel(1), 'ok'));

// 边界连续性：相邻两档不能同时命中同一个值。
check('阈值单调不重叠', () => {
  const levels = new Set();
  for (const v of [0.799, 0.8, 0.83, 0.831]) {
    levels.add(shipConditionLevel(v));
  }
  assert.deepEqual([...levels], ['danger', 'warn', 'ok']);
});

console.log(`\n${pass}/9 passed`);
