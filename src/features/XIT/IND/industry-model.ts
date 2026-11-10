import type { BurnValues } from '@src/core/burn';
import type { FioBuilding, FioRecipe } from '@src/features/XIT/PLAN/fio-buildings';
import {
  HABITATION_FALLBACK,
  getHousingCapacity,
  planHousing,
  tierToLevel,
  wfTiers,
  type WfTier,
} from '@src/features/XIT/PLAN/plan-housing';
import type { PlannedBuilding } from '@src/features/XIT/PLAN/tile-state';
import type { PlanetProductionFee } from '@src/features/XIT/PLAN/plan-planet';
import type { WorkforceNeed } from '@src/features/XIT/PLAN/workforce-needs';
import { getIndustryEfficiency, type IndustryBonuses } from './industry-efficiency';
import { roundIndustryOrders, runIndustryQueue } from './industry-queue';
import type { IndustryWarehouses } from './industry-storage';

const DAY_MS = 86_400_000;
const MIN_DAILY_AMOUNT = 0.005;
const BUILDING_ROUNDING_TOLERANCE = 1e-8;
export const BASE_AREAS = [500, 750, 1000] as const;
export const DEFAULT_QUEUE_SLOTS = 5;

interface BaseBurn {
  siteId: string;
  name: string;
  burn: BurnValues;
  hasStorage: boolean;
}

interface BaseBalance {
  siteId: string;
  name: string;
  demand: number;
  output: number;
  inventory?: number;
  deficit: number;
}

interface MaterialBalance {
  ticker: string;
  input: number;
  demand: number;
  output: number;
  deficit: number;
  bases: BaseBalance[];
}

export function summarizeIndustry(bases: BaseBurn[]) {
  const balances = new Map<string, MaterialBalance>();
  for (const base of bases) {
    for (const [ticker, rate] of Object.entries(base.burn)) {
      const demand = rate.input + rate.workforce;
      const balance = balances.get(ticker) ?? {
        ticker,
        input: 0,
        demand: 0,
        output: 0,
        deficit: 0,
        bases: [],
      };
      balance.input += rate.input;
      balance.demand += demand;
      balance.output += rate.output;
      balance.deficit = Math.max(0, balance.demand - balance.output);
      balance.bases.push({
        siteId: base.siteId,
        name: base.name,
        demand,
        output: rate.output,
        inventory: base.hasStorage ? rate.inventory : undefined,
        deficit: Math.max(0, demand - rate.output),
      });
      balances.set(ticker, balance);
    }
  }
  return balances;
}

export function getIndustryCandidates(balances: Map<string, MaterialBalance>) {
  return [...balances.values()].filter(x => x.input > 0 && x.deficit >= MIN_DAILY_AMOUNT);
}

export interface RecipeChoice {
  value: string;
  building: FioBuilding;
  recipe: FioRecipe;
  fertility: number;
}

export interface IndustryTarget {
  ticker: string;
  dailyTarget: number;
  choice: RecipeChoice;
}

type IndustryLine = RecipeChoice & {
  batches: number;
  orders: number;
  batchesPerBuilding: number;
  efficiency: ReturnType<typeof getIndustryEfficiency>;
};
type Workforce = Record<WfTier, number>;
type BuildingCount = Pick<PlannedBuilding, 'ticker' | 'count'>;
type ProductionBuilding = { building: FioBuilding; count: number };
interface BaseOptions {
  core: FioBuilding;
  housing: Parameters<typeof planHousing>[1];
  warehouses: IndustryWarehouses;
}
interface IndustryScenario {
  permits: number;
  maxArea: number;
  lines: IndustryLine[];
}
interface IndustryLayout {
  area: number;
  permits: number;
  buildings: BuildingCount[];
  production: BuildingCount[];
}
export interface IndustryPlan {
  lines: IndustryLine[];
  workforce: Workforce;
  layout?: IndustryLayout;
  overflow?: { layout: IndustryLayout; reason: 'area' | 'capacity' | 'queue'; queueSlots: number };
}

export function getRecipeNetOutput(recipe: FioRecipe, ticker: string) {
  const amount = (items: FioRecipe['Outputs']) =>
    items.reduce((sum, x) => sum + (x.CommodityTicker === ticker ? x.Amount : 0), 0);
  return amount(recipe.Outputs) - amount(recipe.Inputs);
}

export function planIndustryBase(
  targets: IndustryTarget[],
  catalog: FioBuilding[],
  nativeOptions: Map<string, PrunApi.BuildOption>,
  bonuses: Omit<IndustryBonuses, 'experts'>,
  expertCounts: ReadonlyMap<string, number>,
  maxPermits: number = BASE_AREAS.length,
  warehouses: IndustryWarehouses = { area: 0, buildings: [] },
  buildingCounts: Readonly<Partial<Record<string, number>>> = {},
  queueSlots = DEFAULT_QUEUE_SLOTS,
  getHousingCost?: (ticker: string) => number | undefined,
): IndustryPlan | undefined {
  if (!Number.isSafeInteger(queueSlots) || queueSlots < 1) {
    return undefined;
  }
  const recipes = new Map<string, { choice: RecipeChoice; batches: number }>();
  for (const { ticker, dailyTarget, choice } of targets) {
    const output = getRecipeNetOutput(choice.recipe, ticker);
    const count = buildingCounts[choice.building.Ticker];
    if (
      !Number.isFinite(output) ||
      output <= 0 ||
      !Number.isFinite(choice.recipe.DurationMs) ||
      choice.recipe.DurationMs <= 0 ||
      !Number.isFinite(dailyTarget) ||
      dailyTarget <= 0 ||
      (count !== undefined && (!Number.isSafeInteger(count) || count < 0))
    ) {
      return undefined;
    }
    const previous = recipes.get(choice.value);
    // One run supplies every selected output of the same recipe.
    const batches = Math.max(previous?.batches ?? 0, dailyTarget / output);
    if (!Number.isFinite(batches) || batches <= 0) {
      return undefined;
    }
    recipes.set(choice.value, { choice, batches });
  }
  const core = catalog.find(x => x.Ticker === 'CM');
  if (recipes.size === 0 || core === undefined) {
    return undefined;
  }
  const housingOptions = catalog.flatMap(x => {
    const native = nativeOptions.get(x.Ticker);
    if (native?.type !== 'HABITATION' && HABITATION_FALLBACK[x.Ticker] === undefined) {
      return [];
    }
    const caps = Object.fromEntries(
      wfTiers.map(t => [t, getHousingCapacity(x.Ticker, t, native?.workforceCapacities)]),
    ) as Record<WfTier, number>;
    return [{ ticker: x.Ticker, area: x.AreaCost, caps, cost: getHousingCost?.(x.Ticker) }];
  });
  const base = { core, housing: housingOptions, warehouses };
  const scenarios = BASE_AREAS.slice(0, maxPermits).map((maxArea, index) => {
    const permits = index + 1;
    const lines = [...recipes.values()].map(({ choice, batches }) => {
      const { building, fertility, recipe } = choice;
      const experts = expertCounts.get(building.Expertise ?? '') ?? 0;
      const efficiency = getIndustryEfficiency(
        building,
        fertility,
        { ...bonuses, experts },
        permits,
      );
      const batchesPerBuilding = (DAY_MS * efficiency.total) / recipe.DurationMs;
      return {
        ...choice,
        batches,
        orders: 0,
        batchesPerBuilding,
        efficiency,
      };
    });
    return { lines, permits, maxArea };
  });
  const recipesPerBuilding = new Map<string, number>();
  for (const { choice } of recipes.values()) {
    const ticker = choice.building.Ticker;
    recipesPerBuilding.set(ticker, (recipesPerBuilding.get(ticker) ?? 0) + 1);
  }
  const fitsQueue = [...recipesPerBuilding.values()].every(x => x <= queueSlots);
  for (const scenario of scenarios) {
    const required = getRequestedProduction(scenario.lines);
    const production = required.map(x => ({
      ...x,
      count: buildingCounts[x.building.Ticker] ?? x.count,
    }));
    if (fitsQueue && production.every((x, index) => x.count >= required[index].count)) {
      const plan = layoutIndustryBase(scenario, base, production);
      if (plan.layout !== undefined) {
        const lines = production.flatMap(({ building, count }) => {
          const recipes = plan.lines.filter(x => x.building.Ticker === building.Ticker);
          return runIndustryQueue(recipes, roundIndustryOrders(recipes, queueSlots), count);
        });
        return { ...plan, lines };
      }
    }
  }

  const largest = scenarios.at(-1);
  if (largest === undefined) {
    return undefined;
  }
  const required = getRequestedProduction(largest.lines);
  const requested = required.map(x => ({
    ...x,
    count: buildingCounts[x.building.Ticker] ?? x.count,
  }));
  const requestedPlan = layoutIndustryBase(largest, base, requested);
  const reason = requestedPlan.layout === undefined ? 'area' : fitsQueue ? 'capacity' : 'queue';
  const fixed =
    reason === 'area' ? fitProduction(largest, base, required, buildingCounts) : requested;
  if (fixed === undefined) {
    return requestedPlan;
  }
  for (const scenario of scenarios) {
    const { layout, ...plan } = layoutIndustryBase(scenario, base, fixed);
    if (layout !== undefined) {
      return { ...plan, overflow: { layout, reason, queueSlots } };
    }
  }
  return requestedPlan;
}

function getIndustryWorkforce(lines: ProductionBuilding[]) {
  return Object.fromEntries(
    wfTiers.map(t => [t, lines.reduce((total, x) => total + x.building[t] * x.count, 0)]),
  ) as Workforce;
}

function getProductionLoads(lines: IndustryLine[]) {
  const productionBuildings = new Map<string, { building: FioBuilding; utilization: number }>();
  for (const line of lines) {
    const ticker = line.building.Ticker;
    const group = productionBuildings.get(ticker) ?? {
      building: line.building,
      utilization: 0,
    };
    group.utilization += line.batches / line.batchesPerBuilding;
    productionBuildings.set(ticker, group);
  }
  return productionBuildings;
}

function getRequestedProduction(lines: IndustryLine[]): ProductionBuilding[] {
  return [...getProductionLoads(lines).values()].map(({ building, utilization }) => ({
    building,
    count: Math.max(1, Math.ceil(utilization - BUILDING_ROUNDING_TOLERANCE)),
  }));
}

function fitProduction(
  scenario: IndustryScenario,
  base: BaseOptions,
  required: ProductionBuilding[],
  buildingCounts: Readonly<Partial<Record<string, number>>>,
) {
  const fixed = required.map(x => ({ ...x, count: buildingCounts[x.building.Ticker] ?? 0 }));
  if (layoutIndustryBase(scenario, base, fixed).layout === undefined) {
    return undefined;
  }
  const pending = fixed.flatMap((x, index) =>
    buildingCounts[x.building.Ticker] === undefined
      ? [{ building: x, limit: required[index].count }]
      : [],
  );
  while (pending.length > 0) {
    // Reserve geometry before pricing orders. Fill the least-covered building type first.
    pending.sort((a, b) => a.building.count / a.limit - b.building.count / b.limit);
    const { building, limit } = pending[0];
    building.count++;
    if (layoutIndustryBase(scenario, base, fixed).layout === undefined) {
      building.count--;
      pending.shift();
    } else if (building.count === limit) {
      pending.shift();
    }
  }
  return fixed;
}

function layoutIndustryBase(
  { lines, permits, maxArea }: IndustryScenario,
  { core, housing: options, warehouses }: BaseOptions,
  configured: ProductionBuilding[],
): IndustryPlan {
  const groups = configured.filter(x => x.count > 0);
  const workforce = getIndustryWorkforce(groups);
  const result = { lines, workforce };
  const productionArea = groups.reduce(
    (area, x) => area + x.count * x.building.AreaCost,
    core.AreaCost + warehouses.area,
  );
  if (productionArea > maxArea) {
    return result;
  }
  const housing = planHousing(workforce, options, maxArea - productionArea);
  if (housing === undefined) {
    return result;
  }
  const production = groups.map(({ building, count }) => ({ ticker: building.Ticker, count }));
  const buildings = [
    { ticker: 'CM', count: 1 },
    ...warehouses.buildings,
    ...production,
    ...housing,
  ];
  const area =
    productionArea +
    housing.reduce(
      (sum, x) => sum + x.count * (options.find(option => option.ticker === x.ticker)?.area ?? 0),
      0,
    );
  return { ...result, layout: { area, permits, buildings, production } };
}

interface IndustryBatch {
  recipe: FioRecipe;
  batches: number;
}

export function getIndustryProductionFees(
  lines: (IndustryBatch & { building: FioBuilding })[],
  rules: PlanetProductionFee[] | undefined,
) {
  const total = new Map<string, number>();
  for (const { building, recipe, batches } of lines) {
    const fees = getDailyProductionFees(building, recipe.DurationMs, batches, rules);
    if (fees === undefined) {
      return undefined;
    }
    for (const [currency, amount] of fees) {
      total.set(currency, (total.get(currency) ?? 0) + amount);
    }
  }
  return total;
}

export function getDailyProductionFees(
  building: FioBuilding,
  durationMs: number,
  dailyBatches: number,
  rules: PlanetProductionFee[] | undefined,
) {
  const fees = new Map<string, number>();
  const workers = wfTiers.reduce((total, tier) => total + building[tier], 0);
  if (building.Expertise === null || workers === 0 || rules?.length === 0) {
    return fees;
  }
  if (rules === undefined) {
    return undefined;
  }

  const standardDays = (durationMs * dailyBatches) / DAY_MS;
  for (const tier of wfTiers) {
    if (building[tier] === 0) {
      continue;
    }
    const rule = rules.find(
      x => x.Category === building.Expertise && x.WorkforceLevel === tierToLevel[tier],
    );
    if (rule === undefined || !Number.isFinite(rule.FeeAmount) || rule.FeeAmount < 0) {
      return undefined;
    }
    if (rule.FeeAmount === 0) {
      continue;
    }
    if (!rule.FeeCurrency) {
      return undefined;
    }
    const fee = (building[tier] / workers) * rule.FeeAmount * standardDays;
    fees.set(rule.FeeCurrency, (fees.get(rule.FeeCurrency) ?? 0) + fee);
  }
  return fees;
}

export function getNewBaseFlows(
  lines: IndustryBatch[],
  workforce: Record<WfTier, number>,
  needs: WorkforceNeed[],
) {
  const flows = new Map<string, number>();
  function add(ticker: string, amount: number) {
    if (ticker && amount !== 0) {
      flows.set(ticker, (flows.get(ticker) ?? 0) + amount);
    }
  }

  for (const { recipe, batches } of lines) {
    for (const item of recipe.Inputs) {
      add(item.CommodityTicker, item.Amount * batches);
    }
    for (const item of recipe.Outputs) {
      add(item.CommodityTicker, -item.Amount * batches);
    }
  }
  const workforceInputs = new Map<string, number>();
  for (const tier of wfTiers) {
    for (const item of needs.find(x => x.WorkforceType === tierToLevel[tier])?.Needs ?? []) {
      const amount = (item.Amount * workforce[tier]) / 100;
      workforceInputs.set(
        item.MaterialTicker,
        (workforceInputs.get(item.MaterialTicker) ?? 0) + amount,
      );
    }
  }
  for (const [ticker, amount] of workforceInputs) {
    add(ticker, Math.ceil(amount - 1e-8));
  }
  return flows;
}

export function getPurchaseChanges(
  balances: Map<string, MaterialBalance>,
  newFlows: Map<string, number>,
) {
  return [...newFlows].map(([ticker, flow]) => {
    const balance = balances.get(ticker);
    const net = (balance?.demand ?? 0) - (balance?.output ?? 0);
    const before = Math.max(0, net);
    const newNet = net + flow;
    const after = Math.max(0, newNet);
    return { ticker, before, after, change: after - before, surplus: Math.max(0, -newNet) };
  });
}

export function priceMaterials(
  quantities: Iterable<[string, number]>,
  getPrice: (ticker: string, amount: number) => number | undefined,
) {
  const missing: string[] = [];
  let total = 0;
  for (const [ticker, amount] of quantities) {
    if (Math.abs(amount) < 1e-8) {
      continue;
    }
    const price = getPrice(ticker, amount);
    if (price === undefined) {
      missing.push(ticker);
    } else {
      total += price * amount;
    }
  }
  return { value: missing.length === 0 ? total : undefined, missing };
}
