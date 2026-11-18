// Usage: node scripts/verify-stl-transfer-budget.mjs <exports> [...]
// Reports compatible minimum-fuel intervals from observed same-system transfers.
// Exit nonzero if no eligible samples are supplied. This diagnostic uses observed surface fuel.
import assert from 'node:assert/strict';
import { readFlightObservations } from './lib/flight-observations.mjs';

const batches = [];
const seen = new Set();
for (const file of process.argv.slice(2)) {
  const groups = new Map();
  for (const { request, response, blueprint, flightInputs } of readFlightObservations(file)) {
    const [from, to] = flightInputs?.orbit?.endpoints ?? [];
    if (response?.status !== 'OK' || !from || !to || from.systemId !== to.systemId) {
      continue;
    }
    const transit = response.segments.find(x => x.type === 'TRANSIT' && x.transferEllipse);
    if (!transit || seen.has(request.missionId)) {
      continue;
    }
    seen.add(request.missionId);

    const stlFuel = type => response.segments.find(x => x.type === type)?.stlFuelConsumption ?? 0;
    const { stlFuel: departureStl, ftlFuel: departureFtl, condition, payload } = request;
    const configuration = {
      from: from.naturalId,
      to: to.naturalId,
      blueprint: blueprint.naturalId,
      departureStl,
      departureFtl,
      condition,
      payload,
      landing: request.landing,
    };
    const key = JSON.stringify(configuration);
    const group = groups.get(key) ?? {
      file,
      ...configuration,
      targetSemiMajorAxisKm: to.orbit.semiMajorAxis / 1000,
      samples: [],
    };
    const takeoff = stlFuel('TAKE_OFF');
    const landing = stlFuel('LANDING');
    const tier = request.fuelUsageFactor;
    const debit = transit.stlFuelConsumption;
    assert(Number.isFinite(tier) && tier >= 0 && tier <= 1, '无效的 STL 档位');
    const residual = debit - tier * (departureStl - takeoff - landing);
    const reserveInterval =
      tier === 1 ? null : [residual / (1 - tier), (residual + 1) / (1 - tier)];
    group.samples.push({
      missionId: request.missionId,
      tier,
      takeoff,
      landing,
      transit: debit,
      reserveInterval,
      fullTierResidual: tier === 1 ? residual : undefined,
    });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const ranges = group.samples.flatMap(x => (x.reserveInterval ? [x.reserveInterval] : []));
    const bounds = ranges.length
      ? [Math.max(...ranges.map(x => x[0])), Math.min(...ranges.map(x => x[1]))]
      : null;
    const interval = bounds?.map(x => Number(x.toFixed(12))) ?? null;
    batches.push({
      ...group,
      interval,
      compatible: interval === null ? null : interval[0] < interval[1],
    });
  }
}
assert(batches.length > 0, '缺少有效的系内转移样本');
console.log(JSON.stringify(batches, null, 2));
