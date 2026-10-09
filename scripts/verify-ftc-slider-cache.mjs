// FTC 参数持久化版本与航线级键回归。
// 契约：只读写当前版本；键包含船、起点、终点和模式；旧版本不可回退读取。
// 用法：node scripts/verify-ftc-slider-cache.mjs
// 退出码：0 = 全部通过；1 = 存在失败。
// 局限：只覆盖持久化键空间，DOM 写入由其他回归覆盖。

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
