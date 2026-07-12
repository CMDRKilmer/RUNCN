// Pure profit calculation for the ARB summary.
//
// A single buy level (ticker, buyExchange, buyPrice) can pair with multiple
// sell levels at the destination, each with its own sellQuantity and
// profitPerUnit. The greedy allocator returns the total `units` allocated to
// that buy level, but those units are sold by filling the highest-profit sell
// pairs first (the natural execution: you take the best buy orders first),
// each capped by its available qty.
//
// Summing `units * bestProfitPerUnit` over-attributes the best price to every
// unit and inflates the headline "expected profit". This helper computes the
// correct weighted profit.

export interface ProfitPair {
  // Available quantity at this sell price level.
  qty: number;
  // Profit per unit sold at this level (sellPrice - buyPrice).
  profitPerUnit: number;
}

// Profit realized by selling `units` across `pairs`, filling the highest-profit
// pairs first. Each pair is capped by its `qty`. If `units` exceeds the total
// available qty (should not happen for allocated units, but handled defensively),
// only the available qty is counted.
export function computeAllocatedProfit(pairs: ProfitPair[], units: number): number {
  if (units <= 0) {
    return 0;
  }
  const sorted = pairs.slice().sort((a, b) => b.profitPerUnit - a.profitPerUnit);
  let remaining = units;
  let profit = 0;
  for (const pair of sorted) {
    if (remaining <= 0) {
      break;
    }
    if (pair.qty <= 0) {
      continue;
    }
    const sold = Math.min(pair.qty, remaining);
    profit += sold * pair.profitPerUnit;
    remaining -= sold;
  }
  return profit;
}
