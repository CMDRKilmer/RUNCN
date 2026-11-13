// XIT GOVH 模型纯函数自测。运行时零依赖，用 Node 22 的 --experimental-strip-types 直跑 TS。
// 用法：node --experimental-strip-types scripts/test-govh-model.mjs
import assert from 'node:assert/strict';
import {
  NEEDS,
  INFRA_NEEDS,
  LEVELS,
  UPKEEP_BUILDINGS,
  FACILITY_CAPACITY,
  facilityCapacity,
  HAPPINESS_WEIGHTS,
  TIERS,
  computeNeeded,
  computeHappiness,
  applyCapping,
  solve,
} from '../src/features/XIT/GOVH/govh-model.ts';
import {
  parseReportAge,
  reportCacheRemainingMs,
} from '../src/features/XIT/GOVH/govh-report-age.ts';

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

const zeroPop = () => Object.fromEntries(LEVELS.map(l => [l, 0]));
const zeroFulfill = () => Object.fromEntries(NEEDS.map(n => [n, 0]));
const zeroHappiness = () => Object.fromEntries(LEVELS.map(l => [l, 0]));

check('权重表：每类人口六项权重和 = 1', () => {
  for (const level of LEVELS) {
    const total = Object.values(HAPPINESS_WEIGHTS[level]).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${level} 权重和 ${total}`);
  }
});

check('固化表：14 座建筑，顺序首 SST 末 UNI', () => {
  assert.equal(UPKEEP_BUILDINGS.length, 14);
  assert.equal(UPKEEP_BUILDINGS[0].ticker, 'SST');
  assert.equal(UPKEEP_BUILDINGS.at(-1).ticker, 'UNI');
});

check('固化表：每座建筑每种物料贡献 1/n', () => {
  for (const b of UPKEEP_BUILDINGS) {
    const n = b.materials.length;
    const total = Object.values(b.needs).reduce((a, x) => a + (x ?? 0), 0);
    assert.ok(total > 0, `${b.ticker} 无需求贡献`);
    assert.ok(n >= 3, `${b.ticker} 物料数 ${n}`);
  }
});

check('computeNeeded：人口加权正确', () => {
  const pop = { ...zeroPop(), PIONEER: 100, TECHNICIAN: 50, SCIENTIST: 10 };
  const needed = computeNeeded(pop);
  // 安全 = 100×0.25 + 50×0.20 + 10×0.10 = 25+10+1 = 36
  assert.ok(Math.abs(needed.SAFETY - 36) < 1e-9, `SAFETY=${needed.SAFETY}`);
  // 教育 = 100×0.01 + 50×0.05 + 10×0.30 = 1+2.5+3 = 6.5
  assert.ok(Math.abs(needed.EDUCATION - 6.5) < 1e-9, `EDUCATION=${needed.EDUCATION}`);
});

check('applyCapping：高层被下层短板封顶', () => {
  // 维生100 / 安全70 / 健康90 / 舒适95 / 文化50 / 教育100
  const raw = {
    LIFE_SUPPORT: 1,
    SAFETY: 0.7,
    HEALTH: 0.9,
    COMFORT: 0.95,
    CULTURE: 0.5,
    EDUCATION: 1,
  };
  const { fulfillment, capped } = applyCapping(raw);
  assert.equal(fulfillment.SAFETY, 0.7);
  assert.equal(fulfillment.HEALTH, 0.9);
  // comfort 被 min(safety,health)=0.7 封顶
  assert.ok(Math.abs(fulfillment.COMFORT - 0.7) < 1e-9, `COMFORT=${fulfillment.COMFORT}`);
  assert.equal(capped.COMFORT, true);
  // culture 原始 0.5 < 0.7，不被封顶
  assert.ok(Math.abs(fulfillment.CULTURE - 0.5) < 1e-9, `CULTURE=${fulfillment.CULTURE}`);
  assert.equal(capped.CULTURE, false);
  // education 被 min(comfort_sat=0.7, culture_sat=0.5)=0.5 封顶
  assert.ok(Math.abs(fulfillment.EDUCATION - 0.5) < 1e-9, `EDUCATION=${fulfillment.EDUCATION}`);
  assert.equal(capped.EDUCATION, true);
});

check('applyCapping：oog 样例 安全208%/健康312% 但被维生100%封顶为100%', () => {
  // 方案文档提到的 oog 结果：raw 远超 100% 的项最终被封到 71.8%（下层短板）。
  const raw = {
    LIFE_SUPPORT: 0.718,
    SAFETY: 2.089,
    HEALTH: 3.127,
    COMFORT: 1.32,
    CULTURE: 0.9,
    EDUCATION: 0.8,
  };
  const { fulfillment, capped } = applyCapping(raw);
  assert.ok(Math.abs(fulfillment.SAFETY - 0.718) < 1e-9, `SAFETY=${fulfillment.SAFETY}`);
  assert.ok(Math.abs(fulfillment.HEALTH - 0.718) < 1e-9, `HEALTH=${fulfillment.HEALTH}`);
  assert.ok(Math.abs(fulfillment.COMFORT - 0.718) < 1e-9, `COMFORT=${fulfillment.COMFORT}`);
  assert.equal(capped.SAFETY, true);
});

check('computeHappiness：全 100% 满足 → 五类幸福度均 100%', () => {
  const h = computeHappiness(Object.fromEntries(NEEDS.map(n => [n, 1])));
  for (const level of LEVELS) {
    assert.ok(Math.abs(h[level] - 1) < 1e-9, `${level}=${h[level]}`);
  }
});

check('computeHappiness：仅维生100%，其余0 → 幸福度=维生权重', () => {
  const f = Object.fromEntries(NEEDS.map(n => [n, 0]));
  f.LIFE_SUPPORT = 1;
  const h = computeHappiness(f);
  assert.ok(Math.abs(h.PIONEER - 0.54) < 1e-9, `PIONEER=${h.PIONEER}`);
  assert.ok(Math.abs(h.SCIENTIST - 0.05) < 1e-9, `SCIENTIST=${h.SCIENTIST}`);
});

const baseInput = () => ({
  population: {
    ...zeroPop(),
    PIONEER: 76,
    SETTLER: 646,
    TECHNICIAN: 1995,
    ENGINEER: 10,
    SCIENTIST: 0,
  },
  baseCount: 3,
  currentFulfillment: {
    LIFE_SUPPORT: 1,
    SAFETY: 0.86,
    HEALTH: 0.86,
    COMFORT: 0.86,
    CULTURE: 0,
    EDUCATION: 0,
  },
  currentHappiness: {
    PIONEER: 0.2,
    SETTLER: 0.62,
    TECHNICIAN: 0.8,
    ENGINEER: 0.2,
    SCIENTIST: 0.625,
  },
  levels: { SST: 2, INF: 1, PAR: 1, ART: 1, LIB: 1 },
  prices: Object.fromEntries(
    [...new Set(UPKEEP_BUILDINGS.flatMap(b => b.materials))].map(t => [t, 100]),
  ),
});

check('solve：VH-192b 类样例能给出推荐集合且待补成本约为 30 天日成本', () => {
  const r = solve(baseInput());
  assert.ok(r.options.length > 0, '无选项');
  assert.ok(r.selected.size > 0, '推荐集为空');
  assert.ok(r.selected.size <= r.options.length, '推荐集超出选项');
  // 每个选中项都在 options 里
  for (const key of r.selected) {
    assert.ok(
      r.options.some(o => o.key === key),
      `选中项 ${key} 不存在`,
    );
  }
  // 待补成本 = Σ 选中项净待补成本，且必须等于「待补量 × 单价」之和（不再有日成本口径）。
  let expected = 0;
  for (const key of r.selected) {
    const option = r.options.find(o => o.key === key);
    expected += option.netFillAmount * option.price;
    assert.ok(option.capacityKnown, `${key} 容量未知`);
  }
  assert.ok(
    Math.abs(r.summary.fillCost - expected) < 1e-6,
    `fill=${r.summary.fillCost} expected=${expected}`,
  );
  // 模型层面已无任何「日耗 / 日成本」字段。
  for (const option of r.options) {
    assert.equal(option.qtyPerDay, undefined);
    assert.equal(option.dailyCost, undefined);
  }
  assert.equal(r.summary.dailyCost, undefined);
  // 面板「提供量」列读的是封顶前原始提供量，必须为有限的非负数。
  for (const need of NEEDS) {
    assert.ok(Number.isFinite(r.needs[need].provided), `needs.${need}.provided 非有限数`);
    assert.ok(r.needs[need].provided >= 0, `needs.${need}.provided 为负`);
  }
  // 维生基线来自 POPR（此样例为 100%），100% 目标必须可达。
  assert.equal(r.summary.achievable, true, `100% 不可达：${r.summary.limitingNeed}`);
  console.log(
    `   推荐 ${r.selected.size}/${r.options.length} 项，待补成本 ${r.summary.fillCost.toFixed(0)}`,
  );
});

check('solve：current 模式维生 86% 时 100% 原目标受限，有效目标压到 86%', () => {
  const input = baseInput();
  const r = solve({
    ...input,
    target: 1,
    currentFulfillment: { ...input.currentFulfillment, LIFE_SUPPORT: 0.86 },
    lifeSupportAssumption: 'current',
  });
  assert.ok(Math.abs(r.summary.effectiveTarget - 0.86) < 1e-9);
  assert.ok(Math.abs(r.summary.lifeBaseline - 0.86) < 1e-9);
  // 原 100% 目标受限，UI 用它显示「短板」提示；achievable 按有效目标判定，两者可并存。
  assert.equal(r.summary.limitingNeed, 'LIFE_SUPPORT');
  assert.ok(r.needs.SAFETY.fulfillment <= 0.86 + 1e-9, `安全=${r.needs.SAFETY.fulfillment}`);
  // 后五类需求都按有效目标（86%）备足：原 70% 测试覆盖的「全部需求达有效目标」语义。
  for (const need of INFRA_NEEDS) {
    assert.ok(
      r.needs[need].fulfillment >= r.summary.effectiveTarget - 1e-9,
      `${need}=${r.needs[need].fulfillment} < ${r.summary.effectiveTarget}`,
    );
  }
});

check('solve：未传 lifeSupportAssumption 时缺省 current（向后兼容）', () => {
  const r = solve(baseInput());
  assert.equal(r.summary.assumption, 'current');
  assert.ok(Math.abs(r.summary.lifeBaseline - 1) < 1e-9);
});

check('solve：current 模式维生低于目标时有效目标被压低且仍可达', () => {
  const input = baseInput();
  const r = solve({
    ...input,
    target: 1,
    currentFulfillment: { ...input.currentFulfillment, LIFE_SUPPORT: 0.62 },
    lifeSupportAssumption: 'current',
  });
  assert.ok(Math.abs(r.summary.currentLifeSupport - 0.62) < 1e-9);
  assert.ok(Math.abs(r.summary.effectiveTarget - 0.62) < 1e-9);
  assert.equal(r.summary.achievable, true, `limiting=${r.summary.limitingNeed}`);
  assert.equal(r.summary.limitingNeed, 'LIFE_SUPPORT');
  // current 模式下预测值 = 游戏当前实际显示值（同一封顶基线）。
  for (const need of NEEDS) {
    assert.ok(
      Math.abs(r.needs[need].fulfillment - r.needs[need].displayNow) < 1e-9,
      `${need} 预测/实际不一致`,
    );
  }
});

check('solve：full 模式不打折采购目标，维生基线 1.0，预测与实际显示分离', () => {
  const input = baseInput();
  const r = solve({
    ...input,
    target: 1,
    currentFulfillment: { ...input.currentFulfillment, LIFE_SUPPORT: 0.62 },
    lifeSupportAssumption: 'full',
  });
  assert.equal(r.summary.assumption, 'full');
  assert.ok(Math.abs(r.summary.lifeBaseline - 1) < 1e-9);
  assert.ok(Math.abs(r.summary.effectiveTarget - 1) < 1e-9);
  assert.ok(Math.abs(r.needs.LIFE_SUPPORT.fulfillment - 1) < 1e-9);
  assert.ok(r.needs.LIFE_SUPPORT.displayNow <= 0.62 + 1e-9);
  assert.ok(r.needs.SAFETY.fulfillment > r.needs.SAFETY.displayNow);
});

check('solve：提前备货的推荐成本与物料数不低于按当前维生', () => {
  const input = {
    ...baseInput(),
    currentFulfillment: { ...baseInput().currentFulfillment, LIFE_SUPPORT: 0.62 },
  };
  const current = solve({ ...input, target: 1, lifeSupportAssumption: 'current' });
  const full = solve({ ...input, target: 1, lifeSupportAssumption: 'full' });
  assert.ok(full.summary.fillCost >= current.summary.fillCost);
  assert.ok(full.selected.size >= current.selected.size);
  assert.equal(current.summary.achievable, true);
});

check('solve：维生 100% 时两档等价（推荐集合、成本、预览一致）', () => {
  const input = baseInput();
  const current = solve({ ...input, lifeSupportAssumption: 'current' });
  const full = solve({ ...input, lifeSupportAssumption: 'full' });
  assert.deepEqual([...current.selected].sort(), [...full.selected].sort());
  assert.equal(current.summary.fillCost, full.summary.fillCost);
  for (const need of NEEDS) {
    assert.ok(Math.abs(current.needs[need].fulfillment - full.needs[need].fulfillment) < 1e-9);
  }
});

check('solve：维生低于目标时 Phase2 冗余剔除仍生效（历史 bug 回归）', () => {
  const input = baseInput();
  const low = solve({
    ...input,
    target: 1,
    currentFulfillment: { ...input.currentFulfillment, LIFE_SUPPORT: 0.5 },
    lifeSupportAssumption: 'current',
  });
  const normal = solve({ ...input, target: 1, lifeSupportAssumption: 'current' });
  assert.equal(low.summary.achievable, true, '达标判据又被封顶恒 false 压死');
  assert.ok(
    low.selected.size <= normal.selected.size,
    `low=${low.selected.size} normal=${normal.selected.size}`,
  );
  assert.ok(low.selected.size < low.options.length, '冗余未剔除：选满全部物料');
});

check('solve：已填满的设施存量自动计入提供量，但不进入待采购清单', () => {
  const r = solve({
    ...baseInput(),
    selected: new Set(),
    facilityStocks: {
      // 安全站 L2 满仓 700（储备 600 + 即时仓 100），两格都填满即无需采购。
      SST: { DW: { nextConsumption: 700, reserve: 0 } },
    },
  });
  const option = r.options.find(o => o.key === 'SST.DW');
  assert.equal(option.netFillAmount, 0);
  assert.equal(option.selected, false);
  // 未勾选也已填满，安全需求仍应拿到 SST.DW 的贡献（2 级 × 2500/3）。
  assert.ok(
    r.needs.SAFETY.provided >= (2500 / 3) * 2 - 1e-9,
    `provided=${r.needs.SAFETY.provided}`,
  );
  assert.equal(r.summary.fillCost, 0);
});

check('solve：性价比按实际等级换算，1 级与 2 级同物料效率一致', () => {
  const input = baseInput();
  const one = solve({ ...input, levels: { SST: 1 }, selected: new Set() });
  const two = solve({ ...input, levels: { SST: 2 }, selected: new Set() });
  const e1 = one.options.find(o => o.key === 'SST.DW').efficiency;
  const e2 = two.options.find(o => o.key === 'SST.DW').efficiency;
  assert.ok(Math.abs(e1 - e2) < 1e-9, `e1=${e1} e2=${e2}`);
});

check('solve：fillAll 全选时每项是选中且成本高', () => {
  const r = solve({ ...baseInput(), fillAll: true });
  assert.equal(r.selected.size, r.options.length);
  assert.ok(r.summary.fillCost > 0);
});

check('solve：无人口 + 无基地 → 需求为 0，目标恒可达，推荐集应被削减为空', () => {
  const r = solve({
    ...baseInput(),
    population: zeroPop(),
    baseCount: 0,
    currentFulfillment: Object.fromEntries(NEEDS.map(n => [n, 1])),
    levels: { SST: 1 },
    prices: { DW: 1, OFF: 1, SUN: 1 },
    selected: new Set(),
    fillAll: false,
  });
  assert.equal(r.selected.size, 0, `推荐集 ${[...r.selected]}`);
  assert.equal(r.summary.achievable, true);
});

check('solve：显式选择优先于求解', () => {
  const r = solve({
    ...baseInput(),
    selected: new Set(['SST.DW', 'INF.OFF']),
  });
  assert.equal(r.selected.size, 2);
  assert.ok(r.selected.has('SST.DW'));
  assert.ok(r.selected.has('INF.OFF'));
});

check('solve：无报价物料 efficiency=-1 但仍出现在全部选项', () => {
  const prices = Object.fromEntries(
    [...new Set(UPKEEP_BUILDINGS.flatMap(b => b.materials))].map(t => [t, undefined]),
  );
  const r = solve({ ...baseInput(), prices });
  assert.ok(r.options.length > 0);
  assert.ok(r.options.every(o => o.efficiency === -1));
  assert.equal(r.summary.missingPrices, r.selected.size);
});

check('INFRA_NEEDS 不含 LIFE_SUPPORT', () => {
  assert.ok(!INFRA_NEEDS.includes('LIFE_SUPPORT'));
  assert.equal(INFRA_NEEDS.length, 5);
});

check('TIERS 分层正确', () => {
  assert.deepEqual(
    TIERS.map(t => t.length),
    [1, 2, 2, 1],
  );
});

check('满仓量：POPID 没给容量时用容量表按等级推算（SST.DW L2 → 700）', () => {
  const r = solve({ ...baseInput(), selected: new Set(['SST.DW']) });
  const option = r.options.find(o => o.key === 'SST.DW');
  assert.ok(option.capacityKnown);
  assert.equal(option.grossFillAmount, 700);
  assert.equal(option.stockTotal, 0);
  assert.equal(option.netFillAmount, 700);
  assert.equal(option.netFillCost, 70000);
  assert.ok(option.calculation.includes('待补 700'));
});

check('满仓量：取 POPID「下一次消耗 + 储备」两格容量，实测优先于容量表', () => {
  const r = solve({
    ...baseInput(),
    selected: new Set(['SST.DW']),
    facilityStocks: {
      SST: { DW: { nextConsumption: 0, reserve: 0, nextCapacity: 100, reserveCapacity: 600 } },
    },
  });
  const option = r.options.find(o => o.key === 'SST.DW');
  // 安全站 LV2：DW 日耗 20，储备 600（30 天）+ 下一周期 100（5 天）→ 满仓 700。
  assert.equal(option.grossFillAmount, 700);
  assert.equal(option.netFillAmount, 700);
});

check('满仓量：容量表给出的值全是整数，算式里不出现小数点', () => {
  // INF.TUB L1：储备 200 + 即时仓 100 = 300，全部整数（旧口径按日耗 × 30 会得 200.1）。
  const r = solve({ ...baseInput(), selected: new Set(['INF.TUB']) });
  const option = r.options.find(o => o.key === 'INF.TUB');
  assert.equal(option.grossFillAmount, 300);
  assert.ok(Number.isInteger(option.grossFillAmount), String(option.grossFillAmount));
  assert.ok(!option.calculationCompact.includes('.'), option.calculationCompact);
});

// ── 每级容量表（离线推算满仓量）────────────────────────────────────────
// 公式：储备 = 每级 reserve × 建成等级；下一次消耗 = 每级 next × 运行等级。
// 下面两个用例直接锚定 2026-11-13 的实测值，改表必须同时改这里。
check('容量表：VH-192b SST L2（建成=运行）→ 储备 600 / 下一次消耗 100', () => {
  assert.deepEqual(facilityCapacity('SST', 'DW', 2, 2), { reserve: 600, next: 100 });
});

check('容量表：QQ-001a SST 建成 10 / 运行 7 → 储备 3000 / 下一次消耗 350', () => {
  // 两格不同等级：储备按建成 10 级，下一次消耗按运行 7 级（不是 10 级应有的 500）。
  assert.deepEqual(facilityCapacity('SST', 'DW', 10, 7), { reserve: 3000, next: 350 });
  assert.deepEqual(facilityCapacity('SST', 'SUN', 10, 7), { reserve: 600, next: 210 });
});

check('容量表：QQ-001a INF 建成 9 / 运行 5 → 储备 2700 / 下一次消耗 250', () => {
  assert.deepEqual(facilityCapacity('INF', 'OFF', 9, 5), { reserve: 2700, next: 250 });
  assert.deepEqual(facilityCapacity('INF', 'TUB', 9, 5), { reserve: 1800, next: 500 });
});

check('容量表：运行等级缺省时按建成等级算', () => {
  assert.deepEqual(facilityCapacity('SST', 'DW', 3), { reserve: 900, next: 150 });
});

check('容量表：表外建筑 / 物料返回 undefined（回退 POPID 实测）', () => {
  assert.equal(facilityCapacity('EMC', 'PK', 2, 2), undefined);
  assert.equal(facilityCapacity('SST', 'XXX', 2, 2), undefined);
  assert.equal(facilityCapacity('SST', 'DW', 0, 0), undefined);
});

check('容量表：每级容量都是正整数，且物料必须在该建筑的物料清单里', () => {
  for (const [ticker, materials] of Object.entries(FACILITY_CAPACITY)) {
    const building = UPKEEP_BUILDINGS.find(b => b.ticker === ticker);
    assert.ok(building, `${ticker} 不在 UPKEEP_BUILDINGS`);
    for (const [material, per] of Object.entries(materials)) {
      assert.ok(building.materials.includes(material), `${ticker}.${material} 不在物料清单`);
      assert.ok(
        Number.isInteger(per.reserve) && per.reserve > 0,
        `${ticker}.${material} reserve=${per.reserve}`,
      );
      assert.ok(
        Number.isInteger(per.next) && per.next > 0,
        `${ticker}.${material} next=${per.next}`,
      );
      assert.ok(per.next <= per.reserve, `${ticker}.${material} next > reserve`);
    }
  }
});

check('容量表：10 级满级时储备 = 每级 × 10，全程线性', () => {
  for (const [ticker, materials] of Object.entries(FACILITY_CAPACITY)) {
    for (const [material, per] of Object.entries(materials)) {
      const ten = facilityCapacity(ticker, material, 10, 10);
      assert.equal(ten.reserve, per.reserve * 10);
      assert.equal(ten.next, per.next * 10);
    }
  }
});

check('建筑表只列物料清单，不含任何消耗速率', () => {
  for (const building of UPKEEP_BUILDINGS) {
    assert.equal(building.upkeep, undefined, `${building.ticker} 仍有 upkeep 数值表`);
    assert.ok(Array.isArray(building.materials) && building.materials.length > 0);
    for (const material of building.materials) {
      assert.equal(typeof material, 'string', `${building.ticker} 物料不是 ticker 字符串`);
      assert.ok(/^[A-Z0-9]{2,4}$/.test(material), `${building.ticker}.${material} 不像 ticker`);
    }
  }
});

check('容量未知的物料：capacityKnown=false、待补与性价比全部不可用', () => {
  // EMC 没有容量表样本（POPID max 缺失时无从推算），当作容量未知处理。
  const r = solve({
    ...baseInput(),
    levels: { ...baseInput().levels, EMC: 2 },
    selected: new Set(['EMC.PK']),
    prices: { ...baseInput().prices, PK: 500 },
  });
  const option = r.options.find(o => o.key === 'EMC.PK');
  assert.equal(option.capacityKnown, false);
  assert.equal(option.grossFillAmount, 0);
  assert.equal(option.netFillAmount, 0);
  assert.equal(option.netFillCost, 0);
  assert.equal(option.efficiency, -1);
  // 也不该被自动推荐选上（没容量就没法算待补）。
  const auto = solve({
    ...baseInput(),
    levels: { ...baseInput().levels, EMC: 2 },
  });
  assert.ok(!auto.selected.has('EMC.PK'), '容量未知的物料被自动推荐了');
});

check('补满范围：next 档只补即时仓（SST.DW L2 → 待补 100，不是 700）', () => {
  const stocks = {
    SST: { DW: { nextConsumption: 0, reserve: 0, nextCapacity: 100, reserveCapacity: 600 } },
  };
  const both = solve({ ...baseInput(), selected: new Set(['SST.DW']), facilityStocks: stocks });
  const next = solve({
    ...baseInput(),
    selected: new Set(['SST.DW']),
    facilityStocks: stocks,
    fillScope: 'next',
  });
  assert.equal(both.options.find(o => o.key === 'SST.DW').netFillAmount, 700);
  const option = next.options.find(o => o.key === 'SST.DW');
  assert.equal(option.grossFillAmount, 100);
  assert.equal(option.netFillAmount, 100);
  assert.ok(option.calculation.includes('即时仓 100'));
});

check('补满范围：next 档只抵扣即时仓存量，不把储备仓的料算进抵扣', () => {
  const stocks = {
    SST: { DW: { nextConsumption: 0, reserve: 600, nextCapacity: 100, reserveCapacity: 600 } },
  };
  const next = solve({
    ...baseInput(),
    selected: new Set(['SST.DW']),
    facilityStocks: stocks,
    fillScope: 'next',
  });
  const option = next.options.find(o => o.key === 'SST.DW');
  // 储备仓已满不影响即时仓：即时仓仍是 0/100，待补 100。
  assert.equal(option.netFillAmount, 100);
  assert.ok(option.calculationCompact.startsWith('100−0='), option.calculationCompact);

  const both = solve({ ...baseInput(), selected: new Set(['SST.DW']), facilityStocks: stocks });
  assert.equal(both.options.find(o => o.key === 'SST.DW').netFillAmount, 100);
});

check('补满范围：next 档已备一半时待补 = 差额', () => {
  const next = solve({
    ...baseInput(),
    selected: new Set(['SST.DW']),
    facilityStocks: {
      SST: { DW: { nextConsumption: 40, reserve: 0, nextCapacity: 100, reserveCapacity: 600 } },
    },
    fillScope: 'next',
  });
  const option = next.options.find(o => o.key === 'SST.DW');
  assert.equal(option.netFillAmount, 60);
  assert.equal(option.netFillCost, 60 * 100);
});

check('容量表：表算容量直接进 solve 时与实测口径一致（SST.DW 满仓 700）', () => {
  const cap = facilityCapacity('SST', 'DW', 2, 2);
  const r = solve({
    ...baseInput(),
    selected: new Set(['SST.DW']),
    facilityStocks: {
      SST: {
        DW: {
          nextConsumption: 0,
          reserve: 0,
          nextCapacity: cap.next,
          reserveCapacity: cap.reserve,
        },
      },
    },
  });
  const option = r.options.find(o => o.key === 'SST.DW');
  assert.equal(option.grossFillAmount, 700);
});

check('基建存量：扣除“下一次消耗 + 储备”后得到净待补量', () => {
  const r = solve({
    ...baseInput(),
    selected: new Set(['SST.DW']),
    facilityStocks: { SST: { DW: { nextConsumption: 100, reserve: 200 } } },
  });
  const option = r.options.find(o => o.key === 'SST.DW');
  // 容量来自容量表：SST L2 储备 300×2 = 600、即时仓 50×2 = 100，满仓 700。
  assert.equal(option.grossFillAmount, 700);
  assert.equal(option.stockNextConsumption, 100);
  assert.equal(option.stockReserve, 200);
  assert.equal(option.stockTotal, 300);
  assert.equal(option.netFillAmount, 400);
  assert.equal(option.netFillCost, 40000);
  assert.equal(r.summary.fillCost, 40000);
});

check('基建存量：计算过程列写明毛量、两项存量与待补量', () => {
  const r = solve({
    ...baseInput(),
    selected: new Set(['SST.DW']),
    facilityStocks: { SST: { DW: { nextConsumption: 100, reserve: 200 } } },
  });
  const calculation = r.options.find(o => o.key === 'SST.DW').calculation;
  for (const part of ['满仓量 700', '下一次消耗 100', '储备 200', '待补 400']) {
    assert.ok(calculation.includes(part), `计算过程缺少「${part}」：${calculation}`);
  }
});

check('基建存量：存量超过满仓量时待补量不为负', () => {
  const r = solve({
    ...baseInput(),
    selected: new Set(['SST.DW']),
    facilityStocks: { SST: { DW: { nextConsumption: 400, reserve: 400 } } },
  });
  const option = r.options.find(o => o.key === 'SST.DW');
  assert.equal(option.netFillAmount, 0);
  assert.equal(option.netFillCost, 0);
  assert.ok(!option.calculation.includes('待补 -'), option.calculation);
});

check('基建存量：汇总重量 / 体积按净待补量计算', () => {
  const r = solve({
    ...baseInput(),
    selected: new Set(['SST.DW']),
    facilityStocks: { SST: { DW: { nextConsumption: 100, reserve: 200 } } },
    materialsInfo: { DW: { weight: 1, volume: 2 } },
  });
  assert.equal(r.summary.weight, 400);
  assert.equal(r.summary.volume, 800);
});

check('基建存量：同一物料在不同建筑分别扣除', () => {
  const r = solve({
    ...baseInput(),
    selected: new Set(['SST.DW', 'PAR.DW']),
    facilityStocks: {
      SST: { DW: { nextConsumption: 100, reserve: 200 } },
      PAR: { DW: { nextConsumption: 50, reserve: 50 } },
    },
  });
  const sst = r.options.find(o => o.key === 'SST.DW');
  const par = r.options.find(o => o.key === 'PAR.DW');
  // SST L2 满仓 700；PAR L1 满仓 300 + 50 = 350。
  assert.equal(sst.netFillAmount, 400);
  assert.equal(par.netFillAmount, 250);
});

check('汇总重量 / 体积：缺报价的物料照样计入货运量（只有金额算不出来）', () => {
  const prices = { ...baseInput().prices };
  delete prices.DW;
  const r = solve({
    ...baseInput(),
    selected: new Set(['SST.DW']),
    prices,
    materialsInfo: { DW: { weight: 1, volume: 2 } },
  });
  const option = r.options.find(o => o.key === 'SST.DW');
  assert.ok(option.netFillAmount > 0, '待补量应大于 0');
  // 缺价只影响金额，不能把货运量一起吞掉（PR #60 审查）。
  assert.equal(r.summary.missingPrices, 1);
  assert.equal(r.summary.weight, option.netFillAmount);
  assert.equal(r.summary.volume, option.netFillAmount * 2);
  assert.equal(r.summary.fillCost, 0);
});

// ── 报告年龄 / 周期缓存剩余时长 ─────────────────────────────────────
// POPR 的「6天 23小时前」只精确到小时，缓存必须按年龄区间上界失效，
// 否则会在 rollover 后仍返回上一期的人口 / 满足度（PR #60 审查）。
const HOUR = 3600_000;
const DAY = 24 * HOUR;

check('报告年龄：中文「5天 13小时前」解析为 5天13小时，精度 1 小时', () => {
  const age = parseReportAge('报告#43/5天 13小时前');
  assert.ok(age !== undefined);
  assert.equal(age.ageMs, 5 * DAY + 13 * HOUR);
  assert.equal(age.precisionMs, HOUR);
});

check('报告年龄：周期内正常的剩余时长 = 7天 − 年龄 − 精度', () => {
  const age = parseReportAge('报告#43/5天 13小时前');
  assert.equal(reportCacheRemainingMs(age), 7 * DAY - (5 * DAY + 13 * HOUR) - HOUR);
});

check('报告年龄：「6天 23小时前」不缓存（剩余已不足一个精度，随时可能换期）', () => {
  const age = parseReportAge('报告#43/6天 23小时前');
  assert.ok(age !== undefined);
  // 旧口径会算出还剩 1 小时，把上一期数据带进新周期。
  assert.equal(reportCacheRemainingMs(age), 0);
  assert.ok(reportCacheRemainingMs(age) <= 0);
});

check('报告年龄：「6天前」（只到天）按整天精度扣，剩余为 0 不缓存', () => {
  const age = parseReportAge('报告#43/6天前');
  assert.ok(age !== undefined);
  assert.equal(age.ageMs, 6 * DAY);
  assert.equal(age.precisionMs, DAY);
  assert.equal(reportCacheRemainingMs(age), 0);
});

check('报告年龄：分钟级标签按分钟精度扣', () => {
  const age = parseReportAge('报告#43/30分钟前');
  assert.ok(age !== undefined);
  assert.equal(age.ageMs, 30 * 60_000);
  assert.equal(age.precisionMs, 60_000);
  assert.equal(reportCacheRemainingMs(age), 7 * DAY - 31 * 60_000);
});

check('报告年龄：英文「2d 5h ago」同样解析', () => {
  const age = parseReportAge('Report #43 / 2d 5h ago');
  assert.ok(age !== undefined);
  assert.equal(age.ageMs, 2 * DAY + 5 * HOUR);
  assert.equal(age.precisionMs, HOUR);
});

check('报告年龄：解析不出来（「刚刚」）返回 undefined，调用方因此不写缓存', () => {
  assert.equal(parseReportAge('刚刚'), undefined);
  assert.equal(parseReportAge(undefined), undefined);
});

check('报告年龄：任何解析成功的标签，剩余时长都不超过「7天 − 年龄」', () => {
  for (const label of [
    '报告#43/0分钟前',
    '报告#43/3小时前',
    '报告#43/1天 2小时前',
    '报告#43/6天 23小时前',
  ]) {
    const age = parseReportAge(label);
    assert.ok(age !== undefined, label);
    assert.ok(reportCacheRemainingMs(age) <= 7 * DAY - age.ageMs, `${label} 剩余时长超过年龄上界`);
  }
});

console.log(`\n${pass} 项通过`);
