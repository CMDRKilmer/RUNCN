// 原生 RT 生成（FLEET 向导）的「出发油量初始化」与「改档作废时长」回归脚本 —— 带退出码。
//
// 锁定的行为契约：
//   ① 油罐已读出（容量 > 0）时余量 0 是真空罐，必须原样传给 FTC（stlFuelOverride = 0）
//     与 BTF（fuel.stlFuel = 0）——变成 undefined 会被下游回退成满罐，算出一箱不存在的油；
//   ② 只有油罐读不出（容量也 = 0）才按未知处理（override = undefined）；
//   ③ 出发地有补油步骤时按罐容量起飞，与当前余量无关；
//   ④ 玩家手改某段档位后，本段与下游段（直到受影响油罐补满）的预计时长全部作废：
//     燃料档只影响 STL 罐、反应堆档只影响 FTL 罐（FTL 燃料 = 系数 × 反应堆档 × 距离）。
//
// 用法：node scripts/verify-native-route-settings.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
// 局限：ftc-compute / BTF 是替身（恒失败，只记录入参，见 scripts/lib/native-route-fuel-stub.mjs），
// 覆盖的是编排层的油量初始化与作废范围，不覆盖 FTC 模型数值与真实试飞。
import { register } from 'node:module';
register('./lib/native-route-fuel-loader.mjs', import.meta.url);
const { stubSetFuel, ftcCalls, btfCalls } = await import('./lib/native-route-fuel-stub.mjs');
const { computeNativeRouteFuel } = await import('../src/features/XIT/FLEET/native-route-fuel.ts');
const { hoursInvalidatedBySettingChange, percentAtLeast } =
  await import('../src/features/XIT/FLEET/native-route-plan.ts');

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

const candidate = {
  ship: { ship: { registration: 'T-1' } },
  plan: { loadOnDeparture: { weight: 0 }, loadOnReturn: { weight: 0 }, stops: [] },
};
const noRefuel = [
  { location: 'A', steps: [] },
  { location: 'B', steps: [] },
];
const refuelAtOrigin = [
  {
    location: 'A',
    steps: [
      { kind: 'refuel', tank: 'STL' },
      { kind: 'refuel', tank: 'FTL' },
    ],
  },
  { location: 'B', steps: [] },
];
// 替身 computeFtcPlan 恒失败：每段的调用顺序是 FTC → BTF → 公式估算，override 全程必须一致。
async function runFuel(waypoints) {
  await computeNativeRouteFuel(candidate, waypoints, new AbortController().signal, () => {});
  return {
    overrides: ftcCalls.map(x => x.stlFuelOverride),
    btf: btfCalls.map(x => ({ stlFuel: x.stlFuel, ftlFuel: x.ftlFuel })),
  };
}

await check('空罐已知：余量 0 原样透传给 FTC 与 BTF（不回退满罐）', async failures => {
  stubSetFuel({ stlRemaining: 0, ftlRemaining: 0, stlCap: 3000, ftlCap: 500 });
  const { overrides, btf } = await runFuel(noRefuel);
  expectEqual(failures, 'FTC/估算 override', [0, 0], overrides);
  expectEqual(failures, 'BTF 出发油量', [{ stlFuel: 0, ftlFuel: 0 }], btf);
});

await check('油罐读不出（容量也 0）：按未知处理（override = undefined）', async failures => {
  stubSetFuel({ stlRemaining: 0, ftlRemaining: 0, stlCap: 0, ftlCap: 0 });
  const { overrides, btf } = await runFuel(noRefuel);
  expectEqual(failures, 'FTC/估算 override', [undefined, undefined], overrides);
  expectEqual(failures, 'BTF 出发油量', [{ stlFuel: undefined, ftlFuel: undefined }], btf);
});

await check('出发地补油：按罐容量起飞，与当前余量无关', async failures => {
  stubSetFuel({ stlRemaining: 0, ftlRemaining: 0, stlCap: 3000, ftlCap: 500 });
  const { overrides, btf } = await runFuel(refuelAtOrigin);
  expectEqual(failures, 'FTC/估算 override', [3000, 3000], overrides);
  expectEqual(failures, 'BTF 出发油量', [{ stlFuel: 3000, ftlFuel: 500 }], btf);
});

await check('非零余量透传（控制组）', async failures => {
  stubSetFuel({ stlRemaining: 123, ftlRemaining: 45, stlCap: 3000, ftlCap: 500 });
  const { overrides, btf } = await runFuel(noRefuel);
  expectEqual(failures, 'FTC/估算 override', [123, 123], overrides);
  expectEqual(failures, 'BTF 出发油量', [{ stlFuel: 123, ftlFuel: 45 }], btf);
});

const fourStops = [
  { location: 'A', steps: [] },
  { location: 'B', steps: [] },
  { location: 'C', steps: [] },
  { location: 'D', steps: [] },
];
const stlRefuelAt2 = [
  { location: 'A', steps: [] },
  { location: 'B', steps: [] },
  { location: 'C', steps: [{ kind: 'refuel', tank: 'STL' }] },
  { location: 'D', steps: [] },
];

await check('改档作废：中途不补油时本段与全部下游时长作废', failures => {
  expectEqual(
    failures,
    'stale',
    [1, 2, 3],
    hoursInvalidatedBySettingChange(fourStops, 1, 4, ['STL']),
  );
});

await check('改档作废：受影响油罐补满后，下游时长保留', async failures => {
  expectEqual(
    failures,
    'stale',
    [1, 2],
    hoursInvalidatedBySettingChange(stlRefuelAt2, 1, 4, ['STL']),
  );
});

await check('改档作废：反应堆档只认 FTL 补油（STL 补油不停）', async failures => {
  expectEqual(
    failures,
    'stale',
    [1, 2, 3],
    hoursInvalidatedBySettingChange(stlRefuelAt2, 1, 4, ['FTL']),
  );
});

await check('改档作废：末段没有下游，只清本段', async failures => {
  expectEqual(failures, 'stale', [3], hoursInvalidatedBySettingChange(fourStops, 3, 4, ['STL']));
});

await check('写入档位向上取整：蓝图下限 0.653 不会写成 65%', async failures => {
  expectEqual(failures, '0.653 → ', 66, percentAtLeast(0.653, 0.653));
  expectEqual(failures, '0.65 → ', 65, percentAtLeast(0.65, 0));
  expectEqual(failures, '0.5 但下限 0.653 → ', 66, percentAtLeast(0.5, 0.653));
  expectEqual(failures, '下限 0.5（默认反应堆 50%）→ ', 50, percentAtLeast(0.5, 0.5));
  expectEqual(failures, '超过 1 → ', 100, percentAtLeast(1.2, 0));
});

console.log(`PASS ${summary.pass}/${summary.pass + summary.fail}`);
if (summary.fail > 0) {
  process.exit(1);
}
