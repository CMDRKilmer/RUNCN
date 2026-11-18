// Fit same-configuration pilot curves to raw BTF plans, score other matrix tiers.
// Usage: node scripts/fit-flight-pilot.mjs <raw-observations.json> <matrix.json>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fitLinear } from './lib/flight-observations.mjs';

const [rawPath, matrixPath] = process.argv.slice(2);
assert(rawPath && matrixPath, '用法：node scripts/fit-flight-pilot.mjs <原始样本> <矩阵>');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const raw = read(rawPath);
const matrix = read(matrixPath);
const rows = raw.observations.filter(x => x.response?.status === 'OK');
assert(rows.length >= 3, '至少需要三个有效的试飞档');

const { request: base } = rows[0];
const { missionId: _mission, fuelUsageFactor: _fuel, ...baseInputs } = base;
const blueprint = raw.blueprints.find(x => x.id === base.blueprintId);
assert(blueprint, '缺少原始蓝图');
const matching = matrix.variants.filter(x => x.blueprintId === blueprint.naturalId);
assert.equal(matching.length, 1, '矩阵应有唯一一组匹配的蓝图');
const variant = matching[0];
assert.equal(matrix.probe, base.origin);
assert.equal(matrix.target, base.destination);
for (const key of ['reactorUsageFactor', 'stlFuel', 'payload', 'condition']) {
  assert.equal(variant[key], base[key], '矩阵参数不同：' + key);
}

const points = rows.map(({ request, response }) => {
  const { missionId, fuelUsageFactor: f, ...inputs } = request;
  assert.equal(response.missionId, missionId);
  assert.deepEqual(inputs, baseInputs, '原始样本应只变化 STL 档位');
  const seconds = response.segments.reduce(
    (sum, x) => sum + (x.arrival.timestamp - x.departure.timestamp) / 1000,
    0,
  );
  const stl = response.stlFuelConsumption;
  assert.equal(seconds, response.eta.millis / 1000);
  assert(Number.isFinite(stl) && Number.isFinite(f) && f > 0 && seconds > 0);
  const overlap = variant.samples.find(x => x.fuelUsageFactor === f);
  assert(overlap, '矩阵中没有可交叉核对的对应档位');
  assert.equal(overlap.totalSeconds, seconds);
  assert.equal(overlap.stlFuel, stl);
  for (const fuelType of ['stl', 'ftl']) {
    const key = fuelType + 'FuelConsumption';
    const sum = response.segments.reduce((total, segment) => total + (segment[key] ?? 0), 0);
    assert.equal(sum, response[key] ?? 0, '计划油耗与分段油耗不一致：' + key);
  }
  return { f, seconds, stl, segments: response.segments };
});
assert.equal(new Set(points.map(x => x.f)).size, points.length, '训练档位重复');

const fuel = fitLinear(
  points,
  x => x.f,
  x => x.stl,
);
const time = fitLinear(
  points,
  x => 1 / x.f,
  x => x.seconds,
);
const matrixOnly = variant.samples.filter(x => !points.some(y => y.f === x.fuelUsageFactor));
const errorPct = (predicted, actual) => Number(((100 * (predicted - actual)) / actual).toFixed(2));
const checks = matrixOnly.map(({ fuelUsageFactor: f, stlFuel, totalSeconds }) => ({
  f,
  stlErrorPct: errorPct(fuel.intercept + fuel.slope * f, stlFuel),
  timeErrorPct: errorPct(time.intercept + time.slope / f, totalSeconds),
}));

function leaveOneOut(points, xOf, yOf, linearToOutput = x => x) {
  return points.map((point, index) => {
    const fit = fitLinear(
      points.filter((_, other) => other !== index),
      xOf,
      yOf,
    );
    return errorPct(
      linearToOutput(fit.intercept + fit.slope * xOf(point)),
      linearToOutput(yOf(point)),
    );
  });
}

const segmentDiagnostics = {};
for (const type of ['DEPARTURE', 'APPROACH']) {
  const samples = points.map(({ f, segments }) => {
    const group = segments.filter(x => x.type === type);
    assert.equal(group.length, 1, '此对照需要每条航线恰有一个 ' + type);
    const [segment] = group;
    return {
      f,
      stl: segment.stlFuelConsumption,
      seconds: (segment.arrival.timestamp - segment.departure.timestamp) / 1000,
      distanceKm: segment.stlDistance,
    };
  });
  const tier = x => x.f;
  const inverseTier = x => 1 / x.f;
  const fuel = x => x.stl;
  const time = x => x.seconds;
  const secondsPerMillionKm = x => (1e6 * x.seconds) / x.distanceKm;
  const logTier = x => Math.log(x.f);
  const logSecondsPerMillionKm = x => Math.log(secondsPerMillionKm(x));
  const power = fitLinear(samples, logTier, logSecondsPerMillionKm);
  const distances = samples.map(x => x.distanceKm);
  segmentDiagnostics[type] = {
    distanceRangeKm: [Math.min(...distances), Math.max(...distances)],
    stlByTier: fitLinear(samples, tier, fuel),
    stlLeaveOneOutErrorPct: leaveOneOut(samples, tier, fuel),
    timeLeaveOneOutErrorPct: leaveOneOut(samples, inverseTier, time),
    timeWithNativeDistanceLeaveOneOutErrorPct: leaveOneOut(
      samples,
      inverseTier,
      secondsPerMillionKm,
    ),
    timePerMillionKmPower: { scale: Math.exp(power.intercept), exponent: power.slope },
    powerWithNativeDistanceLeaveOneOutErrorPct: leaveOneOut(
      samples,
      logTier,
      logSecondsPerMillionKm,
      Math.exp,
    ),
  };
}

const contactSegments = points.flatMap(({ segments }) =>
  segments
    .filter(x => x.type === 'TAKE_OFF' || x.type === 'LANDING')
    .map(x => ({
      seconds: (x.arrival.timestamp - x.departure.timestamp) / 1000,
      distanceKm: x.stlDistance,
      fuel: x.stlFuelConsumption,
    })),
);
assert(contactSegments.length > 0);
const contactScales = contactSegments.map(x => x.seconds / Math.sqrt(x.distanceKm));
const takeOffLandingDiagnostics = {
  secondsPerSqrtKm: [Math.min(...contactScales), Math.max(...contactScales)],
  // If fuel is ceil(rate * seconds), the lower bound is exclusive and the upper bound inclusive.
  ceilFuelRateBounds: [
    Math.max(...contactSegments.map(x => (x.fuel - 1) / x.seconds)),
    Math.min(...contactSegments.map(x => x.fuel / x.seconds)),
  ],
};

console.log(
  JSON.stringify(
    {
      blueprint: blueprint.naturalId,
      trainingTiers: points.map(x => x.f),
      stlFuel: fuel,
      seconds: time,
      sameRouteMatrixChecks: checks,
      segmentDiagnostics,
      takeOffLandingDiagnostics,
    },
    null,
    2,
  ),
);
