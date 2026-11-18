// 用法：node --experimental-strip-types scripts/verify-formula-gateway-endpoint.mjs
// 网关段位于航线**首/末段**时的 STL 转移段（真实模块 predictFormulaFlight）。
// 退出码：0 = 全通过（末行 PASS n/n）；1 = 有失败（FAIL <场景> expected=… actual=…）。
//
// 原生 SFC 实测（HRT → OF-375b，useGateways=true，f=0.05，着陆）：
//   TRANSIT HRT→VH-331a 23845.495 km / 178 u ｜ TRANSIT→网关 10 km / 15 u ｜ LOCK 10 min / 5 u
//   JUMP_GATEWAY（19.1327 pc，0 油）｜ DECAY 10 min / 5 u ｜ TRANSIT→OF-375b 10 km / 15 u
//   LANDING 4.207 km / 24 u（**没有**「网关母星 → 目标行星」的额外转移段，因为网关就绕着
//   OF-375b，跳到站即在目标天体旁）。
// 所以模型规则是：网关母星与起点/终点是同一颗天体时，该端的 STL 转移段整段不存在（油耗归零）。
//
// 覆盖：
//   ① 空间站 → 行星（网关母星 == 目标行星）：只有一个出发端 TRANSIT，没有到站 TRANSIT；
//   ② 空间站 → 行星（网关母星 != 目标行星）：出发端与到站端各一个 TRANSIT；
//   ③ 行星 → 空间站（网关母星 == 出发行星）：没有出发端 TRANSIT（TAKE_OFF 直接接网关段）；
//   ④ 空间站 → 空间站（回归）：两端各一个 TRANSIT，总 STL = 固定网关油 + 两段转移油；
// 局限：轨道/星图是合成数据，只锁「段的有无与油量归属」，不锁具体公里数（真实数值由
//       verify-ftc-formula.mjs / verify-real-flight.mjs 锁）。
import { register } from 'node:module';

register('./lib/flight-formula-loader.mjs', import.meta.url);

const { predictFormulaFlight } = await import('../src/infrastructure/fio/flight-formula.ts');

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

function expectEqual(failures, label, expected, actual) {
  const e = JSON.stringify(expected);
  const a = JSON.stringify(actual);
  if (e !== a) {
    failures.push(`${label} expected=${e} actual=${a}`);
  }
}

const orbit = (mass, semiMajorAxis) => ({
  semiMajorAxis,
  eccentricity: 0,
  inclination: 0,
  rightAscension: 0,
  periapsis: 0,
  mass,
});
const endpoint = (naturalId, systemId, mass = 0, semiMajorAxis = 1e11) => ({
  naturalId,
  systemId,
  orbit: orbit(mass, semiMajorAxis),
  parentMassKg: 2e30,
});
const star = (naturalId, systemId, x, connections) => ({
  naturalId,
  systemId,
  position: { x, y: 0, z: 0 },
  connections,
});
const gateway = (naturalId, systemId, planetId) => ({
  naturalId,
  systemId,
  planetId,
  operational: true,
  maxShipVolume: 6000,
});

const blueprint = {
  performance: {
    acceleration: 20,
    accelerationMax: 20,
    operatingEmptyMass: 1000,
    ftlFuelMaterial: { weight: 0.05 },
    stlFuelCapacity: 5000,
    ftlFuelCapacity: 1000,
    storeCapacityWeight: 5000,
    totalVolume: 1000,
    ftlMaxSpeed: 1e-3,
    minReactorUsage: 0.2,
    emitterChargeTime: 300,
    maxOverchargeTime: 1200,
  },
  selections: [
    {
      type: 'STL_ENGINE',
      option: 'STL_ENGINE_STANDARD',
      amount: 1,
      modifiers: [{ type: 'STL_USAGE', value: 0.05 }],
    },
    {
      type: 'FTL_REACTOR',
      option: 'FTL_REACTOR_STANDARD',
      amount: 1,
      modifiers: [{ type: 'FTL_POWER', value: 2 }],
    },
  ],
};

const address = (systemId, kind, bodyId) => `id-${systemId}|${kind},${bodyId}`;

function inputs({ originBody, destinationBody, gateA, gateB }) {
  const endpoints = [endpoint(originBody, 'S1'), endpoint(destinationBody, 'S2')];
  return {
    orbit: { motionFactor: 20, simulationIntervalS: 86400, endpoints },
    environment: [
      { env: { radiusKm: 2000, pressure: 0.7 } },
      { env: { radiusKm: 2000, pressure: 0.7 } },
    ],
    stars: [star('S1', 'S1', 0, []), star('S2', 'S2', 120, [])],
    gateways: [gateway('G1', 'S1', gateA), gateway('G2', 'S2', gateB)],
    gatewayConnections: [{ fromGatewayId: 'G1', toGatewayId: 'G2' }],
    gatewayEndpoints: {
      G1: endpoint(gateA, 'S1', 0, 2e11),
      G2: endpoint(gateB, 'S2', 0, 3e11),
    },
  };
}

const request = (originKind, destinationKind, originBody, destinationBody) => ({
  origin: address('S1', originKind, originBody),
  destination: address('S2', destinationKind, destinationBody),
  landing: true,
  payload: 0,
  condition: 1,
  stlFuel: 4000,
  ftlFuel: 800,
  fuelUsageFactor: 0.3,
  reactorUsageFactor: 0.5,
  preferences: { useGateways: true, ftlPreference: 'LEAST_JUMPS' },
});

const TRANSIT_TYPES = ['TRANSIT'];
const shape = result => result.segments.map(x => `${x.type}:${x.stlFuel}`);

function predicateCount(result, fn) {
  return result.segments.filter(fn).length;
}

check('① 网关母星 == 目标行星：只出发端转移，无到站转移', failures => {
  const result = predictFormulaFlight(
    request('STA', 'PLA', 'P0', 'P2'),
    blueprint,
    inputs({ originBody: 'P0', destinationBody: 'P2', gateA: 'P1', gateB: 'P2' }),
    1_792_000_000_000,
  );
  expectEqual(failures, '段序列', true, shape(result).length === 7);
  // 固定网关段：跳前 TRANSIT 10 km/15 u、LOCK 5 u、JUMP_GATEWAY 0、DECAY 5 u、跳后 TRANSIT 15 u
  expectEqual(
    failures,
    '固定网关段油量',
    [15, 5, 0, 5, 15],
    result.segments.slice(1, 6).map(x => x.stlFuel),
  );
  expectEqual(failures, '段类型', 'JUMP_GATEWAY', result.segments[3].type);
  expectEqual(failures, '最后一段', 'LANDING', result.segments.at(-1).type);
  // 出发端转移必须吃掉剩余 STL 油量的大头（> 固定 90 u）
  expectEqual(failures, '出发端转移有油（> 固定 90 u）', true, result.segments[0].stlFuel > 90);
});

check('② 网关母星 != 目标行星：两端都有 TRANSIT', failures => {
  const result = predictFormulaFlight(
    request('STA', 'PLA', 'P0', 'P2'),
    blueprint,
    inputs({ originBody: 'P0', destinationBody: 'P2', gateA: 'P1', gateB: 'P3' }),
    1_792_000_000_000,
  );
  expectEqual(failures, '段数（含到站转移）', 8, result.segments.length);
  expectEqual(failures, '段类型', TRANSIT_TYPES[0], result.segments.at(-2).type);
  expectEqual(failures, '最后一段', 'LANDING', result.segments.at(-1).type);
  expectEqual(failures, '到站转移有油', true, result.segments.at(-2).stlFuel > 15);
});

check('③ 网关母星 == 出发行星：没有出发端 TRANSIT（TAKE_OFF 直接接网关段）', failures => {
  const result = predictFormulaFlight(
    request('PLA', 'STA', 'P1', 'P2'),
    blueprint,
    inputs({ originBody: 'P1', destinationBody: 'P2', gateA: 'P1', gateB: 'P3' }),
    1_792_000_000_000,
  );
  expectEqual(failures, '首段', 'TAKE_OFF', result.segments[0].type);
  expectEqual(failures, '次段（固定网关 TRANSIT 10 km/15 u）', 15, result.segments[1].stlFuel);
  expectEqual(failures, '段类型', 'TRANSIT', result.segments[1].type);
  expectEqual(failures, '到站转移存在', true, result.segments.at(-1).type === 'TRANSIT');
});

check('④ 空间站 → 空间站（回归）：两端各一个 TRANSIT，油量总和自洽', failures => {
  const result = predictFormulaFlight(
    request('STA', 'STA', 'P0', 'P2'),
    blueprint,
    inputs({ originBody: 'P0', destinationBody: 'P2', gateA: 'P1', gateB: 'P3' }),
    1_792_000_000_000,
  );
  const transfers = predicateCount(result, x => x.type === 'TRANSIT' && x.stlFuel > 15);
  expectEqual(failures, '转移段数', 2, transfers);
  expectEqual(
    failures,
    '总 STL 油量 = 各段之和',
    result.segments.reduce((sum, x) => sum + x.stlFuel, 0),
    result.stlFuel,
  );
  expectEqual(failures, '无 FTL 消耗（纯网关）', 0, result.ftlFuel);
});

console.log(
  summary.fail === 0
    ? `PASS ${summary.pass}/${summary.pass}`
    : `FAIL ${summary.pass}/${summary.pass + summary.fail}`,
);
process.exitCode = summary.fail === 0 ? 0 : 1;
