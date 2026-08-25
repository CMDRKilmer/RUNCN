#!/usr/bin/env node
// 分析 rprun 导出的 prun-log.json，定位「行星轨道根数 + 相位」或
// 「行星当前坐标」的消息类型。
//
// 背景：游戏客户端要渲染所有行星的实时位置（星系地图 MS），必然收到
// 每颗行星的轨道根数 + 相位（历元/平近点角零点）或当前坐标。FIO 只有
// 轨道根数、没有相位；现有已注册消息（SYSTEM_STARS_DATA 等）只有恒星。
// 本脚本扫描真实日志，找出携带这些数据的未处理消息。
//
// 用法：
//   node scripts/analyze-prun-log.mjs <prun-log.json>
//
// 输出：按消息类型汇总命中情况 + 抽样候选结构。

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('用法: node scripts/analyze-prun-log.mjs <prun-log.json>');
  process.exit(1);
}

// 轨道根数字段（大小写变体）。
const ORBIT_KEY = /semiMajorAxis|semiMinorAxis|eccentricity|inclination|rightAscension|periapsis|SemiMajor|Eccentricity|Inclination|RightAscension|Periapsis|orbitalPeriod|OrbitPeriod/i;
// 相位/历元字段。
const PHASE_KEY = /phase|epoch|meanAnomaly|MeanAnomaly|anomaly|trueAnomaly|eccentricAnomaly|M0\b|\bM\b|argumentOfPeriapsis|longitudeOfAscendingNode/i;
// 轨道任意字段（宽泛）。
const ORBIT_ANY = /orbit/i;
// 行星 naturalId 特征：结尾小写字母（恒星 id 结尾数字）。
const PLANET_ID = /^[A-Z]{2}-\d+[a-z]+$/;

let messages;
try {
  messages = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`读取 ${file} 失败: ${e.message}`);
  process.exit(1);
}
console.log(`消息总数: ${messages.length}\n`);

const byType = new Map();

function track(type, key) {
  if (!byType.has(type)) {
    byType.set(type, { count: 0, orbitKeys: new Set(), phaseKeys: new Set(), samples: [] });
  }
  const t = byType.get(type);
  t.count++;
  if (key) {
    t.orbitKeys.add(key);
  }
}

// 判定一个对象是否像「行星/天体实体」（含 naturalId 且可含轨道字段）。
function looksLikeBody(obj) {
  if (typeof obj !== 'object' || obj === null) {
    return false;
  }
  const id = obj.naturalId ?? obj.NaturalId ?? obj.PlanetNaturalId ?? obj.id;
  return typeof id === 'string' && id !== '';
}

// 递归扫描：收集轨道/相位字段命中，并识别含行星轨道数据的容器。
function scan(value, path, type, hit) {
  if (value === null || typeof value !== 'object') {
    return;
  }
  if (Array.isArray(value)) {
    // 数组元素带 naturalId + 轨道字段 → 很可能是行星/天体列表。
    const sample = value.slice(0, 2);
    const bodyLike = sample.filter(looksLikeBody).length;
    const orbitFields = sample.some(
      v => typeof v === 'object' && v !== null && Object.keys(v).some(k => ORBIT_ANY.test(k)),
    );
    if (bodyLike > 0 && orbitFields) {
      hit.samples.push({ path, elementCount: value.length, sample: sample[0] });
    }
    for (let i = 0; i < Math.min(value.length, 200); i++) {
      scan(value[i], `${path}[${i}]`, type, hit);
    }
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    const childPath = `${path}.${k}`;
    if (ORBIT_KEY.test(k)) {
      track(type, k);
      hit.orbitHits++;
    }
    if (PHASE_KEY.test(k)) {
      track(type, k);
      hit.phaseHits++;
    }
    scan(v, childPath, type, hit);
  }
}

for (const msg of messages) {
  const type = msg.messageType ?? msg.type ?? '?';
  const payload = msg.payload ?? msg.data;
  const hit = { orbitHits: 0, phaseHits: 0, samples: [] };
  scan(payload, type, type, hit);
  if (hit.orbitHits > 0 || hit.phaseHits > 0 || hit.samples.length > 0) {
    if (!byType.has(type)) {
      byType.set(type, { count: 0, orbitKeys: new Set(), phaseKeys: new Set(), samples: [] });
    }
    const t = byType.get(type);
    t.count++;
    if (hit.orbitHits > 0 || hit.phaseHits > 0) {
      t.samples.push({
        orbitHits: hit.orbitHits,
        phaseHits: hit.phaseHits,
        samplePath: undefined,
        payload,
      });
    }
    for (const s of hit.samples) {
      t.samples.push(s);
    }
  }
}

// 输出报告。
console.log('=== 含轨道/相位字段或行星列表的消息类型 ===\n');
for (const [type, t] of byType) {
  const keys = [...t.orbitKeys];
  console.log(`[${type}] 出现 ${t.count} 次`);
  if (keys.length) {
    console.log(`  轨道字段: ${keys.join(', ')}`);
  }
  if (t.samples.length) {
    const s = t.samples[0];
    if (s.samplePath !== undefined) {
      console.log(
        `  行星候选: ${s.samplePath} (元素 ${s.elementCount} 个) → ${JSON.stringify(s.sample).slice(0, 400)}`,
      );
    } else {
      console.log(`  字段命中样例: ${JSON.stringify(s.payload).slice(0, 400)}`);
    }
  }
  console.log('');
}
