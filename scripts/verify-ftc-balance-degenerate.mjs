// FTC 平衡点（findBalanceOption）选优的退化回归脚本 —— 带退出码，可自动判定成败。
//
// 背景（2026-09-23 修复的 bug）：SFC 自动联动把「燃料消耗」滑块写成 1（拉满）。
// 根因：燃料维度无真实差异时用 Math.max(1e-9, span) 把浮点噪声放大成全量程，且
// paretoFrontier 退化成只剩最快点 → 两条路径都返回 f=1。
// ⚠️ 2026-09-23 口径标定后：系内燃料 = 0.98×罐×min(f,0.5)（罐口径，与距离无关）——
// 即旧背景里「同星系 stlDistanceKm undefined → stlFuel ≡ 0」的退化路径**已不复存在**
// （燃料不再依赖 d）。契约① 仍由**合成**场景 a/c/d 锁定（那是纯函数层面的退化保护）。
//
// 锁定的行为契约（只断言返回的 fuel / reactor / 燃料总量，不碰内部实现细节）：
//   ① 燃料或时间在全部候选中无差异（跨度 ≤ 1e-9）→ 返回最省油方案
//      （燃料最小 → 反应堆最小 → 滑块最小），**绝不返回最快方案（f = 1 拉满）**；
//   ② 非退化航线 → Pareto 拐点，与修复前逐位一致（「基线锁定」场景：fuel/reactor
//      精确断言 + 燃料总量/总时长 ±1% 数值漂移检测，用于发现退化保护误伤正常选优）；
//   ③ 任何输入（含 NaN 传播）都不得抛异常。
//
// 飞船 = WCB（STL_ENGINE_STANDARD / G8 / 大型 STL 罐 8000）；航线几何取自内置数据：
//   ZV-307a 半长轴 67,291,581 km（planets-orbit.json）
//   HRT|* 离港 21,343,591 km、*|ZV-307A 进近 72,034,932 km（stl-segments.json）
// SFC 自动联动等价于 timeValue=0（未设时间价值）→ findBalanceOption 分支；
// 同星系无自然跃迁 → 反应堆不参与扫描（reactors = [1]，与 ftc-compute 一致）。
//
// 用法：node scripts/verify-ftc-balance-degenerate.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败场景（打印 FAIL <场景名> expected=… actual=…）。
// 直接导入真实模型（Node ≥ 22.18 原生 TS 类型剥离），避免手抄公式引入偏差。
import {
  autoFuelGrid,
  autoReactorGrid,
  findBalanceOption,
  paretoFrontier,
  scanFuelOptions,
} from '../src/features/XIT/FTC/fuel-model.ts';

// ---- 断言框架：失败收集到场景级，末行打印 PASS n/n 或 FAIL，退出码区分成败 ----
const summary = { pass: 0, fail: 0 };
// 「无差异」阈值，与 fuel-model.ts BALANCE_TIE_EPS 及 docs/feature-patterns.md 的契约一致。
const TIE_EPS = 1e-9;

function fmt(v) {
  if (typeof v !== 'number') {
    return String(v);
  }
  return Number.isNaN(v) ? 'NaN' : String(v);
}

function expectExact(failures, label, actual, expected) {
  if (!Object.is(actual, expected)) {
    failures.push(`expected=${fmt(expected)} actual=${fmt(actual)} (${label})`);
  }
}

function expectNear(failures, label, actual, expected, tolerance) {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    failures.push(`expected=${fmt(expected)}±${fmt(tolerance)} actual=${fmt(actual)} (${label})`);
  }
}

function expectCondition(failures, label, ok, expectedText, actualText) {
  if (!ok) {
    failures.push(`expected=${expectedText} actual=${actualText} (${label})`);
  }
}

// 「最快方案」= 时间最短；燃料全域无差异时它就是滑块拉满点（bug 症状），因此退化场景
// 一律不得返回滑块最大值（f = 1）。时间也全等时不存在唯一最快点，同样按此判定。
function expectNotFastest(failures, best) {
  const maxSlider = Math.max(...autoFuelGrid());
  if (best.fuel === maxSlider) {
    failures.push(`expected=非最快方案(f≠${maxSlider}) actual=最快方案(f=${best.fuel}) (退化保护)`);
  }
}

// 场景摘要（供输出与失败定位）：候选数 / 燃料与时间跨度 / Pareto 规模 / 平衡点结果。
function summarize(options, best, fuelSpan, timeSpan) {
  if (options.length === 0) {
    return `候选 0 | 平衡点 ${best === undefined ? 'undefined' : `f=${best.fuel}`}`;
  }
  const bestText =
    best === undefined
      ? 'undefined'
      : `f=${best.fuel} r=${best.reactor} 燃料=${totalFuelOf(best).toFixed(2)}u 时间=${best.totalHours.toFixed(3)}h`;
  return (
    `候选 ${options.length} | 燃料跨度 ${fuelSpan.toExponential(2)} | 时间跨度 ${timeSpan.toExponential(2)}` +
    ` | Pareto ${paretoFrontier(options).length} | 平衡点 ${bestText}`
  );
}

function finish(name, failures, info) {
  if (failures.length === 0) {
    summary.pass++;
    console.log(`PASS ${name}\n     场景 ${info}`);
    return;
  }
  summary.fail++;
  for (const failure of failures) {
    console.log(`FAIL ${name} ${failure}`);
  }
  console.log(`     场景 ${info}`);
}

// 场景判定：前置条件（确认场景真的处于预期的退化/非退化状态，防止 fixture 静默失效）
// → 调用 findBalanceOption → 断言 fuel/reactor（行为契约）与可选的数值锁定。
function checkScenario(name, options, expected) {
  const failures = [];
  const fuels = options.map(totalFuelOf);
  const hours = options.map(o => o.totalHours);
  const fuelSpan = Math.max(...fuels) - Math.min(...fuels);
  const timeSpan = Math.max(...hours) - Math.min(...hours);
  const spanOk = (kind, span) => (kind === 'zero' ? !(span > TIE_EPS) : span > TIE_EPS);
  const spanText = (kind, span) =>
    `${kind === 'zero' ? '全域无差异(span<=1e-9)' : '有差异(span>1e-9)'} span=${span.toExponential(2)}`;
  if (expected.fuelSpan !== undefined) {
    expectCondition(
      failures,
      '前置条件 燃料跨度',
      spanOk(expected.fuelSpan, fuelSpan),
      expected.fuelSpan === 'zero' ? '燃料全域无差异(span<=1e-9)' : '燃料有差异(span>1e-9)',
      spanText(expected.fuelSpan, fuelSpan),
    );
  }
  if (expected.timeSpan !== undefined) {
    expectCondition(
      failures,
      '前置条件 时间跨度',
      spanOk(expected.timeSpan, timeSpan),
      expected.timeSpan === 'zero' ? '时间全域无差异(span<=1e-9)' : '时间有差异(span>1e-9)',
      spanText(expected.timeSpan, timeSpan),
    );
  }
  let best;
  try {
    best = findBalanceOption(options);
  } catch (e) {
    failures.push(
      `expected=不抛异常 actual=抛出异常 ${e instanceof Error ? e.message : String(e)} (findBalanceOption)`,
    );
  }
  if (best === undefined) {
    if (failures.length === 0 && expected.undefinedResult !== true) {
      failures.push('expected=方案对象 actual=undefined (findBalanceOption)');
    }
  } else if (expected.undefinedResult === true) {
    failures.push(`expected=undefined actual=f=${best.fuel} r=${best.reactor} (空输入防御分支)`);
  } else {
    expectExact(failures, '燃料滑块 fuel', best.fuel, expected.fuel);
    expectExact(failures, '反应堆 reactor', best.reactor, expected.reactor);
    if (expected.notFastest === true) {
      expectNotFastest(failures, best);
    }
    if (expected.totalFuel !== undefined) {
      expectNear(
        failures,
        '燃料总量 u（数值锁定 ±1%）',
        totalFuelOf(best),
        expected.totalFuel,
        Math.abs(expected.totalFuel) * 0.01,
      );
    }
    if (expected.totalHours !== undefined) {
      expectNear(
        failures,
        '总时长 h（数值锁定 ±1%）',
        best.totalHours,
        expected.totalHours,
        Math.abs(expected.totalHours) * 0.01,
      );
    }
  }
  finish(name, failures, summarize(options, best, fuelSpan, timeSpan));
  return best;
}

// ---- 场景输入 ----
// SFC 自动联动不传 stlPrice/ftlPrice/timeValue → 全 0。
const NO_PRICES = { stlPrice: 0, ftlPrice: 0, timeValue: 0 };
const grid = autoFuelGrid();
// 单段/双段距离（内置数据实测值，km）。
const A_SEMI_MAJOR_KM = 67291581;
const HRT_DEPART_KM = 21343591;
const ZV307A_APPROACH_KM = 72034932;
// 同星系 = 无自然跃迁/无网关 → 反应堆不影响时长与燃料，网格固定 [1]。
const NO_REACTOR_SCAN = [1];

const wcb = {
  mass: 880,
  operatingEmptyMass: 880,
  acceleration: 78.5,
  ftlMaxSpeed: 3.9,
  stlFuelFlowRate: 0.015,
  reactorPower: 2400,
  condition: 1,
  stlEngineOption: 'STL_ENGINE_STANDARD',
  stlFuelCapacity: 8000,
  stlRemaining: 8000,
  minReactorUsage: 0.3,
  emitterChargeTime: 135,
  maxGFactor: 8,
};

function totalFuelOf(o) {
  return o.stlFuel + o.ftlFuel;
}

function scanRoute(ship, metrics, reactors, settings) {
  return scanFuelOptions(ship, metrics, grid, reactors, NO_PRICES, settings);
}

// 手造方案集（直接喂 findBalanceOption，构造精确的退化/全等输入）。
function makeOption(fuel, reactor, stlFuel, totalHours) {
  return {
    fuel,
    reactor,
    stlFuel,
    ftlFuel: 0,
    stlHours: totalHours,
    ftlHours: 0,
    totalHours,
    fuelCost: 0,
    timeCost: 0,
    gatewayCost: 0,
    totalCost: 0,
    fuelEstimated: true,
    stlShortage: 0,
    ftlShortage: 0,
  };
}

// ===== 退化场景（契约①：任一维度无差异 → 最省油端 f = 网格最小 0.05）=====

// a：燃料对所有候选恒定 + 时间随 f 递减（合成的精确形式）。
checkScenario(
  'a 燃料恒定+时间随f递减（合成）',
  grid.map(f => makeOption(f, 1, 0, 20 / f)),
  { fuel: 0.05, reactor: 1, fuelSpan: 'zero', timeSpan: 'positive', notFastest: true },
);

// a2/a3/b：真实航线 ZV-307a（行星）→ ZV-307（空间站，同星系）。历史触发条件：d 要求
// departKm 与 approachKm 同时存在，进近缺失时 stlFuel ≡ 0。**2026-09-23 口径标定后，
// 系内燃料 = 0.98×罐×min(f,0.5)（与距离无关）** → 这三个场景不再是「燃料无差异」的退化
// 输入，改为锁「新标定式下仍不返回最快方案（f=1）」，并锁定平衡点与燃料量级。
const noApproachSameSystem = {
  stlDistanceKm: undefined,
  departKm: A_SEMI_MAJOR_KM,
  approachKm: undefined,
  natPc: 0,
  gwPc: 0,
  gwCount: 0,
  natJumpCount: 0,
  toBody: 'ZV-307',
};
checkScenario(
  'a2 同星系+进近缺失（罐8000；燃料=0.98×罐×min(f,0.5)，与 d 无关）',
  scanRoute(wcb, noApproachSameSystem, NO_REACTOR_SCAN, {}),
  {
    fuel: 0.1,
    reactor: 1,
    fuelSpan: 'positive',
    timeSpan: 'positive',
    notFastest: true,
    totalFuel: 784,
  },
);
checkScenario(
  'a3 同星系+进近缺失（离港距离 12000km 对照）→ 燃料不受 d 影响',
  scanRoute(wcb, { ...noApproachSameSystem, departKm: 12000 }, NO_REACTOR_SCAN, {}),
  {
    fuel: 0.1,
    reactor: 1,
    fuelSpan: 'positive',
    timeSpan: 'positive',
    notFastest: true,
    totalFuel: 784,
  },
);
// b：小型 STL 罐 1500（BTF 测试船同型）→ 罐口径下燃料 1470×min(f,0.5)。
checkScenario(
  'b 同星系+进近缺失+罐1500（用户现象路径）',
  scanRoute(
    { ...wcb, stlFuelCapacity: 1500, stlRemaining: 1500 },
    noApproachSameSystem,
    NO_REACTOR_SCAN,
    {},
  ),
  {
    fuel: 0.15,
    reactor: 1,
    fuelSpan: 'positive',
    timeSpan: 'positive',
    notFastest: true,
    totalFuel: 220.5,
  },
);

// c：时间对所有候选恒定 + 燃料随 f 递增（tSpan 退化）。
const timeFlatFuelRising = grid.map(f => makeOption(f, 1, f * 1000, 10));
checkScenario('c 时间恒定+燃料随f递增（合成）', timeFlatFuelRising, {
  fuel: 0.05,
  reactor: 1,
  fuelSpan: 'positive',
  timeSpan: 'zero',
  notFastest: true,
});
// c2：同一集合逆序输入 → 结果必须与顺序无关。
checkScenario('c2 时间恒定+燃料递增（逆序输入）', [...timeFlatFuelRising].reverse(), {
  fuel: 0.05,
  reactor: 1,
  fuelSpan: 'positive',
  timeSpan: 'zero',
  notFastest: true,
});

// d：燃料与时间全部相同（完全无差异）→ 只能按「燃料最小 → 反应堆最小 → 滑块最小」兜底。
const allEqual = grid.map(f => makeOption(f, 1, 100, 10));
checkScenario('d 全等（逆序输入）', [...allEqual].reverse(), {
  fuel: 0.05,
  reactor: 1,
  fuelSpan: 'zero',
  timeSpan: 'zero',
  notFastest: true,
});
checkScenario('d2 全等（正序输入，顺序无关性对照）', allEqual, {
  fuel: 0.05,
  reactor: 1,
  fuelSpan: 'zero',
  timeSpan: 'zero',
  notFastest: true,
});

// e：NaN 传播（全 NaN / 半数 NaN）→ 不得抛异常、不得返回最快方案。
checkScenario(
  'e 全字段NaN（stlFuel/totalHours 均 NaN）',
  grid.map(f => makeOption(f, 1, Number.NaN, Number.NaN)),
  { fuel: 0.05, reactor: 1, notFastest: true },
);
checkScenario(
  'e2 半数方案NaN',
  grid.map((f, i) =>
    i % 2 === 0 ? makeOption(f, 1, f * 1000, 20 / f) : makeOption(f, 1, Number.NaN, Number.NaN),
  ),
  { fuel: 0.05, reactor: 1, notFastest: true },
);
// e3：全 NaN 逆序输入 → NaN 会毒化全部比较，兜底排序仍须与输入顺序无关。
checkScenario(
  'e3 全字段NaN（逆序输入）',
  [...grid.map(f => makeOption(f, 1, Number.NaN, Number.NaN))].reverse(),
  { fuel: 0.05, reactor: 1, notFastest: true },
);

// ===== 非退化基线锁定（契约②：退化保护不得误伤正常选优）=====
// 数值为 2026-09-23 修复前后逐位一致的实测值（±1% 容忍浮点/平台差异）。

// k：空候选集（防御分支）→ 返回 undefined，不得抛异常（调用方用 ?? options[0] 兜底）。
checkScenario('k 空候选集', [], { undefinedResult: true });

// l：严格支配点（燃料与时间随 f 同向递减：f=1 既最省油又最快）→ 前沿只剩一点，
// 返回它就是正确选优；证明退化保护不是「一律退到最省油端」的粗暴拦截。
checkScenario(
  'l 严格支配点（燃料与时间同向递减）',
  grid.map(f => makeOption(f, 1, (1 - f) * 1000, 20 / f)),
  { fuel: 1, reactor: 1, fuelSpan: 'positive', timeSpan: 'positive', totalFuel: 0, totalHours: 20 },
);

// f：同星系、两段都有（stlDistanceKm 有值）→ 燃料 = 0.98×罐8000×min(f,0.5) = 7840×min(f,0.5)
// （2026-09-23 口径标定：不再用 C_F×f×d，也不再随 d 变）。
const sameSystemBothSegments = {
  stlDistanceKm: A_SEMI_MAJOR_KM + ZV307A_APPROACH_KM,
  departKm: A_SEMI_MAJOR_KM,
  approachKm: ZV307A_APPROACH_KM,
  natPc: 0,
  gwPc: 0,
  gwCount: 0,
  natJumpCount: 0,
  toBody: 'ZV-307',
};
checkScenario(
  'f 同星系两段都有（标准引擎+罐8000）',
  scanRoute(wcb, sameSystemBothSegments, NO_REACTOR_SCAN, {}),
  {
    fuel: 0.15,
    reactor: 1,
    fuelSpan: 'positive',
    timeSpan: 'positive',
    totalFuel: 1176,
    totalHours: 1.42,
  },
);

// g：跨星系正常（HRT 空间站 → ZV-307a 行星，61pc/8跳，罐模型 + 全反应堆网格）。
const crossSystem = {
  stlDistanceKm: HRT_DEPART_KM + ZV307A_APPROACH_KM,
  departKm: HRT_DEPART_KM,
  approachKm: ZV307A_APPROACH_KM,
  natPc: 61,
  gwPc: 0,
  gwCount: 0,
  natJumpCount: 8,
  toBody: 'ZV-307A',
};
const crossSettings = { landingRadius: 6263, landingPressure: 0.04857154190540314 };
checkScenario(
  'g 跨星系正常（natPc>0，全反应堆网格）',
  scanRoute({ ...wcb, mass: 1200 }, crossSystem, autoReactorGrid(wcb), crossSettings),
  {
    fuel: 0.05,
    reactor: 1,
    fuelSpan: 'positive',
    timeSpan: 'positive',
    totalFuel: 882.83,
    totalHours: 17.929,
  },
);

// h：跨星系 + 罐数据缺失（stlRemaining/stlFuelCapacity 均 undefined）→ 只能靠 cF×f×d 回退。
const noTankShip = { ...wcb, stlFuelCapacity: undefined, stlRemaining: undefined };
checkScenario(
  'h 跨星系+罐数据缺失（cF×f×d 回退）',
  scanRoute(noTankShip, crossSystem, autoReactorGrid(noTankShip), crossSettings),
  {
    fuel: 0.05,
    reactor: 0.6,
    fuelSpan: 'positive',
    timeSpan: 'positive',
    totalFuel: 390.44,
    totalHours: 25.807,
  },
);

// i：纯网关（gwPc>0、起终点段全缺）→ 时间与 f 无关（tSpan 退化）、燃料随 f 线性。
// ⚠️ 断言变更记录（2026-09-24，两次）：当日一度把 `totalHours` 由 **4.6667 改为 4.0111**
// （= 12/3.0 + 2×(20/3600)），依据是「用户 SFC 截图里锁定/衰变各 10 秒」——**该读数看错了**。
// 服务器 BTF（蓝图试航模拟，CDP 直采 ZV-194h → HRT）实测「对锁」与「场衰」**各 10 分钟 0 秒**，
// 与 f、载重无关 ⇒ 原值 **4.6667**（= 12/3.0 + 2×(20/60)）正确，已回滚；4.0111 锁的是错常数。
checkScenario(
  'i 纯网关（时间与f无关、燃料线性）',
  scanRoute(
    wcb,
    {
      stlDistanceKm: undefined,
      departKm: undefined,
      approachKm: undefined,
      natPc: 0,
      gwPc: 12,
      gwCount: 2,
      natJumpCount: 0,
      toBody: 'ZV-307',
    },
    NO_REACTOR_SCAN,
    {},
  ),
  {
    fuel: 0.05,
    reactor: 1,
    fuelSpan: 'positive',
    timeSpan: 'zero',
    notFastest: true,
    totalFuel: 400,
    totalHours: 4.6667,
  },
);

// j：跨星系 + 进近段缺失（罐数据正常，非退化对照）→ 证明退化保护不是一律退到最省油端。
checkScenario(
  'j 跨星系+进近缺失（罐正常，非退化对照）',
  scanRoute(
    wcb,
    { ...crossSystem, stlDistanceKm: undefined, approachKm: undefined },
    NO_REACTOR_SCAN,
    {},
  ),
  {
    fuel: 0.1,
    reactor: 1,
    fuelSpan: 'positive',
    timeSpan: 'positive',
    totalFuel: 1220.95,
    totalHours: 16.925,
  },
);

// m：系内航线 + 整段 TRANSIT（仅 d 已知）→ stlHours = d / 27512 / 3600 / cond 逐位相同。
// 依据（2026-09-24）：BTF「蓝图试航模拟」直采 VH-331g → HRT（同星系纯 TRANSIT）：
//   d = 599,220,390 km / t = 21,780 s → v ≈ 27,512 km/s。fuel-model 已把 restKm 段速度
//   从「引擎表拟合式」改为该常数（见 STL_INTRA_TRANSIT_SPEED_KM_S 上方）。构造：natPc=0、
//   gwPc=0、d=520,000,000 km、departKm/approachKm 缺失 → restKm = d → stlHours = 5.2522 h
//   （cond=1）；ftlHours=0 ⇒ totalHours ≡ stlHours。验证**所有候选** stlHours 与公式
//   逐位相同（误差 < 1 秒 = 0.000278 h）——锁定「用 BTF 实测常数、不再用旧拟合式」。
function checkStlSpeedConstant(name, options, expectedStlHours) {
  const failures = [];
  const TOL_SEC = 1 / 3600; // 1 秒
  const expectedStr = expectedStlHours.toFixed(6);
  let checked = 0;
  for (const o of options) {
    checked++;
    if (Math.abs(o.stlHours - expectedStlHours) > TOL_SEC) {
      failures.push(
        `f=${o.fuel} stlHours=${o.stlHours.toFixed(6)}h 期望 ${expectedStr}±${TOL_SEC.toFixed(6)}h`,
      );
    }
    if (Math.abs(o.totalHours - expectedStlHours) > TOL_SEC) {
      failures.push(
        `f=${o.fuel} totalHours=${o.totalHours.toFixed(6)}h 期望 ${expectedStr}±${TOL_SEC.toFixed(6)}h`,
      );
    }
  }
  if (failures.length === 0 && checked === 0) {
    failures.push('expected=候选>0 actual=候选=0 (空候选集)');
  }
  finish(
    name,
    failures,
    `候选 ${options.length} | stlHours≡${expectedStr}h (±1s=${TOL_SEC.toFixed(6)}h)`,
  );
}

const STL_INTRA_TRANSIT_SPEED_KM_S = 27512;
const INTRA_TRANSIT_D_KM = 520_000_000;
// cond = wcb.condition = 1（见 wcb 定义）；验证 d / 27512 / 3600 / cond 逐位相同。
const EXPECTED_INTRA_TRANSIT_HOURS =
  INTRA_TRANSIT_D_KM / (STL_INTRA_TRANSIT_SPEED_KM_S * 3600) / 1;
const metricsIntraTransit = {
  stlDistanceKm: INTRA_TRANSIT_D_KM,
  departKm: undefined,
  approachKm: undefined,
  natPc: 0,
  gwPc: 0,
  gwCount: 0,
  natJumpCount: 0,
};
checkStlSpeedConstant(
  'm 系内整段 TRANSIT 用 BTF 实测速度常数 27512 km/s（误差 < 1s）',
  scanRoute(wcb, metricsIntraTransit, NO_REACTOR_SCAN, {}),
  EXPECTED_INTRA_TRANSIT_HOURS,
);

// ---- 结果 ----
const total = summary.pass + summary.fail;
if (summary.fail === 0) {
  console.log(`\nPASS ${total}/${total}`);
  process.exit(0);
}
console.log(`\nFAIL ${summary.pass}/${total}（${summary.fail} 个场景失败）`);
process.exit(1);
