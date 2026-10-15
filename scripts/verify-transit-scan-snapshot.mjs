// 转移段扫描产物的「蓝图快照」回归。
//
// 契约（当前）：scanTransitFuelCurve / scanTransitMatrix 的产物必须带 blueprint 快照，
// 含 stlEngine / stlFuelTank / operatingEmptyMass / stlFuelCapacity / selections。
//
// 为什么需要：2026-10-13 那次采集传的罐 8000 与蓝图真实罐 1500 不一致，而产物里只有
// 一个 stlFuel 数字 —— 事后无法判断那组速度属于哪套部件，整批作废。快照就是这条教训的固化。
//
// 用法：node --import ./scripts/lib/transit-scan-register.mjs scripts/verify-transit-scan-snapshot.mjs
//   （需先注册模块解析替身，把 transit-f-scan.ts 的浏览器侧依赖重定向；见 scripts/lib/transit-scan-loader.mjs）
// 退出码：0 = 通过；1 = 断言失败。
//
// 变异验证（证明断言不是恒绿）：把 blueprintSnapshotOf 改成返回 {} → 全部 FAIL。

import { blueprintSnapshotOf } from '../src/infrastructure/prun-api/data/transit-f-scan.ts';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const calib = resolve(here, '..', 'data', 'ftc-calibration');

const summary = { pass: 0, fail: 0 };
function check(name, fn) {
  const failures = [];
  try {
    fn(failures);
  } catch (e) {
    failures.push('抛出异常 ' + String(e));
  }
  if (failures.length === 0) {
    summary.pass++;
    console.log('PASS ' + name);
  } else {
    summary.fail++;
    console.log('FAIL ' + name + ' :: ' + failures.join(' | '));
  }
}
function expect(failures, label, ok, expected, actual) {
  if (!ok) failures.push(label + ' expected=' + expected + ' actual=' + JSON.stringify(actual));
}

console.log('=== 转移段扫描产物：蓝图快照回归 ===\n');

// ---- 用真实蓝图 dump 当夹具（2026-10-13 实机导出）----
const dumpPath = resolve(calib, 'prun-blueprint-dump.json');
if (!existsSync(dumpPath)) {
  console.log('SKIP 夹具缺失：' + dumpPath);
  process.exit(0);
}
const dump = JSON.parse(readFileSync(dumpPath, 'utf8'));
const frvz = dump.blueprints.find(b => b.naturalId === 'BP-FRVZ-6104');
if (!frvz) {
  console.log('SKIP 夹具里没有 BP-FRVZ-6104');
  process.exit(0);
}

check('① 能提取 STL 引擎（fuelSaving）', failures => {
  const s = blueprintSnapshotOf(frvz);
  expect(failures, 'stlEngine', s.stlEngine === 'STL_ENGINE_FUEL_SAVING', 'STL_ENGINE_FUEL_SAVING', s.stlEngine);
});

check('② 能提取 STL 罐选项与容量（small / 1500）', failures => {
  const s = blueprintSnapshotOf(frvz);
  expect(failures, 'stlFuelTank', s.stlFuelTank === 'STL_FUEL_TANK_SMALL', 'STL_FUEL_TANK_SMALL', s.stlFuelTank);
  expect(failures, 'stlFuelCapacity', s.stlFuelCapacity === 1500, 1500, s.stlFuelCapacity);
});

check('③ 能提取整备质量（825.8t）', failures => {
  const s = blueprintSnapshotOf(frvz);
  expect(failures, 'operatingEmptyMass', s.operatingEmptyMass === 825.8, 825.8, s.operatingEmptyMass);
});

check('④ selections 全量转储且含关键部件', failures => {
  const s = blueprintSnapshotOf(frvz);
  expect(failures, 'selections 非空', s.selections !== undefined && Object.keys(s.selections).length > 0, '>0 keys', s.selections && Object.keys(s.selections).length);
  expect(failures, 'STL_ENGINE 在 selections 里', s.selections?.STL_ENGINE === 'STL_ENGINE_FUEL_SAVING', 'STL_ENGINE_FUEL_SAVING', s.selections?.STL_ENGINE);
});

check('⑤ 缺字段时留空而不编造', failures => {
  const s = blueprintSnapshotOf({ naturalId: 'X', selections: [], performance: {} });
  expect(failures, 'stlEngine 应为 undefined', s.stlEngine === undefined, 'undefined', s.stlEngine);
  expect(failures, 'stlFuelCapacity 应为 undefined', s.stlFuelCapacity === undefined, 'undefined', s.stlFuelCapacity);
  expect(failures, 'selections 应为空对象', JSON.stringify(s.selections) === '{}', '{}', s.selections);
});

check('⑥ 口径错配能被检出（请求罐 8000 vs 蓝图罐 1500）', failures => {
  const s = blueprintSnapshotOf(frvz);
  const requestedTank = 8000; // 2026-10-13 的真实错误
  const mismatch = s.stlFuelCapacity !== undefined && s.stlFuelCapacity !== requestedTank;
  expect(failures, '应判定为错配', mismatch === true, 'true', mismatch);
});

console.log('\nPASS ' + summary.pass + ' | FAIL ' + summary.fail);
process.exit(summary.fail > 0 ? 1 : 0);
