import { EXPERT_BONUSES } from '@src/core/experts';
import type { FioBuilding } from '@src/features/XIT/PLAN/fio-buildings';
import { wfTiers } from '@src/features/XIT/PLAN/plan-housing';

export const BASE_EXPERT_LIMIT = 6;
export const INDUSTRY_EXPERT_LIMIT = EXPERT_BONUSES.length - 1;

export function allocateIndustryExperts(
  industries: ReadonlySet<string>,
  overrides: Partial<Record<string, number>>,
) {
  const counts = new Map<string, number>();
  let available = BASE_EXPERT_LIMIT;
  for (const industry of industries) {
    const count = overrides[industry];
    if (count !== undefined) {
      const assigned = Math.max(0, Math.min(count, INDUSTRY_EXPERT_LIMIT, available));
      counts.set(industry, assigned);
      available -= assigned;
    }
  }
  for (const industry of industries) {
    if (!counts.has(industry)) {
      const assigned = Math.min(INDUSTRY_EXPERT_LIMIT, available);
      counts.set(industry, assigned);
      available -= assigned;
    }
  }
  return counts;
}

const HQ_BONUSES: Record<string, Partial<Record<string, number>>> = {
  AI: { ELECTRONICS: 0.1 },
  CI: { MANUFACTURING: 0.1 },
  IC: { AGRICULTURE: 0.06, FOOD_INDUSTRIES: 0.04 },
  NC: { METALLURGY: 0.04, CONSTRUCTION: 0.06 },
  OUT: { CHEMISTRY: 0.04, FUEL_REFINING: 0.04, RESOURCE_EXTRACTION: 0.04 },
};

export interface IndustryBonuses {
  experts: number;
  cogcProgram: string | undefined;
  corporateHq: boolean;
  companyHq: { faction: string | null; usedPermits: number; totalPermits: number } | undefined;
}

export function getIndustryEfficiency(
  building: FioBuilding,
  fertility: number,
  bonuses: IndustryBonuses,
  permits: number,
) {
  const expertise = building.Expertise ?? '';
  const hq = bonuses.companyHq;
  const usedPermits = (hq?.usedPermits ?? 0) + permits;
  const totalPermits = Math.max(hq?.totalPermits ?? 0, usedPermits);
  const factionBonus = hq === undefined ? 0 : (HQ_BONUSES[hq.faction ?? 'OUT']?.[expertise] ?? 0);
  const companyHq = 1 + factionBonus * (3 - (2 * usedPermits) / totalPermits);
  const corporateHq = bonuses.corporateHq ? 1.1 : 1;
  const experts = expertise === '' ? 1 : 1 + (EXPERT_BONUSES[bonuses.experts] ?? 0);
  let cogc = 1;
  if (expertise !== '' && bonuses.cogcProgram === `ADVERTISING_${expertise}`) {
    cogc = 1.25;
  } else if (
    wfTiers.some(t => building[t] > 0 && bonuses.cogcProgram === `WORKFORCE_${t.toUpperCase()}`)
  ) {
    cogc = 1.1;
  }
  return {
    total: fertility * companyHq * corporateHq * experts * cogc,
    fertility,
    companyHq,
    corporateHq,
    experts,
    cogc,
  };
}
