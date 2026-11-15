// 购物车（CBUY）库存抵扣与「最便宜单交易所」的回归脚本 —— 带退出码，可自动判定成败。
//
// 用法：node --experimental-strip-types scripts/test-cbuy-deduction.mjs
//
// 背景（PR #60 审查 2026-11-13）：
//   ① P2：自动选市场此前按「完整需求」算总价，而交易所卡片按「各市场净需求」算。
//      于是「CI1 仓库已存满这批料」时，卡片正确地算出 CI1 零成本最优，自动选择却
//      仍是 AI1，生成的 ACT 在 AI1 白买。
//   ② P1：单市场兜底（没有任何市场凑齐全部物品）时，抵扣按「仓库里有该物料的
//      交易所」解析供货市场，而 ACT 分组独立按最优价市场路由，出现「在 CI1 扣了
//      库存、却去 AI1 买并往 AI1 转运」，CI1 的库存永远不动。
//
// 锁定的行为契约：
//   ① 传 amountByExchange（各市场净需求）后，cheapestSingle 按净需求选，不被
//      完整需求算出的假总价抢走；
//   ② deductNeeds 的 exchangeCode 既决定「在哪扣库存」也决定「在哪买 / 转」：
//      指定路由后不会从别的交易所借库存；
//   ③ 单市场强制到某市场时，买 = 净量、转 = 完整量，且两者同属该市场。
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('./lib/bpc-node-loader.mjs', import.meta.url);
const { computeTotals } = await import('../src/features/XIT/BPC/bp-utils.ts');
const { deductNeeds } = await import('../src/features/XIT/CART/cbuy-inventory.ts');

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

// ── 场景①：10 DW，AI1 单价 1、CI1 单价 2，CI1 仓库已存 10 DW ────────────
const dwComponents = [component('DW', 10, { AI1: 1, CI1: 2 })];
const netByExchange = new Map([
  [
    'AI1',
    new Map([
      ['DW', 10],
      ['RAT', 5],
    ]),
  ],
  [
    'CI1',
    new Map([
      ['DW', 0],
      ['RAT', 5],
    ]),
  ],
]);

check('① 自动选市场按净需求：CI1 已存满 → CI1 才是零成本最优', () => {
  const net = computeTotals(dwComponents, exchanges, undefined, netByExchange);
  assert.equal(net.exchanges.find(e => e.code === 'AI1').total, 10);
  assert.equal(net.exchanges.find(e => e.code === 'CI1').total, 0);
  assert.equal(net.cheapestSingle.code, 'CI1');
});

check('① 对照：只按完整需求算会选 AI1（旧行为，即缺陷本身）', () => {
  const gross = computeTotals(dwComponents, exchanges);
  assert.equal(gross.exchanges.find(e => e.code === 'AI1').total, 10);
  assert.equal(gross.exchanges.find(e => e.code === 'CI1').total, 20);
  assert.equal(gross.cheapestSingle.code, 'AI1');
});

// ── 场景②：DW 只在 AI1 有报价、RAT 只在 CI1 有报价，CI1 另存 6 DW ──────
const grossNeeds = [
  { ticker: 'DW', name: 'DW', amount: 10 },
  { ticker: 'RAT', name: 'RAT', amount: 5 },
];
const inventories = { AI1: {}, CI1: { DW: 6 } };
// 单市场兜底时的路由：各物料的最优价市场（AI1 的 DW 更便宜、RAT 只有 CI1 有）。
const fallbackRoute = { DW: 'AI1', RAT: 'CI1' };

check('② 兜底路由下不会从别的交易所借库存（不再出现「CI1 扣 6、AI1 只买 4」）', () => {
  const rows = deductNeeds(grossNeeds, {}, inventories, t => fallbackRoute[t]);
  const dw = rows.find(r => r.ticker === 'DW');
  assert.equal(dw.exchangeCode, 'AI1');
  assert.equal(dw.exchange, 0);
  assert.equal(dw.net, 10);
  assert.equal(dw.transfer, 10);
});

check('② 不给路由时退回「有库存的市场」（旧分组的错配来源）', () => {
  const rows = deductNeeds(grossNeeds, {}, inventories);
  const dw = rows.find(r => r.ticker === 'DW');
  // 无路由 → 退到仓库里真有 DW 的 CI1：扣 6、只买 4，
  // 而旧实现的分组仍按最优价去 AI1 买 / 转 → 买卖市场与扣减市场不一致。
  assert.equal(dw.exchangeCode, 'CI1');
  assert.equal(dw.exchange, 6);
  assert.equal(dw.net, 4);
});

check('② 每行 exchangeCode 与会话路由一致：买与转同属一个市场', () => {
  const rows = deductNeeds(grossNeeds, {}, inventories, t => fallbackRoute[t]);
  for (const row of rows) {
    assert.equal(row.exchangeCode, fallbackRoute[row.ticker], `${row.ticker} 路由不一致`);
  }
});

check('③ 单市场强制 CI1：买净量 4、转完整量 10，同属 CI1', () => {
  const rows = deductNeeds(grossNeeds, {}, inventories, () => 'CI1');
  const dw = rows.find(r => r.ticker === 'DW');
  assert.equal(dw.exchangeCode, 'CI1');
  assert.equal(dw.exchange, 6);
  assert.equal(dw.net, 4);
  assert.equal(dw.transfer, 10);
});

check('③ 基地库存优先于交易所库存，且不被交易所抵扣重复计算', () => {
  const rows = deductNeeds(grossNeeds, { DW: 4 }, inventories, () => 'CI1');
  const dw = rows.find(r => r.ticker === 'DW');
  // 先扣基地 4 → 需运 6；CI1 有 6 → 全抵扣，采购 0。
  assert.equal(dw.base, 4);
  assert.equal(dw.transfer, 6);
  assert.equal(dw.exchange, 6);
  assert.equal(dw.net, 0);
});

console.log(`\n${pass} 项通过`);
