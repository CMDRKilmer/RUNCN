// Usage: node --experimental-strip-types scripts/verify-flight-itinerary.mjs [--seeded-landing-orbit | --natural-v3] <surface exports> --legs <connected natural-route exports>
//        node --experimental-strip-types scripts/verify-flight-itinerary.mjs --gateway-round-trip [--orbital-minimum-budget] <outbound export>
//        node --experimental-strip-types scripts/verify-flight-itinerary.mjs --same-system <STL tier> --legs <connected same-system exports>
//        node --experimental-strip-types scripts/verify-flight-itinerary.mjs --completed-log <PrUn log> <tank readings>
// Exit nonzero on a broken itinerary. Each leg uses the first successful request matching its tier.
// The forecasts use synthetic departures after the first leg and do not count as blind observations.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { advanceFlightState, predictNoRefuelItinerary } from '../src/core/flight/itinerary.ts';
import { stlTakeoffDistanceRatio } from '../src/core/flight/stl.ts';
import { readFlightObservations } from './lib/flight-observations.mjs';
import { selectFlightRoute } from './lib/flight-path-pilot.mjs';
import {
  orbitalEndpointFuel,
  orbitalMinimumEndpointFuel,
  stationGatewayFlight,
} from './lib/gateway-pilot.mjs';
import {
  createNaturalOrbitalBudget,
  fitNaturalSurfaceCurves,
  orbitalNaturalBudget,
  predictNaturalRoute,
} from './lib/natural-route-pilot.mjs';
import {
  predictSameSystemRoute,
  sameSystemFlightPerformance,
  sameSystemSurfacePhase,
} from './lib/stl-geometry-pilot.mjs';

function checkCompletedFlights(logPath, tankPath) {
  const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  const events = readJson(logPath);
  const { departures, final } = readJson(tankPath);
  assert(Array.isArray(events) && Array.isArray(departures) && departures.length >= 2);
  const flightIds = departures.map(x => x.flightId);
  assert(flightIds.every(x => typeof x === 'string' && x.length > 0));
  assert.equal(new Set(flightIds).size, flightIds.length, '原生航次 ID 重复');
  const completed = new Map(
    events
      .filter(x => x.messageType === 'SHIP_FLIGHT_FLIGHT_ENDED')
      .map(x => [x.payload.id, x.payload]),
  );
  const addressKey = address => address.lines.map(x => [x.type, x.entity?.id, x.orbit]);
  const readBalance = x => {
    assert(
      [x.stlFuel, x.ftlFuel].every(n => Number.isFinite(n) && n >= 0),
      '缺少实际油箱读数',
    );
    return { stlFuel: x.stlFuel, ftlFuel: x.ftlFuel };
  };
  let prior;
  const flights = departures.map((reading, index) => {
    const flight = completed.get(reading.flightId);
    assert(flight && flight.aborted === false, '缺少正常完成的原生航次');
    assert(typeof flight.shipId === 'string' && flight.shipId.length > 0);
    assert(Array.isArray(flight.segments) && flight.segments.length > 0);
    const atMs = flight.departure.timestamp;
    const endMs = flight.arrival.timestamp;
    assert(Number.isFinite(atMs) && Number.isFinite(endMs) && endMs > atMs);
    const departure = { atMs, ...readBalance(reading) };
    if (prior !== undefined) {
      assert.equal(prior.shipId, flight.shipId, '两程必须为同一艘船');
      assert(prior.arrival.timestamp <= atMs, '上一程到达必须早于或等于下一程出发');
      assert.deepEqual(addressKey(prior.destination), addressKey(flight.origin), '原生地址不连续');
    }
    const usage = key =>
      flight.segments.reduce((sum, segment) => {
        const fuel = segment[key];
        assert(fuel === null || (Number.isFinite(fuel) && fuel >= 0), '缺少原生航段扣油数据');
        return sum + (fuel ?? 0);
      }, 0);
    const flightUse = {
      seconds: (endMs - atMs) / 1000,
      stlFuel: usage('stlFuelConsumption'),
      ftlFuel: usage('ftlFuelConsumption'),
    };
    const result = advanceFlightState(departure, flightUse);
    assert(result.ok, '原生耗油超出记录的出发余量');
    const nextBalance = readBalance(departures.at(index + 1) ?? final);
    assert.equal(result.arrival.stlFuel, nextBalance.stlFuel, 'STL 余量与原生扣油不衔接');
    assert.equal(result.arrival.ftlFuel, nextBalance.ftlFuel, 'FTL 余量与原生扣油不衔接');
    prior = flight;
    return { flightId: flight.id, departure, flightUse, arrival: result.arrival };
  });
  return { shipId: prior.shipId, flights };
}

const inputs = process.argv.slice(2);
if (inputs[0] === '--completed-log') {
  assert(inputs.length === 3, '请提供原生 PrUn 日志和油箱读数清单');
  console.log(JSON.stringify(checkCompletedFlights(inputs[1], inputs[2]), null, 2));
  process.exit(0);
}
const sameSystem = inputs[0] === '--same-system';
const useNaturalV3 = inputs.includes('--natural-v3');
const useSeededLanding = sameSystem || useNaturalV3 || inputs.includes('--seeded-landing-orbit');
const useOrbitalMinimumBudget = inputs.includes('--orbital-minimum-budget');
const args = inputs.filter(
  x => !['--seeded-landing-orbit', '--natural-v3', '--orbital-minimum-budget'].includes(x),
);
const gatewayRoundTrip = args[0] === '--gateway-round-trip';
const split = args.indexOf('--legs');
const sameSystemTier = sameSystem ? Number(args[1]) : undefined;
assert(!sameSystem || (!useNaturalV3 && split === 2 && sameSystemTier > 0 && sameSystemTier <= 1));
assert(!gatewayRoundTrip || !useSeededLanding, '纯网关站间往返没有着陆段');
assert(!useOrbitalMinimumBudget || gatewayRoundTrip, '轨道最低油量预算用于纯网关往返');
assert(
  gatewayRoundTrip ? args.length === 2 : split > 0 && args.length - split > 2,
  '请提供一份纯网关去程或至少两段连续航线',
);
const curves =
  gatewayRoundTrip || sameSystem ? undefined : fitNaturalSurfaceCurves(args.slice(0, split));
if (curves) {
  curves.TAKE_OFF.distanceRatio = stlTakeoffDistanceRatio;
  curves.seededLanding = useSeededLanding;
}
const legs = (gatewayRoundTrip ? args.slice(1) : args.slice(split + 1)).map(file => {
  const row = [...readFlightObservations(file)].find(
    x =>
      x.response?.status === 'OK' &&
      (sameSystemTier === undefined || x.request.fuelUsageFactor === sameSystemTier),
  );
  assert(row, '该航段缺少有效原始试飞');
  return row;
});
const first = legs[0];
if (useSeededLanding) {
  assert.equal(new Set(legs.map(leg => leg.request.missionId)).size, legs.length, '航段任务重复');
}
if (gatewayRoundTrip) {
  const { request, response, flightInputs } = first;
  assert(request.origin.includes('|STA,') && request.destination.includes('|STA,'));
  assert(request.preferences.useGateways && request.preferences.ftlPreference === 'LEAST_JUMPS');
  assert(response.segments.some(segment => segment.type === 'JUMP_GATEWAY'));
  assert(!response.segments.some(segment => segment.type === 'JUMP'));
  legs.push({
    blueprint: first.blueprint,
    request: { ...request, origin: request.destination, destination: request.origin },
    flightInputs: {
      ...flightInputs,
      orbit: { ...flightInputs.orbit, endpoints: flightInputs.orbit.endpoints.toReversed() },
    },
  });
}
const initial = {
  atMs: first.gameTimeMs,
  stlFuel: first.request.stlFuel,
  ftlFuel: first.request.ftlFuel,
};
const budget = useNaturalV3
  ? createNaturalOrbitalBudget({
      halfUnitReserve: true,
      orbitApproachWithoutReserve: true,
      departureMinimumReserve: true,
      stationApproachReserve: true,
    })
  : (startingFuel, surfaceFuel, tier, flow, destination) =>
      orbitalNaturalBudget(startingFuel, surfaceFuel, tier, flow, destination, 0.5);
const itinerary = predictNoRefuelItinerary(
  initial,
  legs.map(input => ({ input })),
  (leg, departure, index) => {
    if (index > 0) {
      assert.equal(legs[index - 1].request.destination, leg.request.origin, '相邻航段地址不衔接');
    }
    const request = {
      ...leg.request,
      stlFuel: departure.stlFuel,
      ftlFuel: departure.ftlFuel,
    };
    const [origin, destination] = leg.flightInputs.orbit.endpoints;
    let predicted;
    if (gatewayRoundTrip) {
      const route = selectFlightRoute(
        leg.flightInputs,
        origin.systemId,
        destination.systemId,
        request.preferences,
        leg.blueprint.performance.totalVolume,
      );
      assert(route?.length > 0 && route.every(hop => hop.gate), '连续试算需要两程都为纯网关');
      const path = route.map(hop => hop.gate);
      const flight = stationGatewayFlight(
        leg.flightInputs,
        path,
        leg.blueprint,
        request,
        departure.atMs,
      );
      const baseFuel = ((request.stlFuel - flight.fixedFuel - 15) * request.fuelUsageFactor) / 2;
      const transferFuel = useOrbitalMinimumBudget
        ? orbitalMinimumEndpointFuel(
            flight,
            leg.flightInputs.orbit,
            destination,
            request,
            departure.atMs,
          )
        : orbitalEndpointFuel(flight, origin, destination, baseFuel);
      predicted = flight.estimate(...transferFuel);
    } else if (sameSystem) {
      const performance = sameSystemFlightPerformance(request, leg.blueprint);
      predicted = predictSameSystemRoute(
        request,
        leg.flightInputs,
        departure.atMs,
        performance,
        (kind, env) =>
          sameSystemSurfacePhase(
            kind,
            env,
            request,
            performance.acceleration,
            performance.flow,
            true,
          ),
        true,
      );
    } else {
      predicted = predictNaturalRoute(
        request,
        leg.blueprint,
        leg.flightInputs,
        departure.atMs,
        curves,
        budget,
      );
    }
    return predicted;
  },
);
assert(itinerary.ok, '连续飞行时剩余油量不足');
const forecasts = itinerary.steps.map(({ departure, predicted, arrival }, index) => {
  const leg = legs[index];
  const route = leg.flightInputs.orbit.endpoints.map(x => x.naturalId);
  return {
    route,
    ...(useSeededLanding ? { missionId: leg.request.missionId } : {}),
    departure,
    payload: leg.request.payload,
    seconds: predicted.seconds,
    stlUsed: predicted.stlFuel,
    ftlUsed: predicted.ftlFuel,
    arrival,
  };
});
const arrival = itinerary.arrival;
const used = key => forecasts.reduce((sum, leg) => sum + leg[key], 0);
assert.equal(arrival.stlFuel, initial.stlFuel - used('stlUsed'));
assert.equal(arrival.ftlFuel, initial.ftlFuel - used('ftlUsed'));
assert(Math.abs(arrival.atMs - (initial.atMs + 1000 * used('seconds'))) < 0.001);
assert.deepEqual(
  advanceFlightState(initial, { seconds: 0, stlFuel: initial.stlFuel, ftlFuel: initial.ftlFuel }),
  { ok: true, arrival: { atMs: initial.atMs, stlFuel: 0, ftlFuel: 0 } },
);
assert.deepEqual(
  advanceFlightState(
    { atMs: initial.atMs, stlFuel: 0, ftlFuel: 0 },
    {
      seconds: 1,
      stlFuel: 1,
      ftlFuel: 2,
    },
  ),
  { ok: false, shortfall: { stlFuel: 1, ftlFuel: 2 } },
);
console.log(
  JSON.stringify(
    {
      ...(gatewayRoundTrip ? { syntheticReturn: true } : {}),
      ...(useNaturalV3 ? { model: 'natural-v3', syntheticDepartures: true } : {}),
      ...(sameSystem ? { model: 'same-system', syntheticDepartures: true } : {}),
      forecasts,
    },
    null,
    2,
  ),
);
