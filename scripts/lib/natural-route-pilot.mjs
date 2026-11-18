import assert from 'node:assert/strict';
import {
  flightConditionMultiplier,
  stlAcceleration,
  stlMinimumTransferFuel,
  stlMissionLandingFlight,
  stlSaturationFuel,
  stlSurfaceFlight,
  stlTransferSeconds,
} from '../../src/core/flight/stl.ts';
import { fitLinear, readFlightObservations } from './flight-observations.mjs';
import { flightPhase } from './flight-acceptance.mjs';
import { selectFlightRoute } from './flight-path-pilot.mjs';
import {
  naturalChargeSeconds,
  naturalJumpFuel,
  naturalJumpSpeed,
} from '../../src/core/flight/ftl.ts';
import { ellipseBetween } from '../../src/core/flight/transfer-ellipse.ts';
import {
  gameCircularOrbitSpeedKmS,
  gameOrbitalSpeedKmS,
} from '../../src/infrastructure/fio/orbit-position.ts';
import { position, transferTimeFrom } from './stl-geometry-pilot.mjs';

export const surfacePressure = (kind, pressure) =>
  kind === 'LANDING' ? Math.log1p(Math.sqrt(pressure)) : Math.log(pressure);

export function fitNaturalSurfaceCurves(files) {
  const kinds = ['TAKE_OFF', 'LANDING'];
  const surface = Object.fromEntries(kinds.map(kind => [kind, new Map()]));
  for (const file of files) {
    for (const row of readFlightObservations(file)) {
      if (row.response?.status !== 'OK') {
        continue;
      }
      for (const [i, kind] of kinds.entries()) {
        const endpoint = row.flightInputs?.environment?.[i];
        const distance = row.response.segments.find(x => x.type === kind)?.stlDistance;
        const env = endpoint?.env;
        if (
          !(distance > 0 && Number.isFinite(env?.pressure) && env.radiusKm > 0) ||
          env.pressure < 0 ||
          (kind === 'TAKE_OFF' && env.pressure === 0)
        ) {
          continue;
        }
        const sample = surface[kind].get(endpoint.naturalId) ?? { env: endpoint.env, sum: 0, n: 0 };
        sample.sum += distance;
        sample.n++;
        surface[kind].set(endpoint.naturalId, sample);
      }
    }
  }
  return Object.fromEntries(
    kinds.map(kind => {
      const points = [...surface[kind].values()];
      assert(points.length >= 2, '起降环境训练不足');
      return [
        kind,
        fitLinear(
          points,
          x => surfacePressure(kind, x.env.pressure),
          x => Math.log(x.sum / x.n / x.env.radiusKm),
        ),
      ];
    }),
  );
}

export function naturalSurfaceFlight(kind, env, surfaceCurves, acceleration, flow, missionId) {
  assert(Number.isFinite(env?.pressure) && env.pressure >= 0 && env.radiusKm > 0);
  if (kind === 'LANDING' && surfaceCurves.seededLanding) {
    return stlMissionLandingFlight(env.radiusKm, env.pressure, missionId, acceleration, flow);
  }
  const { intercept, slope, distanceRatio } = surfaceCurves[kind];
  const ratio =
    distanceRatio?.(env.pressure) ??
    Math.exp(intercept + slope * surfacePressure(kind, env.pressure));
  assert(Number.isFinite(ratio) && ratio > 0, '起降环境超出压力曲线适用范围');
  const distance = env.radiusKm * ratio;
  return stlSurfaceFlight(distance, acceleration, flow);
}

export function direction(from, to) {
  const x = to.x - from.x;
  const y = to.y - from.y;
  const z = to.z - from.z;
  const length = Math.hypot(x, y, z);
  assert(length > 0);
  return { x: x / length, y: y / length, z: z / length, length };
}

const jumpOffset = (point, dir, sign, stationEndpoint) =>
  Object.fromEntries(
    ['x', 'y', 'z'].map(axis => [
      axis,
      point[axis] + sign * (stationEndpoint ? 22_439_680.5 : 74_798_935) * dir[axis],
    ]),
  );

export function departureTransfer(
  origin,
  orbit,
  start,
  dir,
  fuel,
  a,
  flow,
  stationEndpoint = false,
) {
  const point = position(origin, start, orbit);
  const km = ellipseBetween(point, jumpOffset(point, dir, 1, stationEndpoint)).length;
  const burnFuel = Math.min(fuel, stlSaturationFuel(km, a, flow));
  return { km, seconds: stlTransferSeconds(km, burnFuel, a, flow), fuel: burnFuel };
}

export function approachTransfer(
  destination,
  orbit,
  start,
  dir,
  fuel,
  a,
  flow,
  stationEndpoint = false,
) {
  const point = jumpOffset(position(destination, start, orbit), dir, -1, stationEndpoint);
  const { length: km, seconds } = transferTimeFrom(point, destination, orbit, start, fuel, a, flow);
  return { km, seconds };
}

export function orbitalNaturalBudget(
  startingFuel,
  surfaceFuel,
  tier,
  flow,
  destination,
  departureReserve,
  approachReserve = departureReserve,
) {
  const base = ((startingFuel - surfaceFuel) * tier) / 2;
  const orbitalSpeedKmS =
    Math.sqrt((6.67384e-11 * destination.parentMassKg) / destination.orbit.semiMajorAxis) / 1000;
  const blend = ((1 - tier) * flow) / 0.015;
  return {
    departureFuel: Math.round(base + departureReserve * blend),
    approachFuel: Math.round(base + approachReserve * blend + 0.2 * orbitalSpeedKmS * blend),
  };
}

export function createNaturalOrbitalBudget({
  halfUnitReserve,
  orbitApproachWithoutReserve,
  orbitalSpeedReserve,
  departureMinimumReserve,
  stationApproachReserve,
}) {
  return (
    startingFuel,
    surfaceFuel,
    tier,
    flow,
    destination,
    arrivesInOrbit,
    { acceleration, orbit, gameTimeMs, arrivesAtStation },
  ) => {
    const reserve = halfUnitReserve ? 0.5 : 0;
    const budget = orbitalNaturalBudget(
      startingFuel,
      surfaceFuel,
      tier,
      flow,
      destination,
      reserve,
      orbitApproachWithoutReserve && arrivesInOrbit ? 0 : reserve,
    );
    const elements = destination.orbit;
    const mass = destination.parentMassKg + (elements.mass ?? 0);
    const { motionFactor, simulationIntervalS } = orbit;
    const base = ((startingFuel - surfaceFuel) * tier) / 2;
    if (orbitalSpeedReserve) {
      const speed = gameCircularOrbitSpeedKmS(elements, mass, motionFactor, simulationIntervalS);
      const minimum = stlMinimumTransferFuel(speed, acceleration, flow);
      budget.approachFuel = Math.floor(base + (1 - tier) * minimum + 1e-10);
    }
    if (departureMinimumReserve) {
      const speed = gameOrbitalSpeedKmS(
        elements,
        mass,
        gameTimeMs,
        motionFactor,
        simulationIntervalS,
      );
      const minimum = stlMinimumTransferFuel(speed, acceleration, flow);
      const available = startingFuel - surfaceFuel - minimum + 2;
      budget.departureFuel = Math.floor((available * tier) / 2 + 1 + 1e-10);
      if (stationApproachReserve && arrivesAtStation) {
        budget.approachFuel = Math.ceil(base + minimum * (1 - 0.75 * tier)) - 1;
      }
    }
    return budget;
  };
}

export function predictNaturalRoute(q, blueprint, input, gameTimeMs, surfaceCurves, fuelBudget) {
  assert(typeof q.landing === 'boolean');
  const [originSystem, originAddress] = q.origin.split('|');
  const [destinationSystem, destinationAddress] = q.destination.split('|');
  const originKind = originAddress?.split(',')[0];
  const destinationKind = destinationAddress?.split(',')[0];
  assert(['PLA', 'STA'].includes(originKind) && ['PLA', 'STA'].includes(destinationKind));
  const takesOff = originKind === 'PLA';
  const lands = destinationKind === 'PLA' && q.landing;
  const p = blueprint.performance;
  const engine = blueprint.selections.find(x => x.type === 'STL_ENGINE' && x.amount > 0);
  const reactor = blueprint.selections.find(x => x.type === 'FTL_REACTOR' && x.amount > 0);
  const flow = engine?.modifiers.find(x => x.type === 'STL_USAGE')?.value;
  const power = reactor?.modifiers.find(x => x.type === 'FTL_POWER')?.value;
  assert(flow > 0 && power > 0);
  const a = stlAcceleration(p, q);
  const up = takesOff
    ? naturalSurfaceFlight('TAKE_OFF', input.environment[0].env, surfaceCurves, a, flow)
    : { seconds: 0, fuel: 0 };
  const down = lands
    ? naturalSurfaceFlight('LANDING', input.environment[1].env, surfaceCurves, a, flow, q.missionId)
    : { seconds: 0, fuel: 0 };
  const [origin, destination] = input.orbit.endpoints;
  const budget = fuelBudget(
    q.stlFuel,
    up.fuel + down.fuel,
    q.fuelUsageFactor,
    flow,
    destination,
    destinationKind === 'PLA' && !q.landing,
    {
      acceleration: a,
      orbit: input.orbit,
      gameTimeMs,
      arrivesAtStation: destinationKind === 'STA',
    },
  );
  assert(budget.departureFuel > 0 && budget.approachFuel > 0);
  const { approachFuel } = budget;

  const legs = selectFlightRoute(
    input,
    origin.systemId,
    destination.systemId,
    q.preferences,
    p.totalVolume,
  );
  assert(legs?.length > 0 && legs.every(leg => !leg.gate), '试飞前寻路未选出纯自然路径');
  const stars = new Map(input.stars.map(x => [x.naturalId, x]));
  assert.equal(stars.get(origin.systemId)?.systemId, originSystem);
  assert.equal(stars.get(destination.systemId)?.systemId, destinationSystem);
  const path = [originSystem, ...legs.map(leg => stars.get(leg.to).systemId)];
  const edges = legs.map(leg =>
    direction(stars.get(leg.from).position, stars.get(leg.to).position),
  );
  const speed =
    naturalJumpSpeed(p.ftlMaxSpeed, p.minReactorUsage, q.reactorUsageFactor) *
    flightConditionMultiplier(q.condition);
  const jumps = edges.map(x => ({
    seconds: Math.floor(x.length / 12 / speed),
    fuel: naturalJumpFuel(x.length / 12, power, q.reactorUsageFactor),
  }));
  const chargePerJump = naturalChargeSeconds(
    p.emitterChargeTime,
    p.maxOverchargeTime,
    q.reactorUsageFactor,
  );
  const charge = (jumps.length - 1) * chargePerJump;
  const ftlSeconds = jumps.reduce((sum, x) => sum + x.seconds, charge);
  const start = gameTimeMs + up.seconds * 1000;
  const departure = departureTransfer(
    origin,
    input.orbit,
    start,
    edges[0],
    budget.departureFuel,
    a,
    flow,
    originKind === 'STA',
  );
  const departureFuel = departure.fuel;
  const approach = approachTransfer(
    destination,
    input.orbit,
    start + (departure.seconds + ftlSeconds) * 1000,
    edges.at(-1),
    approachFuel,
    a,
    flow,
    destinationKind === 'STA',
  );
  return {
    path,
    takeoff: up,
    landing: down,
    departureKm: departure.km,
    approachKm: approach.km,
    departureFuel,
    approachFuel,
    segments: [
      ...(takesOff ? [flightPhase('TAKE_OFF', up.seconds, up.fuel)] : []),
      flightPhase('DEPARTURE', departure.seconds, departureFuel, jumps[0].fuel),
      flightPhase('JUMP', jumps[0].seconds),
      ...jumps
        .slice(1)
        .flatMap(x => [
          flightPhase('CHARGE', chargePerJump, 0, x.fuel),
          flightPhase('JUMP', x.seconds),
        ]),
      flightPhase('APPROACH', approach.seconds, approachFuel),
      ...(lands ? [flightPhase('LANDING', down.seconds, down.fuel)] : []),
    ],
    seconds: up.seconds + departure.seconds + ftlSeconds + approach.seconds + down.seconds,
    stlFuel: up.fuel + departureFuel + approachFuel + down.fuel,
    ftlFuel: jumps.reduce((sum, x) => sum + x.fuel, 0),
  };
}
