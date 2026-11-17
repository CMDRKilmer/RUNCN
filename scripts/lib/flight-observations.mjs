import { readFileSync } from 'node:fs';

export function* readFlightObservations(path) {
  const data = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  if (data.schema === 'rprun.flight-observations.v1') {
    const blueprints = new Map(data.blueprints.map(blueprint => [blueprint.id, blueprint]));
    for (const row of data.observations) {
      yield { ...row, blueprint: blueprints.get(row.request?.blueprintId) };
    }
    return;
  }
  for (const scan of data.variants ?? [data]) {
    if (!Array.isArray(scan.observations)) {
      throw new Error('导出缺少原始试飞记录');
    }
    for (const row of scan.observations) {
      yield { ...row, blueprint: scan.blueprintConfig, flightInputs: data.flightInputs };
    }
  }
}

export function fitLinear(points, xOf, yOf) {
  const mean = values => values.reduce((sum, x) => sum + x, 0) / values.length;
  const meanX = mean(points.map(xOf));
  const meanY = mean(points.map(yOf));
  const variance = points.reduce((sum, x) => sum + (xOf(x) - meanX) ** 2, 0);
  const covariance = points.reduce((sum, x) => sum + (xOf(x) - meanX) * (yOf(x) - meanY), 0);
  const slope = covariance / variance;
  return { intercept: meanY - slope * meanX, slope };
}
