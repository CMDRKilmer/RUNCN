import { describe, expect, it, vi } from 'vitest';

// Mock Vue reactive primitives used by store module side-effects.
vi.mock('vue', () => ({
  computed: vi.fn(fn => fn),
  ref: vi.fn(val => ({ value: val })),
  shallowReactive: vi.fn(obj => obj),
  shallowRef: vi.fn(val => ({ value: val })),
  triggerRef: vi.fn(),
  watch: vi.fn(),
}));

// Mock all store modules imported by burn.ts to prevent reactive chain.
vi.mock('@src/infrastructure/prun-api/data/production', () => ({
  productionStore: { all: { value: undefined }, getBySiteId: vi.fn() },
}));
vi.mock('@src/infrastructure/prun-api/data/workforces', () => ({
  workforcesStore: { all: { value: undefined }, getById: vi.fn() },
}));
vi.mock('@src/infrastructure/prun-api/data/storage', () => ({
  storagesStore: { all: { value: undefined }, getByAddressableId: vi.fn() },
}));
vi.mock('@src/infrastructure/prun-api/data/sites', () => ({
  sitesStore: { all: { value: undefined }, getById: vi.fn() },
}));
vi.mock('@src/infrastructure/prun-api/data/addresses', () => ({
  getEntityNameFromAddress: vi.fn(),
  getEntityNaturalIdFromAddress: vi.fn(),
}));

// Mock getRecurringOrders so we control which orders appear.
vi.mock('@src/core/orders', () => ({
  getRecurringOrders: vi.fn(),
}));

// Mock the api-messages module to prevent side-effect registration.
vi.mock('@src/infrastructure/prun-api/data/api-messages', () => ({
  onApiMessage: vi.fn(),
}));

// Mock request-hooks to prevent side-effect imports.
vi.mock('@src/infrastructure/prun-api/data/request-hooks', () => ({
  request: { production: vi.fn() },
}));

// Mock PrefixStore used by createEntityStore.
vi.mock('@src/utils/prefix-store', () => ({
  PrefixStore: class {
    clear() {}
    insert() {}
    setOne() {}
    findOne() {
      return undefined;
    }
    findAll() {
      return undefined;
    }
    remove() {}
  },
}));

import { calculatePlanetBurn } from './burn';
import { getRecurringOrders } from '@src/core/orders';

const mockGetRecurringOrders = vi.mocked(getRecurringOrders);

function makeMaterial(ticker: string) {
  return {
    name: ticker,
    id: ticker,
    ticker,
    category: 'cat',
    weight: 1,
    volume: 1,
    resource: false,
  };
}

function makeOrder(opts: {
  inputs?: { ticker: string; amount: number }[];
  outputs?: { ticker: string; amount: number }[];
  durationMs: number;
  recurring?: boolean;
}) {
  return {
    id: 'ord',
    productionLineId: 'line1',
    inputs: (opts.inputs ?? []).map(x => ({
      value: { currency: 'NCC', amount: 0 },
      material: makeMaterial(x.ticker),
      amount: x.amount,
    })),
    outputs: (opts.outputs ?? []).map(x => ({
      value: { currency: 'NCC', amount: 0 },
      material: makeMaterial(x.ticker),
      amount: x.amount,
    })),
    created: { timestamp: 0 },
    started: null,
    completion: null,
    duration: { millis: opts.durationMs },
    lastUpdated: null,
    completed: 0,
    halted: false,
    productionFee: { currency: 'NCC', amount: 0 },
    productionFeeCollector: { currency: { numericCode: 0, code: 'NCC', name: '', decimals: 0 } },
    recurring: opts.recurring ?? true,
    recipeId: 'recipe1',
  } as PrunApi.ProductionOrder;
}

function makeLine(orders: PrunApi.ProductionOrder[], capacity = 1) {
  return {
    id: 'line1',
    siteId: 'site1',
    address: [],
    type: 'production',
    capacity,
    slots: 1,
    efficiency: 1,
    condition: 1,
    workforces: [],
    orders,
    productionTemplates: [],
    efficiencyFactors: [],
  } as unknown as PrunApi.ProductionLine;
}

function makeWorkforce(
  needs: { ticker: string; unitsPerInterval: number; remainingAllocation?: number }[],
) {
  return {
    level: 'pioneer',
    population: 100,
    reserve: 0,
    capacity: 100,
    required: 100,
    satisfaction: 1,
    needs: needs.map(n => ({
      category: 'FOOD' as PrunApi.NeedCategory,
      essential: true,
      material: makeMaterial(n.ticker),
      satisfaction: 1,
      unitsPerInterval: n.unitsPerInterval,
      unitsPer100: n.unitsPerInterval,
      remainingAllocation: n.remainingAllocation,
    })),
  } as PrunApi.Workforce;
}

function makeStore(items: { ticker: string; amount: number }[]) {
  return {
    id: 'store1',
    addressableId: 'site1',
    name: null,
    weightLoad: 0,
    weightCapacity: 1000,
    volumeLoad: 0,
    volumeCapacity: 1000,
    items: items.map(x => ({
      quantity: {
        value: { currency: 'NCC', amount: 0 },
        material: makeMaterial(x.ticker),
        amount: x.amount,
      },
      id: `item-${x.ticker}`,
      type: 'INVENTORY' as const,
      weight: 0,
      volume: 0,
    })),
    fixed: false,
    tradeStore: false,
    rank: 0,
    locked: false,
    type: 'STORE' as PrunApi.StoreType,
  } as PrunApi.Store;
}

describe('calculatePlanetBurn', () => {
  it('returns empty object when no production or workforce', () => {
    const result = calculatePlanetBurn(undefined, undefined, undefined);
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('computes daily output from production orders', () => {
    const order = makeOrder({ outputs: [{ ticker: 'RAT', amount: 10 }], durationMs: 86400000 });
    mockGetRecurringOrders.mockReturnValue([order]);

    const result = calculatePlanetBurn([makeLine([order])], undefined, undefined);
    expect(result.RAT).toBeDefined();
    expect(result.RAT.output).toBe(10);
    expect(result.RAT.dailyAmount).toBe(10);
    expect(result.RAT.type).toBe('output');
  });

  it('computes daily input consumption', () => {
    const order = makeOrder({ inputs: [{ ticker: 'DW', amount: 5 }], durationMs: 86400000 });
    mockGetRecurringOrders.mockReturnValue([order]);

    const result = calculatePlanetBurn([makeLine([order])], undefined, undefined);
    expect(result.DW.input).toBe(5);
    expect(result.DW.dailyAmount).toBe(-5);
    expect(result.DW.type).toBe('input');
  });

  it('classifies material as workforce type when workforce is dominant consumer', () => {
    const order = makeOrder({ outputs: [{ ticker: 'RAT', amount: 10 }], durationMs: 86400000 });
    mockGetRecurringOrders.mockReturnValue([order]);
    const workforce = makeWorkforce([{ ticker: 'RAT', unitsPerInterval: 12 }]);

    const result = calculatePlanetBurn([makeLine([order])], [workforce], undefined);
    expect(result.RAT.dailyAmount).toBe(-2);
    expect(result.RAT.type).toBe('workforce');
  });

  it('skips workforce tiers with population <= 1', () => {
    const order = makeOrder({ outputs: [{ ticker: 'RAT', amount: 10 }], durationMs: 86400000 });
    mockGetRecurringOrders.mockReturnValue([order]);
    const tinyWorkforce = makeWorkforce([{ ticker: 'DW', unitsPerInterval: 5 }]);
    tinyWorkforce.population = 1;

    const result = calculatePlanetBurn([makeLine([order])], [tinyWorkforce], undefined);
    expect(result.DW).toBeUndefined();
  });

  it('skips workforce tiers with capacity === 0', () => {
    const order = makeOrder({ outputs: [{ ticker: 'RAT', amount: 10 }], durationMs: 86400000 });
    mockGetRecurringOrders.mockReturnValue([order]);
    const homeless = makeWorkforce([{ ticker: 'DW', unitsPerInterval: 5 }]);
    homeless.capacity = 0;

    const result = calculatePlanetBurn([makeLine([order])], [homeless], undefined);
    expect(result.DW).toBeUndefined();
  });

  describe('daysLeft with remainingAllocation (Bug fix regression)', () => {
    it('includes remainingAllocation in daysLeft calculation', () => {
      const order = makeOrder({ inputs: [{ ticker: 'DW', amount: 5 }], durationMs: 86400000 });
      mockGetRecurringOrders.mockReturnValue([order]);
      const wf = makeWorkforce([{ ticker: 'DW', unitsPerInterval: 2, remainingAllocation: 20 }]);
      const store = makeStore([{ ticker: 'DW', amount: 10 }]);

      const result = calculatePlanetBurn([makeLine([order])], [wf], [store]);
      // DW: output=0, workforce=2, input=5 → dailyAmount = 0-2-5 = -7
      // inventory=10, remainingAllocation=20 → inv=30
      // daysLeft = 30 / 7 ≈ 4.2857
      expect(result.DW.dailyAmount).toBe(-7);
      expect(result.DW.remainingAllocation).toBe(20);
      expect(result.DW.inventory).toBe(10);
      expect(result.DW.daysLeft).toBeCloseTo(30 / 7, 4);
    });

    it('daysLeft is Infinity when dailyAmount >= 0', () => {
      const order = makeOrder({ outputs: [{ ticker: 'RAT', amount: 10 }], durationMs: 86400000 });
      mockGetRecurringOrders.mockReturnValue([order]);

      const result = calculatePlanetBurn([makeLine([order])], undefined, undefined);
      expect(result.RAT.daysLeft).toBe(Number.POSITIVE_INFINITY);
    });

    it('daysLeft uses only inventory when no remainingAllocation', () => {
      const order = makeOrder({ inputs: [{ ticker: 'DW', amount: 5 }], durationMs: 86400000 });
      mockGetRecurringOrders.mockReturnValue([order]);
      const store = makeStore([{ ticker: 'DW', amount: 15 }]);

      const result = calculatePlanetBurn([makeLine([order])], undefined, [store]);
      // DW: input=5, dailyAmount=-5, inventory=15, remainingAllocation=0
      // daysLeft = (0+15) / 5 = 3
      expect(result.DW.daysLeft).toBe(3);
    });
  });

  it('scales production by line capacity', () => {
    const order = makeOrder({ outputs: [{ ticker: 'RAT', amount: 10 }], durationMs: 86400000 });
    mockGetRecurringOrders.mockReturnValue([order]);

    const result = calculatePlanetBurn([makeLine([order], 2)], undefined, undefined);
    expect(result.RAT.output).toBe(20);
  });

  it('ignores storage items not in burnValues', () => {
    const order = makeOrder({ outputs: [{ ticker: 'RAT', amount: 10 }], durationMs: 86400000 });
    mockGetRecurringOrders.mockReturnValue([order]);
    const store = makeStore([{ ticker: 'UNRELATED', amount: 999 }]);

    const result = calculatePlanetBurn([makeLine([order])], undefined, [store]);
    expect(result.UNRELATED).toBeUndefined();
  });
});
