#!/usr/bin/env node
// 从日志 SYSTEM_STARS_DATA 提取恒星跃迁连接，生成内置资源
// public/json/star-connections.json（星系 naturalId → 相邻星系 naturalId[]）。
// 用于 BFS 最短跃迁路径规划（离线可用）。
//
// 用法：node scripts/build-connections.mjs <prun-log.json> [--pretty]

import { readFileSync, writeFileSync } from 'node:fs';

const logPath = process.argv[2];
if (!logPath) {
  console.error('用法: node scripts/build-connections.mjs <prun-log.json>');
  process.exit(1);
}
const pretty = process.argv.includes('--pretty');

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

// systemId -> naturalId
const natBySystem = new Map();
for (const s of stars) {
  natBySystem.set(s.systemId, s.address.lines[0].entity.naturalId);
}

// 构建无向邻接表（naturalId -> naturalId[]），去重、剔除无效。
const adj = new Map();
for (const s of stars) {
  const a = natBySystem.get(s.systemId);
  if (!a) continue;
  const conns = new Set(
    (s.connections || []).map(c => natBySystem.get(c)).filter(Boolean),
  );
  if (conns.size > 0) {
    adj.set(a, [...conns]);
  }
}

// 对称化（日志 connections 可能只给单向）。
for (const [a, conns] of [...adj]) {
  for (const b of conns) {
    if (!adj.has(b)) {
      adj.set(b, []);
    }
    const list = adj.get(b);
    if (!list.includes(a)) {
      list.push(a);
    }
  }
}

// 排序保证确定性输出。
const sorted = [...adj.entries()]
  .map(([k, v]) => [k, [...v].sort()])
  .sort((x, y) => x[0].localeCompare(y[0]));
const out = pretty ? JSON.stringify(Object.fromEntries(sorted), null, 1) : JSON.stringify(Object.fromEntries(sorted));

const outPath = new URL('../public/json/star-connections.json', import.meta.url).pathname.replace(
  /^\/([A-Z]:)/,
  '$1',
);
writeFileSync(outPath, out);
console.log(`写入 ${outPath}`);
console.log(`星系 ${sorted.length} 个，总连接 ${sorted.reduce((a, [, v]) => a + v.length, 0)} 条，大小 ${(out.length / 1024).toFixed(1)} KB`);
