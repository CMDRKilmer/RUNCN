<script setup lang="ts">
import { useId } from 'vue';
import ActionBar from '@src/components/ActionBar.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import PrunButton from '@src/components/PrunButton.vue';
import PrunLink from '@src/components/PrunLink.vue';
import RadioGroupContainer from '@src/components/RadioGroupContainer.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Tooltip from '@src/components/Tooltip.vue';
import Active from '@src/components/forms/Active.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import { calculatePlanetBurn } from '@src/core/burn';
import { EXPERTISE_LABELS } from '@src/core/experts';
import { cxStore } from '@src/infrastructure/fio/cx';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { companyStore } from '@src/infrastructure/prun-api/data/company';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { planetsStore } from '@src/infrastructure/prun-api/data/planets';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { request } from '@src/infrastructure/prun-api/data/request-hooks';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { workforcesStore } from '@src/infrastructure/prun-api/data/workforces';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { timestampEachMinute, timestampEachSecond } from '@src/utils/dayjs';
import { fixed2, percent2 } from '@src/utils/format';
import { watchUntil } from '@src/utils/watch';
import { fioBuildingsStore, loadFioBuildings } from '@src/features/XIT/PLAN/fio-buildings';
import { BUILDING_NAMES_ZH } from '@src/features/XIT/PLAN/building-names-zh';
import { collectPlanMaterials } from '@src/features/XIT/PLAN/plan-materials';
import {
  getActiveCogcProgram,
  getPlanetRecipes,
  loadPlanetEnvironment,
  type PlanetEnvironment,
} from '@src/features/XIT/PLAN/plan-planet';
import { wfTiers } from '@src/features/XIT/PLAN/plan-housing';
import { loadWorkforceNeeds, workforceNeedsStore } from '@src/features/XIT/PLAN/workforce-needs';
import {
  BASE_AREAS,
  DEFAULT_QUEUE_SLOTS,
  getIndustryProductionFees,
  getIndustryCandidates,
  getNewBaseFlows,
  getPurchaseChanges,
  getRecipeNetOutput,
  planIndustryBase,
  priceMaterials,
  summarizeIndustry,
  type IndustryTarget,
} from './industry-model';
import {
  allocateIndustryExperts,
  BASE_EXPERT_LIMIT,
  INDUSTRY_EXPERT_LIMIT,
} from './industry-efficiency';
import { optimizeIndustryQueue } from './industry-optimizer';
import { getIndustryQueues, runIndustryQueue } from './industry-queue';
import { estimateIndustryStorage, getIndustryWarehouses } from './industry-storage';
import $style from './IND.module.css';

const exchange = ref('IC1');
const selectedTickers = ref<string[]>([]);
const planning = ref(false);
const search = ref('');
const planet = ref('');
const permitLimit = ref('1');
const permitOptions = [
  { value: 'auto', label: `自动（最多 ${BASE_AREAS.length} 张）` },
  ...BASE_AREAS.slice(0, -1).map((area, index) => ({
    value: String(index + 1),
    label: `最多 ${index + 1} 张（面积 ${area}）`,
  })),
];
const maxPermits = computed(() =>
  permitLimit.value === 'auto' ? BASE_AREAS.length : Number(permitLimit.value),
);
const recipeKeys = reactive<Partial<Record<string, string>>>({});
const expertOverrides = reactive<Partial<Record<string, number>>>({});
const includeCogc = ref(true);
const corporateHq = ref(false);
const dailyTargets = reactive<Partial<Record<string, number>>>({});
const productionCounts = reactive<Partial<Record<string, number>>>({});
const manualQueueOrders = shallowRef(new Map<string, ReadonlyMap<string, number>>());
const warehouseCounts = reactive<Partial<Record<string, number>>>({});
const planetListId = useId();

const sites = computed(() => sitesStore.all.value ?? []);
const baseData = computed(() =>
  sites.value.map(site => ({
    site,
    name: getEntityNameFromAddress(site.address) ?? site.siteId.substring(0, 8),
    naturalId: getEntityNaturalIdFromAddress(site.address),
    production: productionStore.getLoadedBySiteId(site.siteId),
    workforce: workforcesStore.getLoadedById(site.siteId)?.workforces,
    storage: storagesStore.getByAddressableId(site.siteId)?.filter(s => s.type === 'STORE'),
  })),
);
const pendingBases = computed(() =>
  baseData.value.filter(x => x.production === undefined || x.workforce === undefined),
);
function loadBases() {
  void loadFioBuildings();
  for (const { site } of pendingBases.value) {
    request.production(site.siteId);
  }
}

const balances = computed(() =>
  summarizeIndustry(
    baseData.value.map(x => ({
      siteId: x.site.siteId,
      name: x.name,
      burn: calculatePlanetBurn(x.production, x.workforce, x.storage),
      hasStorage: (x.storage?.length ?? 0) > 0,
    })),
  ),
);
const options = ['IC1', 'AI1', 'NC1', 'CI1', 'NC2', 'CI2'];
const standalonePriceModes = [
  { value: 'VWAP7D', label: '7 天', tooltip: '按 7 日加权均价估值，缺价物料用 30 日均价' },
  { value: 'VWAP30D', label: '30 天', tooltip: '按 30 日加权均价估值' },
  { value: 'live', label: '实时', tooltip: '点击刷新游戏订单簿，按卖一买入、买一卖出' },
] as const;
type StandalonePriceMode = (typeof standalonePriceModes)[number]['value'];
const standalonePriceMode = ref<StandalonePriceMode>('VWAP30D');
const liveQuoteBaselines = shallowRef(new Map<string, PrunApi.CXBroker | undefined>());
const loadingLiveQuotes = ref(false);
const currency = computed(() => exchangesStore.getByCode(exchange.value)?.currency.code);
const quotes = computed(() => cxStore.prices?.get(exchange.value));
function readQuote(price: number | null | undefined) {
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : undefined;
}
function getAsk(material: string) {
  return readQuote(quotes.value?.get(material)?.Ask);
}
function getFreshLiveBook(key: string) {
  const baselines = liveQuoteBaselines.value;
  const book = cxobStore.getByTicker(key);
  return baselines.has(key) && book !== baselines.get(key) ? book : undefined;
}
function getStandalonePrice(ticker: string, side: 'ask' | 'bid') {
  const mode = standalonePriceMode.value;
  if (mode === 'live') {
    const book = getFreshLiveBook(`${ticker}.${exchange.value}`);
    return readQuote(book?.[side]?.price.amount);
  }
  const quote = quotes.value?.get(ticker);
  return readQuote(quote?.[mode]) ?? (mode === 'VWAP7D' ? readQuote(quote?.VWAP30D) : undefined);
}
function getStandaloneBuy(ticker: string) {
  return getStandalonePrice(ticker, 'ask');
}
function money(value: number | undefined) {
  return value === undefined ? '待核算' : [fixed2(value), currency.value].filter(Boolean).join(' ');
}

const candidates = computed(() =>
  getIndustryCandidates(balances.value)
    .map(x => {
      const ask = getAsk(x.ticker);
      return { ...x, cost: ask === undefined ? undefined : x.deficit * ask };
    })
    .sort((a, b) => {
      const costDifference = (b.cost ?? -1) - (a.cost ?? -1);
      return costDifference !== 0 ? costDifference : b.deficit - a.deficit;
    }),
);
const filteredCandidates = computed(() => {
  const query = search.value.trim().toUpperCase();
  return candidates.value.filter(x => x.ticker.includes(query));
});
const selectedSet = computed(() => new Set(selectedTickers.value));
const selected = computed(() => {
  const byTicker = new Map(candidates.value.map(item => [item.ticker, item]));
  return selectedTickers.value.flatMap(ticker => {
    const item = byTicker.get(ticker);
    return item === undefined ? [] : [item];
  });
});

function selectMaterial(ticker: string, checked: boolean) {
  if (checked && !selectedSet.value.has(ticker)) {
    selectedTickers.value = [...selectedTickers.value, ticker];
  } else if (!checked) {
    selectedTickers.value = selectedTickers.value.filter(x => x !== ticker);
  }
}

function loadCatalog() {
  void loadFioBuildings();
  void loadWorkforceNeeds();
}

function openPlan(ticker?: string) {
  if (ticker !== undefined) {
    selectMaterial(ticker, true);
  }
  planning.value = true;
  loadCatalog();
}

const planetSuggestions = computed(() => {
  const query = planet.value.trim().toUpperCase();
  if (query === '') {
    return [];
  }
  return (planetsStore.all.value ?? [])
    .filter(x => x.naturalId.toUpperCase().includes(query) || x.name.toUpperCase().includes(query))
    .slice(0, 20);
});
const candidatePlanet = computed(() => planetsStore.find(planet.value.trim()));
watch(
  () => candidatePlanet.value?.naturalId,
  () => {
    corporateHq.value = false;
    manualQueueOrders.value = new Map();
  },
);
const alreadyOwned = computed(
  () =>
    candidatePlanet.value !== undefined &&
    sitesStore.getByPlanetNaturalId(candidatePlanet.value.naturalId) !== undefined,
);
const planetLoading = ref(false);
const planetResult = shallowRef<{ id: string; environment: PlanetEnvironment | undefined }>();
const hq = computed(() => companyStore.value?.headquarters);
const queueSlots = computed(() => {
  const extra = hq.value?.additionalProductionQueueSlots ?? 0;
  return DEFAULT_QUEUE_SLOTS + (Number.isSafeInteger(extra) && extra > 0 ? extra : 0);
});
const hqId = computed(() => getEntityNaturalIdFromAddress(hq.value?.address));
const hqPlanet = shallowRef<{ id: string; faction: string | null | undefined }>();
const companyHq = computed(() => {
  const current = hq.value;
  const location = hqPlanet.value;
  if (
    current === undefined ||
    location === undefined ||
    location.id !== hqId.value ||
    location.faction === undefined ||
    !Number.isFinite(current.basePermits) ||
    current.basePermits <= 0 ||
    !Number.isFinite(current.usedBasePermits) ||
    current.usedBasePermits < 0
  ) {
    return undefined;
  }
  return {
    faction: location.faction,
    usedPermits: current.usedBasePermits,
    totalPermits: current.basePermits,
  };
});
const environment = computed(() =>
  planetResult.value?.id === candidatePlanet.value?.naturalId
    ? planetResult.value?.environment
    : undefined,
);
async function loadPlanet() {
  const candidate = candidatePlanet.value;
  if (candidate === undefined || alreadyOwned.value || planetLoading.value) {
    return;
  }
  planetLoading.value = true;
  try {
    const headquarters = hqId.value;
    const [result, headquartersEnv] = await Promise.all([
      loadPlanetEnvironment(candidate.naturalId, true),
      headquarters === undefined ? undefined : loadPlanetEnvironment(headquarters),
    ]);
    planetResult.value = { id: candidate.naturalId, environment: result };
    hqPlanet.value =
      headquarters === undefined
        ? undefined
        : { id: headquarters, faction: headquartersEnv?.factionCode };
  } finally {
    planetLoading.value = false;
  }
}

const catalog = computed(() => fioBuildingsStore.buildings ?? []);
const warehouses = computed(() => getIndustryWarehouses(catalog.value, warehouseCounts));
const fixedArea = computed(
  () => (catalog.value.find(x => x.Ticker === 'CM')?.AreaCost ?? 0) + warehouses.value.area,
);
const warehousesExceedLimit = computed(
  () => warehouses.value.area > 0 && fixedArea.value >= BASE_AREAS[maxPermits.value - 1],
);
const materialIndustries = computed(() => {
  const industries = new Map<string, Set<string>>();
  for (const building of catalog.value) {
    const industry = building.Expertise;
    if (industry === null) {
      continue;
    }
    for (const recipe of building.Recipes) {
      for (const output of recipe.Outputs) {
        const ticker = output.CommodityTicker;
        if (ticker !== '' && getRecipeNetOutput(recipe, ticker) > 0) {
          const matches = industries.get(ticker) ?? new Set<string>();
          matches.add(industry);
          industries.set(ticker, matches);
        }
      }
    }
  }
  return industries;
});
function expertiseLabel(industry: string) {
  return EXPERTISE_LABELS[industry] ?? industry;
}
function materialCogc(ticker: string) {
  const industries = new Set(materialIndustries.value.get(ticker));
  if (materialsStore.getByTicker(ticker)?.resource === true) {
    industries.add('RESOURCE_EXTRACTION');
  }
  if (industries.size > 0) {
    return [...industries].map(expertiseLabel).join('、');
  }
  return fioBuildingsStore.buildings === undefined ? '待载入配方' : '—';
}
const nativeOptions = computed(() => {
  const byTicker = new Map<string, PrunApi.BuildOption>();
  for (const site of sites.value) {
    for (const option of site.buildOptions.options) {
      if (!byTicker.has(option.ticker)) {
        byTicker.set(option.ticker, option);
      }
    }
  }
  return byTicker;
});
const recipes = computed(() => {
  const env = environment.value;
  if (env === undefined) {
    return [];
  }
  return catalog.value.flatMap(building => {
    const farm = building.Ticker === 'FRM' || building.Ticker === 'ORC';
    if (farm && (env.fertility === undefined || env.fertility <= -1)) {
      return [];
    }
    const fertility = farm ? 1 + (env.fertility! * 10) / 33 : 1;
    return getPlanetRecipes(building, env).flatMap((recipe, recipeIdx) =>
      recipe.DurationMs > 0 && recipe.Outputs.some(x => x.CommodityTicker && x.Amount > 0)
        ? [
            {
              value: `${building.Ticker}:${recipeIdx}`,
              label: `${building.Ticker} · ${recipe.RecipeName}`,
              building,
              recipe,
              fertility,
            },
          ]
        : [],
    );
  });
});
const materialPlans = computed(() =>
  selected.value.map(item => {
    const options = recipes.value.filter(x => getRecipeNetOutput(x.recipe, item.ticker) > 0);
    return {
      ...item,
      options,
      choice: options.find(x => x.value === recipeKeys[item.ticker]) ?? options.at(0),
      dailyTarget: dailyTargets[item.ticker] ?? item.deficit,
    };
  }),
);
const productionTypes = computed(() => [
  ...new Set(materialPlans.value.flatMap(x => (x.choice ? [x.choice.building.Ticker] : []))),
]);
const invalidProductionCounts = computed(() =>
  productionTypes.value.some(ticker => {
    const count = productionCounts[ticker];
    return count !== undefined && (!Number.isSafeInteger(count) || count < 0);
  }),
);
const activeCogc = computed(() => {
  const env = environment.value;
  return env === undefined ? undefined : getActiveCogcProgram(env, timestampEachMinute.value);
});
const industries = computed(() => {
  const result = new Set<string>();
  for (const item of materialPlans.value) {
    const industry = item.choice?.building.Expertise;
    if (industry !== undefined && industry !== null) {
      result.add(industry);
    }
  }
  return result;
});
const expertCounts = computed(() => allocateIndustryExperts(industries.value, expertOverrides));
const totalExperts = computed(() => [...expertCounts.value.values()].reduce((a, b) => a + b, 0));
function expertOptions(count: number) {
  const limit = Math.min(INDUSTRY_EXPERT_LIMIT, BASE_EXPERT_LIMIT - totalExperts.value + count);
  return Array.from({ length: limit + 1 }, (_, index) => String(index));
}

const requestedPlan = computed(() => {
  const targets: IndustryTarget[] = [];
  for (const { ticker, dailyTarget, choice } of materialPlans.value) {
    if (choice === undefined) {
      return undefined;
    }
    targets.push({ ticker, dailyTarget, choice });
  }
  return planIndustryBase(
    targets,
    catalog.value,
    nativeOptions.value,
    {
      cogcProgram: includeCogc.value ? activeCogc.value : undefined,
      corporateHq: corporateHq.value,
      companyHq: companyHq.value,
    },
    expertCounts.value,
    maxPermits.value,
    warehouses.value,
    productionCounts,
    queueSlots.value,
    ticker =>
      priceMaterials(
        collectPlanMaterials({ buildings: [{ ticker, count: 1 }] }, environment.value),
        getAsk,
      ).value,
  );
});
const fixedLayout = computed(
  () => requestedPlan.value?.layout ?? requestedPlan.value?.overflow?.layout,
);
const optimization = shallowRef<Awaited<ReturnType<typeof optimizeIndustryQueue>>>();
const optimizationReasons = {
  area: '原方案建筑面积超限。',
  capacity: '原目标超过固定生产线的产能。',
  queue: '所选配方超出循环队列槽位。',
};
const optimizing = ref(false);
watch(
  [
    planning,
    requestedPlan,
    balances,
    quotes,
    environment,
    currency,
    () => workforceNeedsStore.needs,
  ],
  async ([open, requested, balanceSnapshot, quoteSnapshot, env, code, needs], _, onCleanup) => {
    optimization.value = undefined;
    optimizing.value = false;
    if (
      !open ||
      requested?.overflow === undefined ||
      needs === undefined ||
      env === undefined ||
      warehousesExceedLimit.value
    ) {
      return;
    }
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    const getPrice = (ticker: string) => readQuote(quoteSnapshot?.get(ticker)?.Ask);
    optimizing.value = true;
    try {
      const result = await optimizeIndustryQueue(
        requested,
        {
          balances: balanceSnapshot,
          needs,
          rules: env.productionFees,
          currency: code,
          getPrice,
        },
        controller.signal,
      );
      if (!controller.signal.aborted) {
        optimization.value = result;
      }
    } finally {
      if (!controller.signal.aborted) {
        optimizing.value = false;
      }
    }
  },
);
const automaticPlan = computed(() => {
  const result = optimization.value;
  return result?.status === 'optimized' || result?.status === 'estimated'
    ? result.plan
    : requestedPlan.value;
});
const queuePreview = computed(() => {
  const automatic = automaticPlan.value;
  const requested = requestedPlan.value;
  return automatic === undefined || requested === undefined
    ? []
    : getIndustryQueues(automatic, requested.lines, manualQueueOrders.value);
});
const hasManualQueues = computed(() => queuePreview.value.some(queue => queue.manual));
const plan = computed(() => {
  const automatic = automaticPlan.value;
  const layout = fixedLayout.value;
  if (automatic === undefined || layout === undefined || !hasManualQueues.value) {
    return automatic;
  }
  const lines = queuePreview.value.flatMap(queue =>
    runIndustryQueue(
      queue.recipes.map(recipe => recipe.line),
      queue.recipes.map(recipe => recipe.orders),
      queue.count,
      true,
    ),
  );
  return { ...automatic, layout, lines };
});

function editQueueOrder(ticker: string, recipeKey: string, orders: number | undefined) {
  const queue = queuePreview.value.find(queue => queue.ticker === ticker);
  const recipe = queue?.recipes.find(recipe => recipe.line.value === recipeKey);
  if (
    queue === undefined ||
    recipe === undefined ||
    orders === undefined ||
    !Number.isSafeInteger(orders) ||
    orders < 0 ||
    orders === recipe.orders
  ) {
    return;
  }
  const overrides = new Map(manualQueueOrders.value);
  overrides.set(
    ticker,
    new Map(
      queue.recipes.map(recipe => [
        recipe.line.value,
        recipe.line.value === recipeKey ? orders : recipe.orders,
      ]),
    ),
  );
  manualQueueOrders.value = overrides;
}

function resetQueueOrders(ticker: string) {
  const overrides = new Map(manualQueueOrders.value);
  overrides.delete(ticker);
  manualQueueOrders.value = overrides;
}

const newBaseFlows = computed(() => {
  const current = plan.value;
  const needs = workforceNeedsStore.needs;
  if (current?.layout === undefined || needs === undefined) {
    return undefined;
  }
  return getNewBaseFlows(current.lines, current.workforce, needs);
});
const purchaseChanges = computed(() => {
  const flows = newBaseFlows.value;
  return flows === undefined ? undefined : getPurchaseChanges(balances.value, flows);
});
const storageCycle = computed(() => {
  const flows = newBaseFlows.value;
  return flows === undefined
    ? undefined
    : estimateIndustryStorage(warehouses.value.capacity, flows, materialsStore.getByTicker);
});
function formatStorageCycle(
  cycle: NonNullable<ReturnType<typeof estimateIndustryStorage>>['fill'] | undefined,
) {
  if (cycle === undefined) {
    return '待核算';
  }
  if (!Number.isFinite(cycle.days)) {
    return '不受容量限制';
  }
  return `${fixed2(cycle.days)} 天（${cycle.limiting === 'weight' ? '重量' : '体积'}限制）`;
}
const materialResults = computed(() => {
  const current = plan.value;
  if (current === undefined) {
    return [];
  }
  const lines = new Map(current.lines.map(x => [x.value, x] as const));
  const recipeFlows = getNewBaseFlows(current.lines, current.workforce, []);
  const purchases = new Map(purchaseChanges.value?.map(x => [x.ticker, x] as const));
  return materialPlans.value.map(item => {
    const line = lines.get(item.choice?.value ?? '');
    const amount = line === undefined ? 0 : getRecipeNetOutput(line.recipe, item.ticker);
    const purchase =
      purchases.get(item.ticker) ??
      (purchaseChanges.value === undefined ? undefined : { after: item.deficit, surplus: 0 });
    return {
      ticker: item.ticker,
      dailyTarget: item.dailyTarget,
      line,
      production: 0 - (recipeFlows.get(item.ticker) ?? 0),
      perBuilding: line === undefined ? undefined : amount * line.batchesPerBuilding,
      purchase,
    };
  });
});
function efficiencyTooltip(
  efficiency: NonNullable<typeof plan.value>['lines'][number]['efficiency'],
) {
  const hq = companyHq.value === undefined ? '待载入' : percent2(efficiency.companyHq - 1);
  return `肥力 ${percent2(efficiency.fertility - 1)} · 公司总部 ${hq} · CoGC ${percent2(efficiency.cogc - 1)} · 专家 ${percent2(efficiency.experts - 1)} · 集团总部 ${percent2(efficiency.corporateHq - 1)}`;
}
const changedPurchases = computed(() =>
  purchaseChanges.value?.filter(x => Math.abs(x.change) >= 1e-8),
);
const procurement = computed(() => {
  const changes = purchaseChanges.value;
  return changes === undefined
    ? undefined
    : priceMaterials(
        changes.map(x => [x.ticker, x.change]),
        getAsk,
      );
});
const standaloneTradeCost = computed(() => {
  const flows = newBaseFlows.value;
  return flows === undefined
    ? undefined
    : priceMaterials(flows, (ticker, amount) =>
        getStandalonePrice(ticker, amount > 0 ? 'ask' : 'bid'),
      );
});
const constructionMaterials = computed(() => {
  const layout = plan.value?.layout;
  return layout === undefined ? undefined : collectPlanMaterials(layout, environment.value);
});
const maintenanceMaterials = computed(() => {
  const production = plan.value?.layout?.production;
  return production === undefined
    ? undefined
    : collectPlanMaterials({ buildings: production }, environment.value);
});
const standaloneQuoteTickers = computed(
  () =>
    new Set(
      [...(constructionMaterials.value ?? []), ...(newBaseFlows.value ?? [])]
        .filter(([, amount]) => Math.abs(amount) >= 1e-8)
        .map(([ticker]) => ticker),
    ),
);
const standaloneFallbackTickers = computed(() => {
  if (standalonePriceMode.value !== 'VWAP7D') {
    return [];
  }
  return [...standaloneQuoteTickers.value].filter(ticker => {
    const quote = quotes.value?.get(ticker);
    return readQuote(quote?.VWAP7D) === undefined && readQuote(quote?.VWAP30D) !== undefined;
  });
});
async function selectStandalonePriceMode(mode: StandalonePriceMode) {
  standalonePriceMode.value = mode;
  if (mode !== 'live' || loadingLiveQuotes.value) {
    return;
  }
  const keys = [...standaloneQuoteTickers.value].map(ticker => `${ticker}.${exchange.value}`);
  liveQuoteBaselines.value = new Map(keys.map(key => [key, cxobStore.getByTicker(key)]));
  loadingLiveQuotes.value = true;
  const deadline = Date.now() + 20_000;
  const expired = computed(() => timestampEachSecond.value >= deadline);
  try {
    await Promise.allSettled(
      keys.map(key =>
        showBuffer(`CXOB ${key}`, {
          force: true,
          autoClose: true,
          closeWhen: computed(() => expired.value || getFreshLiveBook(key) !== undefined),
        }),
      ),
    );
    await watchUntil(() => expired.value || keys.every(key => getFreshLiveBook(key) !== undefined));
  } finally {
    loadingLiveQuotes.value = false;
  }
}
function estimateMaterials(
  materials: Map<string, number> | undefined,
  getPrice: (ticker: string) => number | undefined,
) {
  return materials === undefined ? undefined : priceMaterials(materials, getPrice);
}
const construction = computed(() => estimateMaterials(constructionMaterials.value, getAsk));
const standaloneConstruction = computed(() =>
  estimateMaterials(constructionMaterials.value, getStandaloneBuy),
);
const missingQuotes = computed(() => [
  ...new Set([
    ...(procurement.value?.missing ?? []),
    ...(standaloneTradeCost.value?.missing ?? []),
    ...(construction.value?.missing ?? []),
    ...(standaloneConstruction.value?.missing ?? []),
  ]),
]);
function dailyMaintenance(getPrice: (ticker: string) => number | undefined) {
  const buildValue = estimateMaterials(maintenanceMaterials.value, getPrice)?.value;
  return buildValue === undefined ? undefined : buildValue / 180;
}
const maintenance = computed(() => dailyMaintenance(getAsk));
const standaloneMaintenance = computed(() => dailyMaintenance(getStandaloneBuy));
const productionFees = computed(() => {
  const current = plan.value;
  return current?.layout === undefined
    ? undefined
    : getIndustryProductionFees(current.lines, environment.value?.productionFees);
});
const productionFeeText = computed(() => {
  const fees = productionFees.value;
  if (fees === undefined) {
    return '待核算';
  }
  return fees.size === 0
    ? money(0)
    : [...fees].map(([code, amount]) => `${fixed2(amount)} ${code}`).join(' + ');
});
const feeCurrencyMismatch = computed(() =>
  [...(productionFees.value?.keys() ?? [])].some(code => code !== currency.value),
);
function netAfterOperatingCosts(tradeCost: number | undefined, repair: number | undefined) {
  const fees = productionFees.value;
  if (
    tradeCost === undefined ||
    repair === undefined ||
    fees === undefined ||
    feeCurrencyMismatch.value
  ) {
    return undefined;
  }
  const fee = currency.value === undefined ? 0 : (fees.get(currency.value) ?? 0);
  return -tradeCost - repair - fee;
}
const netSavings = computed(() =>
  netAfterOperatingCosts(procurement.value?.value, maintenance.value),
);
const standaloneProfit = computed(() =>
  netAfterOperatingCosts(standaloneTradeCost.value?.value, standaloneMaintenance.value),
);

function formatPayback(
  dailyBenefit: number | undefined,
  buildCost: number | undefined,
  nonPositiveLabel: string,
) {
  if (dailyBenefit === undefined) {
    return '待核算';
  }
  if (dailyBenefit <= 0) {
    return nonPositiveLabel;
  }
  return buildCost === undefined ? '待核算' : fixed2(buildCost / dailyBenefit);
}
</script>

<template>
  <div>
    <ActionBar v-if="planning">
      <PrunButton dark @click="planning = false">返回原料列表</PrunButton>
    </ActionBar>
    <SectionHeader v-if="planning"> 新基地试算 · {{ selected.length }} 种原料 </SectionHeader>
    <SectionHeader v-else>全公司 · {{ sites.length }} 个基地</SectionHeader>
    <div :class="$style.fields">
      <Active label="交易所">
        <SelectInput v-model="exchange" :options="options" :width="80" />
      </Active>
      <Active v-if="!planning" label="搜索原料代码">
        <TextInput v-model="search" type="search" />
      </Active>
    </div>
    <LoadingSpinner v-if="!sitesStore.fetched.value" />
    <div v-else-if="pendingBases.length > 0">
      <p>还有 {{ pendingBases.length }} 个基地的生产或用工数据待载入。</p>
      <ActionBar>
        <PrunButton primary @click="loadBases">载入全部基地数据</PrunButton>
      </ActionBar>
      <p v-for="base in pendingBases" :key="base.site.siteId">
        <PrunLink inline :command="`BS ${base.naturalId ?? base.name}`">{{ base.name }}</PrunLink>
      </p>
    </div>
    <template v-else>
      <template v-if="!planning">
        <ActionBar>
          <PrunButton primary :disabled="selected.length === 0" @click="openPlan()">
            规划选中原料（{{ selected.length }}）
          </PrunButton>
          <PrunButton
            v-if="!fioBuildingsStore.buildings"
            dark
            :disabled="fioBuildingsStore.loading"
            @click="loadFioBuildings">
            {{ fioBuildingsStore.loading ? '载入中…' : '载入配方与 CoGC' }}
          </PrunButton>
        </ActionBar>
        <p :class="[C.type.typeSmall, $style.note]"
          >按当前生产队列折算。全公司缺口假设基地余量可调拨，采购额按
          {{ exchange }} 最低卖价估算。</p
        >
        <p v-if="filteredCandidates.length === 0" :class="$style.note">暂无符合条件的原料缺口。</p>
        <table v-else :class="$style.amountTable">
          <thead>
            <tr>
              <th>选择</th>
              <th :class="$style.textCell">原料</th>
              <th :class="$style.textCell">CoGC 行业</th>
              <th>日需求</th><th>已有日产</th><th>日缺口</th><th>预计日采购额</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filteredCandidates" :key="item.ticker">
              <td>
                <RadioItem
                  :model-value="selectedSet.has(item.ticker)"
                  :aria-checked="selectedSet.has(item.ticker)"
                  :aria-label="`选择 ${item.ticker}`"
                  role="checkbox"
                  tabindex="0"
                  horizontal
                  @update:model-value="selectMaterial(item.ticker, $event)"
                  @keydown.space.prevent="
                    selectMaterial(item.ticker, !selectedSet.has(item.ticker))
                  ">
                  {{ selectedSet.has(item.ticker) ? '已选' : '选择' }}
                </RadioItem>
              </td>
              <td :class="$style.textCell"
                ><MaterialIcon :ticker="item.ticker" size="inline-table"
              /></td>
              <td :class="$style.textCell">{{ materialCogc(item.ticker) }}</td>
              <td>{{ fixed2(item.demand) }}</td>
              <td>{{ fixed2(item.output) }}</td>
              <td>{{ fixed2(item.deficit) }}</td>
              <td>{{ money(item.cost) }}</td>
              <td><PrunButton dark inline @click="openPlan(item.ticker)">试算</PrunButton></td>
            </tr>
          </tbody>
        </table>
      </template>

      <p v-else-if="selected.length === 0" :class="$style.note"
        >选中的原料已无日缺口。请返回原料列表重新选择。</p
      >
      <section v-else>
        <details v-for="item in selected" :key="item.ticker">
          <summary :class="[C.SectionHeader.container, C.fonts.fontRegular, $style.summary]"
            >{{ item.ticker }} · 各基地日用量与库存</summary
          >
          <table :class="$style.amountTable">
            <thead
              ><tr
                ><th>基地</th><th>日需求</th><th>日产出</th><th>本地日缺口</th><th>库存</th
                ><th>库存可用天数</th></tr
              ></thead
            >
            <tbody>
              <tr v-for="base in item.bases" :key="base.siteId">
                <td
                  ><PrunLink inline :command="`PROD ${base.siteId.substring(0, 8)}`">{{
                    base.name
                  }}</PrunLink></td
                >
                <td>{{ fixed2(base.demand) }}</td>
                <td>{{ fixed2(base.output) }}</td>
                <td>{{ fixed2(base.deficit) }}</td>
                <td>{{ base.inventory === undefined ? '待载入' : fixed2(base.inventory) }}</td>
                <td>{{
                  base.inventory !== undefined && base.deficit >= 0.005
                    ? fixed2(base.inventory / base.deficit)
                    : '—'
                }}</td>
              </tr>
            </tbody>
          </table>
        </details>
        <div :class="$style.fields">
          <Active label="候选星球" tooltip="输入星球代码或名称">
            <TextInput v-model="planet" :list="planetListId" />
          </Active>
          <datalist :id="planetListId">
            <option v-for="p in planetSuggestions" :key="p.naturalId" :value="p.naturalId">{{
              p.name
            }}</option>
          </datalist>
          <PrunButton
            primary
            :disabled="
              !candidatePlanet || alreadyOwned || planetLoading || !materialsStore.fetched.value
            "
            @click="loadPlanet">
            {{ planetLoading ? '载入中…' : '载入星球' }}
          </PrunButton>
          <Active label="许可证上限">
            <SelectInput
              :model-value="permitLimit"
              :options="permitOptions"
              @update:model-value="permitLimit = $event ?? '1'" />
          </Active>
        </div>
        <p v-if="alreadyOwned">此星球已有自有基地，请选择新基地的星球。</p>
        <p
          v-else-if="planetResult && planetResult.id === candidatePlanet?.naturalId && !environment"
          >星球数据载入失败，可重试。</p
        >
        <p v-else-if="planet.trim() && !candidatePlanet">请选择有效的星球名称或代码。</p>

        <LoadingSpinner v-if="fioBuildingsStore.loading || workforceNeedsStore.loading" />
        <p v-else-if="!fioBuildingsStore.buildings || !workforceNeedsStore.needs">
          建筑配方或用工数据未载入。 <PrunButton inline @click="loadCatalog">重试</PrunButton>
        </p>
        <details v-if="warehouses.options.length">
          <summary :class="[C.SectionHeader.container, C.fonts.fontRegular, $style.summary]">
            基地仓库 · {{ warehouses.capacity.weight.toLocaleString() }} t /
            {{ warehouses.capacity.volume.toLocaleString() }} m³ · 占地 {{ warehouses.area }}
          </summary>
          <div :class="$style.fields">
            <Active
              v-for="item in warehouses.options"
              :key="item.ticker"
              :label="`${item.ticker} ${BUILDING_NAMES_ZH[item.ticker] ?? ''}`"
              :tooltip="`每栋 +${item.weight} t / +${item.volume} m³，占地 ${item.area}`">
              <NumberInput
                :class="$style.compactNumber"
                :model-value="item.count"
                :min="0"
                @update:model-value="warehouseCounts[item.ticker] = $event ?? 0" />
            </Active>
          </div>
        </details>
        <template v-if="environment && !alreadyOwned && fioBuildingsStore.buildings">
          <SectionHeader>计划材料</SectionHeader>
          <table :class="$style.amountTable">
            <thead>
              <tr
                ><th>原料</th><th :class="$style.textCell">配方</th
                ><th :class="$style.textCell">CoGC 行业</th><th>日缺口</th><th>目标日产量</th></tr
              >
            </thead>
            <tbody>
              <tr v-for="item in materialPlans" :key="item.ticker">
                <td><MaterialIcon :ticker="item.ticker" size="inline-table" /></td>
                <td :class="$style.textCell">
                  <SelectInput
                    v-if="item.choice"
                    :class="C.forms.input"
                    :model-value="item.choice.value"
                    :options="item.options"
                    width="100%"
                    @update:model-value="recipeKeys[item.ticker] = $event" />
                  <span v-else>此星球暂无可用配方</span>
                </td>
                <td :class="$style.textCell">{{
                  item.choice?.building.Expertise
                    ? expertiseLabel(item.choice.building.Expertise)
                    : '—'
                }}</td>
                <td>{{ fixed2(item.deficit) }}</td>
                <td :data-tooltip="`留空时按日缺口 ${fixed2(item.deficit)} 试算`">
                  <NumberInput
                    v-model="dailyTargets[item.ticker]"
                    :class="C.forms.input"
                    optional
                    :min="0" />
                </td>
              </tr>
            </tbody>
          </table>
          <div :class="$style.fields">
            <Active v-for="ticker in productionTypes" :key="ticker" :label="`${ticker} 栋数`">
              <NumberInput
                v-model="productionCounts[ticker]"
                optional
                :min="0"
                :class="$style.compactNumber"
                data-tooltip="留空自动安排栋数，填 0 则不建设" />
            </Active>
          </div>
          <p :class="[C.type.typeSmall, $style.note]">
            栋数留空时按面积安排。原目标放不下时，在固定栋数和队列槽位内按每日净节省分配整数订单。
          </p>
          <div :class="$style.fields">
            <Active
              v-for="[industry, count] in expertCounts"
              :key="industry"
              :label="`${expertiseLabel(industry)}专家`">
              <SelectInput
                :model-value="String(count)"
                :options="expertOptions(count)"
                :width="64"
                @update:model-value="expertOverrides[industry] = Number($event ?? count)" />
            </Active>
            <span v-if="expertCounts.size"
              >基地专家 {{ totalExperts }} / {{ BASE_EXPERT_LIMIT }}</span
            >
          </div>
          <RadioGroupContainer horizontal>
            <RadioItem
              v-if="activeCogc"
              :model-value="includeCogc"
              horizontal
              @update:model-value="includeCogc = $event">
              计入当前 CoGC（{{ activeCogc }}）
            </RadioItem>
            <RadioItem
              :model-value="corporateHq"
              horizontal
              @update:model-value="corporateHq = $event">
              星球有适用的集团总部加成
            </RadioItem>
          </RadioGroupContainer>
          <p v-if="!companyHq" :class="[C.type.typeSmall, $style.note]">
            公司总部数据待载入。可打开 <PrunLink inline command="HQ" /> 后重新载入星球。
          </p>
          <p v-if="fixedLayout">
            建筑配置 {{ fixedLayout.buildings.map(x => `${x.ticker} × ${x.count}`).join('、') }}。
            面积 {{ fixedLayout.area }} / {{ BASE_AREAS[maxPermits - 1] }}，需要
            {{ fixedLayout.permits }} 张许可证。
          </p>
          <template v-if="fixedLayout && !warehousesExceedLimit">
            <SectionHeader>循环队列订单数</SectionHeader>
            <p v-if="queuePreview.length === 0">当前方案没有生产线。</p>
            <template v-for="queue in queuePreview" :key="queue.ticker">
              <p :class="$style.note">
                {{ queue.ticker }} · {{ queue.count }} 栋并行 · 循环订单合计
                {{ queue.totalOrders }} 单
                <template v-if="queue.manual">
                  · 手动
                  <PrunButton inline @click="resetQueueOrders(queue.ticker)">恢复自动</PrunButton>
                </template>
                <template v-else-if="!automaticPlan?.layout"> · 自动队列待计算</template>
              </p>
              <table :class="$style.amountTable">
                <thead>
                  <tr>
                    <th :class="$style.textCell">配方</th>
                    <th data-tooltip="按整数订单比例试算，每单为 1 个标准批次，0 单表示停产">
                      循环订单数
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="recipe in queue.recipes" :key="recipe.line.value">
                    <td :class="$style.textCell">{{ recipe.line.recipe.RecipeName }}</td>
                    <td>
                      <NumberInput
                        :class="[C.forms.input, $style.compactNumber]"
                        :model-value="recipe.orders"
                        :min="0"
                        integer
                        @update:model-value="
                          editQueueOrder(queue.ticker, recipe.line.value, $event)
                        " />
                    </td>
                  </tr>
                </tbody>
              </table>
            </template>
            <p v-if="!automaticPlan?.layout && queuePreview.some(queue => !queue.manual)">
              <template v-if="optimizing">正在按每日净节省计算自动队列…</template>
              <template v-else-if="optimization?.status === 'missing-cost'">
                请补齐报价或费率，或切换到收费币种的交易所，以便计算自动队列。
              </template>
              <template v-else-if="optimization?.status === 'incomplete'">
                本次未找到可核算的自动分配方案。
              </template>
              <template v-else>等待用工数据后计算自动队列。</template>
              <template v-if="hasManualQueues">待计算的生产线暂按空闲试算。</template>
            </p>
          </template>
          <p v-if="invalidProductionCounts">建筑栋数须为非负整数。</p>
          <p v-else-if="!plan">请检查配方和目标产量。目标产量留空时使用日缺口。</p>
          <p v-else-if="warehousesExceedLimit">
            基地核心和仓库共占地 {{ fixedArea }}，当前上限为 {{ BASE_AREAS[maxPermits - 1] }}。
            请减少仓库栋数以留出生产面积。
          </p>
          <p v-else-if="!fixedLayout">
            固定建筑及配套设施放不进
            {{ BASE_AREAS[maxPermits - 1] }} 的许可面积。请调整建筑栋数或许可证上限。
          </p>
          <template v-else-if="plan.layout">
            <p
              v-if="
                !hasManualQueues &&
                (optimization?.status === 'optimized' || optimization?.status === 'estimated')
              ">
              {{
                requestedPlan?.overflow === undefined
                  ? ''
                  : optimizationReasons[requestedPlan.overflow.reason]
              }}
              {{
                optimization.status === 'optimized'
                  ? '已按每日净节省最大分配循环订单。'
                  : '已找到可行的整数订单分配，最优值尚未确认。'
              }}
            </p>
            <p
              >用工：{{
                wfTiers
                  .filter(t => plan!.workforce[t] > 0)
                  .map(t => `${t} ${plan!.workforce[t]}`)
                  .join('、') || '0'
              }}。</p
            >
            <SectionHeader>产能与外购缺口</SectionHeader>
            <table :class="$style.amountTable">
              <thead>
                <tr
                  ><th>原料</th><th>生产效率</th><th>单栋净产量/日</th><th>目标日产量</th>
                  <th>试算净产量/日</th><th>仍需外购/日</th><th>富余/日</th></tr
                >
              </thead>
              <tbody>
                <tr v-for="row in materialResults" :key="row.ticker">
                  <td><MaterialIcon :ticker="row.ticker" size="inline-table" /></td>
                  <td>
                    <template v-if="row.line">
                      {{ percent2(row.line.efficiency.total) }}
                      <Tooltip :tooltip="efficiencyTooltip(row.line.efficiency)" />
                    </template>
                    <template v-else>—</template>
                  </td>
                  <td>{{ row.perBuilding === undefined ? '—' : fixed2(row.perBuilding) }}</td>
                  <td>{{ fixed2(row.dailyTarget) }}</td>
                  <td>{{ fixed2(row.production) }}</td>
                  <td>{{ row.purchase ? fixed2(row.purchase.after) : '待核算' }}</td>
                  <td>{{ row.purchase ? fixed2(row.purchase.surplus) : '待核算' }}</td>
                </tr>
              </tbody>
            </table>
            <p :class="[C.type.typeSmall, $style.note]"
              >按新建筑、满员和充分供给消耗品估算。请核对空地、用工和许可证。</p
            >
            <SectionHeader>库存周期</SectionHeader>
            <table :class="$style.amountTable">
              <tbody>
                <tr>
                  <th>每日净产物入库</th>
                  <td v-if="storageCycle"
                    >{{ fixed2(storageCycle.products.weight) }} t /
                    {{ fixed2(storageCycle.products.volume) }} m³</td
                  >
                  <td v-else>待核算</td>
                </tr>
                <tr>
                  <th>
                    产物填满周期
                    <Tooltip
                      tooltip="按日均流量估算。成品库存从零开始，原料和消耗品及时补给，产物留在基地。" />
                  </th>
                  <td>{{ formatStorageCycle(storageCycle?.fill) }}</td>
                </tr>
                <tr>
                  <th>
                    一次备齐补给的最长周转周期
                    <Tooltip
                      tooltip="按日均流量估算。每轮开始时一次备齐原料与消耗品，轮末取走净产物。" />
                  </th>
                  <td>{{ formatStorageCycle(storageCycle?.rotation) }}</td>
                </tr>
              </tbody>
            </table>
            <details v-if="changedPurchases?.length">
              <summary :class="[C.SectionHeader.container, C.fonts.fontRegular, $style.summary]"
                >全公司日采购变化（含新增用工消耗）</summary
              >
              <table :class="$style.amountTable">
                <thead
                  ><tr><th>物料</th><th>当前</th><th>投产后</th><th>差额</th></tr></thead
                >
                <tbody>
                  <tr v-for="row in changedPurchases" :key="row.ticker">
                    <td
                      ><PrunLink inline :command="`CXOB ${row.ticker}.${exchange}`">{{
                        row.ticker
                      }}</PrunLink></td
                    >
                    <td>{{ fixed2(row.before) }}</td
                    ><td>{{ fixed2(row.after) }}</td
                    ><td>{{ fixed2(row.change) }}</td>
                  </tr>
                </tbody>
              </table>
            </details>
            <p v-if="missingQuotes.length">缺报价：{{ missingQuotes.join('、') }}</p>
            <p v-if="feeCurrencyMismatch" :class="[C.type.typeSmall, $style.note]">
              生产费与交易所报价币种不同。切换到收费币种的交易所可计算净节省和回本。
            </p>
            <SectionHeader>成本与回本</SectionHeader>
            <table :class="$style.amountTable">
              <tbody>
                <tr
                  ><th>每日采购节省</th
                  ><td>{{
                    money(procurement?.value === undefined ? undefined : -procurement.value)
                  }}</td></tr
                >
                <tr
                  ><th>每日维护估值</th><td>{{ money(maintenance) }}</td></tr
                >
                <tr>
                  <th>每日生产费</th>
                  <td>
                    {{ productionFeeText }}
                    <PrunLink
                      v-if="candidatePlanet"
                      inline
                      :command="`LR ${candidatePlanet.naturalId}`"
                      >本地规则</PrunLink
                    >
                  </td>
                </tr>
                <tr
                  ><th>全公司每日净节省</th><td>{{ money(netSavings) }}</td></tr
                >
                <tr
                  ><th>建材投入</th><td>{{ money(construction?.value) }}</td></tr
                >
                <tr>
                  <th>自产节省回本天数</th>
                  <td>{{ formatPayback(netSavings, construction?.value, '无正节省') }}</td>
                </tr>
                <tr>
                  <th>单基地估值</th>
                  <td>
                    <span role="group" aria-label="单基地估值">
                      <PrunButton
                        v-for="mode in standalonePriceModes"
                        :key="mode.value"
                        inline
                        :primary="standalonePriceMode === mode.value"
                        :neutral="standalonePriceMode !== mode.value"
                        :aria-pressed="standalonePriceMode === mode.value"
                        :data-tooltip="mode.tooltip"
                        :disabled="
                          mode.value === 'live' && (loadingLiveQuotes || newBaseFlows === undefined)
                        "
                        @click="selectStandalonePriceMode(mode.value)">
                        {{ mode.value === 'live' && loadingLiveQuotes ? '读盘中…' : mode.label }}
                      </PrunButton>
                    </span>
                    <div
                      v-if="standaloneFallbackTickers.length"
                      :class="[C.type.typeSmall, $style.note]">
                      {{ standaloneFallbackTickers.join('、') }} 缺少 7 日均价，已用 30 日均价估值。
                    </div>
                  </td>
                </tr>
                <tr>
                  <th>单基地建材投入</th>
                  <td>{{ money(standaloneConstruction?.value) }}</td>
                </tr>
                <tr>
                  <th>单基地每日维护估值</th>
                  <td>{{ money(standaloneMaintenance) }}</td>
                </tr>
                <tr>
                  <th data-tooltip="用加成后的日均净产出和净消耗估值，再扣除维护和生产费。">
                    单基地每日经营利润
                  </th>
                  <td>{{ money(standaloneProfit) }}</td>
                </tr>
                <tr>
                  <th>单基地经营回本天数</th>
                  <td>{{
                    formatPayback(standaloneProfit, standaloneConstruction?.value, '无正利润')
                  }}</td>
                </tr>
              </tbody>
            </table>
          </template>
        </template>
      </section>
    </template>
  </div>
</template>
