// FTC 几何来源回归脚本（**只用服务器原生记录，无回退**）—— 带退出码，可自动判定成败。
//
// 背景（2026-09-23 修复 → 同日二次修订）：SFC 联动路径（browse:false，设计上不许开星系
// 窗口）曾拿不到同星系航线的 STL 几何 —— 同星系 legs 为空 → routeMetrics 任何记录表都
// 查不到 → 回退 liftOffKmAt 自建轨道模型；空间站轨道只能靠浏览星系运行时积累 →
// undefined → 燃料恒 0 → 选优退化 → 与 FTC 面板（browse:true）不一致。第一步修复：
// （2026-09-23 复核更正）旧注释称「服务器下发的 SHIP_FLIGHT_MISSION 里，同星系直飞同样带
// DEPARTURE/APPROACH 段原生 stlDistance（实测 zv-307a → ANT = 68.0562M + 33.6491M）」——
// 那 68.0562M / 33.6491M 其实是**本模型自己的估算行**（FTC 面板标题写明「航线分段（模型估算）」），
// 不是服务器原生值。真实观测到的系内计划只有「转移」（TRANSIT）段（2026-09-23 用户 SFC 原生
// 计划 ZV-307a → ZV-307/Antares Station = 单段 101,655,808 km），所以 (出发天体, 目标天体)
// 这条同星系记录路径在真实数据里**从未命中**（内置同星系表为空）。记录/查表逻辑保留
// （若某天真出现该段结构仍可用），本脚本用合成计划覆盖该能力。
// **第二步（本脚本锁定的当前口径，用户拍板「不需要回退，永远等服务器下发」）**：回退
// 全部删除 —— `liftOffKmAt`（自建轨道模型）与 `STL_EST_*`（统计中位数常数）不再作为几何
// 来源；记录查不到就是 `undefined` → 判缺 → 不写滑块 → 等服务器下发。
//
// 锁定的行为契约：
//   ① 记录（真实 system-bodies.ts）：无 JUMP 计划 → 同星系表（键 出发天体|目标天体，
//      全大写）；跨星系 → 按（出发天体｜首跳目标星系 / 末跳**起点**星系｜目标天体）记录。
//      ⚠️ 第 5 轮（2026-09-23）：第 4 轮曾把进近键的星系分量改成「末跳**到达**星系」，
//      该改动**无真实数据依据**（真实混合航线的 APPROACH 段在中间、destination ≠ 最终目标，
//      该键无论如何都命不中），已回退；几何**首选**来源改为航线级记录（routeRecords），
//      下面这套按跳拼的键只作回退；
//      同星系记录不污染跨星系表，反之亦然；
//      rprun.ftc.stl-segments.v1 写入为旧格式的超集（depart/approach 原样 + sameSystem），
//      旧格式（无 sameSystem）可读、内置数据旧格式可读。
//   ② routeMetrics（真实 route-planner.ts）：同星系 + 有记录 → d 取记录值；**无记录 →
//      departKm/approachKm/stlDistanceKm 全 undefined（不回退：即便轨道观测齐备也不用，
//      负对照锁定「回退已删除」）**；有跳航线不吃同星系记录，只吃按跳键的原生记录，
//      无记录同样 undefined（不再回退统计中位数）。
//   ③ 门控（真实 computeFtcPlan）：无原生记录 → stlDistanceKm undefined →
//      missingModelInputs 非空 → 不写滑块（**最关键的一条**：宁可不动，不写假值）。
//   ④ 两条路径的**差异与收敛**：browse:true（面板）会 showBuffer("MS 起点星系") 取几何，
//      browse:false（SFC 联动）不开窗；在**同一几何输入**下两者得到同一个 best.fuel
//      （截图实参复算：f = 0.15，系内燃料 = 0.98×罐×min(f,0.5)，2026-09-23 标定）。这不等于「两条路径端到端一致」——真实环境里
//      browse:false 的几何可能残缺，那是 ③ 门控负责拦下的场景。
//   ⑤ SFC 推送门（真实 sfc-route-push-gate.ts，纯状态机）：**永远等服务器下发** ——
//      同键同签名在途只跑一次（pending）；同键同签名已跑过一次（完整或残缺）不再重复
//      计算（settled，防 DOM 抖动无上限重算）；签名变化（新的原生 STL 段入库）**必放行**；
//      且**没有任何「试满 N 次就放弃」的上限**（上限若在数据到达后生效会永久放弃该航线）。
//   ⑥ 「输入不完整」提示分级（同模块 `incompleteLogLevel`，2026-09-23 第四轮降噪）：
//      T3（tile ready 首推，服务器计划未到 → 必然残缺）→ 'debug' 不刷屏；T1（MissionPlan
//      表格刷新过 = 服务器计划已到）仍残缺 → 'warn'。语义不变：任一情形都不写滑块。
//
// 用法：node scripts/verify-ftc-geometry-source.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
// 局限：几何来源组用受控替身 store（真实 store 的内容来自服务器消息，由 ① 覆盖）；
// 浏览星系/行星环境 JSON/蓝图异步等待走替身（与 verify-ftc-input-consistency.mjs 同源）。
// system-bodies 的段记录持久化有 1000ms 防抖，脚本用 settlePersist() 等它落盘后再断言缓存。
// ⑤ 组驱动的是真实状态机模块，但**不**覆盖 sfc-auto-fuel-settings.ts 的 DOM 接线
// （该文件依赖 vue/DOM，Node 里加载不了）：接线由代码审查 + 注释锁定。
import { register } from 'node:module';
import {
  autoFuelGrid,
  findBalanceOption,
  missingModelInputs,
  scanFuelOptions,
} from '../src/features/XIT/FTC/fuel-model.ts';
import { SHIP, DEPART_KM, APPROACH_KM } from './lib/ftc-node-fixtures.mjs';
// 命名空间导入：既取 RoutePushGate，又可在用例里断言旧导出（MAX_ROUTE_ATTEMPTS）确已删除。
import * as gateModule from '../src/features/basic/sfc-route-push-gate.ts';
const { RoutePushGate } = gateModule;

// system-bodies 的三张段表持久化有 1000ms 防抖（批量采集下避免 O(n²) 主线程阻塞），
// 断言缓存内容/重载实例前先等它落盘。
const settlePersist = () => new Promise(resolve => setTimeout(resolve, 1100));

const STL_CACHE_KEY = 'rprun.ftc.stl-segments.v1';
const NO_PRICES = { stlPrice: 0, ftlPrice: 0, timeValue: 0 };

// route-planner / route-model / ftc-compute 的浏览器侧依赖走替身；三者保留真实实现。
register('./lib/ftc-geometry-loader.mjs', import.meta.url);

// 自动导入的全局（真实构建由 unimport 注入）：ref 供 system-bodies 用。
globalThis.ref = value => ({ value });
globalThis.config = {
  url: {
    stlSegments: 'https://stub.invalid/stl-segments.json',
    planetEnv: 'https://stub.invalid/planet-env.json',
  },
};
// 内置 STL 段数据：首次加载用**旧格式**（无 sameSystem 字段 —— 验证向后兼容），
// 重载实例前换成新格式（含 sameSystem）—— 验证新增内置字段可加载。
let bundledPayload = {
  depart: [['MOR|OT-580', 77260947]],
  approach: [['OT-580|MOR', 72737809]],
};
const NEW_FORMAT_BUNDLED = {
  depart: [['MOR|OT-580', 77260947]],
  approach: [['OT-580|MOR', 72737809]],
  sameSystem: [['OT-580A|HUB', { depart: 12345678, approach: 23456789 }]],
};
globalThis.fetch = async url => ({
  json: async () => (String(url).includes('stl-segments') ? bundledPayload : {}),
});
// system-bodies 的 persist 用 window.setTimeout（这里只提供用到的两个方法）。
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
};
// 旧格式持久化缓存（真实 localStorage 的替身）：验证「读取兼容旧格式」。
const storage = new Map([
  [
    STL_CACHE_KEY,
    JSON.stringify({
      depart: [['HRT|VH-192', { distanceKm: 21343591, seconds: 3720 }]],
      approach: [['VH-331|VH-192C', { distanceKm: 72737809, seconds: 2959 }]],
    }),
  ],
]);
const fakeStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};
let persistAvailable = true;
try {
  Object.defineProperty(globalThis, 'localStorage', { value: fakeStorage, configurable: true });
} catch {
  try {
    globalThis.localStorage = fakeStorage;
  } catch {
    persistAvailable = false;
  }
}

const api = await import('../src/infrastructure/prun-api/data/api-messages.ts');
const { stlSegmentsStore } = await import('../src/infrastructure/prun-api/data/system-bodies.ts');
const { routeMetrics } = await import('../src/features/XIT/FTC/route-planner.ts');
const { computeFtcPlan } = await import('../src/features/XIT/FTC/ftc-compute.ts');
const stub = await import('./lib/ftc-geometry-stub.mjs');

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

// ---- ① 记录：真实 system-bodies.ts 消费服务器 SHIP_FLIGHT_MISSION ----
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

// 同星系直飞计划（无 JUMP）：zv-307a → ANT（同在 ZV-307），**合成**（面板「模型估算」实参）。
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

// 跨星系计划（两个 JUMP）：ZV-307a → HRT（同名空间站，在 VH-331）。
const crossPlan = {
  missionId: 'STUB-MISSION-CROSS',
  segments: [
    segment(
      'DEPARTURE',
      planetAddress('ZV-307', 'ZV-307a'),
      starAddress('ZV-307'),
      74327215,
      5000000,
    ),
    segment('CHARGE', starAddress('ZV-307'), starAddress('ZV-307'), null, 300000),
    segment('JUMP', starAddress('ZV-307'), starAddress('OT-580'), null, 6000000, 5.1),
    segment('CHARGE', starAddress('OT-580'), starAddress('OT-580'), null, 300000),
    segment('JUMP', starAddress('OT-580'), starAddress('VH-331'), null, 5000000, 4.2),
    segment('APPROACH', starAddress('VH-331'), stationAddress('VH-331', 'HRT'), 21343591, 2959000),
  ],
};

// 内置数据/持久化缓存的异步加载先落地。
await new Promise(resolve => setTimeout(resolve, 20));

check('① 旧格式持久化缓存可读（rprun.ftc.stl-segments.v1 无 sameSystem 字段）', f => {
  if (!persistAvailable) {
    f.push('localStorage 替身安装失败（环境限制）');
    return;
  }
  const rec = stlSegmentsStore.getDeparture('HRT', 'VH-192');
  expectExact(f, 'distanceKm', rec?.distanceKm, 21343591);
  expectExact(f, 'seconds', rec?.seconds, 3720);
  expectExact(
    f,
    '进近记录',
    stlSegmentsStore.getApproach('VH-331', 'VH-192C')?.distanceKm,
    72737809,
  );
});
check('① 旧格式内置数据可读（无 sameSystem 字段不报错）', f => {
  expectExact(f, '内置离港', stlSegmentsStore.getDeparture('MOR', 'OT-580')?.distanceKm, 77260947);
  expectExact(f, '内置进近', stlSegmentsStore.getApproach('OT-580', 'MOR')?.distanceKm, 72737809);
  expectExact(f, '同星系表初始为空', stlSegmentsStore.sameSystemCount, 0);
});

// 跨星系表在派发前的基线（含旧格式种子：缓存 1 条 + 内置 1 条）。
const departBase = stlSegmentsStore.departureCount;
const approachBase = stlSegmentsStore.approachCount;

api.dispatch({ type: 'SHIP_FLIGHT_MISSION', data: sameSystemPlan });

const recorded = stlSegmentsStore.getSameSystem('zv-307a', 'ANT');
check('① 同星系计划（无 JUMP）按 (出发天体, 目标天体) 记录两段（大小写不敏感）', f => {
  expectCondition(f, '记录存在', recorded !== undefined, '同星系记录', String(recorded));
  expectExact(f, '离港距离', recorded?.depart?.distanceKm, DEPART_KM);
  expectExact(f, '进近距离', recorded?.approach?.distanceKm, APPROACH_KM);
  expectExact(f, '离港时长（秒）', recorded?.depart?.seconds, 4481);
  expectExact(f, '进近时长（秒）', recorded?.approach?.seconds, 1345);
  expectExact(f, '同星系表条数', stlSegmentsStore.sameSystemCount, 1);
});
check('① 同星系记录不污染跨星系表（键空间独立）', f => {
  expectExact(f, '跨星系离港表未增长', stlSegmentsStore.departureCount, departBase);
  expectExact(f, '跨星系进近表未增长', stlSegmentsStore.approachCount, approachBase);
  expectExact(
    f,
    '按 (出发天体, 本星系) 查不到',
    stlSegmentsStore.getDeparture('ZV-307a', 'ZV-307'),
    undefined,
  );
  expectExact(
    f,
    '按 (本星系, 目标天体) 查不到',
    stlSegmentsStore.getApproach('ZV-307', 'ANT'),
    undefined,
  );
});

// 持久化防抖（1000ms）落盘后再读缓存：本条计划触发的写还没落地。
await settlePersist();
const persistedAfterSame = persistAvailable ? JSON.parse(storage.get(STL_CACHE_KEY)) : undefined;

api.dispatch({ type: 'SHIP_FLIGHT_MISSION', data: crossPlan });

check('① 跨星系计划键（出发天体|首跳星系 / 末跳【起点】星系|目标天体）', f => {
  expectExact(f, '离港', stlSegmentsStore.getDeparture('ZV-307a', 'OT-580')?.distanceKm, 74327215);
  expectExact(
    f,
    '离港时长（秒）',
    stlSegmentsStore.getDeparture('ZV-307a', 'OT-580')?.seconds,
    5000,
  );
  // ⚠️ 断言变更记录（2026-09-23 第 5 轮）：第 4 轮曾把进近键的星系分量改成「末跳【到达】
  // 星系」（VH-331|HRT），并按「旧语义键（末跳起点星系）不得再被写入」加了一条负断言。
  // 本轮的真实段结构（用户 16 段原生计划）证明该改动无依据：混合航线的 APPROACH 段在中间、
  // 其 destination ≠ 最终目标 ⇒ 按首/末跳拼的键必然失配，几何首选已改走航线级 routeRecords。
  // 故这两处一并回退到改动前的形状：末跳起点星系 = OT-580（本用例末跳 OT-580 → VH-331）。
  expectExact(f, '进近', stlSegmentsStore.getApproach('OT-580', 'HRT')?.distanceKm, 21343591);
  expectExact(f, '进近时长（秒）', stlSegmentsStore.getApproach('OT-580', 'HRT')?.seconds, 2959);
  expectExact(f, '跨星系离港表 +1', stlSegmentsStore.departureCount, departBase + 1);
  expectExact(f, '同星系表未被跨星系计划改动', stlSegmentsStore.sameSystemCount, 1);
});
// 跨星系记录也已落盘（第二次防抖写）。
await settlePersist();
const persistedNow = persistAvailable ? JSON.parse(storage.get(STL_CACHE_KEY)) : undefined;
check('① 持久化为旧格式的超集（depart/approach 原样保留 + sameSystem 新增）', f => {
  if (!persistAvailable) {
    f.push('localStorage 替身安装失败（环境限制）');
    return;
  }
  const before = Object.fromEntries(persistedAfterSame?.depart ?? []);
  expectExact(f, '同星系写入前旧 depart 记录仍在', before['HRT|VH-192']?.distanceKm, 21343591);
  expectExact(f, '同星系写入前旧 approach 记录仍在', persistedAfterSame?.approach?.length, 2);
  expectExact(f, '同星系条数', persistedAfterSame?.sameSystem?.length, 1);
  expectExact(f, '同星系键（大写）', persistedAfterSame?.sameSystem?.[0]?.[0], 'ZV-307A|ANT');
  const now = persistedNow;
  const departNow = Object.fromEntries(now.depart);
  expectExact(f, '旧 depart 记录未丢', departNow['HRT|VH-192']?.distanceKm, 21343591);
  expectExact(f, '新离港记录已写入', departNow['ZV-307A|OT-580']?.distanceKm, 74327215);
  expectExact(f, '同星系记录仍在', now.sameSystem.length, 1);
});

// 读写往返：新实例从（新格式的）缓存恢复，同时换成新格式内置数据。
bundledPayload = NEW_FORMAT_BUNDLED;
const reloaded = await import('../src/infrastructure/prun-api/data/system-bodies.ts?roundtrip=1');
await new Promise(resolve => setTimeout(resolve, 20));
check('① 新格式缓存可往返恢复（重载后同星系记录仍在）', f => {
  if (!persistAvailable) {
    f.push('localStorage 替身安装失败（环境限制）');
    return;
  }
  const rec = reloaded.stlSegmentsStore.getSameSystem('ZV-307A', 'ANT');
  expectExact(f, '离港距离', rec?.depart?.distanceKm, DEPART_KM);
  expectExact(f, '进近距离', rec?.approach?.distanceKm, APPROACH_KM);
  expectExact(
    f,
    '跨星系记录同时恢复',
    reloaded.stlSegmentsStore.getDeparture('ZV-307a', 'OT-580')?.distanceKm,
    74327215,
  );
});
check('① 新格式内置数据（含 sameSystem）可加载', f => {
  const rec = reloaded.stlSegmentsStore.getSameSystem('OT-580a', 'HUB');
  expectExact(f, '离港距离', rec?.depart?.distanceKm, 12345678);
  expectExact(f, '进近距离', rec?.approach?.distanceKm, 23456789);
  expectExact(f, '内置时长置 0', rec?.depart?.seconds, 0);
});

// ---- ② routeMetrics：几何来源（唯一来源 = 服务器原生记录）----
// 自建轨道模型（liftOffKmAt）在本替身里的旧回退值：起点 1e6、终点 2e6 km。
// 以下用例把它们当**负对照**：观测位置照旧登记，但已删除的回退不得再被使用。
const LIFT_FROM_KM = 1e6;
const LIFT_TO_KM = 2e6;
const sameSystemRoute = {
  label: '自然',
  systemIds: ['ZV-307'],
  legs: [],
  totalPc: 0,
  gatewayCount: 0,
  fromBody: 'zv-307a',
  toBody: 'ANT',
};
const crossRoute = {
  label: '自然',
  systemIds: ['ZV-307', 'OT-580'],
  legs: [{ from: 'ZV-307', to: 'OT-580', pc: 10, viaGateway: false }],
  totalPc: 10,
  gatewayCount: 0,
  fromBody: 'zv-307a',
  toBody: 'MOR',
};
function prepareGeometry() {
  stub.stubClearStlRecords();
  stub.stubSetBodyPosition('ZV-307a', { x: LIFT_FROM_KM, y: 0, z: 0 });
  stub.stubSetBodyPosition('ANT', { x: LIFT_TO_KM, y: 0, z: 0 });
  stub.stubSetBodyPosition('MOR', { x: LIFT_TO_KM, y: 0, z: 0 });
}

// 用 ① 真实记录到的值驱动真实 routeMetrics（记录 → 几何 → 模型全链路）。
prepareGeometry();
stub.stubSetSameSystemRecord('zv-307a', 'ANT', recorded);
const metricsRecorded = routeMetrics(sameSystemRoute);

check('② 同星系 + 有原生记录 → d 取记录值', f => {
  expectExact(f, '离港', metricsRecorded.departKm, DEPART_KM);
  expectExact(f, '进近', metricsRecorded.approachKm, APPROACH_KM);
  expectExact(f, '总 STL', metricsRecorded.stlDistanceKm, DEPART_KM + APPROACH_KM);
  expectExact(f, 'stlRecorded', metricsRecorded.stlRecorded, true);
  // 「确实没走回退」由下面「无记录 → 全 undefined」负对照用例承担（同一替身环境下
  // 旧回退值 1e6/2e6 可控且确定，两者对比才有信息量）。
  expectExact(f, '原生离港时长', metricsRecorded.departSeconds, 4481);
  expectExact(f, '原生进近时长', metricsRecorded.approachSeconds, 1345);
});

// 本轮核心负对照：观测位置齐备也没用 —— 几何回退已删除，没有原生记录就是 undefined。
prepareGeometry();
const metricsNoRecord = routeMetrics(sameSystemRoute);

check('② 同星系 + 无原生记录 → 全 undefined（不回退自建轨道模型）', f => {
  expectExact(f, '离港', metricsNoRecord.departKm, undefined);
  expectExact(f, '进近', metricsNoRecord.approachKm, undefined);
  expectExact(f, '总 STL', metricsNoRecord.stlDistanceKm, undefined);
  expectExact(f, 'stlRecorded', metricsNoRecord.stlRecorded, false);
  expectExact(f, '无原生时长', metricsNoRecord.departSeconds, undefined);
  expectCondition(
    f,
    '不等于旧轨道模型回退值（起 1e6 + 终 2e6）',
    metricsNoRecord.stlDistanceKm !== LIFT_FROM_KM + LIFT_TO_KM,
    '≠ 3e6',
    String(metricsNoRecord.stlDistanceKm),
  );
  expectCondition(
    f,
    'missingModelInputs 报缺',
    missingModelInputs(SHIP, metricsNoRecord).length > 0,
    '>0 条缺失',
    '0 条',
  );
});

// 观测数据在这条航线上有没有都不影响几何（几何不再消费它）—— 与上一条逐位一致。
prepareGeometry();
stub.stubSetBodyPosition('ANT', undefined);
const metricsNoRecordNoObs = routeMetrics(sameSystemRoute);

check('② 同星系 + 无记录 + 无观测 → 同样 undefined（观测不再参与几何）', f => {
  expectExact(f, '离港', metricsNoRecordNoObs.departKm, undefined);
  expectExact(f, '进近', metricsNoRecordNoObs.approachKm, undefined);
  expectExact(f, '总 STL', metricsNoRecordNoObs.stlDistanceKm, metricsNoRecord.stlDistanceKm);
});

prepareGeometry();
stub.stubSetSameSystemRecord('zv-307a', 'MOR', {
  depart: { distanceKm: 1e6, seconds: 1 },
  approach: { distanceKm: 1e6, seconds: 1 },
});
const crossNoRecords = routeMetrics(crossRoute);

check('② 有跳航线不吃同星系记录 → 无按跳记录即 undefined（不再回退统计中位数）', f => {
  expectExact(f, '离港', crossNoRecords.departKm, undefined);
  expectExact(f, '进近', crossNoRecords.approachKm, undefined);
  expectExact(f, '总 STL', crossNoRecords.stlDistanceKm, undefined);
  expectExact(f, 'stlRecorded', crossNoRecords.stlRecorded, false);
  expectCondition(
    f,
    '不等于旧统计中位数（70M + 68M）',
    crossNoRecords.stlDistanceKm !== 70e6 + 68e6,
    '≠ 138e6',
    String(crossNoRecords.stlDistanceKm),
  );
});

prepareGeometry();
stub.stubSetDepartureRecord('zv-307a', 'OT-580', { distanceKm: 74327215, seconds: 5000 });
// ⚠️ 断言变更记录（2026-09-23 第 5 轮）：第 4 轮把进近记录换到「末跳【到达】星系」键
// （OT-580|MOR），并加了「只登记旧键（末跳起点星系 = ZV-307）→ 进近必须拿不到几何」的
// 负对照。本轮按真实段结构回退（见文件头 ①）：单跳航线 ZV-307 → OT-580 的末跳**起点**
// 星系 = ZV-307，故查表键 = (ZV-307, MOR)；负对照相应改为「只登记到达侧键 → 拿不到几何」。
stub.stubSetApproachRecord('ZV-307', 'MOR', { distanceKm: 72737809, seconds: 2959 });
const crossRecorded = routeMetrics(crossRoute);

check('② 有跳航线仍按跳键取原生记录（跨星系行为未变）', f => {
  expectExact(f, '离港', crossRecorded.departKm, 74327215);
  expectExact(f, '进近', crossRecorded.approachKm, 72737809);
  expectExact(f, 'stlRecorded', crossRecorded.stlRecorded, true);
  // 负对照：只登记到达侧键（第 4 轮语义）→ 进近必须拿不到几何（证明查表确实在末跳起点侧）。
  stub.stubClearStlRecords();
  stub.stubSetApproachRecord('OT-580', 'MOR', { distanceKm: 72737809, seconds: 2959 });
  expectExact(f, '到达侧键不再被查表命中', routeMetrics(crossRoute).approachKm, undefined);
});

// ---- ③④ 编排层：真实 computeFtcPlan（browse:false = SFC 联动 / browse:true = 面板）----
const runCompute = browse =>
  computeFtcPlan({
    shipRegistration: 'STUB-01',
    from: 'zv-307a',
    to: 'ANT',
    browse,
    ...NO_PRICES,
  });

// 每条 check 自带几何环境（不依赖上一条 check 的残留状态：单跑/乱序都不漂移）。
function prepareLinkedFlyby() {
  prepareGeometry();
  stub.stubSetShip(stub.STUB_SHIP);
  stub.stubSetBlueprint(stub.stubBlueprint());
  stub.stubSetSameSystemRecord('zv-307a', 'ANT', recorded);
  stub.stubResetWrites();
  stub.stubResetBrowseCalls();
}

// ③ 用的环境：**没有任何原生 STL 段记录**（起点/终点观测位置照旧登记 —— 负对照：
// 观测/轨道数据不再参与 STL 几何，齐备也一样算不出来）→ 几何残缺。
function prepareNoStlRecords() {
  prepareGeometry();
  stub.stubSetShip(stub.STUB_SHIP);
  stub.stubSetBlueprint(stub.stubBlueprint());
  stub.stubResetWrites();
  stub.stubResetBrowseCalls();
}

// 截图实参（标准引擎 / 罐 3500 / G8 / 空重 1271t / 质量 2140t）复算。
const panelPure = (() => {
  const options = scanFuelOptions(SHIP, metricsRecorded, autoFuelGrid(), [1], NO_PRICES);
  return { options, best: findBalanceOption(options) };
})();

await checkAsync(
  '④ SFC 联动路径（browse:false）拿到服务器几何 → 写入 f = 0.15 且不开窗',
  async f => {
    prepareLinkedFlyby();
    const out = await runCompute(false);
    expectExact(f, 'ok', out.ok, true);
    expectExact(f, 'inputIncomplete', out.inputIncomplete, undefined);
    expectExact(f, '几何来源为原生记录', out.metrics?.stlRecorded, true);
    expectExact(f, 'd', out.metrics?.stlDistanceKm, DEPART_KM + APPROACH_KM);
    expectExact(f, '滑块写入次数', stub.sliderWrites.length, 1);
    expectExact(f, '写入的燃料值', stub.sliderWrites[0]?.value, 0.15);
    expectExact(f, '反应堆写入次数', stub.reactorWrites.length, 1);
    // 系内燃料 = 0.98×罐×min(f,0.5)（2026-09-23 标定，与距离无关）：罐 3500、f=0.15 → 514.5u
    // （旧 C_F×f×d 口径在同 d 下给 434.6u）。
    expectClose(f, 'STL 燃料（截图实参复算）', out.best?.stlFuel, 514.5, 0.5);
    expectClose(f, '与纯模型一致', out.best?.stlFuel, panelPure.best?.stlFuel, 1e-9);
    // SFC 联动设计上不许开星系窗口（会抢占缓冲槽位）。
    expectExact(f, '未开星系窗口', stub.browseCalls.length, 0);
  },
);

// 面板路径与联动路径的真实差异在**开窗行为**（browse:true 会 showBuffer 取几何，
// browse:false 不会）；收敛依据是「同一几何输入 → 同一结果」，不代表端到端一致。
await checkAsync(
  '④ 面板路径（browse:true）会开窗取几何；同一几何输入下 best.fuel 一致',
  async f => {
    prepareLinkedFlyby();
    const panel = await runCompute(true);
    expectExact(f, '面板路径开窗命令', stub.browseCalls.join(','), 'MS ZV-307');
    const linked = await runCompute(false);
    expectExact(f, 'SFC 联动不开窗', stub.browseCalls.length, 1);
    expectExact(f, '面板 best.fuel', panel.best?.fuel, 0.15);
    expectExact(f, '两条路径 best.fuel 相同', panel.best?.fuel, linked.best?.fuel);
    expectExact(
      f,
      '两条路径 d 相同（同一几何输入）',
      panel.metrics?.stlDistanceKm,
      linked.metrics?.stlDistanceKm,
    );
    expectExact(f, '面板路径输入完整', panel.inputIncomplete, undefined);
  },
);

await checkAsync('③ 无原生记录（观测齐备）→ 判 incomplete 且不写任何滑块', async f => {
  prepareNoStlRecords();
  const out = await runCompute(false);
  expectCondition(
    f,
    'inputIncomplete 非空',
    (out.inputIncomplete?.length ?? 0) > 0,
    '>0 条',
    '0 条',
  );
  expectCondition(
    f,
    '指向起终点轨道距离',
    out.inputIncomplete?.[0]?.includes('轨道距离') === true,
    '含「轨道距离」',
    String(out.inputIncomplete?.[0]),
  );
  expectExact(f, '滑块写入次数', stub.sliderWrites.length, 0);
  expectExact(f, '反应堆写入次数', stub.reactorWrites.length, 0);
  expectCondition(
    f,
    'message 带警告',
    out.message.includes('未应用到 SFC 滑块'),
    '含警告文案',
    out.message,
  );
});

// ---- ⑤ SFC 推送门（真实 sfc-route-push-gate.ts）：同签名只算一次 + 永远等服务器下发 ----
// 签名由调用方拼（sfc-auto-fuel-settings 用「轨道数 + 三张原生 STL 段表条数」这类单调
// 信息量计数），这里用等价的可控字符串代表「几何没变 / 服务器新数据到达」两种情形。
const ROUTE_KEY = 'STUB-01|ZV-307a|ANT|nat';
const ROUTE_OTHER_KEY = 'STUB-01|ZV-307a|HUB|nat';
const SIG_SAME = 'orbit=12|depart=3|approach=3|sameSystem=1';
const SIG_BETTER = 'orbit=13|depart=3|approach=3|sameSystem=1';

check('⑤ 同键同签名在途 → 不并发（第二次 begin 返回 pending）', f => {
  const gate = new RoutePushGate();
  expectExact(f, '首次 begin', gate.begin(ROUTE_KEY, SIG_SAME), 'run');
  // T1（表格文本变化）与 T2（输入框 value 变化）对同一 key 相邻触发。
  expectExact(f, '在途第二次 begin', gate.begin(ROUTE_KEY, SIG_SAME), 'pending');
  gate.finish(ROUTE_KEY, SIG_SAME, false);
});

check('⑤ 同签名连试 5 次：只有第 1 次 run，其余不再算，且永不出现「放弃」', f => {
  const gate = new RoutePushGate();
  const decisions = [];
  for (let i = 0; i < 5; i++) {
    const decision = gate.begin(ROUTE_KEY, SIG_SAME);
    decisions.push(decision);
    if (decision === 'run') {
      // 输入残缺（原生记录还没到）：这次没算出完整结果，没写任何滑块。
      gate.finish(ROUTE_KEY, SIG_SAME, false);
    }
  }
  expectExact(f, '第 1 次（DOM 抖动首次触发）', decisions[0], 'run');
  expectExact(f, '第 2 次', decisions[1], 'settled');
  expectExact(f, '第 3 次', decisions[2], 'settled');
  expectExact(f, '第 4 次', decisions[3], 'settled');
  expectExact(f, '第 5 次', decisions[4], 'settled');
  expectCondition(
    f,
    '决策里没有「放弃」语义',
    decisions.every(d => d === 'run' || d === 'settled' || d === 'pending'),
    'run/settled/pending',
    decisions.join(','),
  );
  // 旧实现的「试满 N 次放弃」已删：连常量都不该再导出。
  expectExact(f, 'MAX_ROUTE_ATTEMPTS 已删除', gateModule.MAX_ROUTE_ATTEMPTS, undefined);
});

check('⑤ 永远等服务器下发：同签名失败多次后，签名变化（原生记录入库）必放行', f => {
  const gate = new RoutePushGate();
  let runs = 0;
  for (let i = 0; i < 8; i++) {
    if (gate.begin(ROUTE_KEY, SIG_SAME) === 'run') {
      runs++;
      gate.finish(ROUTE_KEY, SIG_SAME, false); // 同签名只该跑第一次。
    }
  }
  expectExact(f, '同签名只跑 1 次（DOM 抖动不重算）', runs, 1);
  // 服务器下发原生 STL 段（或浏览星系数据增长）→ 签名变化 → 必放行一次。
  expectExact(f, '签名变化 → 放行', gate.begin(ROUTE_KEY, SIG_BETTER), 'run');
  gate.finish(ROUTE_KEY, SIG_BETTER, true);
  expectExact(f, '这次算出完整结果 → 抑制后续推送', gate.begin(ROUTE_KEY, SIG_BETTER), 'settled');
  // 该航线已算出完整结果：签名再变也不重算（防「写滑块 → 服务器重算 → 再推送」反馈循环）。
  expectExact(f, '完整后签名变化仍抑制（防反馈循环）', gate.begin(ROUTE_KEY, SIG_SAME), 'settled');
  // 换目的地（新 key）：新航线照常放行（每条航线独立记账）。
  expectExact(f, '新航线放行', gate.begin(ROUTE_OTHER_KEY, SIG_SAME), 'run');
});

// ---- ⑥ 「输入不完整」提示分级（真实 sfc-route-push-gate.ts 的 incompleteLogLevel）----
// 2026-09-23 第四轮降噪：T3（tile ready 首推）时服务器计划尚未到达 → 必然判残缺，那是时序
// 产物、不是真问题（旧实现一律 console.warn → 每次打开 SFC 都刷一条无用警告，用户实机日志
// 里那条 500 字警告正是 T3 触发）。策略由真实纯函数决定，这里锁死两个方向：
//   serverPlanSeen=false（T3/T2，服务器计划还没到）→ 'debug'（不刷屏）；
//   serverPlanSeen=true（T1 表格刷新过，服务器计划已到）→ 'warn'（真问题）。
// 「残缺不写滑块」的语义不在这层：由 computeFtcPlan + missingModelInputs 锁定（见 ③/② 组）。
check('⑥ 残缺提示分级：T3 首推（服务器计划未到）静默，T1（表格已刷新）才 warn', f => {
  expectExact(f, 'T3/T2 → debug', gateModule.incompleteLogLevel(false), 'debug');
  expectExact(f, 'T1 → warn', gateModule.incompleteLogLevel(true), 'warn');
  // 负对照：级别只取决于「服务器计划是否到过」，不能有第三种输出（旧实现恒 warn）。
  expectCondition(
    f,
    '只有 debug/warn 两种级别',
    new Set([gateModule.incompleteLogLevel(false), gateModule.incompleteLogLevel(true)]).size === 2,
    "{'debug','warn'}",
    String(gateModule.incompleteLogLevel(true)),
  );
});

console.log(
  `\n截图实参复算：d = ${(DEPART_KM + APPROACH_KM) / 1e6}M km（原生记录）→ ` +
    `best.fuel = ${panelPure.best?.fuel}，STL = ${panelPure.best?.stlFuel}u；` +
    `面板当年显示的 580.7205u 来自已删除的自建轨道几何 + 已证伪的 C_F×f×d 口径` +
    `（2026-09-23 系内改为罐口径 0.98×罐×min(f,0.5)，与距离无关）。`,
);
console.log(`\nPASS ${summary.pass}/${summary.pass + summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
