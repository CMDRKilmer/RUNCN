// Usage: node scripts/fit-ftl-reactor-pilot.mjs <raw-export.json> [...] [--holdout <raw-export.json>]
// Requires at least three distinct reaction settings in a controlled trial on one natural jump.
import assert from 'node:assert/strict';
import { fitLinear, readFlightObservations } from './lib/flight-observations.mjs';

function readTrial(files, missionIds) {
  const samples = [];
  let baseline;
  let preflightDistancePc;
  let rejected = 0;
  for (const file of files) {
    for (const { blueprint, request, response, flightInputs } of readFlightObservations(file)) {
      if (response?.status !== 'OK') {
        rejected++;
        continue;
      }
      const { reactorUsageFactor: r, missionId, ...controls } = request;
      assert.equal(response.missionId, missionId);
      if (missionIds.has(missionId)) {
        continue;
      }
      missionIds.add(missionId);
      assert(blueprint && blueprint.id === controls.blueprintId, '缺少匹配的蓝图快照');
      assert(Number.isFinite(r) && r > 0 && r <= 1, '缺少合法的反应堆档位');
      assert(Number.isFinite(controls.fuelUsageFactor), '缺少 STL 档位');
      const geometry = response.segments.filter(
        x => x.type === 'JUMP' || x.type === 'JUMP_GATEWAY',
      );
      assert(geometry.length === 1 && geometry[0].type === 'JUMP', '基线必须为单次自然跃迁');
      const [jump] = geometry;
      const distancePc = jump.ftlDistance;
      const seconds = (jump.arrival.timestamp - jump.departure.timestamp) / 1000;
      const fuel = response.ftlFuelConsumption;
      assert(
        Number.isFinite(distancePc) && distancePc > 0 && seconds > 0 && Number.isFinite(seconds),
      );
      assert(Number.isFinite(fuel) && fuel > 0, '缺少全程 FTL 油耗');
      assert.equal(
        response.segments.reduce((sum, x) => sum + (x.ftlFuelConsumption ?? 0), 0),
        fuel,
        '分段 FTL 油耗与全程不一致',
      );
      const config = {
        controls,
        distancePc,
        performance: blueprint.performance,
        selections: blueprint.selections,
      };
      baseline ??= config;
      assert.deepEqual(config, baseline, '试飞条件应只改变反应堆档位');
      const endpoints = [controls.origin, controls.destination].map(
        address => flightInputs?.stars?.find(x => x.systemId === address.split('|')[0])?.position,
      );
      if (endpoints.every(p => p && [p.x, p.y, p.z].every(Number.isFinite))) {
        const [a, b] = endpoints;
        const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / 12;
        assert(distance > 0);
        if (preflightDistancePc !== undefined) {
          assert.equal(distance, preflightDistancePc, '试飞前的恒星坐标应保持一致');
        }
        preflightDistancePc = distance;
      }
      samples.push({ r, seconds, fuel });
    }
  }
  assert(baseline, '缺少有效的试飞计划');
  return { samples, baseline, preflightDistancePc, rejected };
}

const args = process.argv.slice(2);
const holdoutIndex = args.indexOf('--holdout');
assert(
  holdoutIndex < 0 || (holdoutIndex > 0 && holdoutIndex === args.length - 2),
  '用法：node scripts/fit-ftl-reactor-pilot.mjs <训练导出> [...] [--holdout <整条航线导出>]',
);
const files = holdoutIndex < 0 ? args : args.slice(0, holdoutIndex);
assert(files.length > 0, '缺少训练导出');
const missionIds = new Set();
const { samples, baseline, preflightDistancePc, rejected } = readTrial(files, missionIds);

const tiers = [...new Set(samples.map(x => x.r))].sort((a, b) => a - b);
assert(tiers.length >= 3, `至少需要三个不同的有效反应堆档位。实际 ${tiers.length} 档。`);

function evaluate(xOf, yOf, transform = x => x, inverse = x => x) {
  const fit = rows => fitLinear(rows, xOf, x => transform(yOf(x)));
  const { intercept, slope } = fit(samples);
  const errors = tiers.map(r => {
    const model = fit(samples.filter(x => x.r !== r));
    const actual = samples.filter(x => x.r === r).map(yOf);
    const prediction = inverse(model.intercept + model.slope * xOf({ r }));
    const relativeErrors = actual.map(y => (100 * Math.abs(prediction - y)) / y);
    return { r, maxErrorPct: Math.max(...relativeErrors) };
  });
  return { scale: inverse(intercept), coefficient: slope, heldOutTiers: errors };
}

const time = x => x.seconds;
const fuel = x => x.fuel;
const reactor = x => x.r;
const inverseReactor = x => 1 / x.r;
const logReactor = x => Math.log(x.r);
let preflightFit;
let holdoutRoute;
const maxSpeed = baseline.performance?.ftlMaxSpeed;
if (preflightDistancePc > 0 && Number.isFinite(maxSpeed) && maxSpeed > 0) {
  const dPc = preflightDistancePc;
  const baseTime = dPc / maxSpeed;
  const fitExponential = rows =>
    rows.reduce((sum, p) => sum + (1 - p.r) * Math.log(p.seconds / baseTime), 0) /
    rows.reduce((sum, p) => sum + (1 - p.r) ** 2, 0);
  const fuelRateInterval = rows => [
    Math.max(...rows.map(({ r, fuel }) => fuel / (r * dPc))),
    Math.min(...rows.map(({ r, fuel }) => (fuel + 1) / (r * dPc))),
  ];
  const [lower, upper] = fuelRateInterval(samples);
  preflightFit = {
    distancePc: dPc,
    distanceErrorPc: dPc - baseline.distancePc,
    fullPowerSeconds: baseTime,
    timeExponentialCoefficient: fitExponential(samples),
    floorFuelRateInterval: lower < upper ? { lowerInclusive: lower, upperExclusive: upper } : null,
    heldOutTiers: tiers.map(r => {
      const train = samples.filter(x => x.r !== r);
      const holdout = samples.filter(x => x.r === r);
      const coefficient = fitExponential(train);
      const time = Math.round(baseTime * Math.exp(coefficient * (1 - r)));
      const [low, high] = fuelRateInterval(train);
      const fuel = low < high ? Math.floor(((low + high) / 2) * dPc * r) : undefined;
      return {
        r,
        maxTimeErrorSeconds: Math.max(...holdout.map(x => Math.abs(time - x.seconds))),
        maxFuelError:
          fuel === undefined ? null : Math.max(...holdout.map(x => Math.abs(fuel - x.fuel))),
      };
    }),
  };
  if (holdoutIndex >= 0) {
    const trial = readTrial([args[holdoutIndex + 1]], missionIds);
    const { destination, ...controls } = baseline.controls;
    const { destination: otherDestination, ...otherControls } = trial.baseline.controls;
    assert.notEqual(otherDestination, destination, '留出批次应使用不同的目的地');
    assert.deepEqual(otherControls, controls, '留出批次应只改变目的地和反应堆档位');
    assert.deepEqual(trial.baseline.performance, baseline.performance, '留出批次蓝图性能不同');
    assert.deepEqual(trial.baseline.selections, baseline.selections, '留出批次蓝图配件不同');
    const d = trial.preflightDistancePc;
    assert(d > 0, '留出批次缺少试飞前的恒星坐标');
    const t0 = d / maxSpeed;
    const trainFuelRate = lower < upper ? (lower + upper) / 2 : undefined;
    const points = trial.samples.map(({ r, seconds, fuel }) => ({
      r,
      actualSeconds: seconds,
      predictedSeconds: Math.round(
        t0 * Math.exp(preflightFit.timeExponentialCoefficient * (1 - r)),
      ),
      actualFuel: fuel,
      predictedFuel: trainFuelRate === undefined ? null : Math.floor(trainFuelRate * d * r),
    }));
    const combined = [
      ...samples.map(x => ({ ...x, t0: baseTime })),
      ...trial.samples.map(x => ({ ...x, t0 })),
    ];
    // Infer post-hoc bounds separately from the frozen-coefficient predictions above.
    const partial = combined.filter(x => x.r < 1);
    const floorMin = Math.max(...partial.map(x => Math.log(x.seconds / x.t0) / (1 - x.r)));
    const floorMax = Math.min(...partial.map(x => Math.log((x.seconds + 1) / x.t0) / (1 - x.r)));
    const compatibleWithFloor =
      floorMin < floorMax && combined.every(x => x.r < 1 || Math.floor(x.t0) === x.seconds);
    holdoutRoute = {
      preflightDistancePc: d,
      distanceErrorPc: d - trial.baseline.distancePc,
      points,
      combinedTimeFloorCoefficientInterval: compatibleWithFloor
        ? { lowerInclusive: floorMin, upperExclusive: floorMax }
        : null,
    };
  }
}
assert(holdoutIndex < 0 || holdoutRoute, '训练批次缺少蓝图最高跃迁速度或试飞前的恒星坐标');
console.log(
  JSON.stringify(
    {
      distancePc: baseline.distancePc,
      samples,
      rejected,
      preflightFit,
      holdoutRoute,
      candidates: {
        timeInverse: evaluate(inverseReactor, time),
        timePower: evaluate(logReactor, time, Math.log, Math.exp),
        fuelLinear: evaluate(reactor, fuel),
      },
    },
    null,
    2,
  ),
);
