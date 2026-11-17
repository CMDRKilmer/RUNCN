// Usage: node --experimental-strip-types scripts/verify-ftl-multijump.mjs <raw-export.json>
// Validates pure natural multi-jump plans with LEAST_JUMPS routing.
import assert from 'node:assert/strict';
import { readFlightObservations } from './lib/flight-observations.mjs';
import {
  fuelPerPowerPc,
  naturalChargeSeconds,
  naturalJumpFuel,
  naturalJumpSpeed,
} from '../src/core/flight/ftl.ts';

function shortestPath(stars, from, to) {
  const queue = [[from]];
  const seen = new Set([from]);
  for (const path of queue) {
    const last = path.at(-1);
    if (last === to) {
      return path;
    }
    for (const next of stars.get(last)?.connections ?? []) {
      if (stars.has(next) && !seen.has(next)) {
        seen.add(next);
        queue.push([...path, next]);
      }
    }
  }
}

const seconds = x => (x.arrival.timestamp - x.departure.timestamp) / 1000;
const system = x => x.lines.find(line => line.type === 'SYSTEM')?.entity.id;
const [file] = process.argv.slice(2);
assert(file, '缺少原始试飞导出');
const results = [];
for (const { blueprint, request, response, flightInputs } of readFlightObservations(file)) {
  if (response?.status !== 'OK') {
    continue;
  }
  assert.equal(response.missionId, request.missionId);
  assert.equal(blueprint.id, request.blueprintId);
  assert.deepEqual(request.preferences, { ftlPreference: 'LEAST_JUMPS', useGateways: false });
  const stars = new Map(flightInputs.stars.map(x => [x.systemId, x]));
  const path = shortestPath(stars, request.origin.split('|')[0], request.destination.split('|')[0]);
  assert(path?.length > 2, '试飞前星图缺少一条多跳自然跃迁路径');
  const { ftlMaxSpeed, minReactorUsage, emitterChargeTime, maxOverchargeTime } =
    blueprint.performance;
  const r = request.reactorUsageFactor;
  const speed = naturalJumpSpeed(ftlMaxSpeed, minReactorUsage, r);
  const reactor = blueprint.selections.find(x => x.type === 'FTL_REACTOR' && x.amount > 0);
  const power = reactor?.modifiers.find(x => x.type === 'FTL_POWER')?.value;
  assert(Number.isFinite(power) && power > 0 && Number.isFinite(speed) && speed > 0);

  assert(!response.segments.some(x => x.type === 'JUMP_GATEWAY'));
  const jumps = response.segments.filter(x => x.type === 'JUMP');
  const charges = response.segments.filter(x => x.type === 'CHARGE');
  const debits = response.segments.map(x => x.ftlFuelConsumption).filter(x => x > 0);
  assert.equal(jumps.length, path.length - 1);
  assert.equal(charges.length, jumps.length - 1);
  assert.equal(debits.length, jumps.length);
  assert.equal(
    debits.reduce((sum, fuel) => sum + fuel, 0),
    response.ftlFuelConsumption,
  );
  const distances = jumps.map((jump, i) => {
    assert.equal(system(jump.origin), path[i]);
    assert.equal(system(jump.destination), path[i + 1]);
    const a = stars.get(path[i]).position;
    const b = stars.get(path[i + 1]).position;
    const distance = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / 12;
    assert(Math.abs(jump.ftlDistance - distance) < 1e-12);
    assert.equal(seconds(jump), Math.floor(distance / speed));
    assert.equal(debits[i], naturalJumpFuel(distance, power, r));
    return distance;
  });
  const chargeSeconds = naturalChargeSeconds(emitterChargeTime, maxOverchargeTime, r);
  for (const [i, charge] of charges.entries()) {
    assert.equal(system(charge.origin), path[i + 1]);
    assert(Math.abs(seconds(charge) - chargeSeconds) < 1e-9);
  }
  assert(Math.abs(response.chargeTime.millis / 1000 - chargeSeconds * charges.length) < 1e-9);
  results.push({
    r,
    route: path.map(id => stars.get(id).naturalId),
    jumpSeconds: jumps.map(seconds),
    chargeSeconds,
    perJumpFuel: debits,
    actualFuel: response.ftlFuelConsumption,
    fuelRoundedAtEnd: Math.floor(fuelPerPowerPc * power * distances.reduce((a, b) => a + b, 0) * r),
    fuelRateInterval: [
      Math.max(...distances.map((distance, i) => debits[i] / (power * distance * r))),
      Math.min(...distances.map((distance, i) => (debits[i] + 1) / (power * distance * r))),
    ],
  });
}

assert(results.length > 0, '缺少有效的多跳试飞计划');
console.log(JSON.stringify(results, null, 2));
