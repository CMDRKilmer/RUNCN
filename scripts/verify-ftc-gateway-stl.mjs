// 跨星系**网关**（「使用跃迁点」）航线的 STL 几何回归脚本 —— 带退出码，可自动判定成败。
//
// 为什么需要这一份（回归覆盖的空白）：
//   - scripts/verify-ftc-gap-guidance.mjs 的 ⑤ 覆盖的是**系内**（同星系）航线；
//   - scripts/verify-ftc-balance-degenerate.mjs 的 i 用例是**手工构造 metrics**；
//   两者都没有覆盖「真实计划派发 → 原生记录 → 查表 → 写滑块」这条链路。
//
// ⚠️ 第 5 轮模型变更（2026-09-23）：几何**首选**来源改为**航线级**记录
//   （system-bodies.routeRecords / stlSegmentsStore.getRoute，键 = 出发天体|目标天体[#gw]）。
//   依据 = 用户 FTC 面板「航线明细（服务器原生飞行计划）」的真实 16 段表（AVI-06JVV
//   ZV-194h → HRT 勾「启用网关」）：
//     0 起飞 / 1 离港 69.1655M / 2 跃迁(自然) / 3 充能 / 4 跃迁(自然) / 5 进近 67.4728M
//     / 6 转移 / 7 锁定 / 8 网关跃迁 / 9 衰变 / 10 转移 / 11 锁定 / 12 网关跃迁 / 13 衰变
//     / 14 转移 / 15 转移 93.4251M（真正到站段）
//   ⇒ APPROACH 在**中间**且 destination = `Antares I - Hephaestus` ≠ 最终目标 `Hortus Station`；
//   到站段是 TRANSIT；首跳是自然跳、末跳是网关跃迁（拼出混合后缀）。
//   故按 (出发天体, 首跳星系) / (末跳星系, 目标天体) 拼的键**必然失配** —— 这正是用户症状
//   「SFC 选择地址后没有计算燃料」的根因。第 4 轮把进近键改成「末跳【到达】星系」的改动
//   **无真实数据依据，本轮已回退**；两张按跳键控的表降级为**回退**口径。
//
// 锁定的行为契约（每条 ≈ 一个 check；数字一律现算，见夹具）：
//   ⓪ 夹具锚点：内置数据（自然口径通配键）未漂移、仓库内无 `#gw` 样本；
//   ① 纯网关 3 段计划（合成）：仍写两张回退表（键 `…|…#gw`）+ 一条航线级记录；离港键在
//      出发侧（首跳目标星系）、进近键在末跳**起点**星系侧；
//   ② 16 段混合计划（真实表形状）：`getRoute('ZV-194H','HRT',true)` 命中，
//      distanceKm = Σ 所有 STL 段 ≈ 230.2M、seconds = Σ 段时长；回退键按「首跳/末跳起点」
//      拼且**命中不了最终目标**（负断言：按末跳【到达】星系查 = undefined）；
//   ③ 自然键零污染 / 同星系表不被污染：`#gw` 只在网关键上，有 jump 的计划不写 sameSystem；
//   ④ 网关口径禁用通配回退；自然口径仍回退（回归保护点）；
//   ⑤ `routeMetrics` **首选**航线级记录：给它 route 记录 → `stlDistanceKm` = `routeKm`
//      （即使两张回退表里放着**不同**的值）；不给 route 记录 → 退回「离港 + 进近」；
//   ⑥ 端到端（纯网关图）：真实 `routes.ts` 观测 JUMP_GATEWAY 段 → 网关边 → `planRoutes`
//      选「网关」→ 真实 `routeMetrics` → 真实 `computeFtcPlan` 写滑块（routeKey 带 `|gw`）；
//   ⑦ 端到端（16 段混合 = 用户症状那条航线）：`zv-194h` → `HRT`，观测到**两条**网关边，
//      写滑块成功且 `inputIncomplete` 为空（修复前这里必然判缺）；
//   ⑧ 反例保护：清空记录 → 仍判缺、文案含「轨道距离」与可操作指引「生成一次飞行计划」、
//      **不含**已删除的错误文案「走「使用跃迁点」」与「服务器计划是网关结构」、不写滑块。
//
// 夹具真实性（哪些是真实数据、哪些是合成 —— 别把合成值当实测值引用）：
//   - 距离/时长**真实**：直接抄自上面那张 16 段真实表（面板按 0.0001M km 显示，故夹具值
//     是「显示值 × 1e6」的整数，非服务器原始精度）；3 段纯网关计划的距离是**合成**的
//     （仓库内无 `#gw` 真实样本，见 ⓪）；
//   - 天体/星系 id **真实**：ZV-194h（ZV-194 的行星，面板显示 `Antares III h`）、ZV-307 =
//     `Antares I`（src/infrastructure/prun-api/data/stations.default.ts 的 ANT 地址行）、
//     ZV-307c = `Hephaestus`（public/json/fallback-fio-responses/allplanets.json）、
//     VH-331a = `Promitor`（同文件）、HRT = `Hortus Station`（public/json/stations.json）、
//     MOR（同文件，OT-580 的空间站）、ANT（ZV-307 的空间站）；
//   - 星系 id **合成**：`SYN-201`（表里的 `Antares II`）、`SYN-202`（表里的 `Amethyst`）——
//     这两个系统的真实 id 在仓库里查不到，坐标也是合成的（本脚本不断言 pc 数值）；
//   - 自然口径几何**真实**：内置 public/json/stl-segments.json 的 `ZV-307A|*`、`HRT|*`、
//     `*|MOR`（运行时从文件读，并断言锚点值未漂移）；
//   - 网关跃迁边不是手写的：由**真实** infrastructure/fio/routes.ts 观测本脚本派发的
//     JUMP_GATEWAY 段得出（⑥⑦）—— 段地址形状本身因此也被测到。
//
// 用法：node scripts/verify-ftc-gateway-stl.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
// 局限：SFC 磁贴的 DOM 接线（真正把值写进 rc-slider）在 Node 里不可加载 —— 本脚本断言到
// `setFtcFuelSlider`（替身记录写入的航线键与值）为止；替换几何替身
// （scripts/lib/ftc-geometry-stub.mjs）与生产同口径但**不是**生产实现，
// 航线级/网关口径的生产实现由 ①②④⑤ 直接驱动真实 store 断言。
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

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

// ---- 夹具锚点：真实内置数据（运行时读，锚点值漂移会被 ⓪ 抓住）----
const bundled = JSON.parse(readFileSync('public/json/stl-segments.json', 'utf8'));
const bundledDepart = new Map(bundled.depart ?? []);
const bundledApproach = new Map(bundled.approach ?? []);
// 锚点值 = 2026-09-23 内置数据里的实际值（由 ⓪ 断言）。若内置数据将来改口径，这里会先
// 变成 undefined，后续断言随之以 `expected=74327215 actual=undefined` 的形式失败（可定位）。
const NAT_DEPART_ZV307A = bundledDepart.get('ZV-307A|*');
const NAT_DEPART_HRT = bundledDepart.get('HRT|*');
const NAT_APPROACH_MOR = bundledApproach.get('*|MOR');
const bundledGwKeyCount = [...bundledDepart.keys(), ...bundledApproach.keys()].filter(k =>
  k.includes('#'),
).length;

// 网关口径几何（合成，见文件头）：实测网关离港/进近比自然口径低 35-50% → 取 ×0.6。
// 自然口径锚点来自内置数据，故网关值随真实数据同缩放，不会与锚点脱节。
const GW_RATIO = 0.6;
const GW_DEPART_KM = Math.round(NAT_DEPART_ZV307A * GW_RATIO);
const GW_APPROACH_KM = Math.round(NAT_APPROACH_MOR * GW_RATIO);
const GW_DEPART_SECONDS = 1500;
const GW_APPROACH_SECONDS = 900;
// 网关跃迁段（JUMP_GATEWAY）的 FTL 距离（pc）：真实计划里该段只带 ftlDistance/stlDistance
// 为 null —— 用非零值让「真实 routes.ts 观测到了这一段」可断言。
const GW_FTL_PC = 12.5;
const GW_LOCAL_ID = 'GTW-STUB-001';
const GW_REMOTE_ID = 'GTW-STUB-002';

console.log(
  `[证据] 内置原生段：depart ${bundledDepart.size} + approach ${bundledApproach.size} 条；` +
    `\`#gw\` 键 ${bundledGwKeyCount} 条（仓库内无真实网关样本 → 网关几何为合成值）；` +
    `锚点 ZV-307A|*=${NAT_DEPART_ZV307A} HRT|*=${NAT_DEPART_HRT} *|MOR=${NAT_APPROACH_MOR}；` +
    `合成网关几何 depart=${GW_DEPART_KM} approach=${GW_APPROACH_KM}（×${GW_RATIO}）`,
);

// ---- 浏览器侧全局替身（真实 system-bodies / routes 需要 ref/config/fetch/localStorage/window）----
globalThis.ref = value => ({ value });
globalThis.config = {
  url: {
    stlSegments: 'https://stub.invalid/stl-segments.json',
    planetEnv: 'https://stub.invalid/planet-env.json',
    starConnections: 'https://stub.invalid/star-connections.json',
  },
};
// 内置 STL 段数据 = **真实文件内容**（锚点断言因此是真实数据；也让「自然模式回退通配」
// 这条回归保护点跑在真实键空间上）。
// 内置**自然**跃迁连接刻意不注入：本用例只覆盖网关航线，注入自然连接会让 natural 候选
// 存在并与网关路线重叠（planRoutes 会丢弃与 natural 同系统的 gateway 候选）。
globalThis.fetch = async url => ({
  json: async () => (String(url).includes('stl-segments') ? bundled : {}),
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
const { stlSegmentsStore, exportStlSegments } =
  await import('../src/infrastructure/prun-api/data/system-bodies.ts');
const { planRoutes, routeMetrics } = await import('../src/features/XIT/FTC/route-planner.ts');
const { computeFtcPlan } = await import('../src/features/XIT/FTC/ftc-compute.ts');
// 真实网关航线图（观测端）：只用来把本脚本派发的 JUMP_GATEWAY 段解析成网关连接，
// 从而证明夹具的段地址形状就是生产认得的形状。
const realRoutes = await import('../src/infrastructure/fio/routes.ts');
const stub = await import('./lib/ftc-geometry-stub.mjs');

// 内置 STL 段表的异步加载（void loadBundledStlSegments）落定后再取基线。
await new Promise(resolve => setTimeout(resolve, 50));

// ---- 合成飞行计划 ----
const T0 = 1_700_000_000_000;
const systemLine = id => ({ type: 'SYSTEM', entity: { naturalId: id, name: id } });
const bodyLine = (type, id) => ({ type, entity: { naturalId: id, name: id } });
const planetAddress = (system, planet) => ({
  lines: [systemLine(system), bodyLine('PLANET', planet)],
});
const stationAddress = (system, station) => ({
  lines: [systemLine(system), bodyLine('STATION', station)],
});
// 恒星（跃迁点）地址：只有 SYSTEM 行（真实计划里自然跃迁段的 origin/destination 就是这个形状）。
const starAddress = system => ({ lines: [systemLine(system)] });
// 网关端地址：SYSTEM 行 = 该端所在星系（= 网关两端星系），SATELLITE 行 = 网关实体本身。
// 形状取自真实观测端 infrastructure/fio/routes.ts（gatewayIdOf 取末行 SATELLITE、
// getSystemLineFromAddress 取 SYSTEM 行）。
const gatewayAddress = (system, gwId) => ({
  lines: [systemLine(system), bodyLine('SATELLITE', gwId)],
});
const segment = (type, origin, destination, stlDistance, durationMs, ftlDistance = null) => ({
  type,
  origin,
  destination,
  departure: { timestamp: T0 },
  arrival: { timestamp: T0 + durationMs },
  stlDistance,
  stlFuelConsumption: null,
  transferEllipse: null,
  ftlDistance,
  ftlFuelConsumption: null,
  damage: 0,
});

// 跨星系网关计划：ZV-307a（ZV-307 的行星）→ ZV-307 端网关 →［网关跃迁］→ OT-580 端网关
// → MOR（OT-580 的空间站）。段序与自然航线同构（system-bodies.ts 文件头）。
const gatewayPlan = {
  missionId: 'STUB-MISSION-GW-CROSS',
  segments: [
    segment(
      'DEPARTURE',
      planetAddress('ZV-307', 'ZV-307a'),
      gatewayAddress('ZV-307', GW_LOCAL_ID),
      GW_DEPART_KM,
      GW_DEPART_SECONDS * 1000,
    ),
    segment(
      'JUMP_GATEWAY',
      gatewayAddress('ZV-307', GW_LOCAL_ID),
      gatewayAddress('OT-580', GW_REMOTE_ID),
      null,
      3_600_000,
      GW_FTL_PC,
    ),
    segment(
      'APPROACH',
      gatewayAddress('OT-580', GW_REMOTE_ID),
      stationAddress('OT-580', 'MOR'),
      GW_APPROACH_KM,
      GW_APPROACH_SECONDS * 1000,
    ),
  ],
};
// 预期键（纯网关 3 段计划的回退口径）：离港 = 出发天体|首跳目标星系#gw；
// 进近 = 末跳【起点】星系|目标天体#gw。
// ⚠️ 断言变更记录（2026-09-23 第 5 轮）：第 4 轮把进近键的星系分量改成「末跳【到达】星系」
// （本用例 = OT-580|MOR#gw）并据此断言；该改动**无真实数据依据**（见文件头 16 段表），
// 本轮回退为「末跳【起点】星系」= ZV-307|MOR#gw（本用例唯一一段 JUMP_GATEWAY 的 origin 在
// ZV-307 侧）。回退口径只是**回退**：几何首选是下面的航线级记录（`ZV-307A|MOR#gw`）。
const GW_DEPART_KEY = 'ZV-307A|OT-580#gw';
const GW_APPROACH_KEY = 'ZV-307|MOR#gw';

// ---- 16 段混合计划（自然跃迁 ×2 + 网关跃迁 ×2）：用户 FTC 面板「航线明细」的真实表 ----
// 距离/时长 = 面板显示值（0.0001M km 精度）× 1e6 / 显示时长，非服务器原始精度（见文件头）。
// 星系 id：ZV-194（表里的 Antares III）/ ZV-307（Antares I）真实；SYN-201（Antares II）/
// SYN-202（Amethyst）合成（仓库里查不到真实 id）。
const MIX_FROM_SYS = 'ZV-194';
const MIX_NAT2_SYS = 'SYN-201';
const MIX_GW2_SYS = 'SYN-202';
const MIX_TO_SYS = 'VH-331';
const MIX_FROM_BODY = 'ZV-194h';
const MIX_APPROACH_BODY = 'ZV-307c'; // 表里的 `Antares I - Hephaestus`（Hephaestus = ZV-307c）
const MIX_TO_BODY = 'HRT'; // 表里的 `Hortus Station`（public/json/stations.json：HRT → VH-331）
const MIX_GW_LOCAL = 'GTW-STUB-101';
const MIX_GW_REMOTE = 'GTW-STUB-102';
const MIX_GW_REMOTE2 = 'GTW-STUB-103';
const MIX_GW_END = 'GTW-STUB-104';
// 跃迁段 FTL 距离（pc，表里的 3.13 / 3.93 / 17.08 / 17.17）。
const MIX_FTL_NAT1_PC = 3.13;
const MIX_FTL_NAT2_PC = 3.93;
const MIX_FTL_GW1_PC = 17.08;
const MIX_FTL_GW2_PC = 17.17;

// 带 stlDistance 的段（= 航线级记录累加的对象；其余段 stlDistance = null）。
const MIX_STL_SEGMENTS = [
  { type: 'TAKE_OFF', km: 41300, seconds: 1178 }, // 0
  { type: 'DEPARTURE', km: 69165500, seconds: 11944 }, // 1
  { type: 'APPROACH', km: 67472800, seconds: 10048 }, // 5
  { type: 'TRANSIT', km: 10000, seconds: 10 }, // 6
  { type: 'LOCK', km: 10000, seconds: 10 }, // 7
  { type: 'DECAY', km: 10000, seconds: 10 }, // 9
  { type: 'TRANSIT', km: 10000, seconds: 10 }, // 10
  { type: 'LOCK', km: 10000, seconds: 10 }, // 11
  { type: 'DECAY', km: 10000, seconds: 10 }, // 13
  { type: 'TRANSIT', km: 10000, seconds: 10 }, // 14
  { type: 'TRANSIT', km: 93425100, seconds: 14366 }, // 15（真正到站段）
];
const MIX_ROUTE_KM = MIX_STL_SEGMENTS.reduce((a, s) => a + s.km, 0);
const MIX_ROUTE_SECONDS = MIX_STL_SEGMENTS.reduce((a, s) => a + s.seconds, 0);
// 表里的 STL 总和锚点（≈ 230.2M km）：用户证据里就是这么合的，断言它没被夹具抄错。
const MIX_ROUTE_KM_ANCHOR = 230.2e6;
const MIX_ROUTE_KEY = `${MIX_FROM_BODY.toUpperCase()}|${MIX_TO_BODY}#gw`;
const MIX_DEPART_KEY = `${MIX_FROM_BODY.toUpperCase()}|${MIX_NAT2_SYS}`;
const MIX_APPROACH_KEY = `${MIX_GW2_SYS}|${MIX_APPROACH_BODY.toUpperCase()}#gw`;

const mixedPlan = {
  missionId: 'STUB-MISSION-MIXED',
  segments: [
    // 0 起飞：ZV-194h 地表 → 其环绕轨道。
    segment('TAKE_OFF', planetAddress(MIX_FROM_SYS, MIX_FROM_BODY), planetAddress(MIX_FROM_SYS, MIX_FROM_BODY), 41300, 1178 * 1000),
    // 1 离港：ZV-194h → 本星系跃迁点（Antares III = 起点恒星）。
    segment('DEPARTURE', planetAddress(MIX_FROM_SYS, MIX_FROM_BODY), starAddress(MIX_FROM_SYS), 69165500, 11944 * 1000),
    // 2 跃迁（**自然**）：Antares III → Antares II。
    segment('JUMP', starAddress(MIX_FROM_SYS), starAddress(MIX_NAT2_SYS), null, 4982 * 1000, MIX_FTL_NAT1_PC),
    // 3 充能。
    segment('CHARGE', starAddress(MIX_NAT2_SYS), starAddress(MIX_NAT2_SYS), null, 295 * 1000),
    // 4 跃迁（**自然**）：Antares II → Antares I（= ZV-307）。
    segment('JUMP', starAddress(MIX_NAT2_SYS), starAddress('ZV-307'), null, 6259 * 1000, MIX_FTL_NAT2_PC),
    // 5 进近：Antares I → `Antares I - Hephaestus`（**不是**最终目标 —— 本轮的核心证据）。
    segment('APPROACH', starAddress('ZV-307'), planetAddress('ZV-307', MIX_APPROACH_BODY), 67472800, 10048 * 1000),
    segment('TRANSIT', planetAddress('ZV-307', MIX_APPROACH_BODY), planetAddress('ZV-307', MIX_APPROACH_BODY), 10000, 10000),
    segment('LOCK', starAddress('ZV-307'), planetAddress('ZV-307', MIX_APPROACH_BODY), 10000, 10000),
    // 8 网关跃迁：Antares I 端网关 → Amethyst 端网关。
    segment('JUMP_GATEWAY', gatewayAddress('ZV-307', MIX_GW_LOCAL), gatewayAddress(MIX_GW2_SYS, MIX_GW_REMOTE), null, 20499 * 1000, MIX_FTL_GW1_PC),
    segment('DECAY', gatewayAddress(MIX_GW2_SYS, MIX_GW_REMOTE), planetAddress(MIX_GW2_SYS, `${MIX_GW2_SYS}B`), 10000, 10000),
    segment('TRANSIT', planetAddress(MIX_GW2_SYS, `${MIX_GW2_SYS}B`), planetAddress(MIX_GW2_SYS, `${MIX_GW2_SYS}B`), 10000, 10000),
    segment('LOCK', planetAddress(MIX_GW2_SYS, `${MIX_GW2_SYS}B`), planetAddress(MIX_GW2_SYS, `${MIX_GW2_SYS}B`), 10000, 10000),
    // 12 网关跃迁：Amethyst 端网关 → Hortus（VH-331）端网关。
    segment('JUMP_GATEWAY', gatewayAddress(MIX_GW2_SYS, MIX_GW_REMOTE2), gatewayAddress(MIX_TO_SYS, MIX_GW_END), null, 20603 * 1000, MIX_FTL_GW2_PC),
    segment('DECAY', gatewayAddress(MIX_TO_SYS, MIX_GW_END), planetAddress(MIX_TO_SYS, 'VH-331a'), 10000, 10000),
    segment('TRANSIT', planetAddress(MIX_TO_SYS, 'VH-331a'), planetAddress(MIX_TO_SYS, 'VH-331a'), 10000, 10000),
    // 15 转移：→ Hortus Station（**真正到站的 STL 段**）。
    segment('TRANSIT', planetAddress(MIX_TO_SYS, 'VH-331a'), stationAddress(MIX_TO_SYS, MIX_TO_BODY), 93425100, 14366 * 1000),
  ],
};

const counts = () => ({
  depart: stlSegmentsStore.departureCount,
  approach: stlSegmentsStore.approachCount,
  sameSystem: stlSegmentsStore.sameSystemCount,
  route: stlSegmentsStore.routeCount,
});
const baseline = counts();

// ---- ⓪ 夹具锚点（内置数据真实值未漂移；否则后面所有断言都在断言空气）----
check('⓪ 夹具锚点：内置数据的自然口径通配键仍在（ZV-307A|* / HRT|* / *|MOR）', f => {
  expectExact(f, 'ZV-307A|*（自然口径，内置）', NAT_DEPART_ZV307A, 74327215);
  expectExact(f, 'HRT|*（自然口径，内置）', NAT_DEPART_HRT, 21343591);
  expectExact(f, '*|MOR（自然口径，内置）', NAT_APPROACH_MOR, 72091720);
  // 「仓库里没有网关样本」是本脚本用合成网关几何的前提，必须显式锁定：
  // 一旦内置数据出现 `#gw` 键，本脚本应改用真实值并重审合成比例。
  expectExact(f, '内置数据无 `#gw` 键（网关几何为合成的依据）', bundledGwKeyCount, 0);
  // 自然口径必走通配回退的前提：同键不存在精确记录。
  expectExact(f, '精确键 ZV-307A|OT-580 不存在', bundledDepart.has('ZV-307A|OT-580'), false);
  expectExact(f, '精确键 OT-580|MOR 不存在', bundledApproach.has('OT-580|MOR'), false);
});

// ---- ① 派发写入：真实 system-bodies 消费纯网关 3 段计划（回退键 + 航线级记录）----
let realDepartGw;
let realApproachGw;
let realRouteGw;
check('① 纯网关计划派发 → 真实 store 写入（回退键带 `#gw` + 航线级记录）', f => {
  const before = counts();
  api.dispatch({ type: 'SHIP_FLIGHT_MISSION', data: gatewayPlan });
  realDepartGw = stlSegmentsStore.getDeparture('zv-307a', 'OT-580', true);
  realApproachGw = stlSegmentsStore.getApproach('ZV-307', 'MOR', true);
  realRouteGw = stlSegmentsStore.getRoute('zv-307a', 'MOR', true);
  const after = counts();
  // 键格式（全大写 + `#gw` 后缀）直接断言在**导出面**上（exportStlSegments 的键就是这些
  // 表的键，也是 build-stl-data.mjs 会内置出去的键）。
  const exported = exportStlSegments();
  const exportedDepartKeys = new Set(exported.depart.map(([k]) => k));
  const exportedApproachKeys = new Set(exported.approach.map(([k]) => k));
  const exportedRouteKeys = new Set(exported.route.map(([k]) => k));
  expectExact(f, `网关离港键 ${GW_DEPART_KEY} 已写入`, exportedDepartKeys.has(GW_DEPART_KEY), true);
  expectExact(
    f,
    `网关进近键 ${GW_APPROACH_KEY} 已写入（末跳【起点】星系侧）`,
    exportedApproachKeys.has(GW_APPROACH_KEY),
    true,
  );
  expectExact(f, `航线级键 ${'ZV-307A|MOR#gw'} 已写入`, exportedRouteKeys.has('ZV-307A|MOR#gw'), true);
  // 不带后缀的自然键**不应**被这次派发写入（否则两套几何会互相覆盖）。
  expectExact(
    f,
    '自然键 ZV-307A|OT-580 未被这次派发写入',
    exportedDepartKeys.has('ZV-307A|OT-580'),
    false,
  );
  expectCondition(f, '网关离港记录存在', realDepartGw !== undefined, '记录', String(realDepartGw));
  expectExact(f, '离港距离（段原生 stlDistance）', realDepartGw?.distanceKm, GW_DEPART_KM);
  expectExact(f, '离港时长（秒）', realDepartGw?.seconds, GW_DEPART_SECONDS);
  expectExact(f, '跨星系离港表 +1', after.depart, before.depart + 1);
  expectCondition(
    f,
    '网关进近记录存在',
    realApproachGw !== undefined,
    '记录',
    String(realApproachGw),
  );
  expectExact(f, '进近距离（段原生 stlDistance）', realApproachGw?.distanceKm, GW_APPROACH_KM);
  expectExact(f, '进近时长（秒）', realApproachGw?.seconds, GW_APPROACH_SECONDS);
  expectExact(f, '跨星系进近表 +1', after.approach, before.approach + 1);
  // 航线级记录（首选几何来源）：距离 = 该航线**所有** STL 段之和（本计划 = 离港 + 进近）。
  expectCondition(f, '航线级记录存在', realRouteGw !== undefined, '记录', String(realRouteGw));
  expectExact(f, '航线级距离 = Σ STL 段', realRouteGw?.distanceKm, GW_DEPART_KM + GW_APPROACH_KM);
  expectExact(
    f,
    '航线级时长 = Σ 段时长',
    realRouteGw?.seconds,
    GW_DEPART_SECONDS + GW_APPROACH_SECONDS,
  );
  expectExact(f, '航线级表 +1', after.route, before.route + 1);
});

// ---- ② 16 段混合计划（用户真实表）：航线级记录命中 + 回退键按首跳/末跳起点拼 ----
let realMixRoute;
check('② 16 段混合计划派发 → 航线级记录（Σ STL ≈ 230.2M）命中且键 = 出发天体|目标天体#gw', f => {
  const before = counts();
  api.dispatch({ type: 'SHIP_FLIGHT_MISSION', data: mixedPlan });
  realMixRoute = stlSegmentsStore.getRoute(MIX_FROM_BODY, MIX_TO_BODY, true);
  const after = counts();
  expectCondition(f, '航线级记录存在', realMixRoute !== undefined, '记录', String(realMixRoute));
  expectExact(f, '航线级距离 = Σ 所有 STL 段（现算）', realMixRoute?.distanceKm, MIX_ROUTE_KM);
  expectExact(f, '航线级时长 = Σ STL 段时长（现算）', realMixRoute?.seconds, MIX_ROUTE_SECONDS);
  expectCondition(
    f,
    'Σ ≈ 表里的 230.2M km（夹具没抄错）',
    Math.abs(MIX_ROUTE_KM - MIX_ROUTE_KM_ANCHOR) < 0.1e6,
    `±0.1M of ${MIX_ROUTE_KM_ANCHOR}`,
    String(MIX_ROUTE_KM),
  );
  expectExact(f, '航线级键（含 `#gw`：整条航线含 JUMP_GATEWAY）', MIX_ROUTE_KEY, 'ZV-194H|HRT#gw');
  expectExact(f, '航线级表 +1', after.route, before.route + 1);
  // 回退键（按首跳/末跳拼）仍然写，但**按「末跳【起点】星系」**（第 4 轮的「到达星系」已回退）。
  expectExact(
    f,
    '回退离港键 = 出发天体|首跳（**自然**）目标星系（无 `#gw` 后缀）',
    stlSegmentsStore.getDeparture(MIX_FROM_BODY, MIX_NAT2_SYS)?.distanceKm,
    69165500,
  );
  expectExact(f, '回退离港键确无后缀', MIX_DEPART_KEY, 'ZV-194H|SYN-201');
  expectExact(
    f,
    '回退进近键 = 末跳【起点】星系|进近段目标天体（含 `#gw`）',
    stlSegmentsStore.getApproach(MIX_GW2_SYS, MIX_APPROACH_BODY, true)?.distanceKm,
    67472800,
  );
  expectExact(f, '回退进近键确在末跳起点侧', MIX_APPROACH_KEY, 'SYN-202|ZV-307C#gw');
  // ★ 本轮的核心负断言：按「末跳【到达】星系」查（第 4 轮语义）必须 **undefined**；
  // 且进近段的目标天体（`Antares I - Hephaestus`）≠ 最终目标 → 按段拼的键永远命不中这条航线。
  expectExact(
    f,
    '第 4 轮语义键（末跳【到达】星系 VH-331）不存在 —— 已回退',
    stlSegmentsStore.getApproach(MIX_TO_SYS, MIX_APPROACH_BODY, true),
    undefined,
  );
  expectExact(
    f,
    '按进近段目标天体拼的「航线」键不存在（它 ≠ 最终目标）',
    stlSegmentsStore.getRoute(MIX_FROM_BODY, MIX_APPROACH_BODY, true),
    undefined,
  );
});

// ---- ③ 自然键零污染（回退表 + 航线级表）----
check('③ 网关记录不污染自然键：自然口径命中的是内置通配值，不是网关值', f => {
  // 自然口径（第三参数省略 = false）：精确键 `ZV-307A|OT-580` 不存在 → 回退内置通配
  // `ZV-307A|*`。断言「等于内置通配值」比只断言「不等于网关值」强：后者在通配数据缺失
  // 时会因 undefined 而假通过。
  const naturalDepart = stlSegmentsStore.getDeparture('zv-307a', 'OT-580');
  expectExact(
    f,
    '自然口径离港 = 内置通配（回退生效）',
    naturalDepart?.distanceKm,
    NAT_DEPART_ZV307A,
  );
  expectCondition(
    f,
    '自然口径离港 ≠ 网关记录值',
    naturalDepart?.distanceKm !== GW_DEPART_KM,
    `≠ ${GW_DEPART_KM}`,
    String(naturalDepart?.distanceKm),
  );
  const naturalApproach = stlSegmentsStore.getApproach('OT-580', 'MOR');
  expectExact(
    f,
    '自然口径进近 = 内置通配（回退生效）',
    naturalApproach?.distanceKm,
    NAT_APPROACH_MOR,
  );
  expectCondition(
    f,
    '自然口径进近 ≠ 网关记录值',
    naturalApproach?.distanceKm !== GW_APPROACH_KM,
    `≠ ${GW_APPROACH_KM}`,
    String(naturalApproach?.distanceKm),
  );
  // 时长侧更硬：内置数据的 seconds 恒为 0（内置不带时长），网关记录是段时长 →
  // 自然口径拿到 0 就证明它没有读到网关记录（键空间确实分开了）。
  expectExact(f, '自然口径离港时长 = 内置 0（不是段的 1500s）', naturalDepart?.seconds, 0);
  // 航线级表的自然口径同样不得看到 `#gw` 记录（无后缀查 = 无通配回退 → undefined）。
  expectExact(
    f,
    '航线级：自然口径查 ZV-307A|MOR = undefined（`#gw` 记录不外泄）',
    stlSegmentsStore.getRoute('zv-307a', 'MOR'),
    undefined,
  );
  expectExact(
    f,
    '航线级：自然口径查 ZV-194H|HRT = undefined',
    stlSegmentsStore.getRoute(MIX_FROM_BODY, MIX_TO_BODY),
    undefined,
  );
});

// ---- ④ 同星系表不被污染 ----
check('④ 有 jump 的计划不写同星系表（sameSystem 计数不变、按该键查不到）', f => {
  expectExact(f, '同星系表计数未增长', counts().sameSystem, baseline.sameSystem);
  expectExact(
    f,
    '按 (出发天体, 目标天体) 查不到（纯网关计划）',
    stlSegmentsStore.getSameSystem('zv-307a', 'MOR'),
    undefined,
  );
  expectExact(
    f,
    '按 (出发天体, 目标天体) 查不到（16 段混合计划）',
    stlSegmentsStore.getSameSystem(MIX_FROM_BODY, MIX_TO_BODY),
    undefined,
  );
});

// ---- ⑤ 决策 2：网关禁用通配回退（真实 store）----
check('⑤ 网关口径禁用通配回退；自然口径仍回退（`BODY|*` / `*|BODY`）', f => {
  // HRT 在出发侧只有内置通配 `HRT|*`（21,343,591），目标星系是合成 id → 精确键必不存在。
  expectExact(
    f,
    '网关口径：精确键查不到即 undefined（不回退通配）',
    stlSegmentsStore.getDeparture('HRT', 'FAKE-STAR', true),
    undefined,
  );
  expectExact(
    f,
    '自然口径：回退到内置通配',
    stlSegmentsStore.getDeparture('HRT', 'FAKE-STAR')?.distanceKm,
    NAT_DEPART_HRT,
  );
  // 进近侧对称：来源星系是合成 id → 精确键不存在 → 网关 undefined / 自然回退 `*|MOR`。
  expectExact(
    f,
    '网关口径进近：undefined（不回退通配）',
    stlSegmentsStore.getApproach('FAKE-STAR', 'MOR', true),
    undefined,
  );
  expectExact(
    f,
    '自然口径进近：回退到内置通配',
    stlSegmentsStore.getApproach('FAKE-STAR', 'MOR')?.distanceKm,
    NAT_APPROACH_MOR,
  );
  // 真实存在的网关键仍能精确命中（确保上面两条不是因为「网关口径恒 undefined」）。
  expectExact(
    f,
    '网关口径精确键仍命中',
    stlSegmentsStore.getDeparture('zv-307a', 'OT-580', true)?.distanceKm,
    GW_DEPART_KM,
  );
});

// ---- ⑥ routeMetrics 取几何（真实实现 + 几何替身）：**首选**航线级记录 ----
const gatewayRoute = {
  label: '网关',
  systemIds: ['ZV-307', 'OT-580'],
  legs: [{ from: 'ZV-307', to: 'OT-580', pc: 1, viaGateway: true }],
  totalPc: 1,
  gatewayCount: 1,
  fromBody: 'zv-307a',
  toBody: 'MOR',
};
const naturalCrossRoute = {
  label: '自然',
  systemIds: ['ZV-307', 'OT-580'],
  legs: [{ from: 'ZV-307', to: 'OT-580', pc: 1, viaGateway: false }],
  totalPc: 1,
  gatewayCount: 0,
  fromBody: 'HRT',
  toBody: 'MOR',
};

check('⑥ routeMetrics(网关航线) → 回退表取 `#gw` 记录值（不是自然记录、不是通配）', f => {
  stub.stubClearStlRecords();
  stub.stubSetGatewayDepartureRecord('zv-307a', 'OT-580', {
    distanceKm: GW_DEPART_KM,
    seconds: GW_DEPART_SECONDS,
  });
  stub.stubSetGatewayApproachRecord('ZV-307', 'MOR', {
    distanceKm: GW_APPROACH_KM,
    seconds: GW_APPROACH_SECONDS,
  });
  // 同键的**自然**记录（不同的值）：若 routeMetrics 没把 viaGateway 传下去，它会被选中。
  stub.stubSetDepartureRecord('zv-307a', 'OT-580', {
    distanceKm: NAT_DEPART_ZV307A,
    seconds: 5000,
  });
  const m = routeMetrics(gatewayRoute);
  expectExact(f, 'departKm = 网关回退记录值', m.departKm, GW_DEPART_KM);
  expectExact(f, 'approachKm = 网关回退记录值（末跳【起点】星系查表）', m.approachKm, GW_APPROACH_KM);
  expectExact(f, 'stlDistanceKm = 两段之和（无航线级记录时的回退口径）', m.stlDistanceKm, GW_DEPART_KM + GW_APPROACH_KM);
  expectExact(f, 'routeKm（无航线级记录）', m.routeKm, undefined);
  expectExact(f, 'stlRecorded', m.stlRecorded, true);
  expectExact(f, 'departSeconds = 网关记录时长', m.departSeconds, GW_DEPART_SECONDS);
  expectExact(f, 'approachSeconds = 网关记录时长', m.approachSeconds, GW_APPROACH_SECONDS);
  expectExact(f, 'gwCount', m.gwCount, 1);
  expectExact(f, 'natJumpCount', m.natJumpCount, 0);
  expectExact(f, 'fromLookup', m.fromLookup, 'zv-307a');
  expectExact(f, 'toLookup', m.toLookup, 'MOR');
  // ★ 首选：给出**航线级**记录（值与两段之和刻意不同——真实混合航线的形状：
  // 两段按跳拼的键命不中，唯有航线级记录对）→ stlDistanceKm/routeKm 都必须取航线级值。
  stub.stubSetGatewayRouteRecord('zv-307a', 'MOR', {
    distanceKm: MIX_ROUTE_KM,
    seconds: MIX_ROUTE_SECONDS,
  });
  const preferred = routeMetrics(gatewayRoute);
  expectExact(f, '首选：routeKm = 航线级记录值', preferred.routeKm, MIX_ROUTE_KM);
  expectExact(f, '首选：stlDistanceKm = routeKm（压过两段之和）', preferred.stlDistanceKm, MIX_ROUTE_KM);
  expectCondition(
    f,
    '首选：stlDistanceKm ≠ 两段之和（证明不是拼出来的）',
    preferred.stlDistanceKm !== GW_DEPART_KM + GW_APPROACH_KM,
    `≠ ${GW_DEPART_KM + GW_APPROACH_KM}`,
    String(preferred.stlDistanceKm),
  );
  // 两段回退值仍在（分段计时用），但不再决定总路程。
  expectExact(f, '首选：departKm 仍为回退记录值', preferred.departKm, GW_DEPART_KM);
  expectExact(f, '首选：approachKm 仍为回退记录值', preferred.approachKm, GW_APPROACH_KM);
  expectExact(f, '首选：routeSeconds', preferred.routeSeconds, MIX_ROUTE_SECONDS);
  expectExact(f, '首选：stlRecorded', preferred.stlRecorded, true);
  // 负对照：只留自然记录 → 网关航线必须拿不到几何（不回退自然记录）。
  stub.stubClearStlRecords();
  stub.stubSetDepartureRecord('zv-307a', 'OT-580', {
    distanceKm: NAT_DEPART_ZV307A,
    seconds: 5000,
  });
  stub.stubSetApproachRecord('ZV-307', 'MOR', {
    distanceKm: NAT_APPROACH_MOR,
    seconds: 2959,
  });
  const fallback = routeMetrics(gatewayRoute);
  expectExact(f, '负对照 departKm（不得回退自然记录）', fallback.departKm, undefined);
  expectExact(f, '负对照 approachKm（不得回退自然记录）', fallback.approachKm, undefined);
  expectExact(f, '负对照 stlDistanceKm', fallback.stlDistanceKm, undefined);
  expectExact(f, '负对照 routeKm', fallback.routeKm, undefined);
  expectExact(f, '负对照 stlRecorded', fallback.stlRecorded, false);
});

// ---- ⑦ 自然模式仍走通配回退（回归保护点）----
check('⑦ 自然航线（viaGateway=false）仍回退通配键 —— viaGateway 被真传下去', f => {
  stub.stubClearStlRecords();
  // 只放通配记录（自然口径的内置批量采集形状）：精确键 `HRT|OT-580` 不存在。
  stub.stubSetDepartureRecord('HRT', '*', { distanceKm: NAT_DEPART_HRT, seconds: 0 });
  stub.stubSetApproachRecord('*', 'MOR', { distanceKm: NAT_APPROACH_MOR, seconds: 0 });
  const nat = routeMetrics(naturalCrossRoute);
  expectExact(f, '自然 departKm = 通配值', nat.departKm, NAT_DEPART_HRT);
  expectExact(f, '自然 approachKm = 通配值', nat.approachKm, NAT_APPROACH_MOR);
  expectExact(f, '自然 stlDistanceKm', nat.stlDistanceKm, NAT_DEPART_HRT + NAT_APPROACH_MOR);
  expectExact(f, '自然 stlRecorded', nat.stlRecorded, true);
  // 替身自检（与生产同口径）：同一份数据下网关口径不得命中（否则 ⑤ 的负对照恒真）。
  expectExact(
    f,
    '替身自检：网关口径对通配键 = undefined',
    stub.stlSegmentsStore.getDeparture('HRT', 'OT-580', true),
    undefined,
  );
  expectExact(
    f,
    '替身自检：自然口径仍命中通配',
    stub.stlSegmentsStore.getDeparture('HRT', 'OT-580')?.distanceKm,
    NAT_DEPART_HRT,
  );
});

// ---- ⑦ 端到端：真实 routes.ts 观测网关边 → 真实 planRoutes → 真实 computeFtcPlan ----
// 网关连接来自**真实观测端**（不是手写的一对假边）：同一份 gatewayPlan 的 JUMP_GATEWAY
// 段被 fio/routes.ts 解析成「ZV-307 ⇄ OT-580」的连接（含两端网关 id 与 FTL 距离）。
// ⚠️ 观测端（`routesStore.getGatewayConnections()`）是**模块级累积**集合，不是本 check 的私货：
// 前序 check 派发的计划会往同一张图里塞边 —— ① 的 3 段纯网关计划贡献目标边本身，
// ② 的 16 段混合计划又贡献 2 条（`SYN-202|ZV-307`、`SYN-202|VH-331`）。
// 故此处**不能**断言「恰好 1 条」：那测的是「本脚本前序 check 有没有弄脏收集器」，
// 与产品行为无关（放宽成 `>= 1` 同样错——丢掉了对目标边的逐字段校验）。
// 正确口径：在集合里**定位目标边**，再对该条**逐字段**断言（比「恰好 1 条」更精确）。
const observedGatewayConnections = realRoutes.routesStore.getGatewayConnections();
// 目标边 = ZV-307 ⇄ OT-580（无向，字典序归一：'OT-580' < 'ZV-307'）。
const TARGET_GW_EDGE = 'OT-580|ZV-307';
const observedTargetConn = observedGatewayConnections.find(
  c => [c.fromSystem, c.toSystem].join('|') === TARGET_GW_EDGE,
);
stub.stubSetRouteGraph({
  gateway: observedGatewayConnections.map(c => [c.fromSystem, c.toSystem]),
});
// 起点恒星 ZV-307 已在替身里（原点）；终点侧 OT-580 需要坐标才能算 pc 权重（合成坐标）。
stub.stubSetStar('OT-580', { x: 0, y: 0, z: 12 });
// MOR 是 OT-580 的空间站（真实 stations.json）→ 让 resolveSystemId('MOR') 解析到星系。
stub.stubSetStation('MOR', 'OT-580');

const NO_PRICES = { stlPrice: 0, ftlPrice: 0, timeValue: 0 };
const runCompute = () =>
  computeFtcPlan({
    shipRegistration: 'STUB-01',
    from: 'zv-307a',
    to: 'MOR',
    useGateway: true,
    browse: false,
    ...NO_PRICES,
  });

// 每条 check 自带环境（不依赖上一条的残留状态：单跑/乱序都不漂移）。真实记录链：
// ① 派发的计划已把（回退键 + **航线级**）记录写进真实 store → 这里把**真实键读到的真实记录**
// 桥接进几何替身（route-planner 查的是替身 store）—— 写入端与查表端任何键后缀不一致都会在此断链。
function prepareGatewayCompute() {
  stub.stubClearStlRecords();
  stub.stubResetWrites();
  stub.stubResetBrowseCalls();
  stub.stubSetShip(stub.STUB_SHIP);
  stub.stubSetBlueprint(stub.stubBlueprint());
  stub.stubSetGatewayDepartureRecord('zv-307a', 'OT-580', realDepartGw);
  stub.stubSetGatewayApproachRecord('ZV-307', 'MOR', realApproachGw);
  stub.stubSetGatewayRouteRecord('zv-307a', 'MOR', realRouteGw);
}

await checkAsync(
  '⑧ 端到端（3 段纯网关）：网关计划 → 网关边 → planRoutes 选「网关」→ 写滑块（routeKey 带 |gw）',
  async f => {
    // 观测端：段地址形状必须被真实 routes.ts 认出来。
    // 断言「集合里存在目标边」而非「集合只有 1 条」（后者是累积集合 + 前序 check 的假约束，
    // 见 observedTargetConn 处的注释）；缺失时打印实观测列表便于定位段地址形状漂移。
    expectCondition(
      f,
      '目标网关边已被真实观测端记录',
      observedTargetConn !== undefined,
      `观测集合含 ${TARGET_GW_EDGE}`,
      observedGatewayConnections.length === 0
        ? '（空集合）'
        : observedGatewayConnections.map(c => [c.fromSystem, c.toSystem].join('|')).join(', '),
    );
    // 目标边不得被重复累积（同一段只应产生一条边）。
    expectExact(
      f,
      '目标边在观测集合里恰好 1 条',
      observedGatewayConnections.filter(c => [c.fromSystem, c.toSystem].join('|') === TARGET_GW_EDGE).length,
      1,
    );
    const conn = observedTargetConn;
    expectExact(
      f,
      '连接两端星系（字典序归一，无向）',
      [conn?.fromSystem, conn?.toSystem].join('|'),
      // 'OT-580' < 'ZV-307'（字符串比较）→ 归一后顺序固定。
      TARGET_GW_EDGE,
    );
    expectExact(
      f,
      '两端网关 id（跟随所属星系）',
      [conn?.fromGatewayId, conn?.toGatewayId].join('|'),
      `${GW_REMOTE_ID}|${GW_LOCAL_ID}`,
    );
    expectExact(f, '跃迁段 ftlDistance 被记录', conn?.ftlDistance, GW_FTL_PC);
    // 航线规划：图上只有网关边 → 自然候选不存在，选中「网关」。
    const planned = planRoutes('zv-307a', 'MOR');
    expectExact(f, '自然候选（图上无自然跃迁）', planned.natural, undefined);
    expectExact(f, '网关候选 label', planned.gateway?.label, '网关');
    expectExact(f, '网关候选 systemIds', planned.gateway?.systemIds.join('|'), 'ZV-307|OT-580');
    expectExact(f, '网关候选 gatewayCount', planned.gateway?.gatewayCount, 1);
    prepareGatewayCompute();
    const out = await runCompute();
    expectExact(f, 'ok', out.ok, true);
    expectExact(f, 'inputIncomplete（网关几何齐备 → 不判缺）', out.inputIncomplete, undefined);
    expectExact(f, '选中的路线', out.route?.label, '网关');
    expectExact(f, 'metrics.departKm = 网关记录值', out.metrics?.departKm, GW_DEPART_KM);
    expectExact(f, 'metrics.approachKm = 网关记录值（末跳【起点】星系侧）', out.metrics?.approachKm, GW_APPROACH_KM);
    // 首选几何 = 航线级记录（= 本计划所有 STL 段之和 = 离港 + 进近，此处两者数值相同，
    // 但来源不同：routeKm 有值是路线级表命中的证据）。
    expectExact(f, 'metrics.routeKm = 航线级记录值', out.metrics?.routeKm, GW_DEPART_KM + GW_APPROACH_KM);
    expectExact(f, 'metrics.stlDistanceKm = routeKm', out.metrics?.stlDistanceKm, out.metrics?.routeKm);
    expectExact(f, 'metrics.stlRecorded', out.metrics?.stlRecorded, true);
    expectExact(f, '滑块写入次数', stub.sliderWrites.length, 1);
    expectExact(f, '写入的航线键（gw 口径）', stub.sliderWrites[0]?.key, 'STUB-01|ZV-307A|MOR|gw');
    expectExact(f, '写入的燃料值 = 本次最优 f', stub.sliderWrites[0]?.value, out.best?.fuel);
    expectCondition(
      f,
      '最优 f 在滑块量程内且 > 0',
      typeof out.best?.fuel === 'number' && out.best.fuel > 0 && out.best.fuel <= 1,
      '(0, 1]',
      String(out.best?.fuel),
    );
    expectExact(f, '反应堆写入次数', stub.reactorWrites.length, 1);
    // SFC 联动路径（browse:false）不许开星系窗口（会抢占缓冲槽位、干扰 SFC 面板）。
    expectExact(f, '未开星系窗口', stub.browseCalls.length, 0);
  },
);

// ---- ⑧ 反例保护：记录未到时仍判缺且文案可操作 ----
await checkAsync(
  '⑧ 反例：清空记录 → 仍判缺 + 可操作指引，旧「网关结构」错误文案不得复活',
  async f => {
    prepareGatewayCompute();
    stub.stubClearStlRecords();
    const out = await runCompute();
    const text = (out.inputIncomplete ?? []).join(' | ');
    expectExact(f, 'ok（算完但退化）', out.ok, true);
    expectExact(f, '仍是同一条网关航线（反例可比）', out.route?.label, '网关');
    expectExact(f, '几何缺失（无回退）', out.metrics?.departKm, undefined);
    expectExact(f, '几何缺失（无回退，进近）', out.metrics?.approachKm, undefined);
    expectCondition(
      f,
      '判缺项含「轨道距离」',
      text.includes('轨道距离') === true,
      '含「轨道距离」',
      text,
    );
    expectCondition(
      f,
      '旧错误文案「走「使用跃迁点」」不得复活',
      text.includes('走「使用跃迁点」') === false,
      '不含「走「使用跃迁点」」',
      text,
    );
    expectCondition(
      f,
      '旧成因「服务器计划是网关结构」不得复活',
      text.includes('服务器计划是网关结构') === false,
      '不含「服务器计划是网关结构」',
      text,
    );
    expectCondition(
      f,
      '操作指引：生成一次飞行计划',
      text.includes('生成一次飞行计划') === true,
      '含「生成一次飞行计划」',
      text,
    );
    expectExact(f, '未写入滑块', stub.sliderWrites.length, 0);
    expectExact(f, '未写入反应堆', stub.reactorWrites.length, 0);
    console.log(`[证据] ⑧ 网关航线无记录 文案：${out.inputIncomplete?.[0]}`);
  },
);

console.log(`PASS ${summary.pass}/${summary.pass + summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
