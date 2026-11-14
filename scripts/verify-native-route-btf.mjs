// 原生 RT 向导（XIT RTWIZ）的 BTF 试飞回归脚本 —— 带退出码。
//
// 锁定的行为契约：
//   ① 出发油量读不出来时不发该字段：覆盖成 undefined 会顶掉 calculateTestFlight 的基线
//      默认值，回退成 0 又会让跨星系航线每一档都因跃迁没油被服务器拒绝；STL 缺容量时回退
//      蓝图容量（FTL 没有第二个来源，只能交给服务器默认值）；
//   ② 已知的空罐（容量 > 0、余量 0）仍按 0 传，不假装满油；
//   ③ 被拒绝的档位按服务器 plan.status 汇总成一行警告；
//   ④ 连续 2 档被拒且一条样本都没有时停止扫描（载荷与消耗对档位单调）；
//   ⑤ 有样本时照旧扫完整网格。
//
// 用法：node --experimental-strip-types scripts/verify-native-route-btf.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
// 局限：calculateTestFlight 是替身（见 scripts/lib/native-route-btf-stub.mjs），
// 服务器判定与 status 取值不在覆盖范围。
import { register } from 'node:module';
register('./lib/native-route-btf-loader.mjs', import.meta.url);
const { stubReset, requests } = await import('./lib/native-route-btf-stub.mjs');
const { measureNativeRouteFuel } = await import('../src/features/XIT/FLEET/native-route-btf.ts');

const summary = { pass: 0, fail: 0 };

async function check(name, fn) {
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

function expectEqual(failures, label, expected, actual) {
  const e = JSON.stringify(expected);
  const a = JSON.stringify(actual);
  if (e !== a) {
    failures.push(`${label} expected=${e} actual=${a}`);
  }
}

function expectTrue(failures, label, value) {
  if (!value) {
    failures.push(`${label} expected=true actual=false`);
  }
}

const candidate = {
  ship: {
    ship: {
      registration: 'T-1',
      blueprintNaturalId: 'bp-1',
      mass: 2500,
      operatingEmptyMass: 2000,
      condition: 1,
    },
    cargoStore: { weightLoad: 500 },
  },
  plan: { loadOnDeparture: { weight: 2000 }, loadOnReturn: { weight: 0 }, stops: [] },
};
const waypoints = [
  { location: 'HRT', steps: [] },
  { location: 'OT-442b', steps: [] },
];

const okPlan = { status: 'OK', segments: [] };
const rejectedPlan = { status: 'OVERWEIGHT', segments: [] };
const okPlans = count => Array.from({ length: count }, () => okPlan);

function measure(fuel) {
  return measureNativeRouteFuel(
    candidate,
    waypoints,
    [1],
    new AbortController().signal,
    () => {},
    fuel,
  );
}

await check('油量未知：FTL 字段整条不发、STL 回退蓝图容量', async failures => {
  stubReset({}, [okPlan]);
  await measure({ stlFuel: undefined, ftlFuel: undefined });
  expectEqual(failures, 'ftlFuel', '<missing>', requests[0].ftlFuel);
  expectEqual(failures, 'stlFuel', 3500, requests[0].stlFuel);
});

await check('已知空罐：0 原样传给服务器', async failures => {
  stubReset({ stlCap: 1500, stlRemaining: 0, ftlCap: 300, ftlRemaining: 0 }, [okPlan]);
  await measure({ stlFuel: 0, ftlFuel: 0 });
  expectEqual(failures, 'stlFuel', 0, requests[0].stlFuel);
  expectEqual(failures, 'ftlFuel', 0, requests[0].ftlFuel);
});

await check('载荷 = 计划舱载 + 船上现有货物；反应堆不低于蓝图下限', async failures => {
  stubReset({}, [okPlan]);
  await measure({});
  expectEqual(failures, 'payload', 2500, requests[0].payload);
  expectEqual(failures, 'reactorUsageFactor', 0.58, requests[0].reactorUsageFactor);
});

await check('全部被拒：状态进警告并在第 2 档后停止扫描', async failures => {
  stubReset({}, Array.from({ length: 10 }, () => rejectedPlan));
  const result = await measure({});
  expectEqual(failures, '请求数', 2, requests.length);
  expectEqual(failures, '实测航段', 0, result.legs.size);
  expectTrue(
    failures,
    '拒绝状态',
    result.warnings.some(w => w.includes('试飞被服务器拒绝（OVERWEIGHT ×2）')),
  );
  expectTrue(
    failures,
    '早停说明',
    result.warnings.some(w => w.includes('已停止扫描')),
  );
  expectTrue(
    failures,
    '无方案说明',
    result.warnings.some(w => w.includes('试飞没有可用方案')),
  );
});

await check('有样本时照旧扫完整网格', async failures => {
  stubReset({}, [rejectedPlan, ...okPlans(19)]);
  const result = await measure({});
  expectEqual(failures, '请求数', 20, requests.length);
  expectTrue(failures, '实测航段', result.legs.has(1));
  expectTrue(
    failures,
    '部分拒绝不影响已测档位',
    result.warnings.some(w => w.includes('不影响已测档位')),
  );
});

console.log(`\n${summary.fail === 0 ? 'PASS' : 'FAIL'} ${summary.pass}/${summary.pass + summary.fail}`);
process.exitCode = summary.fail === 0 ? 0 : 1;
