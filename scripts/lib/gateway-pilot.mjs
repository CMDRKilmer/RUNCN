import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stationGatewayFuelBudget, stationGatewayTiming } from '../../src/core/flight/gateway.ts';
import { stlAcceleration, stlMinimumTransferFuel } from '../../src/core/flight/stl.ts';
import { gameOrbitalSpeedKmS } from '../../src/infrastructure/fio/orbit-position.ts';
import { transferTime } from './stl-geometry-pilot.mjs';

const readData = name =>
  JSON.parse(readFileSync(new URL('../../public/json/' + name, import.meta.url)));
const planetOrbits = new Map(readData('planets-orbit.json').map(x => [x.n.toUpperCase(), x]));
const starMasses = new Map(readData('star-masses.json').map(x => [x.n, x.m]));

const maximumUpgradedGatewayVolume = 6000;

export function gatewayEdges(input, shipVolume = 0) {
  const gates = new Map(input.gateways.filter(x => x.operational).map(x => [x.naturalId, x]));
  return input.gatewayConnections.flatMap(x => {
    const a = gates.get(x.fromGatewayId);
    const b = gates.get(x.toGatewayId);
    if (!a || !b) {
      return [];
    }
    return [
      { a, b },
      { a: b, b: a },
    ].filter(edge => shipVolume <= (edge.a.maxShipVolume ?? maximumUpgradedGatewayVolume));
  });
}

export function planetEndpoint(gate) {
  const planet = planetOrbits.get(gate.planetId?.toUpperCase());
  const parentMassKg = starMasses.get(gate.systemId);
  assert(planet && parentMassKg > 0, '缺少网关所在行星的公开轨道数据');
  return {
    parentMassKg,
    orbit: {
      semiMajorAxis: planet.a,
      eccentricity: planet.e,
      inclination: planet.i,
      rightAscension: planet.o,
      periapsis: planet.p,
      mass: planet.m,
    },
  };
}

export function gatewayJumpMillis(edge, positions) {
  const p = positions.get(edge.a.systemId);
  const q = positions.get(edge.b.systemId);
  return Math.floor((Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) / 12) * 1_200_000);
}

export function stationGatewayFlight(input, path, blueprint, request, gameTimeMs) {
  assert(path?.length > 0, '试飞前网关图没有站间路径');
  for (let i = 1; i < path.length; i++) {
    assert.equal(path[i - 1].b.planetId, path[i].a.planetId, '此模型需同一行星的网关间接驳');
  }
  const orbit = input.orbit;
  const [origin, destination] = orbit.endpoints;
  const gatewayStart = planetEndpoint(path[0].a);
  const gatewayEnd = planetEndpoint(path.at(-1).b);
  const engine = blueprint.selections.find(x => x.type === 'STL_ENGINE' && x.amount > 0);
  const flow = engine?.modifiers.find(x => x.type === 'STL_USAGE')?.value;
  const acceleration = stlAcceleration(blueprint.performance, request);
  assert(acceleration > 0 && flow > 0);
  const stars = new Map(input.stars.map(x => [x.naturalId, x.position]));
  const expectedHops = path.map(edge => ({
    gate: edge.a.naturalId,
    destination: edge.b.naturalId,
    jumpMillis: gatewayJumpMillis(edge, stars),
  }));
  const timing = stationGatewayTiming({
    departureTimeMs: gameTimeMs,
    jumpMillis: expectedHops.map(x => x.jumpMillis),
    departureTransfer: (atMs, fuel) =>
      transferTime({ ...orbit, endpoints: [origin, gatewayStart] }, atMs, fuel, acceleration, flow),
    arrivalTransfer: (atMs, fuel) =>
      transferTime(
        { ...orbit, endpoints: [gatewayEnd, destination] },
        atMs,
        fuel,
        acceleration,
        flow,
      ),
  });
  return {
    ...timing,
    expectedHops,
    gatewayStart,
    gatewayEnd,
    acceleration,
    flow,
  };
}

export function orbitalMinimumEndpointFuel(flight, orbit, destination, request, gameTimeMs) {
  const minimum = ({ orbit: elements, parentMassKg }) =>
    stlMinimumTransferFuel(
      gameOrbitalSpeedKmS(
        elements,
        parentMassKg + (elements.mass ?? 0),
        gameTimeMs,
        orbit.motionFactor,
        orbit.simulationIntervalS,
      ),
      flight.acceleration,
      flight.flow,
    );
  return stationGatewayFuelBudget(
    request.stlFuel,
    flight.fixedFuel,
    minimum(flight.gatewayStart),
    minimum(destination),
    request.fuelUsageFactor,
  );
}

export function orbitalEndpointFuel(flight, origin, destination, baseFuel) {
  const flowScale = flight.flow / 0.015;
  const arrivalRatio = flight.gatewayEnd.orbit.semiMajorAxis / destination.orbit.semiMajorAxis;
  const departureRatio =
    (1.5 * flight.gatewayStart.orbit.semiMajorAxis) / origin.orbit.semiMajorAxis;
  assert(arrivalRatio > 0 && departureRatio > 0 && Number.isFinite(arrivalRatio + departureRatio));
  return [
    Math.floor(baseFuel + 6.5 * (flowScale * Math.min(1, departureRatio))),
    Math.floor(baseFuel + 6 * (flowScale * Math.sqrt(arrivalRatio))),
  ];
}
