#!/usr/bin/env node
// 把用户从 FTC「导出 STL 段数据」得到的 JSON 精简内置为 public/json/stl-segments.json。
//
// 用法：
//   node scripts/build-stl-data.mjs <导出的JSON> [--out 输出路径]
//
// 输入格式（FTC 导出）：
//   {
//     "depart":   [["HRT|VH-192", {"distanceKm": 21175977, "seconds": 3720}], ...],
//     "approach": [["VH-331|VH-192C", {"distanceKm": 72737809, "seconds": 2959}], ...]
//   }
// 输出格式（压缩，只保留与飞船无关的段距离，时长随飞船变不内置）：
//   { "depart": [["HRT|VH-192", 21175977], ...], "approach": [["VH-331|VH-192C", 72737809], ...] }
//
// 键语义：离港 = "出发天体|首跳目标星系"，进近 = "末跳来源星系|目标天体"（均大写）。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const input = process.argv[2];
if (!input) {
  console.error('用法: node scripts/build-stl-data.mjs <导出的JSON> [--out 输出路径]');
  process.exit(1);
}
const outIdx = process.argv.indexOf('--out');
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : 'public/json/stl-segments.json';

const raw = JSON.parse(readFileSync(input, 'utf8'));

function normalize(list, label) {
  const seen = new Set();
  const out = [];
  let skipped = 0;
  for (const entry of list ?? []) {
    const [keyRaw, rec] = entry;
    if (typeof keyRaw !== 'string' || !rec || typeof rec !== 'object') {
      skipped++;
      continue;
    }
    const distanceKm = rec.distanceKm ?? rec.d;
    if (typeof distanceKm !== 'number' || !(distanceKm > 0)) {
      skipped++;
      continue;
    }
    const key = keyRaw.toUpperCase();
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    out.push([key, Math.round(distanceKm)]);
  }
  console.log(`${label}: ${out.length} 条${skipped ? `（跳过 ${skipped} 条无效/重复）` : ''}`);
  return out;
}

const data = {
  depart: normalize(raw.depart, '离港'),
  approach: normalize(raw.approach, '进近'),
};

writeFileSync(resolve(outPath), JSON.stringify(data));
console.log(`已写入 ${outPath}（离港 ${data.depart.length} + 进近 ${data.approach.length} 条）`);
