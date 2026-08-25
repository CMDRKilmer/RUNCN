#!/usr/bin/env node
// 从导出的 prun-all-planets.json 提取精简行星轨道数据，生成内置资源
// public/json/planets-orbit.json，供插件离线初始化轨道缓存。
//
// 压缩键名（体积最小化）：
//   n = PlanetNaturalId, a = OrbitSemiMajorAxis, e = OrbitEccentricity,
//   i = OrbitInclination, o = OrbitRightAscension, p = OrbitPeriapsis,
//   m = Mass, s = SystemId
//
// 用法：node scripts/build-planet-data.mjs <prun-all-planets.json> [--pretty]

import { readFileSync, writeFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/build-planet-data.mjs <prun-all-planets.json>');
  process.exit(1);
}
const pretty = process.argv.includes('--pretty');

const data = JSON.parse(readFileSync(file, 'utf8'));
const rows = [];
let skipped = 0;
for (const p of data) {
  if (!p.PlanetNaturalId || !p.OrbitSemiMajorAxis || p.OrbitSemiMajorAxis <= 0) {
    skipped++;
    continue;
  }
  rows.push({
    n: p.PlanetNaturalId,
    a: p.OrbitSemiMajorAxis,
    e: p.OrbitEccentricity ?? 0,
    i: p.OrbitInclination ?? 0,
    o: p.OrbitRightAscension ?? 0,
    p: p.OrbitPeriapsis ?? 0,
    m: p.Mass ?? 0,
    s: p.SystemId ?? '',
  });
}
const out = pretty ? JSON.stringify(rows, null, 1) : JSON.stringify(rows);
const outPath = new URL('../public/json/planets-orbit.json', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
writeFileSync(outPath, out);
console.log(`写入 ${outPath}`);
console.log(`行星 ${rows.length} 个，跳过 ${skipped}，大小 ${(out.length / 1024).toFixed(1)} KB`);
