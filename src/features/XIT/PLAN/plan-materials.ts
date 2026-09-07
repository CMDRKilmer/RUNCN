// 从已保存的基地计划（UserData.BasePlan）聚合建造所需建材（基础 + 环境）。
//
// 供 XIT BMAT（建材购买表）与 JH「购材 ACT」对话框共用，保证两处建材清单
// 口径一致。环境建材规则与 PLAN 面板一致：
//   - 地表：MCG；空间站：AEF
//   - 低重力（<0.25）：MGC；高重力（>2.5）：BL
//   - 低气压（<0.25）：SEA；高气压（>2.0）：HSE
//   - 低温（<-25°C）：INS；高温（>75°C）：TSH
//
// 价格无关：本模块只算「需求数量」，比价/采购由调用方（BMAT）负责。

import { fioBuildingsStore } from './fio-buildings';
import type { PlannedBuilding } from './tile-state';

export interface PlanetEnv {
  gravity: number;
  temperature: number;
  pressure: number;
  surface: boolean;
}

const FNAR_PLANET_URL = 'https://rest.fnar.net/planet';

// 拉取星球环境参数。失败（无该星球 / 网络不通）时返回 undefined，
// 调用方只按基础建材计算，与 GenerateConstructionActDialog 行为一致。
export async function fetchPlanetEnv(planet: string): Promise<PlanetEnv | undefined> {
  if (!planet) {
    return undefined;
  }
  try {
    const resp = await fetch(`${FNAR_PLANET_URL}/${encodeURIComponent(planet)}`);
    if (!resp.ok) {
      return undefined;
    }
    const data = await resp.json();
    return {
      gravity: data.Gravity as number,
      temperature: data.Temperature as number,
      pressure: data.Pressure as number,
      surface: data.Surface as boolean,
    };
  } catch {
    return undefined;
  }
}

// 星球环境建材：由建筑面积（AreaCost）与星球环境参数决定。
// env 缺失时返回空表（调用方此时应只累加基础 BuildingCosts）。
export function envMaterials(areaCost: number, env?: PlanetEnv): Record<string, number> {
  if (!env) {
    return {};
  }
  const mats: Record<string, number> = {};
  if (env.surface) {
    mats['MCG'] = areaCost * 4;
  } else {
    mats['AEF'] = Math.ceil(areaCost / 3);
  }
  if (env.gravity < 0.25) {
    mats['MGC'] = 1;
  } else if (env.gravity > 2.5) {
    mats['BL'] = 1;
  }
  if (env.pressure < 0.25) {
    mats['SEA'] = areaCost;
  } else if (env.pressure > 2.0) {
    mats['HSE'] = 1;
  }
  if (env.temperature < -25) {
    mats['INS'] = areaCost * 10;
  } else if (env.temperature > 75) {
    mats['TSH'] = 1;
  }
  return mats;
}

// 建筑数量：旧数据优先读 count，新数据按 recipes[].count 求和（兼容旧数据无 recipes）。
export function buildingCount(pb: PlannedBuilding): number {
  if ((pb.count ?? 0) !== 0) {
    return pb.count as number;
  }
  const recipes = pb.recipes ?? [];
  return recipes.reduce((sum, r) => sum + (r?.count ?? 0), 0);
}

export interface PlanMaterialSource {
  planet?: string;
  buildings?: unknown[];
}

// 聚合计划内所有建筑（基础 + 环境）的建材需求。
// 依赖 fioBuildingsStore（需先 loadFioBuildings()）。数据未就绪或计划中
// 没有可识别建筑时返回空 Map；遇到计划里无法识别的建筑 ticker 直接跳过。
export function collectPlanMaterials(
  plan: PlanMaterialSource,
  env?: PlanetEnv,
): Map<string, number> {
  const result = new Map<string, number>();
  const buildings = fioBuildingsStore.buildings;
  if (!buildings) {
    return result;
  }
  const list = plan.buildings ?? [];
  for (const raw of list) {
    const pb = raw as PlannedBuilding;
    if (!pb?.ticker) {
      continue;
    }
    const fb = buildings.find(x => x.Ticker === pb.ticker);
    if (!fb) {
      continue;
    }
    const count = buildingCount(pb);
    for (const cost of fb.BuildingCosts) {
      if (!cost.CommodityTicker) {
        continue;
      }
      result.set(
        cost.CommodityTicker,
        (result.get(cost.CommodityTicker) ?? 0) + cost.Amount * count,
      );
    }
    for (const [ticker, amount] of Object.entries(envMaterials(fb.AreaCost, env))) {
      result.set(ticker, (result.get(ticker) ?? 0) + amount * count);
    }
  }
  return result;
}
