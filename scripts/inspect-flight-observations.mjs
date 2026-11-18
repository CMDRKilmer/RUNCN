// Usage: node scripts/inspect-flight-observations.mjs <export.json> [...]
// Exit 1 when no usable server plans are present. This checks data coverage, not model accuracy.
import { readFlightObservations } from './lib/flight-observations.mjs';

function hasCompletePlan({ blueprint, request, response, error }) {
  return (
    error === undefined &&
    typeof blueprint?.id === 'string' &&
    blueprint.id === request?.blueprintId &&
    typeof request?.missionId === 'string' &&
    request.missionId === response?.missionId &&
    [
      request.fuelUsageFactor,
      request.reactorUsageFactor,
      request.payload,
      request.condition,
      request.stlFuel,
      request.ftlFuel,
    ].every(Number.isFinite) &&
    Array.isArray(response.segments) &&
    response.segments.length > 0 &&
    ['stlFuelConsumption', 'ftlFuelConsumption'].every(
      key =>
        (Number.isFinite(response[key]) && response[key] >= 0) ||
        (response[key] === null &&
          response.segments.every(segment => segment[key] === null || segment[key] === 0)),
    ) &&
    response.segments.every(
      segment =>
        typeof segment.type === 'string' &&
        Number.isFinite(segment.departure?.timestamp) &&
        Number.isFinite(segment.arrival?.timestamp) &&
        segment.arrival.timestamp >= segment.departure.timestamp &&
        [
          segment.stlDistance,
          segment.ftlDistance,
          segment.stlFuelConsumption,
          segment.ftlFuelConsumption,
        ].every(x => x === null || (Number.isFinite(x) && x >= 0)),
    )
  );
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node scripts/inspect-flight-observations.mjs <export.json> [...]');
  process.exit(1);
}

const status = new Map();
const segments = new Map();
const engineSegments = new Map();
const engineRoutes = new Map();
const routes = new Set();
const blueprints = new Set();
const batches = new Set();
const missionIds = new Set();
const preflightCoverage = {
  endpointOrbits: 0,
  planetEnvironment: 0,
  starGraph: 0,
  gatewaySnapshot: 0,
};
const boundaryStatus = {
  zeroDepartureStl: new Map(),
  zeroDepartureFtl: new Map(),
  fullPayloadWeight: new Map(),
};
let usablePlans = 0;
let duplicates = 0;
let missingReactor = 0;
for (const path of files) {
  for (const row of readFlightObservations(path)) {
    const mission = row.request?.missionId;
    if (missionIds.has(mission)) {
      duplicates++;
      continue;
    }
    if (typeof mission === 'string') {
      missionIds.add(mission);
    }
    if (!Number.isFinite(row.request?.reactorUsageFactor)) {
      missingReactor++;
    }
    let outcome = row.response?.status ?? 'NO_RESPONSE';
    if (outcome === 'OK' && !hasCompletePlan(row)) {
      outcome = 'INCOMPLETE';
    }
    increment(status, outcome);
    if (row.request?.stlFuel === 0) {
      increment(boundaryStatus.zeroDepartureStl, outcome);
    }
    if (row.request?.ftlFuel === 0) {
      increment(boundaryStatus.zeroDepartureFtl, outcome);
    }
    const capacity = row.blueprint?.performance?.storeCapacityWeight;
    if (capacity > 0 && row.request?.payload === capacity) {
      increment(boundaryStatus.fullPayloadWeight, outcome);
    }
    if (outcome !== 'OK') {
      continue;
    }
    usablePlans++;
    const inputs = row.flightInputs;
    if (
      inputs?.orbit?.endpoints?.length === 2 &&
      inputs.orbit.endpoints.every(x => x.orbit !== undefined && x.parentMassKg > 0)
    ) {
      preflightCoverage.endpointOrbits++;
    }
    if (inputs?.environment?.some(x => x.env !== undefined)) {
      preflightCoverage.planetEnvironment++;
    }
    if (inputs?.stars?.length > 0) {
      preflightCoverage.starGraph++;
    }
    if (inputs?.gatewayConnections?.length > 0) {
      preflightCoverage.gatewaySnapshot++;
    }
    const engine = row.blueprint.selections?.find(x => x.type === 'STL_ENGINE')?.option;
    if (engine !== undefined) {
      const natural = row.response.segments.some(segment => segment.type === 'JUMP');
      const gateway = row.response.segments.some(segment => segment.type === 'JUMP_GATEWAY');
      const family = gateway
        ? natural
          ? 'mixed'
          : 'gateway'
        : natural
          ? 'natural'
          : 'same-system';
      const counts = engineRoutes.get(engine) ?? new Map();
      increment(counts, family);
      engineRoutes.set(engine, counts);
    }
    routes.add(
      JSON.stringify([row.request.origin, row.request.destination, row.request.preferences]),
    );
    blueprints.add(row.blueprint.id);
    batches.add(row.batchId ?? path);
    for (const segment of row.response.segments) {
      increment(segments, segment.type);
      if (engine !== undefined) {
        increment(engineSegments, `${engine} / ${segment.type}`);
      }
    }
  }
}

console.log(
  JSON.stringify(
    {
      status: Object.fromEntries(status),
      missingReactor,
      duplicates,
      usablePlans,
      preflightCoverage,
      boundaryStatus: Object.fromEntries(
        Object.entries(boundaryStatus).map(([name, counts]) => [name, Object.fromEntries(counts)]),
      ),
      routes: routes.size,
      blueprints: blueprints.size,
      batches: batches.size,
      segments: Object.fromEntries(segments),
      engineRoutes: Object.fromEntries(
        [...engineRoutes].map(([engine, counts]) => [engine, Object.fromEntries(counts)]),
      ),
      engineSegments: Object.fromEntries(engineSegments),
    },
    null,
    2,
  ),
);
if (usablePlans === 0) {
  process.exitCode = 1;
}
