// 原生 RT 生成（FLEET 向导）的「出发油量初始化」与「改档作废时长」回归脚本 —— 带退出码。
//
// 锁定的行为契约：
//   ① 油罐已读出（容量 > 0）时余量 0 是真空罐，必须原样传给 FTC（stlFuelOverride = 0）
//     与 BTF（fuel.stlFuel = 0）——变成 undefined 会被下游回退成满罐，算出一箱不存在的油；
//   ② 只有油罐读不出（容量也 = 0）才按未知处理（override = undefined）；
//   ③ 出发地有补油步骤时按罐容量起飞，与当前余量无关；
//   ④ 玩家手改某段档位后，本段与下游段（直到受影响油罐补满）的预计时长全部作废：
//     燃料档只影响 STL 罐、反应堆档只影响 FTL 罐（FTL 燃料 = 系数 × 反应堆档 × 距离）；
//   ⑤ 离港饱和点只用于模型口径，**不再砍写入的档位**：选中 30% 就写 30%，也不会报「封顶」。
//
// 用法：node --experimental-strip-types scripts/verify-native-route-settings.mjs
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
// 局限：公式入口和 BTF 使用替身，覆盖油量初始化、缺油停止、作废范围及档位写入。
// FTC 模型数值由 verify-ftc-formula.mjs 验证。
import { register } from 'node:module';
import assert from 'node:assert/strict';
register('./lib/native-route-fuel-loader.mjs', import.meta.url);
const { stubSetFuel, stubSetOption, ftcCalls, btfCalls } =
  await import('./lib/native-route-fuel-stub.mjs');
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
// 没有注入档位结果时，公式返回缺输入，FTC 与 BTF 应收到相同的油量。
async function runFuel(waypoints) {
  await computeNativeRouteFuel(candidate, waypoints, new AbortController().signal, () => {});
  return {
    overrides: ftcCalls.map(x => x.stlFuel),
    ftlOverrides: ftcCalls.map(x => x.ftlFuel),
    btf: btfCalls.map(x => ({ stlFuel: x.stlFuel, ftlFuel: x.ftlFuel })),
  };
}

await check('空罐已知：余量 0 原样透传给 FTC 与 BTF（不回退满罐）', async failures => {
  stubSetFuel({ stlRemaining: 0, ftlRemaining: 0, stlCap: 3000, ftlCap: 500 });
  const { overrides, ftlOverrides, btf } = await runFuel(noRefuel);
  expectEqual(failures, '每段一次公式规划（stlFuel 透传）', [0], overrides);
  expectEqual(failures, 'FTL 余量同样透传', [0], ftlOverrides);
  expectEqual(failures, 'BTF 出发油量', [{ stlFuel: 0, ftlFuel: 0 }], btf);
});

await check('油罐读不出（容量也 0）：按未知处理（override = undefined）', async failures => {
  stubSetFuel({ stlRemaining: 0, ftlRemaining: 0, stlCap: 0, ftlCap: 0 });
  const { overrides, btf } = await runFuel(noRefuel);
  expectEqual(failures, '每段一次公式规划（stlFuel 透传）', [undefined], overrides);
  expectEqual(failures, 'BTF 出发油量', [{ stlFuel: undefined, ftlFuel: undefined }], btf);
});

await check('出发地补油：按罐容量起飞，与当前余量无关', async failures => {
  stubSetFuel({ stlRemaining: 0, ftlRemaining: 0, stlCap: 3000, ftlCap: 500 });
  const { overrides, ftlOverrides, btf } = await runFuel(refuelAtOrigin);
  expectEqual(failures, '每段一次公式规划（stlFuel 透传）', [3000], overrides);
  expectEqual(failures, '补满后 FTL 余量也按罐容量透传', [500], ftlOverrides);
  expectEqual(failures, 'BTF 出发油量', [{ stlFuel: 3000, ftlFuel: 500 }], btf);
});

await check('非零余量透传（控制组）', async failures => {
  stubSetFuel({ stlRemaining: 123, ftlRemaining: 45, stlCap: 3000, ftlCap: 500 });
  const { overrides, ftlOverrides, btf } = await runFuel(noRefuel);
  expectEqual(failures, '每段一次公式规划（stlFuel 透传）', [123], overrides);
  expectEqual(failures, 'FTL 余量透传', [45], ftlOverrides);
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

await check('原样写入公式返回的整数档位与对应时长', async failures => {
  stubSetFuel({ stlRemaining: 3000, ftlRemaining: 500, stlCap: 3000, ftlCap: 500 });
  stubSetOption({
    reactorRelevant: true,
    best: { fuel: 0.05, reactor: 0.66, totalHours: 1, stlFuel: 100, ftlFuel: 10 },
  });
  const result = await computeNativeRouteFuel(
    candidate,
    noRefuel,
    new AbortController().signal,
    () => {},
  );
  expectEqual(failures, 'FTC 调用次数', 1, ftcCalls.length);
  expectEqual(failures, '按原生 RT 口径选点', 'value', ftcCalls[0]?.selection);
  expectEqual(
    failures,
    '实际写入档位及对应时长',
    {
      fuelPercent: 5,
      reactorPercent: 66,
      hours: 1,
    },
    result.legs[1],
  );
});

// 旧口径的「离港饱和点」已随新公式模型删除，编排层没有任何砍档逻辑：
// 这一条只锁定「选中多少就写多少、不报封顶」，不再假装喂流量（旧代码用空函数喂流量，断言恒真）。
await check('选中档位原样写入：不砍档、不报封顶', async failures => {
  stubSetFuel({ stlRemaining: 3000, ftlRemaining: 500, stlCap: 3000, ftlCap: 500 });
  stubSetOption({
    reactorRelevant: false,
    best: { fuel: 0.3, reactor: 0.5, totalHours: 2, stlFuel: 200, ftlFuel: 0 },
  });
  const result = await computeNativeRouteFuel(
    candidate,
    noRefuel,
    new AbortController().signal,
    () => {},
  );
  expectEqual(failures, '写入的燃料百分比', 30, result.legs[1]?.fuelPercent);
  expectEqual(
    failures,
    '不再出现封顶警告',
    false,
    result.warnings.some(x => x.includes('封顶')),
  );
});

await check('已确认油量不足的航段停止自动创建', async failures => {
  stubSetFuel({ stlRemaining: 3000, ftlRemaining: 50, stlCap: 3000, ftlCap: 500 });
  stubSetOption({
    reactorRelevant: true,
    best: { fuel: 0.04, reactor: 0.5, totalHours: 1, stlFuel: 100, ftlFuel: 40 },
  });
  const threeStops = [
    { location: 'A', steps: [] },
    { location: 'B', steps: [] },
    { location: 'C', steps: [] },
  ];
  await assert.rejects(
    computeNativeRouteFuel(candidate, threeStops, new AbortController().signal, () => {}),
    /B → C：FTL 缺 30 u/,
  );
  expectEqual(
    failures,
    '余量逐段递减',
    [50, 10],
    ftcCalls.map(x => x.ftlFuel),
  );
  expectEqual(failures, '不降级成试飞', 0, btfCalls.length);
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
