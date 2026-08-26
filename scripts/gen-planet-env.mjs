// 生成 public/json/planet-env.json：全部行星的半径(km)/气压（FTC 起降燃料模型用）。
// 从内置 allplanets.json 读 4155 行星 ID，并发拉 FIO /planet/{id}。
// 输出格式：{ "PG-241h": { "r": 8000, "p": 1.2 }, ... }（r=Radius km，p=Pressure）。
import { readFileSync, writeFileSync } from 'node:fs';

const allplanets = JSON.parse(
  readFileSync('public/json/fallback-fio-responses/allplanets.json', 'utf8'),
);
const ids = allplanets.map(x => x.PlanetNaturalId).filter(Boolean);

const CONCURRENCY = 30;
const TIMEOUT = 10000;

async function fetchPlanet(id) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const resp = await fetch(`https://rest.fnar.net/planet/${encodeURIComponent(id)}`, {
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return undefined;
    }
    const d = await resp.json();
    if (typeof d.Radius === 'number' && d.Radius > 0) {
      return {
        id: d.PlanetNaturalId ?? id,
        r: Math.round(d.Radius / 1000), // km
        p: typeof d.Pressure === 'number' && d.Pressure > 0 ? d.Pressure : undefined,
      };
    }
  } catch {
    // ignore
  } finally {
    clearTimeout(t);
  }
  return undefined;
}

async function main() {
  const out = {};
  let ok = 0;
  let fail = 0;
  let i = 0;
  const worker = async () => {
    while (i < ids.length) {
      const id = ids[i++];
      const r = await fetchPlanet(id);
      if (r) {
        out[r.id] = r.p !== undefined ? { r: r.r, p: r.p } : { r: r.r };
        ok++;
      } else {
        fail++;
      }
      if ((ok + fail) % 200 === 0) {
        console.log(`进度 ${ok + fail}/${ids.length} 成功 ${ok} 失败 ${fail}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  writeFileSync('public/json/planet-env.json', JSON.stringify(out));
  console.log(`完成：${ok} 成功 / ${fail} 失败，输出 public/json/planet-env.json`);
}

main();
