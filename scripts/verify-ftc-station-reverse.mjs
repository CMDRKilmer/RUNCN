// 「星系 id → 空间站 id 反查」（成因② 修复，任务 A）回归脚本 —— 带退出码，可自动判定成败。
//
// 背景（2026-09-23）：ZV-307a → ZV-307 这条航线曾永远拿不到原生 STL 段记录，有两个独立成因：
//   ① 系内飞行（同一星系）：段结构是「转移（TRANSIT）」（实测用户 SFC 原生计划
//      ZV-307a → ZV-307/Antares Station = 单段 101,655,808 km），服务器计划**没有**
//      DEPARTURE/APPROACH 段。**2026-09-23 本轮起 recordStlSegments 会记录 TRANSIT 段**
//      （段名/字段已核实：`SegmentType` 含 'TRANSIT'、字段就是 `FlightSegment.stlDistance`）
//      → 系内航线有原生几何了。该段的燃料/时长口径**已标定**（2026-09-23，BTF 受控数据：
//      燃料 = 0.98×罐×min(f,0.5)、时长 = d/v_转移，见 fuel-model.ts 的「系内转移段标定」块）
//      → 拿到记录即可算、可写滑块；`missingModelInputs` 对系内只剩「记录未到」与「罐容量缺失」。
//      ⚠️ 2026-09-23 复核：这与勾选「使用跃迁点」**无关**
//      （勾选不改变系内航线的路程），旧文案的「取消勾选改走直飞」是错误归因且无效，已删。
//   ② **SFC 的目的地框把空间站目的地规范化成所属星系 id**（ANT → ZV-307，见
//      prun-ui/utils/select-address.ts 与 FLEET/ChainView.vue），而服务器写记录的键用的是
//      **真实天体 id**（真实导出键 ZV-307A|ANT）→ 查表键错配，5930 条记录里天体侧命中
//      星系 id 的 = **0 条**。本条**已修**（用户本轮拍板只修这一条）。
//
// 修复：查表前把「本身就是星系 id」的分量反查成**唯一**空间站 id（数据源 =
// public/json/stations.json 的 `s` 反向索引 + 游戏内 stationsStore；合并后候选恰好 1 个才反查
// —— 0/≥2 个一律拒绝，宁可不写也不猜）。反查**只作用于记录查表键**，不改
// PlannedRoute.fromBody/toBody 的对外语义（fetchPlanetEnv / FTC.vue 的原生计划匹配依赖它）。
//
// 本脚本锁定的行为契约：
//   ① 反查能力：ZV-307 → ANT（唯一）；不是星系 id 的输入不反查；候选 ≥2 时拒绝反查；
//   ② 命中：合成记录键 ZV-307A|ANT（数值取自面板「模型估算」行 68.0562M + 33.6491M）→
//      routeMetrics('ZV-307a' → 'ZV-307') 得 stlDistanceKm = 101.7053M，且 toBody 仍是
//      'ZV-307'（反查只改查表键）；无记录时仍是 undefined（不回退）+ 判缺；
//   ③ 全链路：computeFtcPlan('ZV-307a' → 'ZV-307'，不勾跃迁点) → best.fuel = 0.2、
//      stlFuel ≈ 579.72u、写入滑块；无记录 → incomplete + 不写滑块 + 文案写明「已按
//      ZV-307 → ANT 反查」；反查被拒绝（同星系多站）→ incomplete + 文案写明「无法反查出
//      唯一空间站」。
//
// 用法：node scripts/verify-ftc-station-reverse.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
// 局限：几何侧 store（stlSegmentsStore/stationsStore/buffers）走替身
// （scripts/lib/ftc-geometry-stub.mjs），但 route-planner / route-model / ftc-compute 与
// system-bodies 的记录逻辑都是**真实实现**；SFC 磁贴的 DOM 接线在 Node 里不可加载，
// 由真实日志 + 代码审查覆盖。stations.json 的 6 站 6 星系一一对应是**数据事实**，不在本脚本
// 覆盖范围内（内置 JSON 由 scripts/build-station-data.mjs 生成）。
import { register } from 'node:module';
import { DEPART_KM, APPROACH_KM } from './lib/ftc-node-fixtures.mjs';

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
function expectJson(failures, label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures.push(`expected=${e} actual=${a} (${label})`);
  }
}

// ---- 浏览器侧全局替身（真实 system-bodies 的持久化需要 localStorage/window/fetch/ref）----
globalThis.ref = value => ({ value });
globalThis.config = {
  url: {
    stlSegments: 'https://stub.invalid/stl-segments.json',
    planetEnv: 'https://stub.invalid/planet-env.json',
  },
};
globalThis.fetch = async () => ({ json: async () => ({}) });
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
};

// route-planner / route-model / ftc-compute 的浏览器侧依赖走替身；三者保留真实实现。
register('./lib/ftc-geometry-loader.mjs', import.meta.url);

const api = await import('../src/infrastructure/prun-api/data/api-messages.ts');
const { stlSegmentsStore } = await import('../src/infrastructure/prun-api/data/system-bodies.ts');
const { planRoutes, routeMetrics } = await import('../src/features/XIT/FTC/route-planner.ts');
const { lookupStationInSystem } = await import('../src/features/XIT/FTC/route-model.ts');
const { computeFtcPlan } = await import('../src/features/XIT/FTC/ftc-compute.ts');
const stub = await import('./lib/ftc-geometry-stub.mjs');

// ---- 合成飞行计划（键 ZV-307A|ANT；真实系内计划只有「转移」段，此结构为合成）----
const T0 = 1_700_000_000_000;
const systemLine = id => ({ type: 'SYSTEM', entity: { naturalId: id, name: id } });
const bodyLine = (type, id) => ({ type, entity: { naturalId: id, name: id } });
const planetAddress = (system, planet) => ({
  lines: [systemLine(system), bodyLine('PLANET', planet)],
});
const stationAddress = (system, station) => ({
  lines: [systemLine(system), bodyLine('STATION', station)],
});
const starAddress = system => ({ lines: [systemLine(system)] });
const segment = (type, origin, destination, stlDistance, durationMs) => ({
  type,
  origin,
  destination,
  departure: { timestamp: T0 },
  arrival: { timestamp: T0 + durationMs },
  stlDistance,
  stlFuelConsumption: null,
  transferEllipse: null,
  ftlDistance: null,
  ftlFuelConsumption: null,
  damage: 0,
});
const sameSystemPlan = {
  missionId: 'STUB-MISSION-SAME',
  segments: [
    segment(
      'DEPARTURE',
      planetAddress('ZV-307', 'ZV-307a'),
      starAddress('ZV-307'),
      DEPART_KM,
      4481000,
    ),
    segment(
      'APPROACH',
      starAddress('ZV-307'),
      stationAddress('ZV-307', 'ANT'),
      APPROACH_KM,
      1345000,
    ),
  ],
};

const NO_PRICES = { stlPrice: 0, ftlPrice: 0, timeValue: 0 };
const runCompute = (from, to, useGateway) =>
  computeFtcPlan({
    shipRegistration: 'STUB-01',
    from,
    to,
    useGateway,
    browse: false,
    ...NO_PRICES,
  });

// 每条 check 自带环境（不依赖上一条的残留状态：单跑/乱序都不漂移）。
// 真实记录链：合成计划派发给**真实** system-bodies → 真实键（天体侧 ZV-307A|ANT）入表；
// 再把这条真实记录（含真实距离/时长）桥接进几何替身的同星系表 —— 因为
// route-planner 查的是替身 stlSegmentsStore（真实 store 的内容来自服务器消息，由
// verify-ftc-geometry-source.mjs 覆盖），这样用例驱动的仍是「真实记录 → 真实查表逻辑」。
function prepareComplete() {
  stub.stubClearStlRecords();
  stub.stubSetRuntimeStations([]);
  stub.stubSetShip(stub.STUB_SHIP);
  stub.stubSetBlueprint(stub.stubBlueprint());
  stub.stubResetWrites();
  api.dispatch({ type: 'SHIP_FLIGHT_MISSION', data: sameSystemPlan });
  const recorded = stlSegmentsStore.getSameSystem('ZV-307A', 'ANT');
  stub.stubSetSameSystemRecord('zv-307a', 'ANT', recorded);
}

// ---- ① 反查能力与守卫 ----
check('① 反查能力：ZV-307 → ANT（唯一）；非星系 id 不反查', f => {
  stub.stubSetRuntimeStations([]);
  expectJson(f, 'ZV-307 反查结果', lookupStationInSystem('ZV-307'), {
    systemId: 'ZV-307',
    station: 'ANT',
    candidates: ['ANT'],
  });
  // 大小写/空白归一。
  expectExact(f, '小写输入同样命中', lookupStationInSystem(' zv-307 ')?.station, 'ANT');
  // 不是星系 id 的输入（天体/空串）不在反查范围（route-planner 只在 isSystemId 时调用）。
  expectExact(f, '空间站 id 无候选', lookupStationInSystem('ANT')?.station, undefined);
  expectExact(f, '空串返回 undefined', lookupStationInSystem('  '), undefined);
});

check('① 守卫：同星系多站（内置 ANT + 运行时 ZZZ）→ 拒绝反查（宁可不写也不猜）', f => {
  stub.stubSetRuntimeStations([{ naturalId: 'ZZZ', systemId: 'ZV-307' }]);
  const lookup = lookupStationInSystem('ZV-307');
  expectExact(f, '拒绝反查（station undefined）', lookup?.station, undefined);
  expectJson(f, '候选列出全部（诊断用）', lookup?.candidates, ['ANT', 'ZZZ']);
  // 负对照：候选回到 1 个（运行时站点清空）→ 又能反查。
  stub.stubSetRuntimeStations([]);
  expectExact(f, '清空运行时站点后恢复', lookupStationInSystem('ZV-307')?.station, 'ANT');
});

// ---- ② routeMetrics：命中 / 不命中 ----
const routeFor = (from, to) => planRoutes(from, to).natural;

check('② 有同星系记录（ZV-307A|ANT，68.0562M + 33.6491M）→ 反查命中，d = 101.7053M', f => {
  prepareComplete();
  // 记录键由真实 system-bodies 从真实计划里写出 = 天体侧（ZV-307A|ANT）。
  expectExact(
    f,
    '真实记录键是天体侧',
    stlSegmentsStore.getSameSystem('ZV-307a', 'ANT')?.depart?.distanceKm,
    DEPART_KM,
  );
  // 用被 SFC 规范化后的星系 id 直接查表仍命不中（成因② 的键错配本身没变）。
  expectExact(
    f,
    '星系 id 直接查表命不中',
    stlSegmentsStore.getSameSystem('ZV-307a', 'ZV-307'),
    undefined,
  );
  const route = routeFor('ZV-307a', 'ZV-307');
  const metrics = routeMetrics(route);
  expectExact(f, 'stlDistanceKm', metrics.stlDistanceKm, 101705300);
  expectExact(f, 'departKm', metrics.departKm, DEPART_KM);
  expectExact(f, 'approachKm', metrics.approachKm, APPROACH_KM);
  expectExact(f, 'stlRecorded', metrics.stlRecorded, true);
  expectExact(f, '记录查表键（反查后）', metrics.fromLookup, 'ZV-307a');
  expectExact(f, '目标侧查表键（反查后）', metrics.toLookup, 'ANT');
  // ★ 对外语义未变：fromBody/toBody 仍是输入原文（fetchPlanetEnv / 原生计划匹配依赖它）。
  expectExact(f, 'fromBody 仍是输入原文', metrics.fromBody, 'ZV-307a');
  expectExact(f, 'toBody 仍是输入原文（星系 id）', metrics.toBody, 'ZV-307');
  expectExact(f, 'toIsSystem', metrics.toIsSystem, true);
  expectExact(f, 'fromIsSystem', metrics.fromIsSystem, false);
  expectJson(f, '反查诊断', metrics.stationReverse, [
    { systemId: 'ZV-307', station: 'ANT', candidates: ['ANT'] },
  ]);
});

check('② 无原生记录 → 仍全 undefined（不回退），反查诊断仍给出（供文案用）', f => {
  stub.stubClearStlRecords();
  stub.stubSetRuntimeStations([]);
  const metrics = routeMetrics(routeFor('ZV-307a', 'ZV-307'));
  expectExact(f, 'stlDistanceKm', metrics.stlDistanceKm, undefined);
  expectExact(f, 'departKm', metrics.departKm, undefined);
  expectExact(f, 'approachKm', metrics.approachKm, undefined);
  expectExact(f, '反查仍成功（键已正确，只是记录没到）', metrics.toLookup, 'ANT');
  expectExact(f, '反查诊断 station', metrics.stationReverse?.[0]?.station, 'ANT');
});

check('② 守卫生效时记录查表退回原值 → 即便记录存在也拿不到几何', f => {
  prepareComplete();
  stub.stubSetRuntimeStations([{ naturalId: 'ZZZ', systemId: 'ZV-307' }]);
  const metrics = routeMetrics(routeFor('ZV-307a', 'ZV-307'));
  expectExact(f, '不反查（查表键保持星系 id）', metrics.toLookup, 'ZV-307');
  expectExact(f, '几何拿不到', metrics.stlDistanceKm, undefined);
  expectJson(f, '诊断：暂无唯一候选', metrics.stationReverse, [
    { systemId: 'ZV-307', station: undefined, candidates: ['ANT', 'ZZZ'] },
  ]);
});

// ---- ③ 全链路：computeFtcPlan ----
await checkAsync(
  '③ 全链路（不勾跃迁点）：ZV-307a → ZV-307 变可算 → f = 0.15、写入滑块',
  async f => {
    prepareComplete();
    const out = await runCompute('ZV-307a', 'ZV-307', false);
    expectExact(f, 'ok', out.ok, true);
    expectExact(f, 'inputIncomplete', out.inputIncomplete, undefined);
    expectExact(f, 'message 无警告', out.message, '');
    expectExact(f, 'd', out.metrics?.stlDistanceKm, 101705300);
    expectExact(f, 'best.fuel', out.best?.fuel, 0.15);
    // 系内燃料 = 0.98×罐 3500×min(0.15,0.5) = 514.5u（2026-09-23 标定：与距离无关）。
    expectClose(f, 'STL 燃料（截图实参复算）', out.best?.stlFuel, 514.5, 0.5);
    expectExact(f, '滑块写入次数', stub.sliderWrites.length, 1);
    expectExact(f, '写入的燃料值', stub.sliderWrites[0]?.value, 0.15);
    // 航线键用**输入原文**（SFC 规范化后的星系 id），与记录查表键（反查后的空间站）不同。
    expectExact(f, '写入的航线键', stub.sliderWrites[0]?.key, 'STUB-01|ZV-307A|ZV-307|nat');
  },
);

let reverseMissText = '';
await checkAsync(
  '③ 系内航线无几何 → incomplete + 不写滑块 + 文案写明「已按 ZV-307 → ANT 反查」且不再承诺等下发',
  async f => {
    stub.stubClearStlRecords();
    stub.stubSetRuntimeStations([]);
    stub.stubSetShip(stub.STUB_SHIP);
    stub.stubSetBlueprint(stub.stubBlueprint());
    stub.stubResetWrites();
    const out = await runCompute('ZV-307a', 'ZV-307', false);
    const text = out.inputIncomplete?.[0] ?? '';
    reverseMissText = text;
    expectCondition(f, '报缺', text.includes('轨道距离') === true, '含「轨道距离」', text);
    expectCondition(f, '点明星系 id', text.includes('星系 id') === true, '含「星系 id」', text);
    expectCondition(
      f,
      '写明已反查',
      text.includes('已按 ZV-307 → ANT 反查') === true,
      '含「已按 ZV-307 → ANT 反查」',
      text,
    );
    // ⚠️ 断言变更记录（2026-09-23 本轮）：系内几何现在**已入库**（转移段的 stlDistance），
    // 拿到它只需生成一次计划 —— 旧断言要求文案不含「生成一次计划」（当时该操作无效，
    // 因为转移段不被消费）已不成立，改为要求给出这条**有效**操作。
    expectCondition(f, '点明系内飞行', text.includes('系内飞行') === true, '含「系内飞行」', text);
    expectCondition(
      f,
      '操作：生成一次计划（该段已是消费的几何来源）',
      text.includes('生成一次飞行计划') === true,
      '含「生成一次飞行计划」',
      text,
    );
    expectCondition(
      f,
      '不再误导「改目的地」（反查已生效）',
      text.includes('把目的地改成具体天体/空间站') === false,
      '不含「改目的地」',
      text,
    );
    expectCondition(
      f,
      '操作：手动设置',
      text.includes('手动设置燃料滑块') === true,
      '含「手动设置燃料滑块」',
      text,
    );
    expectExact(f, '未写入滑块', stub.sliderWrites.length, 0);
    expectExact(f, '未写入反应堆', stub.reactorWrites.length, 0);
  },
);
console.log(`[证据] 反查命中、但该航线的原生几何落在转移段上的文案：${reverseMissText}`);

await checkAsync(
  '③ 守卫拒绝反查（同星系多站）→ incomplete + 给出唯一有效的「改目的地」建议',
  async f => {
    prepareComplete();
    stub.stubSetRuntimeStations([{ naturalId: 'ZZZ', systemId: 'ZV-307' }]);
    stub.stubResetWrites();
    const out = await runCompute('ZV-307a', 'ZV-307', false);
    const text = out.inputIncomplete?.[0] ?? '';
    expectCondition(
      f,
      '写明无法唯一反查',
      text.includes('无法反查出唯一空间站') === true,
      '含「无法反查出唯一空间站」',
      text,
    );
    expectCondition(f, '列出候选', text.includes('ZZZ') === true, '含候选 ZZZ', text);
    // ⚠️ 断言变更记录（2026-09-23 本轮，**意图反转**）：旧断言要求文案**不含**「把目的地改成
    // 具体天体/空间站」（当时把它当成误导）。但本场景恰恰是**反查被拒**（同星系多站 ANT +
    // ZZZ，候选 ≠1，见 ①）—— 此时查表键**根本推不出来**（目标端永远是星系 id），生成计划
    // 也命不中；而玩家把目的地改成**具体天体/空间站**（如 ANT）后，记录键就是原生的
    // ZV-307A|ANT → 几何立刻可用。
    // ⇒ 「改目的地」在这里是**唯一有效**操作（implementation：fuel-model.ts 的
    // `refused.length > 0 → actions.push('把目的地改成具体天体/空间站')`），文案给出它是对的。
    // 🚫 后人勿改回去：两条分支的关键区别是「反查是否被拒」——
    //   上一个用例（reversed：候选=1，已反查、只是记录没到）必须**不含**本条建议（生成计划
    //   才有用）；本用例（refused：候选≠1）必须**含**本条建议。只留「不要误导改目的地」一句
    //   泛结论会误导实现去删掉这个分支，所以这里连同下一条负向断言一起把两条分支钉开。
    expectCondition(
      f,
      '给出唯一有效的「改目的地」建议（反查被拒 → 生成计划也命不中）',
      text.includes('把目的地改成具体天体/空间站') === true,
      '含「把目的地改成具体天体/空间站」',
      text,
    );
    expectCondition(
      f,
      '不得同时承诺「生成一次计划」（该分支下无效：查表键推不出来）',
      text.includes('生成一次飞行计划') === false,
      '不含「生成一次飞行计划」',
      text,
    );
    expectCondition(
      f,
      '点明系内转移段事实',
      text.includes('系内飞行') === true,
      '含「系内飞行」',
      text,
    );
    expectCondition(
      f,
      '操作：手动设置',
      text.includes('手动设置燃料滑块') === true,
      '含「手动设置燃料滑块」',
      text,
    );
    expectExact(f, '未写入滑块', stub.sliderWrites.length, 0);
  },
);

await checkAsync(
  '③ 系内航线：勾「使用跃迁点」与不勾选完全一致（planner 同路）→ 同样算并写滑块',
  async f => {
    prepareComplete();
    const unchecked = await runCompute('ZV-307a', 'ZV-307', false);
    const uncheckedWrites = stub.sliderWrites.length;
    prepareComplete();
    const checked = await runCompute('ZV-307a', 'ZV-307', true);
    // ⚠️ 断言变更记录（2026-09-23 本轮）：旧断言要求勾选态「点明系内飞行 + 不写滑块」
    // （`usesGatewayTransfer` 对系内一律判缺）—— 那时系内几何根本拿不到。现在系内几何来自
    // 原生「转移」（TRANSIT）段，而勾选不改变系内航线的路程（`planRoutes` 同星系两种模式都
    // 返回 natural；实测 101,655,808 km vs 直飞口径 101.7053M km，差 0.05%）→ 勾选态与
    // 不勾选态**必须走同一条路、得到同一个结果**（下面逐位比较），旧断言要求的
    // 「勾选态不写滑块」是错误归因的产物，已删除。
    expectExact(f, '不勾选：写滑块一次', uncheckedWrites, 1);
    expectExact(f, '勾选：inputIncomplete', checked.inputIncomplete, undefined);
    expectExact(f, '勾选：ok', checked.ok, true);
    expectExact(f, '勾选：best.fuel 与不勾选一致', checked.best?.fuel, unchecked.best?.fuel);
    expectExact(f, '勾选：写滑块一次', stub.sliderWrites.length, 1);
    expectExact(f, '勾选：写入的燃料值一致', stub.sliderWrites[0]?.value, unchecked.best?.fuel);
    expectExact(
      f,
      '勾选：写入的航线键（网关标志进键）',
      stub.sliderWrites[0]?.key,
      'STUB-01|ZV-307A|ZV-307|gw',
    );
  },
);

console.log(
  `\n反查证据：lookupStationInSystem('ZV-307') = ` +
    `${JSON.stringify(lookupStationInSystem('ZV-307'))}；记录键 ZV-307A|ANT → ` +
    `d = ${(DEPART_KM + APPROACH_KM) / 1e6}M km → best.fuel = 0.2`,
);
console.log(`PASS ${summary.pass}/${summary.pass + summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
