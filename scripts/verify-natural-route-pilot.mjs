// Usage: node --experimental-strip-types scripts/verify-natural-route-pilot.mjs [budget option] [--takeoff-pressure] [--ftl-shortfall-diagnostic] <surface training exports> --replay <natural route exports>
// Replays the natural-route model using only preflight data. Its fuel allocation is provisional.
import assert from 'node:assert/strict';
import { stlTakeoffDistanceRatio } from '../src/core/flight/stl.ts';
import { readFlightObservations } from './lib/flight-observations.mjs';
import { flightSample, scoreFlight, scoreFlightSegments } from './lib/flight-acceptance.mjs';
import {
  fitNaturalSurfaceCurves,
  createNaturalOrbitalBudget,
  predictNaturalRoute,
} from './lib/natural-route-pilot.mjs';

const inputs = process.argv.slice(2);
const useOriginal = inputs.includes('--original-budget');
const useOrbitalApproach = inputs.includes('--orbital-approach-budget');
const useOrbitalSpeedReserve = inputs.includes('--orbital-speed-reserve');
const useDepartureMinimumReserve = inputs.includes('--departure-minimum-reserve');
const useStationApproachReserve = inputs.includes('--station-approach-reserve');
const useHalfUnitReserve = inputs.includes('--half-unit-reserve');
const useOrbitApproachWithoutReserve = inputs.includes('--orbit-approach-without-reserve');
assert(!(useOriginal && useOrbitalApproach));
assert(!useDepartureMinimumReserve || useOrbitalApproach, '离港预留需与轨道进近预算一起使用');
assert(!useStationApproachReserve || useDepartureMinimumReserve, '站间进近预留需使用轨道最低燃油');
assert(!useOrbitalSpeedReserve || useOrbitalApproach, '轨道速度预留需与轨道进近预算一起使用');
assert(!(useOrbitalSpeedReserve && useOrbitApproachWithoutReserve), '请选择一种进近预算');
assert(!useHalfUnitReserve || useOrbitalApproach, '半单位预留需与轨道进近预算一起使用');
assert(!useOrbitApproachWithoutReserve || useHalfUnitReserve, '请同时指定半单位预留');
const useTakeoffPressure = inputs.includes('--takeoff-pressure');
const useSeededLanding = inputs.includes('--seeded-landing-orbit');
const useFtlShortfallDiagnostic = inputs.includes('--ftl-shortfall-diagnostic');
const options = [
  '--original-budget',
  '--orbital-approach-budget',
  '--orbital-speed-reserve',
  '--departure-minimum-reserve',
  '--station-approach-reserve',
  '--half-unit-reserve',
  '--orbit-approach-without-reserve',
  '--takeoff-pressure',
  '--seeded-landing-orbit',
  '--ftl-shortfall-diagnostic',
];
const args = inputs.filter(x => !options.includes(x));
const split = args.indexOf('--replay');
assert(split > 0 && split < args.length - 1, '需要起降训练导出及跨星系复算导出');

const surfaceCurves = fitNaturalSurfaceCurves(args.slice(0, split));
surfaceCurves.seededLanding = useSeededLanding;
if (useTakeoffPressure) {
  surfaceCurves.TAKE_OFF.distanceRatio = stlTakeoffDistanceRatio;
}
const model =
  (useOriginal
    ? 'original-budget'
    : useOrbitalApproach
      ? 'orbital-approach-budget'
      : 'reserve-budget') +
  (useHalfUnitReserve ? '-half-unit-reserve' : '') +
  (useOrbitApproachWithoutReserve ? '-orbit-approach-without-reserve' : '') +
  (useOrbitalSpeedReserve ? '-orbital-speed-reserve' : '') +
  (useDepartureMinimumReserve ? '-departure-minimum-reserve' : '') +
  (useStationApproachReserve ? '-station-approach-reserve' : '') +
  (useSeededLanding ? '-seeded-landing-orbit' : '') +
  (useTakeoffPressure ? '-takeoff-pressure' : '') +
  '-condition-speed-departure-cap';
const orbitalBudget = createNaturalOrbitalBudget({
  halfUnitReserve: useHalfUnitReserve,
  orbitApproachWithoutReserve: useOrbitApproachWithoutReserve,
  orbitalSpeedReserve: useOrbitalSpeedReserve,
  departureMinimumReserve: useDepartureMinimumReserve,
  stationApproachReserve: useStationApproachReserve,
});
const fuelBudget = useOrbitalApproach
  ? orbitalBudget
  : (startingFuel, surfaceFuel, tier, flow) => {
      const base = ((startingFuel - surfaceFuel) * tier) / 2;
      if (useOriginal) {
        return {
          departureFuel: Math.floor(base),
          approachFuel: Math.floor((startingFuel * tier) / 2),
        };
      }
      return { departureFuel: Math.round(base), approachFuel: Math.floor(base + 400 * flow) };
    };

const rows = [];
const status = useFtlShortfallDiagnostic ? 'MISSING_FTL_FUEL' : 'OK';
for (const file of args.slice(split + 1)) {
  for (const { request, blueprint, response, flightInputs, gameTimeMs } of readFlightObservations(
    file,
  )) {
    if (response?.status !== status) {
      continue;
    }
    assert.equal(request.missionId, response.missionId);
    const effectiveRequest = useFtlShortfallDiagnostic
      ? { ...request, reactorUsageFactor: blueprint.performance.minReactorUsage }
      : request;
    const predicted = predictNaturalRoute(
      effectiveRequest,
      blueprint,
      flightInputs,
      gameTimeMs,
      surfaceCurves,
      fuelBudget,
    );
    const jumps = response.segments.filter(x => x.type === 'JUMP' || x.type === 'JUMP_GATEWAY');
    const system = address => address.lines.find(x => x.type === 'SYSTEM')?.entity.id;
    assert(jumps.length > 0 && jumps.every(x => x.type === 'JUMP'));
    assert.deepEqual(
      [system(jumps[0].origin), ...jumps.map(x => system(x.destination))],
      predicted.path,
    );
    const dep = response.segments.find(x => x.type === 'DEPARTURE');
    const app = response.segments.find(x => x.type === 'APPROACH');
    const up = response.segments.find(x => x.type === 'TAKE_OFF');
    const down = response.segments.find(x => x.type === 'LANDING');
    assert(dep && app);
    const actualSeconds = segment =>
      (segment.arrival.timestamp - segment.departure.timestamp) / 1000;
    const error = (estimate, actual) => 100 * (estimate / actual - 1);
    rows.push({
      ...flightSample(request, blueprint, true),
      model,
      blueprint: blueprint.naturalId,
      tier: request.fuelUsageFactor,
      departureFuel: request.stlFuel,
      r: request.reactorUsageFactor,
      ...(useFtlShortfallDiagnostic
        ? { effectiveReactor: effectiveRequest.reactorUsageFactor }
        : {}),
      departureErrorPct: error(predicted.departureKm, dep.stlDistance),
      approachErrorPct: error(predicted.approachKm, app.stlDistance),
      departureFuelError: predicted.departureFuel - dep.stlFuelConsumption,
      approachFuelError: predicted.approachFuel - app.stlFuelConsumption,
      ...(up ? { takeoffTimeErrorSeconds: predicted.takeoff.seconds - actualSeconds(up) } : {}),
      ...(down ? { landingTimeErrorSeconds: predicted.landing.seconds - actualSeconds(down) } : {}),
      ...(up ? { takeoffFuelError: predicted.takeoff.fuel - up.stlFuelConsumption } : {}),
      ...(down ? { landingFuelError: predicted.landing.fuel - down.stlFuelConsumption } : {}),
      timeErrorPct: error(predicted.seconds, response.eta.millis / 1000),
      stlFuelErrorPct: error(predicted.stlFuel, response.stlFuelConsumption),
      ftlFuelError: predicted.ftlFuel - response.ftlFuelConsumption,
      segmentScores: scoreFlightSegments(predicted.segments, response.segments),
      score: scoreFlight(predicted, {
        seconds: response.eta.millis / 1000,
        stlFuel: response.stlFuelConsumption,
        ftlFuel: response.ftlFuelConsumption,
      }),
    });
  }
}
assert(rows.length > 0);
const keys = new Set(rows.flatMap(row => Object.keys(row).filter(x => x.includes('Error'))));
const maxAbsoluteErrors = Object.fromEntries(
  [...keys].map(key => [
    key,
    Math.max(
      ...rows
        .map(row => row[key])
        .filter(Number.isFinite)
        .map(Math.abs),
    ),
  ]),
);
const passing = rows.filter(row => row.score.passed).length;
console.log(
  JSON.stringify(
    {
      count: rows.length,
      passing,
      maxAbsoluteErrors,
      ...(useFtlShortfallDiagnostic ? { diagnostics: rows } : { rows }),
    },
    null,
    2,
  ),
);
