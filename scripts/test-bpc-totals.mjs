// 多市场比价（computeTotals）回归脚本 —— 带退出码，可自动判定成败。
//
// 用法：node --experimental-strip-types scripts/test-bpc-totals.mjs
//
// 背景（PR #60 审查）：BURN / REPD / GOVH 模式下，采购量是按「当前选定交易所」的
// 仓库库存抵扣后的数量；而交易所卡片此前复用同一份数量去乘各市场价格，于是
// 「某市场有库存、另一市场没有」时，缺货市场的卡片会漏算该物料，被虚假地标成最便宜，
// 用户点进去后成本又跳回去。
//
// 锁定的行为契约：
//   ① 传入 amountByExchange 后，每张卡片用**该市场自己的**数量算总额；
//   ② 某市场该物料净需求为 0 时，既不计价也不计入 missing（否则会被判「不完整」
//      而排除在 cheapestSingle 之外）；
//   ③ 不传 amountByExchange 时行为与旧版完全一致（BPC / BMAT 走这条路径）。
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./lib/bpc-node-loader.mjs', import.meta.url);
const { computeTotals } = await import('../src/features/XIT/BPC/bp-utils.ts');

let pass = 0;
const check = (name, fn) => {
  try {
    fn();
    pass++;
    console.log(`PASS ${name}`);
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`);
    process.exitCode = 1;
  }
};

const exchanges = [
  { code: 'AI1', currency: 'AIC' },
  { code: 'CI1', currency: 'CIS' },
];

function component(ticker, amount, priceByExchange) {
  const prices = new Map();
  for (const [code, price] of Object.entries(priceByExchange)) {
    prices.set(code, { price, amount: 1_000_000, live: true });
  }
  return {
    ticker,
    name: ticker,
    amount,
    prices,
    bestExchange: Object.keys(priceByExchange)[0],
    bestPrice: Object.values(priceByExchange)[0],
    bestAmount: 1_000_000,
    bestLive: true,
  };
}

// RAT 在 CI1 仓库能全覆盖（该市场净需求 0），在 AI1 没有 → AI1 仍需买 500。
const components = [
  component('RAT', 0, { AI1: 100, CI1: 100 }),
  component('DW', 100, { AI1: 100, CI1: 100 }),
];
const amountByExchange = new Map([
  [
    'AI1',
    new Map([
      ['RAT', 500],
      ['DW', 100],
    ]),
  ],
  [
    'CI1',
    new Map([
      ['RAT', 0],
      ['DW', 100],
    ]),
  ],
]);

check('每个交易所用自己的数量算总额（AI1 必须包含 CI1 有库存的 RAT）', () => {
  const totals = computeTotals(components, exchanges, undefined, amountByExchange);
  const ai1 = totals.exchanges.find(e => e.code === 'AI1');
  const ci1 = totals.exchanges.find(e => e.code === 'CI1');
  // AI1：RAT 500 + DW 100，各 100 元 → 60000。
  assert.equal(ai1.total, 60_000);
  // CI1：RAT 0（库存覆盖）+ DW 100 → 10000。
  assert.equal(ci1.total, 10_000);
});

check('最便宜单市场不会再被「漏算缺货」的市场抢走', () => {
  const totals = computeTotals(components, exchanges, undefined, amountByExchange);
  assert.ok(totals.cheapestSingle !== undefined);
  // 旧逻辑下 AI1 只算 DW（10000），会和 CI1 并列甚至更便宜。
  assert.equal(totals.cheapestSingle.code, 'CI1');
});

check('净需求为 0 的物料不算缺报价，市场仍判为「完整」', () => {
  // CI1 完全没给 RAT 报价，但 CI1 也不需要买 RAT → 不应记 missing。
  const noRatQuote = [
    component('RAT', 0, { AI1: 100 }),
    component('DW', 100, { AI1: 100, CI1: 100 }),
  ];
  const totals = computeTotals(noRatQuote, exchanges, undefined, amountByExchange);
  const ci1 = totals.exchanges.find(e => e.code === 'CI1');
  assert.equal(ci1.missing, 0);
  assert.equal(ci1.complete, true);
  assert.equal(ci1.total, 10_000);
});

check('需要买却真的没报价 → 记 missing 且判为不完整', () => {
  // RAT 只有 CI1 报价；AI1 需要买 500 却没有这个盘口。
  const ai1NoRatQuote = [
    component('RAT', 0, { CI1: 100 }),
    component('DW', 100, { AI1: 100, CI1: 100 }),
  ];
  const totals = computeTotals(ai1NoRatQuote, exchanges, undefined, amountByExchange);
  const ai1 = totals.exchanges.find(e => e.code === 'AI1');
  // AI1 要买 500 RAT，但没有报价。
  assert.equal(ai1.missing, 1);
  assert.equal(ai1.complete, false);
});

check('不传 amountByExchange 时与旧行为一致（BPC / BMAT 路径不变）', () => {
  const totals = computeTotals(components, exchanges);
  const ai1 = totals.exchanges.find(e => e.code === 'AI1');
  const ci1 = totals.exchanges.find(e => e.code === 'CI1');
  // 两份都用组件自带的 amount（RAT 0 + DW 100）→ 都是 10000。
  assert.equal(ai1.total, 10_000);
  assert.equal(ci1.total, 10_000);
});

check('选中物料过滤仍然生效：未勾选的物料不计入任何市场', () => {
  const totals = computeTotals(components, exchanges, new Set(['DW']), amountByExchange);
  const ai1 = totals.exchanges.find(e => e.code === 'AI1');
  // 只剩 DW 100 → 10000；RAT 的 500 不该出现。
  assert.equal(ai1.total, 10_000);
});

check('混合总价仍按各物料最优价 × 默认数量（不随分市场数量变化）', () => {
  const totals = computeTotals(components, exchanges, undefined, amountByExchange);
  // RAT amount 0、DW 100，最优价都是 100 → 10000。
  assert.equal(totals.mixedTotal, 10_000);
  assert.equal(totals.mixedMissing, 0);
});

console.log(`\n${pass} 项通过`);
