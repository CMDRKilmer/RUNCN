import { describe, expect, it } from 'vitest';
import { computeAllocatedProfit } from './arb-profit';

describe('computeAllocatedProfit', () => {
  it('returns 0 for non-positive units', () => {
    expect(computeAllocatedProfit([{ qty: 10, profitPerUnit: 5 }], 0)).toBe(0);
    expect(computeAllocatedProfit([{ qty: 10, profitPerUnit: 5 }], -3)).toBe(0);
  });

  it('returns 0 for empty pairs', () => {
    expect(computeAllocatedProfit([], 80)).toBe(0);
  });

  // Regression: a buy level paired with multiple sell levels must NOT attribute
  // the best sell price to every unit. 80 units across 50@profit15 + 30@profit10
  // is 1050, not the previous buggy 80*15 = 1200.
  it('fills highest-profit pairs first, capped by each pair qty', () => {
    const pairs = [
      { qty: 30, profitPerUnit: 10 },
      { qty: 50, profitPerUnit: 15 },
    ];
    expect(computeAllocatedProfit(pairs, 80)).toBe(50 * 15 + 30 * 10);
    expect(computeAllocatedProfit(pairs, 80)).toBe(1050);
  });

  it('does not over-attribute the best price to all units', () => {
    const pairs = [
      { qty: 50, profitPerUnit: 15 },
      { qty: 30, profitPerUnit: 10 },
    ];
    expect(computeAllocatedProfit(pairs, 80)).not.toBe(80 * 15);
  });

  it('uses only the best pair when units fit within it', () => {
    const pairs = [
      { qty: 50, profitPerUnit: 15 },
      { qty: 30, profitPerUnit: 10 },
    ];
    expect(computeAllocatedProfit(pairs, 40)).toBe(40 * 15);
  });

  it('counts only available qty when units exceed total (defensive)', () => {
    const pairs = [
      { qty: 50, profitPerUnit: 15 },
      { qty: 30, profitPerUnit: 10 },
    ];
    expect(computeAllocatedProfit(pairs, 100)).toBe(1050);
  });

  it('skips pairs with non-positive qty', () => {
    const pairs = [
      { qty: 0, profitPerUnit: 99 },
      { qty: 50, profitPerUnit: 15 },
    ];
    expect(computeAllocatedProfit(pairs, 40)).toBe(40 * 15);
  });

  it('handles a single pair', () => {
    expect(computeAllocatedProfit([{ qty: 100, profitPerUnit: 7 }], 60)).toBe(60 * 7);
  });
});
