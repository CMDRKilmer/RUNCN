// Usage: node --experimental-strip-types scripts/verify-ftc-formula.mjs [--archive]
// Replays recorded preflight inputs through FTC's real formula/selection modules.
// Exit 1 on a failed whole-flight, phase, or selection check. Does not test live SFC writes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
register('./lib/flight-formula-loader.mjs', import.meta.url);
const { predictFormulaFlight, selectFormulaRoute } =
  await import('../src/infrastructure/fio/flight-formula.ts');
const { calculateFormulaOptions } = await import('../src/features/XIT/FTC/formula-options.ts');
const { readFlightObservations } = await import('./lib/flight-observations.mjs');
const { scoreFlight, scoreFlightSegments } = await import('./lib/flight-acceptance.mjs');
const { planetEndpoint } = await import('./lib/gateway-pilot.mjs');
const read = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const fixtures = read(new URL('./fixtures/ftc-formula.json', import.meta.url));
let checks = 0;
function verify(row) {
  const { request, blueprint, flightInputs, gameTimeMs, actual, segments } = row;
  const estimate = predictFormulaFlight(request, blueprint, flightInputs, gameTimeMs);
  const entity = (address, type) => address.lines.find(x => x.type === type)?.entity?.naturalId;
  const actualRoute =
    row.actualRoute ??
    segments
      .filter(x => x.type === 'JUMP' || x.type === 'JUMP_GATEWAY')
      .map(x => [
        entity(x.origin, 'SYSTEM'),
        entity(x.destination, 'SYSTEM'),
        x.type === 'JUMP_GATEWAY' ? entity(x.origin, 'SATELLITE') : null,
      ]);
  assert.deepEqual(
    estimate.route.map(x => [x.from, x.to, x.gate?.a.naturalId ?? null]),
    actualRoute,
  );
  const whole = scoreFlight(estimate, actual);
  assert(whole.passed, `whole flight ${request.missionId}`);
  const scores = scoreFlightSegments(estimate.segments, segments);
  assert(
    scores.every(x => x.passed),
    `phase ${request.missionId}: ${JSON.stringify(scores.filter(x => !x.passed))}`,
  );
  // 余油要对着**记录里的实际消耗**核，而不是拿 estimate 自己减自己的消耗（那样恒真、等于没查）。
  // 容差与整飞校验同一口径（5% 或 1 u）。
  const remaining = [
    ['STL', estimate.stlRemaining, request.stlFuel - actual.stlFuel, whole.checks.stlFuel],
    ['FTL', estimate.ftlRemaining, request.ftlFuel - actual.ftlFuel, whole.checks.ftlFuel],
  ];
  for (const [kind, predicted, observed, check] of remaining) {
    assert(
      Math.abs(predicted - observed) <= check.tolerance,
      `${kind} 余油 ${predicted} 与实测余油 ${observed} 相差超过容差 ${check.tolerance}（${request.missionId}）`,
    );
  }
  checks++;
  return estimate;
}
const failures = [];
for (const row of fixtures) {
  try {
    verify(row);
  } catch (error) {
    failures.push(`${row.request?.missionId ?? 'fixture'}: ${error.message}`);
  }
}
console.log(`PASS recorded fixtures ${fixtures.length - failures.length}/${fixtures.length}`);
if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`FAIL ${failure}`);
  }
  process.exit(1);
}

const same = fixtures.find(
  x =>
    x.flightInputs.orbit.endpoints[0].systemId === x.flightInputs.orbit.endpoints[1].systemId &&
    x.request.landing,
);
const calculate = (q, prices = { time: 0 }, optimize = false) =>
  calculateFormulaOptions(q, same.blueprint, same.flightInputs, same.gameTimeMs, prices, optimize);
const midpoint = calculate({ ...same.request, missionId: undefined }).best;
assert(midpoint.estimatedLanding && midpoint.warnings.length > 0);
assert(!calculate(same.request).best.estimatedLanding);
assert.throws(() => calculate({ ...same.request, missionId: 'invalid' }), /UUID/);
assert.throws(() => calculate({ ...same.request, stlFuel: -1 }), /余油/);
assert.throws(
  () => calculate({ ...same.request, stlFuel: same.blueprint.performance.stlFuelCapacity + 1 }),
  /余油/,
);
assert.throws(() => calculate({ ...same.request, fuelUsageFactor: 0 }), /档位/);
assert.throws(
  () => calculate({ ...same.request, payload: same.blueprint.performance.storeCapacityWeight + 1 }),
  /货舱容量/,
);
assert.throws(() => calculate({ ...same.request, stlFuel: 0 }), /起降耗油/);
assert.throws(
  () =>
    predictFormulaFlight(
      same.request,
      same.blueprint,
      { ...same.flightInputs, orbit: { ...same.flightInputs.orbit, endpoints: [{}, {}] } },
      same.gameTimeMs,
    ),
  /轨道/,
);
const scan = calculate(same.request, { stl: 10, time: 1000 }, true);
assert.equal(scan.options.length, 20);
assert(scan.options.every(x => x.reactor === same.request.reactorUsageFactor));
assert(scan.best.feasible);
assert.equal(
  scan.best.totalCost,
  Math.min(...scan.options.filter(x => x.feasible).map(x => x.totalCost)),
);
const unpriced = calculate(same.request, { time: 1000 }, true);
assert(!unpriced.costBased);
assert.equal(unpriced.best.totalCost, undefined);
const natural = fixtures.find(x => x.actual.ftlFuel > 0 && x.request.destination.includes('|STA,'));
const noFtl = predictFormulaFlight(
  { ...natural.request, ftlFuel: 0 },
  natural.blueprint,
  natural.flightInputs,
  natural.gameTimeMs,
);
assert(!noFtl.feasible && noFtl.ftlShortage > 0 && noFtl.ftlRemaining < 0);
for (const row of fixtures.filter(x => x.source.startsWith('2026-11-15-mixed-'))) {
  const estimate = predictFormulaFlight(
    row.request,
    row.blueprint,
    row.flightInputs,
    row.gameTimeMs,
  );
  assert(estimate.warnings.some(x => x.includes('独立盲测尚未完成')));
}
assert.throws(
  () =>
    calculateFormulaOptions(
      {
        ...natural.request,
        reactorUsageFactor: natural.blueprint.performance.minReactorUsage - 0.001,
      },
      natural.blueprint,
      natural.flightInputs,
      natural.gameTimeMs,
      { time: 0 },
      false,
    ),
  /反应堆档位/,
);
console.log('PASS input validation, feasibility, pricing, landing uncertainty, and tier selection');

if (process.argv.includes('--archive')) {
  const audit = read('.tmp/flight-formula-reports/formal-acceptance-audit.json');
  const ids = new Set();
  for (const group of audit.groups) {
    const manifest = path.join(
      '.tmp/flight-formula-freezes',
      group.freeze,
      `blind-manifest${group.tag}.json`,
    );
    const sources = read(manifest).sources;
    let passing = 0;
    for (const source of sources) {
      for (const row of readFlightObservations(path.resolve(path.dirname(manifest), source))) {
        if (row.response?.status !== 'OK') {
          continue;
        }
        const gates = selectFormulaRoute(row.request, row.blueprint, row.flightInputs).flatMap(x =>
          x.gate ? [x.gate.a, x.gate.b] : [],
        );
        const flightInputs = {
          ...row.flightInputs,
          gatewayEndpoints: Object.fromEntries(gates.map(x => [x.naturalId, planetEndpoint(x)])),
        };
        verify({
          ...row,
          flightInputs,
          actual: {
            seconds: row.response.eta.millis / 1000,
            stlFuel: row.response.stlFuelConsumption,
            ftlFuel: row.response.ftlFuelConsumption,
          },
          segments: row.response.segments,
        });
        ids.add(row.request.missionId);
        passing++;
      }
    }
    assert.equal(passing, group.count);
    console.log(`PASS ${group.freeze}${group.tag} ${passing}/${group.count}`);
  }
  assert.equal(ids.size, 560);
  const multiblock = [
    '2026-11-15-mixed-hrt-zv759b-1500.json',
    '2026-11-15-mixed-zv759b-hrt-1500.json',
    '2026-11-15-mixed-zv194h-hrt-1500.json',
    '2026-11-15-mixed-vh874a-zv759b-1500.json',
    '2026-11-15-mixed-vh874a-zv759b-750.json',
    '2026-11-15-mixed-zv759b-vh874a-1500.json',
  ];
  let mixedCount = 0;
  for (const source of multiblock) {
    for (const row of readFlightObservations('.tmp/flight-formula-data/' + source)) {
      if (row.response?.status !== 'OK') {
        continue;
      }
      const gates = selectFormulaRoute(row.request, row.blueprint, row.flightInputs).flatMap(x =>
        x.gate ? [x.gate.a, x.gate.b] : [],
      );
      verify({
        ...row,
        flightInputs: {
          ...row.flightInputs,
          gatewayEndpoints: Object.fromEntries(gates.map(x => [x.naturalId, planetEndpoint(x)])),
        },
        actual: {
          seconds: row.response.eta.millis / 1000,
          stlFuel: row.response.stlFuelConsumption,
          ftlFuel: row.response.ftlFuelConsumption,
        },
        segments: row.response.segments,
      });
      mixedCount++;
    }
  }
  assert.equal(mixedCount, 18);
  console.log('PASS exploratory mixed routes 18/18 (separate from formal blind groups)');
}
console.log(`PASS ${checks}/${checks} recorded flights`);
