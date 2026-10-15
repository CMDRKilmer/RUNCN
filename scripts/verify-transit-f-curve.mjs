// 系内「转移」段 f 曲线：实测 vs 模型回归脚本 —— 带退出码。
//
// 背景（2026-10-13，缺陷 #3 —— 且本脚本记录了一次"改了又回滚"）：
//   fuel-model.ts 的系内转移段速度
//     v = STL_INTRA_TRANSIT_SPEED_KM_S(=27512) × (1271/质量)^0.78 × f 曲线(f)
//   其中 27,512 来自 BTF 样本 VH-331g → HRT（599,220,390 km / 21,780 s）。
//   ⚠️ 该样本**没有记录 f**（btf-scan-2026-09-24.json 里根本没有 f 字段）——
//   全模型的 f 依赖只有这一个点 + 一条**假设**的曲线形状。
//
//   ⚠️⚠️ 在弄清「纯 TRANSIT + 已知 f」这个口径之前，**不要**用
//   `btf-load-sweep-2026-08-29.md` 的 f 表去标定（它的「转移」段口径未确认：
//   520M km 的段可能被离港/进近稀释，与纯 TRANSIT 不可比）。
//   曾据该表把锚点改成 11063，被两份独立实测（锚点样本 + 用户 2727t 样本）
//   以 2.5× 的失配证伪，已回滚 —— 详见
//   data/ftc-calibration/transit-anchor-correction-2026-10-13.md。
//
// 【断言变更记录 2026-10-14】④ 由「f=0.05 与 1271t 锚点比速度（±25%）」改为
//   「燃料与请求罐自洽 F≈0.98·罐·min(f,0.5)（±5%）」。原因：旧断言是**跨口径比较**
//   （锚点 = standard 引擎/罐 1500/1271t，而扫描船可能是别的引擎/罐/质量），比值无判别力；
//   实测 BP-FRVZ-6104 得 2.135×，不是模型错，是两艘不同的船。⑤ 未改：它当前 FAIL（2.06×）
//   是**真实缺陷信号**（模型对 1500 罐高估约 2×），按「断言失败是模型错就先修模型」保留。
//
//   本脚本只做**能确证的事**：
//     ① 扫描数据存在时：检查单调性 / 燃料与请求罐自洽 / 高端 f 偏差；
//     ② 数据缺失时**明确 SKIP 而非伪绿**（不拿单一锚点自证）。
//
//   ⚠️ 2026-10-14：原 ④「f=0.05 与 1271t 锚点比速度（±25%）」已删除 —— 那是**跨口径比较**
//   （锚点 = standard 引擎 / 罐 1500 / 1271t；扫描船可能三者都不同），比值无判别力。
//   改为 ④ 燃料自洽。注意 ④ 验的是「服务器用了请求里的罐」，**不是**「请求的罐 = 船的真实罐」；
//   后者是面板发请求前的责任（见 FTC.vue startFScan 的 bpCap 检查）。
//
// 数据来源（二选一，自动探测）：
//   A. data/ftc-calibration/prun-transit-f-scan.json   ← 扩展面板「扫描 f 曲线」导出
//   B. data/ftc-calibration/btf-scan-2026-09-24.json    ← 历史 CDP 直采（**无 f 字段**）
//
// 用法：node scripts/verify-transit-f-curve.mjs
// 退出码：0 = 通过或明确 SKIP；1 = 断言失败。
//
// 变异验证（2026-10-13，证明断言不是恒绿）：
//   · 夹具 A（f 依赖 == 模型）→ PASS 5 | FAIL 0，exit 0；
//   · 夹具 B（f 依赖**平坦**，即服务器不理会 f）→ ⑤ 在 f=0.5 报
//     「模型 190,337 vs 实测 27,512 km/s = 6.92×」→ PASS 4 | FAIL 1，exit 1。
//   即本脚本能真正抓住缺陷 #3（模型 f 曲线高估至 6.9×）。
//   ⚠️ 夹具B 的具体倍率随质量假设（此处 1271t）变化；断言用的是**倍率区间**，
//      不是把 6.92 写成常数 —— 换船/换质量不会假报。

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stlIntraTransitSpeedKmS, stlIntraTransitSpeedFor } from '../src/features/XIT/FTC/fuel-model.ts';

const here = dirname(fileURLToPath(import.meta.url));
const calib = resolve(here, '..', 'data', 'ftc-calibration');

const summary = { pass: 0, fail: 0, skip: 0 };
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
    console.log('FAIL ' + name + ' ' + failures.join(' | '));
  }
}
function expect(failures, label, ok, expectedText, actualText) {
  if (!ok) failures.push('expected=' + expectedText + ' actual=' + actualText + ' (' + label + ')');
}

// ---- 数据载入 ----
const scanPath = resolve(calib, 'prun-transit-f-scan.json');
const histPath = resolve(calib, 'btf-scan-2026-09-24.json');

/** 扫描数据里的一个样本 → {f, km, seconds, fuel, kmS}。 */
function sampleOf(s) {
  return {
    f: s.fuelUsageFactor,
    km: s.transitKm > 0 ? s.transitKm : s.totalStlKm,
    seconds: s.transitKm > 0 ? s.transitSeconds : s.totalSeconds,
    fuel: s.transitKm > 0 ? s.transitFuel : s.stlFuel,
    kmS: s.transitKm > 0 ? s.transitAvgKmS : s.totalAvgKmS,
  };
}

console.log('=== 系内转移段 f 曲线校验 ===\n');

if (!existsSync(scanPath)) {
  summary.skip++;
  console.log('SKIP 扫描数据缺失：' + scanPath);
  console.log('     请用 FTC 面板「扫描 f 曲线」按钮生成（固定船/航线/罐，只变 f）。');
  console.log('     ⚠️ 不拿历史 btf-scan 的单点自证 —— 那份数据没有 f 字段（见文件头）。');
  console.log('\nSKIP ' + summary.skip + ' | PASS ' + summary.pass + ' | FAIL ' + summary.fail);
  process.exit(0);
}

const scan = JSON.parse(readFileSync(scanPath, 'utf8'));
const samples = (scan.samples ?? []).map(sampleOf).filter(s => s.km > 0 && s.seconds > 0);
console.log('数据：' + scanPath);
console.log('船 ' + scan.blueprintId + ' | 罐 ' + scan.stlFuel + ' | 载重 ' + scan.payload + ' | 状况 ' + scan.condition);
console.log('样本 ' + samples.length + ' 档：' + samples.map(s => 'f=' + s.f).join(', ') + '\n');

check('① 至少 6 档（覆盖 f=0.05…0.5）', failures => {
  expect(failures, '档位数', samples.length >= 6, '>=6', samples.length);
});

check('② 时长随 f 单调不增（越快档耗时不应更长）', failures => {
  const sorted = [...samples].sort((a, b) => a.f - b.f);
  for (let i = 1; i < sorted.length; i++) {
    expect(
      failures,
      'f=' + sorted[i].f + ' vs f=' + sorted[i - 1].f,
      sorted[i].seconds <= sorted[i - 1].seconds * 1.15,
      'seconds 单调不增(容 15% 噪声)',
      sorted[i - 1].seconds + ' -> ' + sorted[i].seconds,
    );
  }
});

check('③ 速度随 f 单调不减', failures => {
  const sorted = [...samples].sort((a, b) => a.f - b.f);
  for (let i = 1; i < sorted.length; i++) {
    expect(
      failures,
      'f=' + sorted[i].f,
      sorted[i].kmS >= sorted[i - 1].kmS * 0.9,
      'kmS 单调不减(容 10% 噪声)',
      sorted[i - 1].kmS.toFixed(0) + ' -> ' + sorted[i].kmS.toFixed(0),
    );
  }
});

// ④ 口径自洽：燃料必须由「扫描请求的罐」解释，而不是别的罐。
// 2026-10-14 取代旧的「f=0.05 与 1271t 锚点比速度（±25%）」断言 —— 那条是**跨口径比较**：
// 锚点是 standard 引擎 / 罐 1500 / 1271t，而扫描船可能是别的引擎/罐/质量，比值本就没有意义
// （实测 BP-FRVZ-6104 扫描得到 2.135×，不是模型错，是两艘不同的船）。
// 现在改测一个**真的能判错**的性质：F/(0.98·stlFuel·min(f,0.5)) 应贴近 1。
// 若扫描器传错罐（如给 1500 罐的船传 8000），这一项**仍然**会过 —— 它验的是
// 「服务器用了请求里的罐」，不是「请求的罐等于船的真实罐」；后者由面板在发请求前拦下。
check('④ 燃料与请求罐自洽 F≈0.98·罐·min(f,0.5)（±5%）', failures => {
  const tank = scan.stlFuel;
  if (!(tank > 0)) {
    failures.push('扫描记录没有有效 stlFuel：' + tank);
    return;
  }
  for (const s of samples) {
    const pred = 0.98 * tank * Math.min(s.f, 0.5);
    const ratio = pred > 0 ? s.fuel / pred : 0;
    expect(
      failures,
      'f=' + s.f,
      ratio > 0.95 && ratio < 1.05,
      '预测/实测 ∈ (0.95, 1.05)',
      ratio.toFixed(3) + '（预测 ' + pred.toFixed(0) + 'u vs 实测 ' + s.fuel.toFixed(0) + 'u）',
    );
  }
});

// ★核心断言：模型对**高端 f** 的预测偏差。f 曲线的形状此前从未被验证。
// 注意：区间取 2×，是「粗筛」而非「标定」—— 真正的标定需要纯 TRANSIT + 已知 f 的数据。
check('⑤ 高端 f（>=0.4）模型偏差 < 2×（缺陷#3 的回归门）', failures => {
  const high = samples.filter(s => s.f >= 0.4);
  if (high.length === 0) {
    failures.push('样本里没有 f>=0.4');
    return;
  }
  for (const s of high) {
    const model = stlIntraTransitSpeedKmS(1271) * fCurveRatio(s.f);
    const ratio = model / s.kmS;
    expect(
      failures,
      'f=' + s.f,
      ratio > 0.5 && ratio < 2,
      '模型/实测 ∈ (0.5, 2)',
      ratio.toFixed(2) + '×（模型 ' + model.toFixed(0) + ' vs 实测 ' + s.kmS.toFixed(0) + ' km/s）',
    );
  }
});

/**
 * 模型当前用的 f 曲线（比值形式，锚定 f=0.05）：
 * fuel-model.stlIntraTransitSpeedFor = base × 引擎系数 × curve(f)/curve(0.05)。
 * 这里用标准引擎参数复现该比值（唯一的单一来源是 fuel-model 自身）。
 */
function fCurveRatio(f) {
  const ship = {
    mass: 1271,
    operatingEmptyMass: 1271,
    acceleration: 0,
    ftlMaxSpeed: 1,
    reactorPower: 1,
    condition: 1,
    stlEngineOption: 'STL_ENGINE_STANDARD',
  };
  const ref = stlIntraTransitSpeedFor(ship, 0.05);
  const cur = stlIntraTransitSpeedFor(ship, f);
  return ref > 0 ? cur / ref : 1;
}

// 诊断输出：逐点偏差表（无论断言是否通过都打印，供标定决策）
console.log('\n--- 逐点偏差（模型/实测，标准引擎 @1271t）---');
for (const s of [...samples].sort((a, b) => a.f - b.f)) {
  const model = stlIntraTransitSpeedKmS(1271) * fCurveRatio(s.f);
  console.log(
    '  f=' + String(s.f).padEnd(5) +
    ' 实测 ' + s.kmS.toFixed(0).padStart(7) + ' km/s' +
    ' 模型 ' + model.toFixed(0).padStart(7) + ' km/s' +
    ' 偏差 ' + (model / s.kmS).toFixed(2) + '×' +
    ' | ' + (s.km / 1e6).toFixed(1) + 'M km / ' + s.seconds.toFixed(0) + 's / ' + s.fuel.toFixed(0) + 'u',
  );
}

console.log('\nPASS ' + summary.pass + ' | SKIP ' + summary.skip + ' | FAIL ' + summary.fail);
process.exit(summary.fail > 0 ? 1 : 0);
