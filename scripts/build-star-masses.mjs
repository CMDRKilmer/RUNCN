#!/usr/bin/env node
// 从日志 SYSTEM_STARS_DATA 拿全部星系 naturalId，并发拉取 FIO 恒星质量，
// 生成内置资源 public/json/star-masses.json（供 predictPosition 离线预测）。
//
// 用法：node scripts/build-star-masses.mjs <prun-log.json>

import { readFileSync, writeFileSync } from 'node:fs';

const logPath = process.argv[2];
if (!logPath) {
  console.error('用法: node scripts/build-star-masses.mjs <prun-log.json>');
  process.exit(1);
}

const messages = JSON.parse(readFileSync(logPath, 'utf8'));
let stars = [];
for (const x of messages) {
  if (x.messageType === 'SYSTEM_STARS_DATA') {
    stars = x.payload.stars;
  }
}
if (stars.length === 0) {
  console.error('日志中无 SYSTEM_STARS_DATA');
  process.exit(1);
}
const ids = stars.map(s => s.address.lines[0].entity.naturalId);
console.log(`星系数: ${ids.length}`);

const CONCURRENCY = 10;
const results = [];
let index = 0;

async function fetchMass(naturalId) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(
        `https://rest.fnar.net/systemstars/star/${encodeURIComponent(naturalId)}`,
      );
      if (r.ok) {
        const j = await r.json();
        const mass = j?.Mass;
        if (typeof mass === 'number' && mass > 0) {
          return mass;
        }
      }
    } catch {
      // 重试
    }
    await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
  }
  return undefined;
}

const worker = async () => {
  while (index < ids.length) {
    const id = ids[index++];
    const mass = await fetchMass(id);
    results.push({ n: id, m: mass });
    if (index % 50 === 0 || index === ids.length) {
      process.stdout.write(`\r${index}/${ids.length}`);
    }
  }
};
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log('');

const withMass = results.filter(x => x.m);
const failed = results.filter(x => !x.m);
console.log(`有质量: ${withMass.length}，失败: ${failed.length}`);
if (failed.length) {
  console.log('失败示例:', failed.slice(0, 5).map(x => x.n).join(', '));
}

const out = JSON.stringify(withMass);
const outPath = new URL('../public/json/star-masses.json', import.meta.url).pathname.replace(
  /^\/([A-Z]:)/,
  '$1',
);
writeFileSync(outPath, out);
console.log(`写入 ${outPath}，大小 ${(out.length / 1024).toFixed(1)} KB`);
