#!/usr/bin/env node
// 深入逆向 STL/FTL 燃料与时间计算。
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'C:/Users/kilsa/Downloads/bundle.b4534f74bb305f2c.js';
const code = readFileSync(file, 'utf8');

const KEYS = [
  '_ftlFactor',
  'fuelUsageFactor',
  'stlFuelFlowRate',
  'STL_USAGE',
  'FTL_REACTOR',
  'ftlMaxSpeed',
  'reactorUsageFactor',
];

function esc(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

for (const key of KEYS) {
  const re = new RegExp(esc(key), 'g');
  const hits = [];
  let m;
  while ((m = re.exec(code)) !== null && hits.length < 5) {
    const start = Math.max(0, m.index - 500);
    const end = Math.min(code.length, m.index + key.length + 700);
    hits.push(code.slice(start, end).replace(/\n/g, ' '));
  }
  console.log(`\n########## "${key}" — ${hits.length} 处 ##########`);
  for (const h of hits) console.log(`\n…${h}…`);
}

