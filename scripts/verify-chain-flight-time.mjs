// 环线各段预计飞行时间（真实模块 src/features/XIT/FLEET/chain-flight-time.ts 的
// estimateChainFlightTimes）回归脚本 —— 带退出码，可自动判定成败。
//
// 背景（2026-09-24 修复）：段输入残缺时（系内航段缺服务器原生「转移」TRANSIT 段记录 →
// routeMetrics().stlDistanceKm === undefined → computeFuelOption 的 totalHours === 0），
// 旧实现仍标 ok = true：
//   · 面板把 0 小时显示成「--（与出发同一时刻到达）」；
//   · 循环里 elapsedMs 原地不动（后续段都在"出发时刻"算几何）；
//   · 汇总只累加能算的段；
//   · 更糟的是下游把它当真值消费 —— 多船时间均衡（chain-planner.planTimeBalancedSegments
//     的 complete 门 = 所有段 est.ok）与到港库存预测（arrivalHoursByNaturalId）。
//
// 本脚本锁定的契约（全部直接驱动真实模块，见下"依赖替身"）：
//   ① 输入残缺（missingModelInputs 非空）→ ok=false、error='缺原生 STL 段记录'、
//      missingInputs=[成因全文]、hours=0、arriveAtMs=departAtMs，且**不推进** elapsedMs；
//   ② 反方向原生记录近似（仅系内 + 前向几何缺失 + getSameSystem(to, from).transit.distanceKm > 0）
//      → ok=true + approximated={kind:'reverse-record', from, to, distanceKm}，
//      用时长的 metrics 是 {...metrics, stlDistanceKm: km, transitKm: km}；
//   ③ 近似补上几何后**再判一次** missingModelInputs（罐容量/余量缺失仍判缺，近似不掩盖残缺）；
//   ④ 汇总：ok = legs.every(ok)、totalHours 只累加 ok 段、approximatedLegs = 近似段数。
//
// 依赖替身（scripts/lib/chain-flight-time-loader.mjs）：只有浏览器侧/编排侧依赖走替身
// （vue / ships / blueprints / storage / buffers / sleep / orbit / routes / stars / stations /
// flight-plans / ftc-fuel-settings），被测链路全部保留真实实现：
//   chain-flight-time.ts（被测）→ route-planner.ts（几何来源与查表键）→ route-model.ts
//   （resolveSystemId / isSystemId）→ fuel-model.ts（纯函数模型）→ ftc-compute.ts
//   （shipPerformanceFor / ensureShipBlueprint）→ system-bodies.ts（stlSegmentsStore）。
//
// ⚠️ 为什么 STL 段记录**不用**替身 store：写入键与查表键是成对的契约，替身把两边都自己写会
// 让两边同错而不被发现（docs/contributing.md「写路径与查表路径同错则恒绿」）。这里用真实
// SHIP_FLIGHT_MISSION 消息（api-messages.dispatch）驱动真实 recordStlSegments 写入，
// 于是"只有反方向记录"就是一条**生产解析路径真的会写出**的记录，而不是手搓的 map 项。
//
// 断言常数来源（docs/contributing.md）：
//   · 距离/段时长是夹具字面量（40_000_000 / 55_000_000 / 2200 / 3000 …）；
//   · 时长/燃料的期望值写**字面量**，并与真实模型（routeMetrics / computeFuelOption /
//     scanFuelOptions / findBalanceOption / missingModelInputs）复算互相印证；
//   · 系内段燃料是罐口径 2×0.49×罐×min(f,0.5)（与距离无关）→ f=0.15、罐 3500 应为
//     0.98×3500×0.15 = 514.5u（独立于代码推导，见 data/ftc-calibration 的标定式）；
//   · **不 import 任何生产常数**做期望值：GW_LOCK_HOURS / GW_COST_PER_JUMP / NAT_PC_PER_H
//     等一律不进断言（并发会话正在改网关口径，且本脚本的夹具不含网关段）。
//
// 变异验证（第 1 轮，2026-09-24 本脚本落地时）：把被测判缺分支改回旧行为 ——
//   `if (unresolved.length > 0) {` → `if (false && unresolved.length > 0) {`
// 脚本立刻变红（PASS 5/10，退出码 1），原文：
//   FAIL ① 系内 + 无原生记录 → 每段判缺（ok=false / hours=0 / 不推进时刻）
//     expected=false actual=true (段0.ok) | expected=缺原生 STL 段记录 actual=undefined (段0.error)
//     | expected=0 actual=2 (ok 且 hours===0 的段数（旧 bug 的形状）) …
//   （控制台另打印「① 负向断言：ok 且 hours===0 的段数 = 2（必须为 0，旧实现为 2）」）
// 另外 ① / ④ / ⑤ / ⑥ 共 4 条 FAIL、② 与 ③ 保持 PASS —— 即本脚本的判缺断言确实钉住了
// 被修改的那一行，而与被改行为无关的断言（近似形状、燃料不变性）不受牵连。
// 还原用备份副本覆盖（SHA256 17BBE5D67C7149B71B030645A245B2AD69644E3E133BCB853D1FC76007E428C1
// 前后一致，git diff --stat 与变异前逐行一致）→ 脚本回到 PASS 10/10。
//
// 用法：node scripts/verify-chain-flight-time.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
//
// 局限（别把这里的绿当成端到端绿）：
//   · DOM / 面板展示（ChainView.vue 的「飞行」列文案、多船时间均衡、到港库存预测的消费端）
//     **不在覆盖范围内** —— 本脚本只锁 estimateChainFlightTimes 的返回值契约；
//   · 恒星坐标、航线图、空间站归属是替身注入的**合成**数据（真实来源是游戏 DATA_DATA /
//     routes.ts 观测到的网关连接 / public/json/stations.json），本脚本只用它们把
//     planRoutes 走到系内（legs 为空）与跨星系（1 条自然边）两种真实分支；
//   · 油罐余量恒不可用（替身返回 undefined）→ stlRemaining 恒 undefined，段燃料基准回落罐
//     容量（真实环境里罐不满时用余量，该分支未覆盖）；
//   · gameNow 是替身常量（真实实现 = Date.now() + 计划标定的偏差），只有"缺省起点时刻"
//     一条用例依赖它；
//   · 网关航线（gwCount > 0）未覆盖：其时长口径正被另一会话改动（GW_LOCK_HOURS），
//     本脚本刻意不碰，避免与那边互相绑死；
//   · ④ 的「反方向同星系记录」是**合成**夹具（两份 address 的 SYSTEM 行都写 YY-301 才能让
//     真实 recordStlSegments 写进同星系表）：目的是让近似的查表键**本可命中**，从而
//     「是否误用」可分辨。该合成计划同时写下反方向航线级记录（真实写入端对任何带
//     stlDistance 的计划都写，键同为方向敏感），故段1 正常算出 —— 这是真实行为，不是近似。
import { register } from 'node:module';

// 真实链路：chain-flight-time / route-planner / route-model / fuel-model / ftc-compute /
// system-bodies 保留生产实现；只有浏览器侧依赖走替身（见 loader 的依赖图注释）。
register('./lib/chain-flight-time-loader.mjs', import.meta.url);

// 生产构建由 unimport 注入的全局（真实环境里由 vite/unimport 提供）：system-bodies 用 ref。
globalThis.ref = value => ({ value });
globalThis.config = {
  url: {
    stlSegments: 'https://stub.invalid/stl-segments.json',
    planetEnv: 'https://stub.invalid/planet-env.json',
  },
};
// 内置 STL 段数据：返回空表 —— 夹具只认本脚本派发的计划写下的记录（避免内置快照漂移成隐式夹具）。
globalThis.fetch = async () => ({ json: async () => ({}) });
// system-bodies 的持久化用 window.setTimeout（1000ms 防抖）；本脚本不断言持久化，只为不报错。
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
};
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  },
  configurable: true,
});

const stub = await import('./lib/chain-flight-time-stub.mjs');
// 与生产同一实例的模型（经 shim，见 scripts/lib/chain-flight-time-fuel-model.mjs）。
const fuelModel = await import('./lib/chain-flight-time-fuel-model.mjs');
const { computeFuelOption, findBalanceOption, missingModelInputs, scanFuelOptions } = fuelModel;
const { autoFuelGrid } = fuelModel;
const api = await import('../src/infrastructure/prun-api/data/api-messages.ts');
const { stlSegmentsStore } = await import('../src/infrastructure/prun-api/data/system-bodies.ts');
const { planRoutes, routeMetrics } = await import('../src/features/XIT/FTC/route-planner.ts');
const { shipPerformanceFor } = await import('../src/features/XIT/FTC/ftc-compute.ts');
const { estimateChainFlightTimes } = await import('../src/features/XIT/FLEET/chain-flight-time.ts');

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

async function checkAsync(name, fn) {
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

function expectExact(failures, label, actual, expected) {
  if (!Object.is(actual, expected)) {
    failures.push(`expected=${expected} actual=${actual} (${label})`);
  }
}
function expectClose(failures, label, actual, expected, tol) {
  if (typeof actual !== 'number' || Math.abs(actual - expected) > tol) {
    failures.push(`expected=${expected}±${tol} actual=${actual} (${label})`);
  }
}
function expectCondition(failures, label, ok, expectedText, actualText) {
  if (!ok) {
    failures.push(`expected=${expectedText} actual=${actualText} (${label})`);
  }
}
function expectTextIncludes(failures, label, text, needle) {
  if (typeof text !== 'string' || !text.includes(needle)) {
    failures.push(`expected=含「${needle}」 actual=${text} (${label})`);
  }
}

// ---- 夹具（截图实参同源的飞船/蓝图口径，见 scripts/lib/ftc-node-fixtures.mjs）----
const T0 = 1_700_000_000_000;
// 与替身 gameNow 一致（缺省起点时刻用例）。
const GAME_NOW_STUB = 1_700_000_000_000;
const NO_PRICES = { stlPrice: 0, ftlPrice: 0, timeValue: 0 };
// 合成星系：ZZ-101 内的行星 a..k（全部经 starsStore.getByPlanetNaturalId 解析到 ZZ-101）；
// XX-201 / YY-301 是跨星系用例的两个恒星系。
const SYS = 'ZZ-101';
const REV_KM = 55_000_000; // 反方向记录的距离（只有 i→h 有记录）
const FWD_KM = 40_000_000; // 前向记录的距离（j→k 有记录）

const SHIP = {
  registration: 'STUB-01',
  blueprintNaturalId: 'BP-STUB',
  mass: 2140,
  operatingEmptyMass: 1271,
  acceleration: 0,
  thrust: 0,
  condition: 1,
  stlFuelFlowRate: 0.015,
  reactorPower: 0,
  idStlFuelStore: undefined,
  idFtlFuelStore: undefined,
};

// 标准引擎 / 罐 3500 / G8 / 最小反应堆 0.3 / 充能 135s。tank = 0 用于「罐容量缺失」夹具
// （blueprintInfoFor 把 0 当缺失 → stlFuelCapacity undefined）。
const blueprint = (tank = 3500) => ({
  performance: {
    ftlMaxSpeed: 2.84 / 3600,
    stlFuelCapacity: tank,
    minReactorUsage: 0.3,
    emitterChargeTime: 135,
    maxGFactor: 8,
  },
  selections: [
    { type: 'STL_ENGINE', option: 'STL_ENGINE_STANDARD', amount: 1, modifiers: [] },
    {
      type: 'FTL_REACTOR',
      option: 'FTL_REACTOR_STUB',
      amount: 1,
      modifiers: [{ type: 'FTL_POWER', value: 2400 }],
    },
  ],
});

const sysLine = id => ({ type: 'SYSTEM', entity: { naturalId: id, name: id } });
const bodyLine = (type, id) => ({ type, entity: { naturalId: id, name: id } });
const bodyAddress = (system, body) => ({ lines: [sysLine(system), bodyLine('PLANET', body)] });

// 真实写入路径：一份系内「转移」（TRANSIT）段计划 → recordStlSegments 同时写
// 同星系表（键 出发天体|目标天体）与航线级表（同键）。**只有 origin 星系 === destination
// 星系**时才写同星系表 —— 这正是"系内"的定义（见 system-bodies.recordStlSegments）。
// address 的第二行的星系文本可按用例覆盖：跨星系用例要用它伪造"反方向同星系记录"。
function dispatchTransit(fromBody, toBody, km, seconds, { fromSystem = SYS, toSystem = SYS } = {}) {
  api.dispatch({
    type: 'SHIP_FLIGHT_MISSION',
    data: {
      missionId: `M-${fromBody}-${toBody}`,
      segments: [
        {
          type: 'TRANSIT',
          origin: bodyAddress(fromSystem, fromBody),
          destination: bodyAddress(toSystem, toBody),
          departure: { timestamp: T0 },
          arrival: { timestamp: T0 + seconds * 1000 },
          stlDistance: km,
          stlFuelConsumption: null,
          transferEllipse: null,
          ftlDistance: null,
          ftlFuelConsumption: null,
          damage: 0,
        },
      ],
    },
  });
}

// 每条 check 自备状态：飞船/蓝图/恒星/航线图一律重设（记录表是真实 store，只增不改 ——
// 每个场景用**互不相交**的天体对，故无需清空，单跑与乱序都不漂移）。
function prepareEnvironment({ tank = 3500, graph = {} } = {}) {
  stub.stubSetShip(SHIP);
  stub.stubSetBlueprint(blueprint(tank));
  stub.stubSetStar(SYS, { x: 0, y: 0, z: 0 });
  stub.stubSetStar('XX-201', { x: 0, y: 0, z: 0 });
  // 坐标单位是游戏 ParsecLength(=12)/pc → x=60 ⇒ pc = 5（跨星系用例断言 natPc = 5）。
  stub.stubSetStar('YY-301', { x: 60, y: 0, z: 0 });
  stub.stubSetRouteGraph(graph);
}

const run = (origin, stopIds) =>
  estimateChainFlightTimes({
    ship: SHIP,
    origin,
    stops: stopIds.map(id => ({ naturalId: id, planetName: `${id} 站` })),
    startAtMs: T0,
  });

// ---- ① 系内 + 无任何原生记录：显式判缺（锁旧 bug 的核心用例）----
await checkAsync('① 系内 + 无原生记录 → 每段判缺（ok=false / hours=0 / 不推进时刻）', async f => {
  prepareEnvironment();
  const est = await run('ZZ-101a', ['ZZ-101b']);
  expectExact(f, '段数', est.legs.length, 2);
  expectExact(f, 'est.ok', est.ok, false);
  expectExact(f, 'shipRegistration', est.shipRegistration, 'STUB-01');
  for (const [i, leg] of est.legs.entries()) {
    expectExact(f, `段${i}.ok`, leg.ok, false);
    expectExact(f, `段${i}.error`, leg.error, '缺原生 STL 段记录');
    expectCondition(
      f,
      `段${i}.missingInputs 非空`,
      (leg.missingInputs?.length ?? 0) > 0,
      '>0 条成因',
      String(leg.missingInputs?.length),
    );
    expectExact(f, `段${i}.hours`, leg.hours, 0);
    expectExact(f, `段${i}.arriveAtMs === departAtMs`, leg.arriveAtMs, leg.departAtMs);
    // 判缺段不推进 elapsedMs：两段都在起点时刻。
    expectExact(f, `段${i}.departAtMs`, leg.departAtMs, T0);
    expectExact(f, `段${i}.approximated`, leg.approximated, undefined);
    // 不得留下可被下游消费的「0 小时方案」（旧行为会写 route/metrics/option 并标 ok）。
    expectExact(f, `段${i}.option`, leg.option, undefined);
    expectExact(f, `段${i}.metrics`, leg.metrics, undefined);
    expectExact(f, `段${i}.route`, leg.route, undefined);
  }
  expectExact(f, 'totalHours', est.totalHours, 0);
  expectCondition(
    f,
    '!est.ok ⇒ approximatedLegs===0',
    est.ok === false && est.approximatedLegs === 0,
    'ok=false 且 approximatedLegs=0',
    `ok=${est.ok} approximatedLegs=${est.approximatedLegs}`,
  );
  console.log(
    `  ① 负向断言：ok 且 hours===0 的段数 = ` +
      `${est.legs.filter(l => l.ok === true && l.hours === 0).length}（必须为 0，旧实现为 2）`,
  );
  expectExact(
    f,
    'ok 且 hours===0 的段数（旧 bug 的形状）',
    est.legs.filter(l => l.ok === true && l.hours === 0).length,
    0,
  );
});

// ① 交叉验证 + 成因文案：判缺成因必须来自真实 missingModelInputs（同输入逐字一致）。
await checkAsync('① 判缺成因来自真实 missingModelInputs（逐字一致 + 指明系内）', async f => {
  prepareEnvironment();
  const metrics = routeMetrics(planRoutes('ZZ-101a', 'ZZ-101b').natural);
  expectExact(f, '夹具几何确实缺失（stlRecorded）', metrics.stlRecorded, false);
  expectExact(f, '夹具几何确实缺失（stlDistanceKm）', metrics.stlDistanceKm, undefined);
  const expected = missingModelInputs(shipPerformanceFor(SHIP), metrics);
  expectCondition(f, '真实模型报缺', expected.length > 0, '>0 条', String(expected.length));
  expectTextIncludes(f, '真实模型的成因指明系内', expected[0], '系内飞行');
  const est = await run('ZZ-101a', ['ZZ-101b']);
  expectExact(
    f,
    '段0.missingInputs[0] 与真实模型逐字一致',
    est.legs[0].missingInputs?.[0],
    expected[0],
  );
  // 回程段的成因文案是另一条航线（起终点互换）→ 用同口径再复算一次，逐字比对。
  const reverseMetrics = routeMetrics(planRoutes('ZZ-101b', 'ZZ-101a').natural);
  const expectedReverse = missingModelInputs(shipPerformanceFor(SHIP), reverseMetrics);
  expectExact(
    f,
    '段1.missingInputs[0] 与真实模型逐字一致',
    est.legs[1].missingInputs?.[0],
    expectedReverse[0],
  );
});

// ① 缺省起点时刻 = gameNow()（替身常量）—— 契约里 startAtMs 缺省为当前游戏时刻。
await checkAsync('① 缺省 startAtMs → 第一段出发时刻 = gameNow()', async f => {
  prepareEnvironment();
  const est = await estimateChainFlightTimes({
    ship: SHIP,
    origin: 'ZZ-101a',
    stops: [{ naturalId: 'ZZ-101b', planetName: 'ZZ-101b 站' }],
  });
  expectExact(f, '段0.departAtMs', est.legs[0].departAtMs, GAME_NOW_STUB);
  expectExact(f, 'stub gameNow', stub.gameNow(), GAME_NOW_STUB);
});

// ---- ② 系内 + 只有反方向记录：反方向原生记录近似 ----
await checkAsync('② 反方向记录近似：形状逐字段 + 时长由近似几何算出', async f => {
  prepareEnvironment();
  // 夹具：只派发**反方向**计划（i → h）→ 真实 store 写 sameSystem/route 的键都是 I|H。
  dispatchTransit('ZZ-101i', 'ZZ-101h', REV_KM, 3000);
  expectExact(
    f,
    '夹具：反方向同星系记录已写入（i→h）',
    stlSegmentsStore.getSameSystem('ZZ-101i', 'ZZ-101h')?.transit?.distanceKm,
    REV_KM,
  );
  expectExact(
    f,
    '夹具：本方向（h→i）无记录',
    stlSegmentsStore.getSameSystem('ZZ-101h', 'ZZ-101i'),
    undefined,
  );
  const est = await run('ZZ-101h', ['ZZ-101i']);
  const leg = est.legs[0];
  expectExact(f, '段0.ok', leg.ok, true);
  expectExact(f, '段0.error', leg.error, undefined);
  expectExact(f, '段0.missingInputs', leg.missingInputs, undefined);
  // 近似来源标注：字段与值逐位对应夹具（from/to 是**查表键**，即本段起终点互换）。
  expectExact(f, 'approximated.kind', leg.approximated?.kind, 'reverse-record');
  expectExact(f, 'approximated.from', leg.approximated?.from, 'ZZ-101i');
  expectExact(f, 'approximated.to', leg.approximated?.to, 'ZZ-101h');
  expectExact(f, 'approximated.distanceKm', leg.approximated?.distanceKm, REV_KM);
  expectExact(
    f,
    'approximated 字段集合',
    Object.keys(leg.approximated ?? {})
      .sort()
      .join(','),
    'distanceKm,from,kind,to',
  );
  // 用时长的 metrics 是「近似后的」：d/转移路程都取反方向记录值。
  expectExact(f, '段0.metrics.stlDistanceKm', leg.metrics?.stlDistanceKm, REV_KM);
  expectExact(f, '段0.metrics.transitKm', leg.metrics?.transitKm, REV_KM);
  // 近似不是原生记录：stlRecorded 仍为 false（面板/诊断据此区分）。
  expectExact(f, '段0.metrics.stlRecorded', leg.metrics?.stlRecorded, false);
  // 系内转移段速度改用 BTF 直采常数 STL_INTRA_TRANSIT_SPEED_KM_S = 27,512
  // （2026-09-24 替换原 Weibull 拟合式 —— 与 f/距离无关，但同 d 时长逐位相同 ⇒
  // 平衡退化、最省油即 f=0.05，时长 = d / (27512 × 3600) / cond）。
  expectExact(f, '段0.hours', leg.hours, 0.5553132370521147);
  expectCondition(f, '段0.hours > 0', leg.hours > 0, '>0', String(leg.hours));
  expectExact(f, 'est.approximatedLegs', est.approximatedLegs, 1);
  expectExact(f, 'est.ok', est.ok, true);
  // 交叉验证：真实模型在同一 metrics/档位下复算出同一时长；燃料是罐口径（与距离无关）。
  const recomputed = computeFuelOption(
    shipPerformanceFor(SHIP),
    leg.metrics,
    leg.option.fuel,
    leg.option.reactor,
    NO_PRICES,
  );
  expectExact(f, '选中档位 f（平衡退化 → 最省油）', leg.option.fuel, 0.05);
  expectExact(f, '同档位 STL 燃料（0.98×罐×f = 0.98×3500×0.05）', leg.option.stlFuel, 171.5);
  expectClose(
    f,
    'hours 与真实 computeFuelOption 复算一致',
    leg.hours,
    recomputed.totalHours,
    1e-12,
  );
  // 回程段（i→h）正好被反方向计划写下的键命中 → 有原生记录、**不是**近似段。
  const back = est.legs[1];
  expectExact(f, '回程段.ok', back.ok, true);
  expectExact(f, '回程段.approximated（近似只用于缺前向记录的段）', back.approximated, undefined);
  expectExact(f, '回程段.metrics.stlRecorded', back.metrics?.stlRecorded, true);
  expectExact(
    f,
    '回程段.departAtMs（段0 已推进 elapsed）',
    back.departAtMs,
    T0 + leg.hours * 3600000,
  );
  expectExact(f, 'totalHours（两段相加）', est.totalHours, 1.1106264741042294);
});

// ② 近似只影响时长：同一 f 的 stlFuel 逐位相同（罐口径、与距离无关），时长整条曲线都不同。
check('② 近似只改时长：同 f 的 stlFuel 逐位相同、时长逐点不同（真实模型扫描）', f => {
  prepareEnvironment();
  dispatchTransit('ZZ-101i', 'ZZ-101h', REV_KM, 3000);
  dispatchTransit('ZZ-101j', 'ZZ-101k', FWD_KM, 2200);
  const perf = shipPerformanceFor(SHIP);
  // 反方向夹具：本方向没有几何 → 用模块的近似口径（{...metrics, stlDistanceKm: km, transitKm: km}）。
  const reverseMetrics = routeMetrics(planRoutes('ZZ-101h', 'ZZ-101i').natural);
  expectExact(f, '反方向夹具：forward 几何缺失', reverseMetrics.stlDistanceKm, undefined);
  const usedReverse = { ...reverseMetrics, stlDistanceKm: REV_KM, transitKm: REV_KM };
  // 前向夹具：真实原生记录（距离与前向段不同，用于证明时长随 d 变）。
  const forwardMetrics = routeMetrics(planRoutes('ZZ-101j', 'ZZ-101k').natural);
  expectExact(f, '前向夹具：原生记录距离', forwardMetrics.stlDistanceKm, FWD_KM);
  const optsReverse = scanFuelOptions(perf, usedReverse, autoFuelGrid(), [1], NO_PRICES);
  const optsForward = scanFuelOptions(perf, forwardMetrics, autoFuelGrid(), [1], NO_PRICES);
  expectExact(f, '档位数', optsReverse.length, 20);
  expectExact(
    f,
    'stlFuel 不同的档位数（必须 0：燃料与距离无关）',
    optsReverse.filter((o, i) => !Object.is(o.stlFuel, optsForward[i].stlFuel)).length,
    0,
  );
  expectExact(
    f,
    '时长相同的档位数（必须 0：d 不同 ⇒ 时长不同）',
    optsReverse.filter((o, i) => Object.is(o.stlHours, optsForward[i].stlHours)).length,
    0,
  );
  // 字面量锚点：0.98×3500×0.05 = 171.5u（f=0.05）、0.98×3500×0.5 = 1715u（f≥0.5 饱和）。
  expectExact(f, 'f=0.05 的 STL 燃料', optsReverse[0].stlFuel, 171.5);
  expectExact(f, 'f=1 的 STL 燃料（f 饱和在 0.5）', optsReverse[19].stlFuel, 1715);
  // 系内转移段速度改用 BTF 直采常数 STL_INTRA_TRANSIT_SPEED_KM_S = 27,512（与 f 无关）
  // ⇒ 不论 f，反方向 55M km 时长 = 55M / (27512 × 3600) ≈ 0.5553h；
  //   前向 40M km 时长 = 40M / (27512 × 3600) ≈ 0.4039h；不同 d ⇒ 不同时长（锚点）。
  expectExact(f, 'f=0.15 的反方向时长', optsReverse[2].stlHours, 0.5553132370521147);
  expectExact(f, 'f=0.15 的前向时长', optsForward[2].stlHours, 0.40386417240153794);
});

// ---- ③ 系内 + 前向记录存在：不走近似，时长按真实模型 ----
await checkAsync('③ 前向记录存在 → approximated 缺席、时长 = 真实模型值', async f => {
  prepareEnvironment();
  dispatchTransit('ZZ-101j', 'ZZ-101k', FWD_KM, 2200);
  const est = await run('ZZ-101j', ['ZZ-101k']);
  const leg = est.legs[0];
  expectExact(f, '段0.ok', leg.ok, true);
  expectExact(f, '段0.approximated', leg.approximated, undefined);
  // 系内转移段速度改用 BTF 直采常数 STL_INTRA_TRANSIT_SPEED_KM_S = 27,512（与 f 无关）
  // ⇒ 40M km 时长 = 40M / (27512 × 3600) ≈ 0.4039h；平衡退化 → 最省油即 f=0.05。
  expectExact(f, '段0.hours', leg.hours, 0.40386417240153794);
  expectExact(f, '段0.metrics.stlDistanceKm', leg.metrics?.stlDistanceKm, FWD_KM);
  expectExact(f, '段0.metrics.routeKm（原生航线级）', leg.metrics?.routeKm, FWD_KM);
  expectExact(f, '段0.metrics.routeSeconds（原生段时长）', leg.metrics?.routeSeconds, 2200);
  expectExact(f, '段0.metrics.transitSeconds（原生段时长）', leg.metrics?.transitSeconds, 2200);
  expectExact(f, '段0.metrics.stlRecorded', leg.metrics?.stlRecorded, true);
  // 交叉验证 ①：真实 computeFuelOption 用同一 metrics/档位复算出同一时长。
  const perf = shipPerformanceFor(SHIP);
  const recomputed = computeFuelOption(
    perf,
    leg.metrics,
    leg.option.fuel,
    leg.option.reactor,
    NO_PRICES,
  );
  expectClose(f, 'hours 复算一致', leg.hours, recomputed.totalHours, 1e-12);
  // 交叉验证 ②：档位就是真实模型的平衡点（不是随手取的固定 f）。
  expectExact(
    f,
    '选中档位 = 真实平衡点',
    leg.option.fuel,
    findBalanceOption(scanFuelOptions(perf, leg.metrics, autoFuelGrid(), [1], NO_PRICES))?.fuel,
  );
  expectExact(f, '选中档位（平衡退化 → 最省油）', leg.option.fuel, 0.05);
  // 负向：时长不是原生段时长（2200s = 0.6111h）—— 契约刻意不用 transitSeconds
  //（记录当时那条计划的 f/质量会把它钉死，见 fuel-model.computeFuelOption 的 ⚠️）。
  expectCondition(
    f,
    '时长 ≠ 原生段时长口径（2200s）',
    leg.hours !== 2200 / 3600,
    `≠ ${2200 / 3600}`,
    String(leg.hours),
  );
  // 回程段（k→j）无原生记录 → 走反方向近似（前向记录被反查）。
  expectExact(f, '回程段.approximated.kind', est.legs[1].approximated?.kind, 'reverse-record');
  expectExact(f, '回程段.approximated.from', est.legs[1].approximated?.from, 'ZZ-101j');
  expectExact(f, '回程段.approximated.to', est.legs[1].approximated?.to, 'ZZ-101k');
  expectExact(f, '回程段.approximated.distanceKm', est.legs[1].approximated?.distanceKm, FWD_KM);
  expectExact(f, '回程段.hours', est.legs[1].hours, 0.40386417240153794);
  expectExact(f, 'est.approximatedLegs', est.approximatedLegs, 1);
  expectExact(f, 'est.ok', est.ok, true);
  expectExact(f, 'totalHours', est.totalHours, 0.8077283448030759);
});

// ---- ④ 跨星系：判缺，且反方向记录**不得**被误用 ----
// 强负向夹具：为这条跨星系段**合成**一条反方向的「同星系」计划
//（两份 address 的 SYSTEM 行都写 YY-301 ⇒ 真实 recordStlSegments 判为系内、写进同星系表）。
// 反方向近似的查表键正是 getSameSystem(to, from) = ('YY-301a','XX-201a') → 会命中它，
// 于是"是否误用"才是可分辨的（而不是因为记录不存在而"恰好"没近似）。
// ⚠️ 真实写入端对**任何**带 stlDistance 的计划都会写航线级记录（键同为方向敏感的
// 「出发天体|目标天体」），故这条合成计划同时写下 getRoute('YY-301a','XX-201a')——
// 那只服务**反方向**（YY-301a → XX-201a），对被测的正方向查表无影响。
await checkAsync('④ 跨星系：判缺，反方向记录不得当几何用（approximated 缺席）', async f => {
  prepareEnvironment({ graph: { natural: [['XX-201', 'YY-301']] } });
  dispatchTransit('YY-301a', 'XX-201a', 77_000_000, 4000);
  expectExact(
    f,
    '夹具：反方向同星系记录已就位（会被近似的查表键命中）',
    stlSegmentsStore.getSameSystem('YY-301a', 'XX-201a')?.transit?.distanceKm,
    77_000_000,
  );
  expectExact(
    f,
    '夹具：反方向航线级记录（服务于反方向，不影响正方向）',
    stlSegmentsStore.getRoute('YY-301a', 'XX-201a')?.distanceKm,
    77_000_000,
  );
  expectExact(
    f,
    '夹具：正方向仍无任何记录',
    stlSegmentsStore.getRoute('XX-201a', 'YY-301a'),
    undefined,
  );
  const est = await run('XX-201a', ['YY-301a']);
  expectExact(f, '段数', est.legs.length, 2);
  expectExact(f, 'est.ok', est.ok, false);
  expectExact(f, 'approximatedLegs（近似只能用于系内）', est.approximatedLegs, 0);
  // 段0（正方向，缺记录）→ 判缺；查表键本可命中反方向同星系记录，但系内守卫必须拦住它。
  const forward = est.legs[0];
  expectExact(f, '段0.ok', forward.ok, false);
  expectExact(f, '段0.error', forward.error, '缺原生 STL 段记录');
  expectExact(f, '段0.approximated', forward.approximated, undefined);
  expectExact(f, '段0.hours', forward.hours, 0);
  expectExact(f, '段0.arriveAtMs === departAtMs', forward.arriveAtMs, forward.departAtMs);
  expectExact(f, '段0.metrics', forward.metrics, undefined);
  expectTextIncludes(
    f,
    '段0 成因指向未下发',
    forward.missingInputs?.[0],
    '未为该航线下发原生 STL 段记录',
  );
  expectCondition(
    f,
    '段0 成因不含系内归因',
    forward.missingInputs?.[0].includes('系内飞行') === false,
    '不含「系内飞行」',
    String(forward.missingInputs?.[0]),
  );
  // 段1（反方向）有自己方向的航线级记录 → 正常算出（**不是**近似路径）。
  const backward = est.legs[1];
  expectExact(f, '段1.ok', backward.ok, true);
  expectExact(f, '段1.approximated（有原生记录就不该标近似）', backward.approximated, undefined);
  expectExact(f, '段1.metrics.routeKm（反方向原生记录）', backward.metrics?.routeKm, 77_000_000);
  expectExact(f, '段1.metrics.stlRecorded', backward.metrics?.stlRecorded, true);
  // 系内转移段速度改用 BTF 直采常数 STL_INTRA_TRANSIT_SPEED_KM_S = 27,512
  // ⇒ 77M km 时长 = 77M / (27512 × 3600) ≈ 0.7774h；FTL 部分不变。
  //   当前实机输出 3.196893495447173h（STL = 0.777h + FTL = 2.420h）。
  expectExact(f, '段1.hours', backward.hours, 3.196893495447173);
  expectClose(
    f,
    '段1.hours 与真实 computeFuelOption 复算一致',
    backward.hours,
    computeFuelOption(
      shipPerformanceFor(SHIP),
      backward.metrics,
      backward.option.fuel,
      backward.option.reactor,
      NO_PRICES,
    ).totalHours,
    1e-12,
  );
  expectExact(f, 'totalHours（只累加 ok 段）', est.totalHours, 3.196893495447173);
  // 交叉验证：这条航线确实是跨星系（有跳 → natPc > 0），且正方向所有记录表都缺几何。
  const metrics = routeMetrics(planRoutes('XX-201a', 'YY-301a').natural);
  expectCondition(f, '夹具是跨星系（natPc > 0）', metrics.natPc > 0, '>0', String(metrics.natPc));
  expectExact(f, 'natPc', metrics.natPc, 5);
  expectExact(f, 'natJumpCount', metrics.natJumpCount, 1);
  expectExact(f, '正方向 stlDistanceKm', metrics.stlDistanceKm, undefined);
  expectExact(f, '正方向 stlRecorded', metrics.stlRecorded, false);
});

// ---- ⑤ 近似不得掩盖残缺：几何可近似、罐仍缺 → 仍判缺 ----
await checkAsync('⑤ 系内 + 只有反方向记录 + 罐容量缺失 → 仍判缺（近似不掩盖残缺）', async f => {
  prepareEnvironment({ tank: 0 });
  dispatchTransit('ZZ-101i', 'ZZ-101h', REV_KM, 3000);
  const perfNoTank = shipPerformanceFor(SHIP);
  expectExact(f, '夹具：蓝图无罐 → perf.stlFuelCapacity', perfNoTank.stlFuelCapacity, undefined);
  const est = await run('ZZ-101h', ['ZZ-101i']);
  const leg = est.legs[0];
  expectExact(f, '段0.ok', leg.ok, false);
  expectExact(f, '段0.error', leg.error, '缺原生 STL 段记录');
  expectExact(f, '段0.missingInputs 条数（只剩罐）', leg.missingInputs?.length, 1);
  expectExact(f, '段0.missingInputs[0]', leg.missingInputs?.[0], 'STL 罐容量（飞船蓝图性能）');
  expectCondition(
    f,
    '几何成因已被近似消掉（只剩罐成因）',
    leg.missingInputs?.length === 1 && leg.missingInputs[0].includes('轨道距离') === false,
    '1 条且不含「轨道距离」',
    String(leg.missingInputs?.[0]),
  );
  expectExact(f, '段0.hours', leg.hours, 0);
  expectExact(f, '段0.arriveAtMs === departAtMs', leg.arriveAtMs, leg.departAtMs);
  // 没算出时长 → 不得标注近似（标注了会让面板显示一个不存在的近似时长）。
  expectExact(f, '段0.approximated', leg.approximated, undefined);
  expectExact(f, '段0.metrics', leg.metrics, undefined);
  expectExact(f, '段0.option', leg.option, undefined);
  expectExact(f, 'approximatedLegs', est.approximatedLegs, 0);
  expectExact(f, 'est.ok', est.ok, false);
  expectExact(f, 'totalHours', est.totalHours, 0);
});

// ⑤ 对照：同一夹具换回有罐蓝图 → 同一段算出时长（证明差异只因罐，不是因为几何还缺）。
await checkAsync('⑤ 对照：同夹具有罐蓝图 → 同一段算出近似时长', async f => {
  prepareEnvironment();
  const est = await run('ZZ-101h', ['ZZ-101i']);
  // 系内转移段速度改用 BTF 直采常数 STL_INTRA_TRANSIT_SPEED_KM_S = 27,512
  // ⇒ 55M km 时长 = 55M / (27512 × 3600) ≈ 0.5553h。
  expectExact(f, '段0.ok', est.legs[0].ok, true);
  expectExact(f, '段0.hours', est.legs[0].hours, 0.5553132370521147);
  expectExact(f, '段0.approximated.kind', est.legs[0].approximated?.kind, 'reverse-record');
});

// ---- ⑥ elapsedMs 只推进 ok 段（段0 可算 / 段1 判缺 / 段2 可算）----
await checkAsync('⑥ 三段链：段1 判缺不推进时刻，totalHours 只累加 ok 段', async f => {
  prepareEnvironment();
  // 段0（e→f）有前向记录；段1（f→g）无任何记录；段2（g→e）有前向记录。
  dispatchTransit('ZZ-101e', 'ZZ-101f', 30_000_000, 1800);
  dispatchTransit('ZZ-101g', 'ZZ-101e', 42_000_000, 2500);
  const est = await run('ZZ-101e', ['ZZ-101f', 'ZZ-101g']);
  expectExact(f, '段数', est.legs.length, 3);
  expectExact(f, '段0.ok', est.legs[0].ok, true);
  expectExact(f, '段1.ok', est.legs[1].ok, false);
  expectExact(f, '段2.ok', est.legs[2].ok, true);
  // 系内转移段速度改用 BTF 直采常数 STL_INTRA_TRANSIT_SPEED_KM_S = 27,512
  // ⇒ 段0（30M km）= 0.3029h、段2（42M km）= 0.4241h。
  expectExact(f, '段0.hours', est.legs[0].hours, 0.30289812930115345);
  expectExact(f, '段1.hours', est.legs[1].hours, 0);
  expectExact(f, '段2.hours', est.legs[2].hours, 0.42405738102161483);
  // 段1 的出发时刻 = 起点 + 段0 时长（段0 到站时刻）；段1 不推进。
  expectExact(f, '段1.departAtMs', est.legs[1].departAtMs, T0 + 0.30289812930115345 * 3600000);
  expectExact(f, '段1.arriveAtMs === departAtMs', est.legs[1].arriveAtMs, est.legs[1].departAtMs);
  // 段2 的出发时刻 = 段1 的出发时刻（判缺段贡献 0ms）。
  expectExact(
    f,
    '段2.departAtMs === 段1.departAtMs',
    est.legs[2].departAtMs,
    est.legs[1].departAtMs,
  );
  expectExact(
    f,
    '段2.arriveAtMs',
    est.legs[2].arriveAtMs,
    est.legs[2].departAtMs + 0.42405738102161483 * 3600000,
  );
  expectExact(f, 'totalHours（段0 + 段2）', est.totalHours, 0.7269555103227683);
  expectExact(f, 'est.ok（含判缺段）', est.ok, false);
  expectExact(f, 'approximatedLegs', est.approximatedLegs, 0);
  // 负向：推进量是**模型时长**，不是段0 原生段时长（1800s = 0.5h）—— 记录口径会把时长钉死。
  expectCondition(
    f,
    '段1 出发时刻 ≠ 起点 + 原生段时长 1800s',
    est.legs[1].departAtMs !== T0 + 1800 * 1000,
    `≠ ${T0 + 1800 * 1000}`,
    String(est.legs[1].departAtMs),
  );
  expectCondition(
    f,
    '段1 出发时刻 < 起点 + 原生段时长',
    est.legs[1].departAtMs < T0 + 1800 * 1000,
    `< ${T0 + 1800 * 1000}`,
    String(est.legs[1].departAtMs),
  );
});

// ---- 汇总 ----
console.log(
  '\n口径摘要（全部来自真实模型，非断言常数）：' +
    `系内转移段速度 = STL_INTRA_TRANSIT_SPEED_KM_S = 27512 km/s（BTF 直采实测，与 f/距离无关，2026-09-24 标定）` +
    `⇒ 55M km → 0.55531h、40M km → 0.40386h、30M km → 0.30290h、42M km → 0.42406h（与距离线性一致）；` +
    `燃料 0.98×3500×min(f,0.5) = 171.5u（f=0.05，平衡退化时选中）。`,
);
console.log(`\nPASS ${summary.pass}/${summary.pass + summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
