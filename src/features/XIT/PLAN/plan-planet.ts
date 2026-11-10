import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import type { PlanetEnv } from './plan-materials';
import type { FioBuilding, FioRecipe } from './fio-buildings';

interface PlanetResource {
  ticker: string;
  type: 'MINERAL' | 'LIQUID' | 'GASEOUS';
  factor: number;
}

export interface PlanetProductionFee {
  Category: string;
  WorkforceLevel: PrunApi.WorkforceLevel;
  FeeAmount: number;
  FeeCurrency: string | null;
}

export interface PlanetEnvironment extends PlanetEnv {
  fertility?: number;
  factionCode?: string | null;
  cogcPrograms?: { ProgramType: string; StartEpochMs: number; EndEpochMs: number }[];
  productionFees?: PlanetProductionFee[];
  resources: PlanetResource[];
}

const RESOURCE_TYPE_BUILDING: Record<string, string> = {
  MINERAL: 'EXT',
  LIQUID: 'RIG',
  GASEOUS: 'COL',
};

const planetEnvCache = new Map<string, PlanetEnvironment>();
export async function loadPlanetEnvironment(naturalId: string, refresh = false) {
  const cached = planetEnvCache.get(naturalId);
  if (!refresh && cached !== undefined) {
    return cached;
  }
  try {
    const resp = await fetch(`https://rest.fnar.net/planet/${encodeURIComponent(naturalId)}`);
    if (!resp.ok) {
      return undefined;
    }
    const data = await resp.json();
    if (
      !Number.isFinite(data.Gravity) ||
      !Number.isFinite(data.Temperature) ||
      !Number.isFinite(data.Pressure) ||
      typeof data.Surface !== 'boolean'
    ) {
      return undefined;
    }
    const resources: PlanetResource[] = [];
    for (const r of (data.Resources ?? []) as {
      MaterialId: string;
      ResourceType: string;
      Factor: number;
    }[]) {
      const mat = materialsStore.getById(r.MaterialId);
      if (mat && Number.isFinite(r.Factor) && r.Factor > 0) {
        resources.push({
          ticker: mat.ticker,
          type: r.ResourceType as PlanetResource['type'],
          factor: r.Factor,
        });
      }
    }
    const env: PlanetEnvironment = {
      fertility: data.Fertility ?? undefined,
      factionCode: data.FactionCode as string | null | undefined,
      cogcPrograms: data.COGCProgramStatus === 'ACTIVE' ? data.COGCPrograms : undefined,
      productionFees: Array.isArray(data.ProductionFees) ? data.ProductionFees : undefined,
      gravity: data.Gravity as number,
      temperature: data.Temperature as number,
      pressure: data.Pressure as number,
      surface: data.Surface as boolean,
      resources,
    };
    if (materialsStore.fetched.value) {
      planetEnvCache.set(naturalId, env);
    }
    return env;
  } catch {
    return undefined;
  }
}

export function getActiveCogcProgram(env: PlanetEnvironment, timestamp: number) {
  return env.cogcPrograms?.find(x => x.StartEpochMs <= timestamp && timestamp < x.EndEpochMs)
    ?.ProgramType;
}

// 开采产量计算常量（来源：PRUNplanner）。
const TOTAL_MS_DAY = 86400000;
const BASE_DAILY: Record<string, number> = { MINERAL: 70, LIQUID: 70, GASEOUS: 60 };
const DAILY_TYPE_SHARE: Record<string, number> = {
  MINERAL: 43200000 / TOTAL_MS_DAY, // EXT 12h → 0.5
  LIQUID: 17280000 / TOTAL_MS_DAY, // RIG 4h48m → 0.2
  GASEOUS: 21600000 / TOTAL_MS_DAY, // COL 6h → 0.25
};

// 获取建筑的有效配方列表。
// 对于开采类建筑（EXT/RIG/COL），FIO 只有空配方，需根据星球资源生成。
export function getPlanetRecipes(fb: FioBuilding, env: PlanetEnvironment | undefined): FioRecipe[] {
  const ticker = fb.Ticker;
  const buildingForType = RESOURCE_TYPE_BUILDING;
  const matchingType = Object.entries(buildingForType).find(([, b]) => b === ticker)?.[0];
  if (!matchingType) {
    return fb.Recipes;
  }
  if (!env || env.resources.length === 0) {
    return fb.Recipes;
  }
  const planetResources = env.resources.filter(r => r.type === matchingType);
  if (planetResources.length === 0) {
    return fb.Recipes;
  }
  return planetResources.map(r => {
    const dailyExtraction = r.factor * (BASE_DAILY[r.type] ?? 70);
    const share = DAILY_TYPE_SHARE[r.type] ?? 0.5;
    const amount = Math.trunc(Math.ceil(dailyExtraction * share));
    const timeMs =
      amount > 0 ? Math.round(amount * (TOTAL_MS_DAY / dailyExtraction)) : TOTAL_MS_DAY;
    return {
      RecipeName: `=>${amount}x${r.ticker} (${(r.factor * 100).toFixed(1)}%)`,
      DurationMs: timeMs,
      Inputs: [],
      Outputs: [{ CommodityTicker: r.ticker, Amount: amount }],
    };
  });
}
