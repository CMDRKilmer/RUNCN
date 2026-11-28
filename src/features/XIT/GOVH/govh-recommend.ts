// XIT GOVH 建造页的「推荐配置」：按人口与当前满足度，反推每类基建建筑要建到几级。
//
// 机制（与 govh-model 一致，已固化）：每座基建每 1 级提供 `needs[need]` 点需求，
// 实际效果再乘以「这一周收到的 upkeep / 需要的 upkeep」；满足度 = 供给 / 需求，
// 需求量 = Σ 人口 × 各人口权重。基地本身固定提供安全 / 健康各 50 点。
//
// 这里做的是**贪心近似**（不是全局最优）：每轮给「性价比最高的一级」加一，
// 直到五类基建需求都达到目标或全部建筑顶到 10 级。成本由调用方传入（带本地行情），
// 缺报价时按材料量计，保证仍能给出一个可执行的配置。

import {
  INFRA_NEEDS,
  computeNeeded,
  type InfraNeed,
  type Need,
  type WorkforceLevel,
  UPKEEP_BUILDINGS,
} from './govh-model';
import { BUILDING_MAX_LEVEL, SCALABLE_BUILDINGS } from './govh-buildings';

export interface RecommendInput {
  population: Record<WorkforceLevel, number>;
  /** 政府当前已建等级（作为下限，不建议降级） */
  start: Readonly<Record<string, number>>;
  /** 当前满足度（0~1，含封顶），用来反推基地 / 住房等非基建供给 */
  fulfillment: Record<Need, number>;
  /** 从 from 级升到 to 级这一段的材料成本 */
  cost: (code: string, from: number, to: number) => number;
}

export interface RecommendResult {
  /** 建筑代码 → 建议目标等级 */
  levels: Record<string, number>;
  /** 每类需求的需求量 / 已确认供给 / 建议新增供给 */
  needs: Record<InfraNeed, { needed: number; provided: number; added: number }>;
  /** 顶到 10 级仍补不满的需求 */
  unmet: InfraNeed[];
}

const BUILDING_NEEDS = new Map(
  UPKEEP_BUILDINGS.map(building => [building.ticker, building.needs] as const),
);

const usableBuildings = SCALABLE_BUILDINGS.map(building => building.code);

/** 建议配置：只保证五类基建需求达标，不追求材料种类最少。 */
export function recommendLevels(input: RecommendInput): RecommendResult {
  const needed = computeNeeded(input.population);
  const levels: Record<string, number> = {};
  const provided: Record<string, number> = {};
  for (const code of usableBuildings) {
    levels[code] = Math.min(input.start[code] ?? 0, BUILDING_MAX_LEVEL);
    provided[code] = levels[code];
  }

  const supply: Record<InfraNeed, number> = {} as Record<InfraNeed, number>;
  const target: Record<InfraNeed, number> = {} as Record<InfraNeed, number>;
  for (const need of INFRA_NEEDS) {
    target[need] = needed[need];
    // 已有供给 = 当前满足度 × 需求量；其中等级带来的部分先扣掉，剩下的
    // （基地 +50/座、住房等）视为「不是本次要建的东西」。
    const now = Math.max(0, (input.fulfillment[need] ?? 0) * needed[need]);
    let fromLevels = 0;
    for (const code of usableBuildings) {
      const per = BUILDING_NEEDS.get(code)?.[need] ?? 0;
      fromLevels += per * levels[code];
    }
    const baseline = Math.max(0, now - fromLevels);
    supply[need] = fromLevels + baseline;
  }

  const added: Record<InfraNeed, number> = { ...(supply as Record<InfraNeed, number>) };
  const initial = { ...added };

  // 贪心：每次给「每点成本最低、且能补到缺口」的一级加一。
  //
  // 约束只有一条：**不拆已建成的建筑**。levels 以现状为起点、只加不减，所以推荐
  // 不会出现「把 SST 清零、改建 SDP」这种方案——现有建筑的等级只会被保留或提高。
  // 反过来，如果另一类建筑从 0 建到 1 级更划算（需求增长、现有等级已很高时常见），
  // 允许直接新建，不受「必须沿用现有类型」的限制。
  for (let guard = 0; guard < usableBuildings.length * BUILDING_MAX_LEVEL + 1; guard++) {
    const deficits = INFRA_NEEDS.filter(need => added[need] < target[need]);
    if (deficits.length === 0) {
      break;
    }
    let best: { code: string; score: number } | undefined;
    for (const code of usableBuildings) {
      if (levels[code] >= BUILDING_MAX_LEVEL) {
        continue;
      }
      const needs = BUILDING_NEEDS.get(code);
      if (!needs) {
        continue;
      }
      let gain = 0;
      for (const need of deficits) {
        const per = needs[need] ?? 0;
        if (per <= 0) {
          continue;
        }
        // 只算「还缺的」那部分，避免为已经满足的需求多花钱。
        gain += Math.min(per, target[need] - added[need]);
      }
      if (gain <= 0) {
        continue;
      }
      // 边际成本按「这一级」算：新建（0→1）只要 1 级的材料，已有建筑升一级更贵，
      // 所以贪心会优先考虑性价比高的新建，但仍不会动已建成的等级。
      const cost = Math.max(input.cost(code, levels[code], levels[code] + 1), 1);
      const score = gain / cost;
      if (!best || score > best.score) {
        best = { code, score };
      }
    }
    if (!best) {
      break;
    }
    levels[best.code] += 1;
    const needs = BUILDING_NEEDS.get(best.code) ?? {};
    for (const need of deficits) {
      const per = needs[need] ?? 0;
      if (per > 0) {
        added[need] += per;
      }
    }
  }

  const unmet = INFRA_NEEDS.filter(need => added[need] < target[need]);
  return {
    levels,
    needs: Object.fromEntries(
      INFRA_NEEDS.map(need => [
        need,
        {
          needed: target[need],
          provided: initial[need] ?? 0,
          added: (added[need] ?? 0) - (initial[need] ?? 0),
        },
      ]),
    ) as RecommendResult['needs'],
    unmet: [...unmet],
  };
}
