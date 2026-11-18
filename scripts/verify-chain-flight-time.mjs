// 用法：node --experimental-strip-types scripts/verify-chain-flight-time.mjs
// 环线各段预计飞行时间（真实模块 src/features/XIT/FLEET/chain-flight-time.ts 的行为契约）。
// 退出码：0 = 全部通过（末行 PASS n/n）；1 = 有失败（打印 FAIL <场景> expected=… actual=…）。
//
// 覆盖（切换新公式模型后的契约）：
//   ① 每段时长来自公式模型（正数、有限），到达时刻 = 出发时刻 + 时长；
//   ② 逐段起飞时刻 = 上一段到达时刻，总时长 = 各段之和；
//   ③ 判缺（地址/星图缺失）→ ok = false + 成因全文，绝不写成「0 小时且 ok」；
//   ④ 模型拒绝（缺蓝图）时同样标缺，而不是 0 小时；
//   ⑤ 起终点相同 → ok 且 0 小时，不依赖任何输入；
//   ⑥ includeEndpointHours 的出发/归航采样；
//   ⑦ 设了时间价值后不会比不设时更慢（成本最优趋快）。
//
// 注意：「缺飞船蓝图」用例会真实等待蓝图 6 s（与生产口径一致，替身 sleep 立即返回但
// 截止时间仍按墙钟走），整套约 6 s 属预期。
// 局限：公式数值本身由 verify-ftc-formula.mjs / verify-real-flight.mjs 覆盖；本脚本用
// scripts/lib/chain-flight-time-stub.mjs 注入 store/时钟/地址快照（见 loader 注释），
// 不覆盖滑块写入（chain-flight-time.ts 从不写滑块）。
import { register } from 'node:module';

register('./lib/chain-flight-time-loader.mjs', import.meta.url);

const stub = await import('./lib/chain-flight-time-stub.mjs');
const { estimateChainFlightTimes } = await import('../src/features/XIT/FLEET/chain-flight-time.ts');

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

function expect(failures, label, condition, detail) {
  if (!condition) {
    failures.push(`${label} ${detail}`);
  }
}

const ship = {
  registration: 'T-1',
  blueprintNaturalId: 'BP-TEST-0001',
  mass: 1200,
  operatingEmptyMass: 1000,
  condition: 1,
  stlFuelFlowRate: 0.015,
  reactorPower: 2400,
  acceleration: 20,
  thrust: 20000,
  volume: 1000,
  stlFuelStoreId: 'stl',
  ftlFuelStoreId: 'ftl',
};

const blueprint = {
  naturalId: 'BP-TEST-0001',
  performance: {
    acceleration: 20,
    accelerationMax: 1000,
    operatingEmptyMass: 1000,
    ftlFuelMaterial: { weight: 0.05 },
    stlFuelCapacity: 3000,
    ftlFuelCapacity: 500,
    storeCapacityWeight: 3000,
    totalVolume: 1000,
    ftlMaxSpeed: 0.0007,
    minReactorUsage: 0.1,
    emitterChargeTime: 100,
    maxOverchargeTime: 50,
  },
  selections: [
    {
      type: 'STL_ENGINE',
      option: 'STL_ENGINE_STANDARD',
      amount: 1,
      modifiers: [{ type: 'STL_USAGE', value: 0.015 }],
    },
    {
      type: 'FTL_REACTOR',
      option: 'FTL_REACTOR_STANDARD',
      amount: 1,
      modifiers: [{ type: 'FTL_POWER', value: 2400 }],
    },
  ],
};

const endpoint = (naturalId, semiMajorAxis) => ({
  naturalId,
  systemId: 'SYS-1',
  parentMassKg: 2e30,
  orbit: {
    semiMajorAxis,
    eccentricity: 0,
    inclination: 0,
    rightAscension: 0,
    periapsis: 0,
    mass: 0,
  },
});

// 系内两站（同恒星、不同轨道半径）：模型走单段 TRANSIT，不需要星图与起降环境。
const inputs = {
  orbit: {
    motionFactor: 20,
    simulationIntervalS: 86400,
    endpoints: [endpoint('A', 1e11), endpoint('B', 1.5e11)],
  },
  environment: [{}, {}],
  stars: [],
  gateways: [],
  gatewayConnections: [],
  gatewayEndpoints: {},
};

const addressOf = (naturalId, stationId) => `SYS1|STA,${stationId}`;

function useFixture({ stlRemaining = 3000, inputs: custom } = {}) {
  stub.stubReset();
  stub.stubSetShip(ship);
  stub.stubSetBlueprint(blueprint);
  stub.stubSetFuel({ stlRemaining, ftlRemaining: 0, stlCap: 3000, ftlCap: 500 });
  stub.stubSetNow(1_000_000);
  stub.stubSetInputs({
    input: custom ?? inputs,
    origin: addressOf('A', 'a'),
    destination: addressOf('B', 'b'),
    from: 'A',
    to: 'B',
  });
}

const stops = [{ naturalId: 'B', planetName: 'Station B' }];

await check('单段：时长来自公式模型，到达时刻 = 出发 + 时长', async failures => {
  useFixture();
  const est = await estimateChainFlightTimes({ ship, origin: 'A', stops });
  const leg = est.legs[0];
  expect(failures, 'ok', leg?.ok === true, `actual=${JSON.stringify(leg)}`);
  expect(
    failures,
    '时长有限且为正',
    Number.isFinite(leg.hours) && leg.hours > 0,
    `hours=${leg.hours}`,
  );
  expect(
    failures,
    '到达时刻',
    leg.arriveAtMs === leg.departAtMs + leg.hours * 3600000,
    `actual=${leg.arriveAtMs}`,
  );
  expect(failures, '起飞时刻 = 起始时刻', leg.departAtMs === 1_000_000, `actual=${leg.departAtMs}`);
  const sum = est.legs.reduce((total, x) => total + x.hours, 0);
  expect(
    failures,
    '总时长 = 各段之和',
    Math.abs(est.totalHours - sum) < 1e-9,
    `actual=${est.totalHours}`,
  );
  expect(
    failures,
    '输入按起点→站点调用',
    stub.state.loads[0]?.from === 'A',
    `actual=${stub.state.loads[0]?.from}`,
  );
});

await check('多段：逐段起飞时刻接上一段到达，环线含归航段', async failures => {
  useFixture();
  const est = await estimateChainFlightTimes({
    ship,
    origin: 'A',
    stops: [
      { naturalId: 'B', planetName: 'B' },
      { naturalId: 'A', planetName: 'A' },
    ],
  });
  expect(failures, '段数 = 站点数 + 1', est.legs.length === 3, `actual=${est.legs.length}`);
  for (let i = 1; i < est.legs.length; i++) {
    expect(
      failures,
      `第 ${i} 段起飞时刻`,
      est.legs[i].departAtMs === est.legs[i - 1].arriveAtMs,
      `expected=${est.legs[i - 1].arriveAtMs} actual=${est.legs[i].departAtMs}`,
    );
  }
  const sum = est.legs.reduce((total, leg) => total + (leg.ok ? leg.hours : 0), 0);
  expect(failures, '总时长', Math.abs(est.totalHours - sum) < 1e-9, `actual=${est.totalHours}`);
});

await check('判缺：地址/星图缺失时不写 0 小时，标出成因', async failures => {
  useFixture();
  stub.stubSetInputsError('无法解析起终点，请输入具体行星或空间站代号');
  const est = await estimateChainFlightTimes({ ship, origin: 'A', stops });
  const leg = est.legs[0];
  expect(failures, 'ok=false', leg.ok === false, `actual=${leg.ok}`);
  expect(failures, '时长为 0', leg.hours === 0, `actual=${leg.hours}`);
  expect(failures, '到达即出发', leg.arriveAtMs === leg.departAtMs, `actual=${leg.arriveAtMs}`);
  expect(
    failures,
    '成因全文',
    leg.missingInputs?.[0] === '无法解析起终点，请输入具体行星或空间站代号',
    `actual=${JSON.stringify(leg.missingInputs)}`,
  );
  expect(failures, '整体 ok=false', est.ok === false, `actual=${est.ok}`);
  expect(failures, '总时长 0', est.totalHours === 0, `actual=${est.totalHours}`);
});

await check('判缺：模型拒绝（无蓝图）时同样标缺而不是 0 小时', async failures => {
  useFixture();
  stub.stubSetBlueprint(undefined);
  const est = await estimateChainFlightTimes({ ship, origin: 'A', stops });
  const leg = est.legs[0];
  expect(failures, 'ok=false', leg.ok === false, `actual=${leg.ok}`);
  expect(
    failures,
    '成因',
    leg.missingInputs?.[0] === '飞船蓝图',
    `actual=${JSON.stringify(leg.missingInputs)}`,
  );
  expect(failures, 'error', leg.error === '缺规划输入', `actual=${leg.error}`);
});

await check('起终点相同：ok 且 0 小时，不依赖任何输入', async failures => {
  useFixture();
  stub.stubSetInputsError('不应被调用');
  const est = await estimateChainFlightTimes({
    ship,
    origin: 'A',
    stops: [{ naturalId: 'A', planetName: 'A' }],
  });
  expect(
    failures,
    '两段都 ok',
    est.legs.every(x => x.ok),
    `actual=${JSON.stringify(est.legs)}`,
  );
  expect(
    failures,
    '时长为 0',
    est.legs.every(x => x.hours === 0),
    `actual=${est.legs.map(x => x.hours)}`,
  );
  expect(failures, '未读输入', stub.state.loads.length === 0, `actual=${stub.state.loads.length}`);
});

await check('includeEndpointHours：出发/归航各站采样', async failures => {
  useFixture();
  const est = await estimateChainFlightTimes({
    ship,
    origin: 'A',
    stops: [{ naturalId: 'B', planetName: 'B' }],
    includeEndpointHours: true,
    startAtMs: 500,
  });
  expect(
    failures,
    'outbound 长度',
    est.endpointHours?.outbound.length === 1,
    `actual=${JSON.stringify(est.endpointHours)}`,
  );
  expect(
    failures,
    'inbound 长度',
    est.endpointHours?.inbound.length === 1,
    `actual=${JSON.stringify(est.endpointHours)}`,
  );
  expect(
    failures,
    'outbound 都是正时长',
    est.endpointHours.outbound.every(x => Number.isFinite(x) && x > 0),
    `actual=${JSON.stringify(est.endpointHours.outbound)}`,
  );
});

await check('时间价值：成本最优不会比平衡点更慢', async failures => {
  useFixture();
  const balanced = await estimateChainFlightTimes({ ship, origin: 'A', stops });
  const urgent = await estimateChainFlightTimes({
    ship,
    origin: 'A',
    stops,
    stlPrice: 5,
    ftlPrice: 500,
    timeValue: 1_000_000,
  });
  expect(
    failures,
    'urgent ≤ balanced',
    urgent.legs[0].hours <= balanced.legs[0].hours + 1e-9,
    `balanced=${balanced.legs[0].hours} urgent=${urgent.legs[0].hours}`,
  );
});

console.log(
  summary.fail === 0
    ? `PASS ${summary.pass}/${summary.pass}`
    : `FAIL ${summary.pass}/${summary.pass + summary.fail}`,
);
process.exitCode = summary.fail === 0 ? 0 : 1;
