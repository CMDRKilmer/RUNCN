// 用法：node --experimental-strip-types scripts/verify-fuel-average.mjs
// 燃料单价四市场均价（真实模块 src/features/XIT/FTC/fuel-prices.ts，数据源 FIO）。
// 退出码：0 = 全通过（末行 PASS n/n）；1 = 有失败（FAIL <场景> expected=… actual=…）。
//
// 覆盖（6 个场景）：① 每市场取 FIO `PriceAverage`，四市场取简单平均（缺价市场不参与平均）；
//      ② `PriceAverage` 缺失回退 `Ask`、再回退 `Bid`；③ 只认 SF/FF × AI1/CI1/IC1/NC1
//      （其它物料与交易所忽略）；④ 缓存 10 分钟内不重复请求、force 强制重取；
//      ⑤ 请求失败时保留上一次结果并记录错误；⑥ 并发调用只发一次请求。
// 局限：不触发真实 FIO 请求（fetch 由用例注入），也不覆盖面板渲染。
import { register } from 'node:module';

register('./lib/fuel-average-loader.mjs', import.meta.url);

const { ensureFuelPrices, fuelPrices, readFuelAverages, FUEL_EXCHANGES } =
  await import('../src/features/XIT/FTC/fuel-prices.ts');

const summary = { pass: 0, fail: 0 };

async function check(name, fn) {
  const failures = [];
  try {
    await fn(failures);
  } catch (e) {
    failures.push(`抛出异常 ${String(e)}`);
  }
  if (failures.length === 0) {
    summary.pass++;
    console.log(`PASS ${name}`);
  } else {
    summary.fail++;
    console.log(`FAIL ${name} ${failures.join(' | ')}`);
  }
}

function expectEqual(failures, label, expected, actual) {
  const e = JSON.stringify(expected);
  const a = JSON.stringify(actual);
  if (e !== a) {
    failures.push(`${label} expected=${e} actual=${a}`);
  }
}

const close = (failures, label, expected, actual) => {
  if (!(Math.abs(actual - expected) < 1e-9)) {
    failures.push(`${label} expected=${expected} actual=${actual}`);
  }
};

let fetchCalls = 0;
let rows = [];
let failWith = undefined;

globalThis.fetch = async () => {
  fetchCalls++;
  if (failWith !== undefined) {
    return { ok: false, status: failWith, json: async () => ({}) };
  }
  return { ok: true, status: 200, json: async () => rows };
};

const row = (MaterialTicker, ExchangeCode, PriceAverage, Ask, Bid) => ({
  MaterialTicker,
  ExchangeCode,
  PriceAverage: PriceAverage ?? null,
  Ask: Ask ?? null,
  Bid: Bid ?? null,
});

await check('FIO PriceAverage：SF/FF 各取四市场平均', async failures => {
  fetchCalls = 0;
  failWith = undefined;
  rows = [
    row('SF', 'AI1', 10),
    row('SF', 'CI1', 20),
    row('SF', 'IC1', 30),
    row('SF', 'NC1', 40),
    row('FF', 'AI1', 100),
    row('FF', 'CI1', 200),
    row('FF', 'IC1', 300),
    row('FF', 'NC1', 400),
  ];
  const ok = await ensureFuelPrices(true);
  expectEqual(failures, '取数成功', true, ok);
  expectEqual(failures, '请求次数', 1, fetchCalls);
  close(failures, 'STL 均价', 25, fuelPrices.value.stl.average);
  close(failures, 'FTL 均价', 250, fuelPrices.value.ftl.average);
  expectEqual(
    failures,
    '参与市场',
    [...FUEL_EXCHANGES],
    fuelPrices.value.stl.markets.map(x => x.code),
  );
  expectEqual(
    failures,
    '读取接口',
    { stl: 25, ftl: 250 },
    { stl: readFuelAverages().stl.average, ftl: readFuelAverages().ftl.average },
  );
});

await check('回退链：PriceAverage → Ask → Bid', async failures => {
  failWith = undefined;
  rows = [
    row('SF', 'AI1', 10),
    row('SF', 'CI1', null, 20),
    row('SF', 'IC1', null, null, 30),
    row('SF', 'NC1', null),
  ];
  await ensureFuelPrices(true);
  close(failures, 'STL 均价', 20, fuelPrices.value.stl.average);
  expectEqual(
    failures,
    '各市场取值',
    [
      ['AI1', 10],
      ['CI1', 20],
      ['IC1', 30],
    ],
    fuelPrices.value.stl.markets.map(x => [x.code, x.price]),
  );
});

await check('过滤：只认 SF/FF 与四个主市场', async failures => {
  failWith = undefined;
  rows = [
    row('SF', 'AI1', 10),
    row('SF', 'CI2', 999),
    row('FF', 'NC2', 999),
    row('H2O', 'IC1', 999),
    row('FF', 'IC1', 60),
  ];
  await ensureFuelPrices(true);
  close(failures, 'STL 均价', 10, fuelPrices.value.stl.average);
  close(failures, 'FTL 均价', 60, fuelPrices.value.ftl.average);
  expectEqual(failures, 'STL 市场数', 1, fuelPrices.value.stl.markets.length);
});

await check('缓存：10 分钟内不重复请求，force 强制重取', async failures => {
  failWith = undefined;
  rows = [row('SF', 'AI1', 10)];
  await ensureFuelPrices(true);
  const calls = fetchCalls;
  await ensureFuelPrices();
  expectEqual(failures, '未过期不请求', calls, fetchCalls);
  await ensureFuelPrices(true);
  expectEqual(failures, 'force 重取', calls + 1, fetchCalls);
});

await check('请求失败：保留上一次结果并记录错误', async failures => {
  failWith = 500;
  const ok = await ensureFuelPrices(true);
  expectEqual(failures, '返回 false', false, ok);
  expectEqual(failures, '错误文案', 'FIO HTTP 500', fuelPrices.value.error);
  close(failures, '上次均价保留', 10, fuelPrices.value.stl.average);
  expectEqual(failures, 'loading 复位', false, fuelPrices.value.loading);
});

await check('并发合并：同时调用只发一次请求', async failures => {
  failWith = undefined;
  rows = [row('SF', 'AI1', 12)];
  const before = fetchCalls;
  await Promise.all([ensureFuelPrices(true), ensureFuelPrices(true), ensureFuelPrices(true)]);
  expectEqual(failures, '请求次数', before + 1, fetchCalls);
});

console.log(
  summary.fail === 0
    ? `PASS ${summary.pass}/${summary.pass}`
    : `FAIL ${summary.pass}/${summary.pass + summary.fail}`,
);
process.exitCode = summary.fail === 0 ? 0 : 1;
