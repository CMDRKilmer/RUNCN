import assert from 'node:assert/strict';
import {
  predictSameSystemStlFlight,
  resolveStlTransferTime,
  stlAcceleration,
  stlLandingDistanceKm,
  stlMinimumTransferFuel,
  stlMissionLandingFlight,
  stlSurfaceFlight,
  stlTakeoffDistanceRatio,
} from '../../src/core/flight/stl.ts';
import { ellipseBetween } from '../../src/core/flight/transfer-ellipse.ts';
import {
  gameOrbitalSpeedKmS,
  predictWithGameModel,
} from '../../src/infrastructure/fio/orbit-position.ts';

export function position(endpoint, timeMs, orbitInputs) {
  const totalMassKg = endpoint.parentMassKg + (endpoint.orbit.mass ?? 0);
  return predictWithGameModel(
    endpoint.orbit,
    totalMassKg,
    timeMs,
    orbitInputs.motionFactor,
    orbitInputs.simulationIntervalS,
  );
}

export function transferTime(orbitInputs, start, fuel, a, flow) {
  const [from, to] = orbitInputs.endpoints;
  return transferTimeFrom(
    position(from, start, orbitInputs),
    to,
    orbitInputs,
    start,
    fuel,
    a,
    flow,
  );
}

export function transferTimeFrom(origin, to, orbitInputs, start, fuel, a, flow) {
  const lengthAt = seconds =>
    ellipseBetween(origin, position(to, start + seconds * 1000, orbitInputs)).length;
  return resolveStlTransferTime(lengthAt, start, fuel, a, flow);
}

export function sameSystemFlightPerformance(request, blueprint) {
  const engine = blueprint.selections.find(x => x.type === 'STL_ENGINE' && x.amount > 0);
  const flow = engine?.modifiers.find(x => x.type === 'STL_USAGE')?.value;
  const acceleration = stlAcceleration(blueprint.performance, request);
  assert(flow > 0 && acceleration > 0);
  return { flow, acceleration };
}

export function sameSystemSurfacePhase(kind, env, request, acceleration, flow, seededLanding) {
  if (kind === 'LANDING' && seededLanding) {
    return stlMissionLandingFlight(
      env.radiusKm,
      env.pressure,
      request.missionId,
      acceleration,
      flow,
    );
  }
  const distance =
    kind === 'TAKE_OFF'
      ? env.radiusKm * stlTakeoffDistanceRatio(env.pressure)
      : stlLandingDistanceKm(0.15 * env.radiusKm, env.pressure);
  return stlSurfaceFlight(distance, acceleration, flow);
}

export function predictSameSystemRoute(
  request,
  input,
  gameTimeMs,
  { acceleration, flow },
  modelSurface,
  useOrbitalSpeedBudget,
) {
  const { orbit, environment } = input;
  const [from, to] = orbit.endpoints;
  assert(from.orbit && to.orbit && from.systemId === to.systemId);
  assert(typeof request.landing === 'boolean' && environment?.length === 2);
  const surface = (kind, index, enabled) => {
    if (!enabled) {
      return undefined;
    }
    const env = environment[index].env;
    assert(Number.isFinite(env?.pressure) && env.pressure >= 0 && env.radiusKm > 0);
    return modelSurface(kind, env);
  };
  const takeoff = surface('TAKE_OFF', 0, request.origin.includes('|PLA,'));
  const landing = surface('LANDING', 1, request.landing && request.destination.includes('|PLA,'));
  const minimumFuel = useOrbitalSpeedBudget
    ? stlMinimumTransferFuel(
        gameOrbitalSpeedKmS(
          to.orbit,
          to.parentMassKg + (to.orbit.mass ?? 0),
          gameTimeMs,
          orbit.motionFactor,
          orbit.simulationIntervalS,
        ),
        acceleration,
        flow,
      )
    : (4 * flow) / 0.015;
  const flight = predictSameSystemStlFlight(
    {
      departureTimeMs: gameTimeMs,
      departureFuel: request.stlFuel,
      tier: request.fuelUsageFactor,
      minimumTransferFuel: minimumFuel,
      takeoff: takeoff ?? { seconds: 0, fuel: 0 },
      landing: landing ?? { seconds: 0, fuel: 0 },
    },
    (start, fuel) => transferTime(orbit, start, fuel, acceleration, flow),
  );
  return { ...flight, takeoff, landing };
}
