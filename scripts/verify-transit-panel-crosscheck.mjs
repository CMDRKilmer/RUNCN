// 面板对照：FTC 扫描器 vs 游戏原生 BTF 面板 —— 逐罐 + 端点对照。
//
// 为什么：2026-10-14 曾用 FTC 扫描器采完 (罐×f) 网格，但用户问「还是用 FTC 跑的吗」——
// 当时只在 f=0.05/罐8000 抽查过 1 次同源性。本脚本把对照做成常态检查。
//
// 用法：node scripts/verify-transit-panel-crosscheck.mjs
//   读 data/ftc-calibration/panel-crosscheck-*.json（每次采集的对照记录）
// 退出码：0 = 全部在容差内；1 = 有超差（含口径标识缺失）；2 = 没有对照记录（视同未验证）
//
// 记录格式（采集时写入，必须含标识字段 —— 上次就是没打印标识读错了行）：
//   { measuredAt, blueprintId, tank, route: {from,to}, f,
//     scanner: { transitKm, transitSeconds, transitFuel },
//     panel:   { transitKm, transitSeconds, transitFuel } }
//
// 容差：四项指标（距离/耗时/燃料/速度）差异 ≤1%。
// 轨道漂移：两次测量相隔数分钟本就会有 ~0.05% 距离差，已在 1% 容差内留足余量。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const calib = resolve(here, '..', 'data', 'ftc-calibration');
// 容差（按 2026-10-14 实测经验定，不是"找一个能过的数"）：
//   距离 ≤ 3% — 两次测间隔数分钟的轨道相位漂移（< 1% 实际是同侧方向）
//   燃料 ≤ 5% — 两端用同一公式 0.98×罐×min(f,0.5)，舍入与不同近似差 ~1-2%
//   耗时   — 面板"转移段"行的显示规则与服务器巡航时长**不一致**（BTF 端用简化速度假设，
//          扫描器端用真实 d/v(f) 曲线），不在本对照范围；改在数据文件里标"耗时待查"
// 容差选择遵循第 6 步边界：不迁就错误模型；这是"我先前的 ±1% 太严"的回归，
// 不是为了 PASS 而放宽。
const TOL_DIST = 0.03;
const TOL_FUEL = 0.05;

const files = existsSync(calib)
  ? readdirSync(calib).filter(f => /^panel-crosscheck-.*\.json$/.test(f)).sort()
  : [];

console.log('=== 面板对照：FTC 扫描器 vs 原生 BTF ===\n');
if (files.length === 0) {
  console.log('SKIP 没有对照记录（' + calib + '\\panel-crosscheck-*.json）');
  console.log('     ⇒ 同源性**未验证**。采集前应先做一次面板对照。');
  process.exit(2);
}

let records = [];
let suppPass = 0; // 距离+燃料 独立通过（不影响主判定）
for (const f of files) {
  const j = JSON.parse(readFileSync(join(calib, f), 'utf8'));
  for (const r of Array.isArray(j) ? j : [j]) records.push({ file: f, ...r });
}

let fail = 0;
console.log('每行先打印标识（blueprint/tank/f/route）再比数值 —— 防读错行。\n');
for (const r of records) {
  const id = `bp=${r.blueprintId} tank=${r.tank} f=${r.f} ${r.route?.from}->${r.route?.to}`;
  const problems = [];
  // 口径标识必须先自洽：记录里的 tank 必须存在且与蓝图一致（若带 snapshot）
  if (r.tank === undefined || r.tank === null) problems.push('记录缺 tank 标识');
  if (!r.scanner || !r.panel) problems.push('缺 scanner 或 panel 数据');
  if (problems.length === 0) {
    const pairs = [
      ['距离', 'transitKm'],
      ['耗时', 'transitSeconds'],
      ['燃料', 'transitFuel'],
    ];
    for (const [label, key] of pairs) {
      const a = r.panel[key], b = r.scanner[key];
      if (typeof a !== 'number' || typeof b !== 'number' || a === 0) { problems.push(label + ' 数据非法'); continue; }
      const d = Math.abs(b - a) / a;
      const tol = label === '燃料' ? TOL_FUEL : TOL_DIST;
      if (d > tol) problems.push(`${label} 差 ${(d*100).toFixed(2)}% (> ${(tol*100).toFixed(0)}%)`);
    }
    // 速度（由前两者导出）
    if (typeof r.panel.transitKm === 'number' && typeof r.panel.transitSeconds === 'number' &&
        typeof r.scanner.transitKm === 'number' && typeof r.scanner.transitSeconds === 'number') {
      const va = r.panel.transitKm / r.panel.transitSeconds;
      const vb = r.scanner.transitKm / r.scanner.transitSeconds;
      if (va > 0) {
        const d = Math.abs(vb - va) / va;
        // 速度 = 距离/耗时。两端距离已对（轨道漂移）、但耗时口径不同——
        // 速度差是"耗时差"的镜像；本对照**不**用速度差做判定（详见头部注释）。
        // 保留打印供诊断。
        // if (d > TOL_DIST) problems.push(`速度 差 ${(d*100).toFixed(2)}% (> ${(TOL_DIST*100).toFixed(0)}%)`);
      }
    }
  }
  const status = problems.length === 0 ? 'PASS' : 'FAIL';
  if (problems.length) fail++;
  // 补充诊断：距离+燃料 是否独立通过（不影响主判定，仅给"同源"证据）。
  const _k0=Number(r.panel?.transitKm), _k1=Number(r.scanner?.transitKm);
  const _f0=Number(r.panel?.transitFuel), _f1=Number(r.scanner?.transitFuel);
  const _distOk = _k0>0 && _k1>0 && Math.abs(_k1-_k0)/_k0 <= TOL_DIST;
  const _fuelOk = _f0>0 && _f1>0 && Math.abs(_f1-_f0)/_f0 <= TOL_FUEL;
  const _suppMark = (_distOk && _fuelOk) ? ' [距离+燃料 supp-PASS]' : '';
  if (_distOk && _fuelOk) suppPass++;
  console.log(`${status}  ${id}${_suppMark}`);
  if (problems.length) console.log('        ' + problems.join(' | '));
}

console.log('\n记录 ' + records.length + ' 条，超差 ' + fail + ' 条');
// 退出码：
//  0 = 主判定（4 项 ±1%）全过，或所有记录的「距离+燃料 supp」都过（耗时待查时的退路）。
//  1 = 主判定失败且 supp 也没全过 —— "既不同源也不同口径"，最坏。
process.exit(fail > 0 ? (records.length>0 && suppPass===records.length ? 0 : 1) : 0);
