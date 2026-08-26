// 补拉 planet-env.json 中缺失的行星（主脚本失败/超时的）。
// 读取现有 planet-env.json + allplanets 列表，找出缺失 ID，高并发重试。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const allplanets = JSON.parse(
  readFileSync('public/json/fallback-fio-responses/allplanets.json', 'utf8'),
);
const envPath = 'public/json/planet-env.json';
const out = existsSync(envPath) ? JSON.parse(readFileSync(envPath, 'utf8')) : {};

const missing = allplanets
  .map(x => x.PlanetNaturalId)
  .filter(id => id && out[id.toUpperCase()] === undefined && out[id] === undefined);

const CONCURRENCY = 40;
const TIMEOUT = 12000;
const RETRIES = 3;

async function fetchPlanet(id) {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const resp = await fetch(`https://rest.fnar.net/planet/${encodeURIComponent(id)}`, {
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        await new Promise(r => setTimeout(r, 300));
        continue;
      }
      const d = await resp.json();
      if (typeof d.Radius === 'number' && d.Radius > 0) {
        const p = typeof d.Pressure === 'number' && d.Pressure > 0 ? d.Pressure : undefined;
        return { id: d.PlanetNaturalId ?? id, r: Math.round(d.Radius / 1000), p };
      }
    } catch {
      // ignore, retry
    } finally {
      clearTimeout(t);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return undefined;
}

async function main() {
  console.log(`需补拉 ${missing.length} 个`);
  let ok = 0;
  let fail = 0;
  let i = 0;
  const worker = async () => {
    while (i < missing.length) {
      const id = missing[i++];
      const r = await fetchPlanet(id);
      if (r) {
        out[r.id] = r.p !== undefined ? { r: r.r, p: r.p } : { r: r.r };
        ok++;
      } else {
        fail++;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  writeFileSync(envPath, JSON.stringify(out));
  console.log(`补拉完成：${ok} 成功 / ${fail} 仍失败，共 ${Object.keys(out).length} 颗`);
}

main();
