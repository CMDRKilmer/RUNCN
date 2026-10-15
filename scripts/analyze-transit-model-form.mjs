// 转移段速度：候选模型形式的离线判定 + 参数可辨识性报告。
//
// 背景：2026-10-14 的 (罐×f) 受控网格证明「速度只由 f 决定」是错的 ——
// 同一艘船同 f 下三档罐速度最多差 7.9x；质量校正后罐效应单调（92517 -> 130058 -> 141522）。
// 本脚本不预设结论，而是把候选形式**并排跑**，让数据自己淘汰：
//   M1  v = Vmax * f^k                          （现行模型形状：只由 f 定）
//   M2  v = Vmax * (f/0.5)^k                    （同上，f>=0.5 饱和 —— 等价于 M1 带截断）
//   M3  v = Vmax * (1-exp(-(tank/T0)^k))        （罐驱动饱和，与离港/进近段同族）
//   M4  v = Vmax * (1-exp(-(tank/T0)^k)) * f^a  （罐 + f 联合）
// 每个形式报：自由参数数、数据点数、逐点误差、以及**可辨识性警告**。
//
// 可辨识性规则（本脚本的硬约束）：
//   自由参数数 >= 数据点数  =>  必然过拟合，标 "UNIDENTIFIABLE"，**不得**采纳其拟合值。
//   自由参数数 >= 数据点数-1 =>  标 "BORDERLINE"，采纳需外部独立数据佐证。
//
// 用法：node scripts/analyze-transit-model-form.mjs
// 退出码：0 = 至少一个形式「可辨识且达标」；1 = 无可辨识形式 / 全部不达标 / 数据缺失。
//
// 只做分析，**不写进 src/** —— 改生产代码是计划里的第 5 步，且必须有新数据支撑。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const calib = resolve(here, '..', 'data', 'ftc-calibration');
const TARGET_ERR = 0.15; // 逐点误差门（与计划第 5 步一致）

console.log('=== 转移段速度：候选模型形式判定 ===\n');

// ---- 载入网格（只认带 tank 字段的 grid-frvz-*.json）----
const files = existsSync(calib)
  ? readdirSync(calib).filter(f => /^grid-frvz-tank\d+.*\.json$/.test(f)).sort()
  : [];
const points = [];
const seen = new Set();
for (const f of files) {
  const j = JSON.parse(readFileSync(join(calib, f), 'utf8'));
  const tank = j.stlFuel;
  if (!(tank > 0)) continue;
  // 同一 (tank,f) 若有多份（如 rerun），只取第一份并记录
  for (const s of j.samples ?? []) {
    const key = tank + '@' + s.fuelUsageFactor;
    if (seen.has(key)) continue;
    seen.add(key);
    const v = s.transitKm / s.transitSeconds;
    if (!(v > 0)) continue;
    points.push({ tank, f: s.fuelUsageFactor, v, src: f });
  }
}
if (points.length === 0) {
  console.log('FAIL 没有网格数据（' + calib + '\\grid-frvz-tank*.json）');
  process.exit(1);
}
const tanks = [...new Set(points.map(p => p.tank))].sort((a, b) => a - b);
console.log('数据：' + points.length + ' 点，罐档 [' + tanks.join(', ') + ']\n');

// ---- 拟合工具：网格搜索（无依赖）----
function fitGrid(model, nParams, paramGrids, useLogSpace) {
  let best = null;
  const keys = Object.keys(paramGrids);
  const rec = (idx, acc) => {
    if (idx === keys.length) {
      const params = { ...acc };
      let sse = 0;
      for (const p of points) {
        const pred = model(p, params);
        if (!(pred > 0)) return;
        const r = useLogSpace ? Math.log(pred / p.v) : (pred - p.v) / p.v;
        sse += r * r;
      }
      if (!best || sse < best.sse) best = { params, sse };
      return;
    }
    const k = keys[idx];
    for (const val of paramGrids[k]) rec(idx + 1, { ...acc, [k]: val });
  };
  rec(0, {});
  return best;
}

const models = [
  { name: 'M1 v=Vmax*f^k', n: 2,
    grid: { Vmax: [80000, 100000, 120000, 150000, 200000, 300000, 500000, 800000], k: [0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,1.0] },
    fn: (p, q) => q.Vmax * Math.pow(p.f, q.k) },
  { name: 'M2 v=Vmax*(min(f,.5)/.5)^k', n: 2,
    grid: { Vmax: [80000, 100000, 120000, 150000, 200000], k: [0.2,0.3,0.4,0.5,0.6,0.7,0.8] },
    fn: (p, q) => q.Vmax * Math.pow(Math.min(p.f, 0.5) / 0.5, q.k) },
  { name: 'M3 v=Vmax*(1-exp(-(tank/T0)^k))', n: 3,
    grid: { Vmax: [100000, 120000, 140000, 160000, 200000], T0: [500, 1000, 1500, 2000, 3000, 5000, 8000], k: [0.3,0.5,0.7,0.9,1.1,1.3,1.6,2.0] },
    fn: (p, q) => q.Vmax * (1 - Math.exp(-Math.pow(p.tank / q.T0, q.k))) },
  { name: 'M5 v=vSat*(min(f,.5)/.5)^(a+b*ln(tank))', n: 3,
    grid: { vSat: [90000, 110000, 130000, 150000, 180000], a: [0.2, 0.4, 0.6, 0.8, 1.0, 1.2], b: [-0.30, -0.25, -0.20, -0.15, -0.10, -0.05] },
    fn: (p, q) => q.vSat * Math.pow(Math.min(p.f, 0.5) / 0.5, q.a + q.b * Math.log(p.tank)) },
  { name: 'M4 v=Vmax*(1-exp(-(tank/T0)^k))*f^a', n: 4,
    grid: { Vmax: [120000, 150000, 200000, 300000], T0: [500, 1000, 1500, 2500, 4000], k: [0.5, 0.7, 0.9, 1.2], a: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7] },
    fn: (p, q) => q.Vmax * (1 - Math.exp(-Math.pow(p.tank / q.T0, q.k))) * Math.pow(p.f, q.a) },
];

const N = points.length;
let anyAccepted = false;
console.log('形式                                自由参数  数据点  最大|误差|   判定');
console.log('─'.repeat(78));
const results = [];
for (const m of models) {
  const best = fitGrid(m.fn, m.n, m.grid, false);
  let maxErr = Infinity, meanErr = Infinity;
  if (best) {
    const errs = points.map(p => Math.abs(m.fn(p, best.params) / p.v - 1));
    maxErr = Math.max(...errs);
    meanErr = errs.reduce((a, b) => a + b, 0) / errs.length;
  }
  // 可辨识性
  let verdict;
  if (m.n >= N) verdict = 'UNIDENTIFIABLE（自由参数≥数据点，拟合值不可采纳）';
  else if (m.n >= N - 1) verdict = 'BORDERLINE（需外部数据佐证）';
  else if (maxErr <= TARGET_ERR) { verdict = 'OK（可辨识且达标）'; anyAccepted = true; }
  else verdict = '可辨识但未达标';
  results.push({ m, best, maxErr, meanErr, verdict });
  console.log(
    m.name.padEnd(36) +
    String(m.n).padStart(6) + String(N).padStart(8) +
    (isFinite(maxErr) ? (maxErr * 100).toFixed(1) + '%' : 'n/a').padStart(12) +
    '   ' + verdict,
  );
}

// ---- 逐点误差表（只对最优的那个形式展开，避免刷屏）----
const bestRes = results.filter(r => r.best).sort((a, b) => a.maxErr - b.maxErr)[0];
if (bestRes && isFinite(bestRes.maxErr)) {
  console.log('\n--- 最接近的形式「' + bestRes.m.name + '」逐点误差 ---');
  console.log('tank    f      实测       预测      误差');
  for (const p of points) {
    const pred = bestRes.m.fn(p, bestRes.best.params);
    console.log(
      String(p.tank).padStart(5) + ' ' + p.f.toFixed(2).padStart(6) +
      p.v.toFixed(0).padStart(10) + pred.toFixed(0).padStart(10) +
      (((pred / p.v - 1) * 100).toFixed(1) + '%').padStart(9),
    );
  }
  console.log('参数：' + JSON.stringify(bestRes.best.params));
}

console.log('\n=== 结论 ===');
for (const r of results) console.log('  ' + r.m.name + ' -> ' + r.verdict);
console.log('\n（只做分析，未改动 src/。改生产代码需新数据 + 计划第 5 步。）');
process.exit(anyAccepted ? 0 : 1);
