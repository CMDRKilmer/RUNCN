export type WfTier = 'Pioneers' | 'Settlers' | 'Technicians' | 'Engineers' | 'Scientists';
export const tierToLevel: Record<WfTier, PrunApi.WorkforceLevel> = {
  Pioneers: 'PIONEER',
  Settlers: 'SETTLER',
  Technicians: 'TECHNICIAN',
  Engineers: 'ENGINEER',
  Scientists: 'SCIENTIST',
};

export const wfTiers: WfTier[] = ['Pioneers', 'Settlers', 'Technicians', 'Engineers', 'Scientists'];

// 已知居住建筑的默认容量回退表。
// 数据来源：PRUNner 开源项目，与游戏内部数据一致。
export const HABITATION_FALLBACK: Record<string, Partial<Record<WfTier, number>>> = {
  HB1: { Pioneers: 100 },
  HB2: { Settlers: 100 },
  HB3: { Technicians: 100 },
  HB4: { Engineers: 100 },
  HB5: { Scientists: 100 },
  HBB: { Pioneers: 75, Settlers: 75 },
  HBC: { Settlers: 75, Technicians: 75 },
  HBM: { Technicians: 75, Engineers: 75 },
  HBL: { Engineers: 75, Scientists: 75 },
};

export function getHousingCapacity(
  ticker: string,
  tier: WfTier,
  capacities: PrunApi.WorkforceCapacity[] | undefined,
) {
  const capacity = capacities?.find(x => x.level === tierToLevel[tier])?.capacity;
  return capacity !== undefined && capacity > 0
    ? capacity
    : (HABITATION_FALLBACK[ticker]?.[tier] ?? 0);
}

interface HabOption {
  ticker: string;
  caps: Record<WfTier, number>;
  area: number;
  cost?: number;
}

export function planHousing(
  baseDeficit: Record<WfTier, number>,
  options: HabOption[],
  maxArea = Infinity,
) {
  if (wfTiers.every(t => baseDeficit[t] <= 0)) {
    return [];
  }

  const relevantOptions = options.filter(
    opt => opt.area <= maxArea && wfTiers.some(t => baseDeficit[t] > 0 && opt.caps[t] > 0),
  );
  if (wfTiers.some(t => baseDeficit[t] > 0 && !relevantOptions.some(x => x.caps[t] > 0))) {
    return undefined;
  }

  // A fully priced combination ranks ahead of one with missing prices.
  const useCosts = relevantOptions.some(x => x.cost !== undefined);
  const costs = relevantOptions.map(x => (useCosts ? (x.cost ?? Infinity) : 0));
  let bestCost = Infinity;
  let bestArea = Infinity;
  let bestCounts: number[] | undefined;

  // 计算初始上界（贪心）。
  {
    const greedyCounts = relevantOptions.map(() => 0);
    const rem = { ...baseDeficit };
    for (const tier of wfTiers) {
      if (rem[tier] <= 0) {
        continue;
      }
      // 单层住房中找容量/面积比最大的。
      let bestIdx = -1;
      let bestRatio = -1;
      for (let i = 0; i < relevantOptions.length; i++) {
        const cap = relevantOptions[i].caps[tier];
        if (cap <= 0) {
          continue;
        }
        const ratio = cap / relevantOptions[i].area;
        if (ratio > bestRatio) {
          bestRatio = ratio;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) {
        continue;
      }
      const cap = relevantOptions[bestIdx].caps[tier];
      const count = Math.ceil(rem[tier] / cap);
      greedyCounts[bestIdx] += count;
      for (const t of wfTiers) {
        rem[t] -= count * relevantOptions[bestIdx].caps[t];
      }
    }
    const greedyArea = greedyCounts.reduce((s, c, i) => s + c * relevantOptions[i].area, 0);
    if (wfTiers.every(t => rem[t] <= 0) && greedyArea <= maxArea) {
      bestCost = greedyCounts.reduce(
        (sum, count, i) => (count > 0 ? sum + count * costs[i] : sum),
        0,
      );
      bestArea = greedyArea;
      bestCounts = [...greedyCounts];
    }
  }

  const counts = relevantOptions.map(() => 0);

  function dfs(idx: number, rem: Record<WfTier, number>, usedArea: number, usedCost: number) {
    const costDifference = usedCost === bestCost ? 0 : usedCost - bestCost;
    const sameCost = Math.abs(costDifference) <= 1e-8;
    if (usedArea > maxArea || costDifference > 1e-8 || (sameCost && usedArea >= bestArea)) {
      return;
    }
    // 满足条件。
    if (wfTiers.every(t => rem[t] <= 0)) {
      bestCost = usedCost;
      bestArea = usedArea;
      bestCounts = relevantOptions.map((_, i) => counts[i]);
      return;
    }
    if (idx >= relevantOptions.length) {
      return;
    }

    const opt = relevantOptions[idx];
    // 计算该建筑最多需要几个（满足所有它能覆盖的层级）。
    let maxNeeded = 0;
    for (const tier of wfTiers) {
      if (opt.caps[tier] > 0 && rem[tier] > 0) {
        maxNeeded = Math.max(maxNeeded, Math.ceil(rem[tier] / opt.caps[tier]));
      }
    }
    const remainingArea = Math.min(maxArea, sameCost ? bestArea : Infinity) - usedArea;
    const maxTry = Math.min(maxNeeded, Math.floor(remainingArea / opt.area));

    for (let c = maxTry; c >= 0; c--) {
      counts[idx] = c;
      const newRem = { ...rem };
      for (const tier of wfTiers) {
        if (opt.caps[tier] > 0) {
          newRem[tier] = rem[tier] - opt.caps[tier] * c;
        }
      }
      const nextCost = c === 0 ? usedCost : usedCost + c * costs[idx];
      dfs(idx + 1, newRem, usedArea + c * opt.area, nextCost);
    }
    counts[idx] = 0;
  }

  dfs(0, { ...baseDeficit }, 0, 0);

  // 转换结果。
  if (bestCounts === undefined) {
    return undefined;
  }

  const additions: { ticker: string; count: number }[] = [];
  for (let i = 0; i < relevantOptions.length; i++) {
    if (bestCounts[i] > 0) {
      additions.push({ ticker: relevantOptions[i].ticker, count: bestCounts[i] });
    }
  }

  return additions;
}
