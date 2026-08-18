// FIO 建筑数据接口与存储。
// 注意：人口字段直接在建筑对象上，无嵌套。

export interface FioBuildingCost {
  CommodityTicker: string;
  Amount: number;
}

export interface FioRecipeIO {
  CommodityTicker: string;
  Amount: number;
}

export interface FioRecipe {
  RecipeName: string;
  DurationMs: number;
  Inputs: FioRecipeIO[];
  Outputs: FioRecipeIO[];
}

export interface FioBuilding {
  Ticker: string;
  Name: string;
  AreaCost: number;
  Expertise: string | null;
  // 人口需求（生产建筑）或人口供给（居住建筑）直接以扁平字段存储
  Pioneers: number;
  Settlers: number;
  Technicians: number;
  Engineers: number;
  Scientists: number;
  BuildingCosts: FioBuildingCost[];
  Recipes: FioRecipe[];
}

// 本次会话内的建筑数据存储。
export const fioBuildingsStore = shallowReactive<{
  buildings: FioBuilding[] | undefined;
  loading: boolean;
  error: boolean;
}>({
  buildings: undefined,
  loading: false,
  error: false,
});

// 标记是否已发起过请求，避免重复加载。
let fetchStarted = false;

const FIO_URL = 'https://rest.fnar.net/building/allbuildings';

// 懒加载建筑数据，每次会话只请求一次。
export async function loadFioBuildings() {
  if (fetchStarted) {
    return;
  }
  fetchStarted = true;
  fioBuildingsStore.loading = true;
  fioBuildingsStore.error = false;
  try {
    const response = await fetch(FIO_URL);
    if (!response.ok) {
      fioBuildingsStore.error = true;
      return;
    }
    fioBuildingsStore.buildings = (await response.json()) as FioBuilding[];
  } catch {
    fioBuildingsStore.error = true;
  } finally {
    fioBuildingsStore.loading = false;
  }
}
