#!/usr/bin/env node
// 分析 matrix-13bp-8f-*.json：13 份蓝图 × 8 个 f 档位。
// 目的：用更密的数据判断「系内转移段速度」的模型形式是否可辨识，
// 以及 tank / engine / mass 各自的作用。
//
// 只读 + 只打印；不写任何数据文件。

import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const calib = resolve(here, '..', 'data', 'ftc-calibration');

const matrixFile = readdirSync(calib).filter(f => /^matrix-13bp-.*\.json$/.test(f)).sort().pop();
if (!matrixFile) { console.log('FAIL 找不到 matrix-13bp-*.json'); process.exit(2); }
const m = JSON.parse(readFileSync(join(calib, matrixFile), 'utf8'));
const dump = JSON.parse(readFileSync(join(calib, 'prun-blueprint-dump.json'), 'utf8'));

// 从蓝图 dump 取：引擎、整备质量、罐
const info = {};
for (const b of dump.blueprints ?? []) {
  const sel = b.selections ?? [];
  const eng = sel.find(s => s.type === 'STL_ENGINE');
  const tank = sel.find(s => s.type === 'STL_FUEL_TANK');
  info[b.naturalId] = {
    engine: eng?.option ?? '?',
    tankPart: tank?.option ?? '?',
    mass: b.performance?.operatingEmptyMass ?? null,
    cap: b.performance?.stlFuelCapacity ?? null,
  };
}

console.log('数据文件: ' + matrixFile);
console.log('变体数: ' + m.variants.length + '   f 档位: ' + m.fuelFactors.join(',') + '\n');

// ---- 逐变体计算速度 v = km/s ----
const rows = [];
for (const v of m.variants) {
  const meta = info[v.blueprintId] ?? {};
  const pts = v.samples
    .map(s => ({ f: s.fuelUsageFactor, km: s.transitKm, sec: s.transitSeconds, fuel: s.transitFuel }))
    .filter(s => s.sec > 0)
    .map(s => ({ ...s, v: s.km / s.sec }))
    .sort((a, b) => a.f - b.f);
  rows.push({ bp: v.blueprintId, variant: v.variant, tank: v.stlFuel, engine: meta.engine, mass: meta.mass, pts });
}

// ---- 表 1：每个变体各 f 的速度 ----
console.log('=== 表1 每变体速度 v (km/s) ===');
const header = 'variant'.padEnd(15) + 'engine'.padEnd(26) + 'tank'.padStart(6) + 'mass'.padStart(8) + '  ' +
  m.fuelFactors.map(f => ('f=' + f).padStart(10)).join('');
console.log(header);
for (const r of rows) {
  const cells = m.fuelFactors.map(f => {
    const p = r.pts.find(x => Math.abs(x.f - f) < 1e-9);
    return (p ? Math.round(p.v) : '-').toString().padStart(10);
  }).join('');
  console.log(r.variant.padEnd(15) + String(r.engine).slice(0, 25).padEnd(26) +
    String(r.tank).padStart(6) + String(r.mass ?? '?').padStart(8) + '  ' + cells);
}

// ---- 表 2：归一化 v / v(f=0.5)，看是否按 tank 折叠 ----
console.log('\n=== 表2 归一化 v/v(f=0.5) —— 同一列内越接近说明形状一致 ===');
const byTank = {};
for (const r of rows) (byTank[r.tank] ??= []).push(r);
for (const tank of Object.keys(byTank).sort((a, b) => a - b)) {
  console.log('-- 罐 ' + tank + ' --');
  for (const r of byTank[tank]) {
    const v05 = r.pts.find(p => Math.abs(p.f - 0.5) < 1e-9)?.v;
    const cells = m.fuelFactors.map(f => {
      const p = r.pts.find(x => Math.abs(x.f - f) < 1e-9);
      return (p && v05 ? (p.v / v05).toFixed(3) : '-').padStart(10);
    }).join('');
    console.log('  ' + r.variant.padEnd(13) + r.engine.slice(0, 24).padEnd(26) + cells);
  }
}

// ---- 表 3：同罐同 f 下，不同引擎的差异 ----
console.log('\n=== 表3 同罐同 f 的速度离散度（判断引擎是否是主要变量）===');
for (const tank of Object.keys(byTank).sort((a, b) => a - b)) {
  const group = byTank[tank];
  const engines = new Set(group.map(r => r.engine));
  if (engines.size < 2) { console.log('罐 ' + tank + ': 只有一种引擎（' + [...engines][0] + '），无法比较'); continue; }
  const spread = m.fuelFactors.map(f => {
    const vs = group.map(r => r.pts.find(p => Math.abs(p.f - f) < 1e-9)?.v).filter(x => x > 0);
    if (vs.length < 2) return '-';
    return (Math.max(...vs) / Math.min(...vs)).toFixed(3);
  });
  console.log('罐 ' + String(tank).padStart(5) + '  引擎数=' + engines.size + '  max/min: ' + spread.join('  '));
}

// ---- 可辨识性：每变体拟合 v = vSat*(min(f,.5)/.5)^k ----
console.log('\n=== 表4 逐变体拟合 v = vSat*(min(f,0.5)/0.5)^k ===');
console.log('variant'.padEnd(15) + 'tank'.padStart(6) + 'vSat'.padStart(9) + 'k'.padStart(8) + 'maxErr%'.padStart(9) + '  未饱和点数');
for (const r of rows) {
  const pts = r.pts.filter(p => p.f <= 0.5);
  const unsat = pts.filter(p => p.f < 0.5 && p.v < 0.98 * Math.max(...pts.map(x => x.v)));
  // 网格搜索 k
  let best = null;
  for (let k = 0.05; k <= 3; k += 0.005) {
    // 用最小二乘定 vSat
    let num = 0, den = 0;
    for (const p of pts) {
      const x = Math.pow(Math.min(p.f, 0.5) / 0.5, k);
      num += p.v * x; den += x * x;
    }
    const vSat = den > 0 ? num / den : 0;
    let maxErr = 0;
    for (const p of pts) {
      const pred = vSat * Math.pow(Math.min(p.f, 0.5) / 0.5, k);
      maxErr = Math.max(maxErr, Math.abs(pred - p.v) / p.v);
    }
    if (!best || maxErr < best.maxErr) best = { k, vSat, maxErr };
  }
  console.log(r.variant.padEnd(15) + String(r.tank).padStart(6) +
    Math.round(best.vSat).toString().padStart(9) + best.k.toFixed(3).padStart(8) +
    (best.maxErr * 100).toFixed(1).padStart(9) + '  ' + unsat.length + '/' + pts.length);
}
const _ = rows.length; // noop


// ================= 受控罐扫描：v 对 Q 的折叠检验 =================
// 输入 controlled-stlFuel-<n>-*.json：同一蓝图、同一质量，只改请求里的 stlFuel。
// 结论（2026-10-14）：v 几乎只由 Q = 0.98*stlFuel*min(f,0.5) 决定（同 Q 跨罐差 4-5%），
// 并在 Q 足够大时饱和到 ~120,000 km/s。这正是「罐项」—— 罐不是独立的第二变量，
// 它是通过 Q 进模型的。
const controlled = readdirSync(calib).filter(f => /^controlled-stlFuel-\d+-.*\.json$/.test(f)).sort();
if (controlled.length > 0) {
  console.log('\n\n=== 受控罐扫描（同蓝图/同质量，只改 stlFuel）===');
  const rows = [];
  const masses = new Set();
  for (const f of controlled) {
    const j = JSON.parse(readFileSync(join(calib, f), 'utf8'));
    masses.add(j.blueprint?.operatingEmptyMass);
    for (const smp of j.samples ?? []) {
      rows.push({
        tank: j.stlFuel, f: smp.fuelUsageFactor,
        Q: 0.98 * j.stlFuel * Math.min(smp.fuelUsageFactor, 0.5),
        v: smp.transitKm / smp.transitSeconds,
      });
    }
  }
  console.log('文件 ' + controlled.length + ' 个；整备质量集合=' + JSON.stringify([...masses]));
  console.log(masses.size === 1 ? '✅ 质量固定（受控前提成立）' : '❌ 质量不一致，受控前提不成立');
  rows.sort((a, b) => a.Q - b.Q);
  console.log('\nQ'.padStart(9) + 'tank'.padStart(7) + 'f'.padStart(7) + 'v'.padStart(10));
  for (const r of rows) {
    console.log(r.Q.toFixed(1).padStart(9) + String(r.tank).padStart(7) + String(r.f).padStart(7) + Math.round(r.v).toString().padStart(10));
  }
  console.log('\n同 Q（±6%）跨罐点对 —— 偏差越小说明「只由 Q 决定」越成立：');
  let worst = 0, n = 0;
  for (let i = 0; i < rows.length; i++)
    for (let k = i + 1; k < rows.length; k++) {
      if (rows[i].tank === rows[k].tank) continue;
      const dq = Math.abs(rows[i].Q - rows[k].Q) / Math.max(rows[i].Q, rows[k].Q);
      if (dq >= 0.06) continue;
      const dv = Math.abs(rows[i].v - rows[k].v) / Math.max(rows[i].v, rows[k].v);
      worst = Math.max(worst, dv); n++;
      console.log('  罐' + String(rows[i].tank).padStart(5) + ' f=' + rows[i].f + '  vs  罐' + String(rows[k].tank).padStart(5) + ' f=' + rows[k].f +
        '   Δv=' + (dv * 100).toFixed(1) + '%');
    }
  console.log('  共 ' + n + ' 对，最大偏差 ' + (worst * 100).toFixed(1) + '%');
  const sat = rows.filter(r => r.Q > 700);
  if (sat.length) {
    const vs = sat.map(r => r.v);
    console.log('  饱和平台（Q>700）：min=' + Math.round(Math.min(...vs)) + ' max=' + Math.round(Math.max(...vs)));
  }
}
