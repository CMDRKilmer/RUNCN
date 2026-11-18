// Usage: node --experimental-strip-types scripts/verify-stl-segments-pilot.mjs [--planet-environment <FIO export>] <raw-export.json> [...]
// Uses observed segment distance and fuel to isolate time from route geometry and fuel allocation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import {
  allocateTransferFuel,
  stlAcceleration,
  stlLandingDistanceKm,
  stlSurfaceFlight,
  stlSurfaceFuel,
  stlTakeoffDistanceRatio,
  stlTransferSeconds,
} from '../src/core/flight/stl.ts';
import { scoreFlight } from './lib/flight-acceptance.mjs';
import { fitLinear, readFlightObservations } from './lib/flight-observations.mjs';
import { naturalSurfaceFlight, surfacePressure } from './lib/natural-route-pilot.mjs';

const flightTypes = new Set(['DEPARTURE', 'TRANSIT', 'APPROACH']);
const surfaceTypes = new Set(['TAKE_OFF', 'LANDING']);
const args = process.argv.slice(2);
let preciseEnvironment = new Map();
if (args[0] === '--planet-environment') {
  const [, path] = args.splice(0, 2);
  assert(path, '请提供 FIO 行星环境导出');
  const planets = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  preciseEnvironment = new Map(planets.map(planet => [planet.PlanetNaturalId, planet]));
  assert(preciseEnvironment.size > 0, 'FIO 行星环境导出为空');
}
const files = args;
assert(files.length > 0, '缺少原始试飞导出');
const missions = new Set();
const totals = {};
const transferTimingMismatches = [];
const transit = [];
const fuelDiagnostics = {
  surface: { points: 0, exact: 0, maxAbsoluteError: 0 },
  transitUsingObservedSurfaceFuel: { points: 0, exact: 0, maxAbsoluteError: 0 },
};
const surfaceBodies = { TAKE_OFF: new Map(), LANDING: new Map() };
const landingRepeats = new Map();
const surfaceDistanceDiagnostics = {};

function recordFuel(stat, actual, predicted) {
  stat.points++;
  stat.exact += Number(actual === predicted);
  stat.maxAbsoluteError = Math.max(stat.maxAbsoluteError, Math.abs(actual - predicted));
}

function bestFixedLandingDistance(observations) {
  const distances = observations.map(row => {
    const actual = { seconds: row.seconds, stlFuel: row.fuel, ftlFuel: 0 };
    const { checks } = scoreFlight(actual, actual);
    const allowedSeconds = [];
    const low = Math.max(1, Math.ceil(row.seconds - checks.seconds.tolerance));
    const high = Math.floor(row.seconds + checks.seconds.tolerance);
    for (let seconds = low; seconds <= high; seconds++) {
      if (Math.abs(stlSurfaceFuel(seconds, row.flow) - row.fuel) <= checks.stlFuel.tolerance) {
        allowedSeconds.push(seconds);
      }
    }
    assert(allowedSeconds.length > 0, '测得的着陆时间和油耗不满足动力学关系');
    const distance = seconds => (seconds ** 2 * row.effectiveAcceleration) / 2000;
    return { low: distance(allowedSeconds[0] - 1), high: distance(allowedSeconds.at(-1)) };
  });
  // The maximum overlap is reached at a right endpoint of an allowed interval.
  const passing = Math.max(
    ...distances.map(({ high }) => distances.filter(x => high > x.low && high <= x.high).length),
  );
  return { points: observations.length, passing };
}

function range(values) {
  return [Math.min(...values), Math.max(...values)];
}

for (const file of files) {
  for (const { blueprint, request, response, flightInputs } of readFlightObservations(file)) {
    if (response?.status !== 'OK' || missions.has(request.missionId)) {
      continue;
    }
    assert.equal(response.missionId, request.missionId);
    assert.equal(blueprint.id, request.blueprintId);
    missions.add(request.missionId);
    const { acceleration, accelerationMax, operatingEmptyMass, ftlFuelMaterial } =
      blueprint.performance;
    const engine = blueprint.selections.find(x => x.type === 'STL_ENGINE' && x.amount > 0);
    const flow = engine?.modifiers.find(x => x.type === 'STL_USAGE')?.value;
    assert(
      [acceleration, accelerationMax, operatingEmptyMass, flow, ftlFuelMaterial?.weight].every(
        x => Number.isFinite(x) && x > 0,
      ),
    );
    const mass =
      operatingEmptyMass +
      request.payload +
      0.06 * request.stlFuel +
      ftlFuelMaterial.weight * request.ftlFuel;
    assert(Number.isFinite(mass) && mass > 0);
    const conditionScale = Math.min(1, request.condition + 0.2);
    const effectiveAcceleration = stlAcceleration(blueprint.performance, request);
    const applyConditionFirst = Math.min(
      accelerationMax,
      ((acceleration * operatingEmptyMass) / mass) * conditionScale,
    );
    const surfaceFuel = response.segments
      .filter(x => surfaceTypes.has(x.type))
      .reduce((sum, x) => sum + x.stlFuelConsumption, 0);
    const hasJump = response.segments.some(x => x.type === 'JUMP' || x.type === 'JUMP_GATEWAY');
    for (const [index, segment] of response.segments.entries()) {
      const { type, stlDistance: distance, stlFuelConsumption: fuel } = segment;
      if (!flightTypes.has(type) && !surfaceTypes.has(type)) {
        continue;
      }
      if (type === 'TRANSIT' && segment.transferEllipse === null) {
        continue;
      }
      assert(Number.isFinite(distance) && distance > 0 && Number.isFinite(fuel) && fuel > 0);
      const seconds = (segment.arrival.timestamp - segment.departure.timestamp) / 1000;
      const surface = surfaceTypes.has(type);
      const surfaceFlight = surface
        ? stlSurfaceFlight(distance, effectiveAcceleration, flow)
        : undefined;
      const predict = a =>
        surface
          ? stlSurfaceFlight(distance, a, flow).seconds
          : stlTransferSeconds(distance, fuel, a, flow);
      const predicted =
        surfaceFlight?.seconds ?? stlTransferSeconds(distance, fuel, effectiveAcceleration, flow);
      if (!surface && predicted !== seconds) {
        const nearestIntegerBudgets = [fuel - 2, fuel - 1, fuel + 1, fuel + 2].filter(
          x => x > 0 && stlTransferSeconds(distance, x, effectiveAcceleration, flow) === seconds,
        );
        transferTimingMismatches.push({
          file,
          type,
          departureFuel: request.stlFuel,
          tier: request.fuelUsageFactor,
          recordedFuel: fuel,
          observedSeconds: seconds,
          secondsUsingRecordedFuel: predicted,
          nearestIntegerBudgets,
        });
      }
      const stat = (totals[type] ??= {
        points: 0,
        exactTimes: 0,
        maxTimeErrorSeconds: 0,
        exactTimesWhenApplyingConditionFirst: 0,
      });
      stat.points++;
      stat.exactTimes += Number(predicted === seconds);
      stat.maxTimeErrorSeconds = Math.max(stat.maxTimeErrorSeconds, Math.abs(seconds - predicted));
      stat.exactTimesWhenApplyingConditionFirst += Number(predict(applyConditionFirst) === seconds);
      if (surfaceFlight !== undefined) {
        recordFuel(fuelDiagnostics.surface, fuel, surfaceFlight.fuel);
        const endpoint = flightInputs?.environment?.[type === 'TAKE_OFF' ? 0 : 1];
        if (endpoint?.env?.pressure > 0 && endpoint.env.radiusKm > 0) {
          const precise = preciseEnvironment.get(endpoint.naturalId);
          let env = endpoint.env;
          if (precise !== undefined) {
            const radiusKm = precise.Radius / 1000;
            assert.equal(
              env.radiusKm,
              env.source === 'native' ? radiusKm : Math.round(radiusKm),
              'FIO 半径与采集记录不一致',
            );
            assert.equal(precise.Pressure, env.pressure, 'FIO 气压与采集记录不一致');
            env = { ...env, radiusKm };
          }
          const bodies = surfaceBodies[type];
          const body = bodies.get(endpoint.naturalId) ?? {
            name: endpoint.naturalId,
            env,
            observations: [],
          };
          const localOrbit = segment.origin?.lines?.find(x => x.type === 'ORBIT')?.orbit;
          const landingAltitudeKm =
            type === 'LANDING' && localOrbit?.semiMajorAxis > 0
              ? localOrbit.semiMajorAxis / 1000 - env.radiusKm
              : undefined;
          const estimatedDistance =
            type === 'TAKE_OFF'
              ? env.radiusKm * stlTakeoffDistanceRatio(env.pressure)
              : landingAltitudeKm === undefined
                ? undefined
                : stlLandingDistanceKm(landingAltitudeKm, env.pressure);
          if (estimatedDistance !== undefined) {
            const estimate = stlSurfaceFlight(estimatedDistance, effectiveAcceleration, flow);
            const stats = (surfaceDistanceDiagnostics[type] ??= {
              points: 0,
              preciseRadiusPoints: 0,
              maxDistanceErrorKm: 0,
              maxTimeErrorSeconds: 0,
              maxFuelError: 0,
            });
            stats.points++;
            stats.preciseRadiusPoints += Number(precise !== undefined || env.source === 'native');
            stats.maxDistanceErrorKm = Math.max(
              stats.maxDistanceErrorKm,
              Math.abs(distance - estimatedDistance),
            );
            stats.maxTimeErrorSeconds = Math.max(
              stats.maxTimeErrorSeconds,
              Math.abs(seconds - estimate.seconds),
            );
            stats.maxFuelError = Math.max(stats.maxFuelError, Math.abs(fuel - estimate.fuel));
          }
          const previousOrbit = response.segments[index - 1]?.destination?.lines?.find(
            x => x.type === 'ORBIT',
          )?.orbit;
          const observation = {
            distance,
            seconds,
            fuel,
            effectiveAcceleration,
            flow,
            landingAltitudeKm,
            matchesPreviousOrbit:
              landingAltitudeKm !== undefined && isDeepStrictEqual(localOrbit, previousOrbit),
          };
          body.observations.push(observation);
          bodies.set(endpoint.naturalId, body);
          if (type === 'LANDING') {
            const controls = { ...request };
            delete controls.missionId;
            const key = JSON.stringify(controls);
            const repeat = landingRepeats.get(key) ?? {
              body: endpoint.naturalId,
              tier: request.fuelUsageFactor,
              observations: [],
            };
            repeat.observations.push({ ...observation, startMs: segment.departure.timestamp });
            landingRepeats.set(key, repeat);
          }
        }
      }
      if (type === 'TRANSIT' && !hasJump) {
        // 分配规律用生产实现；这里的「最小转移燃料」是本文件按采集数据拟合的经验下限
        // （stlMinimumTransferFuel 需要目标轨道速度，而本诊断不重建星历），不是游戏公式。
        const empiricalMinimumFuel = (4 * flow) / 0.015;
        const predictedFuel = allocateTransferFuel(
          empiricalMinimumFuel,
          request.fuelUsageFactor,
          request.stlFuel - surfaceFuel,
        );
        recordFuel(fuelDiagnostics.transitUsingObservedSurfaceFuel, fuel, predictedFuel);
        transit.push({
          blueprint: blueprint.id,
          request,
          distance,
          fuel,
          seconds,
          flow,
          effectiveAcceleration,
        });
      }
    }
  }
}

let transitFuelHoldout;
const match = transit.find(x => x.request.stlFuel === 750);
const fuelTrialControls = ({ stlFuel, fuelUsageFactor, missionId, ...inputs }) => inputs;
const cohort =
  match === undefined
    ? []
    : transit.filter(x =>
        isDeepStrictEqual(fuelTrialControls(x.request), fuelTrialControls(match.request)),
      );
const train = cohort.filter(x => x.request.stlFuel === 1500);
const test = cohort.filter(x => x.request.stlFuel === 750);
if (train.length > 1 && test.length > 0) {
  const { intercept, slope } = fitLinear(
    train,
    x => x.request.fuelUsageFactor,
    x => x.fuel - x.request.stlFuel * x.request.fuelUsageFactor,
  );
  const points = test.map(x => {
    const predictedFuel = Math.round(
      intercept + (x.request.stlFuel + slope) * x.request.fuelUsageFactor,
    );
    return {
      f: x.request.fuelUsageFactor,
      actualFuel: x.fuel,
      predictedFuel,
      actualSeconds: x.seconds,
      predictedSeconds: stlTransferSeconds(
        x.distance,
        predictedFuel,
        x.effectiveAcceleration,
        x.flow,
      ),
    };
  });
  transitFuelHoldout = { intercept, reserve: -slope, points };
}

const surfaceHoldout = {};
for (const [type, entries] of Object.entries(surfaceBodies)) {
  const bodies = [...entries.values()];
  if (bodies.length < 3) {
    continue;
  }
  surfaceHoldout[type] = bodies.map(body => {
    const curve = fitLinear(
      bodies.filter(x => x !== body),
      x => surfacePressure(type, x.env.pressure),
      x =>
        Math.log(
          x.observations.reduce((total, row) => total + row.distance, 0) /
            x.observations.length /
            x.env.radiusKm,
        ),
    );
    const results = body.observations.map(row => {
      const model = naturalSurfaceFlight(
        type,
        body.env,
        { [type]: curve },
        row.effectiveAcceleration,
        row.flow,
      );
      return scoreFlight(
        { seconds: model.seconds, stlFuel: model.fuel, ftlFuel: 0 },
        { seconds: row.seconds, stlFuel: row.fuel, ftlFuel: 0 },
      );
    });
    const landingAltitudes = body.observations.filter(x => x.landingAltitudeKm > 0);
    const relativeAltitudes = landingAltitudes.map(x => x.landingAltitudeKm / body.env.radiusKm);
    const distanceToAltitude = landingAltitudes.map(x => x.distance / x.landingAltitudeKm);
    const estimatedFromAltitude = landingAltitudes.map(row => {
      const distance = stlLandingDistanceKm(row.landingAltitudeKm, body.env.pressure);
      const estimate = stlSurfaceFlight(distance, row.effectiveAcceleration, row.flow);
      return {
        distanceErrorPct: 100 * Math.abs(distance / row.distance - 1),
        secondsError: Math.abs(estimate.seconds - row.seconds),
        fuelError: Math.abs(estimate.fuel - row.fuel),
      };
    });
    const orbitWindow = landingAltitudes.map(row => {
      const distances = [0.13, 0.17].map(x =>
        stlLandingDistanceKm(x * body.env.radiusKm, body.env.pressure),
      );
      const [lo, hi] = distances.map(x => stlSurfaceFlight(x, row.effectiveAcceleration, row.flow));
      return {
        distanceCovered: distances[0] <= row.distance && row.distance <= distances[1],
        timeAndFuelCovered:
          lo.seconds <= row.seconds &&
          row.seconds <= hi.seconds &&
          lo.fuel <= row.fuel &&
          row.fuel <= hi.fuel,
        widthSeconds: hi.seconds - lo.seconds,
      };
    });
    return {
      body: body.name,
      points: results.length,
      passing: results.filter(x => x.passed).length,
      maxTimeErrorSeconds: Math.max(...results.map(x => Math.abs(x.checks.seconds.error))),
      maxFuelError: Math.max(...results.map(x => Math.abs(x.checks.stlFuel.error))),
      landingAltitudes:
        landingAltitudes.length === 0
          ? undefined
          : {
              points: landingAltitudes.length,
              relativeRange: [Math.min(...relativeAltitudes), Math.max(...relativeAltitudes)],
              distanceMultiplierRange: [
                Math.min(...distanceToAltitude),
                Math.max(...distanceToAltitude),
              ],
              maxDistanceErrorPct: Math.max(...estimatedFromAltitude.map(x => x.distanceErrorPct)),
              maxTimeErrorSeconds: Math.max(...estimatedFromAltitude.map(x => x.secondsError)),
              maxFuelError: Math.max(...estimatedFromAltitude.map(x => x.fuelError)),
              matchingPreviousOrbit: landingAltitudes.filter(x => x.matchesPreviousOrbit).length,
              observedWindow: {
                distanceCovered: orbitWindow.filter(x => x.distanceCovered).length,
                timeAndFuelCovered: orbitWindow.filter(x => x.timeAndFuelCovered).length,
                widthSeconds: range(orbitWindow.map(x => x.widthSeconds)),
              },
            },
      bestFixedLandingDistance:
        type === 'LANDING' ? bestFixedLandingDistance(body.observations) : undefined,
    };
  });
}

assert(missions.size > 0 && Object.keys(totals).length > 0);
const repeatedLandings = [...landingRepeats.values()]
  .filter(x => x.observations.length > 1)
  .map(({ body, tier, observations }) => {
    const ordered = observations.toSorted((a, b) => a.startMs - b.startMs);
    const [closest] = ordered
      .slice(1)
      .map((x, i) => ({
        gapMs: x.startMs - ordered[i].startMs,
        distancesKm: [ordered[i].distance, x.distance],
      }))
      .sort((a, b) => a.gapMs - b.gapMs);
    return {
      body,
      tier,
      timeRangeSeconds: range(observations.map(x => x.seconds)),
      fuelRange: range(observations.map(x => x.fuel)),
      distanceRangeKm: range(observations.map(x => x.distance)),
      closest,
      bestFixedLandingDistance: bestFixedLandingDistance(observations),
    };
  });
console.log(
  JSON.stringify(
    {
      totals,
      fuelDiagnostics,
      transitFuelHoldout,
      surfaceHoldout,
      surfaceDistanceDiagnostics,
      repeatedLandings,
      transferTimingMismatches,
    },
    null,
    2,
  ),
);
