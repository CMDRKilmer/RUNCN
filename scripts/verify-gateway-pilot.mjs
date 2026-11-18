// Usage: node --experimental-strip-types scripts/verify-gateway-pilot.mjs [budget option] [--gateway-snapshot <earlier export>] <raw-export.json> [...]
// Replays a station-to-station route through a connected chain of operational gateways.
import assert from 'node:assert/strict';
import { readFlightObservations } from './lib/flight-observations.mjs';
import {
  flightPhase,
  flightSample,
  scoreFlight,
  scoreFlightSegments,
} from './lib/flight-acceptance.mjs';
import { selectFlightRoute } from './lib/flight-path-pilot.mjs';
import {
  orbitalEndpointFuel,
  orbitalMinimumEndpointFuel,
  stationGatewayFlight,
} from './lib/gateway-pilot.mjs';

const system = address => address.lines.find(x => x.type === 'SYSTEM')?.entity?.naturalId;
const gateway = address => address.lines.find(x => x.type === 'SATELLITE')?.entity?.naturalId;
const milliseconds = segment => segment.arrival.timestamp - segment.departure.timestamp;

const args = process.argv.slice(2);
const snapshotArg = args.indexOf('--gateway-snapshot');
let archivedGatewaySnapshot;
if (snapshotArg !== -1) {
  assert(args[snapshotArg + 1], '缺少较早的网关导出');
  const [, source] = args.splice(snapshotArg, 2);
  archivedGatewaySnapshot = [...readFlightObservations(source)].find(
    x => Number.isFinite(x.requestedAt) && x.flightInputs?.gatewayConnections?.length > 0,
  );
  assert(archivedGatewaySnapshot, '指定导出缺少较早的网关快照');
}
const useMorAntBudget = args[0] === '--mor-ant-budget';
const useFlowScaledBudget = args[0] === '--flow-scaled-budget';
const useLimitedArrivalBudget = args[0] === '--limited-arrival-budget';
const useOrbitalEndpointBudget = args[0] === '--orbital-endpoint-budget';
const useOrbitalMinimumBudget = args[0] === '--orbital-minimum-budget';
const useOrbitalArrivalBudget = args[0] === '--orbital-arrival-budget' || useOrbitalEndpointBudget;
const useScaledBudget = useFlowScaledBudget || useLimitedArrivalBudget || useOrbitalArrivalBudget;
const files = useMorAntBudget || useScaledBudget || useOrbitalMinimumBudget ? args.slice(1) : args;
const model = files === args ? 'shared-budget' : args[0].slice(2);
assert(files.length, '缺少网关原始试飞导出');
const results = [];
for (const { request, blueprint, response, flightInputs, gameTimeMs, requestedAt } of files.flatMap(
  file => [...readFlightObservations(file)],
)) {
  if (response?.status !== 'OK') {
    continue;
  }
  assert.equal(request.missionId, response.missionId);
  assert(
    request.preferences.useGateways &&
      request.origin.includes('|STA,') &&
      request.destination.includes('|STA,'),
  );
  const [origin, destination] = flightInputs.orbit.endpoints;
  const shipVolume = blueprint.performance.totalVolume;
  const selectRoute = input =>
    selectFlightRoute(
      input,
      origin.systemId,
      destination.systemId,
      request.preferences,
      shipVolume,
    );
  let route = selectRoute(flightInputs);
  const useArchivedSnapshot =
    (!route || route.some(leg => !leg.gate)) && archivedGatewaySnapshot !== undefined;
  if (useArchivedSnapshot) {
    assert(archivedGatewaySnapshot.requestedAt < requestedAt, '网关快照必须早于本次试飞');
    const { gateways, gatewayConnections } = archivedGatewaySnapshot.flightInputs;
    route = selectRoute({ ...flightInputs, gateways, gatewayConnections });
  }
  assert(route?.length > 0 && route.every(leg => leg.gate), '试飞前寻路未选出纯网关路径');
  const path = route.map(leg => leg.gate);
  const flight = stationGatewayFlight(flightInputs, path, blueprint, request, gameTimeMs);
  const { expectedHops, bridgeCount, fixedFuel, gatewayEnd, flow, estimate: replay } = flight;
  const jumps = response.segments.filter(x => x.type === 'JUMP_GATEWAY');
  assert.deepEqual(
    jumps.map(x => ({
      gate: gateway(x.origin),
      destination: gateway(x.destination),
      jumpMillis: milliseconds(x),
    })),
    expectedHops,
  );
  assert(!response.segments.some(x => x.type === 'JUMP'));
  assert.equal(response.ftlFuelConsumption, 0);
  const phases = response.segments.filter(x => x.type === 'LOCK' || x.type === 'DECAY');
  assert.equal(phases.length, 2 * path.length);
  for (const phase of phases) {
    assert.equal(milliseconds(phase), 600_000);
    assert.equal(phase.stlFuelConsumption, 5);
  }
  const bridges = response.segments.filter(x => x.type === 'TRANSIT' && x.transferEllipse === null);
  assert.equal(bridges.length, bridgeCount);
  for (const bridge of bridges) {
    assert.equal(system(bridge.origin), system(bridge.destination));
    assert.equal(milliseconds(bridge), 10_000);
    assert.equal(bridge.stlFuelConsumption, 15);
  }
  const longTransfers = response.segments.filter(
    x => x.type === 'TRANSIT' && x.transferEllipse !== null,
  );
  assert.equal(longTransfers.length, 2, '此模型需首末各一段长转移');
  const longFuel = Math.floor((request.stlFuel * request.fuelUsageFactor) / 2);
  const actual = {
    seconds: response.eta.millis / 1000,
    stlFuel: response.stlFuelConsumption,
    ftlFuel: response.ftlFuelConsumption,
  };
  const frozen = replay(longFuel, longFuel);
  // These budgets were inferred from both MOR → ANT batches. Verify on a new route before use.
  const variableFuel = (request.stlFuel - fixedFuel - 21) * request.fuelUsageFactor;
  const refinedTotalFuel = Math.floor(21 + variableFuel);
  const refinedFirstFuel = Math.floor(7.25 + variableFuel / 2);
  const refined = replay(refinedFirstFuel, refinedTotalFuel - refinedFirstFuel);
  const refinedScore = scoreFlight(refined, actual);
  // The shared coefficients are provisional and calibrated on standard STL station routes.
  const baseFuel = ((request.stlFuel - fixedFuel - 15) * request.fuelUsageFactor) / 2;
  const sharedBudget = replay(Math.floor(6.5 + baseFuel), Math.floor(6 + baseFuel));
  const sharedScore = scoreFlight(sharedBudget, actual);
  const flowScale = flow / 0.015;
  let arrivalScale = flowScale;
  if (useLimitedArrivalBudget) {
    arrivalScale = Math.min(1, flowScale);
  }
  if (useOrbitalArrivalBudget) {
    const ratio = gatewayEnd.orbit.semiMajorAxis / destination.orbit.semiMajorAxis;
    assert(Number.isFinite(ratio) && ratio > 0, '缺少网关到站轨道半径');
    arrivalScale *= Math.sqrt(ratio);
  }
  const flowScaledBudget = useScaledBudget
    ? useOrbitalEndpointBudget
      ? replay(...orbitalEndpointFuel(flight, origin, destination, baseFuel))
      : replay(Math.floor(baseFuel + 6.5 * flowScale), Math.floor(baseFuel + 6 * arrivalScale))
    : undefined;
  const observedTransfers = longTransfers.map(x => ({
    seconds: milliseconds(x) / 1000,
    fuel: x.stlFuelConsumption,
    km: x.stlDistance,
  }));
  const geometryOnly = replay(observedTransfers[0].fuel, observedTransfers[1].fuel);
  const orbitalMinimumBudget = useOrbitalMinimumBudget
    ? replay(
        ...orbitalMinimumEndpointFuel(flight, flightInputs.orbit, destination, request, gameTimeMs),
      )
    : undefined;
  const acceptedEstimate =
    orbitalMinimumBudget ?? flowScaledBudget ?? (useMorAntBudget ? refined : sharedBudget);
  const acceptedFirst = acceptedEstimate.transfers[0];
  const acceptedLast = acceptedEstimate.transfers[1];
  const segmentScores = scoreFlightSegments(
    [
      flightPhase('TRANSIT', acceptedFirst.seconds, acceptedFirst.fuel),
      ...expectedHops.flatMap(x => [
        flightPhase('TRANSIT', 10, 15),
        flightPhase('LOCK', 600, 5),
        flightPhase('JUMP_GATEWAY', x.jumpMillis / 1000),
        flightPhase('DECAY', 600, 5),
      ]),
      flightPhase('TRANSIT', 10, 15),
      flightPhase('TRANSIT', acceptedLast.seconds, acceptedLast.fuel),
    ],
    response.segments,
  );
  results.push({
    ...flightSample(request, blueprint),
    model,
    ...(useArchivedSnapshot ? { usedArchivedGatewaySnapshot: true } : {}),
    score: scoreFlight(acceptedEstimate, actual),
    route: [origin.systemId, ...path.map(x => x.b.systemId)],
    expectedHops,
    bridgeCount,
    tier: request.fuelUsageFactor,
    departureFuel: request.stlFuel,
    predictedMillis: Math.round(frozen.seconds * 1000),
    actualMillis: response.eta.millis,
    predictedStlFuel: frozen.stlFuel,
    actualStlFuel: response.stlFuelConsumption,
    actualFtlFuel: response.ftlFuelConsumption,
    frozenScore: scoreFlight(frozen, actual),
    refined: { ...refined, score: refinedScore },
    sharedBudget: { ...sharedBudget, score: sharedScore },
    flowScaledBudget,
    orbitalMinimumBudget,
    observedTransfers,
    geometryOnly: {
      transfers: geometryOnly.transfers,
      timeErrorSeconds: geometryOnly.seconds - actual.seconds,
    },
    fees: phases.filter(x => x.type === 'LOCK').map(x => x.cost),
    segmentScores,
  });
}
assert(results.length > 0, '缺少有效网关试飞');
console.log(JSON.stringify(results, null, 2));
