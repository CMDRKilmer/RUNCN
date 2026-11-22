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
//   ⑦ 设了时间价值后不会比不设时更慢（成本最优趋快）；
//   ⑧ 逐段 SF/FF 实耗 = 出发油量 − 到达余量（真实模型给出余量，不是占位 0），并与
//      fuelPerRound 的每轮燃料对账。
//
// 注意：「缺飞船蓝图」用例会真实等待蓝图 6 s（与生产口径一致，替身 sleep 立即返回但
// 截止时间仍按墙钟走），整套约 6 s 属预期。
// 局限：公式数值本身由 verify-ftc-formula.mjs / verify-real-flight.mjs 覆盖；本脚本用
// scripts/lib/chain-flight-time-stub.mjs 注入 store/时钟/地址快照（见 loader 注释），
// 不覆盖滑块写入（chain-flight-time.ts 从不写滑块）。
import { register } from 'node:module';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

register('./lib/chain-flight-time-loader.mjs', import.meta.url);

const stub = await import('./lib/chain-flight-time-stub.mjs');
const { estimateChainFlightTimes, chainShipFuelCaps } =
  await import('../src/features/XIT/FLEET/chain-flight-time.ts');
const { fuelPerRound } = await import('../src/features/XIT/FLEET/native-route-loop.ts');
const { planFormulaFlight } = await import('../src/features/XIT/FTC/formula-plan.ts');
const recorded = JSON.parse(readFileSync(new URL('./fixtures/ftc-formula.json', import.meta.url)));

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

await check('逐段 SF 实耗 = 出发油量 − 到达余量，与每轮燃料对账', async failures => {
  useFixture({ stlRemaining: 3000 });
  const est = await estimateChainFlightTimes({
    ship,
    origin: 'A',
    stops: [
      { naturalId: 'B', planetName: 'B' },
      { naturalId: 'A', planetName: 'A' },
    ],
  });
  const legs = est.legs;
  const used = legs.map(x => x.stlUsed);
  expect(
    failures,
    '三段都 ok',
    legs.every(x => x.ok),
    `actual=${JSON.stringify(legs.map(x => x.ok))}`,
  );
  expect(
    failures,
    '每段都写数值实耗',
    used.every(v => Number.isFinite(v)),
    `actual=${JSON.stringify(used)}`,
  );
  expect(
    failures,
    '去程与归程都耗油',
    used[0] > 0 && used[1] > 0,
    `actual=${JSON.stringify(used)}`,
  );
  expect(
    failures,
    '实耗取自余量差值（小于满罐 3000，不是拿满罐顶替）',
    used[0] < 3000,
    `actual=${used[0]}`,
  );
  expect(
    failures,
    '起终点相同的段实耗为 0',
    legs[est.legs.length - 1].stlUsed === 0,
    `actual=${legs[est.legs.length - 1].stlUsed}`,
  );
  const stlSum = used.reduce((total, v) => total + v, 0);
  const perRound = fuelPerRound(legs, chainShipFuelCaps(ship));
  expect(
    failures,
    '每轮 SF = 各段实耗之和',
    perRound.stl === stlSum && stlSum > 0,
    `expected=${stlSum} actual=${perRound.stl}`,
  );
  // 系内单段时间飞行不耗 FTL：模型给出 0 余量差，每轮 FF 就该是 0，不能落到「缺段回退罐容量」。
  expect(
    failures,
    '系内不耗 FF（每轮 FF = 0，未回退罐容量）',
    perRound.ftl === 0,
    `actual=${perRound.ftl}`,
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

await check('出发地默认补满：空罐仍按罐容量算出时长', async failures => {
  useFixture({ stlRemaining: 0 });
  const est = await estimateChainFlightTimes({ ship, origin: 'A', stops });
  const leg = est.legs[0];
  expect(failures, 'ok', leg?.ok === true, `actual=${JSON.stringify(leg)}`);
  expect(
    failures,
    '时长有限且为正',
    Number.isFinite(leg.hours) && leg.hours > 0,
    `hours=${leg.hours}`,
  );
});

await check('refuelAtOrigin=false：少油按当前余量出发（更慢或判缺）', async failures => {
  useFixture({ stlRemaining: 300 });
  const full = await estimateChainFlightTimes({ ship, origin: 'A', stops });
  const dry = await estimateChainFlightTimes({
    ship,
    origin: 'A',
    stops,
    refuelAtOrigin: false,
  });
  const leg = dry.legs[0];
  expect(
    failures,
    '不补油不会比补满更快',
    leg.ok === false || leg.hours > full.legs[0].hours,
    `full=${full.legs[0].hours} dry=${leg.hours} ok=${leg.ok}`,
  );
});

await check('逐段载重参与时长：重载航段不会更快', async failures => {
  useFixture();
  const empty = await estimateChainFlightTimes({
    ship,
    origin: 'A',
    stops,
    legPayloads: [0, 0],
  });
  const loaded = await estimateChainFlightTimes({
    ship,
    origin: 'A',
    stops,
    legPayloads: [500, 500],
  });
  expect(
    failures,
    '重载 ≥ 空载',
    loaded.legs[0].hours >= empty.legs[0].hours - 1e-9,
    `empty=${empty.legs[0].hours} loaded=${loaded.legs[0].hours}`,
  );
});

await check('原生 RT 区分油箱资料缺失和已确认的空罐', async () => {
  const row = recorded.find(
    x => x.request.landing && x.segments.some(segment => segment.type === 'TAKE_OFF'),
  );
  const [from, to] = row.flightInputs.orbit.endpoints.map(x => x.naturalId);
  const emptyShip = {
    ...ship,
    blueprintNaturalId: row.blueprint.naturalId,
    condition: row.request.condition,
  };
  stub.stubReset();
  stub.stubSetBlueprint(row.blueprint);
  stub.stubSetInputs({
    origin: row.request.origin,
    destination: row.request.destination,
    input: row.flightInputs,
  });
  const input = {
    ship: emptyShip,
    from,
    to,
    useGateway: false,
    payload: row.request.payload,
    atMs: row.gameTimeMs,
    ftlFuel: row.request.ftlFuel,
    selection: 'value',
  };
  const unknown = await planFormulaFlight(input);
  assert.deepEqual(unknown.inputIncomplete, ['STL 油箱数据']);
  const empty = await planFormulaFlight({ ...input, stlFuel: 0 });
  assert.equal(empty.ok, false);
  assert.equal(empty.insufficientFuel, true);
  assert.match(empty.message, /起降耗油/);
});

await check('原生循环：网关、逐段档位、时长和备货油量使用同一套方案', async () => {
  const row = recorded.find(
    x => x.actual.ftlFuel === 0 && x.segments.some(seg => seg.type === 'JUMP_GATEWAY'),
  );
  const [origin, destination] = row.flightInputs.orbit.endpoints.map(x => x.naturalId);
  const gatewayShip = {
    ...ship,
    blueprintNaturalId: row.blueprint.naturalId,
    condition: row.request.condition,
  };
  stub.stubReset();
  stub.stubSetShip(gatewayShip);
  stub.stubSetBlueprint(row.blueprint);
  stub.stubSetFuel({ stlRemaining: 0, stlCap: row.request.stlFuel, ftlRemaining: 0, ftlCap: 0 });
  stub.stubSetInputs(from => {
    const forward = from === origin;
    const snapshot = row.flightInputs;
    return {
      origin: forward ? row.request.origin : row.request.destination,
      destination: forward ? row.request.destination : row.request.origin,
      input: forward
        ? snapshot
        : {
            ...snapshot,
            orbit: { ...snapshot.orbit, endpoints: snapshot.orbit.endpoints.toReversed() },
            environment: snapshot.environment.toReversed(),
          },
    };
  });
  const route = {
    ship: gatewayShip,
    origin,
    stops: [{ naturalId: destination, planetName: destination }],
    startAtMs: row.gameTimeMs,
    legPayloads: [row.request.payload, row.request.payload + 10],
  };
  assert.equal((await estimateChainFlightTimes(route)).ok, false, 'needs gateway data');
  const loop = await estimateChainFlightTimes({ ...route, nativeRoute: true });
  assert.equal(loop.ok, true, JSON.stringify(loop.legs));
  assert.equal(loop.legs[1].departAtMs, loop.legs[0].arriveAtMs);
  assert.equal(
    loop.totalHours,
    loop.legs.reduce((sum, leg) => sum + leg.settings.hours, 0),
  );
  let stlFuel = row.request.stlFuel;
  for (const [index, leg] of loop.legs.entries()) {
    const fixed = await planFormulaFlight({
      ship: gatewayShip,
      from: leg.from,
      to: leg.to,
      atMs: leg.departAtMs,
      useGateway: true,
      payload: route.legPayloads[index],
      stlFuel,
      ftlFuel: 0,
      fuel: leg.settings.fuelPercent / 100,
      selection: 'value',
    });
    assert.equal(fixed.ok, true);
    assert.equal(leg.settings.reactorPercent, undefined);
    assert.equal(leg.hours, fixed.best.totalHours);
    assert.equal(leg.stlUsed, fixed.best.stlFuel);
    assert.equal(leg.ftlUsed, 0);
    stlFuel = fixed.best.stlRemaining;
  }
  assert.deepEqual(fuelPerRound(loop.legs, chainShipFuelCaps(gatewayShip)), {
    stl: row.request.stlFuel - stlFuel,
    ftl: 0,
  });
});

console.log(
  summary.fail === 0
    ? `PASS ${summary.pass}/${summary.pass}`
    : `FAIL ${summary.pass}/${summary.pass + summary.fail}`,
);
process.exitCode = summary.fail === 0 ? 0 : 1;
