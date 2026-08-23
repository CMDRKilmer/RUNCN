<script setup lang="ts">
import { useTileState, PlannedBuilding, PlannedRecipe } from '@src/features/XIT/PLAN/tile-state';
import { getTileState } from '@src/store/user-data-tiles';
import {
  fioBuildingsStore,
  loadFioBuildings,
  FioBuilding,
  FioRecipe,
  FioRecipeIO,
} from '@src/features/XIT/PLAN/fio-buildings';
import { workforceNeedsStore, loadWorkforceNeeds } from '@src/features/XIT/PLAN/workforce-needs';
import { BUILDING_NAMES_ZH } from '@src/features/XIT/PLAN/building-names-zh';
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import { cxStore } from '@src/infrastructure/fio/cx';
import { userData } from '@src/store/user-data';
import { planetsStore } from '@src/infrastructure/prun-api/data/planets';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { sortMaterials } from '@src/core/sort-materials';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { showTileOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import { formatCurrency, fixed2 } from '@src/utils/format';
import PrunButton from '@src/components/PrunButton.vue';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import Active from '@src/components/forms/Active.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import SavePlanOverlay from '@src/features/XIT/PLAN/SavePlanOverlay.vue';

// 从 XIT 参数中读取初始星球。
const parameters = useXitParameters();

const planet = useTileState('planet');
const permits = useTileState('permits');
const exchange = useTileState('exchange');
const buildings = useTileState('buildings');
const experts = useTileState('experts');
const cogcIndustry = useTileState('cogcIndustry');
const customInputPrices = useTileState('customInputPrices');
const customOutputPrices = useTileState('customOutputPrices');
const customWfPrices = useTileState('customWfPrices');
const jhPlanId = useTileState('jhPlanId');

// 从 JH 工作区加载数据（从 JH 列表打开计划时）。
{
  const ws = getTileState('bplan-workspace') as Record<string, unknown>;
  if (Object.keys(ws).length > 0) {
    planet.value = (ws.planet as string) ?? '';
    permits.value = (ws.permits as number) ?? 1;
    exchange.value = (ws.exchange as string) ?? 'IC1';
    buildings.value = JSON.parse(JSON.stringify(ws.buildings ?? []));
    experts.value = { ...((ws.experts as Record<string, number>) ?? {}) };
    cogcIndustry.value = (ws.cogcIndustry as string) ?? '';
    customInputPrices.value = { ...((ws.customInputPrices as Record<string, number>) ?? {}) };
    customOutputPrices.value = { ...((ws.customOutputPrices as Record<string, number>) ?? {}) };
    customWfPrices.value = { ...((ws.customWfPrices as Record<string, number>) ?? {}) };
    jhPlanId.value = (ws.jhPlanId as string) ?? '';
    // 清空工作区，避免残留。
    for (const key of Object.keys(ws)) {
      delete ws[key];
    }
  }
}

// 专家加成固定值（index = 专家数量）。
const EXPERT_BONUSES = [0, 0.0306, 0.0826, 0.1534, 0.2315, 0.284];

const EXPERTISE_CATEGORIES = [
  'AGRICULTURE',
  'CHEMISTRY',
  'CONSTRUCTION',
  'ELECTRONICS',
  'FOOD_INDUSTRIES',
  'FUEL_REFINING',
  'MANUFACTURING',
  'METALLURGY',
  'RESOURCE_EXTRACTION',
] as const;

const EXPERTISE_LABELS: Record<string, string> = {
  AGRICULTURE: '农业',
  CHEMISTRY: '化学',
  CONSTRUCTION: '建筑材料',
  ELECTRONICS: '电子',
  FOOD_INDUSTRIES: '食品工业',
  FUEL_REFINING: '燃料精炼',
  MANUFACTURING: '制造',
  METALLURGY: '冶金',
  RESOURCE_EXTRACTION: '资源开采',
};

function getEfficiencyMultiplier(expertise: string | null | undefined): number {
  if (!expertise) {
    return 1;
  }
  const expertCount = Math.min(5, Math.max(0, experts.value[expertise] ?? 0));
  const expertBonus = EXPERT_BONUSES[expertCount];
  const cogcBonus = cogcIndustry.value === expertise ? 0.25 : 0;
  return (1 + expertBonus) * (1 + cogcBonus);
}

function onExpertChange(category: string, value: number) {
  const clamped = Math.min(5, Math.max(0, value));
  const newExperts = { ...experts.value };
  if (clamped === 0) {
    delete newExperts[category];
  } else {
    newExperts[category] = clamped;
  }
  experts.value = newExperts;
}

// 若用户通过参数传入星球，则预填充。
if (parameters.length > 0 && !planet.value) {
  planet.value = parameters[0];
}

// 懒加载 FIO 建筑数据。
loadFioBuildings();
// 懒加载人口消耗品数据。
loadWorkforceNeeds();

// ── 星球环境建材 ──────────────────────────────────────────────
interface PlanetResource {
  ticker: string;
  type: 'MINERAL' | 'LIQUID' | 'GASEOUS';
  factor: number;
}

interface PlanetEnvironment {
  gravity: number;
  temperature: number;
  pressure: number;
  surface: boolean;
  resources: PlanetResource[];
}

const RESOURCE_TYPE_BUILDING: Record<string, string> = {
  MINERAL: 'EXT',
  LIQUID: 'RIG',
  GASEOUS: 'COL',
};

const planetEnvCache = new Map<string, PlanetEnvironment>();
const planetEnv = ref<PlanetEnvironment | undefined>();

async function fetchPlanetDetail(naturalId: string) {
  if (planetEnvCache.has(naturalId)) {
    planetEnv.value = planetEnvCache.get(naturalId);
    return;
  }
  try {
    const resp = await fetch(`https://rest.fnar.net/planet/${encodeURIComponent(naturalId)}`);
    if (!resp.ok) {
      planetEnv.value = undefined;
      return;
    }
    const data = await resp.json();
    const resources: PlanetResource[] = [];
    for (const r of (data.Resources ?? []) as {
      MaterialId: string;
      ResourceType: string;
      Factor: number;
    }[]) {
      const mat = materialsStore.getById(r.MaterialId);
      if (mat) {
        resources.push({
          ticker: mat.ticker,
          type: r.ResourceType as PlanetResource['type'],
          factor: r.Factor,
        });
      }
    }
    const env: PlanetEnvironment = {
      gravity: data.Gravity as number,
      temperature: data.Temperature as number,
      pressure: data.Pressure as number,
      surface: data.Surface as boolean,
      resources,
    };
    planetEnvCache.set(naturalId, env);
    planetEnv.value = env;
  } catch {
    planetEnv.value = undefined;
  }
}

// 根据星球环境参数和建筑面积计算环境建材需求。
function getPlanetEnvMaterials(areaCost: number): Record<string, number> {
  const env = planetEnv.value;
  if (!env) {
    return {};
  }
  const mats: Record<string, number> = {};
  // 星球表面类型
  if (env.surface) {
    mats['MCG'] = areaCost * 4;
  } else {
    mats['AEF'] = Math.ceil(areaCost / 3);
  }
  // 重力
  if (env.gravity < 0.25) {
    mats['MGC'] = 1;
  } else if (env.gravity > 2.5) {
    mats['BL'] = 1;
  }
  // 气压
  if (env.pressure < 0.25) {
    mats['SEA'] = areaCost;
  } else if (env.pressure > 2.0) {
    mats['HSE'] = 1;
  }
  // 温度
  if (env.temperature < -25) {
    mats['INS'] = areaCost * 10;
  } else if (env.temperature > 75) {
    mats['TSH'] = 1;
  }
  return mats;
}

// 交易所选项列表。
const exchangeOptions = ['IC1', 'AI1', 'NC1', 'CI1', 'NC2', 'CI2'];

// 可供选择的所有建筑列表（按 Ticker 排序）。
const allBuildings = computed<FioBuilding[]>(() => {
  const list = fioBuildingsStore.buildings;
  if (!list) {
    return [];
  }
  return [...list].sort((a, b) => a.Ticker.localeCompare(b.Ticker));
});

function findFioBuilding(ticker: string): FioBuilding | undefined {
  return fioBuildingsStore.buildings?.find(x => x.Ticker === ticker);
}

// ── 建筑元数据（类型 + 人口容量）──────────────────────────────
interface BuildingMetaEntry {
  type: PrunApi.PlatformModuleType;
  name: string;
  wfCapacities: PrunApi.WorkforceCapacity[];
}

const buildingMeta = computed(() => {
  const sites = sitesStore.all.value;
  const map = new Map<string, BuildingMetaEntry>();
  if (!sites) {
    return map;
  }
  for (const site of sites) {
    for (const opt of site.buildOptions.options) {
      if (!map.has(opt.ticker)) {
        map.set(opt.ticker, {
          type: opt.type,
          name: opt.name,
          wfCapacities: opt.workforceCapacities,
        });
      }
    }
  }
  return map;
});

type WfTier = 'Pioneers' | 'Settlers' | 'Technicians' | 'Engineers' | 'Scientists';
const tierToLevel: Record<WfTier, PrunApi.WorkforceLevel> = {
  Pioneers: 'PIONEER',
  Settlers: 'SETTLER',
  Technicians: 'TECHNICIAN',
  Engineers: 'ENGINEER',
  Scientists: 'SCIENTIST',
};

function getBuildingType(ticker: string): PrunApi.PlatformModuleType | undefined {
  return buildingMeta.value.get(ticker)?.type;
}

function isProductionBuilding(ticker: string): boolean {
  const t = getBuildingType(ticker);
  if (t) {
    return t === 'PRODUCTION' || t === 'RESOURCES';
  }
  const fb = findFioBuilding(ticker);
  return fb ? fb.Recipes.length > 0 : false;
}

// 迁移旧格式（recipeIdx + count）到新格式（recipes 数组）。
function migrateBuilding(pb: PlannedBuilding): PlannedBuilding {
  if (pb.recipes !== undefined) {
    return pb;
  }
  return {
    ...pb,
    recipes:
      pb.recipeIdx !== undefined && pb.recipeIdx >= 0
        ? [{ recipeIdx: pb.recipeIdx, count: pb.count }]
        : [],
  };
}

function isHabitationBuilding(ticker: string): boolean {
  const t = getBuildingType(ticker);
  if (t) {
    return t === 'HABITATION';
  }
  if (ticker in HABITATION_FALLBACK) {
    return true;
  }
  const fb = findFioBuilding(ticker);
  return fb ? fb.Name.toLowerCase().includes('habitation') : false;
}

function isStorageBuilding(ticker: string): boolean {
  const t = getBuildingType(ticker);
  if (t) {
    return t === 'STORAGE';
  }
  const fb = findFioBuilding(ticker);
  return fb
    ? fb.Name.toLowerCase().includes('storage') || fb.Name.toLowerCase().includes('store')
    : false;
}

// 获取居住建筑在指定层级的容量。
// 优先使用游戏 API 数据，容量为 0 或不可用时回退到硬编码表。
function getWfCapacity(ticker: string, tier: WfTier): number {
  const meta = buildingMeta.value.get(ticker);
  if (meta) {
    const gameCap = meta.wfCapacities.find(c => c.level === tierToLevel[tier])?.capacity;
    if (gameCap !== undefined && gameCap > 0) {
      return gameCap;
    }
  }
  return HABITATION_FALLBACK[ticker]?.[tier] ?? 0;
}

// 已知居住建筑的默认容量回退表。
// 数据来源：PRUNner 开源项目，与游戏内部数据一致。
const HABITATION_FALLBACK: Record<string, Partial<Record<WfTier, number>>> = {
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

// 获取建筑显示名称：中文 → 游戏内名称 → FIO camelCase 格式化。
function getBuildingDisplayName(ticker: string): string {
  if (BUILDING_NAMES_ZH[ticker]) {
    return BUILDING_NAMES_ZH[ticker];
  }
  const gameName = buildingMeta.value.get(ticker)?.name;
  if (gameName) {
    return gameName;
  }
  const fb = findFioBuilding(ticker);
  if (!fb) {
    return ticker;
  }
  return fb.Name.replace(/([A-Z])/g, ' $1')
    .trim()
    .replace(/^./, s => s.toUpperCase());
}

// 建筑行类型标签（非生产建筑的配方列显示）。
function buildingTypeLabel(ticker: string): string {
  if (isHabitationBuilding(ticker)) {
    return '居住';
  }
  if (isStorageBuilding(ticker)) {
    return '仓库';
  }
  if (ticker === 'CM') {
    return '核心';
  }
  return '--';
}

// 已用面积合计。
const totalArea = computed<number>(() => {
  let sum = 0;
  for (const pb of buildings.value) {
    const fb = findFioBuilding(pb.ticker);
    if (fb) {
      sum += fb.AreaCost * pb.count;
    }
  }
  return sum;
});

const maxArea = computed<number>(() => permits.value * 500);

// 各层级劳动力需求（来自生产建筑）。
const workforceNeeded = computed(() => {
  const result = { Pioneers: 0, Settlers: 0, Technicians: 0, Engineers: 0, Scientists: 0 };
  for (const pb of buildings.value) {
    const fb = findFioBuilding(pb.ticker);
    if (!fb || !isProductionBuilding(pb.ticker)) {
      continue;
    }
    result.Pioneers += fb.Pioneers * pb.count;
    result.Settlers += fb.Settlers * pb.count;
    result.Technicians += fb.Technicians * pb.count;
    result.Engineers += fb.Engineers * pb.count;
    result.Scientists += fb.Scientists * pb.count;
  }
  return result;
});

// 各层级劳动力供给（来自居住建筑）。
const workforceProvided = computed(() => {
  const result = { Pioneers: 0, Settlers: 0, Technicians: 0, Engineers: 0, Scientists: 0 };
  for (const pb of buildings.value) {
    if (!isHabitationBuilding(pb.ticker)) {
      continue;
    }
    for (const tier of wfTiers) {
      result[tier] += getWfCapacity(pb.ticker, tier) * pb.count;
    }
  }
  return result;
});

// 使用 PLAN 磁贴的交易所设置获取价格
function getPlanPrice(ticker?: string | null): number | undefined {
  if (!ticker) {
    return undefined;
  }

  const upper = ticker.toUpperCase();
  const ignored = new Set(userData.settings.financial.ignoredMaterials.split(','));
  const mmMaterials = new Set(userData.settings.financial.mmMaterials.split(','));

  if (ignored.has(upper)) {
    return 0;
  }
  if (!cxStore.fetched) {
    return undefined;
  }

  const exchangeData = cxStore.prices.get(exchange.value);
  if (!exchangeData) {
    return undefined;
  }

  if (mmMaterials.has(upper)) {
    return exchangeData.get(ticker)?.MMBuy ?? 0;
  }

  const tickerInfo = exchangeData.get(ticker);
  if (!tickerInfo) {
    return 0;
  }

  const method = userData.settings.pricing.method;
  switch (method) {
    case 'ASK':
      return tickerInfo.Ask ?? 0;
    case 'BID':
      return tickerInfo.Bid ?? 0;
    case 'AVG':
      return tickerInfo.PriceAverage ?? 0;
    case 'VWAP7D':
      return tickerInfo.VWAP7D ?? 0;
    case 'VWAP30D':
      return tickerInfo.VWAP30D ?? 0;
    case 'DEFAULT':
      return (
        tickerInfo.VWAP7D ??
        tickerInfo.VWAP30D ??
        tickerInfo.PriceAverage ??
        tickerInfo.Ask ??
        tickerInfo.Bid ??
        0
      );
  }
  return undefined;
}

// 优先使用自定义价格，否则回退到交易所价格。
function getInputPrice(ticker: string): number | undefined {
  if (Object.hasOwn(customInputPrices.value, ticker)) {
    return customInputPrices.value[ticker];
  }
  return getPlanPrice(ticker);
}

function getOutputPrice(ticker: string): number | undefined {
  if (Object.hasOwn(customOutputPrices.value, ticker)) {
    return customOutputPrices.value[ticker];
  }
  return getPlanPrice(ticker);
}

function getWfPrice(ticker: string): number | undefined {
  if (Object.hasOwn(customWfPrices.value, ticker)) {
    return customWfPrices.value[ticker];
  }
  return getPlanPrice(ticker);
}

function onSetInputPrice(ticker: string, value: number) {
  customInputPrices.value = { ...customInputPrices.value, [ticker]: value };
}
function onResetInputPrice(ticker: string) {
  const copy = { ...customInputPrices.value };
  delete copy[ticker];
  customInputPrices.value = copy;
}
function onSetOutputPrice(ticker: string, value: number) {
  customOutputPrices.value = { ...customOutputPrices.value, [ticker]: value };
}
function onResetOutputPrice(ticker: string) {
  const copy = { ...customOutputPrices.value };
  delete copy[ticker];
  customOutputPrices.value = copy;
}
function onSetWfPrice(ticker: string, value: number) {
  customWfPrices.value = { ...customWfPrices.value, [ticker]: value };
}
function onResetWfPrice(ticker: string) {
  const copy = { ...customWfPrices.value };
  delete copy[ticker];
  customWfPrices.value = copy;
}

// 计算建筑的批次周期数据（PRUNplanner 模型：配方顺序执行）。
function calcBatchRuns(fb: FioBuilding, recipes: PlannedRecipe[], buildingCount: number) {
  const eff = getEfficiencyMultiplier(fb.Expertise);
  const effectiveRecipes = getEffectiveRecipes(fb);
  let totalBatchTime = 0;
  for (const r of recipes) {
    if (r.recipeIdx < 0 || r.recipeIdx >= effectiveRecipes.length) {
      continue;
    }
    const recipe = effectiveRecipes[r.recipeIdx];
    totalBatchTime += (recipe.DurationMs * r.count) / eff;
  }
  if (totalBatchTime === 0) {
    return undefined;
  }
  const batchRuns = (86400000 * buildingCount) / totalBatchTime;
  return { batchRuns, eff };
}

function calcDailyProfit(
  fb: FioBuilding,
  recipes: PlannedRecipe[],
  buildingCount: number,
): number | undefined {
  const batch = calcBatchRuns(fb, recipes, buildingCount);
  if (!batch) {
    return undefined;
  }

  const effectiveRecipes = getEffectiveRecipes(fb);
  let total = 0;
  for (const r of recipes) {
    if (r.recipeIdx < 0 || r.recipeIdx >= effectiveRecipes.length) {
      continue;
    }
    const recipe = effectiveRecipes[r.recipeIdx];
    let outputValue = 0;
    for (const out of recipe.Outputs) {
      if (!out.CommodityTicker) {
        continue;
      }
      const price = getOutputPrice(out.CommodityTicker);
      if (price === undefined) {
        return undefined;
      }
      outputValue += out.Amount * r.count * price;
    }
    let inputValue = 0;
    for (const inp of recipe.Inputs) {
      if (!inp.CommodityTicker) {
        continue;
      }
      const price = getInputPrice(inp.CommodityTicker);
      if (price === undefined) {
        return undefined;
      }
      inputValue += inp.Amount * r.count * price;
    }
    total += (outputValue - inputValue) * batch.batchRuns;
  }
  return total;
}

const dailyProfit = computed<number | undefined>(() => {
  let total = 0;
  for (const pb of buildings.value) {
    const migrated = migrateBuilding(pb);
    const fb = findFioBuilding(migrated.ticker);
    if (!fb || !isProductionBuilding(migrated.ticker)) {
      continue;
    }
    if (migrated.recipes.length === 0) {
      continue;
    }
    const profit = calcDailyProfit(fb, migrated.recipes, pb.count);
    if (profit === undefined) {
      return undefined;
    }
    total += profit;
  }
  return total;
});

// 每日消耗材料汇总
const dailyInputs = computed<Record<string, number>>(() => {
  const result: Record<string, number> = {};
  for (const pb of buildings.value) {
    const migrated = migrateBuilding(pb);
    const fb = findFioBuilding(migrated.ticker);
    if (!fb || !isProductionBuilding(migrated.ticker)) {
      continue;
    }

    const batch = calcBatchRuns(fb, migrated.recipes, pb.count);
    if (!batch) {
      continue;
    }

    const effectiveRecipes = getEffectiveRecipes(fb);
    for (const r of migrated.recipes) {
      if (r.recipeIdx < 0 || r.recipeIdx >= effectiveRecipes.length) {
        continue;
      }
      const recipe = effectiveRecipes[r.recipeIdx];
      for (const inp of recipe.Inputs) {
        if (!inp.CommodityTicker) {
          continue;
        }
        result[inp.CommodityTicker] =
          (result[inp.CommodityTicker] ?? 0) + inp.Amount * r.count * batch.batchRuns;
      }
    }
  }
  return result;
});

// 每日产出材料汇总
const dailyOutputs = computed<Record<string, number>>(() => {
  const result: Record<string, number> = {};
  for (const pb of buildings.value) {
    const migrated = migrateBuilding(pb);
    const fb = findFioBuilding(migrated.ticker);
    if (!fb || !isProductionBuilding(migrated.ticker)) {
      continue;
    }

    const batch = calcBatchRuns(fb, migrated.recipes, pb.count);
    if (!batch) {
      continue;
    }

    const effectiveRecipes = getEffectiveRecipes(fb);
    for (const r of migrated.recipes) {
      if (r.recipeIdx < 0 || r.recipeIdx >= effectiveRecipes.length) {
        continue;
      }
      const recipe = effectiveRecipes[r.recipeIdx];
      for (const out of recipe.Outputs) {
        if (!out.CommodityTicker) {
          continue;
        }
        result[out.CommodityTicker] =
          (result[out.CommodityTicker] ?? 0) + out.Amount * r.count * batch.batchRuns;
      }
    }
  }
  return result;
});

// 汇总所有建筑所需建材（基础 + 环境）。
const totalMaterials = computed<Record<string, number>>(() => {
  const result: Record<string, number> = {};
  for (const pb of buildings.value) {
    const fb = findFioBuilding(pb.ticker);
    if (!fb) {
      continue;
    }
    const count = pb.count;
    // 基础建材
    for (const cost of fb.BuildingCosts) {
      if (!cost.CommodityTicker) {
        continue;
      }
      result[cost.CommodityTicker] = (result[cost.CommodityTicker] ?? 0) + cost.Amount * count;
    }
    // 环境建材（根据星球环境和建筑面积计算）
    const envMats = getPlanetEnvMaterials(fb.AreaCost);
    for (const [ticker, amount] of Object.entries(envMats)) {
      result[ticker] = (result[ticker] ?? 0) + amount * count;
    }
  }
  return result;
});

// 排序后的消耗材料列表
const sortedInputs = computed(() => {
  const tickers = Object.keys(dailyInputs.value);
  const mats = tickers.map(t => materialsStore.getByTicker(t)).filter(m => m !== undefined);
  return sortMaterials(mats);
});

// 排序后的产出材料列表
const sortedOutputs = computed(() => {
  const tickers = Object.keys(dailyOutputs.value);
  const mats = tickers.map(t => materialsStore.getByTicker(t)).filter(m => m !== undefined);
  return sortMaterials(mats);
});

// 每日总成本（生产消耗 + 人口消耗品）
const dailyCost = computed<number | undefined>(() => {
  let total = 0;
  for (const [ticker, amount] of Object.entries(dailyInputs.value)) {
    const price = getInputPrice(ticker);
    if (price === undefined) {
      return undefined;
    }
    total += amount * price;
  }
  const wfCost = dailyWorkforceCost.value;
  if (wfCost === undefined) {
    return undefined;
  }
  total += wfCost;
  return total;
});

// 每日总收入
const dailyRevenue = computed<number | undefined>(() => {
  let total = 0;
  for (const [ticker, amount] of Object.entries(dailyOutputs.value)) {
    const price = getOutputPrice(ticker);
    if (price === undefined) {
      return undefined;
    }
    total += amount * price;
  }
  return total;
});

const wfTiers: WfTier[] = ['Pioneers', 'Settlers', 'Technicians', 'Engineers', 'Scientists'];

const wfTierNames: Record<WfTier, string> = {
  Pioneers: '先驱',
  Settlers: '定居者',
  Technicians: '技师',
  Engineers: '工程师',
  Scientists: '科学家',
};

// 每日人口消耗品汇总（按 FIO workforceneeds 数据，每100人/天换算，不足1个取整为1）。
const dailyWorkforceConsumption = computed<Record<string, number>>(() => {
  const needs = workforceNeedsStore.needs;
  if (!needs) {
    return {};
  }

  const wfCounts: Record<string, number> = {
    PIONEER: workforceNeeded.value.Pioneers,
    SETTLER: workforceNeeded.value.Settlers,
    TECHNICIAN: workforceNeeded.value.Technicians,
    ENGINEER: workforceNeeded.value.Engineers,
    SCIENTIST: workforceNeeded.value.Scientists,
  };

  const result: Record<string, number> = {};
  for (const tierNeeds of needs) {
    const count = wfCounts[tierNeeds.WorkforceType] ?? 0;
    if (count <= 0) {
      continue;
    }
    for (const need of tierNeeds.Needs) {
      const ticker = need.MaterialTicker;
      result[ticker] = (result[ticker] ?? 0) + (need.Amount * count) / 100;
    }
  }
  // 不足1个取整为1。
  for (const ticker of Object.keys(result)) {
    result[ticker] = Math.max(1, Math.ceil(result[ticker]));
  }
  return result;
});

const sortedWorkforceConsumption = computed(() => {
  const tickers = Object.keys(dailyWorkforceConsumption.value);
  const mats = tickers.map(t => materialsStore.getByTicker(t)).filter(m => m !== undefined);
  return sortMaterials(mats);
});

const dailyWorkforceCost = computed<number | undefined>(() => {
  let total = 0;
  for (const [ticker, amount] of Object.entries(dailyWorkforceConsumption.value)) {
    const price = getWfPrice(ticker);
    if (price === undefined) {
      return undefined;
    }
    total += amount * price;
  }
  return total;
});

// 规划中涉及的行业类别（去重，用于专家设置 UI）。
const activeExpertiseCategories = computed(() => {
  const cats = new Set<string>();
  for (const pb of buildings.value) {
    const fb = findFioBuilding(pb.ticker);
    if (fb?.Expertise) {
      cats.add(fb.Expertise);
    }
  }
  return EXPERTISE_CATEGORIES.filter(c => cats.has(c));
});

// 自动配平居住建筑：穷举搜索最小面积组合，支持复合住房。
function onAutoBalance() {
  const allFio = fioBuildingsStore.buildings;
  if (!allFio) {
    return;
  }

  // 先移除所有现有居住建筑，基于纯生产需求重新计算。
  const nonHabBuildings = buildings.value.filter(pb => !isHabitationBuilding(pb.ticker));
  // 临时计算无居住建筑时的劳动力需求。
  const needed = { Pioneers: 0, Settlers: 0, Technicians: 0, Engineers: 0, Scientists: 0 };
  for (const pb of nonHabBuildings) {
    const fb = findFioBuilding(pb.ticker);
    if (!fb || !isProductionBuilding(pb.ticker)) {
      continue;
    }
    needed.Pioneers += fb.Pioneers * pb.count;
    needed.Settlers += fb.Settlers * pb.count;
    needed.Technicians += fb.Technicians * pb.count;
    needed.Engineers += fb.Engineers * pb.count;
    needed.Scientists += fb.Scientists * pb.count;
  }

  // 当前缺口。
  const baseDeficit: Record<WfTier, number> = {} as Record<WfTier, number>;
  for (const tier of wfTiers) {
    baseDeficit[tier] = Math.max(0, needed[tier]);
  }
  if (wfTiers.every(t => baseDeficit[t] <= 0)) {
    // 无需任何居住建筑，移除现有的。
    buildings.value = nonHabBuildings;
    return;
  }

  // 收集所有居住建筑候选及其容量/面积。
  interface HabOption {
    ticker: string;
    caps: Record<WfTier, number>;
    area: number;
  }
  const options: HabOption[] = allFio
    .filter(
      fb => isHabitationBuilding(fb.Ticker) && wfTiers.some(t => getWfCapacity(fb.Ticker, t) > 0),
    )
    .map(fb => ({
      ticker: fb.Ticker,
      caps: Object.fromEntries(wfTiers.map(t => [t, getWfCapacity(fb.Ticker, t)])) as Record<
        WfTier,
        number
      >,
      area: fb.AreaCost,
    }));

  if (options.length === 0) {
    return;
  }

  // DFS 剪枝搜索最优解。
  // 只枚举实际有缺口层级涉及的建筑。
  const relevantOptions = options.filter(opt =>
    wfTiers.some(t => baseDeficit[t] > 0 && opt.caps[t] > 0),
  );

  // 贪心初解：每层独立取最优单层住房，得到上界面积。
  let bestArea = Infinity;
  let bestCounts: number[] = relevantOptions.map(() => 0);

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
      greedyCounts[bestIdx] += Math.ceil(rem[tier] / cap);
    }
    const greedyArea = greedyCounts.reduce((s, c, i) => s + c * relevantOptions[i].area, 0);
    if (greedyArea < bestArea) {
      bestArea = greedyArea;
      bestCounts = [...greedyCounts];
    }
  }

  const counts = relevantOptions.map(() => 0);

  function dfs(idx: number, rem: Record<WfTier, number>, usedArea: number) {
    // 剪枝：已超过当前最优。
    if (usedArea >= bestArea) {
      return;
    }
    // 满足条件。
    if (wfTiers.every(t => rem[t] <= 0)) {
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
    // 加一点余量防止剪枝过激，但限制最大搜索量。
    const maxTry = Math.min(maxNeeded + 1, Math.floor((bestArea - usedArea) / opt.area) + 1);

    for (let c = maxTry; c >= 0; c--) {
      counts[idx] = c;
      const newRem = { ...rem };
      for (const tier of wfTiers) {
        if (opt.caps[tier] > 0) {
          newRem[tier] = rem[tier] - opt.caps[tier] * c;
        }
      }
      dfs(idx + 1, newRem, usedArea + c * opt.area);
    }
    counts[idx] = 0;
  }

  dfs(0, { ...baseDeficit }, 0);

  // 转换结果。
  const additions: { ticker: string; count: number }[] = [];
  for (let i = 0; i < relevantOptions.length; i++) {
    if (bestCounts[i] > 0) {
      additions.push({ ticker: relevantOptions[i].ticker, count: bestCounts[i] });
    }
  }

  // 一次性替换居住建筑。
  if (additions.length === 0) {
    buildings.value = nonHabBuildings;
    return;
  }
  const newList = [...nonHabBuildings];
  for (const a of additions) {
    newList.push({ ticker: a.ticker, count: a.count, recipes: [] });
  }
  buildings.value = newList;
}

// 添加建筑到规划列表。
function onAddBuilding(ticker: string) {
  if (!ticker) {
    return;
  }
  const newList = [...buildings.value];
  newList.push({ ticker, count: 1, recipes: [] });
  buildings.value = newList;
  selectedTicker.value = '';
}

function onRemoveBuilding(idx: number) {
  const newList = [...buildings.value];
  newList.splice(idx, 1);
  buildings.value = newList;
}

// 非生产建筑（居住/仓储/核心）的数量修改。
function onNonProdCountChange(idx: number, value: number) {
  if (value === 0 || Number.isNaN(value) || value < 1) {
    return;
  }
  const newList = [...buildings.value];
  newList[idx] = { ...newList[idx], count: Math.max(1, value) };
  buildings.value = newList;
}

// 生产建筑总数量修改。
function onBuildingCountChange(idx: number, value: number) {
  if (value === 0 || Number.isNaN(value) || value < 1) {
    return;
  }
  const newList = [...buildings.value];
  newList[idx] = { ...newList[idx], count: Math.max(1, value) };
  buildings.value = newList;
}

// 添加一个配方条目到指定建筑行。
function onAddRecipe(idx: number) {
  const newList = [...buildings.value];
  const pb = migrateBuilding(newList[idx]);
  newList[idx] = { ...pb, recipes: [...pb.recipes, { recipeIdx: -1, count: 1 }] };
  buildings.value = newList;
}

// 删除指定建筑行中的某个配方条目。
function onRemoveRecipe(idx: number, rIdx: number) {
  const newList = [...buildings.value];
  const pb = migrateBuilding(newList[idx]);
  const newRecipes = pb.recipes.filter((_, i) => i !== rIdx);
  newList[idx] = { ...pb, recipes: newRecipes };
  buildings.value = newList;
}

function onRecipeCountChange(idx: number, rIdx: number, value: number | undefined) {
  if (value === undefined) {
    return;
  }
  const newList = [...buildings.value];
  const pb = migrateBuilding(newList[idx]);
  const newRecipes = pb.recipes.map((r, i) =>
    i === rIdx ? { ...r, count: Math.max(1, value) } : r,
  );
  newList[idx] = { ...pb, recipes: newRecipes };
  buildings.value = newList;
}

function onRecipeChange(idx: number, rIdx: number, value: string) {
  const newList = [...buildings.value];
  const pb = migrateBuilding(newList[idx]);
  const newRecipes = pb.recipes.map((r, i) =>
    i === rIdx ? { ...r, recipeIdx: parseInt(value, 10) } : r,
  );
  newList[idx] = { ...pb, recipes: newRecipes };
  buildings.value = newList;
}

// 生成建材采购 ACT 操作包。
function onGenerateAct() {
  const materials = totalMaterials.value;
  if (Object.keys(materials).length === 0) {
    return;
  }
  const pkgName = 'JIHUAJIANZHU';
  const pkg: UserData.ActionPackageData = {
    global: { name: pkgName },
    groups: [{ type: 'Manual', name: '建材', materials: { ...materials } }],
    actions: [
      {
        type: 'CX Buy',
        name: '采购建材',
        group: '建材',
        exchange: exchange.value !== configurableValue ? exchange.value : undefined,
        buyPartial: false,
        allowUnfilled: false,
        useCXInv: true,
      },
    ],
  };
  const existingIdx = userData.actionPackages.findIndex(x => x.global.name === pkgName);
  if (existingIdx >= 0) {
    userData.actionPackages[existingIdx] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }
  showBuffer(`XIT ACT GEN ${pkgName}`);
}

// 保存到 JH 计划列表。
function onSaveToJH(ev: Event) {
  showTileOverlay(ev, SavePlanOverlay, {
    initialName: userData.basePlans.find(p => p.id === jhPlanId.value)?.name ?? '',
    isExisting: !!jhPlanId.value && userData.basePlans.some(p => p.id === jhPlanId.value),
    onSave: (name: string, saveAsNew: boolean) => {
      const id = saveAsNew
        ? crypto.randomUUID()
        : (userData.basePlans.find(p => p.id === jhPlanId.value)?.id ?? crypto.randomUUID());
      jhPlanId.value = id;
      const plan: UserData.BasePlan = {
        id,
        name,
        savedAt: Date.now(),
        planet: planet.value,
        permits: permits.value,
        exchange: exchange.value,
        buildings: JSON.parse(JSON.stringify(buildings.value)),
        experts: { ...experts.value },
        cogcIndustry: cogcIndustry.value,
        customInputPrices: { ...customInputPrices.value },
        customOutputPrices: { ...customOutputPrices.value },
        customWfPrices: { ...customWfPrices.value },
      };
      const idx = userData.basePlans.findIndex(p => p.id === id);
      if (idx >= 0) {
        userData.basePlans[idx] = plan;
      } else {
        userData.basePlans.push(plan);
      }
    },
  });
}

// 按类型分组的建筑选项（不含行星项目等其他建筑）。
interface BuildingGroup {
  label: string;
  items: { ticker: string; displayName: string }[];
}

const buildingGroups = computed<BuildingGroup[]>(() => {
  const production: BuildingGroup['items'] = [];
  const habitation: BuildingGroup['items'] = [];
  const storage: BuildingGroup['items'] = [];
  for (const fb of allBuildings.value) {
    if (fb.Ticker === 'CM') {
      continue;
    }
    const item = {
      ticker: fb.Ticker,
      displayName: `${fb.Ticker} - ${getBuildingDisplayName(fb.Ticker)}`,
    };
    if (isProductionBuilding(fb.Ticker)) {
      production.push(item);
    } else if (isHabitationBuilding(fb.Ticker)) {
      habitation.push(item);
    } else if (isStorageBuilding(fb.Ticker)) {
      storage.push(item);
    }
    // 其他建筑（行星项目等）不显示在下拉中。
  }
  const groups: BuildingGroup[] = [];
  if (production.length > 0) {
    groups.push({ label: '生产建筑', items: production });
  }
  if (habitation.length > 0) {
    groups.push({ label: '居住建筑', items: habitation });
  }
  if (storage.length > 0) {
    groups.push({ label: '仓库', items: storage });
  }
  return groups;
});

const selectedTicker = ref('');

const planetSuggestions = computed(() => {
  const input = planet.value.trim().toLowerCase();
  if (!input || input.length < 1) {
    return [];
  }
  return (planetsStore.all.value ?? [])
    .filter(p => p.naturalId.toLowerCase().includes(input) || p.name.toLowerCase().includes(input))
    .slice(0, 20);
});

function addCoreIfMissing() {
  if (!buildings.value.find(x => x.ticker === 'CM')) {
    buildings.value = [{ ticker: 'CM', count: 1, recipes: [] }, ...buildings.value];
  }
}

watch(
  planet,
  newVal => {
    const matched = planetsStore.find(newVal.trim());
    if (matched) {
      addCoreIfMissing();
      fetchPlanetDetail(matched.naturalId);
    } else {
      planetEnv.value = undefined;
    }
  },
  { immediate: true },
);

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
function getEffectiveRecipes(fb: FioBuilding): FioRecipe[] {
  const ticker = fb.Ticker;
  const buildingForType = RESOURCE_TYPE_BUILDING;
  const matchingType = Object.entries(buildingForType).find(([, b]) => b === ticker)?.[0];
  if (!matchingType) {
    return fb.Recipes;
  }
  const env = planetEnv.value;
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

function recipeOptions(fb: FioBuilding) {
  return getEffectiveRecipes(fb).map((r, i) => ({
    label: r.RecipeName,
    value: String(i),
  }));
}

// 获取指定 recipeIdx 的产出材料列表。
function getRecipeOutputs(fb: FioBuilding, recipeIdx: number): FioRecipeIO[] {
  const recipes = getEffectiveRecipes(fb);
  if (recipeIdx < 0 || recipeIdx >= recipes.length) {
    return [];
  }
  return recipes[recipeIdx].Outputs.filter(out => out.CommodityTicker);
}

function rowProfitText(pb: PlannedBuilding): string {
  const fb = findFioBuilding(pb.ticker);
  if (!fb || !isProductionBuilding(pb.ticker)) {
    return '--';
  }
  const migrated = migrateBuilding(pb);
  if (migrated.recipes.length === 0) {
    return '--';
  }
  const profit = calcDailyProfit(fb, migrated.recipes, pb.count);
  if (profit === undefined) {
    return '?';
  }
  return formatCurrency(profit);
}

function wfOk(tier: WfTier): boolean {
  return workforceProvided.value[tier] >= workforceNeeded.value[tier];
}
</script>

<template>
  <div :class="$style.container">
    <!-- 加载状态 -->
    <div v-if="fioBuildingsStore.loading" :class="$style.status">载入中...</div>
    <div v-else-if="fioBuildingsStore.error" :class="$style.status">加载失败，无法连接 FIO。</div>

    <template v-else>
      <!-- 顶部参数行 -->
      <div :class="$style.paramRow">
        <Active label="星球">
          <input
            v-model="planet"
            type="text"
            placeholder="星球标识符或名称"
            list="bplan-planet-list"
            :class="$style.planetInput" />
          <datalist id="bplan-planet-list">
            <option v-for="p in planetSuggestions" :key="p.naturalId" :value="p.naturalId">
              {{ p.name }}
            </option>
          </datalist>
        </Active>
        <Active label="许可证">
          <NumberInput :model-value="permits" @update:model-value="v => (permits = v ?? 1)" />
        </Active>
        <span :class="$style.areaInfo">已用面积：{{ totalArea }} / {{ maxArea }}</span>
        <Active label="交易所">
          <SelectInput v-model="exchange" :options="exchangeOptions" />
        </Active>
        <PrunButton primary @click="onSaveToJH">保存到 JH</PrunButton>
      </div>

      <!-- 建筑列表 -->
      <div :class="$style.section">
        <div :class="$style.sectionHeader">
          <span
            >建筑列表 <span :class="$style.hint">（可多次添加同一建筑以使用不同配方）</span></span
          >
          <div :class="$style.addRow">
            <select v-model="selectedTicker" :class="$style.buildingSelect">
              <option value="">— 选择建筑 —</option>
              <optgroup v-for="group in buildingGroups" :key="group.label" :label="group.label">
                <option v-for="b in group.items" :key="b.ticker" :value="b.ticker">
                  {{ b.displayName }}
                </option>
              </optgroup>
            </select>
            <PrunButton primary :disabled="!selectedTicker" @click="onAddBuilding(selectedTicker)">
              + 添加
            </PrunButton>
          </div>
        </div>

        <!-- 表格头 -->
        <div v-if="buildings.length > 0" :class="$style.tableHeader">
          <span :class="$style.colTicker">建筑</span>
          <span :class="$style.colCount">数量</span>
          <span :class="$style.colRecipe">配方（槽数 × 配方）</span>
          <span :class="$style.colArea">面积</span>
          <span :class="$style.colProfit">每日利润</span>
          <span :class="$style.colDel"></span>
        </div>

        <!-- 建筑行 -->
        <div v-for="(pb, idx) in buildings" :key="idx" :class="$style.buildingRow">
          <span :class="$style.colTicker">{{ pb.ticker }}</span>
          <span :class="$style.colCount">
            <input
              type="number"
              min="1"
              :value="pb.count"
              :class="$style.countInput"
              @change="
                e =>
                  isProductionBuilding(pb.ticker)
                    ? onBuildingCountChange(idx, parseInt((e.target as HTMLInputElement).value, 10))
                    : onNonProdCountChange(idx, parseInt((e.target as HTMLInputElement).value, 10))
              " />
          </span>
          <span :class="$style.colRecipe">
            <template v-if="findFioBuilding(pb.ticker) && isProductionBuilding(pb.ticker)">
              <!-- 每个配方条目 -->
              <div
                v-for="(r, rIdx) in migrateBuilding(pb).recipes"
                :key="rIdx"
                :class="$style.recipeRow">
                <input
                  type="number"
                  min="1"
                  :value="r.count"
                  :class="[$style.slotInput, r.count > pb.count ? $style.slotWarn : '']"
                  @change="
                    e =>
                      onRecipeCountChange(
                        idx,
                        rIdx,
                        parseInt((e.target as HTMLInputElement).value, 10),
                      )
                  " />
                <select
                  :value="String(r.recipeIdx)"
                  :class="$style.recipeSelect"
                  @change="e => onRecipeChange(idx, rIdx, (e.target as HTMLSelectElement).value)">
                  <option value="-1">— 选择配方 —</option>
                  <option
                    v-for="opt in recipeOptions(findFioBuilding(pb.ticker)!)"
                    :key="opt.value"
                    :value="opt.value">
                    {{ opt.label }}
                  </option>
                </select>
                <span v-if="r.recipeIdx >= 0" :class="$style.recipeIcons">
                  <MaterialIcon
                    v-for="out in getRecipeOutputs(findFioBuilding(pb.ticker)!, r.recipeIdx)"
                    :key="out.CommodityTicker"
                    :ticker="out.CommodityTicker"
                    size="inline" />
                </span>
                <PrunButton danger inline @click="onRemoveRecipe(idx, rIdx)">✕</PrunButton>
              </div>
              <div :class="$style.recipeFooter">
                <PrunButton neutral inline @click="onAddRecipe(idx)">+ 配方</PrunButton>
                <span v-if="migrateBuilding(pb).recipes.length > 0" :class="$style.slotHint">
                  {{ migrateBuilding(pb).recipes.reduce((s, r) => s + r.count, 0) }}/{{ pb.count }}
                  槽
                </span>
              </div>
            </template>
            <template v-else>
              <span :class="$style.noRecipe">{{ buildingTypeLabel(pb.ticker) }}</span>
            </template>
          </span>
          <span :class="$style.colArea">
            {{ (findFioBuilding(pb.ticker)?.AreaCost ?? 0) * pb.count }}
          </span>
          <span :class="$style.colProfit">{{ rowProfitText(pb) }}</span>
          <span :class="$style.colDel">
            <PrunButton danger inline @click="onRemoveBuilding(idx)">✕</PrunButton>
          </span>
        </div>

        <div v-if="buildings.length === 0" :class="$style.empty"
          >暂无建筑，请从上方下拉列表添加。</div
        >
      </div>

      <!-- 自动配平 -->
      <div :class="$style.section">
        <PrunButton neutral @click="onAutoBalance">自动配平居住建筑</PrunButton>
      </div>

      <!-- 专家设置 -->
      <div v-if="activeExpertiseCategories.length > 0" :class="$style.section">
        <div :class="$style.sectionHeader">专家设置：</div>
        <div v-for="cat in activeExpertiseCategories" :key="cat" :class="$style.expertRow">
          <span :class="$style.expertLabel">{{ EXPERTISE_LABELS[cat] }}</span>
          <input
            type="number"
            min="0"
            max="5"
            :value="experts[cat] ?? 0"
            :class="$style.expertInput"
            @change="
              e => onExpertChange(cat, parseInt((e.target as HTMLInputElement).value, 10))
            " />
          <span :class="$style.expertBonus"
            >+{{ (EXPERT_BONUSES[Math.min(5, experts[cat] ?? 0)] * 100).toFixed(2) }}%</span
          >
        </div>
      </div>

      <!-- CoGC 项目 -->
      <div :class="$style.section">
        <Active label="CoGC 项目">
          <select v-model="cogcIndustry" :class="$style.cogcSelect">
            <option value="">— 无 —</option>
            <option v-for="cat in EXPERTISE_CATEGORIES" :key="cat" :value="cat">
              {{ EXPERTISE_LABELS[cat] }} (+25%)
            </option>
          </select>
        </Active>
      </div>

      <!-- 人口统计 -->
      <div :class="$style.section">
        <div :class="$style.wfRow">
          <span :class="$style.wfLabel">人口统计：</span>
          <span
            v-for="tier in wfTiers"
            :key="tier"
            :class="[$style.wfTier, wfOk(tier) ? $style.wfOk : $style.wfWarn]">
            {{ wfTierNames[tier] }}
            {{ workforceProvided[tier] }}/{{ workforceNeeded[tier] }}
            {{ wfOk(tier) ? '✓' : '⚠' }}
          </span>
        </div>
      </div>

      <!-- 每日总利润 -->
      <div :class="$style.section">
        <span :class="$style.profitLabel">每日总利润：</span>
        <span
          :class="[
            $style.profitValue,
            dailyProfit !== undefined && dailyProfit >= 0 ? $style.positive : $style.negative,
          ]">
          {{ dailyProfit !== undefined ? formatCurrency(dailyProfit) : '价格数据加载中...' }}
        </span>
      </div>

      <!-- 每日成本 -->
      <div :class="$style.section">
        <span :class="$style.profitLabel">每日成本：</span>
        <span :class="[$style.profitValue, $style.negative]">
          {{ dailyCost !== undefined ? formatCurrency(dailyCost) : '?' }}
        </span>
      </div>

      <!-- 每日收入 -->
      <div :class="$style.section">
        <span :class="$style.profitLabel">每日收入：</span>
        <span :class="[$style.profitValue, $style.positive]">
          {{ dailyRevenue !== undefined ? formatCurrency(dailyRevenue) : '?' }}
        </span>
      </div>

      <!-- 每日消耗 -->
      <div :class="$style.section">
        <div :class="$style.sectionHeaderRow">
          <span :class="$style.sectionHeader">每日消耗：</span>
          <PrunButton
            v-if="Object.keys(customInputPrices).length > 0"
            neutral
            inline
            @click="customInputPrices = {}"
            >↺ 还原全部</PrunButton
          >
        </div>
        <span v-if="sortedInputs.length === 0" :class="$style.empty">无</span>
        <div v-else :class="$style.priceTable">
          <div v-for="mat in sortedInputs" :key="mat.ticker" :class="$style.priceRow">
            <MaterialIcon :ticker="mat.ticker" size="inline" />
            <span :class="$style.materialAmount">{{ fixed2(dailyInputs[mat.ticker]) }}</span>
            <span :class="$style.priceX">×</span>
            <input
              type="number"
              min="0"
              :value="getInputPrice(mat.ticker) ?? 0"
              :class="[
                $style.priceInput,
                customInputPrices[mat.ticker] !== undefined ? $style.customPrice : '',
              ]"
              @change="
                e => onSetInputPrice(mat.ticker, parseFloat((e.target as HTMLInputElement).value))
              " />
            <span :class="$style.priceSubtotal"
              >=
              {{
                formatCurrency((getInputPrice(mat.ticker) ?? 0) * (dailyInputs[mat.ticker] ?? 0))
              }}</span
            >
            <PrunButton
              neutral
              inline
              :class="[
                $style.resetBtn,
                customInputPrices[mat.ticker] !== undefined ? $style.resetBtnActive : '',
              ]"
              @click="onResetInputPrice(mat.ticker)"
              >↺</PrunButton
            >
          </div>
        </div>
      </div>

      <!-- 每日产出 -->
      <div :class="$style.section">
        <div :class="$style.sectionHeaderRow">
          <span :class="$style.sectionHeader">每日产出：</span>
          <PrunButton
            v-if="Object.keys(customOutputPrices).length > 0"
            neutral
            inline
            @click="customOutputPrices = {}"
            >↺ 还原全部</PrunButton
          >
        </div>
        <span v-if="sortedOutputs.length === 0" :class="$style.empty">无</span>
        <div v-else :class="$style.priceTable">
          <div v-for="mat in sortedOutputs" :key="mat.ticker" :class="$style.priceRow">
            <MaterialIcon :ticker="mat.ticker" size="inline" />
            <span :class="$style.materialAmount">{{ fixed2(dailyOutputs[mat.ticker]) }}</span>
            <span :class="$style.priceX">×</span>
            <input
              type="number"
              min="0"
              :value="getOutputPrice(mat.ticker) ?? 0"
              :class="[
                $style.priceInput,
                customOutputPrices[mat.ticker] !== undefined ? $style.customPrice : '',
              ]"
              @change="
                e => onSetOutputPrice(mat.ticker, parseFloat((e.target as HTMLInputElement).value))
              " />
            <span :class="$style.priceSubtotal"
              >=
              {{
                formatCurrency((getOutputPrice(mat.ticker) ?? 0) * (dailyOutputs[mat.ticker] ?? 0))
              }}</span
            >
            <PrunButton
              neutral
              inline
              :class="[
                $style.resetBtn,
                customOutputPrices[mat.ticker] !== undefined ? $style.resetBtnActive : '',
              ]"
              @click="onResetOutputPrice(mat.ticker)"
              >↺</PrunButton
            >
          </div>
        </div>
      </div>

      <!-- 每日人口消耗品 -->
      <div :class="$style.section">
        <div :class="$style.sectionHeaderRow">
          <span :class="$style.sectionHeader">每日消耗品：</span>
          <PrunButton
            v-if="Object.keys(customWfPrices).length > 0"
            neutral
            inline
            @click="customWfPrices = {}"
            >↺ 还原全部</PrunButton
          >
        </div>
        <span v-if="sortedWorkforceConsumption.length === 0" :class="$style.empty">
          {{ workforceNeedsStore.fetched ? '无' : '加载中...' }}
        </span>
        <div v-else :class="$style.priceTable">
          <div v-for="mat in sortedWorkforceConsumption" :key="mat.ticker" :class="$style.priceRow">
            <MaterialIcon :ticker="mat.ticker" size="inline" />
            <span :class="$style.materialAmount">{{
              fixed2(dailyWorkforceConsumption[mat.ticker])
            }}</span>
            <span :class="$style.priceX">×</span>
            <input
              type="number"
              min="0"
              :value="getWfPrice(mat.ticker) ?? 0"
              :class="[
                $style.priceInput,
                customWfPrices[mat.ticker] !== undefined ? $style.customPrice : '',
              ]"
              @change="
                e => onSetWfPrice(mat.ticker, parseFloat((e.target as HTMLInputElement).value))
              " />
            <span :class="$style.priceSubtotal"
              >=
              {{
                formatCurrency(
                  (getWfPrice(mat.ticker) ?? 0) * (dailyWorkforceConsumption[mat.ticker] ?? 0),
                )
              }}</span
            >
            <PrunButton
              neutral
              inline
              :class="[
                $style.resetBtn,
                customWfPrices[mat.ticker] !== undefined ? $style.resetBtnActive : '',
              ]"
              @click="onResetWfPrice(mat.ticker)"
              >↺</PrunButton
            >
          </div>
        </div>
      </div>

      <!-- 所需建材 -->
      <div :class="$style.section">
        <span :class="$style.matLabel">所需建材：</span>
        <span v-if="Object.keys(totalMaterials).length === 0" :class="$style.empty">无</span>
        <span v-for="(amt, ticker) in totalMaterials" :key="ticker" :class="$style.matChip">
          {{ ticker }}×{{ amt }}
        </span>
      </div>

      <!-- 生成 ACT -->
      <div :class="$style.section">
        <PrunButton
          primary
          :disabled="Object.keys(totalMaterials).length === 0"
          @click="onGenerateAct">
          生成建材采购 ACT
        </PrunButton>
      </div>
    </template>
  </div>
</template>

<style module>
/* 统一暗色主题：所有表单元素与游戏风格一致 */
.container input,
.container select {
  background: rgba(14, 21, 28, 0.85);
  color: #bbb;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 2px;
  padding: 2px 4px;
  font-size: 11px;
}

.container input:focus,
.container select:focus {
  border-color: rgba(255, 200, 86, 0.5);
  outline: none;
}

.container {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px;
  font-size: 11px;
}

.status {
  padding: 8px;
  color: #aaa;
}

.paramRow {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}

.planetInput {
  width: 140px;
}

.areaInfo {
  white-space: nowrap;
  padding: 0 4px;
}

.section {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 4px;
}

.sectionHeader {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  gap: 4px;
}

.addRow {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tableHeader,
.buildingRow {
  display: grid;
  grid-template-columns: 50px 45px 1fr 50px 90px 30px;
  gap: 4px;
  align-items: start;
  width: 100%;
}

.tableHeader {
  font-weight: bold;
  opacity: 0.7;
}

.colTicker,
.colCount,
.colRecipe,
.colArea,
.colProfit,
.colDel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.countInput {
  width: 42px;
}

.slotInput {
  width: 36px;
}

.slotWarn {
  border-color: #ff9800 !important;
  color: #ff9800;
}

.recipeFooter {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}

.slotHint {
  font-size: 10px;
  opacity: 0.6;
}

.buildingSelect {
  width: 240px;
  font-size: 11px;
}

.recipeRow {
  display: flex;
  align-items: center;
  gap: 4px;
}

.recipeSelect {
  flex: 1;
  min-width: 0;
  font-size: 11px;
}

.recipeIcons {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.noRecipe {
  opacity: 0.5;
}

.expertRow {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}

.expertLabel {
  width: 80px;
  font-size: 11px;
}

.expertInput {
  width: 45px;
}

.expertBonus {
  font-size: 11px;
  color: #4caf50;
  min-width: 50px;
}

.cogcSelect {
  font-size: 11px;
}

.empty {
  opacity: 0.5;
  font-style: italic;
}

.wfRow {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.wfLabel {
  font-weight: bold;
}

.wfTier {
  white-space: nowrap;
}

.wfOk {
  color: #4caf50;
}

.wfWarn {
  color: #ff9800;
}

.profitLabel {
  font-weight: bold;
}

.positive {
  color: #4caf50;
}

.negative {
  color: #f44336;
}

.matLabel {
  font-weight: bold;
}

.matChip {
  background: rgba(255, 255, 255, 0.08);
  padding: 1px 5px;
  border-radius: 3px;
}

.materialItem {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-right: 6px;
}

.materialAmount {
  font-size: 10px;
}

.hint {
  font-size: 9px;
  opacity: 0.6;
  font-weight: normal;
}

.priceTable {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 2px;
}

.priceRow {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.priceX {
  opacity: 0.5;
  font-size: 10px;
}

.priceInput {
  width: 70px;
}

.customPrice {
  border-color: rgba(255, 200, 86, 0.6) !important;
}

.priceSubtotal {
  font-size: 10px;
  opacity: 0.8;
  min-width: 80px;
}

.resetBtn {
  opacity: 0.3;
  font-size: 11px;
}

.resetBtnActive {
  opacity: 1;
  color: #ffc856 !important;
  border-color: #ffc856 !important;
}

.sectionHeaderRow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 2px;
}
</style>
