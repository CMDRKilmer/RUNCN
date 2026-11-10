import { solve, type Constraint } from 'yalps';
import type { PlanetProductionFee } from '@src/features/XIT/PLAN/plan-planet';
import type { WorkforceNeed } from '@src/features/XIT/PLAN/workforce-needs';
import {
  getDailyProductionFees,
  getNewBaseFlows,
  type getPurchaseChanges,
  type IndustryPlan,
} from './industry-model';
import { runIndustryQueue } from './industry-queue';

interface IndustryEconomics {
  balances: Parameters<typeof getPurchaseChanges>[0];
  needs: WorkforceNeed[];
  rules: PlanetProductionFee[] | undefined;
  currency: string | undefined;
  getPrice(ticker: string): number | undefined;
}

type OptimizationResult =
  | { status: 'optimized' | 'estimated'; plan: IndustryPlan }
  | { status: 'missing-cost' | 'incomplete' };

const EPSILON = 1e-8;

interface ProductionLine {
  ticker: string;
  count: number;
  recipes: IndustryPlan['lines'];
}

function buildModel(
  lines: ProductionLine[],
  workforce: IndustryPlan['workforce'],
  queueSlots: number,
  economics: IndustryEconomics,
) {
  const { balances, needs, rules, currency, getPrice } = economics;
  const constraints = new Map<string, Constraint>();
  const variables = new Map<string, Record<string, number>>();
  const binaries = new Set<string>();
  const orderVariables = new Map<string, { key: string; count: number }[]>();
  const workforceFlows = getNewBaseFlows([], workforce, needs);
  const maxIncrease = new Map<string, number>();

  for (const { ticker, count, recipes } of lines) {
    const singleRecipe = recipes.length === 1;
    const maxRate = Math.max(...recipes.map(x => x.batchesPerBuilding));
    const time = 'time:' + ticker;
    const slots = 'slots:' + ticker;
    const active = 'active:' + ticker;
    const frequency = 'frequency:' + ticker;
    const frequencyLimit = 'frequency-limit:' + ticker;
    const frequencyCoefficients: Record<string, number> = { [frequencyLimit]: 1 };
    if (!singleRecipe) {
      constraints.set(time, { equal: 0 });
      constraints.set(slots, { max: 0 });
      constraints.set(frequencyLimit, { max: 0 });
      variables.set(active, { [time]: -1, [slots]: -queueSlots, [frequencyLimit]: -1 });
      variables.set(frequency, frequencyCoefficients);
      binaries.add(active);
    }

    for (const recipe of recipes) {
      const fees = getDailyProductionFees(recipe.building, recipe.recipe.DurationMs, 1, rules);
      if (fees === undefined || [...fees.keys()].some(x => x !== currency)) {
        return undefined;
      }
      const capacity = count * recipe.batchesPerBuilding;
      const flows = getNewBaseFlows([{ recipe: recipe.recipe, batches: 1 }], workforce, []);
      const effects: [string, number][] = [
        ['cost', currency === undefined ? 0 : (fees.get(currency) ?? 0)],
      ];
      for (const [material, amount] of flows) {
        if (Math.abs(amount * capacity) >= EPSILON) {
          effects.push(['purchase:' + material, -amount]);
          maxIncrease.set(
            material,
            (maxIncrease.get(material) ?? 0) + Math.max(0, amount * capacity),
          );
        }
      }
      const orders: { key: string; count: number }[] = [];
      orderVariables.set(recipe.value, orders);
      if (singleRecipe) {
        variables.set(active, Object.fromEntries(effects.map(([key, x]) => [key, x * capacity])));
        binaries.add(active);
        orders.push({ key: active, count: 1 });
        continue;
      }

      // Encode integer order counts as bits. Each rate variable equals its bit times
      // the common normalized frequency, so all orders repeat at the same rate.
      for (let weight = 1; weight <= queueSlots; weight *= 2) {
        const bit = `order:${recipe.value}:${weight}`;
        const scaled = 'rate:' + bit;
        const atMostFrequency = 'upper-frequency:' + bit;
        const atMostBit = 'upper-bit:' + bit;
        const atLeastFrequencyIfSet = 'lower-frequency:' + bit;
        constraints.set(atMostFrequency, { max: 0 });
        constraints.set(atMostBit, { max: 0 });
        constraints.set(atLeastFrequencyIfSet, { max: 1 });
        frequencyCoefficients[atMostFrequency] = -1;
        frequencyCoefficients[atLeastFrequencyIfSet] = 1;
        variables.set(bit, { [slots]: weight, [atMostBit]: -1, [atLeastFrequencyIfSet]: 1 });
        const rate = weight * count * maxRate;
        variables.set(scaled, {
          ...Object.fromEntries(effects.map(([key, x]) => [key, x * rate])),
          [time]: (weight * maxRate) / recipe.batchesPerBuilding,
          [atMostFrequency]: 1,
          [atMostBit]: 1,
          [atLeastFrequencyIfSet]: -1,
        });
        binaries.add(bit);
        orders.push({ key: bit, count: weight });
      }
    }
  }

  for (const [ticker, maximum] of maxIncrease) {
    const balance = balances.get(ticker);
    const net = (balance?.demand ?? 0) - (balance?.output ?? 0) + (workforceFlows.get(ticker) ?? 0);
    const price = getPrice(ticker);
    if (price === undefined) {
      if (net > EPSILON || net + maximum > EPSILON) {
        return undefined;
      }
      continue;
    }
    const key = 'purchase:' + ticker;
    constraints.set(key, { min: net });
    variables.set(key, { cost: price, [key]: 1 });
  }

  return {
    model: { direction: 'minimize' as const, objective: 'cost', constraints, variables, binaries },
    orderVariables,
  };
}

export async function optimizeIndustryQueue(
  requested: IndustryPlan,
  economics: IndustryEconomics,
  signal: AbortSignal,
): Promise<OptimizationResult | undefined> {
  const overflow = requested.overflow;
  if (overflow === undefined) {
    return undefined;
  }
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  if (signal.aborted) {
    return undefined;
  }
  const { workforce } = requested;
  const { layout, queueSlots } = overflow;
  const production = layout.production.map(x => ({
    ...x,
    recipes: requested.lines.filter(line => line.building.Ticker === x.ticker),
  }));
  const prepared = buildModel(production, workforce, queueSlots, economics);
  if (prepared === undefined) {
    return { status: 'missing-cost' };
  }
  const solution = solve(prepared.model, { timeout: 250 });
  if (!Number.isFinite(solution.result)) {
    return { status: 'incomplete' };
  }
  const values = new Map(solution.variables);
  const lines: IndustryPlan['lines'] = [];
  for (const { recipes, count } of production) {
    const orders = recipes.map(recipe =>
      prepared.orderVariables
        .get(recipe.value)!
        .reduce((sum, x) => sum + Math.round(values.get(x.key) ?? 0) * x.count, 0),
    );
    if (orders.reduce((sum, x) => sum + x, 0) > queueSlots) {
      return { status: 'incomplete' };
    }
    lines.push(...runIndustryQueue(recipes, orders, count));
  }
  return {
    status: solution.status === 'optimal' ? 'optimized' : 'estimated',
    plan: { workforce, layout, lines },
  };
}
