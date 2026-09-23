// FTC「结构性拿不到原生 STL 段几何」的成因回归脚本 —— 带退出码，可自动判定成败。
//
// 背景（2026-09-23 用户实机日志）：
//   [sfc-auto-fuel-settings] 推送航线给 FTC：AVI-06JVV ZV-307a → ZV-307（网关）
//   [sfc-auto-fuel-settings] 输入不完整（缺 起终点轨道距离（ZV-307a / ZV-307））：…
// 玩家另一条航线 zv-307a → ANT（同一系统）在 FTC 面板上**能**算出几何（起落 68.0562M +
// 33.6491M km —— 注意：面板标题写明「航线分段（模型估算）」，这两个数是**模型估算行**，
// 不是服务器原生值，2026-09-23 复核确认）。本脚本锁定「为什么 ZV-307a → ZV-307 永远算不出来」的两条结构性成因，
// 并锁定它们的可操作提示文案（不能只说「等服务器下发」）：
//
//   ① 目的地被游戏规范化成**星系 id**：SFC 目的地框会把空间站目的地规范化成所属星系
//      （ANT → ZV-307，见 prun-ui/utils/select-address.ts、FLEET/ChainView.vue 的注释），
//      而服务器下发的原生段记录按**实际天体/空间站 id** 键控（真实导出键 ZV-307A|ANT，
//      见 scripts/build-stl-data.mjs 的格式说明）→ 星系 id 直接查表命不中。
//      **2026-09-23 已修**（本轮）：查表前先按 stations.json / 游戏内站点把星系 id 反查为
//      **唯一**空间站 id（route-model.lookupStationInSystem + route-planner.stlRecordKeyFor，
//      守卫：候选 ≠1 一律拒绝反查）；本条成因的文案随之从「把目的地改成具体天体/空间站」
//      变为「已按 ZV-307 → ANT 反查（键已经对了），为该航线生成一次计划等服务器算完」。
//      反查的完整验收（命中/不命中/守卫/全链路）在 scripts/verify-ftc-station-reverse.mjs。
//   ② 系内飞行（同一星系）：段结构是「转移（TRANSIT）」（行星起飞/着陆另加起飞/着陆段），
//      **没有** DEPARTURE/APPROACH 段（2026-09-23 用户 SFC 原生计划实测：ZV-307a →
//      ZV-307/Antares Station = 单段 101,655,808 km / 43分59秒 / 2655 单位 STL；BTF 侧
//      HRT → VH-331g 也是「转移 + 着陆」，见 data/ftc-calibration/btf-load-sweep-2026-08-29.md）。
//      **2026-09-23 本轮变更**：段名/字段已核实（`PrunApi.SegmentType` 含 'TRANSIT'、
//      字段就是 `FlightSegment.stlDistance` —— 与离港/进近同口径），故 `recordStlSegments`
//      **现在会记录这一段**（同星系表的 `transit` 字段）→ 系内航线有**原生**几何了。
//      **同日二次变更（口径标定）**：该段的
//      燃料/时长口径已用 BTF 受控数据标定（燃料 = 2×0.49×罐×min(f,0.5)，与距离无关；
//      时长 = d/v_转移，见 fuel-model 的 STL_TRANSIT_F_SAT 上方）→ `missingModelInputs`
//      **不再因口径判缺**：拿到转移段记录即可算、可写滑块。
//      ⚠️ 是否勾选「使用跃迁点」与这条事实**无关** —— 勾选不改变系内航线的路程
//      （判据：`planRoutes` 对同星系两种模式都返回 `natural`；旧注释的「101.7053M km
//      差 0.05%」比法已作废 —— 那是已删除的自建轨道模型的估算行，不是原生值）。
//      本脚本锁定：勾选态**不**被归因为网关成因、也不出现无效操作（「取消勾选改走直飞」）；
//      还没有原生记录时给出**有效**操作（生成一次计划 —— 该段已是消费的几何来源）。
//
// 锁定的行为契约：
//   ① 键空间事实：内置/导出数据里「天体侧」分量（depart 第一分量、approach 第二分量）
//      从不出现星系 id（只出现行星/空间站 id，另有 '*' 通配）；
//   ② TRANSIT 结构的计划派发给**真实** system-bodies 后：同星系表 +1（键 出发天体|目标天体），
//      整段路程记在独立字段 `transit`（**不**伪造离港/进近），跨星系两张表一动未动；
//   ③ 合成的同星系计划（带 DEPARTURE/APPROACH，**不是**真实观测形状）写出的键是天体侧
//      （ZV-307A|ANT）；用被规范化后的星系 id 查表命不中；同键两种结构并存（合并不覆盖）；
//   ④ 真实 planRoutes/routeMetrics：ZV-307a → ZV-307 是**同星系**航线（legs 为空），
//      「使用跃迁点」在 planner 里不改变选中的路线（同星系无跳 → gateway 候选恒为空）
//      —— 成因② 是模型外的事实（由游戏实测锁定），不是 planner 的 gateway 分支造成的；
//      metrics 给出 toIsSystem = true / fromIsSystem = false（成因② 的可判定信号）、
//      toLookup = 反查后的查表键（无站点数据时等于原值）、stationReverse = 反查诊断。
//   ⑤ 真实 computeFtcPlan 全链路：两类成因各给出**可操作**文案且都不写滑块；
//      有原生记录时（d = 101.7053M km）→ best.fuel = 0.15 并正常写入滑块。
//   ⑥ 同星系表的 `transit`（真实系内结构）→ `routeMetrics` 给出整段原生路程
//      （stlDistanceKm = transitKm，不伪造离港/进近），且口径已标定 →
//      真实 computeFtcPlan **算出并写入滑块**（燃料 = 0.98×罐×min(f,0.5)，与 d 无关；
//      时长 = d/v_转移）。
//   ⑦ 系内 + 星系 id 目的地：有转移段记录 → 直接可算并写滑块；无记录 → 文案给
//      「生成一次计划」且**不含**已过时的「口径未标定」。
//
// 用法：node scripts/verify-ftc-gap-guidance.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
// 局限：DOM 接线（SFC 写滑块）在 Node 里不可加载；服务器真实下行消息的地址形状由
// 合成计划 + 真实导出键（ZV-307A|ANT）双重锚定，仍属「与实测一致」的推断。
import { register } from 'node:module';
import { readFileSync } from 'node:fs';
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
function expectCondition(failures, label, ok, expectedText, actualText) {
  if (!ok) {
    failures.push(`expected=${expectedText} actual=${actualText} (${label})`);
  }
}
function expectClose(failures, label, actual, expected, tolerance) {
  if (!(typeof actual === 'number' && Math.abs(actual - expected) <= tolerance)) {
    failures.push(`expected=${expected} ±${tolerance} actual=${actual} (${label})`);
  }
}

// ---- ① 键空间事实（读真实数据文件，不依赖替身）----
const bundled = JSON.parse(readFileSync('public/json/stl-segments.json', 'utf8'));
const starIds = new Set(
  Object.keys(JSON.parse(readFileSync('public/json/star-connections.json', 'utf8'))),
);
const bodySideOf = (table, entry) =>
  table === 'depart' ? entry[0].split('|')[0] : entry[0].split('|')[1];
const bodySideHitsStar = [];
let bodySideTotal = 0;
for (const table of ['depart', 'approach']) {
  for (const entry of bundled[table] ?? []) {
    const side = bodySideOf(table, entry);
    bodySideTotal++;
    if (side !== '*' && starIds.has(side.toUpperCase())) {
      bodySideHitsStar.push(`${table}:${entry[0]}`);
    }
  }
}
const starSideOfZV307 = (bundled.depart ?? []).filter(
  x => x[0].split('|')[1].toUpperCase() === 'ZV-307',
).length;

console.log(
  `[证据] 内置原生段：depart ${(bundled.depart ?? []).length} + approach ` +
    `${(bundled.approach ?? []).length} 条；星系 id 总数 ${starIds.size}；` +
    `「天体侧」分量命中星系 id 的条目 ${bodySideHitsStar.length}/${bodySideTotal}；` +
    `ZV-307 作为**星系侧**出现 ${starSideOfZV307} 次（是已知星系）。`,
);

check('① 数据事实：原生段的「天体侧」分量从不出现星系 id（只有天体/空间站 + * 通配）', f => {
  expectCondition(
    f,
    '命中数',
    bodySideHitsStar.length === 0,
    '0 条（星系 id 只出现在星系侧）',
    bodySideHitsStar.slice(0, 5).join(', '),
  );
  expectCondition(f, '样本量足够', bodySideTotal > 1000, '>1000 条', String(bodySideTotal));
  expectCondition(
    f,
    'ZV-307 是已知星系',
    starIds.has('ZV-307') && starSideOfZV307 > 0,
    'ZV-307 ∈ 星系 id 且出现在星系侧',
    `hasZV307=${starIds.has('ZV-307')} starSideCount=${starSideOfZV307}`,
  );
});

// ---- 浏览器侧替身（真实 system-bodies.ts 需要 localStorage/window/fetch/ref/config）----
globalThis.ref = value => ({ value });
globalThis.config = {
  url: {
    stlSegments: 'https://stub.invalid/stl-segments.json',
    planetEnv: 'https://stub.invalid/planet-env.json',
  },
};
globalThis.fetch = async url => ({
  json: async () => (String(url).includes('stl-segments') ? {} : {}),
});
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
};

register('./lib/ftc-geometry-loader.mjs', import.meta.url);

const api = await import('../src/infrastructure/prun-api/data/api-messages.ts');
const { stlSegmentsStore } = await import('../src/infrastructure/prun-api/data/system-bodies.ts');
const { planRoutes, routeMetrics } = await import('../src/features/XIT/FTC/route-planner.ts');
const { computeFtcPlan } = await import('../src/features/XIT/FTC/ftc-compute.ts');
const { missingModelInputs } = await import('../src/features/XIT/FTC/fuel-model.ts');
const stub = await import('./lib/ftc-geometry-stub.mjs');

// ---- 合成飞行计划（与 verify-ftc-geometry-source.mjs 同一条实测键 ZV-307A|ANT）----
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

//      合成计划（非真实观测：真实系内计划只有「转移」段）。
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

// 系内转移（TRANSIT）结构：段结构 = 转移（+ 起飞/着陆，取决于天体类型）。
// 距离/耗时取自 BTF 实测（HRT → VH-331g，520M km / 12h29m）；用户 SFC 原生计划
// （ZV-307a → ZV-307/Antares Station）实测为**单段**转移 101,655,808 km。
const inSystemGatewayPlan = {
  missionId: 'STUB-MISSION-GW',
  segments: [
    segment(
      'TRANSIT',
      planetAddress('ZV-307', 'ZV-307a'),
      stationAddress('ZV-307', 'ANT'),
      520267630,
      44940000,
    ),
    segment('LANDING', starAddress('ZV-307'), stationAddress('ZV-307', 'ANT'), 4779, 349000),
  ],
};

const counts = () => ({
  depart: stlSegmentsStore.departureCount,
  approach: stlSegmentsStore.approachCount,
  sameSystem: stlSegmentsStore.sameSystemCount,
});

// ---- ② 系内转移（TRANSIT）计划：写入同星系表的 `transit`（整段原生路程）----
const beforeGateway = counts();
api.dispatch({ type: 'SHIP_FLIGHT_MISSION', data: inSystemGatewayPlan });
const transitRec = stlSegmentsStore.getSameSystem('zv-307a', 'ANT');

check(
  '② 系内转移（TRANSIT）计划 → 写入同星系记录（键 出发天体|目标天体，整段路程进 transit）',
  f => {
    // ⚠️ 断言变更记录（2026-09-23 本轮）：本用例原来断言「一条都不写」（当时 TRANSIT 段不被
    // 记录，系内航线结构性拿不到几何）。段名/字段核实后改为记录该段 → 断言随之反转。
    expectExact(f, '同星系表 +1', counts().sameSystem, beforeGateway.sameSystem + 1);
    expectExact(f, '转移段距离（原生 stlDistance）', transitRec?.transit?.distanceKm, 520267630);
    expectExact(f, '转移段时长（秒）', transitRec?.transit?.seconds, 44940);
    // 转移段是**整段**路程：不得塞进离港/进近（那是两段拆分的语义 → 会伪造出不存在的段）。
    expectExact(f, '未伪造离港段', transitRec?.depart, undefined);
    expectExact(f, '未伪造进近段', transitRec?.approach, undefined);
    // 同计划里的 LANDING 段不是模型消费的几何来源：不得进任何表。
    expectExact(f, '离港表未被污染', counts().depart, beforeGateway.depart);
    expectExact(f, '进近表未被污染', counts().approach, beforeGateway.approach);
  },
);

// ---- ③ 同星系直飞计划：键写在天体/空间站侧；星系 id 查表命不中 ----
api.dispatch({ type: 'SHIP_FLIGHT_MISSION', data: sameSystemPlan });
const recorded = stlSegmentsStore.getSameSystem('zv-307a', 'ANT');

check('③ 同星系直飞 → 键为 (出发天体, 目标空间站) = ZV-307A|ANT（天体侧）', f => {
  expectCondition(f, '记录存在', recorded !== undefined, '同星系记录', String(recorded));
  expectExact(f, '离港距离', recorded?.depart?.distanceKm, DEPART_KM);
  expectExact(f, '进近距离', recorded?.approach?.distanceKm, APPROACH_KM);
  // ⚠️ 同一条航线先后出现两种段结构时**合并**（互补不互覆）：②的转移段仍在。
  expectExact(f, '②的转移段记录未被覆盖', recorded?.transit?.distanceKm, 520267630);
  expectExact(
    f,
    '同星系表 +1（同键，条数不变）',
    counts().sameSystem,
    beforeGateway.sameSystem + 1,
  );
});
check('③ 用被规范化成星系 id 的目的地查表 → 命不中（查表键错配）', f => {
  expectExact(f, 'ZV-307A|ZV-307', stlSegmentsStore.getSameSystem('ZV-307a', 'ZV-307'), undefined);
});

// ---- ④ 真实 planRoutes / routeMetrics：这条航线在 planner 里是什么 ----
stub.stubClearStlRecords();
const sameSystemRoutes = planRoutes('ZV-307a', 'ZV-307');
const sameSystemRoute = sameSystemRoutes.natural;
const sameSystemMetrics = routeMetrics(sameSystemRoute);
const antRoutes = planRoutes('ZV-307a', 'ANT');
const antMetrics = routeMetrics(antRoutes.natural);

console.log(
  `[证据] planRoutes('ZV-307a','ZV-307') → label=${sameSystemRoute?.label} ` +
    `systemIds=[${sameSystemRoute?.systemIds.join(', ')}] legs=${sameSystemRoute?.legs.length} ` +
    `fromBody=${sameSystemRoute?.fromBody} toBody=${sameSystemRoute?.toBody} ` +
    `gateway=${sameSystemRoutes.gateway === undefined ? 'undefined（与 natural 同路线，被丢弃）' : '存在'}`,
);
console.log(
  `[证据] routeMetrics(ZV-307a → ZV-307) → stlDistanceKm=${sameSystemMetrics.stlDistanceKm} ` +
    `departKm=${sameSystemMetrics.departKm} approachKm=${sameSystemMetrics.approachKm} ` +
    `toIsSystem=${sameSystemMetrics.toIsSystem} fromIsSystem=${sameSystemMetrics.fromIsSystem}`,
);

check('④ toBody 恒为输入原文（不是 undefined）：终点 ZV-307 是星系 id，不是天体', f => {
  expectExact(f, 'fromBody', sameSystemRoute?.fromBody, 'ZV-307a');
  expectExact(f, 'toBody', sameSystemRoute?.toBody, 'ZV-307');
  expectExact(f, '同星系（legs 为空）', sameSystemRoute?.legs.length, 0);
  expectExact(f, 'fromIsSystem', sameSystemMetrics.fromIsSystem, false);
  expectExact(f, 'toIsSystem', sameSystemMetrics.toIsSystem, true);
  expectExact(f, 'ZV-307a → ANT 的 toIsSystem', antMetrics.toIsSystem, false);
});
check('④ 「使用跃迁点」在 planner 里不改变路线（同星系无跳 → gateway 候选恒为空）', f => {
  expectExact(f, 'gateway 候选', sameSystemRoutes.gateway, undefined);
  // computeFtcPlan 的选择式：useGateway ? (gateway ?? natural) : natural → 恒为 natural。
  const chosen = true
    ? (sameSystemRoutes.gateway ?? sameSystemRoutes.natural)
    : sameSystemRoutes.natural;
  expectExact(f, '勾选后选中的路线', chosen?.label, '自然');
  expectExact(f, '勾选后路线与不勾选相同', chosen, sameSystemRoutes.natural);
});
check('④ 无原生记录 → 几何全 undefined（无任何回退）', f => {
  expectExact(f, 'stlDistanceKm', sameSystemMetrics.stlDistanceKm, undefined);
  expectExact(f, 'departKm', sameSystemMetrics.departKm, undefined);
  expectExact(f, 'approachKm', sameSystemMetrics.approachKm, undefined);
});

// ---- ⑤ 真实 computeFtcPlan 全链路：三类成因的可操作文案 + 不写滑块 ----
stub.stubSetShip(stub.STUB_SHIP);
stub.stubSetBlueprint(stub.stubBlueprint());
const runCompute = (from, to, useGateway) =>
  computeFtcPlan({ shipRegistration: 'STUB-01', from, to, useGateway, browse: false });

stub.stubClearStlRecords();
stub.stubResetWrites();
const gwIncomplete = await runCompute('ZV-307a', 'ZV-307', true);

check('⑤ 成因①+②（勾「使用跃迁点」+ 星系 id 目的地）→ 两条成因都点明且可操作', f => {
  const text = gwIncomplete.inputIncomplete?.[0] ?? '';
  expectCondition(f, '报缺', text.includes('轨道距离') === true, '含「轨道距离」', text);
  expectCondition(f, '点明系内飞行', text.includes('系内飞行') === true, '含「系内飞行」', text);
  expectCondition(f, '点明星系 id', text.includes('星系 id') === true, '含「星系 id」', text);
  // ⚠️ 断言变更记录（2026-09-23 本轮）：旧断言要求文案含「取消勾选」（建议改走直飞）——
  // 该操作**无效**（系内计划永远是「转移」段，见 guides/how-to-collect-btf-data.md），
  // 文案改为「勾选/取消不改变系内航线的路程，换模式无用」+ 手动设置。
  expectCondition(
    f,
    '写明换模式无用（不再建议取消勾选）',
    text.includes('不改变系内航线的路程') === true && text.includes('取消勾选') === false,
    '含「不改变系内航线的路程」且不含「取消勾选」',
    text,
  );
  expectCondition(
    f,
    '操作：已按反查后的键查表（反查取代了旧的「改目的地」）',
    text.includes('已按 ZV-307 → ANT 反查') === true,
    '含「已按 ZV-307 → ANT 反查」',
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
  // ⚠️ 断言变更记录（2026-09-23）：原来断言文案含「具体天体/空间站」（要求玩家改目的地），
  // 反查上线后这条航线**不再需要**改目的地 —— 文案改为「已按 ZV-307 → ANT 反查 + 生成一次
  // 计划」，故断言同步替换（否则会把更正确的文案判为失败）。
});
console.log(`[证据] 成因①+② 文案：${gwIncomplete.inputIncomplete?.[0]}`);

stub.stubResetWrites();
const natIncomplete = await runCompute('ZV-307a', 'ZV-307', false);

check('⑤ 成因②（终点是星系 id）→ 只点星系 id，不把成因推给勾选', f => {
  const text = natIncomplete.inputIncomplete?.[0] ?? '';
  expectCondition(f, '点明星系 id', text.includes('星系 id') === true, '含「星系 id」', text);
  // ⚠️ 断言变更记录（2026-09-23 本轮）：系内成因文案现在会**主动**说明「勾选/取消
  // 不改变系内航线的路程」（预防用户误解），故旧断言「不含「使用跃迁点」」过严 ——
  // 改为断言不把成因归给网关（不含「该航线走「使用跃迁点」」）。
  expectCondition(
    f,
    '不误报为网关成因',
    text.includes('该航线走「使用跃迁点」') === false,
    '不含「该航线走「使用跃迁点」」',
    text,
  );
  expectCondition(
    f,
    '写明已按反查后的键查表',
    text.includes('已按 ZV-307 → ANT 反查') === true,
    '含「已按 ZV-307 → ANT 反查」',
    text,
  );
  // ⚠️ 断言变更记录（2026-09-23 本轮）：系内航线的原生几何**已入库**（转移段的
  // stlDistance），拿到它只需生成一次计划 —— 旧断言要求不含「生成一次计划」（当时该操作
  // 无效，因为转移段不被消费）已不成立，改为要求给出这条**有效**操作。
  expectCondition(
    f,
    '操作：生成一次计划（该段已是消费的几何来源）',
    text.includes('生成一次飞行计划') === true,
    '含「生成一次飞行计划」',
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
});
console.log(`[证据] 成因② 文案：${natIncomplete.inputIncomplete?.[0]}`);

stub.stubResetWrites();
const antIncomplete = await runCompute('zv-307a', 'ANT', false);

check('⑤ 系内航线（尚无同星系记录）→ 先报「系内飞行/转移段」，并给出有效操作', f => {
  const text = antIncomplete.inputIncomplete?.[0] ?? '';
  expectCondition(f, '报缺', text.includes('轨道距离') === true, '含「轨道距离」', text);
  expectCondition(f, '点明系内飞行', text.includes('系内飞行') === true, '含「系内飞行」', text);
  expectCondition(f, '点明转移段（TRANSIT）', text.includes('转移') === true, '含「转移」', text);
  // ⚠️ 断言变更记录（2026-09-23 本轮）：「转移」段现在是本模型消费的几何来源，
  // 「生成一次计划」由无效操作变成**唯一**有效操作 → 断言反转（不再要求不含）。
  expectCondition(
    f,
    '操作：生成一次计划',
    text.includes('生成一次飞行计划') === true,
    '含「生成一次飞行计划」',
    text,
  );
  expectCondition(f, '点名终点实体', text.includes('ANT') === true, '含 ANT', text);
  expectCondition(
    f,
    '操作：手动设置',
    text.includes('手动设置燃料滑块') === true,
    '含「手动设置燃料滑块」',
    text,
  );
  // ⚠️ 区分度（防退化成「只看后缀」，也防后人误判为断言过期）：
  //   a) 动作必须由成因句的 ` —— ` 引出、且排在成因**之后**（不是散落在别处的字眼）；
  //   b) 不得出现已被证伪的「取消勾选」建议（换模式不改变系内航线路程）。
  // ⚠️ 2026-09-23 本轮定位记录：这条用例曾表现为「文案已精简成 `(操作：生成一次计划)` /
  // `(操作：手动设置)`」—— 那两串其实是**断言自身的 label**（expectCondition 把 label 拼在
  // 行尾括号里），不是文案内容。真实实现缺陷：系内动作被嵌在 `systemIds.length > 0` 里，
  // 而起终点都不是星系 id 的系内航线（zv-307a → ANT，最常见形状）命不中该分支 → 只报成因、
  // 不给任何操作。已在 fuel-model.ts 修（把系内动作提到判定之外），断言本身未放宽。
  const causeAt = text.indexOf('系内飞行');
  const actionAt = text.indexOf(' —— ');
  expectCondition(
    f,
    '动作由成因句的 ` —— ` 引出且在成因之后',
    causeAt >= 0 && actionAt > causeAt && text.includes('，否则请手动设置燃料滑块') === true,
    '` —— ` 在「系内飞行」之后且尾句为「，否则请手动设置燃料滑块」',
    `causeAt=${causeAt} actionAt=${actionAt}`,
  );
  expectCondition(
    f,
    '不给无效的「取消勾选」建议',
    text.includes('取消勾选') === false,
    '不含「取消勾选」',
    text,
  );
  expectExact(f, '未写入滑块', stub.sliderWrites.length, 0);
});
console.log(`[证据] 成因③（系内）文案：${antIncomplete.inputIncomplete?.[0]}`);

// 成因③（数据未到）只适用于**跨星系**：系内航线的原生几何根本不在离港/进近段上
// （见上方 ②），所以这里用纯函数直接给一份跨星系 metrics（有跳、无记录）锁该分支。
check('⑤ 成因③（跨星系、记录未到）→ 仍给「生成一次计划等算完」', f => {
  const msgs = missingModelInputs(
    { stlFuelCapacity: 3500, stlRemaining: 3500, condition: 1 },
    {
      stlDistanceKm: undefined,
      stlRecorded: false,
      departKm: undefined,
      approachKm: undefined,
      departSeconds: undefined,
      approachSeconds: undefined,
      natPc: 6,
      gwPc: 0,
      gwCount: 0,
      natJumpCount: 1,
      toBody: 'VH-331g',
      fromBody: 'HRT',
      fromIsSystem: false,
      toIsSystem: false,
      stationReverse: [],
    },
  );
  const text = msgs[0] ?? '';
  expectCondition(
    f,
    '点明数据未到',
    text.includes('服务器尚未为该航线下发原生 STL 段记录') === true,
    '含成因③文案',
    text,
  );
  expectCondition(
    f,
    '操作：生成一次计划',
    text.includes('生成一次飞行计划') === true,
    '含「生成一次飞行计划」',
    text,
  );
});
// 不删：上面 ⑤ 新用例已单独覆盖系内文案，这里保留原日志行便于对照。
console.log(`[证据] 成因③ 文案（旧条目）：${antIncomplete.inputIncomplete?.[0]}`);

// 有同星系记录（**合成**：数值取自面板「模型估算」行 68.0562M + 33.6491M = 101.7053M km）
// → 完整链路算出 f = 0.2 并写入。
stub.stubSetSameSystemRecord('zv-307a', 'ANT', {
  depart: { distanceKm: DEPART_KM, seconds: 4481 },
  approach: { distanceKm: APPROACH_KM, seconds: 1345 },
});
stub.stubResetWrites();
const complete = await runCompute('zv-307a', 'ANT', false);

check('⑤ 有原生记录（d = 101.7053M km）→ 不报缺、best.fuel = 0.15、写入滑块', f => {
  expectExact(
    f,
    '起点到终点的记录',
    routeMetrics(planRoutes('zv-307a', 'ANT').natural).stlDistanceKm,
    101705300,
  );
  expectExact(f, 'inputIncomplete', complete.inputIncomplete, undefined);
  expectExact(f, 'ok', complete.ok, true);
  expectExact(f, 'message 无警告', complete.message, '');
  expectExact(f, 'best.fuel', complete.best?.fuel, 0.15);
  expectExact(f, '滑块写入次数', stub.sliderWrites.length, 1);
  expectExact(f, '写入的燃料值', stub.sliderWrites[0]?.value, 0.15);
  // ⚠️ 断言变更记录（2026-09-23，本轮复核）：键从「按船」改成「按航线」后，替身
  // setFtcFuelSlider(routeKey, value) 记录的字段是 `key`（拼好的航线键）而不再是 `ship`
  // ——原断言 `sliderWrites[0]?.ship === 'STUB-01'` 读的是已不存在的字段（恒 undefined，
  // 必然失败），属**断言过期**，不是实现缺陷。这里改成断言**完整的航线键字面量**：
  // 它同时锁住船 + 起点 + 终点 + 网关标志四个分量（比原断言更强），实现退化成按船键控或
  // 起终点/网关标志不进键都会立刻失败。
  expectExact(f, '写入的航线键', stub.sliderWrites[0]?.key, 'STUB-01|ZV-307A|ANT|nat');
  expectExact(f, '反应堆写入次数', stub.reactorWrites.length, 1);
  expectExact(f, '写入的反应堆值', stub.reactorWrites[0]?.value, complete.best?.reactor);
  expectExact(f, '写入的反应堆键', stub.reactorWrites[0]?.key, 'STUB-01|ZV-307A|ANT|nat');
  expectCondition(
    f,
    'STL 燃料量级',
    Math.abs((complete.best?.stlFuel ?? 0) - 514.5) < 0.5,
    '514.5 ±0.5（= 0.98×罐3500×min(f,0.5)）',
    String(complete.best?.stlFuel),
  );
});

// ---- ⑥ 真实系内结构（同星系表只剩 `transit`）----
// 数值取用户 SFC 原生计划：ZV-307a → ZV-307/Antares Station = 单段「转移」
// 101,655,808 km / 43分59秒。**2026-09-23 本轮口径已标定**（BTF 受控数据，见 fuel-model
// 的 STL_TRANSIT_F_SAT 上方）：燃料 = 2×0.49×罐×min(f,0.5)（**与距离无关**）、
// 时长 = d/v_转移（V_SAT(引擎)×(min(f,0.5)/0.5)^k×(整备/当前质量)^0.75）。
// 故真实 computeFtcPlan 现在**算出并写入滑块**（旧行为：口径未标定 → 判缺、不写）。
stub.stubSetSameSystemRecord('zv-307a', 'ANT', {
  transit: { distanceKm: 101655808, seconds: 2639 },
});
const transitMetrics = routeMetrics(planRoutes('zv-307a', 'ANT').natural);
stub.stubResetWrites();
const transitOnly = await runCompute('zv-307a', 'ANT', false);

check('⑥ 转移段记录 → 几何取整段原生路程（不伪造离港/进近）', f => {
  expectExact(f, 'stlDistanceKm', transitMetrics.stlDistanceKm, 101655808);
  expectExact(f, 'transitKm', transitMetrics.transitKm, 101655808);
  expectExact(f, 'stlRecorded（原生记录）', transitMetrics.stlRecorded, true);
  expectExact(f, 'departKm 不伪造', transitMetrics.departKm, undefined);
  expectExact(f, 'approachKm 不伪造', transitMetrics.approachKm, undefined);
});

check('⑥ 转移段口径已标定 → 不报缺、按罐口径算燃料并写入滑块', f => {
  expectExact(f, 'inputIncomplete', transitOnly.inputIncomplete, undefined);
  expectExact(f, 'ok', transitOnly.ok, true);
  expectExact(f, 'best.fuel', transitOnly.best?.fuel, 0.15);
  expectExact(f, '滑块写入次数', stub.sliderWrites.length, 1);
  expectExact(f, '写入的燃料值', stub.sliderWrites[0]?.value, 0.15);
  expectExact(f, '写入的航线键', stub.sliderWrites[0]?.key, 'STUB-01|ZV-307A|ANT|nat');
  // 燃料 = 0.98×罐×min(f,0.5)：罐 3500、f=0.15 → 514.5u（旧 C_F×f×d 口径给 434.6u）。
  expectClose(f, 'STL 燃料 = 0.98×罐×min(f,0.5)', transitOnly.best?.stlFuel, 514.5, 0.5);
  // 时长 = d / v_转移（标定式）：f=0.15 → v=21,418 km/s → 1.3184h。旧「巡航模型」同 d
  // 给 0.44h 级（f≥0.2 饱和到 55,009 km/s）—— 这行锁住「时长确实换了转移段标定式」。
  expectClose(f, 'STL 时长（小时）', transitOnly.best?.stlHours, 1.3184, 0.01);
});
console.log(
  `[证据] ⑥ 转移段（d=101,655,808 km、罐 3500）→ f=${transitOnly.best?.fuel} ` +
    `燃料=${transitOnly.best?.stlFuel?.toFixed(2)}u 时长=${transitOnly.best?.stlHours?.toFixed(4)}h`,
);

// ---- ⑦ 系内 + 目的地是星系 id（反查命中）----
// 有转移段记录 → 直接可算（不报缺、写滑块）；无记录 → 成因只给「系内/转移段 + 生成一次
// 计划」，且**不得**再出现「口径未标定」（该口径已于 2026-09-23 用 BTF 受控数据标定）。
stub.stubSetSameSystemRecord('zv-307a', 'ANT', {
  transit: { distanceKm: 88870000, seconds: 2600 },
});
stub.stubResetWrites();
const transitSysId = await runCompute('ZV-307a', 'ZV-307', true);

check('⑦ 已有转移段几何 + 星系 id 目的地 → 直接可算（不报缺、写滑块）', f => {
  expectExact(f, 'inputIncomplete', transitSysId.inputIncomplete, undefined);
  expectExact(f, '滑块写入次数', stub.sliderWrites.length, 1);
  // 航线键用**输入原文**（起点/终点文本）：终点写的是星系 id，故键里是 ZV-307 + gw 标志。
  expectExact(f, '写入的航线键', stub.sliderWrites[0]?.key, 'STUB-01|ZV-307A|ZV-307|gw');
  // 燃料与距离无关（88.87M 与 101.66M 同为 514.5u）—— 这正是罐口径的核心结论。
  expectClose(f, 'STL 燃料（与 d 无关）', transitSysId.best?.stlFuel, 514.5, 0.5);
  // 时长按 d 线性：88.87M / 101.655808M × 1.3184h = 1.1526h。
  expectClose(f, 'STL 时长（小时，d=88.87M）', transitSysId.best?.stlHours, 1.1526, 0.01);
});
console.log(
  `[证据] ⑦ 系内 + 星系 id + 转移段已记录：f=${transitSysId.best?.fuel} ` +
    `燃料=${transitSysId.best?.stlFuel?.toFixed(2)}u 时长=${transitSysId.best?.stlHours?.toFixed(4)}h`,
);

// 无记录（本轮新锁）：系内 + 星系 id 两条成因都点明，动作是「生成一次计划」；
// 同时锁死「口径未标定」这类**已过时**文案不得复活（口径已标定，写滑块不再受阻）。
stub.stubClearStlRecords();
stub.stubResetWrites();
const transitSysIdNoRec = await runCompute('ZV-307a', 'ZV-307', true);

check('⑦ 无记录 → 文案给「生成一次计划」、不再提「口径未标定」，且不写滑块', f => {
  const text = transitSysIdNoRec.inputIncomplete?.[0] ?? '';
  expectCondition(f, '报缺', text.includes('轨道距离') === true, '含「轨道距离」', text);
  expectCondition(f, '点明系内飞行', text.includes('系内飞行') === true, '含「系内飞行」', text);
  expectCondition(
    f,
    '点明星系 id + 已按反查后的键查表',
    text.includes('已按 ZV-307 → ANT 反查') === true,
    '含「已按 ZV-307 → ANT 反查」',
    text,
  );
  expectCondition(
    f,
    '操作：生成一次计划',
    text.includes('生成一次飞行计划') === true,
    '含「生成一次飞行计划」',
    text,
  );
  expectCondition(
    f,
    '不再提「口径未标定」（已标定）',
    text.includes('口径未标定') === false,
    '不含「口径未标定」',
    text,
  );
  // 文案预算：≤2 句 + 一句动作指引（旧口径未标定文案 430+ 字）。
  // 两条成因（系内 + 星系 id）都成立时合计 229 字 —— 比旧文案少一半，仍锁上限。
  expectCondition(f, '文案长度 ≤ 260 字', text.length <= 260, '≤260', `len=${text.length}`);
  expectExact(f, '未写入滑块', stub.sliderWrites.length, 0);
  expectExact(f, '未写入反应堆', stub.reactorWrites.length, 0);
});
console.log(`[证据] ⑦ 系内 + 星系 id + 无记录文案：${transitSysIdNoRec.inputIncomplete?.[0]}`);

console.log(`PASS ${summary.pass}/${summary.pass + summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
