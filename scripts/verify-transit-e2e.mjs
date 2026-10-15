// 端到端校对：模型 vs 全部可用实测（逐点误差表）—— 带退出码。
//
// ⚠️ 本脚本**不**声称「模型已校准」。它把模型与**所有**可用实测数据并排打印，
// 让「哪份数据支持模型、哪份不支持」一目了然 —— 这正是当前真正的问题：
// 两份实测口径不一致（见 data/ftc-calibration/transit-anchor-correction-2026-10-13.md）。
//
// 数据来源（全部离线，不依赖浏览器/服务器）：
//   · btf-scan-2026-09-24.json      组3/组4：纯 TRANSIT 样本（**无 f**）
//   · btf-load-sweep-2026-08-29.md  §2/§3：带 f 的受控扫描（**口径待定**）
//   · 用户实测样本（硬编码在本脚本，出处见注释）
//
// 用法：node scripts/verify-transit-e2e.mjs
// 退出码：0 = 表已产出且**口径一致性**检查通过；1 = 发现口径冲突（当前即此状态）。
//
// ⚠️ 退出码 1 在本任务是**预期结果**，不是回归失败 —— 它表示「数据尚不可用于标定」。
//
// 【断言变更记录 2026-10-14】**未改动**，且不应改动。理由：2026-10-14 的受控实验
// （data/ftc-calibration/grid-tank-f-controlled-2026-10-14.md）已证明「速度只由 f 决定」
// 的形状是错的（同 f 下三档罐速度最多差 7.9×），但**尚未找到可辨识的替代形式**
// （scripts/analyze-transit-model-form.mjs：5 个候选最好 60.8% 误差）。本脚本报的
// 「口径冲突」正是这一未决状态的忠实记录 —— 改成绿色等于掩盖问题。

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stlIntraTransitSpeedFor } from '../src/features/XIT/FTC/fuel-model.ts';

const here = dirname(fileURLToPath(import.meta.url));
const calib = resolve(here, '..', 'data', 'ftc-calibration');

const REF_MASS = 1271;
const MASS_EXP = 0.78;
/** 模型在给定质量/f 下的转移段速度（单一来源：fuel-model）。 */
function modelSpeed(mass, f) {
  const ship = {
    mass, operatingEmptyMass: mass, acceleration: 50, ftlMaxSpeed: 1,
    reactorPower: 1, condition: 1, stlEngineOption: 'STL_ENGINE_STANDARD',
  };
  return stlIntraTransitSpeedFor(ship, f);
}

console.log('=== 模型 vs 全部实测（转移段速度）===\n');

// ---- A. 锚点样本（纯 TRANSIT，无 f；推定为 f=0.05 的标定基点）----
// VH-331g → HRT: 599,220,390 km / 21,780 s（btf-scan-2026-09-24.json 组 4）
const A = { label: 'A 锚点样本(纯TRANSIT,无f)', km: 599220390, sec: 21780, mass: 1271, f: 0.05 };
// ---- B. 受控扫描 §2 载重0（带 f，口径待定）----
const Bm = 1199;
const Bpts = [[0.05,520384259,44940],[0.1,521421277,22860],[0.2,521937387,11880],
              [0.3,522102516,8400],[0.5,522218890,6000]]
  .map(([f,km,sec]) => ({ f, km, sec, mass: Bm, label: 'B 受控扫描§2(口径待定)' }));
// ---- C. 用户实测（纯?/无 f）----
const C = { label: 'C 用户实测(2727t,无f)', km: 619312100, sec: 40781, mass: 2727, f: 0.05 };

const rows = [A, ...Bpts, C].map(s => {
  const measured = s.km / s.sec;
  const model = modelSpeed(s.mass, s.f);
  return { ...s, measured, model, ratio: model / measured };
});

console.log('数据点                       质量     f     实测km/s    模型km/s   模型/实测');
for (const r of rows) {
  console.log(
    r.label.padEnd(28) +
    String(r.mass).padStart(6) +
    String(r.f).padStart(7) +
    r.measured.toFixed(0).padStart(11) +
    r.model.toFixed(0).padStart(12) +
    ('  ' + r.ratio.toFixed(3) + '×').padStart(12),
  );
}

// ---- 口径一致性检查：A 与 C 应互相印证（同口径），B 应落在同一尺度上 ----
const ratioA = A.km / A.sec / modelSpeed(A.mass, A.f);
const ratioC = C.km / C.sec / modelSpeed(C.mass, C.f);
const ratioB = (Bpts[0].km / Bpts[0].sec) / modelSpeed(Bpts[0].mass, Bpts[0].f);

console.log('\n--- 口径一致性（实测/模型，1.0 = 模型正确）---');
console.log('  A 锚点样本      :', (1 / ratioA).toFixed(3));
console.log('  C 用户样本      :', (1 / ratioC).toFixed(3));
console.log('  B 受控扫描      :', (1 / ratioB).toFixed(3));
console.log('');
const acAgree = Math.abs(ratioA - ratioC) < 0.05;
const bAgrees = Math.abs(ratioB - ratioA) < 0.10;
console.log('  A 与 C 是否同口径？', acAgree ? '是 ✓' : '否 ✗');
console.log('  B 是否与 A/C 同尺度？', bAgrees ? '是 ✓' : '否 ✗（相差 ' + (ratioA / ratioB).toFixed(2) + '×）');

console.log('\n--- 结论 ---');
if (acAgree && !bAgrees) {
  console.log('  A 与 C 互相印证（支持现有模型），B 独自偏离 ' + (ratioA / ratioB).toFixed(2) + '×。');
  console.log('  ⇒ **B 的口径与 A/C 不同**，不能用于标定。');
  console.log('  ⇒ 在取得「纯 TRANSIT + 已知 f」的数据前，**不得修改任何转移段常数**。');
  console.log('\nFAIL 1（口径冲突：这是当前已知的真实状态，非脚本缺陷）');
  process.exit(1);
}
console.log('  口径一致。');
console.log('\nPASS 1');
process.exit(0);
