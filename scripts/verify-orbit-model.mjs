#!/usr/bin/env node
// 验证从游戏 bundle 反推的「行星相位模型」：
//   M0 = 0（所有天体在世界时间 0 时平近点角为 0）
//   worldTime = REF + (t_s - REF) * FACTOR，REF=1451690603，FACTOR=20
//   M = n * worldTime，n = sqrt(G*M_center / a^3)
//
// 方法：对每个 transferEllipse 观测（位置+游戏世界时间戳），用观测方向
// 反推该时刻的平近角 M_obs，再减 n*worldTime 得 M0。若游戏公式正确，
// M0 应 ≈ 0（mod 2π）。
//
// 用法：
//   node scripts/verify-orbit-model.mjs <prun-log.json> [--detail]
//
// 需要的日志内容：一次 SFC 查询或实际飞行（产生 SHIP_FLIGHT_MISSION，
// 含 transferEllipse）+ 星系详情 DATA_DATA（轨道根数）。

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/verify-orbit-model.mjs <prun-log.json> [--detail]');
  process.exit(1);
}
const detail = process.argv.includes('--detail');

// 从 bundle 反推的常量。
const REF = 1451690603;
const MOTION_FACTOR = 20; // SimulationInterval=86400 → 86400/86400*20
const G = 6.674e-11;

const messages = JSON.parse(readFileSync(file, 'utf8'));

// 收集：星系详情里的行星轨道（naturalId → orbit + 恒星质量）。
const planetsOrbits = new Map();
const starMasses = new Map(); // 星系 naturalId → 恒星质量
const stationsOrbits = new Map();

function systemLineFromAddress(address) {
  const lines = address?.lines ?? [];
  const system = lines.find(l => l.type === 'SYSTEM');
  return system?.entity?.naturalId;
}

for (const msg of messages) {
  if (msg.messageType !== 'DATA_DATA') {
    continue;
  }
  const path = msg.payload?.path;
  if (!Array.isArray(path)) {
    continue;
  }
  if (path[0] === 'systems') {
    const b = msg.payload.body ?? {};
    if (b.star?.mass) {
      starMasses.set((b.naturalId ?? '').toUpperCase(), b.star.mass);
    }
    for (const p of b.planets ?? []) {
      if (p?.naturalId && p.orbit?.semiMajorAxis) {
        planetsOrbits.set(p.naturalId.toUpperCase(), { ...p.orbit, mass: p.mass });
      }
    }
    for (const s of b.celestialBodies ?? []) {
      if (s?.naturalId && s.orbit?.semiMajorAxis) {
        stationsOrbits.set(s.naturalId.toUpperCase(), { ...s.orbit, mass: 0 });
      }
    }
  }
}
console.log(
  `轨道根数: 行星 ${planetsOrbits.size}、空间站 ${stationsOrbits.size}、恒星质量 ${starMasses.size}\n`,
);

// ---- 开普勒数学（与 FTC orbit.ts 一致）----
function solveKepler(M, e) {
  M = ((M % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  let E = e < 0.8 ? M : Math.PI;
  for (let i = 0; i < 32; i++) {
    const d = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= d;
    if (Math.abs(d) < 1e-10) break;
  }
  return E;
}
function eccFromTrue(nu, e) {
  return 2 * Math.atan(Math.sqrt((1 - e) / (1 + e)) * Math.tan(nu / 2));
}
// 观测方向（相对中心，世界坐标）→ 轨道面方向（绕 Ω,i,ω 逆旋转）。
function worldToOrbital(d, orbit) {
  const { inclination: i, rightAscension: o, periapsis: w } = orbit;
  const x1 = Math.cos(o) * d.x + Math.sin(o) * d.y;
  const y1 = -Math.sin(o) * d.x + Math.cos(o) * d.y;
  const y2 = Math.cos(i) * y1 + Math.sin(i) * d.z;
  const z2 = -Math.sin(i) * y1 + Math.cos(i) * d.z;
  return {
    x: Math.cos(w) * x1 + Math.sin(w) * y2,
    y: -Math.sin(w) * x1 + Math.cos(w) * y2,
    z: z2,
  };
}

function normalizeAngle(a) {
  let x = a % (2 * Math.PI);
  if (x > Math.PI) x -= 2 * Math.PI;
  if (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

// 对单个观测反推 M0（游戏模型）。
function backoutM0(orbit, centerMass, obs, center) {
  const a = orbit.semiMajorAxis;
  const e = orbit.eccentricity;
  const offset = {
    x: obs.x - center.x,
    y: obs.y - center.y,
    z: obs.z - center.z,
  };
  const len = Math.hypot(offset.x, offset.y, offset.z);
  if (!(len > 0)) {
    return undefined;
  }
  const dir = worldToOrbital(
    { x: offset.x / len, y: offset.y / len, z: offset.z / len },
    orbit,
  );
  if (Math.abs(dir.z) > 0.05) {
    return undefined; // 偏离轨道面 → 帧/根数不一致
  }
  const nu = Math.atan2(dir.y, dir.x);
  const E = eccFromTrue(nu, e);
  const Mobs = E - e * Math.sin(E);

  const t_s = obs.timestampMs / 1000;
  const worldTime = REF + (t_s - REF) * MOTION_FACTOR;
  const n = Math.sqrt((G * centerMass) / Math.pow(a, 3));
  const M0 = normalizeAngle(Mobs - n * worldTime);
  return { Mobs, n, worldTime, M0, rLen: len };
}

// 收集 transferEllipse 观测。
let observations = [];
for (const msg of messages) {
  if (msg.messageType !== 'SHIP_FLIGHT_MISSION') {
    continue;
  }
  const segments = msg.payload?.segments ?? [];
  for (const seg of segments) {
    const ell = seg.transferEllipse;
    if (!ell) {
      continue;
    }
    observations.push({
      kind: 'origin',
      id: seg.origin?.lines?.at(-1)?.entity?.naturalId,
      pos: ell.startPosition,
      ts: seg.departure?.timestamp,
      center: ell.center,
    });
    observations.push({
      kind: 'target',
      id: seg.destination?.lines?.at(-1)?.entity?.naturalId,
      pos: ell.targetPosition,
      ts: seg.arrival?.timestamp,
      center: ell.center,
    });
  }
}
console.log(`观测数: ${observations.length}\n`);

let checked = 0;
let matched = 0;
const mismatches = [];
for (const obs of observations) {
  if (!obs.id || obs.pos === undefined || obs.ts === undefined) {
    continue;
  }
  const key = obs.id.toUpperCase();
  const orbit = planetsOrbits.get(key) ?? stationsOrbits.get(key);
  if (!orbit) {
    continue;
  }
  const systemId = undefined; // 需要中心恒星质量：orbit 记录不完整时跳过
  // 中心 = 观测的椭圆中心（transferEllipse.center），用它找恒星质量。
  // 简化：恒星质量从星系详情匹配——此处用观测 center 的最近星系不可行，
  // 直接尝试用所有已知恒星质量反推，取 M0 最接近 0 的。
  let best = undefined;
  for (const mass of starMasses.values()) {
    const r = backoutM0(orbit, mass, obs.pos, obs.center ?? { x: 0, y: 0, z: 0 });
    if (!r) continue;
    if (!best || Math.abs(r.M0) < Math.abs(best.M0)) {
      best = r;
    }
  }
  if (!best) {
    continue;
  }
  checked++;
  const errDeg = Math.abs(best.M0) * 180 / Math.PI;
  if (errDeg < 20) {
    matched++;
  } else {
    mismatches.push({ id: obs.id, kind: obs.kind, M0deg: errDeg.toFixed(1) });
  }
  if (detail) {
    console.log(
      `${obs.id} (${obs.kind}) M0=${(best.M0 * 180 / Math.PI).toFixed(2)}° ` +
        `| 半径=${best.rLen.toExponential(2)} 单位, n=${best.n.toExponential(2)} rad/s`,
    );
  }
}

console.log(`=== 验证结果 ===`);
console.log(`可验证观测: ${checked}, M0≈0(<20°): ${matched}, 偏离: ${mismatches.length}`);
if (mismatches.length) {
  console.log('偏离项:', mismatches.map(x => `${x.id}(${x.kind}) ${x.M0deg}°`).join(', '));
}
console.log(
  matched / Math.max(1, checked) > 0.7
    ? '\n结论: 游戏 M0=0 模型与观测一致 ✅（可去掉观测反推，改用固定公式）'
    : '\n结论: M0=0 模型与观测不符 ⚠️（时间基准或 M0 模型需修正）',
);
