// 用法：node --experimental-strip-types scripts/verify-formula-route.mjs
// 公式模型的**路线选择**（真实模块 src/infrastructure/fio/flight-formula.ts 的
// selectFormulaRoute，纯函数：星图 + 网关腿 + 蓝图体积上限）。
// 退出码：0 = 全通过（末行 PASS n/n）；1 = 有失败（FAIL <场景> expected=… actual=…）。
//
// 覆盖：
//   ① 行星终点：允许网关段收尾（原生 SFC 实测形状：HRT → OF-375b 走 GTW-PGG-155 → GTW-MWD-607）；
//   ② 空间站终点：允许网关段收尾（纯网关路线）；
//   ③ 行星起点：允许网关段开头；
//   ④ 只有网关一条路：行星端点也能选出路线（不再报「模型暂不支持」）；
//   ⑤ 船体体积超过网关上限 → 该网关腿被剔除（沿用原有规则）；
//   ⑥ 关闭网关 → 只用自然航线；
//   ⑦⑧ gatewayRouteAvailable（warning 分类用）：不加端点约束时星图上是否有网关路。
// 局限：只验证选路，不验证分段时长/油耗（由 verify-ftc-formula.mjs / verify-real-flight.mjs /
//       verify-formula-gateway-endpoint.mjs 覆盖）。
import { register } from 'node:module';

register('./lib/flight-formula-loader.mjs', import.meta.url);

const { selectFormulaRoute, gatewayRouteAvailable } =
  await import('../src/infrastructure/fio/flight-formula.ts');

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

function expectThrows(failures, label, fn, fragment) {
  try {
    fn();
    failures.push(`${label} expected=抛出异常 actual=正常返回`);
  } catch (e) {
    const text = e instanceof Error ? e.message : String(e);
    if (!String(text).includes(fragment)) {
      failures.push(`${label} expected=含「${fragment}」 actual=${text}`);
    }
  }
}

const star = (naturalId, systemId, x, connections) => ({
  naturalId,
  systemId,
  position: { x, y: 0, z: 0 },
  connections,
});
const gateway = (naturalId, systemId, volume = 6000) => ({
  naturalId,
  systemId,
  planetId: `${naturalId}-P`,
  operational: true,
  maxShipVolume: volume,
});
const address = (systemId, kind, bodyId) => `id-${systemId}|${kind},${bodyId}`;
const endpoint = (systemId, naturalId) => ({
  naturalId,
  systemId,
  orbit: {
    semiMajorAxis: 1e11,
    eccentricity: 0,
    inclination: 0,
    rightAscension: 0,
    periapsis: 0,
    mass: 0,
  },
  parentMassKg: 2e30,
});
const blueprint = { performance: { totalVolume: 1000 }, selections: [] };

// S1 与 S2 只经 S3 自然连通；S1↔S2 另有一条网关连接。
function inputs() {
  return {
    orbit: {
      motionFactor: 20,
      simulationIntervalS: 86400,
      endpoints: [endpoint('S1', 'P1'), endpoint('S2', 'P2')],
    },
    environment: [{}, {}],
    stars: [
      star('S1', 'S1', 0, ['S3']),
      star('S3', 'S3', 60, ['S1', 'S2']),
      star('S2', 'S2', 120, ['S3']),
    ],
    gateways: [gateway('G1', 'S1'), gateway('G2', 'S2')],
    gatewayConnections: [{ fromGatewayId: 'G1', toGatewayId: 'G2' }],
    gatewayEndpoints: {},
  };
}

const request = (originKind, destinationKind, useGateways = true) => ({
  origin: address('S1', originKind, 'P1'),
  destination: address('S2', destinationKind, 'P2'),
  landing: true,
  payload: 0,
  condition: 1,
  stlFuel: 3000,
  ftlFuel: 300,
  fuelUsageFactor: 0.2,
  reactorUsageFactor: 0.5,
  preferences: { useGateways, ftlPreference: 'LEAST_JUMPS' },
});

// gate 是 { a, b } 包装（两端网关实体），这里显示成 `G1>G2` 便于断言。
const shape = route =>
  route.map(x => [
    x.from,
    x.to,
    x.gate === undefined ? null : `${x.gate.a.naturalId}>${x.gate.b.naturalId}`,
  ]);

check('① 行星终点：允许网关收尾（原生 HRT → OF-375b 实测形状）', failures => {
  const route = selectFormulaRoute(request('STA', 'PLA'), blueprint, inputs());
  expectEqual(failures, '路线', [['S1', 'S2', 'G1>G2']], shape(route));
});

check('② 空间站终点：允许网关段收尾（纯网关路线不变）', failures => {
  const route = selectFormulaRoute(request('STA', 'STA'), blueprint, inputs());
  expectEqual(failures, '路线', [['S1', 'S2', 'G1>G2']], shape(route));
});

check('③ 行星起点：允许网关开头', failures => {
  const route = selectFormulaRoute(request('PLA', 'STA'), blueprint, inputs());
  expectEqual(failures, '路线', [['S1', 'S2', 'G1>G2']], shape(route));
});

check('④ 只有网关一条路：行星端点也能选出来（不再报不支持）', failures => {
  const only = inputs();
  // 掐断自然连接（S3 不再连 S1/S2），只剩网关边。
  only.stars = [star('S1', 'S1', 0, []), star('S3', 'S3', 60, []), star('S2', 'S2', 120, [])];
  expectEqual(
    failures,
    '行星终点',
    [['S1', 'S2', 'G1>G2']],
    shape(selectFormulaRoute(request('STA', 'PLA'), blueprint, only)),
  );
  expectEqual(
    failures,
    '行星起点',
    [['S1', 'S2', 'G1>G2']],
    shape(selectFormulaRoute(request('PLA', 'STA'), blueprint, only)),
  );
  expectEqual(
    failures,
    '空间站到空间站',
    [['S1', 'S2', 'G1>G2']],
    shape(selectFormulaRoute(request('STA', 'STA'), blueprint, only)),
  );
});

check('⑤ 体积超网关上限：网关腿被剔除，回到自然航线', failures => {
  const heavy = inputs();
  heavy.gateways = [gateway('G1', 'S1', 500), gateway('G2', 'S2', 500)];
  const route = selectFormulaRoute(request('STA', 'STA'), blueprint, heavy);
  expectEqual(
    failures,
    '路线',
    [
      ['S1', 'S3', null],
      ['S3', 'S2', null],
    ],
    shape(route),
  );
});

check('⑥ 关闭网关：只用自然航线', failures => {
  const route = selectFormulaRoute(request('STA', 'STA', false), blueprint, inputs());
  expectEqual(
    failures,
    '路线',
    [
      ['S1', 'S3', null],
      ['S3', 'S2', null],
    ],
    shape(route),
  );
});

// gatewayRouteAvailable 只用于给 warning 分类（不参与选路）：
// 它**不加端点约束**，所以「只有网关首/末位」的航线也算 true。
check('⑦ gatewayRouteAvailable：星图上有网关路时为 true（含端点约束外的形状）', failures => {
  expectEqual(
    failures,
    '有自然连接的星图',
    true,
    gatewayRouteAvailable(request('STA', 'STA'), blueprint, inputs()),
  );
  const only = inputs();
  only.stars = [star('S1', 'S1', 0, []), star('S3', 'S3', 60, []), star('S2', 'S2', 120, [])];
  expectEqual(
    failures,
    '只剩网关时的行星终点',
    true,
    gatewayRouteAvailable(request('STA', 'PLA'), blueprint, only),
  );
});

check('⑧ gatewayRouteAvailable：没有网关数据/关闭网关/超体积时为 false', failures => {
  const noData = inputs();
  noData.gateways = [];
  noData.gatewayConnections = [];
  expectEqual(
    failures,
    '没有网关数据',
    false,
    gatewayRouteAvailable(request('STA', 'STA'), blueprint, noData),
  );
  expectEqual(
    failures,
    '关闭网关',
    false,
    gatewayRouteAvailable(request('STA', 'STA', false), blueprint, inputs()),
  );
  const heavy = inputs();
  heavy.gateways = [gateway('G1', 'S1', 500), gateway('G2', 'S2', 500)];
  expectEqual(
    failures,
    '体积超限',
    false,
    gatewayRouteAvailable(request('STA', 'STA'), blueprint, heavy),
  );
});

console.log(
  summary.fail === 0
    ? `PASS ${summary.pass}/${summary.pass}`
    : `FAIL ${summary.pass}/${summary.pass + summary.fail}`,
);
process.exitCode = summary.fail === 0 ? 0 : 1;
