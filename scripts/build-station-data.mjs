#!/usr/bin/env node
// 从 FTC 面板导出的 prun-stations.json（空间站轨道 + 归属星系）精简为内置资源
// public/json/stations.json，供插件离线解析空间站起终点并预测其位置。
//
// 压缩键名（体积最小化）：
//   s = systemId（空间站绕所属星系恒星公转），a = semiMajorAxis, e = eccentricity,
//   i = inclination, o = rightAscension, p = periapsis
// 无轨道（仅归属映射）的空间站只写 s。
//
// 用法：node scripts/build-station-data.mjs <prun-stations.json> [--pretty]

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/build-station-data.mjs <prun-stations.json>');
  process.exit(1);
}
const pretty = process.argv.includes('--pretty');

const data = JSON.parse(readFileSync(file, 'utf8'));
const out = {};
let withOrbit = 0;
let mappingOnly = 0;
for (const st of data) {
  const id = String(st.naturalId ?? st.naturalId ?? '').toUpperCase();
  const systemId = String(st.systemId ?? '').toUpperCase();
  if (!id || !systemId) {
    continue;
  }
  const orbit = st.orbit;
  if (orbit?.semiMajorAxis !== undefined && orbit.semiMajorAxis > 0) {
    out[id] = {
      s: systemId,
      a: orbit.semiMajorAxis,
      e: orbit.eccentricity ?? 0,
      i: orbit.inclination ?? 0,
      o: orbit.rightAscension ?? 0,
      p: orbit.periapsis ?? 0,
    };
    withOrbit++;
  } else {
    out[id] = { s: systemId };
    mappingOnly++;
  }
}
const json = pretty ? JSON.stringify(out, null, 1) : JSON.stringify(out);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'public', 'json', 'stations.json');
writeFileSync(outPath, json);
console.log(`写入 ${outPath}`);
console.log(`空间站 ${withOrbit + mappingOnly} 个（含轨道 ${withOrbit}、仅归属 ${mappingOnly}），大小 ${(json.length / 1024).toFixed(1)} KB`);
