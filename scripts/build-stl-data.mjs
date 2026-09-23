#!/usr/bin/env node
// 把用户从 FTC「导出 STL 段数据」得到的 JSON 精简内置为 public/json/stl-segments.json。
//
// 用法：
//   node scripts/build-stl-data.mjs <导出的JSON> [--out 输出路径]
//
// 输入格式（FTC 导出）：
//   {
//     "depart":   [["HRT|VH-192", {"distanceKm": 21175977, "seconds": 3720}], ...],
//     "approach": [["VH-331|VH-192C", {"distanceKm": 72737809, "seconds": 2959}], ...],
//     "sameSystem": [["ZV-307A|ANT", {"depart": {"distanceKm": 68056200, "seconds": 4470},
//                                      "approach": {"distanceKm": 33649100, "seconds": 1345}}], ...]
//   }
// 输出格式（压缩，只保留与飞船无关的段距离，时长随飞船变不内置）：
//   { "depart": [["HRT|VH-192", 21175977], ...], "approach": [["VH-331|VH-192C", 72737809], ...],
//     "sameSystem": [["ZV-307A|ANT", {"depart": 68056200, "approach": 33649100}], ...] }
//
// 键语义：跨星系离港 = "出发天体|首跳目标星系"，进近 = "末跳来源星系|目标天体"；
// 同星系（无跳）航线 = "出发天体|目标天体"（均大写）。
// ⚠️ 2026-09-23 复核：上面 sameSystem 的**示例键/数值是合成的**（68.0562M/33.6491M 来自
// FTC 面板「航线分段（模型估算）」行，不是服务器原生计划）—— 真实系内计划只有「转移」
// （TRANSIT）段，不含 DEPARTURE/APPROACH，所以实际导出的 sameSystem 表**恒为空**
// （public/json/stl-segments.json 的 sameSystem 就是 []）。格式保留以备将来。

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

// 入口形状校验：本脚本的**输出**与输入的字段名/结构长得很像（都是 depart/approach/
// sameSystem 数组），只是条目的值被压成了数字。把「自己的输出」当输入跑（很自然的
// 误操作：默认输出路径就是 public/json/stl-segments.json）时，条目值 typeof 不是 object
// → 全部当无效跳过 → 静默写出空表覆盖内置数据。两道闸拦住：
//   ① 三个字段至少有一个是数组，否则根本不是导出文件；
//   ② 输入非空但三类解析结果全空 → 格式不对（或整份数据都无效），拒绝写入。
if (![raw?.depart, raw?.approach, raw?.sameSystem].some(Array.isArray)) {
  console.error('输入不是 FTC 导出格式：需要 depart / approach / sameSystem 中至少一个数组字段。');
  process.exit(1);
}

function distanceKmOf(rec) {
  const value = rec?.distanceKm ?? rec?.d;
  return typeof value === 'number' && value > 0 ? value : undefined;
}

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
    const distanceKm = distanceKmOf(rec);
    if (distanceKm === undefined) {
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

// 同星系（无跳）航线：一条键带离港/进近两个距离，各自可选。
function normalizeSameSystem(list, label) {
  const seen = new Set();
  const out = [];
  let skipped = 0;
  for (const entry of list ?? []) {
    const [keyRaw, rec] = entry;
    if (typeof keyRaw !== 'string' || !rec || typeof rec !== 'object') {
      skipped++;
      continue;
    }
    const depart = distanceKmOf(rec.depart);
    const approach = distanceKmOf(rec.approach);
    if (depart === undefined && approach === undefined) {
      skipped++;
      continue;
    }
    const key = keyRaw.toUpperCase();
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    const slim = {};
    if (depart !== undefined) {
      slim.depart = Math.round(depart);
    }
    if (approach !== undefined) {
      slim.approach = Math.round(approach);
    }
    out.push([key, slim]);
  }
  console.log(`${label}: ${out.length} 条${skipped ? `（跳过 ${skipped} 条无效/重复）` : ''}`);
  return out;
}

const data = {
  depart: normalize(raw.depart, '离港'),
  approach: normalize(raw.approach, '进近'),
  sameSystem: normalizeSameSystem(raw.sameSystem, '同星系'),
};

const inputCount =
  (raw?.depart?.length ?? 0) + (raw?.approach?.length ?? 0) + (raw?.sameSystem?.length ?? 0);
const parsedCount = data.depart.length + data.approach.length + data.sameSystem.length;
if (inputCount > 0 && parsedCount === 0) {
  console.error(
    `拒绝写入：输入有 ${inputCount} 条记录但三类解析结果全空 —— 多半是把本脚本的输出` +
      '（值已压成数字）当成输入了。请改用 FTC 面板「导出 STL 段数据」得到的原始 JSON。',
  );
  process.exit(1);
}

writeFileSync(resolve(outPath), JSON.stringify(data));
console.log(
  `已写入 ${outPath}（离港 ${data.depart.length} + 进近 ${data.approach.length} + ` +
    `同星系 ${data.sameSystem.length} 条）`,
);
