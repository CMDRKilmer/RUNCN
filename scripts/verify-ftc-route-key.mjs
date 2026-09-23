// FTC 参数**航线级键控**（任务 B）回归脚本 —— 带退出码，可自动判定成败。
//
// 背景（2026-09-23，两轮修复中的第二项）：
//   `rprun.ftc.fuel-slider.v3` 的键只有 `ship`。船换了目的地而新航线算不出来时
//   （无原生几何 → ftc-compute 门控不写参数），同一个键上还留着**上一条航线**的值，
//   SFC 打开新航线后照样读到它并写进新航线的滑块 —— 值本身合法（甚至可能就是上一条
//   航线的最优值），只是属于另一条航线。键改成 `船|起点|终点|gw|nat`（ftcRouteKey，
//   与 computeFtcPlan 写进 lastFtcCompute.key 的键逐位一致）后，不同航线互不可见：
//   读不到就是 undefined → SFC 不改滑块（与既有的「残缺不写」路径同一行为）。
//
// 本脚本锁定的行为契约（4 条验收用例）：
//   ① 航线 A 算出 0.2 → 按航线键写入 `.v4`，且键与 lastFtcCompute.key 逐位一致；
//   ② 同船换到航线 B（B 无原生几何）→ 读不到航线 A 的值（undefined）→ 不写滑块
//      （`.v4` 里不出现 B 的键）；
//   ③ 航线 B 数据到位（原生 STL 段入库）后重算 → 写入 B 自己的值，A 的值不受影响；
//   ④ 同船同航线再算一次（同值）→ setFtcFuelSlider 同值短路，不重复写 localStorage。
//
// 用法：node scripts/verify-ftc-route-key.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
// 局限：驱动的是真实编排层 + 真实 ftc-fuel-settings + 真实 route-planner/route-model，
// 但几何侧 store（stlSegmentsStore/stationsStore/buffers）走替身（`scripts/lib/
// ftc-geometry-stub.mjs`，与 verify-ftc-geometry-source.mjs 同源）；SFC 磁贴的
// `tileRoutes` 上下文（DOM 侧接线）在 Node 里不可加载，由
// scripts/verify-ftc-slider-cache.mjs（键空间）+ 代码审查覆盖。
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

// ---- 浏览器侧全局替身（真实 ftc-fuel-settings 的 persistedRef 需要 localStorage）----
const FUEL_V4 = 'rprun.ftc.fuel-slider.v4';
const REACTOR_V4 = 'rprun.ftc.reactor-usage.v4';
const storage = new Map();
const writes = [];
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => {
    writes.push(key);
    storage.set(key, value);
  },
};
globalThis.window = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
};
globalThis.ref = value => ({ value });
globalThis.config = {
  url: {
    stlSegments: 'https://stub.invalid/stl-segments.json',
    planetEnv: 'https://stub.invalid/planet-env.json',
  },
};
globalThis.fetch = async () => ({ json: async () => ({}) });

register('./lib/ftc-route-key-loader.mjs', import.meta.url);

const settings = await import('../src/features/XIT/FTC/ftc-fuel-settings.ts');
const { computeFtcPlan, lastFtcCompute } = await import('../src/features/XIT/FTC/ftc-compute.ts');
const stub = await import('./lib/ftc-geometry-stub.mjs');

// 截图实测航线 A：zv-307a → ANT（同星系；几何数值 68.0562M + 33.6491M 来自面板的**模型估算**行）。
const SHIP = 'STUB-01';
const FROM = 'zv-307a';
const TO_A = 'ANT';
const TO_B = 'ZV-307c'; // ZV-307 里的另一个天体（SFC 里是可解析目的地，但还没有原生记录）
const KEY_A = 'STUB-01|ZV-307A|ANT|nat';
const KEY_B = 'STUB-01|ZV-307A|ZV-307C|nat';

const persisted = key => {
  const raw = storage.get(key);
  return raw === undefined ? undefined : JSON.parse(raw);
};

const runCompute = to =>
  computeFtcPlan({
    shipRegistration: SHIP,
    from: FROM,
    to,
    browse: false,
    stlPrice: 0,
    ftlPrice: 0,
    timeValue: 0,
  });

// 每条 check 自带几何环境（不依赖上一条的残留状态：单跑/乱序都不漂移）。
function prepareA() {
  stub.stubClearStlRecords();
  stub.stubSetSameSystemRecord(FROM, TO_A, {
    depart: { distanceKm: DEPART_KM, seconds: 4481 },
    approach: { distanceKm: APPROACH_KM, seconds: 1345 },
  });
  stub.stubSetShip(stub.STUB_SHIP);
  stub.stubSetBlueprint(stub.stubBlueprint());
}

// ---- ① 航线 A：算出 0.15 → 按航线键写入 ----
const writesBeforeA = writes.length;
await checkAsync('① 航线 A（ZV-307a → ANT）算出 f = 0.15 → 写入航线键（.v4）', async f => {
  prepareA();
  const out = await runCompute(TO_A);
  expectExact(f, 'ok', out.ok, true);
  expectExact(f, 'inputIncomplete', out.inputIncomplete, undefined);
  expectExact(f, 'best.fuel', out.best?.fuel, 0.15);
  // 系内燃料 = 0.98×罐 3500×min(0.15,0.5) = 514.5u（2026-09-23 罐口径，与距离无关）。
  expectClose(f, 'STL 燃料（截图实参复算）', out.best?.stlFuel, 514.5, 0.5);
  // 键格式：ftcRouteKey(船, 起点, 终点, 网关) —— 起终点 trim + 大写归一。
  expectExact(f, '读回（航线键）', settings.getFtcFuelSlider(SHIP, FROM, TO_A, false), 0.15);
  expectExact(
    f,
    '读回（大小写/空白归一后命中同一键）',
    settings.getFtcFuelSlider(SHIP, ' ZV-307A ', 'ant', false),
    0.15,
  );
  expectExact(f, 'lastFtcCompute.key', lastFtcCompute.value?.key, KEY_A);
  expectExact(f, '落盘的燃料键值', persisted(FUEL_V4)?.[KEY_A], 0.15);
  expectCondition(
    f,
    '落盘只有 .v4（未回写旧版本键）',
    writes.slice(writesBeforeA).every(k => k === FUEL_V4 || k === REACTOR_V4),
    `仅 ${FUEL_V4} / ${REACTOR_V4}`,
    [...new Set(writes.slice(writesBeforeA))].join(','),
  );
});

// ---- ② 同船换航线 B（B 无几何）→ 读不到 A 的值 → 不写滑块 ----
await checkAsync('② 同船换航线 B（无几何）→ 读不到航线 A 的值 → 不写滑块', async f => {
  // 航线 A 的记录仍在（负对照：A 的值确实还躺着，但按 B 的键读不到）。
  prepareA();
  const writesBefore = writes.length;
  const out = await runCompute(TO_B);
  expectExact(f, 'ok', out.ok, true);
  expectCondition(
    f,
    'inputIncomplete 非空（B 无原生几何）',
    (out.inputIncomplete?.length ?? 0) > 0,
    '>0 条',
    '0 条',
  );
  // ★ 本轮的修复目标：按 B 的键读 → undefined（修复前按船读会拿到 A 的 0.2）。
  expectExact(f, '航线 B 读不到值', settings.getFtcFuelSlider(SHIP, FROM, TO_B, false), undefined);
  expectExact(
    f,
    '航线 A 的值仍在（对照）',
    settings.getFtcFuelSlider(SHIP, FROM, TO_A, false),
    0.15,
  );
  expectExact(f, '落盘里没有 B 的键', persisted(FUEL_V4)?.[KEY_B], undefined);
  expectExact(f, '未新增任何持久化写入', writes.length, writesBefore);
});

// ---- ③ 航线 B 数据到位后写入自己的值，A 不受影响 ----
await checkAsync('③ 航线 B 数据到位 → 写入 B 自己的值，A 不受影响', async f => {
  prepareA();
  // 服务器为 B 下发原生 STL 段（同星系键 = 出发天体|目标天体）。
  // ⚠️ 2026-09-23 口径标定后系内燃料 = 0.98×罐×min(f,0.5)（与距离无关）→ 以前靠「B 比 A
  // 长得多 → 档位不同」区分 A/B 的方式不再成立（同船同罐下两者会算出同一个 f）。
  // 改为用**不同罐容量**区分：B 用小型罐 1500 → 燃料 1470×min(f,0.5)，最优档位与 A 不同，
  // 这样「B 用的是自己的值」在输出里仍然肉眼可辨。
  stub.stubSetSameSystemRecord(FROM, TO_B, {
    depart: { distanceKm: 200e6, seconds: 1800 },
    approach: { distanceKm: 50e6, seconds: 900 },
  });
  stub.stubSetBlueprint(stub.stubBlueprint(1500));
  const out = await runCompute(TO_B);
  expectExact(f, 'inputIncomplete', out.inputIncomplete, undefined);
  const valueB = settings.getFtcFuelSlider(SHIP, FROM, TO_B, false);
  expectCondition(f, 'B 有自己的值', typeof valueB === 'number' && valueB > 0, '>0', `${valueB}`);
  expectExact(f, 'B 的值与 best.fuel 一致', valueB, out.best?.fuel);
  expectExact(f, 'A 的值不变', settings.getFtcFuelSlider(SHIP, FROM, TO_A, false), 0.15);
  expectExact(f, '落盘 B 键', persisted(FUEL_V4)?.[KEY_B], valueB);
  expectExact(f, '落盘 A 键不变', persisted(FUEL_V4)?.[KEY_A], 0.15);
  // 恢复 A 的蓝图（罐 3500），避免影响后续用例。
  stub.stubSetBlueprint(stub.stubBlueprint());
});

// ---- ④ 同船同航线再算一次（同值）→ 不重复写 ----
await checkAsync('④ 同船同航线重复计算（同值）→ 不重复写 localStorage', async f => {
  const before = writes.length;
  const out = await runCompute(TO_B);
  expectExact(f, 'inputIncomplete', out.inputIncomplete, undefined);
  expectExact(
    f,
    '两次 best.fuel 相同',
    out.best?.fuel,
    settings.getFtcFuelSlider(SHIP, FROM, TO_B, false),
  );
  expectExact(f, '未新增持久化写入（同值短路）', writes.length, before);
});

console.log(
  `\n航线键证据：A = ${KEY_A}（f = ${persisted(FUEL_V4)?.[KEY_A]}）、B = ${KEY_B}（f = ${persisted(FUEL_V4)?.[KEY_B]}）；` +
    `落盘键 = ${Object.keys(persisted(FUEL_V4) ?? {}).join(' , ')}`,
);
console.log(`PASS ${summary.pass}/${summary.pass + summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
