import assert from 'node:assert/strict';

export function flightSample(request, blueprint, includeFtl = false) {
  const engine = blueprint.selections.find(x => x.type === 'STL_ENGINE' && x.amount > 0);
  assert(engine?.optionMaterialName, '缺少 STL 引擎');
  const ftlParts = includeFtl
    ? blueprint.selections.filter(
        x => x.amount > 0 && (x.type === 'FTL_REACTOR' || x.type.startsWith('FTL_FIELD_EMITTER_')),
      )
    : [];
  const targetKind = request.destination.split('|')[1]?.split(',')[0];
  assert(
    targetKind === 'STA' || (targetKind === 'PLA' && typeof request.landing === 'boolean'),
    '缺少可评分的到达方式',
  );
  return {
    missionId: request.missionId,
    arrival: targetKind === 'STA' ? 'station' : request.landing ? 'surface' : 'orbit',
    configuration: [engine.optionMaterialName, ...ftlParts.map(x => x.optionMaterialName)].join(
      ' / ',
    ),
  };
}

export function scoreFlight(estimate, actual) {
  const checks = Object.fromEntries(
    Object.entries({ seconds: 5, stlFuel: 1, ftlFuel: 1 }).map(([key, minimum]) => {
      assert(Number.isFinite(estimate[key]) && estimate[key] >= 0, 'Invalid estimate: ' + key);
      assert(Number.isFinite(actual[key]) && actual[key] >= 0, 'Invalid observation: ' + key);
      const error = estimate[key] - actual[key];
      const tolerance = Math.max(0.05 * actual[key], minimum);
      return [key, { error, tolerance, passed: Math.abs(error) <= tolerance }];
    }),
  );
  return { passed: Object.values(checks).every(x => x.passed), checks };
}

export function flightPhase(type, seconds, stlFuel = 0, ftlFuel = 0) {
  return { type, seconds, stlFuel, ftlFuel };
}

export function scoreFlightSegments(estimated, observed) {
  assert.deepEqual(
    estimated.map(x => x.type),
    observed.map(x => x.type),
    '原生航段顺序与模型不一致',
  );
  return estimated.map((estimate, i) => {
    const segment = observed[i];
    const type =
      segment.type === 'TRANSIT'
        ? segment.transferEllipse === null
          ? 'SHORT_TRANSIT'
          : 'LONG_TRANSIT'
        : segment.type;
    return {
      type,
      ...scoreFlight(estimate, {
        seconds: (segment.arrival.timestamp - segment.departure.timestamp) / 1000,
        stlFuel: segment.stlFuelConsumption ?? 0,
        ftlFuel: segment.ftlFuelConsumption ?? 0,
      }),
    };
  });
}
