// FTC 燃料滑块/反应堆参数**持久化 key 版本 + 航线级键控**回归脚本 —— 带退出码，可自动判定成败。
//
// 背景（2026-09-23 两轮修复）：
//   ① v2 → v3（脏值作废）：退化 bug 期间残缺输入也走到了 setFtcFuelSlider，把退化值 `f = 1`
//      （以及同星系航线唯一档 `r = 1`）写进了 `.v2`。此后残缺航线虽已被 ftc-compute 门控
//      拦住（不写新值），SFC 仍从本共享 ref 读到 `.v2` 的旧值照写滑块 —— 用户日志
//      「set 燃料消耗 to 1」紧接「输入不完整…已跳过滑块写入」正是这个组合：写进滑块的 1
//      不是本次算出来的，是历史脏值。
//   ② v3 → v4（键语义：按船 → 按航线，2026-09-23 二次修订）：按船键控时一条船只有一个键，
//      船换了目的地而新航线算不出来（无原生几何 → 门控不写参数）时，该键上还留着**上一条
//      航线**的值，SFC 打开新航线后照样读到并写进新航线的滑块 —— 与 ① 完全独立的第二个
//      错误写入面（值本身合法，只是属于另一条航线）。键改为 `船|起点|终点|gw|nat`
//      （ftcRouteKey），旧值无法迁移：`.v3` 的键里没有航线信息，且 `f = 1`/`r = 1` 都是
//      **合法**取值（最快档 / 同星系航线反应堆网格只有 1），没有可靠判据把「合法 1」与
//      「脏 1」、或某个值属于哪条航线分开；persistedRef（src/utils/persisted-ref.ts）只做
//      JSON.parse 恢复，**不支持** rename / 迁移钩子 → 只能整体作废。
//
// 本脚本锁定的行为契约：
//   ① 载入时**不再读** `.v3`（脏值 / 跨航线旧值不会进入共享 ref → SFC 不会照写）；
//      ⚠️ 2026-09-23 复核修正：原 ① 用 `getFtcFuelSlider(SHIP, FROM, TO_A, false)` 当「旧船键
//      查询」，但四参签名下这三个实参正好等于 `.v4` fixture 的航线键 ROUTE_A —— 同一表达式
//      在同一 check 里既要求 undefined 又要求 0.35，**自相矛盾**（那是「按船键控」时代一参
//      `getFtcFuelSlider(ship)` 的残留断言，必然失败）。改为两条独立证据：①a 直接检查共享
//      ref 的键集合/键形状（v3 船键一格未进）；①b 抽走 `.v4`、只留 `.v3` 后重新载入模块 →
//      全部查不到（直接判定「实现里有没有读旧键的逻辑」，并带写入负对照防恒真）；
//   ② 载入时**仍然读** `.v4`（升级后重新写入的值照常恢复；只是历史值一次性作废）；
//   ③ 写入落到 `.v4`（新值仍能正常读写），且**从不回写** `.v3`（脏值不会被刷新/传染）；
//   ④ 扩展重载（同进程内二次导入 = 新模块实例）后，写下的值仍在（跨会话持久化）；
//   ⑤ 键是**航线级**的（见 ftcRouteKey）：同船不同航线互不可见 —— 写入航线 A 后读航线 B
//      必须得到 undefined（读到旧航线的值就会写错滑块，正是本轮修的 bug）；
//      网关标志也进键（同一对起终点的直飞与网关是两条航线）。
//
// 用法：node scripts/verify-ftc-slider-cache.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
// 局限：只覆盖「持久化 key 版本 + 航线键读写」这一段；SFC 写滑块的 DOM 路径在 Node 里不可加载
// （依赖 vue/DOM），由真实日志与代码审查覆盖（编排层侧的航线键写入/读不到由
// scripts/verify-ftc-route-key.mjs 驱动真实 computeFtcPlan 覆盖）。
import { register } from 'node:module';

const FUEL_V3 = 'rprun.ftc.fuel-slider.v3';
const FUEL_V4 = 'rprun.ftc.fuel-slider.v4';
const REACTOR_V3 = 'rprun.ftc.reactor-usage.v3';
const REACTOR_V4 = 'rprun.ftc.reactor-usage.v4';

// 航线键（与生产代码 ftcRouteKey 同格式；这里手写以显式锁定格式本身）。
const ROUTE_A = 'AVI-06JVV|ZV-307A|ANT|nat';
const ROUTE_A_GW = 'AVI-06JVV|ZV-307A|ANT|gw';
const ROUTE_B = 'AVI-06JVV|ZV-307A|HUB|nat';
const SHIP = 'AVI-06JVV';
const FROM = 'zv-307a';
const TO_A = 'ANT';
const TO_B = 'HUB';

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
function expectCondition(failures, label, ok, expectedText, actualText) {
  if (!ok) {
    failures.push(`expected=${expectedText} actual=${actualText} (${label})`);
  }
}
// 对象/数组断言走 JSON 逐位比较（Object.is 对引用类型永远不相等）。
function expectJson(failures, label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures.push(`expected=${e} actual=${a} (${label})`);
  }
}

// ---- localStorage 替身（必须在模块载入前装好：persistedRef 在 import 时就读 key）----
// `.v3` 里放的就是上一轮实机留下的值（退化期间写入的 `f = 1` / `r = 1`，键是船名）；
// `.v4` 里放一个升级后写入的航线值，用来证明「v4 仍会被恢复」。
const storage = new Map([
  [FUEL_V3, JSON.stringify({ [SHIP]: 1, 'STUB-01': 1 })],
  [REACTOR_V3, JSON.stringify({ [SHIP]: 1, 'STUB-01': 1 })],
  [FUEL_V4, JSON.stringify({ [ROUTE_A]: 0.35 })],
  [REACTOR_V4, JSON.stringify({ [ROUTE_A]: 0.6 })],
]);
const writes = [];
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => {
    writes.push(key);
    storage.set(key, value);
  },
};

register('./lib/ftc-fuel-settings-loader.mjs', import.meta.url);

const settings = await import('../src/features/XIT/FTC/ftc-fuel-settings.ts');

// ---- ①a 旧 `.v3` 不再被读到：共享 ref 里只有 `.v4` 的航线键 ----
check('①a 载入时忽略 .v3：共享 ref 只有 .v4 航线键，脏 f = 1 / r = 1 一格未进', f => {
  // v3 的两个船键（SHIP / STUB-01）都不许出现在共享 ref 的键空间里。
  expectJson(f, '共享 ref 的键（燃料）', Object.keys(settings.ftcFuelSliders.value), [ROUTE_A]);
  expectJson(f, '共享 ref 的键（反应堆）', Object.keys(settings.ftcReactorUsages.value), [ROUTE_A]);
  expectExact(
    f,
    '脏值 1 未进入燃料 ref',
    Object.values(settings.ftcFuelSliders.value).includes(1),
    false,
  );
  expectExact(
    f,
    '脏值 1 未进入反应堆 ref',
    Object.values(settings.ftcReactorUsages.value).includes(1),
    false,
  );
  expectExact(
    f,
    '船名不是 ref 的键（燃料）',
    Object.keys(settings.ftcFuelSliders.value).includes(SHIP),
    false,
  );
  expectExact(
    f,
    '船名不是 ref 的键（反应堆）',
    Object.keys(settings.ftcReactorUsages.value).includes('STUB-01'),
    false,
  );
  // 键形状：4 段（船|起点|终点|gw|nat）——有人回退成按船键控就会在这里失败。
  for (const key of Object.keys(settings.ftcFuelSliders.value)) {
    const parts = key.split('|');
    expectExact(f, `键形状 4 段（${key}）`, parts.length, 4);
    expectCondition(
      f,
      `尾段是 gw/nat（${key}）`,
      parts[3] === 'nat' || parts[3] === 'gw',
      'nat|gw',
      parts[3],
    );
    expectExact(f, `首段是船（${key}）`, parts[0], SHIP);
  }
  // 旧船键在**任何**查法下都拿不到东西（STUB-01 在 `.v3` 里有 1，在 `.v4` 里不存在）。
  expectExact(
    f,
    '旧船键查不到（燃料）',
    settings.getFtcFuelSlider('STUB-01', FROM, TO_A, false),
    undefined,
  );
  expectExact(
    f,
    '旧船键查不到（反应堆）',
    settings.getFtcReactorUsage('STUB-01', FROM, TO_A, false),
    undefined,
  );
  expectExact(
    f,
    '未计算过的船仍是 undefined',
    settings.getFtcFuelSlider('NEVER-SEEN', FROM, TO_A, false),
    undefined,
  );
  // 负对照：不是「函数整体失效」——`.v4` 的航线值照常恢复。
  expectExact(f, 'v4 值仍被恢复（燃料）', settings.getFtcFuelSlider(SHIP, FROM, TO_A, false), 0.35);
  expectExact(
    f,
    'v4 值仍被恢复（反应堆）',
    settings.getFtcReactorUsage(SHIP, FROM, TO_A, false),
    0.6,
  );
});

// ---- ①b 直接判定「实现里有没有读旧键的逻辑」：只留 `.v3`、抽走 `.v4` 后重新载入 ----
// 若实现存在 `.v3` / 按船键的兼容或回退分支，下面的读取必然拿到 1；只读 `.v4` 才全 undefined。
// 用独立 storage 做这次载入（不动主 storage），故不影响后面的 ③ 断言。
let legacyOnlyModule;
{
  const mainStorage = globalThis.localStorage;
  const legacyOnly = new Map([
    [FUEL_V3, JSON.stringify({ [SHIP]: 1, 'STUB-01': 1 })],
    [REACTOR_V3, JSON.stringify({ [SHIP]: 1, 'STUB-01': 1 })],
  ]);
  globalThis.localStorage = {
    getItem: key => legacyOnly.get(key) ?? null,
    setItem: (key, value) => legacyOnly.set(key, value),
  };
  try {
    legacyOnlyModule = await import('../src/features/XIT/FTC/ftc-fuel-settings.ts?legacy-only=1');
  } finally {
    globalThis.localStorage = mainStorage;
  }
}

check('①b 只留 .v3 时重新载入 → 全 undefined（实现只读 .v4，无按船/旧键回退）', f => {
  expectJson(f, '共享 ref（燃料）', legacyOnlyModule.ftcFuelSliders.value, {});
  expectJson(f, '共享 ref（反应堆）', legacyOnlyModule.ftcReactorUsages.value, {});
  expectExact(
    f,
    '本航线（燃料）',
    legacyOnlyModule.getFtcFuelSlider(SHIP, FROM, TO_A, false),
    undefined,
  );
  expectExact(
    f,
    '本航线（反应堆）',
    legacyOnlyModule.getFtcReactorUsage(SHIP, FROM, TO_A, false),
    undefined,
  );
  expectExact(
    f,
    '另一条航线（燃料）',
    legacyOnlyModule.getFtcFuelSlider(SHIP, FROM, TO_B, false),
    undefined,
  );
  expectExact(
    f,
    '另一艘船（燃料）',
    legacyOnlyModule.getFtcFuelSlider('STUB-01', FROM, TO_A, false),
    undefined,
  );
  // 负对照：排除「模块整体失效导致上面几条恒真」——同一实例写入后立刻读得到。
  legacyOnlyModule.setFtcFuelSlider(ROUTE_A, 0.42);
  expectExact(
    f,
    '负对照：写入后可读回',
    legacyOnlyModule.getFtcFuelSlider(SHIP, FROM, TO_A, false),
    0.42,
  );
});

// ---- ⑤ 航线级键：同船不同航线/不同网关标志互不可见 ----
check('⑤ 航线级键：同船换航线（或换网关标志）读不到另一条航线的值', f => {
  // `.v4` 里只有 ROUTE_A（ZV-307A|ANT|nat）的值。
  expectExact(
    f,
    '同船换终点 → undefined',
    settings.getFtcFuelSlider(SHIP, FROM, TO_B, false),
    undefined,
  );
  expectExact(
    f,
    '同船换终点（反应堆）→ undefined',
    settings.getFtcReactorUsage(SHIP, FROM, TO_B, false),
    undefined,
  );
  expectExact(
    f,
    '同航线但换网关标志 → undefined',
    settings.getFtcFuelSlider(SHIP, FROM, TO_A, true),
    undefined,
  );
  expectExact(
    f,
    '换船（同航线文本）→ undefined',
    settings.getFtcFuelSlider('STUB-01', FROM, TO_A, false),
    undefined,
  );
  // 大小写/空白归一：同一条航线必须命中同一个键（SFC 输入框大小写不稳定）。
  expectExact(
    f,
    '大小写归一命中',
    settings.getFtcFuelSlider(SHIP, ' ZV-307A ', 'ant', false),
    0.35,
  );
  // 空船名（未选中飞船）：不改滑块。
  expectExact(
    f,
    '船名 undefined',
    settings.getFtcFuelSlider(undefined, FROM, TO_A, false),
    undefined,
  );
});

// ---- ③ 写入落到 `.v4` ----
const writesBefore = writes.length;
settings.setFtcFuelSlider(ROUTE_B, 0.2);
settings.setFtcReactorUsage(ROUTE_B, 0.3);

check('③ 新值写入 .v4 并可读回（不做任何迁移/回退）', f => {
  expectExact(f, '读回燃料滑块', settings.getFtcFuelSlider(SHIP, FROM, TO_B, false), 0.2);
  expectExact(f, '读回反应堆使用量', settings.getFtcReactorUsage(SHIP, FROM, TO_B, false), 0.3);
  expectExact(f, '航线 A 的值不受影响', settings.getFtcFuelSlider(SHIP, FROM, TO_A, false), 0.35);
  expectJson(f, '落的 key（燃料）', JSON.parse(storage.get(FUEL_V4)), {
    [ROUTE_A]: 0.35,
    [ROUTE_B]: 0.2,
  });
  expectJson(f, '落的 key（反应堆）', JSON.parse(storage.get(REACTOR_V4)), {
    [ROUTE_A]: 0.6,
    [ROUTE_B]: 0.3,
  });
});

check('③ 从不回写 .v3（旧值不会被刷新，也不会被覆盖成新值冒充迁移）', f => {
  expectJson(f, '燃料 .v3 原样', JSON.parse(storage.get(FUEL_V3)), {
    [SHIP]: 1,
    'STUB-01': 1,
  });
  expectJson(f, '反应堆 .v3 原样', JSON.parse(storage.get(REACTOR_V3)), {
    [SHIP]: 1,
    'STUB-01': 1,
  });
  expectJson(
    f,
    '写入的 key 只有 v4',
    [...new Set(writes.slice(writesBefore))],
    [FUEL_V4, REACTOR_V4],
  );
});

check('③ 同值重复写入不再触发持久化（既有短路行为未变）', f => {
  const before = writes.length;
  settings.setFtcFuelSlider(ROUTE_B, 0.2);
  expectExact(f, '未新增写入', writes.length, before);
});

// ---- ④ 扩展重载后仍在（跨会话持久化）----
// 带查询串再导入一次 = 新模块实例（Node 的模块缓存按完整 URL 索引），
// 等价于扩展重新加载后 persistedRef 重新读 localStorage。
const reloaded = await import('../src/features/XIT/FTC/ftc-fuel-settings.ts?reload=1');

check('④ 重载后读回 .v4（跨会话持久化；.v3 旧值仍被忽略）', f => {
  expectExact(f, '燃料滑块（航线 A）', reloaded.getFtcFuelSlider(SHIP, FROM, TO_A, false), 0.35);
  expectExact(f, '燃料滑块（航线 B）', reloaded.getFtcFuelSlider(SHIP, FROM, TO_B, false), 0.2);
  expectExact(
    f,
    '反应堆使用量（航线 B）',
    reloaded.getFtcReactorUsage(SHIP, FROM, TO_B, false),
    0.3,
  );
  expectExact(
    f,
    '旧船键仍未恢复',
    reloaded.getFtcFuelSlider('STUB-01', FROM, TO_A, false),
    undefined,
  );
  expectExact(f, '网关标志仍区分', reloaded.getFtcFuelSlider(SHIP, FROM, TO_A, true), undefined);
});

console.log(`PASS ${summary.pass}/${summary.pass + summary.fail}`);
process.exit(summary.fail === 0 ? 0 : 1);
