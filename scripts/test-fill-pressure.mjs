// 强装填型基地 Mock:对比三种补给上限公式,验证补货后整个补给周期内
// 仓储峰值是否超过容量(产出无处存放 = 卡线)。
//
//   before : daysOfSuppliesFit + 1           (旧公式,只看消耗品占用)
//   minfix : min(fit + 1, daysUntilFull + 1) (最小修复,过于保守)
//   planA  : suppliesCapDays                 (方案 A,storage-analysis 新字段)
//
// 周期模拟: 到港 ship-out(按 shipOutRatio) → 卸货补到 cap → N 天净流累积
// → 峰值负荷 = max(卸货后, 下次到港时)。峰值 > capacity 即卡住。
// 注: 模型假设到港飞船运走全部产物(shippedOut);shipOutRatio<1 的场景
// 违反该假设,属船容量问题(由 FLEET 超载指示),不计入方案 A 判定。

const materials = {
  H2O: { weight: 1.0, volume: 1.0 },
  O2:  { weight: 1.0, volume: 1.0 },
  RTA: { weight: 1.0, volume: 1.0 },
  DW:  { weight: 1.0, volume: 1.0 },
};

const cases = [
  {
    name: '弱装填: 出口 ≫ 进口',
    capacity: { w: 1000, v: 1000 },
    load:     { w:  200, v:  200 },
    burn: { H2O: { daily: 50, inv: 25 }, O2: { daily: 50, inv: 25 }, RTA: { daily: -5, inv: 50 }, DW: { daily: 0, inv: 0 } },
  },
  {
    name: '强装填: 出口 100, 进口 1',
    capacity: { w: 1000, v: 1000 },
    load:     { w:  400, v:  400 },
    burn: { H2O: { daily: 50, inv: 100 }, O2: { daily: 50, inv: 100 }, RTA: { daily: -1, inv: 5 }, DW: { daily: 0, inv: 0 } },
  },
  {
    name: '极端: 当前 90% 满, 出口 100, 进口 1',
    capacity: { w: 1000, v: 1000 },
    load:     { w:  900, v:  900 },
    burn: { H2O: { daily: 50, inv: 200 }, O2: { daily: 50, inv: 200 }, RTA: { daily: -1, inv: 5 }, DW: { daily: 0, inv: 0 } },
  },
  {
    name: '纯消耗(消耗型,应该不卡)',
    capacity: { w: 1000, v: 1000 },
    load:     { w:  300, v:  300 },
    burn: { H2O: { daily: 0, inv: 0 }, O2: { daily: 0, inv: 0 }, RTA: { daily: -10, inv: 50 }, DW: { daily: -5, inv: 50 } },
  },
  {
    name: '体积压力: 大体积产物 + 小仓库',
    capacity: { w: 1000, v: 1000 },
    load:     { w:  600, v:  600 },
    burn: {
      H2O: { daily: 200, inv: 50 },
      O2:  { daily: 100, inv: 50 },
      RTA: { daily: -5,  inv: 10 },
      DW:  { daily: -2,  inv: 20 },
    },
  },
  {
    name: '大库存消耗品 + 高产出(周期短于库存天数)',
    capacity: { w: 1000, v: 1000 },
    load:     { w:  900, v:  900 },
    burn: { H2O: { daily: 50, inv: 10 }, O2: { daily: 50, inv: 10 }, RTA: { daily: -5, inv: 500 }, DW: { daily: 0, inv: 0 } },
  },
  {
    name: '模型外: 80% 满 + 高产出 + ship-out 只带走一半',
    capacity: { w: 1000, v: 1000 },
    load:     { w:  800, v:  800 },
    burn: { H2O: { daily: 80, inv: 200 }, O2: { daily: 80, inv: 200 }, RTA: { daily: -2, inv: 10 }, DW: { daily: 0, inv: 0 } },
    shipOutRatio: 0.5,
    outOfModel: true,
  },
];

// 单维度补给容量上限(与 storage-analysis.ts capDaysForPeak 一致)
function capDaysForPeak(reserved, idle, consumerInv, importRate, exportRate) {
  const invDays = importRate > 0 ? consumerInv / importRate : Infinity;
  let fill;
  const atInvDays = idle + exportRate * invDays;
  if (atInvDays <= reserved) {
    fill = exportRate > 0 ? (reserved - idle) / exportRate : Infinity;
  } else {
    fill =
      exportRate > importRate
        ? Math.max((reserved - idle - consumerInv) / (exportRate - importRate), 0)
        : 0;
  }
  const peak = importRate > 0 ? Math.max((reserved - idle) / importRate, invDays) : Infinity;
  return Math.min(fill, peak);
}

// ---------- 复刻 computeAnalysis(单维度) ----------
function analyse(c) {
  const { capacity, load, burn } = c;
  let importW = 0, exportW = 0, shippedOutW = 0, consumerInvW = 0;
  for (const t of Object.keys(burn)) {
    const m = materials[t]; const b = burn[t]; const daily = b.daily;
    if (daily < 0) {
      importW += -daily * m.weight;
      consumerInvW += b.inv * m.weight;
    } else {
      exportW += daily * m.weight;
    }
    if (daily > 0) shippedOutW += b.inv * m.weight;
  }
  const netW = exportW - importW;
  const availW = Math.max(capacity.w - load.w, 0);
  const daysUntilFull = netW > 0 ? availW / netW : Infinity;
  const reserve = daysUntilFull === Infinity ? 0.05 : 0.20;
  const idleNonW = Math.max(load.w - shippedOutW - consumerInvW, 0);

  const consumableCapW = Math.max(capacity.w * (1 - reserve) - idleNonW, 0);
  const daysOfSuppliesFit = importW > 0 ? consumableCapW / importW : Infinity;

  // 方案 A: suppliesCapDays(与 storage-analysis.ts capDaysForPeak 实现一致)
  const reservedW = capacity.w * (1 - reserve);
  const suppliesCapDays = capDaysForPeak(reservedW, idleNonW, consumerInvW, importW, exportW);

  return { importW, exportW, netW, shippedOutW, idleNonW, consumerInvW, reserve, daysUntilFull, daysOfSuppliesFit, suppliesCapDays };
}

// ---------- 周期模拟 ----------
function simulate(c, capOf) {
  const a = analyse(c);
  const totalCap = capOf(a);
  const consumers = Object.values(c.burn).filter(b => b.daily < 0);
  const minDaysLeft = consumers.length === 0 ? 1000 : Math.min(...consumers.map(b => b.inv / -b.daily));
  const inv = Math.min(minDaysLeft, totalCap);
  const fillTons = Math.max(0, (totalCap - inv) * a.importW);

  const ratio = c.shipOutRatio ?? 1.0;
  const afterShipOut = Math.max(c.load.w - a.shippedOutW * ratio, 0);
  const afterFill = afterShipOut + fillTons;
  // 周期内净流累积到下次到港(N = totalCap 天);峰值取两端较大者
  const atNextVisit = afterFill + (a.exportW - a.importW) * totalCap;
  const peak = a.netW > 0 ? atNextVisit : afterFill;

  return {
    cap: totalCap, inv, fillTons,
    afterFill, atNextVisit, peak,
    capacity: c.capacity.w,
    stuck: peak > c.capacity.w + 1e-9,
  };
}

const formulas = {
  before: a => a.daysOfSuppliesFit + 1,
  minfix: a => Math.min(a.daysOfSuppliesFit + 1, a.daysUntilFull + 1),
  planA:  a => a.suppliesCapDays,
};

let allPass = true;
for (const c of cases) {
  console.log(`\n=== ${c.name}${c.outOfModel ? '(不计入判定)' : ''} ===`);
  const a = analyse(c);
  console.log(`  进口 ${a.importW} t/d, 出口 ${a.exportW} t/d, idleNon ${a.idleNonW} t, 消耗品库存 ${a.consumerInvW} t, reserve ${a.reserve}`);
  console.log(`  daysUntilFull=${fmt(a.daysUntilFull)} daysOfSuppliesFit=${fmt(a.daysOfSuppliesFit)} suppliesCapDays=${fmt(a.suppliesCapDays)}`);
  for (const [k, f] of Object.entries(formulas)) {
    const s = simulate(c, f);
    if (k === 'planA' && s.stuck && !c.outOfModel) allPass = false;
    console.log(`  [${k.padEnd(6)}] 上限=${fmt(s.cap)} 天 补货=${s.fillTons.toFixed(0)} t 卸货后=${s.afterFill.toFixed(0)} 下次到港=${fmt(s.atNextVisit)} 峰值=${s.peak.toFixed(0)}/${s.capacity} → ${s.stuck ? '❌ 卡住' : '✅ OK'}`);
  }
}
console.log(`\n${allPass ? '✅ 方案 A(suppliesCapDays)全部场景通过' : '❌ 方案 A 存在卡住场景'}`);

function fmt(x) {
  return !isFinite(x) ? '∞' : x.toFixed(2);
}
