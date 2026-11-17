// Usage: node --experimental-strip-types scripts/verify-mixed-route-pilot.mjs [--takeoff-pressure] [--orbital-approach-budget] <surface training exports> --replay <mixed exports>
// Scores mixed routes built from alternating blocks of natural and gateway jumps.
import assert from 'node:assert/strict';
import {
  flightConditionMultiplier,
  stlAcceleration,
  stlMinimumTransferFuel,
  stlTakeoffDistanceRatio,
} from '../src/core/flight/stl.ts';
import { gameOrbitalSpeedKmS } from '../src/infrastructure/fio/orbit-position.ts';
import {
  flightPhase as phase,
  flightSample,
  scoreFlight,
  scoreFlightSegments,
} from './lib/flight-acceptance.mjs';
import { readFlightObservations } from './lib/flight-observations.mjs';
import { selectFlightRoute } from './lib/flight-path-pilot.mjs';
import { gatewayJumpMillis, planetEndpoint } from './lib/gateway-pilot.mjs';
import { naturalChargeSeconds, naturalJumpFuel, naturalJumpSpeed } from '../src/core/flight/ftl.ts';
import {
  approachTransfer,
  departureTransfer,
  direction,
  fitNaturalSurfaceCurves,
  naturalSurfaceFlight,
} from './lib/natural-route-pilot.mjs';
import { transferTime } from './lib/stl-geometry-pilot.mjs';

function predictMixedRoute(
  q,
  blueprint,
  input,
  timeMs,
  surfaceCurves,
  useOrbitalApproach,
  useEndpointReserves,
) {
  assert(q.preferences.useGateways);
  const orbit = input.orbit;
  const [origin, destination] = orbit.endpoints;
  const legs = selectFlightRoute(
    input,
    origin.systemId,
    destination.systemId,
    q.preferences,
    blueprint.performance.totalVolume,
  );
  assert(legs?.length > 1);
  const blocks = [];
  for (const leg of legs) {
    const gateway = leg.gate !== undefined;
    if (blocks.at(-1)?.gateway !== gateway) {
      blocks.push({ gateway, legs: [] });
    }
    blocks.at(-1).legs.push(leg);
  }
  assert(blocks.length > 1, '预测路径必须包含自然及网关跃迁');
  const gatewayFirst = blocks[0].gateway;
  const gatewayLast = blocks.at(-1).gateway;
  assert(q.origin.includes(gatewayFirst ? '|STA,' : '|PLA,'));
  assert(
    gatewayLast
      ? q.destination.includes('|STA,')
      : q.destination.includes('|PLA,') && typeof q.landing === 'boolean',
  );
  const positions = new Map(input.stars.map(x => [x.naturalId, x.position]));
  const p = blueprint.performance;
  const engine = blueprint.selections.find(x => x.type === 'STL_ENGINE' && x.amount > 0);
  const reactor = blueprint.selections.find(x => x.type === 'FTL_REACTOR' && x.amount > 0);
  const flow = engine?.modifiers.find(x => x.type === 'STL_USAGE')?.value;
  const power = reactor?.modifiers.find(x => x.type === 'FTL_POWER')?.value;
  const a = stlAcceleration(p, q);
  assert(flow > 0 && power > 0 && a > 0);
  const takeoff = gatewayFirst
    ? undefined
    : naturalSurfaceFlight('TAKE_OFF', input.environment[0].env, surfaceCurves, a, flow);
  const landing =
    gatewayLast || !q.landing
      ? undefined
      : naturalSurfaceFlight(
          'LANDING',
          input.environment[1].env,
          surfaceCurves,
          a,
          flow,
          q.missionId,
        );
  const chargePerJump = naturalChargeSeconds(
    p.emitterChargeTime,
    p.maxOverchargeTime,
    q.reactorUsageFactor,
  );
  const speed =
    naturalJumpSpeed(p.ftlMaxSpeed, p.minReactorUsage, q.reactorUsageFactor) *
    flightConditionMultiplier(q.condition);
  let transferCount = Number(gatewayFirst) + Number(gatewayLast);
  let fixedFuel = 0;
  for (const block of blocks) {
    if (block.gateway) {
      const gates = block.legs.map(x => x.gate);
      assert(gates.slice(1).every((x, i) => x.a.planetId === gates[i].b.planetId));
      block.start = planetEndpoint(gates[0].a);
      block.end = planetEndpoint(gates.at(-1).b);
      block.phases = gates.flatMap(gate => [
        phase('TRANSIT', 10, 15),
        phase('LOCK', 600, 5),
        phase('JUMP_GATEWAY', gatewayJumpMillis(gate, positions) / 1000),
        phase('DECAY', 600, 5),
      ]);
      block.phases.push(phase('TRANSIT', 10, 15));
      fixedFuel += block.phases.reduce((sum, x) => sum + x.stlFuel, 0);
    } else {
      transferCount += 2;
    }
  }
  const surfaceFuel = (takeoff?.fuel ?? 0) + (landing?.fuel ?? 0);
  const base = ((q.stlFuel - surfaceFuel - fixedFuel - 15) * q.fuelUsageFactor) / transferCount;
  const orbitalSpeedKmS =
    Math.sqrt((6.67384e-11 * destination.parentMassKg) / destination.orbit.semiMajorAxis) / 1000;
  const approachReserve = useOrbitalApproach
    ? 4.5 + 0.1 * orbitalSpeedKmS * (1 - q.fuelUsageFactor)
    : 7;
  const departureFuel = Math.floor(base + 1.25);
  let approachFuel = Math.floor(base + approachReserve);
  let stationFuel = Math.floor(base + 6);
  if (useEndpointReserves && gatewayFirst && !gatewayLast) {
    const minimum = ({ orbit: elements, parentMassKg }) =>
      stlMinimumTransferFuel(
        gameOrbitalSpeedKmS(
          elements,
          parentMassKg + (elements.mass ?? 0),
          timeMs,
          orbit.motionFactor,
          orbit.simulationIntervalS,
        ),
        a,
        flow,
      );
    const gateMinimum = minimum(blocks[0].start);
    const targetMinimum = minimum(destination);
    const share = q.fuelUsageFactor / transferCount;
    const stationReserve = gateMinimum * (1 - share / 2);
    const targetReserve = stationReserve - (gateMinimum - targetMinimum) * (1 - share);
    stationFuel = Math.floor(base + stationReserve + 1e-10);
    approachFuel = Math.floor(base + targetReserve + 1e-10);
  }
  assert(departureFuel > 0 && approachFuel > 0 && stationFuel > 0);
  const segments = [];
  const transfers = [];
  const totals = { seconds: 0, stlFuel: 0, ftlFuel: 0 };
  const append = segment => {
    segments.push(segment);
    totals.seconds += segment.seconds;
    totals.stlFuel += segment.stlFuel;
    totals.ftlFuel += segment.ftlFuel;
  };
  const now = () => timeMs + totals.seconds * 1000;
  const recordTransfer = (type, transfer, fuel, ftlFuel = 0) => {
    transfers.push({ km: transfer.km ?? transfer.length, seconds: transfer.seconds, fuel });
    append(phase(type, transfer.seconds, fuel, ftlFuel));
  };
  const transferToStation = (from, to) => {
    const transfer = transferTime({ ...orbit, endpoints: [from, to] }, now(), stationFuel, a, flow);
    recordTransfer('TRANSIT', transfer, stationFuel);
  };

  if (takeoff) {
    append(phase('TAKE_OFF', takeoff.seconds, takeoff.fuel));
  }
  for (const [index, block] of blocks.entries()) {
    const first = index === 0;
    const last = index === blocks.length - 1;
    if (block.gateway) {
      if (first) {
        transferToStation(origin, block.start);
      }
      for (const segment of block.phases) {
        append(segment);
      }
      if (last) {
        transferToStation(block.end, destination);
      }
      continue;
    }
    const from = first ? origin : blocks[index - 1].end;
    const to = last ? destination : blocks[index + 1].start;
    const vectors = block.legs.map(x => direction(positions.get(x.from), positions.get(x.to)));
    const departure = departureTransfer(from, orbit, now(), vectors[0], departureFuel, a, flow);
    for (const [i, vector] of vectors.entries()) {
      const distance = vector.length / 12;
      const fuel = naturalJumpFuel(distance, power, q.reactorUsageFactor);
      if (i === 0) {
        recordTransfer('DEPARTURE', departure, departure.fuel, fuel);
      } else {
        append(phase('CHARGE', chargePerJump, 0, fuel));
      }
      append(phase('JUMP', Math.floor(distance / speed)));
    }
    const approach = approachTransfer(to, orbit, now(), vectors.at(-1), approachFuel, a, flow);
    recordTransfer('APPROACH', approach, approachFuel);
  }
  if (landing) {
    append(phase('LANDING', landing.seconds, landing.fuel));
  }
  return {
    ...totals,
    route: legs.map(x => [x.from, x.to, x.gate?.a.naturalId ?? null]),
    surface: takeoff && landing ? { takeoff, landing } : (takeoff ?? landing),
    segments,
    transfers,
  };
}

const options = [
  '--takeoff-pressure',
  '--orbital-approach-budget',
  '--seeded-landing-orbit',
  '--orbital-endpoint-reserves',
];
const inputs = process.argv.slice(2);
const useTakeoffPressure = inputs.includes('--takeoff-pressure');
const useOrbitalApproach = inputs.includes('--orbital-approach-budget');
const useSeededLanding = inputs.includes('--seeded-landing-orbit');
const useEndpointReserves = inputs.includes('--orbital-endpoint-reserves');
assert(!useEndpointReserves || useOrbitalApproach, '端点预留需与轨道进近预算一起使用');
const args = inputs.filter(x => !options.includes(x));
const split = args.indexOf('--replay');
assert(split > 0 && split < args.length - 1, '需要起降训练导出与混合航线导出');
const surfaceCurves = fitNaturalSurfaceCurves(args.slice(0, split));
surfaceCurves.seededLanding = useSeededLanding;
if (useTakeoffPressure) {
  surfaceCurves.TAKE_OFF.distanceRatio = stlTakeoffDistanceRatio;
}
const rows = [];
const entity = (address, type) => address.lines.find(x => x.type === type)?.entity?.naturalId;
for (const file of args.slice(split + 1)) {
  for (const { request, blueprint, response, flightInputs, gameTimeMs } of readFlightObservations(
    file,
  )) {
    if (response?.status !== 'OK') {
      continue;
    }
    assert.equal(response.missionId, request.missionId);
    const predicted = predictMixedRoute(
      request,
      blueprint,
      flightInputs,
      gameTimeMs,
      surfaceCurves,
      useOrbitalApproach,
      useEndpointReserves,
    );
    const segments = response.segments;
    const route = segments
      .filter(x => x.type === 'JUMP' || x.type === 'JUMP_GATEWAY')
      .map(x => [
        entity(x.origin, 'SYSTEM'),
        entity(x.destination, 'SYSTEM'),
        x.type === 'JUMP_GATEWAY' ? entity(x.origin, 'SATELLITE') : null,
      ]);
    assert.deepEqual(predicted.route, route);
    const actual = {
      seconds: response.eta.millis / 1000,
      stlFuel: response.stlFuelConsumption,
      ftlFuel: response.ftlFuelConsumption,
    };
    const observedTransfers = segments
      .filter(
        x => x.transferEllipse !== null && ['DEPARTURE', 'APPROACH', 'TRANSIT'].includes(x.type),
      )
      .map(x => ({
        km: x.stlDistance,
        seconds: (x.arrival.timestamp - x.departure.timestamp) / 1000,
        fuel: x.stlFuelConsumption,
      }));
    assert.equal(observedTransfers.length, predicted.transfers.length);
    const segmentScores = scoreFlightSegments(predicted.segments, segments);
    rows.push({
      ...flightSample(request, blueprint, true),
      model:
        (useTakeoffPressure ? 'mixed-takeoff-pressure' : 'mixed-original') +
        (useOrbitalApproach ? '-orbital-approach-budget' : '') +
        (useSeededLanding ? '-seeded-landing-orbit' : '') +
        '-condition-speed-departure-cap' +
        (useEndpointReserves ? '-orbital-endpoint-reserves' : ''),
      tier: request.fuelUsageFactor,
      predicted,
      actual,
      observedTransfers,
      segmentScores,
      score: scoreFlight(predicted, actual),
    });
  }
}
assert(rows.length > 0, '缺少有效混合航线试飞');
console.log(JSON.stringify({ rows }, null, 2));
