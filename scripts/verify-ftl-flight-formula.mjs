// Usage: node --experimental-strip-types scripts/verify-ftl-flight-formula.mjs <raw-export.json> [...]
// Checks time and fuel for single natural jumps and reports the rejected rounding candidate.
import assert from 'node:assert/strict';
import { readFlightObservations } from './lib/flight-observations.mjs';
import { minSpeedPcPerSecond, naturalJumpFuel, naturalJumpSpeed } from '../src/core/flight/ftl.ts';
const files = process.argv.slice(2);
assert(files.length > 0, '缺少原始试飞导出');
const missionIds = new Set();
const results = [];

for (const file of files) {
  for (const { blueprint, request, response, flightInputs } of readFlightObservations(file)) {
    if (response?.status !== 'OK' || missionIds.has(request.missionId)) {
      continue;
    }
    assert.equal(response.missionId, request.missionId);
    missionIds.add(request.missionId);
    assert.equal(blueprint.id, request.blueprintId);
    const jumpSegments = response.segments.filter(
      x => x.type === 'JUMP' || x.type === 'JUMP_GATEWAY',
    );
    assert(jumpSegments.length === 1 && jumpSegments[0].type === 'JUMP', '需要一条单次自然跃迁');
    const [jump] = jumpSegments;
    const [from, to] = [request.origin, request.destination].map(address =>
      flightInputs?.stars?.find(x => x.systemId === address.split('|')[0]),
    );
    assert(from?.position && to?.position, '缺少试飞前的恒星坐标');
    const a = from.position;
    const b = to.position;
    const distancePc = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / 12;
    assert(Number.isFinite(distancePc) && distancePc > 0, '无效的恒星距离');
    const { ftlMaxSpeed, minReactorUsage } = blueprint.performance;
    const r = request.reactorUsageFactor;
    assert(Number.isFinite(ftlMaxSpeed) && ftlMaxSpeed >= minSpeedPcPerSecond);
    assert(Number.isFinite(minReactorUsage) && minReactorUsage >= 0 && minReactorUsage < 1);
    assert(Number.isFinite(r) && r >= minReactorUsage && r <= 1);
    const speed = naturalJumpSpeed(ftlMaxSpeed, minReactorUsage, r);
    const predictedSeconds = Math.floor(distancePc / speed);
    const actualSeconds = (jump.arrival.timestamp - jump.departure.timestamp) / 1000;
    const power = blueprint.selections
      .filter(x => x.type === 'FTL_REACTOR' && x.amount > 0)
      .flatMap(x => x.modifiers)
      .find(x => x.type === 'FTL_POWER')?.value;
    assert(Number.isFinite(power) && power > 0, '蓝图缺少反应堆功率');
    const actualFuel = response.ftlFuelConsumption;
    assert(Number.isInteger(actualFuel) && actualFuel > 0, '缺少有效的 FTL 油耗');
    assert.equal(
      response.segments.reduce((sum, x) => sum + (x.ftlFuelConsumption ?? 0), 0),
      actualFuel,
      '分段 FTL 油耗与全程不一致',
    );
    const fuelBasis = distancePc * power * r;
    const fuelWithSingleFloor = naturalJumpFuel(distancePc, power, r);
    // 被否定的候选模型：燃料预算先按旧口径 0.003 四舍五入，再乘档位。真实速率是
    // ftl.ts 的 fuelPerPowerPc（0.003003），所以这里保留独立的候选常数、不引用生产实现。
    const fuelWithRoundedBudget = Math.floor(Math.round(0.003 * distancePc * power) * r);
    results.push({
      blueprint: blueprint.naturalId,
      route: [from.naturalId, to.naturalId],
      r,
      distancePc,
      distanceErrorPc: distancePc - jump.ftlDistance,
      predictedSeconds,
      actualSeconds,
      actualFuel,
      fuelWithSingleFloor,
      fuelWithRoundedBudget,
      fuelRateLowerInclusive: actualFuel / fuelBasis,
      fuelRateUpperExclusive: (actualFuel + 1) / fuelBasis,
    });
  }
}

assert(results.length > 0, '缺少有效的原始试飞样本');
const durationMatches = results.filter(x => x.predictedSeconds === x.actualSeconds).length;
const fuelMatchesSingleFloor = results.filter(x => x.fuelWithSingleFloor === x.actualFuel).length;
const fuelMatchesRoundedBudget = results.filter(
  x => x.fuelWithRoundedBudget === x.actualFuel,
).length;
console.log(
  JSON.stringify(
    {
      count: results.length,
      durationMatches,
      fuelMatchesSingleFloor,
      fuelMatchesRoundedBudget,
      maxDistanceErrorPc: Math.max(...results.map(x => Math.abs(x.distanceErrorPc))),
      maxTimeErrorSeconds: Math.max(
        ...results.map(x => Math.abs(x.predictedSeconds - x.actualSeconds)),
      ),
      compatibleSingleFloorRate: [
        Math.max(...results.map(x => x.fuelRateLowerInclusive)),
        Math.min(...results.map(x => x.fuelRateUpperExclusive)),
      ],
      results,
    },
    null,
    2,
  ),
);
if (durationMatches !== results.length || fuelMatchesSingleFloor !== results.length) {
  process.exitCode = 1;
}
