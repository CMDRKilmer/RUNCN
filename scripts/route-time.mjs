// 计算两点间航线时间（自然 vs 网关）。用内置连接 + 网关配对连接 + FIO 恒星坐标。
// 用法：node scripts/route-time.mjs <fromSystem> <toSystem>
import { readFileSync } from 'node:fs';

const [, , fromArg, toArg] = process.argv;
const FROM = (fromArg || 'VH-331').toUpperCase();
const TO = (toArg || 'OT-580').toUpperCase();

const stars = JSON.parse(readFileSync('.tmp/fio-stars.json', 'utf8'));
const byNat = new Map(stars.map(s => [s.NaturalId, s]));
const dist3d = (a, b) => Math.hypot(a.PositionX - b.PositionX, a.PositionY - b.PositionY, a.PositionZ - b.PositionZ);
const ftlPc = (a, b) => dist3d(byNat.get(a), byNat.get(b)) / 12;

// 自然连接（内置）
const builtin = JSON.parse(readFileSync('public/json/star-connections.json', 'utf8'));
const natAdj = new Map();
for (const [k, conns] of Object.entries(builtin)) {
  for (const c of conns) {
    (natAdj.get(k) || natAdj.set(k, new Set()).get(k)).add(c);
    (natAdj.get(c) || natAdj.set(c, new Set()).get(c)).add(k);
  }
}

// 网关连接（名称配对，来自打开星图的 DATA_DATA gateways）
const gws = JSON.parse(readFileSync('C:/Users/kilsa/Downloads/prun-gateways.json', 'utf8'));
const norm = s => String(s).toLowerCase().replace(/\s+/g, '').replace(/[‐\-–—]/g, '');
const parseName = name => {
  const m = name.match(/^(.*?)\s*(?:-{1,2}>|→)\s*(.*?)$/);
  return m ? { local: m[1].trim(), remote: m[2].trim() } : null;
};
const parsed = gws.map(g => ({ g, ...parseName(g.name) })).filter(p => p.local);
const gwEdges = [];
const seenPair = new Set();
for (const x of parsed) {
  for (const y of parsed) {
    if (x.g.naturalId === y.g.naturalId) continue;
    const l1 = norm(x.local), r1 = norm(x.remote), l2 = norm(y.local), r2 = norm(y.remote);
    const ok1 = r1 === l2 || r1.startsWith(l2) || l2.startsWith(r1);
    const ok2 = r2 === l1 || r2.startsWith(l1) || l1.startsWith(r2);
    if (!ok1 || !ok2) continue;
    const key = [x.g.naturalId, y.g.naturalId].sort().join('|');
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    gwEdges.push([x.g.systemId, y.g.systemId]);
  }
}
const gwSet = new Set(gwEdges.map(([a, b]) => [a, b].sort().join('|')));
const gwAdj = new Map();
for (const [k, v] of natAdj) gwAdj.set(k, new Set(v));
for (const [a, b] of gwEdges) {
  (gwAdj.get(a) || gwAdj.set(a, new Set()).get(a)).add(b);
  (gwAdj.get(b) || gwAdj.set(b, new Set()).get(b)).add(a);
}

// Dijkstra 按时间加权
function dijkstra(adj, useGw) {
  const dist = new Map();
  const prev = new Map();
  const q = new Map();
  q.set(FROM, 0);
  dist.set(FROM, 0);
  while (q.size) {
    let cur = null, min = Infinity;
    for (const [n, d] of q) if (d < min) { min = d; cur = n; }
    q.delete(cur);
    if (cur === TO) break;
    for (const nx of adj.get(cur) || []) {
      const pc = ftlPc(cur, nx);
      const gw = gwSet.has([cur, nx].sort().join('|'));
      let w = gw ? pc / 3.0 : pc / 2.26;
      if (useGw && gw) w += 20 / 60; // LOCK+DECAY 固定 20min
      const nd = dist.get(cur) + w;
      if (nd < (dist.get(nx) ?? Infinity)) { dist.set(nx, nd); prev.set(nx, cur); q.set(nx, nd); }
    }
  }
  if (!prev.has(TO) && TO !== FROM) return undefined;
  const path = [];
  let n = TO;
  while (n != null) { path.unshift(n); n = prev.get(n); }
  return { path, ftl: dist.get(TO) };
}

function show(r, label) {
  if (!r) { console.log(label + ': 不可达'); return; }
  let gwPc = 0, natPc = 0, gwN = 0, lock = 0;
  console.log(`\n${label}（${r.path.length - 1} 跳, FTL+锁定 ≈ ${r.ftl.toFixed(1)}h）`);
  for (let i = 0; i < r.path.length - 1; i++) {
    const a = r.path[i], b = r.path[i + 1];
    const pc = ftlPc(a, b);
    const gw = gwSet.has([a, b].sort().join('|'));
    const h = gw ? pc / 3.0 : pc / 2.26;
    if (gw) { gwPc += pc; gwN++; lock += 20 / 60; } else natPc += pc;
    console.log(`  ${a} → ${b} | ${gw ? '🛰网关' : '自然'} | ${pc.toFixed(2)}pc | ${h.toFixed(1)}h`);
  }
  console.log(`  网关 ${gwN} 段 ${gwPc.toFixed(2)}pc + 自然 ${natPc.toFixed(2)}pc | 锁定衰减 ${lock.toFixed(1)}h`);
  return r;
}

console.log(`===== ${FROM} → ${TO} =====`);
const nat = show(dijkstra(natAdj, false), '自然航线');
const gw = show(dijkstra(gwAdj, true), '网关航线');
if (nat && gw) {
  console.log(`\n网关省 ${(nat.ftl - gw.ftl).toFixed(1)}h（${(((nat.ftl - gw.ftl) / nat.ftl) * 100).toFixed(0)}%）`);
  console.log(`加 STL 起降 ≈ 2~3h：自然总 ${(nat.ftl + 2.5).toFixed(1)}~${(nat.ftl + 3).toFixed(1)}h | 网关总 ${(gw.ftl + 2.5).toFixed(1)}~${(gw.ftl + 3).toFixed(1)}h`);
}
