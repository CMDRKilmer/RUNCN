// FTC 邻档对比（fuel-model.nearbyFuelOptions）纯函数回归脚本 —— 带退出码，可自动判定成败。
//
// 背景（2026-09-24 需求）：FTC 面板原来只显示「最优燃料方案」单行，玩家无法评估
// 「快一点 / 省一点」的边际代价。新增：以最优燃料滑块为中心、**同一反应堆**固定为最优值，
// 取前后各 5 档做对比表（差额列 Δ总时长 / Δ总成本，越界按实际档数截断）。
// 三处用户拍板的口径就是本脚本锁定的对象：
//   a. 反应堆固定为最优值 —— 玩家要看的是「只动燃料滑块」的代价；若每档各取自身最优
//      反应堆，相邻两行差异就混入反应堆变量，无法归因；
//   b. 差额列相对**最优行**（不是相邻行）；
//   c. 越界截断（最优 f = 0.05 时左侧无档可加，只剩右侧 5 档）。
//
// 锁定的行为契约（每条 ≈ 一个 check；直接驱动真实纯函数，不重算、不驱动编排层）：
//   ① 中间档：best.fuel = 0.5、span = 5 → 11 档，覆盖 0.25…0.75（默认 span 常量 = 5）；
//   ② 同反应堆筛选：返回项 reactor 全等于 best.reactor，且网格里**存在**的 r = 1 同档位
//      （同样 11 档）一个都不进结果 —— 证明是「同反应堆」筛选，不是「全网格按成本」取邻近；
//   ③ 结果含 best 本身（同一对象引用）且位于正中、按 fuel 严格升序；调用不改变入参数组顺序；
//   ④ 端点截断：best.fuel = 0.05 → 6 档（0.05…0.30）；best.fuel = 0.1 → 7 档（0.05…0.35，
//      用户举的样例）；best.fuel = 1 → 6 档（0.75…1）；
//   ⑤ 守卫：best 的 fuel 不在网格里（且同反应堆候选**非空**）→ 返回 []，不抛异常；
//      best.reactor 不在网格里 → 同样返回 []；
//   ⑥ 真实 computeFuelOption 生成的 options（同一 metrics/ship）：含 best 行，且该行
//      totalCost 与 best 逐位相同（筛选时不会把 best 换成「同燃料的另一条方案」）。
//
// 用法：node scripts/verify-ftc-nearby-fuels.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
// 局限：① 只到纯函数层 —— 面板 DOM 接线（`<details open>`、差额文案「—」/带符号）在 Node
//   里不可加载，由代码审查覆盖；② 飞船/航线夹具是**合成**的（本脚本只断言筛选与截断的
//   结构性行为，不断言任何实测数值，故不需要真实标定数据）；③ 不引入 register/@src loader：
//   fuel-model.ts 无任何 import（纯函数模块，与 verify-ftc-balance-degenerate.mjs 同一路）。
import {
  autoFuelGrid,
  computeFuelOption,
  nearbyFuelOptions,
  scanFuelOptions,
  NEARBY_FUEL_SPAN,
} from '../src/features/XIT/FTC/fuel-model.ts';

const summary = { pass: 0, fail: 0 };

function check(name, fn) {
  const failures = [];
  try {
    fn(failures);
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

function expectExact(failures, label, actual, expected) {
  if (!Object.is(actual, expected)) {
    failures.push(`expected=${expected} actual=${actual} (${label})`);
  }
}
// 档位数值用 1e-9 容差比较：autoFuelGrid 的 0.05 步长是 2 位小数取整值，
// 只有 0.25/0.75 这类二进制可精确表示的数才值得逐位比（本脚本不依赖这一点）。
function expectNear(failures, label, actual, expected, tol = 1e-9) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tol) {
    failures.push(`expected=${expected}±${tol} actual=${actual} (${label})`);
  }
}
function expectCondition(failures, label, ok, expectedText, actualText) {
  if (!ok) {
    failures.push(`expected=${expectedText} actual=${actualText} (${label})`);
  }
}
function fmtFuels(list) {
  return list.map(o => o.fuel).join(', ');
}

// ---- 夹具：合成飞船 + 跨星系航线（含自然跃迁，故反应堆参与扫描）----
const SHIP = {
  mass: 3200,
  operatingEmptyMass: 2400,
  acceleration: 78.5,
  ftlMaxSpeed: 4.4,
  stlFuelFlowRate: 0.03,
  reactorPower: 7200,
  condition: 1,
  stlEngineOption: 'STL_ENGINE_HYPERTHRUST',
  stlFuelCapacity: 8000,
  stlRemaining: 8000,
  minReactorUsage: 0.076,
  emitterChargeTime: 90,
  maxGFactor: 15,
};
const METRICS = {
  stlDistanceKm: 21343591 + 72034932,
  departKm: 21343591,
  approachKm: 72034932,
  natPc: 41.3,
  gwPc: 0,
  gwCount: 0,
  natJumpCount: 2,
  fromBody: 'HRT',
  toBody: 'ZV-307A',
};
const PRICES = { stlPrice: 12000, ftlPrice: 30000, timeValue: 2500 };
// 两个反应堆值：r = 0.5 是最优档（被固定的那个），r = 1 是「同档位但不同反应堆」的对照集。
const REACTORS = [0.5, 1];
const GRID = autoFuelGrid();
const OPTIONS = scanFuelOptions(SHIP, METRICS, GRID, REACTORS, PRICES);
const OPTION_FUELS_BEFORE = OPTIONS.map(o => o.fuel);
const at = (fuel, reactor) => OPTIONS.find(o => o.fuel === fuel && o.reactor === reactor);

// ---- ① 中间档：11 档、覆盖 0.25…0.75 ----
check('① 中间档 best.fuel=0.5 → 11 档（0.25…0.75），默认 span=5', f => {
  const best = at(0.5, 0.5);
  expectCondition(f, '前置 best 存在', best !== undefined, '非 undefined', 'undefined');
  expectExact(f, '默认 span 常量', NEARBY_FUEL_SPAN, 5);
  const near = nearbyFuelOptions(OPTIONS, best);
  expectExact(f, '档数', near.length, 11);
  expectNear(f, '首档', near[0]?.fuel, 0.25);
  expectNear(f, '末档', near[10]?.fuel, 0.75);
  expectExact(f, '显式 span=5 与默认结果一致', nearbyFuelOptions(OPTIONS, best, 5).length, 11);
  console.log(`     档位 ${fmtFuels(near)}`);
});

// ---- ② 同反应堆筛选（而非全网格按成本取邻近）----
check('② 返回项全为 best.reactor，且网格里存在的 r=1 同档位一个都不进结果', f => {
  const best = at(0.5, 0.5);
  expectCondition(f, '前置 best.reactor=0.5', best?.reactor === 0.5, '0.5', String(best?.reactor));
  const near = nearbyFuelOptions(OPTIONS, best);
  const reactors = [...new Set(near.map(o => o.reactor))];
  expectCondition(
    f,
    '全部同反应堆',
    near.every(o => o.reactor === best.reactor),
    `reactor=${best.reactor}`,
    `reactors=${reactors.join(',')}`,
  );
  // 对照集：同燃料区间但 r=1 的 11 条方案确实存在于网格里（否则上一条断言因数据缺失而空转）。
  const otherReactor = OPTIONS.filter(
    o => o.reactor === 1 && o.fuel >= 0.25 - 1e-9 && o.fuel <= 0.75 + 1e-9,
  );
  expectExact(f, '对照 r=1 同档位数量', otherReactor.length, 11);
  expectCondition(
    f,
    '不含 r=1 的同档位',
    near.every(o => o.reactor !== 1),
    'reactor=0.5',
    `reactors=${reactors.join(',')}`,
  );
  // 反证「不是全网格取邻近」：全网格同燃料区间的档数是结果的 2 倍（两个反应堆值）。
  const allReactors = OPTIONS.filter(o => o.fuel >= 0.25 - 1e-9 && o.fuel <= 0.75 + 1e-9);
  expectExact(f, '对照 全网格同区间档数', allReactors.length, 22);
  expectExact(f, '结果恰为全网格的一半（只取同反应堆）', near.length * 2, allReactors.length);
});

// ---- ③ 含 best 本身、居中、升序、不改变入参顺序 ----
check('③ 含 best（同一引用）且居中、按 fuel 升序、调用无副作用', f => {
  const best = at(0.5, 0.5);
  const near = nearbyFuelOptions(OPTIONS, best);
  expectCondition(f, '包含 best 本身', near.includes(best), 'true', 'false');
  expectExact(f, 'best 位于正中', near.indexOf(best), 5);
  let ascending = true;
  for (let i = 1; i < near.length; i++) {
    if (!(near[i].fuel > near[i - 1].fuel)) {
      ascending = false;
    }
  }
  expectCondition(f, '按 fuel 严格升序', ascending, 'true', fmtFuels(near));
  expectCondition(
    f,
    '未改变入参数组顺序',
    OPTIONS.every((o, i) => o.fuel === OPTION_FUELS_BEFORE[i]),
    '原序不变',
    '顺序被改动',
  );
});

// ---- ④ 端点截断 ----
check('④ 越界截断：f=0.05 → 6 档；f=0.1 → 7 档；f=1 → 6 档', f => {
  const low = nearbyFuelOptions(OPTIONS, at(0.05, 0.5));
  expectExact(f, 'f=0.05 档数', low.length, 6);
  expectNear(f, 'f=0.05 首档', low[0]?.fuel, 0.05);
  expectNear(f, 'f=0.05 末档', low[low.length - 1]?.fuel, 0.3);

  const second = nearbyFuelOptions(OPTIONS, at(0.1, 0.5));
  expectExact(f, 'f=0.1 档数', second.length, 7);
  expectNear(f, 'f=0.1 首档', second[0]?.fuel, 0.05);
  expectNear(f, 'f=0.1 末档', second[second.length - 1]?.fuel, 0.35);

  const high = nearbyFuelOptions(OPTIONS, at(1, 0.5));
  expectExact(f, 'f=1 档数', high.length, 6);
  expectNear(f, 'f=1 首档', high[0]?.fuel, 0.75);
  expectNear(f, 'f=1 末档', high[high.length - 1]?.fuel, 1);
  console.log(`     档位 ${fmtFuels(low)} ｜ ${fmtFuels(second)} ｜ ${fmtFuels(high)}`);
});

// ---- ⑤ 守卫：best 不在 options 里 → [] 且不抛异常 ----
check('⑤ best 不在网格（fuel 不命中 / reactor 不命中）→ []，不抛异常', f => {
  const ghostFuel = { ...at(0.5, 0.5), fuel: 0.333 };
  expectCondition(
    f,
    '前置：同反应堆候选非空（证明走的是 findIndex 守卫而非空筛选）',
    OPTIONS.some(o => o.reactor === 0.5),
    'true',
    'false',
  );
  const byFuel = nearbyFuelOptions(OPTIONS, ghostFuel);
  expectExact(f, 'fuel 不命中 → 空数组', byFuel.length, 0);

  const ghostReactor = { ...at(0.5, 0.5), reactor: 0.37 };
  const byReactor = nearbyFuelOptions(OPTIONS, ghostReactor);
  expectExact(f, 'reactor 不命中 → 空数组', byReactor.length, 0);
});

// ---- ⑥ 真实 computeFuelOption 生成的 options：best 行不被替换 ----
check('⑥ 真实 computeFuelOption 生成的 options：含 best 行且 totalCost 逐位相同', f => {
  const manual = [];
  for (const fuel of GRID) {
    for (const reactor of REACTORS) {
      manual.push(computeFuelOption(SHIP, METRICS, fuel, reactor, PRICES));
    }
  }
  expectExact(f, '手工生成的组合数', manual.length, GRID.length * REACTORS.length);
  // 最优 = 手工集合里 totalCost 最小者（best 必须来自**同一个**数组，否则查不到同一对象）。
  const best = manual.reduce((a, b) => (b.totalCost < a.totalCost ? b : a));
  const near = nearbyFuelOptions(manual, best);
  const row = near.find(o => o.fuel === best.fuel && o.reactor === best.reactor);
  expectCondition(f, '结果含最优行', row !== undefined, '非 undefined', 'undefined');
  expectExact(f, '最优行 totalCost 与 best 逐位相同', row?.totalCost, best.totalCost);
  expectCondition(f, '最优行就是同一对象（未被换掉）', row === best, 'true', 'false');
  // 交叉验证：手工组合与 scanFuelOptions 派生集合（同一 ship/metrics/价格）的最优成本一致。
  expectExact(f, '与 scanFuelOptions 的最优成本一致', best.totalCost, OPTIONS[0].totalCost);
  console.log(
    `     最优 f=${best.fuel} r=${best.reactor} 成本=${best.totalCost.toFixed(2)} 档数=${near.length}`,
  );
});

console.log(`PASS ${summary.pass}/${summary.pass + summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
