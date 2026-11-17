// Usage: node --experimental-strip-types scripts/verify-stl-transfer-geometry.mjs [--surface-pressure] [--orbital-speed-budget] <exports> [...] [--holdout <exports> ...]
// With --holdout, scores unseen routes offline. --surface-pressure needs no training exports.
import assert from 'node:assert/strict';
import { stlSurfaceFlight } from '../src/core/flight/stl.ts';
import { ellipseBetween } from '../src/core/flight/transfer-ellipse.ts';
import {
  position,
  predictSameSystemRoute,
  sameSystemFlightPerformance,
  sameSystemSurfacePhase,
  transferTime,
} from './lib/stl-geometry-pilot.mjs';
import { fitLinear, readFlightObservations } from './lib/flight-observations.mjs';
import {
  flightPhase,
  flightSample,
  scoreFlight,
  scoreFlightSegments,
} from './lib/flight-acceptance.mjs';

const relativeError = (estimate, actual) => (100 * (estimate - actual)) / actual;
const useSurfacePressure = process.argv.includes('--surface-pressure');
const useOrbitalSpeedBudget = process.argv.includes('--orbital-speed-budget');
const useSeededLanding = process.argv.includes('--seeded-landing-orbit');
const args = process.argv
  .slice(2)
  .filter(
    x => !['--surface-pressure', '--orbital-speed-budget', '--seeded-landing-orbit'].includes(x),
  );
assert(!useSeededLanding || useSurfacePressure, '着陆轨道需与气压起降模型一起使用');
const split = args.indexOf('--holdout');
const files = split < 0 ? args : args.slice(0, split);
const holdout = split < 0 ? [] : args.slice(split + 1);
assert(files.length > 0 || (useSurfacePressure && holdout.length > 0), '缺少原始试飞导出');
assert(split < 0 || holdout.length > 0, '缺少留出导出');
const routes = {};
const missions = new Set();
const surfaceSamples = { TAKE_OFF: new Map(), LANDING: new Map() };

for (const file of [...files, ...holdout]) {
  for (const row of readFlightObservations(file)) {
    if (row.response?.status !== 'OK' || missions.has(row.request.missionId)) {
      continue;
    }
    missions.add(row.request.missionId);
    const { segments } = row.response;
    const transit = segments.find(x => x.type === 'TRANSIT');
    if (transit === undefined) {
      continue;
    }
    assert.equal(row.request.missionId, row.response.missionId);
    const orbitInputs = row.flightInputs?.orbit;
    assert.equal(orbitInputs?.endpoints?.length, 2, '缺少试飞前的端点轨道');
    const [from, to] = orbitInputs.endpoints;
    assert(from.orbit && to.orbit && from.systemId === to.systemId);
    const { transferEllipse: e, departure, arrival, stlDistance, stlFuelConsumption } = transit;
    assert(e && stlDistance > 0 && stlFuelConsumption > 0);
    const observed = ellipseBetween(e.startPosition, e.targetPosition);
    assert(Math.abs(observed.a - e.semiMajorAxis) < 1e-5);
    assert(Math.abs(observed.b - e.semiMinorAxis) < 1e-5);
    const atObservedTimes = ellipseBetween(
      position(from, departure.timestamp, orbitInputs),
      position(to, arrival.timestamp, orbitInputs),
    );
    const q = row.request;
    const performance = sameSystemFlightPerformance(q, row.blueprint);
    const { acceleration: a, flow } = performance;
    const takeoff = segments.find(x => x.type === 'TAKE_OFF');
    const takeoffMillis = takeoff ? takeoff.arrival.timestamp - takeoff.departure.timestamp : 0;
    assert(Number.isFinite(row.gameTimeMs));
    const { length, seconds: t } = transferTime(
      orbitInputs,
      row.gameTimeMs + takeoffMillis,
      stlFuelConsumption,
      a,
      flow,
    );
    const key = from.naturalId + ' → ' + to.naturalId;
    const environment = row.flightInputs.environment;
    let offline;
    if (holdout.includes(file)) {
      assert(!routes[key]?.some(x => x.training), '留出组与训练组存在相同航线');
      const modelSurface = (kind, env) => {
        if (useSurfacePressure) {
          return sameSystemSurfacePhase(kind, env, q, a, flow, useSeededLanding);
        }
        assert(env.pressure > 0);
        const samples = [...surfaceSamples[kind].values()].map(x => ({
          pressure: x.env.pressure,
          distancePerRadius: x.totalDistance / x.count / x.env.radiusKm,
        }));
        assert(samples.length >= 2);
        const fit = fitLinear(
          samples,
          x => Math.log(x.pressure),
          x => Math.log(x.distancePerRadius),
        );
        const distance =
          env.radiusKm * Math.exp(fit.intercept + fit.slope * Math.log(env.pressure));
        return stlSurfaceFlight(distance, a, flow);
      };
      const estimate = predictSameSystemRoute(
        q,
        row.flightInputs,
        row.gameTimeMs,
        performance,
        modelSurface,
        useOrbitalSpeedBudget,
      );
      const {
        seconds: totalSeconds,
        stlFuel: totalFuel,
        transfer,
        takeoff: up,
        landing: down,
      } = estimate;
      const f = q.fuelUsageFactor;
      offline = {
        ...flightSample(q, row.blueprint),
        model:
          (useSurfacePressure ? 'surface-pressure' : 'fitted-surface') +
          (useOrbitalSpeedBudget ? '-orbital-speed-budget' : '') +
          (useSeededLanding ? '-seeded-landing-orbit' : ''),
        f,
        departureFuel: q.stlFuel,
        totalTimeErrorPct: relativeError(totalSeconds, row.response.eta.millis / 1000),
        totalFuelErrorPct: relativeError(totalFuel, row.response.stlFuelConsumption),
        totalTimeErrorSeconds: totalSeconds - row.response.eta.millis / 1000,
        totalFuelErrorUnits: totalFuel - row.response.stlFuelConsumption,
        segmentScores: scoreFlightSegments(
          [
            ...(up ? [flightPhase('TAKE_OFF', up.seconds, up.fuel)] : []),
            flightPhase('TRANSIT', transfer.seconds, transfer.fuel),
            ...(down ? [flightPhase('LANDING', down.seconds, down.fuel)] : []),
          ],
          segments,
        ),
        score: scoreFlight(estimate, {
          seconds: row.response.eta.millis / 1000,
          stlFuel: row.response.stlFuelConsumption,
          ftlFuel: row.response.ftlFuelConsumption ?? 0,
        }),
      };
    } else if (environment?.length === 2) {
      for (const [i, type] of ['TAKE_OFF', 'LANDING'].entries()) {
        const { naturalId, env } = environment[i];
        const segment = segments.find(x => x.type === type);
        if (env?.pressure > 0 && env.radiusKm > 0 && segment?.stlDistance > 0) {
          const sample = surfaceSamples[type].get(naturalId) ?? { env, totalDistance: 0, count: 0 };
          sample.totalDistance += segment.stlDistance;
          sample.count++;
          surfaceSamples[type].set(naturalId, sample);
        }
      }
    }
    (routes[key] ??= []).push({
      training: !holdout.includes(file),
      offline,
      arcErrorPct: relativeError(observed.length, stlDistance),
      ephemerisDistanceErrorPct: relativeError(atObservedTimes.length, stlDistance),
      fixedPointDistanceErrorPct: relativeError(length, stlDistance),
      fixedPointTimeErrorPct: relativeError(t, (arrival.timestamp - departure.timestamp) / 1000),
    });
  }
}
assert(Object.keys(routes).length > 0, '缺少系内转移样本');
assert(
  holdout.length === 0 ||
    Object.values(routes).some(rows => rows.some(x => x.offline !== undefined)),
  '缺少可评分的留出样本',
);
console.log(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(routes).map(([route, rows]) => [
        route,
        {
          observations: rows.length,
          maxArcErrorPct: Math.max(...rows.map(x => Math.abs(x.arcErrorPct))),
          maxEphemerisDistanceErrorPct: Math.max(
            ...rows.map(x => Math.abs(x.ephemerisDistanceErrorPct)),
          ),
          maxFixedPointDistanceErrorPct: Math.max(
            ...rows.map(x => Math.abs(x.fixedPointDistanceErrorPct)),
          ),
          maxFixedPointTimeErrorPct: Math.max(...rows.map(x => Math.abs(x.fixedPointTimeErrorPct))),
          offlineHoldout: rows.flatMap(x => (x.offline === undefined ? [] : [x.offline])),
        },
      ]),
    ),
    null,
    2,
  ),
);
