#!/usr/bin/env node
// 分析 PrUn 游戏客户端 JS，定位「行星轨道相位生成」算法。
//
// 背景：游戏不下发行星相位（M0），客户端本地确定性生成。本脚本在游戏
// 主 bundle 中搜索轨道/相位/开普勒相关关键词，输出命中上下文，帮助
// 逆向相位算法（从行星 id 种子生成？还是固定历元？）。
//
// 用法：
//   node scripts/analyze-game-js.mjs <game-bundle.js> [--context N] [--max N]
//
// 输出：每个关键词的命中数 + 若干条命中上下文（前后 N 字符，默认 160）。

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/analyze-game-js.mjs <game-bundle.js> [--context N] [--max N]');
  process.exit(1);
}
const ctxArg = process.argv.indexOf('--context');
const contextLen = ctxArg >= 0 ? Number(process.argv[ctxArg + 1]) : 160;
const maxArg = process.argv.indexOf('--max');
const maxHits = maxArg >= 0 ? Number(process.argv[maxArg + 1]) : 5;

const code = readFileSync(file, 'utf8');
console.log(`文件大小: ${(code.length / 1024 / 1024).toFixed(2)} MB\n`);

// 轨道/相位相关关键词（按优先级分组）。
const GROUPS = [
  {
    label: '开普勒/轨道数学',
    keys: ['meanAnomaly', 'trueAnomaly', 'eccentricAnomaly', 'kepler', 'solveKepler', 'KeplerEquation'],
  },
  {
    label: '轨道根数',
    keys: ['semiMajorAxis', 'semiMinorAxis', 'eccentricity', 'inclination', 'rightAscension', 'periapsis', 'orbitalPeriod', 'OrbitPeriod'],
  },
  {
    label: '相位/历元',
    keys: ['phase', 'epoch', 'M0', 'meanAnomaly0', 'initialAnomaly', 'argumentOfPeriapsis', 'longitudeOfAscendingNode', 'seedPhase'],
  },
  {
    label: '位置计算',
    keys: ['planetPosition', 'orbitPosition', 'positionAtTime', 'positionAt', 'getPositionAt', 'celestialPosition', 'bodyPosition'],
  },
  {
    label: '天体数据',
    keys: ['celestialBody', 'celestialBodies', 'PlanetOrbit', 'SystemData', 'starSystem'],
  },
];

// 转义正则。
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

for (const group of GROUPS) {
  console.log(`=== ${group.label} ===`);
  const all = group.keys.flatMap(key => {
    const re = new RegExp(escapeRe(key), 'gi');
    const hits = [];
    let m;
    while ((m = re.exec(code)) !== null) {
      hits.push({ key, index: m.index });
      if (hits.length >= maxHits * 3) {
        break;
      }
    }
    return hits;
  });
  // 每个 key 至少展示 1 条，总量不超 maxHits。
  const seen = new Set();
  for (const hit of all) {
    if (seen.has(hit.key)) {
      continue;
    }
    seen.add(hit.key);
    const start = Math.max(0, hit.index - contextLen);
    const end = Math.min(code.length, hit.index + contextLen * 2);
    console.log(`\n[${hit.key}] @${hit.index}`);
    console.log(code.slice(start, end).replace(/\n/g, ' '));
    if (seen.size >= maxHits) {
      break;
    }
  }
  if (seen.size === 0) {
    console.log('  （无命中）');
  }
  console.log('');
}
