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

// Mock store modules imported by utils.ts → sortMaterials → materialCategoriesStore.
vi.mock('@src/infrastructure/prun-api/data/material-categories', () => ({
  materialCategoriesStore: { all: { value: undefined }, getById: vi.fn() },
}));

// Mock sortMaterials to bypass the store dependency.
vi.mock('@src/core/sort-materials', () => ({
  sortMaterials: vi.fn(mats => mats),
}));

// Mock materialsStore used by getSortedTickers.
vi.mock('@src/infrastructure/prun-api/data/materials', () => ({
  materialsStore: { all: { value: undefined }, getById: vi.fn(), getByTicker: vi.fn() },
}));

// Mock the api-messages module to prevent side-effect registration.
vi.mock('@src/infrastructure/prun-api/data/api-messages', () => ({
  onApiMessage: vi.fn(),
}));

// Mock createEntityStore dependencies.
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

import { countDays } from './utils';
import type { BurnValues } from '@src/core/burn';

describe('countDays', () => {
  it('returns default 1000 when burn is empty', () => {
    expect(countDays({})).toBe(1000);
  });

  it('returns default 1000 when all dailyAmounts are non-negative', () => {
    const burn: BurnValues = {
      RAT: {
        input: 0,
        output: 10,
        workforce: 0,
        dailyAmount: 10,
        remainingAllocation: 0,
        inventory: 0,
        daysLeft: Infinity,
        type: 'output',
      },
    };
    expect(countDays(burn)).toBe(1000);
  });

  it('returns minimum daysLeft among materials with negative dailyAmount', () => {
    const burn: BurnValues = {
      DW: {
        input: 5,
        output: 0,
        workforce: 0,
        dailyAmount: -5,
        remainingAllocation: 0,
        inventory: 10,
        daysLeft: 2,
        type: 'input',
      },
      RAT: {
        input: 10,
        output: 0,
        workforce: 0,
        dailyAmount: -10,
        remainingAllocation: 0,
        inventory: 15,
        daysLeft: 1.5,
        type: 'input',
      },
    };
    expect(countDays(burn)).toBe(1.5);
  });

  it('skips materials with NaN dailyAmount', () => {
    const burn: BurnValues = {
      DW: {
        input: 0,
        output: 0,
        workforce: 0,
        dailyAmount: NaN,
        remainingAllocation: 0,
        inventory: 0,
        daysLeft: 0,
        type: 'output',
      },
      RAT: {
        input: 5,
        output: 0,
        workforce: 0,
        dailyAmount: -5,
        remainingAllocation: 0,
        inventory: 20,
        daysLeft: 4,
        type: 'input',
      },
    };
    expect(countDays(burn)).toBe(4);
  });

  it('ignores materials with non-negative dailyAmount', () => {
    const burn: BurnValues = {
      DW: {
        input: 0,
        output: 10,
        workforce: 0,
        dailyAmount: 10,
        remainingAllocation: 0,
        inventory: 0,
        daysLeft: Infinity,
        type: 'output',
      },
      RAT: {
        input: 5,
        output: 0,
        workforce: 0,
        dailyAmount: -5,
        remainingAllocation: 0,
        inventory: 15,
        daysLeft: 3,
        type: 'input',
      },
    };
    expect(countDays(burn)).toBe(3);
  });
});
