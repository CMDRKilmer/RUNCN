#!/usr/bin/env node
// 校验「系内转移段速度查询表」路径（fuel-model.stlIntraTransitSpeedFor 走表时的精度）。
//
// 用法: node scripts/verify-transit-lookup.mjs
// 退出码: 0 = 整体平均 <= 10% 且内部区间 <= 10%；1 = 不达标；2 = 表缺失
//
// 契约：
//   - 表来自 public/json/transit-speed-table.json（构建产物，与扩展运行时同一份）
//   - 对每个受控扫描点，构造与扫描一致的 ShipPerformance，调用生产函数 stlIntraTransitSpeedFor
//   - 「内部区间」= a_eff 50–120（该区间实测平均 4.2–4.9%）
//   - 外推区（Q≈25 / a_eff 两端）不参与 PASS 判定，但会打印出来

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stlIntraTransitSpeedFor,
  setTransitSpeedTableForTest,
} from '../src/features/XIT/FTC/fuel-model.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const tablePath = resolve(repo, 'public', 'json', 'transit-speed-table.json');
if (!existsSync(tablePath)) {
  console.log('SKIP 表缺失: ' + tablePath);
  process.exit(2);
}
const table = JSON.parse(readFileSync(tablePath, 'utf8'));
setTransitSpeedTableForTest(table.byEngine);
console.log('表已装载：引擎 ' + Object.keys(table.byEngine).join(', '));

const calib = resolve(repo, 'data', 'ftc-calibration');
const dump = JSON.parse(readFileSync(resolve(calib, 'prun-blueprint-dump.json'), 'utf8'));
const BP = {};
for (const b of dump.blueprints) {
  const e = (b.selections ?? []).find(s => s.type === 'STL_ENGINE');
  BP[b.naturalId] = {
    mass: b.performance.operatingEmptyMass,
    acc: b.performance.acceleration,
    cap: b.performance.stlFuelCapacity,
    eng: e?.option,
  };
}

const files = [];
const readdir = (await import('node:fs')).readdirSync;
for (const f of readdir(calib)) {
  if (/^(controlled-|grid2d-).*\.json$/.test(f)) files.push(f);
}

const rows = [];
for (const f of files) {
  let j;
  try {
    j = JSON.parse(readFileSync(resolve(calib, f), 'utf8'));
  } catch {
    continue;
  }
  const b = BP[j.blueprintId];
  if (!b || !b.eng || !b.acc) continue;
  const total = b.mass + (j.payload ?? 0);
  for (const s of j.samples) {
    if (!(s.transitSeconds > 0)) continue;
    const measured = s.transitKm / s.transitSeconds;
    const ship = {
      mass: total,
      operatingEmptyMass: b.mass,
      acceleration: b.acc,
      ftlMaxSpeed: 0,
      reactorPower: 0,
      condition: 1,
      stlEngineOption: b.eng,
      stlFuelCapacity: j.stlFuel,
      stlRemaining: j.stlFuel,
    };
    const predicted = stlIntraTransitSpeedFor(ship, s.fuelUsageFactor);
    if (!(predicted > 0)) continue;
    const aEff = (b.acc * b.mass) / total;
    const Q = 0.98 * j.stlFuel * Math.min(s.fuelUsageFactor, 0.5);
    rows.push({ aEff, Q, measured, predicted, err: Math.abs(predicted - measured) / measured });
  }
}
console.log('对照点=' + rows.length);

const interior = rows.filter(r => r.aEff >= 50 && r.aEff <= 120);
const avg = g => (g.length ? g.reduce((a, r) => a + r.err, 0) / g.length : 0);
const mx = g => (g.length ? Math.max(...g.map(r => r.err)) : 0);

const checks = [];
checks.push([
  '内部区间(a_eff 50-120) 平均 <= 10%',
  interior.length > 0 && avg(interior) <= 0.1,
  (avg(interior) * 100).toFixed(1) + '%  n=' + interior.length,
]);
checks.push(['整体平均 <= 10%', avg(rows) <= 0.1, (avg(rows) * 100).toFixed(1) + '%']);
checks.push([
  '整体最大 <= 70%（外推区已计入）',
  mx(rows) <= 0.7,
  (mx(rows) * 100).toFixed(1) + '%',
]);

for (const [name, ok, detail] of checks) {
  console.log((ok ? 'PASS ' : 'FAIL ') + name + '  → ' + detail);
}
console.log('');
console.log('--- 分区间 ---');
for (const [lo, hi] of [
  [0, 25],
  [25, 50],
  [50, 80],
  [80, 120],
  [120, 200],
  [200, 1000],
]) {
  const g = rows.filter(r => r.aEff >= lo && r.aEff < hi);
  if (!g.length) continue;
  console.log(
    '  a_eff ' +
      String(lo).padStart(3) +
      '-' +
      String(hi).padStart(4) +
      '  n=' +
      String(g.length).padStart(3) +
      '  平均 ' +
      (avg(g) * 100).toFixed(1) +
      '%  最大 ' +
      (mx(g) * 100).toFixed(1) +
      '%',
  );
}
const bad = rows.filter(r => r.err > 0.15).length;
console.log('');
console.log(
  '超 15% 的点: ' + bad + ' / ' + rows.length + '（集中在 Q≈25 与 a_eff 两端的**外推区**）',
);

process.exit(checks.every(c => c[1]) ? 0 : 1);
