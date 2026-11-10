import type { IndustryPlan } from './industry-model';

type Line = IndustryPlan['lines'][number];

export function roundIndustryOrders(lines: Line[], slots: number) {
  if (lines.length === 0) {
    return [];
  }
  const totalBatches = lines.reduce((sum, x) => sum + x.batches, 0);
  const proportions = lines.map(x => x.batches / totalBatches);
  let bestError = Infinity;
  let best: number[] = [];
  for (let total = lines.length; total <= slots; total++) {
    const counts = lines.map(() => 1);
    const targets = proportions.map(x => x * total);
    for (let filled = lines.length; filled < total; filled++) {
      const next = counts.reduce(
        (index, count, i) => (targets[i] - count > targets[index] - counts[index] ? i : index),
        0,
      );
      counts[next]++;
    }
    const error = counts.reduce((sum, count, i) => sum + (count / total - proportions[i]) ** 2, 0);
    if (error < bestError - Number.EPSILON) {
      best = counts;
      bestError = error;
      if (error <= Number.EPSILON) {
        break;
      }
    }
  }
  return best;
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

export function runIndustryQueue(
  lines: Line[],
  counts: number[],
  buildings: number,
  preserveCounts = false,
): Line[] {
  if (counts.every(count => count === 0)) {
    return [];
  }
  const divisor = preserveCounts ? 1 : counts.reduce(greatestCommonDivisor, 0);
  const totalDays = lines.reduce(
    (sum, line, index) => sum + counts[index] / line.batchesPerBuilding,
    0,
  );
  return lines.flatMap((line, index) => {
    const count = counts[index];
    return count > 0
      ? [{ ...line, orders: count / divisor, batches: (count * buildings) / totalDays }]
      : [];
  });
}

export function getIndustryQueues(
  plan: IndustryPlan,
  availableLines: Line[],
  manualOrders: ReadonlyMap<string, ReadonlyMap<string, number>>,
) {
  const layout = plan.layout ?? plan.overflow?.layout;
  const automaticOrders = new Map(
    plan.layout === undefined ? [] : plan.lines.map(x => [x.value, x.orders]),
  );
  return (
    layout?.production.map(({ ticker, count }) => {
      const lines = availableLines.filter(line => line.building.Ticker === ticker);
      const override = manualOrders.get(ticker);
      const manual =
        override !== undefined &&
        lines.length === override.size &&
        lines.every(line => override.has(line.value));
      const orders = manual ? override : automaticOrders;
      const recipes = lines.map(line => ({ line, orders: orders.get(line.value) ?? 0 }));
      const totalOrders = recipes.reduce((sum, recipe) => sum + recipe.orders, 0);
      return { ticker, count, recipes, totalOrders, manual };
    }) ?? []
  );
}
