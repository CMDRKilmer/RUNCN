// XIT GOVH 会话快照缓存回归（PR #60 审查 P2 两条）。
//
// 锁定的行为契约：
//   ① 缓存失效时刻 = min(savedAt + 5 分钟 TTL, 本期人口报告结束时刻)：
//      报告标签的取整精度算进剩余寿命，跨周期数据不得被重开面板复用。
//   ② 整星基地数随快照缓存，且 COMG 异步返回后可单独补写，不重置 TTL / 报告期限。
//   ③ 旧格式、脏数据、星球不匹配、TTL 或报告期到期一律视为未命中并清理条目。
//
// 用法：node --experimental-strip-types scripts/verify-govh-cache.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL 与 expected/actual）。
// 直接 import 真实 govh-cache.ts；registerHooks 只补生产代码里打包器才认识的无扩展
// 导入路径，不替换任何生产逻辑。sessionStorage 与时钟为每例自备的桩。
// 局限：Vue SFC 的恢复赋值无法在此运行时驱动，末尾只做源码级断言；
//       面板行为仍需实机打开 XIT GOVH 复测。

import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const REPORT_AGE = new URL('../src/features/XIT/GOVH/govh-report-age.ts', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === './govh-report-age') {
      return { url: REPORT_AGE, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const cache = await import('../src/features/XIT/GOVH/govh-cache.ts');
const realNow = Date.now;
const KEY = 'rprun.govh.snapshot.v1.VH-192B';
const BASE_TIME = 1_800_000_000_000;

function makeEnv() {
  const store = new Map();
  const removed = [];
  globalThis.sessionStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
      removed.push(key);
    },
  };
  let clock = BASE_TIME;
  Date.now = () => clock;
  return {
    advance(ms) {
      clock += ms;
    },
    raw(key) {
      return store.get(key);
    },
    has(key) {
      return store.has(key);
    },
    removed,
    putRaw(key, value) {
      store.set(key, value);
    },
  };
}

function snapshot(label, planet = 'VH-192B') {
  return {
    planet,
    population: {},
    happiness: {},
    fulfillment: {},
    fulfillmentText: {},
    reportRows: [],
    reportLabel: label,
  };
}

const summary = { pass: 0, fail: 0 };

function check(name, fn) {
  const env = makeEnv();
  const failures = [];
  try {
    fn(env, failures);
  } catch (e) {
    failures.push(`抛出异常 ${String(e)}`);
  } finally {
    Date.now = realNow;
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
    failures.push(`${label}: expected=${expected} actual=${actual}`);
  }
}

check('正常报告：按 5 分钟 TTL 定失效时刻，并保存基地数', (env, failures) => {
  cache.writeCachedSnapshot('VH-192B', snapshot('报告#43/5天 13小时前'), 7);
  const parsed = JSON.parse(env.raw(KEY));
  expectExact(failures, 'savedAt', parsed.savedAt, BASE_TIME);
  expectExact(failures, 'TTL 期限', parsed.endsAt - parsed.savedAt, 300000);
  expectExact(failures, '基地数', parsed.planetBaseCount, 7);
});

check('本期报告剩余不足 5 分钟：以报告到期为准', (env, failures) => {
  // 7 天 = 10080 分钟；10075 分钟前 + 1 分钟精度 → 剩 4 分钟。
  cache.writeCachedSnapshot('VH-192B', snapshot('报告#43/10075分钟前'));
  const parsed = JSON.parse(env.raw(KEY));
  expectExact(failures, '报告期限', parsed.endsAt - parsed.savedAt, 240000);
});

check('报告即将 rollover（6天 23小时前）：不写缓存', (env, failures) => {
  cache.writeCachedSnapshot('VH-192B', snapshot('报告#43/6天 23小时前'));
  expectExact(failures, '未写条目', env.has(KEY), false);
  expectExact(failures, '读取结果', cache.readCachedSnapshot('VH-192B'), undefined);
});

check('报告标签解析不出来：不写缓存', (env, failures) => {
  cache.writeCachedSnapshot('VH-192B', snapshot('刚刚'));
  expectExact(failures, '未写条目', env.has(KEY), false);
  expectExact(failures, '读取结果', cache.readCachedSnapshot('VH-192B'), undefined);
});

check('有效缓存：返回快照与全部元数据', (env, failures) => {
  const snap = snapshot('报告#43/5天 13小时前');
  cache.writeCachedSnapshot('VH-192B', snap, 4);
  const cached = cache.readCachedSnapshot('VH-192B');
  expectExact(failures, '命中', cached !== undefined, true);
  expectExact(failures, '星球', cached?.snapshot.planet, 'VH-192B');
  expectExact(failures, '基地数', cached?.planetBaseCount, 4);
  expectExact(failures, '失效时刻', cached?.endsAt, BASE_TIME + 300000);
});

check('TTL 到期：读取为未命中并删除条目', (env, failures) => {
  cache.writeCachedSnapshot('VH-192B', snapshot('报告#43/5天 13小时前'));
  env.advance(300001);
  expectExact(failures, '读取结果', cache.readCachedSnapshot('VH-192B'), undefined);
  expectExact(failures, '条目已删', env.has(KEY), false);
  expectExact(failures, '删除记录', env.removed.includes(KEY), true);
});

check('报告期早于 TTL 到期：读取为未命中', (env, failures) => {
  cache.writeCachedSnapshot('VH-192B', snapshot('报告#43/10075分钟前'));
  env.advance(240001);
  expectExact(failures, '读取结果', cache.readCachedSnapshot('VH-192B'), undefined);
  expectExact(failures, '条目已删', env.has(KEY), false);
});

check('旧格式缓存（无 endsAt）：拒绝并清理', (env, failures) => {
  env.putRaw(
    KEY,
    JSON.stringify({ snapshot: snapshot('报告#43/5天 13小时前'), savedAt: BASE_TIME }),
  );
  expectExact(failures, '读取结果', cache.readCachedSnapshot('VH-192B'), undefined);
  expectExact(failures, '条目已删', env.has(KEY), false);
});

check('基地数脏数据（字符串）：拒绝并清理', (env, failures) => {
  env.putRaw(
    KEY,
    JSON.stringify({
      snapshot: snapshot('报告#43/5天 13小时前'),
      savedAt: BASE_TIME,
      endsAt: BASE_TIME + 300000,
      planetBaseCount: '7',
    }),
  );
  expectExact(failures, '读取结果', cache.readCachedSnapshot('VH-192B'), undefined);
  expectExact(failures, '条目已删', env.has(KEY), false);
});

check('快照星球与请求不符：拒绝并清理', (env, failures) => {
  env.putRaw(
    KEY,
    JSON.stringify({
      snapshot: snapshot('报告#43/5天 13小时前', 'QQ-001A'),
      savedAt: BASE_TIME,
      endsAt: BASE_TIME + 300000,
    }),
  );
  expectExact(failures, '读取结果', cache.readCachedSnapshot('VH-192B'), undefined);
  expectExact(failures, '条目已删', env.has(KEY), false);
});

check('异步补写基地数：只改该字段，不动快照与期限', (env, failures) => {
  const snap = snapshot('报告#43/5天 13小时前');
  cache.writeCachedSnapshot('VH-192B', snap, 2);
  env.advance(10000);
  cache.writeCachedBaseCount('VH-192B', 9);
  const parsed = JSON.parse(env.raw(KEY));
  expectExact(failures, 'savedAt 不变', parsed.savedAt, BASE_TIME);
  expectExact(failures, 'endsAt 不变', parsed.endsAt, BASE_TIME + 300000);
  expectExact(failures, '新基地数', parsed.planetBaseCount, 9);
  expectExact(failures, '快照星球', parsed.snapshot.planet, 'VH-192B');
  expectExact(failures, '读取结果', cache.readCachedSnapshot('VH-192B')?.planetBaseCount, 9);
});

check('补写基地数不得延长 TTL', (env, failures) => {
  cache.writeCachedSnapshot('VH-192B', snapshot('报告#43/5天 13小时前'));
  env.advance(200000);
  cache.writeCachedBaseCount('VH-192B', 3);
  env.advance(100001);
  expectExact(failures, '总时长已过 5 分钟', Date.now() - BASE_TIME, 300001);
  expectExact(failures, '读取结果', cache.readCachedSnapshot('VH-192B'), undefined);
});

check('COMG 读取失败：不覆盖缓存里已有的基地数', (env, failures) => {
  cache.writeCachedSnapshot('VH-192B', snapshot('报告#43/5天 13小时前'), 6);
  env.advance(10000);
  cache.writeCachedBaseCount('VH-192B', undefined);
  expectExact(failures, '保留旧值', cache.readCachedSnapshot('VH-192B')?.planetBaseCount, 6);
  expectExact(failures, 'savedAt 不变', JSON.parse(env.raw(KEY)).savedAt, BASE_TIME);
});

check('缓存不存在时补写基地数：不创建条目', (env, failures) => {
  cache.writeCachedBaseCount('VH-192B', 8);
  expectExact(failures, '未写条目', env.has(KEY), false);
});

check('星球编码大小写与空格归一：同一条缓存', (env, failures) => {
  cache.writeCachedSnapshot('vh-192b', snapshot('报告#43/5天 13小时前'), 5);
  expectExact(failures, '写入键', env.has(KEY), true);
  expectExact(failures, '读取结果', cache.readCachedSnapshot(' VH-192B ')?.planetBaseCount, 5);
});

check('SFC 源码：缓存挂载恢复基地数、补读与回写齐全', (_env, failures) => {
  const source = readFileSync(
    new URL('../src/features/XIT/GOVH/GOVH.vue', import.meta.url),
    'utf8',
  );
  expectExact(
    failures,
    '恢复赋值',
    source.includes('planetBaseCount.value = cached.planetBaseCount;'),
    true,
  );
  expectExact(
    failures,
    '异步回写',
    source.includes('writeCachedBaseCount(planet, count?.total);'),
    true,
  );
  expectExact(
    failures,
    '星球标记',
    source.includes('lastBaseCountPlanet = planet.toUpperCase();'),
    true,
  );
  expectExact(
    failures,
    '写入带上已知值',
    source.includes('writeCachedSnapshot(planet, snap, planetBaseCount.value);'),
    true,
  );
  expectExact(
    failures,
    '缺值补读',
    source.includes('void refreshBaseCount(planetInput.value.trim(), false, loadSeq);'),
    true,
  );
});

console.log(`PASS ${summary.pass}/${summary.pass + summary.fail}`);
if (summary.fail > 0) {
  process.exitCode = 1;
}
