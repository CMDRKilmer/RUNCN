<script setup lang="ts">
// XIT GOVH 政府基建补给助手主面板。
// 数据全部来自游戏本地：POPR / POPI / POPID 原生窗口 DOM（govh-dom）+ cxobStore
// 实时订单簿（复用 BPC/BMAT/CBUY 的 bp-utils）+ sitesStore 基地数 + materialsStore
// 重量体积。零外部请求。求解模型见 govh-model.ts（固化 oog 系数与算法，运行时零网络）。

import Header from '@src/components/Header.vue';
import ActionBar from '@src/components/ActionBar.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import PrunButton from '@src/components/PrunButton.vue';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import { useTileState } from '@src/store/user-data-tiles';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { planetsStore } from '@src/infrastructure/prun-api/data/planets';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { fixed0, fixed2, percent1 } from '@src/utils/format';
import {
  readGovernanceSnapshot,
  takeReadFailure,
  type GovernanceProjectEntry,
  type GovhSnapshot,
} from './govh-dom';
import { readCachedSnapshot, writeCachedSnapshot } from './govh-cache';
import { useManagedGovernments } from './govh-governments';
import { setGovhQuote } from './govh-quote';
import { readPrices, subscribePrices, GOVH_EXCHANGES } from './govh-prices';
import { readPlanetBaseCount } from './govh-base-count';
import {
  solve,
  LEVELS,
  LEVEL_LABELS,
  NEEDS,
  INFRA_NEEDS,
  NEED_LABELS,
  UPKEEP_BUILDINGS,
  type Need,
  type InfraNeed,
  type LifeSupportAssumption,
  type FillScope,
  type SupplyOption,
} from './govh-model';

const parameters = useXitParameters();
const planetInput = useTileState('govh-planet', '');
// 目标满足度固定 100%：面板定位「一个报告周期备足」。
// 模型层不再保留可调 target（求解器恒按 100% 目标 + 维生假设计算），减少二次采购的
// 「省钱档」旋钮已从设计与求解器中移除，不存在「改 UI 即可恢复」的隐藏分支。
// 维生预期：政府改不了住房，可以选择按当前维生封顶备货（current），还是假定一个
// 人口报告周期内住房补齐到 100% 提前备足 30 天（full）。默认 current：非宜居星球
// 的维生是全星球住房容量 ÷ 总人口的整体比值，住房由其他基地主控制、政府读不到也
// 改不了；2026-11-12 实测 VH-192b 维生 86% 已持续多期、人口仍净增，缺口并非
// 「一个报告周期内自愈」的暂时态，默认按乐观的 full 会系统性高估预览并过度提前备货。
// full 档保留为可切换对照（确认住房即将补齐时再切）；曾手动切过档的用户沿用其 localStorage 选择。
// current 档说明压到 ≤30 汉字，直接指顶部「预计补齐 100%」按钮，不再重复有效目标 / 二次采购 / 30 天。
const lifeAssumption = useTileState<LifeSupportAssumption>('govh-life-assumption', 'current');
// 补满范围：默认「即时仓 + 储备仓」（两格都填满，一次到位）。
// 「只补即时仓」用于精打细算：只把「下一次消耗」补够，储备仓留空，等消耗后自然补位。
// 切换只影响待补量与待补成本口径，不影响需求满足度求解。
const fillScope = useTileState<FillScope>('govh-fill-scope', 'both');
// 命令参数 `XIT GOVH VH-192b` 预填星球（保留玩家输入的大小写）。
if (parameters[0] && parameters[0].trim() !== '') {
  planetInput.value = parameters[0].trim();
}

// 游戏本地「视图」菜单里，我作为管理者的政府 → 星球编码。零外部请求、零硬编码账号数据。
const { governments, loaded: governmentsLoaded } = useManagedGovernments();
// 自定义兜底：仅当菜单尚未就绪或需要查非管理星球时使用，默认不显示输入框。
const CUSTOM_PLANET = '__custom__';
const customMode = ref(false);
const customPlanet = ref('');
const mounted = ref(false);
let loadSeq = 0;

const snapshot = shallowRef<GovhSnapshot | undefined>(undefined);
const loading = ref(false);
const error = ref<string | undefined>(undefined);
const info = ref<string | undefined>(undefined);
const disposed = ref(false);
// 管理方项目：LR「项目」标签的四个原生字段共用第一列竖表头，左右两列取当期 / 即办。
// 顺序与 LR 原生 FormComponent 一致（类别 / 项目 / 说明 / 结束于·开始于）。
const PROJECT_FIELDS = [
  { key: 'category', label: '类别', clamp: false },
  { key: 'name', label: '项目', clamp: false },
  { key: 'description', label: '说明', clamp: true },
  { key: 'time', label: '结束于 / 开始于', clamp: false },
] as const;
const PROJECT_SIDES = ['current', 'pending'] as const;
type ProjectSide = (typeof PROJECT_SIDES)[number];

function projectValue(side: ProjectSide, key: keyof GovernanceProjectEntry): string {
  return snapshot.value?.projects?.[side]?.[key] ?? '—';
}
// 用户显式勾选集合；undefined = 用求解器推荐。
const userSelected = shallowRef<Set<string> | undefined>(undefined);
// 额外 additive 价格刷新 nonce：订单簿推送会触发 computed 重算，这里只用于手动刷新提示。
const priceNonce = ref(0);

// 下拉数据：只用 userDataStore 的 GOVERNMENT 上下文过滤「视图」菜单里的星球链接。
function findGovernment(value: string) {
  const needle = value.trim().toLowerCase();
  return governments.value.find(
    g => g.planet.toLowerCase() === needle || g.name.toLowerCase() === needle,
  );
}

// 命令参数 / 旧存档可能是 VH-192B 这类大小写，命中本地政府时回正到服务端 naturalId。
function canonicalPlanet(value: string): string {
  return findGovernment(value)?.planet ?? value.trim();
}

interface GovernmentOption {
  label: string;
  value: string;
}

const governmentOptions = computed<GovernmentOption[]>(() => {
  const options = governments.value.map(g => ({
    label: `${g.name} (${g.planet})`,
    value: g.planet,
  }));
  const current = planetInput.value.trim();
  // 命令参数或旧存档里的星球可能不在政府列表中，仍保留为可选项避免丢失上下文。
  if (current && !options.some(o => o.value.toLowerCase() === current.toLowerCase())) {
    options.unshift({ label: `自定义：${current}`, value: current });
  }
  return options;
});

const governmentPlaceholder = computed(() => {
  if (governments.value.length > 0) {
    return `选择我管理的政府（${governments.value.length} 个）`;
  }
  if (!governmentsLoaded.value) {
    return '正在读取我管理的政府…';
  }
  return '未在「视图」菜单中检测到政府';
});

const governmentStatus = computed(() => {
  if (governments.value.length > 0) {
    return `已从游戏本地「视图」菜单预设 ${governments.value.length} 个我管理的政府：${governments.value
      .map(g => g.planet)
      .join(' / ')}`;
  }
  if (!governmentsLoaded.value) {
    return '正在从游戏本地「视图」菜单读取我管理的政府…';
  }
  return '未检测到管理的政府；可选「自定义编码…」输入星球编码。';
});

const selectedGovernment = computed<string>({
  get: () => (customMode.value ? CUSTOM_PLANET : planetInput.value.trim()),
  set: value => {
    if (value === CUSTOM_PLANET) {
      customMode.value = true;
      const current = planetInput.value.trim();
      customPlanet.value = current && !findGovernment(current) ? current : '';
      planetInput.value = '';
      snapshot.value = undefined;
      error.value = undefined;
      info.value = undefined;
      return;
    }
    customMode.value = false;
    const canonical = canonicalPlanet(value);
    planetInput.value = canonical;
    userSelected.value = undefined;
    if (mounted.value && canonical !== '') {
      void refreshData();
    }
  },
});

// 政府列表就绪后：空选自动落到第一个政府；已有选择则只回正大小写。
watch(
  governments,
  list => {
    if (list.length === 0 || customMode.value) {
      return;
    }
    const current = planetInput.value.trim();
    if (current === '') {
      planetInput.value = list[0].planet;
      if (mounted.value) {
        void refreshData();
      }
      return;
    }
    const canonical = canonicalPlanet(current);
    if (canonical !== current) {
      planetInput.value = canonical;
      if (mounted.value) {
        void refreshData();
      }
    }
  },
  { immediate: true },
);

watch(customPlanet, value => {
  if (customMode.value) {
    planetInput.value = value.trim();
  }
});

// 自定义星球输入框的「守护式聚焦」：真人用鼠标点原生 <select> 的「自定义编码…」选项时，
// 原生下拉关闭 + 游戏 Frame 的全局 click 处理会在 TextInput 的 nextTick 单次 focus 之后
// 把焦点抢回根 <div tabindex="-1">，于是输入框已渲染却打不进字。CDP 的 selectOption /
// 键盘选择不走这条鼠标路径，旧的单次 focus 因此只在真机失败。这里在 customMode 打开的
// 短窗口（600ms）内检测到焦点落到不可编辑区域就补一次 focus；用户主动点到其它
// 输入框 / 按钮 / 下拉则立即放手，不抢焦点。
const rootEl = useTemplateRef<HTMLElement>('rootEl');
const CUSTOM_FOCUS_GUARD_MS = 600;
let focusGuardUntil = 0;
let focusGuardTimer: ReturnType<typeof setInterval> | undefined;
let focusOutCleanup: (() => void) | undefined;

function customPlanetInput(): HTMLInputElement | undefined {
  return (
    rootEl.value?.querySelector<HTMLInputElement>('[data-govh-custom-planet] input') ?? undefined
  );
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.matches('input, textarea, select, button, a[href], [contenteditable="true"]')
  );
}

function stopCustomFocusGuard(): void {
  if (focusGuardTimer !== undefined) {
    clearInterval(focusGuardTimer);
    focusGuardTimer = undefined;
  }
  focusOutCleanup?.();
  focusOutCleanup = undefined;
}

function startCustomFocusGuard(): void {
  stopCustomFocusGuard();
  focusGuardUntil = Date.now() + CUSTOM_FOCUS_GUARD_MS;
  const guardActive = (): boolean => customMode.value && Date.now() <= focusGuardUntil;

  const input = customPlanetInput();
  if (input) {
    // 焦点一旦被游戏 Frame 根 div 这类不可编辑区域抢走，下一宏任务补回（让原生 click 链走完）。
    // 用户主动切到其它可交互控件则放手，不抢焦点。
    const onFocusOut = (event: FocusEvent): void => {
      if (!guardActive()) {
        stopCustomFocusGuard();
        return;
      }
      if (isInteractiveTarget(event.relatedTarget)) {
        stopCustomFocusGuard();
        return;
      }
      setTimeout(() => {
        if (guardActive()) {
          customPlanetInput()?.focus();
        }
      }, 0);
    };
    input.addEventListener('focusout', onFocusOut);
    focusOutCleanup = () => input.removeEventListener('focusout', onFocusOut);
  }

  // 轮询兜底：应对 focusout 先于监听挂载、或焦点被静默移动的情况。
  let elapsed = 0;
  const step = 40;
  focusGuardTimer = setInterval(() => {
    elapsed += step;
    if (!guardActive() || elapsed > CUSTOM_FOCUS_GUARD_MS) {
      stopCustomFocusGuard();
      return;
    }
    const target = customPlanetInput();
    if (!target || document.activeElement === target) {
      return;
    }
    if (isInteractiveTarget(document.activeElement)) {
      stopCustomFocusGuard();
      return;
    }
    target.focus();
  }, step);
}

watch(customMode, value => {
  if (value) {
    void nextTick(() => startCustomFocusGuard());
  } else {
    stopCustomFocusGuard();
  }
});

function applyCustomPlanet() {
  if (!customMode.value) {
    return;
  }
  // 手填也走一次本地政府表回正大小写，避免 VH-192B 这类输入打不开 POPR。
  const canonical = canonicalPlanet(customPlanet.value.trim());
  customPlanet.value = canonical;
  planetInput.value = canonical;
  userSelected.value = undefined;
  void refreshData();
}

// 该星球玩家自有基地数（本地 sitesStore，按 planet naturalId 统计）。
const siteCount = computed(() => {
  const planet = (snapshot.value?.planet ?? planetInput.value).trim().toUpperCase();
  if (planet === '') {
    return 0;
  }
  return (sitesStore.all.value ?? []).filter(
    site => (getEntityNaturalIdFromAddress(site.address) ?? '').toUpperCase() === planet,
  ).length;
});

// 整星基地数（含其他公司的基地）。安全 / 健康的基础供给是「每座基地 +50」且整星
// 共享，用自有基地数会在共享星球上少算一个数量级，进而多买安全 / 健康物料
// （PR #60 审查 P2）。来源是星球聊天频道「用户列表」的会员数（本地窗口，
// 不连任何外部网站）；读不到时回退自有基地数，宁可变保守也不报错。
const planetBaseCount = ref<number | undefined>(undefined);
const baseCount = computed(() => planetBaseCount.value ?? siteCount.value);

// 自定义模式的主入口：只列「自有基地星球」，不拉全量星球列表、不硬编码账号数据。
// 游戏约束每个玩家在每个星球只能有 1 座基地，所以按 naturalId 去重即可，不显示基地数量。
// 基地来自本地 sitesStore；星球显示名 / 大小写回正来自本地 planetsStore。
interface BasePlanetOption {
  value: string;
  label: string;
}
const basePlanetOptions = computed<BasePlanetOption[]>(() => {
  const planets = new Map<string, string>();
  for (const site of sitesStore.all.value ?? []) {
    const naturalId = getEntityNaturalIdFromAddress(site.address);
    if (!naturalId) {
      continue;
    }
    planets.set(naturalId.toUpperCase(), naturalId);
  }
  return [...planets.values()]
    .map(naturalId => {
      const known = planetsStore.getByNaturalId(naturalId);
      const displayId = known?.naturalId ?? naturalId;
      const name = known?.name ?? naturalId;
      return {
        value: displayId,
        label: `${name} (${displayId})`,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
});

const basePlanetPlaceholder = computed(() => '选择自有基地星球');

// v-model 直接落到 customPlanet，并复用手输路径的回正 / 重读逻辑。
const selectedBasePlanet = computed<string>({
  get: () => {
    const current = customPlanet.value.trim().toLowerCase();
    return basePlanetOptions.value.find(o => o.value.toLowerCase() === current)?.value ?? '';
  },
  set: value => {
    if (value === '') {
      return;
    }
    customPlanet.value = value;
    applyCustomPlanet();
  },
});

// 全部参与补给的物料 ticker（来自已建建筑，去重）。
const tickers = computed(() => {
  if (!snapshot.value) {
    return [] as string[];
  }
  const set = new Set<string>();
  for (const building of UPKEEP_BUILDINGS) {
    if ((snapshot.value.levels[building.ticker] ?? 0) > 0) {
      for (const ticker of building.materials) {
        set.add(ticker);
      }
    }
  }
  return [...set].sort();
});

// 单价统一走 BPC/BMAT/CBUY 同一套本地订单簿价格源，不提供手填覆盖。
const prices = computed<Record<string, number | undefined>>(() => {
  void priceNonce.value; // 依赖：手动刷新时强制重算
  const live = readPrices(tickers.value);
  return Object.fromEntries(tickers.value.map(ticker => [ticker, live[ticker]?.price]));
});
const priceExchanges = computed<Record<string, string>>(() => {
  const live = readPrices(tickers.value);
  return Object.fromEntries(tickers.value.map(ticker => [ticker, live[ticker]?.exchange ?? '—']));
});

// 物料重量/体积（本地 materialsStore）。
const materialsInfo = computed<Record<string, { weight: number; volume: number }>>(() => {
  const result: Record<string, { weight: number; volume: number }> = {};
  for (const ticker of tickers.value) {
    const material = materialsStore.getByTicker(ticker);
    result[ticker] = { weight: material?.weight ?? 0, volume: material?.volume ?? 0 };
  }
  return result;
});

// 主求解：每次输入 / 价格 / 勾选 / 维生预期变化都实时重算。
// solveBase 抽出公共输入，供主结果与两档成本对照复用，避免三处手写同一份参数。
const solveBase = computed(() => {
  const snap = snapshot.value;
  if (!snap) {
    return undefined;
  }
  return {
    population: snap.population,
    baseCount: baseCount.value,
    currentFulfillment: snap.fulfillment,
    currentHappiness: snap.happiness,
    // LR「人口」标签给出上一周期实际运行等级；目标降级 / 断供时它小于已建造等级，
    // 按建成等级算会高估 provided。LR 不可用时回退已建造等级（旧行为）。
    // 容量推算另走 builtLevels / effectiveLevels：储备按建成等级、即时仓按运行等级。
    levels: snap.effectiveLevels ?? snap.levels,
    builtLevels: snap.levels,
    effectiveLevels: snap.effectiveLevels,
    facilityStocks: snap.facilityStocks,
    prices: prices.value,
    materialsInfo: materialsInfo.value,
  };
});

const result = computed(() => {
  const base = solveBase.value;
  if (!base) {
    return undefined;
  }
  return solve({
    ...base,
    selected: userSelected.value,
    lifeSupportAssumption: lifeAssumption.value,
    fillScope: fillScope.value,
  });
});

// 两档维生预期的推荐备货成本对照。用户手动勾选后成本由勾选决定，对照无意义，故隐藏。
const assumptionCosts = computed(() => {
  const base = solveBase.value;
  if (!base || userSelected.value !== undefined) {
    return undefined;
  }
  const current = solve({
    ...base,
    selected: undefined,
    lifeSupportAssumption: 'current',
    fillScope: fillScope.value,
  });
  const full = solve({
    ...base,
    selected: undefined,
    lifeSupportAssumption: 'full',
    fillScope: fillScope.value,
  });
  return { current: current.summary.fillCost, full: full.summary.fillCost };
});

const currentLifeSupport = computed(
  () => result.value?.summary.currentLifeSupport ?? snapshot.value?.fulfillment.LIFE_SUPPORT ?? 1,
);
// 肥沃星球维生恒 100%，两档等价，无需让用户切换。
const lifeSupportFull = computed(() => currentLifeSupport.value >= 1 - 1e-9);

// 说明文案拆成片段，只为「XX% 封顶」这一段套语义警示文字色（非底色）。
const assumptionNoteParts = computed(() => {
  const r = result.value;
  if (!r) {
    return [];
  }
  const ls = formatPercent(r.summary.currentLifeSupport);
  if (r.summary.currentLifeSupport >= 1 - 1e-9) {
    return [{ text: '当前维生 100%，两种维生预期等价：后五类需求不受维生封顶。' }];
  }
  if (r.summary.assumption === 'full') {
    return [
      {
        text: '维生预期：假定一个人口报告周期内住房补齐到 100%。上方「预览」为住房补齐后的预测值；游戏此刻仍按维生 ',
      },
      { text: `${ls} 封顶`, emphasis: true },
      { text: '，表内小字「当前」即该实际显示值。' },
    ];
  }
  return [
    { text: '默认按当前维生 ' },
    { text: `${ls} 封顶`, emphasis: true },
    { text: '备货；也可按顶部「预计补齐 100%」备足供给。' },
  ];
});

const assumptionCostText = computed(() => {
  const c = assumptionCosts.value;
  if (!c) {
    return '';
  }
  const delta = Math.abs(c.full - c.current);
  const base = `推荐备货成本对照：按当前维生 ${fixed0(c.current)} ／ 预计补齐 100% ${fixed0(
    c.full,
  )}`;
  // 目标未超过维生现值，或两档选出的物料集合相同时，差额天然为 0；
  // 明确写出「等价」，避免被误读成切换没生效。
  return delta < 1
    ? `${base}（两档等价，差额 0：推荐物料集合相同）`
    : `${base}（差额 ${fixed0(delta)}）`;
});

// 只有按当前有效目标确实没达标才告警；预测值与「原目标受维生限制」不混为一谈。
const targetWarning = computed(() => {
  const r = result.value;
  if (!r || r.summary.achievable) {
    return undefined;
  }
  const limiting = r.summary.limitingNeed;
  if (limiting) {
    return `按当前维生预期，目标 ${formatPercent(
      r.summary.effectiveTarget,
    )} 仍未达标：短板需求「${NEED_LABELS[limiting]}」被下一层限制，请补齐该层物料。`;
  }
  return `按当前维生预期，目标 ${formatPercent(
    r.summary.effectiveTarget,
  )} 仍未达标，请增加已建建筑的补给物料。`;
});

// 已建建筑列表（14 座中等级 > 0 的）。
const builtBuildings = computed(() =>
  UPKEEP_BUILDINGS.filter(b => (snapshot.value?.levels[b.ticker] ?? 0) > 0),
);

// LR「人口」标签：按需求聚合「贡献（上一周期）」运行率。
// 同一需求有多座建筑时取最低值（短板口径，与 GOVH 逐需求求解一致）。
// 这是物料齐备度，不是满足度：不参与求解、不与预览百分比相减，只作差距对照。
const lastPeriodRates = computed(() => {
  const infra = snapshot.value?.infra;
  if (!infra) {
    return [];
  }
  return INFRA_NEEDS.map(need => {
    const values = infra.levels
      .map(level => level.contributions[need])
      .filter((value): value is number => value !== undefined);
    return {
      need,
      label: NEED_LABELS[need],
      text: values.length > 0 ? formatPercent(Math.min(...values)) : '—',
    };
  });
});

// 只提示、不改模型的一种 LR 口径：当前运行等级 < 建成等级时，求解已按当前等级
// 校正，须让管理者知道，避免把「按当前等级算的供给」误当成「按建成等级算的」。
// LR「目标」列不再做任何计算与展示（2026-11-12 用户裁定：目标等级那段没有意义）。
const infraWarnings = computed(() => {
  const infra = snapshot.value?.infra;
  if (!infra) {
    return [];
  }
  const warnings: string[] = [];
  const downgraded = infra.levels.filter(level => level.built > 0 && level.current < level.built);
  if (downgraded.length > 0) {
    warnings.push(
      `等级校正：${downgraded.length} 座建筑当前运行等级低于建成等级（${downgraded
        .map(level => `${level.ticker} ${level.built}→${level.current}`)
        .join('、')}），本方案按当前等级计算，避免高估供给。`,
    );
  }
  return warnings;
});

// 物料表按建筑分组：buildOptions 按 UPKEEP_BUILDINGS 顺序逐建筑连续 push，
// solve() 不重排 options，故同一建筑的物料行始终相邻。
// 每行携带：是否组首、建筑列 / 覆盖需求列 rowspan（组首为组内行数，其余为 0 不渲染）、
// 组序号、以及整组的覆盖需求并集（按 NEEDS 顺序去重）。建筑名与覆盖需求同组共享一个合并单元格。
interface MaterialRow {
  option: SupplyOption;
  buildingStart: boolean;
  buildingSpan: number;
  groupIndex: number;
  groupNeeds: InfraNeed[];
  fillDisabled: boolean;
  // 合并列「待补量」里的紧凑算式：`700−0−0=` + 得数 `700`。
  calcExpr: string;
  calcResult: string;
}
const materialRows = computed<MaterialRow[]>(() => {
  const options = result.value?.options ?? [];
  const rows: MaterialRow[] = [];
  let groupIndex = -1;
  let previousBuilding: string | undefined;
  // 先数每个建筑的行数，并收集整组的覆盖需求并集，组首行的合并单元格覆盖整组。
  const counts = new Map<string, number>();
  const needsByBuilding = new Map<string, Set<InfraNeed>>();
  for (const option of options) {
    counts.set(option.building, (counts.get(option.building) ?? 0) + 1);
    let set = needsByBuilding.get(option.building);
    if (!set) {
      set = new Set<InfraNeed>();
      needsByBuilding.set(option.building, set);
    }
    for (const need of option.needs) {
      set.add(need);
    }
  }
  // 按 INFRA_NEEDS 固定顺序输出，避免 Set 插入顺序导致标签位置跳动。
  const orderedNeeds = (building: string): InfraNeed[] => {
    const set = needsByBuilding.get(building) ?? new Set<InfraNeed>();
    return INFRA_NEEDS.filter(n => set.has(n)) as InfraNeed[];
  };
  for (const option of options) {
    const buildingStart = option.building !== previousBuilding;
    if (buildingStart) {
      groupIndex++;
      previousBuilding = option.building;
    }
    // `300−50−100=150` 拆成「算式=」与「得数」，模板里给得数单独加粗加深。
    const [calcExpr, calcResult] = option.calculationCompact.split('=');
    rows.push({
      option,
      buildingStart,
      buildingSpan: buildingStart ? (counts.get(option.building) ?? 1) : 0,
      groupIndex,
      groupNeeds: buildingStart ? orderedNeeds(option.building) : [],
      calcExpr: calcExpr ?? '',
      calcResult: calcResult ?? '',
      // 读数期间 POPID hidden 窗口可能与目标命令同名，禁用以免复用到正在关闭的窗。
      fillDisabled: loading.value || planetInput.value.trim() === '',
    });
  }
  return rows;
});

// 模板内百分比：0.86 → "86.0%"，与 fixed0/fixed2 同一本地化口径。
function formatPercent(value: number): string {
  return percent1(value);
}

// 会话内缓存年龄文案：避免切回面板时重复开 POPR / POPI / 逐建筑 POPID hidden 窗口。
function cacheAge(savedAt: number): string {
  const minutes = Math.floor((Date.now() - savedAt) / 60_000);
  return minutes < 1 ? '刚刚' : `${minutes} 分钟前`;
}

function snapshotInfo(snap: GovhSnapshot, suffix: string): string {
  const population = LEVELS.reduce((n, l) => n + snap.population[l], 0);
  const stocked = Object.keys(snap.facilityStocks).length;
  return `已读取 ${snap.planet}：${population.toLocaleString()} 人口 · ${siteCount.value} 座自有基地 · ${builtBuildings.value.length} 类已建基建 · ${stocked} 座设施的「下一次消耗/储备」已计入待补量 · ${suffix}`;
}

// 会话快照在 setup 阶段同步恢复，而不是等 onMounted 再异步读缓存。
// 原因：切换政府 / 公司视图会重建 XIT 磁贴，组件重新挂载。若 snapshot 初始为
// undefined，首绘先渲染空态，随后 refreshData 命中缓存给 snapshot 赋新引用，
// 触发 result 重算 + 20 行 × 11 列整表（含计算过程长文本）二次重建，用户感知为
// 「每次激活 GOVH 都要重新载入计算过程」。在首次渲染前把快照就位即可避免这一次重建。
// 只恢复纯 DOM 快照，价格仍走 cxobStore 实时源；「刷新数据」按钮仍强制重读。
const restoredFromCache = ref(false);
function restoreFromCache(): boolean {
  const planet = planetInput.value.trim();
  if (planet === '') {
    return false;
  }
  const cached = readCachedSnapshot(planet);
  if (!cached) {
    return false;
  }
  snapshot.value = cached.snapshot;
  info.value = snapshotInfo(
    cached.snapshot,
    `本地缓存（${cacheAge(cached.savedAt)}，点「刷新数据」重读）`,
  );
  restoredFromCache.value = true;
  return true;
}
restoreFromCache();

// 记录上一次按哪个星球读过整星基地数，切星球时要把旧值清掉。
let lastBaseCountPlanet = '';

// 读整星基地数（hidden COMG 窗口）。失败不阻断主流程：baseCount 回退自有基地数。
async function refreshBaseCount(planet: string, force: boolean, seq: number) {
  const count = await readPlanetBaseCount(planet, force);
  if (disposed.value || seq !== loadSeq) {
    return;
  }
  planetBaseCount.value = count?.total;
}

// 读取 POPR / POPI / POPID 快照。loadSeq 保证快速切换政府时只认最后一次结果。
// force=true（「刷新数据」按钮）绕过会话缓存并覆写；普通打开 / 切回直接复用。
async function refreshData(force = false) {
  const planet = planetInput.value.trim();
  if (planet === '') {
    error.value = customMode.value
      ? '请先输入自定义星球编码（例如 VH-192b）'
      : '请先从表头下拉菜单选择我作为管理者的政府';
    info.value = undefined;
    return;
  }
  const seq = ++loadSeq;
  loading.value = true;
  error.value = undefined;
  info.value = undefined;
  userSelected.value = undefined;
  if (snapshot.value && snapshot.value.planet !== planet) {
    snapshot.value = undefined;
  }
  if ((snapshot.value?.planet ?? planet).toUpperCase() !== lastBaseCountPlanet) {
    planetBaseCount.value = undefined;
    lastBaseCountPlanet = planet.toUpperCase();
  }
  try {
    const cached = force ? undefined : readCachedSnapshot(planet);
    if (cached) {
      snapshot.value = cached.snapshot;
      info.value = snapshotInfo(
        cached.snapshot,
        `本地缓存（${cacheAge(cached.savedAt)}，点「刷新数据」重读）`,
      );
      void subscribePrices(tickers.value, () => disposed.value);
      void refreshBaseCount(planet, force, seq);
      return;
    }
    const snap = await readGovernanceSnapshot(planet, force);
    if (seq !== loadSeq || disposed.value) {
      return;
    }
    if (!snap) {
      // 失败原因由 govh-dom 回传（POPR / POPI / 哪几座建筑的 POPID 没读到），
      // 比一句笼统的「读取失败」更好定位。
      const reason = takeReadFailure();
      error.value = reason
        ? `读取 ${planet} 失败：${reason}。请确认该游戏原生窗口能正常打开，再点「刷新数据」重试一次。`
        : `读取 ${planet} 的 POPR / POPI / POPID 失败：请确认星球编码正确、游戏原生窗口可正常打开，且已建建筑的维护供给表可读。`;
      snapshot.value = undefined;
      return;
    }
    snapshot.value = snap;
    writeCachedSnapshot(planet, snap);
    info.value = snapshotInfo(snap, '刚刚从本地窗口读取');
    // 本地订单簿按需订阅（hidden CXOB，零外部请求）。
    void subscribePrices(tickers.value, () => disposed.value);
    void refreshBaseCount(planet, force, seq);
  } finally {
    if (seq === loadSeq) {
      loading.value = false;
    }
  }
}

// 手动更新价格：重新订阅缺失报价的物料，订阅结束后必须回收提示。
async function refreshPrices() {
  if (!snapshot.value) {
    return;
  }
  priceNonce.value++;
  info.value = '正在从本地订单簿更新价格（不会连接任何外部网站）…';
  await subscribePrices(tickers.value, () => disposed.value, true);
  if (disposed.value) {
    return;
  }
  const available = tickers.value.filter(t => prices.value[t] !== undefined).length;
  info.value = `本地订单簿已更新：${available} / ${tickers.value.length} 种物料有实时买一价（零外部请求）`;
}

// 勾选 / 取消某物料（含同一 ticker 的多建筑条目独立）。
function toggleOption(key: string) {
  // 容量未知的行在 UI 上是禁用的，这里再挡一次，防止键盘 / 脚本绕过。
  const option = result.value?.options.find(o => o.key === key);
  if (option !== undefined && !option.capacityKnown) {
    return;
  }
  const current = new Set(result.value?.selected ?? []);
  if (current.has(key)) {
    current.delete(key);
  } else {
    current.add(key);
  }
  userSelected.value = current;
}

function isSelected(key: string): boolean {
  return result.value?.selected.has(key) ?? false;
}

// 全选 / 清空 / 恢复推荐。
function selectAll() {
  // 容量未知的行没有采购量，勾上也不会进清单，全选时直接跳过。
  userSelected.value = new Set(
    result.value?.options.filter(o => o.capacityKnown).map(o => o.key) ?? [],
  );
}
function selectNone() {
  userSelected.value = new Set();
}
function resetToRecommended() {
  userSelected.value = undefined;
}

// 维生预期切换：影响有效目标与封顶基线，必须丢掉手动勾选重新求解。
function setLifeAssumption(value: LifeSupportAssumption) {
  lifeAssumption.value = value;
  userSelected.value = undefined;
}

// 补满范围只改待补量口径（补一格还是两格），不影响需求求解，
// 所以不清手动勾选，用户选的物料保持不变。
function setFillScope(value: FillScope) {
  fillScope.value = value;
}

// 说明区第 2 行随补满范围变，避免「两格填满」和「只补即时仓」两种口径同时出现。
const fillScopeNote = computed(() =>
  fillScope.value === 'both'
    ? '待补量：按「下一次消耗 + 储备」两格填满备货，已扣除该建筑现有存量。'
    : '待补量：只补「下一次消耗」（即时仓），储备仓留空，已扣除该格现有存量。',
);

function currentLifePercent(): string {
  return formatPercent(currentLifeSupport.value);
}

// 预测值与游戏当前实际显示值差异显著时，在预览格下方补一行小字。
function showDisplayNow(need: Need): boolean {
  const state = result.value?.needs[need];
  return !!state && Math.abs(state.displayNow - state.fulfillment) > 0.005;
}

// 汇总清单：按 ticker 合并选中物料扣除基建内部存量后的待补量。
function buildCartItems(): { ticker: string; amount: number }[] {
  if (!result.value) {
    return [];
  }
  const byTicker = new Map<string, number>();
  for (const option of result.value.options) {
    if (!option.selected) {
      continue;
    }
    byTicker.set(option.ticker, (byTicker.get(option.ticker) ?? 0) + option.netFillAmount);
  }
  return [...byTicker]
    .map(([ticker, amount]) => ({ ticker, amount: Math.ceil(amount) }))
    .filter(x => x.amount > 0)
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

// 联动 XIT CBUY 比价（临时清单，不写购物车）。
function openCbuy() {
  if (!result.value || !snapshot.value) {
    return;
  }
  const items = buildCartItems().map(x => ({ ticker: x.ticker, name: x.ticker, amount: x.amount }));
  if (items.length === 0) {
    info.value = '当前没有选中的补给物料。';
    return;
  }
  setGovhQuote({ planet: snapshot.value.planet, target: 1, items });
  showBuffer('XIT CBUY GOVH');
}

// 打开某建筑的 POPID 原生详情窗口，把「逐物料填充」交还给玩家自己操作。
// 只开窗、不设置任何贡献滑块、不点「贡献」提交：守住 ToS「服务器写操作必须由
// 用户点击触发」与 GOVH 方案红线 #5「不自动补给/下单」。showBuffer 不带 autoClose
// 即打开可见窗口；同名窗口已存在时聚焦而非重复新建。读数期间的 hidden 窗口可能
// 与命令同名，故按钮在 loading 时禁用，避免复用到正在关闭的隐藏窗。
function openPopid(building: string) {
  if (!snapshot.value) {
    return;
  }
  const planet = snapshot.value.planet.replace(/^p-/i, '');
  void showBuffer(`POPID p-${planet} t-${building}`);
}

// 复制 XIT JSON（购物车可直接识别的格式），便于分享 / 导入。
async function copyJson() {
  const items = buildCartItems();
  if (items.length === 0) {
    info.value = '当前没有选中的补给物料。';
    return;
  }
  const payload = {
    name: `GOVH ${snapshot.value?.planet ?? ''} 100%`,
    materials: Object.fromEntries(items.map(x => [x.ticker, x.amount])),
  };
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    info.value = `已复制 ${items.length} 种物料的 XIT JSON 到剪贴板。`;
  } catch {
    info.value = '复制失败：浏览器拒绝了剪贴板权限。';
  }
}

// 需求满足度条的颜色类（用现有 game ColoredValue 语义，不引入裸色值）。
// 判据用 effectiveTarget 而非 100% 原目标：current 模式下有效目标已被维生压低，
// 按原 100% 目标比较会把已备足的行全部误标红。
function needClass(state: { fulfillment: number; current: number }): string {
  const effective = result.value?.summary.effectiveTarget ?? 1;
  if (state.fulfillment >= 1) {
    return C.ColoredValue.positive;
  }
  if (state.fulfillment < effective) {
    return C.ColoredValue.negative;
  }
  return '';
}

onMounted(() => {
  mounted.value = true;
  if (restoredFromCache.value) {
    // 首绘已由 setup 同步恢复的快照填充，无需再走 onMounted → refreshData 的路径：
    // 那条路会给 snapshot 赋新引用，导致整表二次重建。这里只补订本地订单簿价格。
    void subscribePrices(tickers.value, () => disposed.value);
    return;
  }
  if (planetInput.value.trim() !== '') {
    void refreshData();
  }
});
onUnmounted(() => {
  disposed.value = true;
  stopCustomFocusGuard();
});
</script>

<template>
  <div ref="rootEl" :class="$style.root" :data-govh-restored="restoredFromCache ? 'cache' : 'cold'">
    <div :class="$style.titleRow">
      <Header>政府基建补给助手</Header>
      <span :class="$style.hint">六类需求 × 五类人口 · 本地数据 · 零外部请求</span>
    </div>

    <div :class="$style.controls">
      <Active label="管理的政府">
        <select
          v-model="selectedGovernment"
          :class="$style.governmentSelect"
          data-govh-government-select>
          <option value="" disabled>{{ governmentPlaceholder }}</option>
          <option v-for="option in governmentOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
          <option :value="CUSTOM_PLANET">自定义编码…</option>
        </select>
      </Active>
      <Active v-if="customMode && basePlanetOptions.length > 0" label="自有基地星球">
        <select
          v-model="selectedBasePlanet"
          :class="$style.basePlanetSelect"
          data-govh-base-planet-select>
          <option value="" disabled>{{ basePlanetPlaceholder }}</option>
          <option v-for="option in basePlanetOptions" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
      </Active>
      <Active v-if="customMode" label="自定义星球">
        <TextInput
          v-model="customPlanet"
          :class="$style.planetInput"
          focus-on-mount
          placeholder="VH-192b"
          data-govh-custom-planet
          @change="applyCustomPlanet" />
      </Active>
      <Active label="维生预期">
        <div
          :class="$style.targetGroup"
          data-govh-life-group
          :data-govh-assumption="lifeAssumption">
          <PrunButton
            :primary="lifeAssumption === 'current'"
            :dark="lifeAssumption !== 'current'"
            :disabled="lifeSupportFull"
            inline
            data-govh-life-current
            @click="setLifeAssumption('current')"
            >按当前 {{ currentLifePercent() }}</PrunButton
          >
          <PrunButton
            :primary="lifeAssumption === 'full'"
            :dark="lifeAssumption !== 'full'"
            :disabled="lifeSupportFull"
            inline
            data-govh-life-full
            @click="setLifeAssumption('full')"
            >预计补齐 100%</PrunButton
          >
        </div>
      </Active>
      <!-- 动作按钮整体成组：宽度不够时整组换行并右对齐，不会把「维生预期」挤到第二行。 -->
      <div :class="$style.actions">
        <PrunButton primary :disabled="loading || planetInput === ''" @click="refreshData(true)">
          {{ loading ? '读取中…' : '刷新数据' }}
        </PrunButton>
        <PrunButton dark :disabled="!snapshot" @click="refreshPrices">更新价格</PrunButton>
      </div>
    </div>

    <div :class="$style.governmentHint">{{ governmentStatus }}</div>
    <div v-if="error" :class="$style.error">{{ error }}</div>
    <div v-else-if="info" :class="$style.info">{{ info }}</div>

    <template v-if="snapshot && result">
      <!-- ① 现状：本期 POPR 报告明细（无折线图） + 六类需求现状/预览，左右两栏 -->
      <div :class="$style.card">
        <SectionHeader>报告值 / 本方案预测 · 目标 100%</SectionHeader>
        <div :class="$style.sectionMeta">
          本期人口报告明细（POPR 原生值，不含折线图） · 六类需求报告值 / 本方案预测（按{{
            lifeAssumption === 'full' ? '住房补齐后 100%' : '当前维生'
          }}预期，含封顶）
        </div>
        <div :class="$style.summaryGrid">
          <div
            v-for="level in LEVELS"
            :key="level"
            :class="$style.statCell"
            data-govh-population-stat>
            <div :class="$style.statLabel">{{ LEVEL_LABELS[level] }}</div>
            <div :class="$style.statValue">{{ formatPercent(snapshot.happiness[level]) }}</div>
          </div>
        </div>
        <div :class="$style.reportGrid" data-govh-report-grid>
          <div :class="$style.reportColumn">
            <div :class="$style.subTitle">
              本期人口报告{{
                snapshot.reportLabel ? ' · ' + snapshot.reportLabel : ' · POPR 原生明细'
              }}
            </div>
            <div :class="$style.tableWrap">
              <table :class="[$style.table, $style.miniTable]">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th v-for="level in LEVELS" :key="level" :class="$style.numCol">
                      {{ LEVEL_LABELS[level] }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in snapshot.reportRows" :key="row.label">
                    <td>{{ row.label }}</td>
                    <td v-for="level in LEVELS" :key="level" :class="$style.numCell">
                      {{ row.values[level] || '—' }}
                    </td>
                  </tr>
                </tbody>
              </table>
              <!-- 管理方项目：留在左栏，且与上方「本期人口报告」表共用同一个
                   tableWrap，保证左右边缘严格对齐（含出现横向滚动条时）。
                   LR「项目」标签的当期 / 即办左右并排，四个字段共用第一列竖表头，
                   倒计时原样显示。LR 读不到时降级回 POPR 底部的单行项目。 -->
              <table
                v-if="snapshot.projects && (snapshot.projects.current || snapshot.projects.pending)"
                :class="$style.projectTable"
                data-govh-projects>
                <colgroup>
                  <col :class="$style.projectLabelCol" />
                  <col :class="$style.projectValueCol" />
                  <col :class="$style.projectValueCol" />
                </colgroup>
                <thead>
                  <tr>
                    <th :class="$style.projectCorner">管理方项目</th>
                    <th>当期</th>
                    <th>即办</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="field in PROJECT_FIELDS" :key="field.key">
                    <th scope="row" :class="$style.projectRowHead">{{ field.label }}</th>
                    <!-- 表内不再挂 title：说明列靠两行截断、其余字段 nowrap 省略，
                         鼠标悬浮不再弹重复文案（用户明确要求）。 -->
                    <td
                      v-for="side in PROJECT_SIDES"
                      :key="side"
                      :class="field.clamp ? $style.projectClampCell : $style.projectValue">
                      <div v-if="field.clamp" :class="$style.projectClamp">
                        {{ projectValue(side, field.key) }}
                      </div>
                      <template v-else>{{ projectValue(side, field.key) }}</template>
                    </td>
                  </tr>
                </tbody>
              </table>
              <div
                v-else-if="snapshot.project"
                :class="$style.projectLine"
                :title="snapshot.project.name + '：' + snapshot.project.description">
                项目：{{ snapshot.project.name }} · {{ snapshot.project.description }}
              </div>
            </div>
          </div>
          <div :class="$style.reportColumn">
            <div :class="$style.subTitle">六类需求 · 报告值 / 本方案预测</div>
            <div :class="$style.tableWrap">
              <table :class="[$style.table, $style.miniTable]">
                <thead>
                  <tr>
                    <th>需求</th>
                    <th title="需求量" :class="$style.numCol">需要</th>
                    <th title="现状满足度" :class="$style.numCol">现状</th>
                    <th title="按所选维生假设的补足后预测满足度" :class="$style.numCol">预览</th>
                    <th title="提供量" :class="$style.numCol">提供</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="need in NEEDS" :key="need">
                    <td>{{ NEED_LABELS[need] }}</td>
                    <td :class="$style.numCell">{{ fixed0(result.needs[need].needed) }}</td>
                    <td :class="$style.numCell">{{ snapshot.fulfillmentText[need] }}</td>
                    <td :class="[$style.numCell, needClass(result.needs[need])]">
                      <div :class="$style.previewStack">
                        <strong>{{ formatPercent(result.needs[need].fulfillment) }}</strong>
                        <!-- 「当前」小字始终占位一行（仅切换维生预期时显隐），避免 full 模式多出
                             第 2 行导致整表高度跳动；visibility:hidden 仍保留布局高度。 -->
                        <div
                          :class="$style.previewNow"
                          :data-govh-display-now="showDisplayNow(need) ? '' : null"
                          :style="{ visibility: showDisplayNow(need) ? 'visible' : 'hidden' }"
                          aria-hidden="true"
                          >{{
                            showDisplayNow(need)
                              ? '当前 ' + formatPercent(result.needs[need].displayNow)
                              : '当前'
                          }}</div
                        >
                      </div>
                    </td>
                    <td :class="$style.numCell">{{ fixed0(result.needs[need].provided) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <!-- 说明区：两段注记左右对齐两栏表格，成本对照跨整宽收尾。
             两栏只放两段注记（与 reportGrid 同为 2 项，杜绝 auto-fit 在宽面板拆成 3+ 列）；
             成本对照移到栅格外的独立块，避免它作为第 3 个 item 撑出空列。
             不放在右栏表格脚下，避免右栏被文字撑高、左栏留白。 -->
        <div :class="$style.notes" data-govh-notes>
          <div :class="$style.notesGrid" data-govh-notes-grid>
            <div :class="$style.lifeNote" data-govh-life-hint>
              <strong>「维生」</strong>：宜居恒 100%；非宜居按
              <strong>全星球住房 ÷ 总人口</strong>，补给无效，须玩家建住房。
            </div>
            <div :class="$style.assumptionNote" data-govh-assumption-note
              ><span
                v-for="(part, index) in assumptionNoteParts"
                :key="index"
                :class="part.emphasis ? $style.lifeCap : undefined"
                :data-govh-life-cap="part.emphasis ? '' : null"
                >{{ part.text }}</span
              ></div
            >
          </div>
          <div
            v-if="assumptionCostText"
            :class="[$style.assumptionNote, $style.noteCost]"
            data-govh-assumption-cost>
            {{ assumptionCostText }}
          </div>
          <!-- 未达标告警并入说明区：色条 .notes::before 由此自动覆盖到它的底边，
               2 行 / 3 行星球一致；告警块去掉水平 padding 与边框，文字左缘与上方对齐（R36）。 -->
          <div
            v-if="targetWarning"
            :class="[$style.warn, $style.notesWarn]"
            data-govh-target-warning>
            {{ targetWarning }}
          </div>
        </div>
      </div>

      <!-- ② 已建造等级（LR「人口」标签「建成」列；LR 不可用时回退 POPI） -->
      <div :class="$style.card">
        <SectionHeader>
          已建造基建等级 · {{ builtBuildings.length }} / 14 类 · 整星 {{ baseCount }} 座基地<span
            v-if="baseCount !== siteCount"
            >（自有 {{ siteCount }}）</span
          >
        </SectionHeader>
        <div :class="$style.buildingGrid">
          <div
            v-for="building in UPKEEP_BUILDINGS"
            :key="building.ticker"
            :class="$style.buildingCell">
            <span :class="$style.buildingName">{{ building.name }}</span>
            <span :class="$style.buildingLevel">{{ snapshot.levels[building.ticker] ?? 0 }}</span>
          </div>
        </div>
        <!-- 上一周期运行率与本方案假设并列。两者口径不同（物料齐备度 vs 满足度，
             后者还含维生封顶），不能摆成可相减的两列百分比：左侧是 LR 实测 chips，
             右侧是假设说明，只让管理者看到「现实 / 理想」差距，不动求解逻辑。 -->
        <div v-if="snapshot.infra" :class="$style.infraAudit" data-govh-infra-audit>
          <div :class="$style.infraAuditCol">
            <div :class="$style.infraAuditTitle">上一周期运行率 · LR 实测</div>
            <div :class="$style.infraRates" data-govh-infra-rates>
              <span
                v-for="rate in lastPeriodRates"
                :key="rate.need"
                :class="$style.infraRate"
                :data-govh-infra-rate="rate.need"
                >{{ rate.label }} {{ rate.text }}</span
              >
            </div>
          </div>
          <div :class="$style.infraAuditCol">
            <div :class="$style.infraAuditTitle">本方案假设</div>
            <div :class="$style.infraAssumption" data-govh-infra-assumption>
              物料备足后按 100% 运行计算；左侧为上一周期实测齐备度，仅作差距对照，不参与求解。
            </div>
          </div>
          <div v-if="infraWarnings.length > 0" :class="$style.infraWarn" data-govh-infra-warn>
            <div v-for="(warning, index) in infraWarnings" :key="index">{{ warning }}</div>
          </div>
        </div>
      </div>

      <!-- ③ 补给方案：全部物料自选 -->
      <div :class="$style.card">
        <SectionHeader>补给方案 · 全部物料自选</SectionHeader>
        <div :class="$style.planNotes" data-govh-plan-notes>
          <div :class="$style.planNote" data-govh-plan-note>
            勾选：选中即纳入方案，可随时手动调整。
          </div>
          <div :class="$style.planNote" data-govh-plan-note>
            {{ fillScopeNote }}
          </div>
          <div :class="$style.planNote" data-govh-plan-note>
            推荐：本地实时价下的逐需求贪心近似，非严格全局最优。
          </div>
          <div :class="$style.planNote" data-govh-plan-note>
            填充：点建筑下「填充此建筑」打开该建筑 POPID 原生窗口
          </div>
        </div>
        <div :class="$style.materialToolbar">
          <!-- 补满范围放在补给方案表上方（与全选/清空同一行左侧）：
               只改待补量口径，属于「这个表怎么算」，跟顶部的星球 / 维生参数不同层。 -->
          <span :class="$style.fillScopeLabel">补满范围</span>
          <div :class="$style.targetGroup" data-govh-fill-group :data-govh-fill-scope="fillScope">
            <PrunButton
              :primary="fillScope === 'next'"
              :dark="fillScope !== 'next'"
              inline
              data-govh-fill-next
              @click="setFillScope('next')"
              >补满即时仓</PrunButton
            >
            <PrunButton
              :primary="fillScope === 'both'"
              :dark="fillScope !== 'both'"
              inline
              data-govh-fill-both
              @click="setFillScope('both')"
              >补满即时 + 储备仓</PrunButton
            >
          </div>
          <span :class="$style.toolbarDivider" aria-hidden="true"></span>
          <!-- 物料选择：与「补满范围」同格式的分组标签，标明右侧三个按钮作用于勾选。 -->
          <span :class="$style.fillScopeLabel">物料选择</span>
          <PrunButton dark inline @click="selectAll">全选</PrunButton>
          <PrunButton dark inline @click="selectNone">清空</PrunButton>
          <PrunButton dark inline @click="resetToRecommended">恢复推荐</PrunButton>
          <span :class="$style.selectedCount">
            已选 {{ result.selected.size }} / {{ result.options.length }} 项
          </span>
        </div>
        <div :class="$style.tableWrap">
          <table :class="[$style.table, $style.supplyTable]">
            <thead>
              <tr>
                <th>建筑</th>
                <th :class="$style.needsHeader">覆盖需求</th>
                <th :class="$style.checkCol">选</th>
                <th :class="$style.materialCol">物料</th>
                <th :class="$style.numCol">{{ fillScope === 'next' ? '即时仓量' : '满仓量' }}</th>
                <th :class="$style.numCol">待补量</th>
                <th :class="$style.numCol">单价</th>
                <th>来源</th>
                <th :class="$style.numCol">待补成本</th>
                <th :class="$style.numCol">性价比</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="materialRows.length === 0">
                <td colspan="10" :class="$style.empty">该星球没有已建基建，或没有匹配的物料。</td>
              </tr>
              <tr
                v-for="row in materialRows"
                :key="row.option.key"
                :data-govh-group="row.groupIndex"
                :data-govh-building-start="row.buildingStart ? 'true' : null"
                :class="[
                  row.option.selected ? $style.rowSelected : '',
                  row.buildingStart && row.groupIndex > 0 ? $style.groupStart : '',
                ]">
                <td
                  v-if="row.buildingStart"
                  :rowspan="row.buildingSpan"
                  :class="$style.nameCell"
                  data-govh-col="建筑">
                  <div :class="$style.nameCellContent">
                    <div :class="$style.buildingName">
                      {{ row.option.buildingName }}
                      <span :class="$style.dim">Lv{{ row.option.builtLevel }}</span>
                    </div>
                    <PrunButton
                      dark
                      inline
                      :class="$style.fillButton"
                      :disabled="row.fillDisabled"
                      @click="openPopid(row.option.building)">
                      填充此建筑
                    </PrunButton>
                  </div>
                </td>
                <td
                  v-if="row.buildingStart"
                  :rowspan="row.buildingSpan"
                  :class="$style.needsCellMerged"
                  data-govh-col="覆盖需求">
                  <div :class="$style.needsCell">
                    <span v-for="need in row.groupNeeds" :key="need" :class="$style.needTag">
                      {{ NEED_LABELS[need] }}
                    </span>
                  </div>
                </td>
                <td :class="$style.checkCol" data-govh-col="选">
                  <input
                    type="checkbox"
                    :checked="isSelected(row.option.key)"
                    :disabled="!row.option.capacityKnown"
                    :class="$style.checkbox"
                    @change="toggleOption(row.option.key)" />
                </td>
                <!-- 物料列只留图标：ticker 文字与悬浮说明已删，列宽随之收窄。 -->
                <td :class="$style.materialCol" data-govh-col="物料">
                  <div :class="$style.materialCell">
                    <MaterialIcon :ticker="row.option.ticker" size="medium" />
                  </div>
                </td>
                <td :class="$style.numCell" data-govh-col="满仓量">{{
                  row.option.capacityKnown ? fixed0(row.option.grossFillAmount) : '—'
                }}</td>
                <!-- 待补量与计算合并成一列：算式右对齐，等号后的得数加粗加深。
                     内层 span 保留 data-govh-col="计算过程" 作为稳定验收钩子。 -->
                <td :class="[$style.numCell, $style.calcCell]" data-govh-col="待补量">
                  <span :class="$style.calcExpr" data-govh-col="计算过程">{{
                    row.option.capacityKnown ? row.calcExpr + '=' : ''
                  }}</span
                  ><span :class="$style.calcResult">{{
                    row.option.capacityKnown ? row.calcResult : '容量未知'
                  }}</span>
                </td>
                <td :class="$style.numCell" data-govh-col="单价">{{
                  row.option.price === undefined ? '—' : fixed2(row.option.price)
                }}</td>
                <td :class="$style.sourceCell" data-govh-col="来源">{{
                  priceExchanges[row.option.ticker]
                }}</td>
                <td :class="$style.numCell" data-govh-col="待补成本">{{
                  row.option.price === undefined || !row.option.capacityKnown
                    ? '—'
                    : fixed0(row.option.netFillCost)
                }}</td>
                <td :class="$style.numCell" data-govh-col="性价比">
                  {{
                    row.option.efficiency < 0
                      ? '—'
                      : row.option.efficiency === Infinity
                        ? '免费'
                        : fixed2(row.option.efficiency * 1000)
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- ④ 汇总 + 联动 -->
      <div :class="$style.card">
        <SectionHeader>汇总与采购联动</SectionHeader>
        <div :class="$style.summaryGrid">
          <div :class="$style.statCell">
            <div :class="$style.statLabel"
              >待补成本({{ fillScope === 'next' ? '即时仓' : '满仓' }})</div
            >
            <div :class="$style.statValue"
              >{{ result.summary.missingPrices > 0 ? '≈' : ''
              }}{{ fixed0(result.summary.fillCost) }}</div
            >
          </div>
          <div :class="$style.statCell">
            <div :class="$style.statLabel">总重量</div>
            <div :class="$style.statValue">{{ fixed0(result.summary.weight) }} t</div>
          </div>
          <div :class="$style.statCell">
            <div :class="$style.statLabel">总体积</div>
            <div :class="$style.statValue">{{ fixed0(result.summary.volume) }} m³</div>
          </div>
        </div>
        <div v-if="result.summary.missingPrices > 0" :class="$style.warn">
          有
          {{ result.summary.missingPrices }}
          种物料没有本地报价，成本被低估。可点「更新价格」订阅本地订单簿；单价不接受手填，避免脱离统一价格口径。
        </div>
        <div :class="$style.metaLine">
          主交易所：{{ GOVH_EXCHANGES.map(x => x.code).join(' / ') }} · 价格 1:1 不换算汇率
        </div>
        <ActionBar>
          <PrunButton primary @click="openCbuy">CBUY 比价</PrunButton>
          <PrunButton dark @click="copyJson">复制 JSON</PrunButton>
        </ActionBar>
      </div>
    </template>

    <div v-else-if="!error" :class="$style.emptyState">
      从表头下拉菜单选择我作为管理者的政府；需要查其它星球时可选「自定义编码…」。数据从游戏本地 POPR
      / POPI / POPID 读取，零外部请求。
    </div>
  </div>
</template>

<style module>
.root {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px 12px;
  box-sizing: border-box;
  min-width: 0;
}
.titleRow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.hint {
  color: rgb(148, 158, 166);
  font-size: 11px;
}
.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.governmentSelect {
  width: 240px;
  max-width: 100%;
  font-size: 11px;
  color: var(--rp-skin-ink, currentColor);
}
/* 自有基地星球下拉：选项文字较长，稍宽于政府下拉；字号与面板原生控件统一为 11px，
   颜色仍走主题 ink（R02）。 */
.basePlanetSelect {
  width: 280px;
  max-width: 100%;
  font-size: 11px;
  color: var(--rp-skin-ink, currentColor);
}
.planetInput {
  width: 160px;
}
.governmentHint {
  color: rgb(148, 158, 166);
  font-size: 11px;
  margin-top: -2px;
}
.targetGroup {
  display: inline-flex;
  gap: 2px;
}
/* 动作按钮组：与参数组同一行放不下时整组换行，并靠右收尾（左对齐会留下一大片空白）。 */
.actions {
  display: inline-flex;
  gap: 8px;
  margin-left: auto;
}
.error {
  padding: 6px 8px;
  border: 1px solid rgb(var(--rp-skin-danger-rgb, 217, 83, 79));
  background: rgba(217, 83, 79, 0.12);
  color: rgb(229, 115, 115);
  font-size: 11px;
  border-radius: 2px;
}
.info {
  padding: 5px 8px;
  background: rgba(var(--rp-accent-rgb), 0.1);
  color: rgb(200, 208, 214);
  font-size: 11px;
  border-radius: 2px;
}
.card {
  border: 1px solid rgb(61, 74, 84);
  background: rgba(0, 0, 0, 0.12);
  padding: 6px 8px 8px;
  border-radius: 3px;
  min-width: 0;
}
.sectionMeta {
  color: rgb(148, 158, 166);
  font-size: 11px;
  margin: 2px 0 6px;
}
/* 补给方案说明：4 条规则按 2×2 等宽网格并排，去掉星号 / 列表符 / 单价行；
   两列同宽、同行等高由 grid 保证，minmax(0,1fr) 让长文本在格内换行不溢出（R35）。 */
.planNotes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 14px;
  row-gap: 4px;
  margin: 2px 0 6px;
  color: var(--rp-skin-ink, currentColor);
  font-size: 11px;
  line-height: 1.5;
}
.planNote {
  min-width: 0;
}
.summaryGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 6px;
  margin-bottom: 8px;
}
.statCell {
  border: 1px solid rgb(61, 74, 84);
  border-radius: 3px;
  padding: 4px 6px;
  background: rgba(var(--rp-accent-rgb), 0.05);
  min-width: 0;
}
.statLabel {
  color: rgb(167, 176, 183);
  font-size: 11px;
}
.statValue {
  /* 强调色只做卡片底纹（statCell 的 rgba 底），不当文字色：warm paper /
     ceramic 下 accent 偏浅，配同色浅底只有 3.77~3.95:1（R02）。正文走 ink。 */
  color: var(--rp-skin-ink, currentColor);
  font-size: 16px;
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
/* 本期 POPR 明细与六类需求并排：面板宽度由游戏窗口决定，不能用 viewport 媒体查询。
   auto-fit + minmax 让窄面板自动落回单栏；每列表格各自横向滚动，不挤压列宽（R29）。 */
.reportGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 330px), 1fr));
  gap: 10px;
  align-items: start;
  margin-bottom: 6px;
}
.reportColumn {
  min-width: 0;
}
.subTitle {
  color: var(--rp-skin-ink, currentColor);
  font-size: 11px;
  font-weight: 600;
  margin: 0 0 4px;
}
.projectLine {
  color: var(--rp-skin-ink, currentColor);
  font-size: 11px;
  margin-top: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 管理方项目（LR 当期 / 即办，共用竖列表头）。
   位置：必须留在左栏，并与「本期人口报告」表放在同一个 .tableWrap 里，
   两者共享同一宽度上下文（含横向滚动条出现的情形），左右边缘才严格对齐。
   用户先后否掉「跨整宽放两栏下方」（三张表互相错位）与「放在左栏但不同容器」
   （看着宽度没对齐），最终定为同容器。
   宽度：固定 table-layout + 96px 首列 + 两个值列各 50%。**值列绝不能留空**
   ——实测 Chromium 在 fixed layout 下对未指定宽度的 <col> 只给内容自然宽度，
   不把 width:100% 的剩余空间分下去：只写首列时表格元素宽 415px，但三列只有
   96+106+106=308px，右侧空出 107px，视觉上就是「右边缘往左缩进」。
   calc()/max() 用在 <col> 上不生效，auto layout 也不铺满；只有显式 50% 能铺满
   且保住首列 96px 不折行（实测列宽 96/160/160、右边差 0px）。
   值列 min-width:0 / 溢出隐藏，长项目名与说明不会撑破容器，也不出现横向滚动条
   （R29/R34：不用 viewport 媒体查询）。
   高度：11px 字 / line-height 1.2 / 1px 内边距 / 说明最多 2 行，整块只有 5 行，
   不另加标题行、分组留白或大 padding。首列必须容得下「结束于 / 开始于」不折行，
   否则该行会被撑成两行（实测 76px 时整表 115px，96px 时约 94px）。 */
.projectTable {
  width: 100%;
  min-width: 0;
  table-layout: fixed;
  border-collapse: collapse;
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.2;
}
.projectLabelCol {
  width: 96px;
}
.projectValueCol {
  width: 50%;
}
.projectTable th,
.projectTable td {
  min-width: 0;
  padding: 1px 4px;
  border-bottom: 1px solid var(--rp-skin-border, currentColor);
  color: var(--rp-skin-ink, currentColor);
  text-align: left;
  vertical-align: top;
  overflow: hidden;
}
.projectTable thead th {
  border-bottom-color: var(--rp-skin-border-strong, currentColor);
}
.projectTable thead th:not(:first-child) {
  text-align: center;
}
.projectCorner {
  font-weight: 600;
}
.projectRowHead {
  font-weight: 400;
  white-space: normal;
  overflow-wrap: anywhere;
}
/* 4 个竖表头（类别 / 项目 / 说明 / 结束于·开始于）文字垂直居中：
   `.projectTable th` 是 (0,1,1) 的 vertical-align:top，用双类 (0,2,0) 覆盖；
   值单元格仍 top，说明列占两行时标签落在行中线上，不再贴着行顶。 */
.projectTable .projectRowHead {
  vertical-align: middle;
}
.projectValue {
  white-space: nowrap;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.projectClampCell {
  white-space: normal;
}
.projectClamp {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
/* 说明区：外层只做定位 + 左侧装饰条，两栏栅格交给内层 .notesGrid。
   外层不再自带水平 padding / border——那会让格宽比 .reportGrid 窄 10px，
   auto-fit 切列临界点随之错开，688–695px 一段出现「表格两栏、注记一栏」的错位。
   装饰条改用 ::before 画在卡片内边距里，不占内容盒宽度（R29 / R31）。 */
.notes {
  position: relative;
  margin: 2px 0 4px;
  padding: 3px 0;
}
.notes::before {
  content: '';
  position: absolute;
  left: -8px;
  top: 3px;
  bottom: 3px;
  width: 2px;
  background: rgb(var(--rp-accent-rgb));
}
/* 两段注记两栏：与 .reportGrid 完全同款列定义 / column-gap，且只有 2 个 item；
   auto-fit 窄面板落回单栏、宽面板折叠空轨道锁成两栏，任何宽度都对齐上方表格。 */
.notesGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 330px), 1fr));
  gap: 2px 10px;
  align-items: start;
}
/* 维生来源提示 / 维生预期说明：文字走 ink（R02），11px 满足 R09，
   opacity 显式归 1 避免被全局可读性兜底压淡（R10）。色条由 .notes::before 提供。 */
.lifeNote,
.assumptionNote {
  color: var(--rp-skin-ink, currentColor);
  font-size: 11px;
  line-height: 1.45;
  opacity: 1;
  min-width: 0;
}
.lifeNote strong {
  color: var(--rp-skin-ink, currentColor);
  font-weight: 600;
}
/* 「86.0% 封顶」用语义警示色强调：只改文字色与字重，不铺底色（R02 / R27）。
   --rp-skin-danger 三套色板都有，原样主题回退 currentColor；不用装饰色
   --rp-accent-rgb 当文字色，也不写裸色值。 */
.lifeCap {
  color: var(--rp-skin-danger, currentColor);
  font-weight: 600;
}
/* 成本对照：外层 block 流里天然整宽（不再当 .notes 的 grid item，
   否则宽面板 auto-fit 会把它算成第 3/4 列、撑散两栏注记）。细线与上方分开。 */
.noteCost {
  border-top: 1px solid var(--rp-skin-border, currentColor);
  margin-top: 2px;
  padding-top: 3px;
}
/* 预览格内的「当前实际显示值」小字：与主预测值同色但常规字重，不加底色。 */
.previewNow {
  color: var(--rp-skin-ink, currentColor);
  font-size: 11px;
  font-weight: 400;
  font-variant-numeric: tabular-nums;
  opacity: 1;
}
/* 预览列用固定 2 行高的堆叠容器：主预测值在上、「当前」小字在下且始终占位
   （显隐用 visibility 而非 v-if），确保切换维生预期时整表高度不跳动（R31）。 */
.previewStack {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
  min-height: 2.6em;
  justify-content: flex-end;
}
.tableWrap {
  min-width: 0;
  overflow-x: auto;
}
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.table th,
.table td {
  padding: 3px 6px;
  border-bottom: 1px solid rgb(48, 58, 66);
  white-space: nowrap;
  text-align: left;
}
.table th {
  color: rgb(200, 208, 214);
  font-weight: 600;
  border-bottom-color: rgb(61, 74, 84);
}
/* 双栏内的表格收紧内边距；.table.miniTable 特异性 (0,2,1) 高于 .table th/td 的 (0,1,1)。 */
.table.miniTable th,
.table.miniTable td {
  padding: 2px 4px;
}
/* 勾选 / hover 只给「选」及其后的 td 着色；建筑与覆盖需求是 rowspan 合并单元格，
   必须保持透明，避免 tr 级底色透上去后看起来像分组底色（R30）。 */
.table tbody tr:hover td:not([data-govh-col='建筑']):not([data-govh-col='覆盖需求']) {
  background-color: rgba(var(--rp-accent-rgb), 0.08) !important;
}
.table tbody tr.rowSelected td:not([data-govh-col='建筑']):not([data-govh-col='覆盖需求']) {
  background-color: rgba(var(--rp-accent-rgb), 0.1) !important;
}
/* 必须带 .table 前缀：`.table th, .table td` 是 (0,1,1)，
   裸 .numCell / .checkCol 只有 (0,1,0)，会被左对齐覆盖（R28）。 */
.table .numCol,
.table .numCell {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.table .checkCol {
  text-align: center;
  width: 28px;
}
/* 补给方案表专用（只挂在物料表上，不影响六类需求 / 本期人口报告表）：
   - 表头水平居中，特异性 (0,2,2) 压过 `.table .numCol` 的右对齐；数据单元格仍右对齐；
   - 水平内边距 6px→5px，整体略紧凑但保留余量，不贴字；
   - 物料列只留图标、计算列只留紧凑算式，`width:1%` 让浏览器把这两列压到内容宽度，
     剩余空间留给建筑 / 覆盖需求列，短内容不再白占一大截。 */
.table.supplyTable thead th {
  text-align: center;
}
.table.supplyTable th,
.table.supplyTable td {
  padding: 3px 5px;
}
.table.supplyTable .materialCol {
  width: 1%;
}
.calcCell {
  color: var(--rp-skin-ink, currentColor);
  font-variant-numeric: tabular-nums;
}
/* 合并列「待补量」= 算式 + 得数：整段右对齐（numCell 已给）。
   算式用次级文字色（仍走主题变量，原样主题回退 currentColor），
   得数用主文字色 + 700 字重——颜色与字重同时加深，一眼落到结果上。 */
.calcExpr {
  color: var(--rp-skin-muted, currentColor);
  font-weight: 400;
}
.calcResult {
  color: var(--rp-skin-ink, currentColor);
  font-weight: 700;
}
.checkbox {
  cursor: pointer;
  accent-color: rgb(var(--rp-accent-rgb));
}
.materialCell {
  display: flex;
  align-items: center;
  gap: 6px;
}
/* 带 .table 前缀抬特异性（0,2,0 > `.table td` 的 0,1,1），确保合并单元格内
   纵向 flex 布局不被 td 的 white-space:nowrap 干扰。 */
.table .nameCell {
  max-width: 130px;
  white-space: normal;
  vertical-align: middle;
}
/* 合并的建筑单元格内纵向排列「建筑名 + 填充此建筑」按钮。
   不能用 overflow:hidden + text-overflow:ellipsis，否则按钮被裁掉；
   建筑名过长时单独省略，按钮始终可见。 */
.nameCellContent {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 5px;
  min-width: 0;
}
.buildingName {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fillButton {
  max-width: 100%;
  white-space: nowrap;
  font-size: 11px;
  line-height: 1.4;
}
/* R30：同一建筑的建筑列 / 覆盖需求列都合并单元格；组间只保留粗线 + 建筑列色条，
   不加交替底色（用户要求：留粗线即可，底色区分去掉）。 */
/* 组间粗线：`.table th, .table td` 是 (0,1,1)，必须带 .table + 双类抬到足够特异性。 */
.table tbody tr.groupStart td {
  border-top: 2px solid var(--rp-skin-border-strong, currentColor);
}
/* 被合并的建筑单元格：垂直居中、左侧 2px 色条标识分组，文字色仍随主题。
   rowspan 单元格会被游戏原生 !important 规则刷成灰底（真机 rgb(240,240,240)），
   必须同样用 !important 才能清掉，避免被误读成「分组底色」。 */
.table .nameCell[rowspan] {
  vertical-align: middle;
  border-left: 2px solid rgb(var(--rp-accent-rgb));
  padding-left: 8px;
  color: var(--rp-skin-ink, currentColor);
  background-color: transparent !important;
}
/* 覆盖需求列同样按建筑合并：垂直居中，并在与「选」列之间保留 2px 竖向边界。
   表头与合并单元格使用同一条边界，避免列顺序调整后两列看起来连在一起。 */
.table .needsHeader {
  border-right: 2px solid var(--rp-skin-border-strong, currentColor) !important;
}
.table .needsCellMerged[rowspan] {
  vertical-align: middle;
  border-right: 2px solid var(--rp-skin-border-strong, currentColor) !important;
  background-color: transparent !important;
}
.dim {
  color: rgb(148, 158, 166);
  margin-left: 4px;
}
.needsCell {
  display: flex;
  gap: 3px;
  flex-wrap: wrap;
}
.needTag {
  display: inline-block;
  padding: 0 4px;
  border-radius: 2px;
  background: rgba(var(--rp-accent-rgb), 0.14);
  color: var(--rp-skin-ink, currentColor);
  font-size: 11px;
}
.sourceCell {
  color: rgb(148, 158, 166);
}
.warn {
  padding: 5px 8px;
  border: 1px solid rgb(247, 166, 0);
  background: rgba(247, 166, 0, 0.1);
  color: rgb(230, 180, 60);
  font-size: 11px;
  border-radius: 2px;
  margin: 6px 0;
}
/* 说明区内的未达标告警：并入 .notes 作第 3 块，色条 .notes::before 以 top/bottom
   相对 .notes padding box，自动延伸到它的底边，2 行 / 3 行星球始终一致（R36）。
   用 .notes .notesWarn 提高特异性（0,2,0）压过裸 .warn（0,1,0），不依赖样式表
   源码顺序（R06）：去掉 8px 水平 padding 与 1px 边框，让文字左缘与上方两段注记
   严格对齐；警示黄底 / 黄字沿用 .warn 既有值，此处只改盒模型、不新增裸色值（R01 / R18）。 */
.notes .notesWarn {
  margin: 5px 0 0;
  padding: 4px 0;
  border: 0;
  border-radius: 0;
  line-height: 1.45;
}
.materialToolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
/* 工具条分组标签（补满范围 / 物料选择）：与「已选 x / y」同色，不抢主按钮的层级。 */
.fillScopeLabel {
  color: rgb(167, 176, 183);
  font-size: 11px;
}
.toolbarDivider {
  width: 1px;
  height: 14px;
  background: rgba(167, 176, 183, 0.35);
  margin: 0 2px;
}
.selectedCount {
  color: rgb(167, 176, 183);
  font-size: 11px;
  margin-left: auto;
}
.buildingGrid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
  gap: 4px;
}
.buildingCell {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding: 3px 6px;
  border: 1px solid rgb(48, 58, 66);
  border-radius: 2px;
  font-size: 11px;
}
.buildingName {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.buildingLevel {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  color: var(--rp-skin-ink, currentColor);
}

/* LR 上一周期运行率对照：两栏等宽、窄面板靠 minmax(0,1fr) 换行（R29/R34）。
   11px 正文（R09）、ink 文字色（R02）、opacity 显式归 1（R10）、不加底色，
   不引入裸色值（R01）。告警跨两栏，避免撑出第三列。 */
.infraAudit {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 14px;
  row-gap: 4px;
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--rp-skin-ink, currentColor);
  opacity: 1;
}
.infraAuditCol {
  min-width: 0;
}
.infraAuditTitle {
  font-weight: 600;
  margin-bottom: 2px;
}
.infraRates {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
}
.infraRate {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.infraAssumption {
  min-width: 0;
  overflow-wrap: anywhere;
}
.infraWarn {
  grid-column: 1 / -1;
  margin-top: 3px;
  color: var(--rp-skin-ink, currentColor);
  opacity: 1;
}
.metaLine {
  color: rgb(148, 158, 166);
  font-size: 11px;
  margin: 6px 0;
}
.table .empty {
  text-align: center;
  padding: 16px 8px;
  color: rgb(167, 176, 183);
}
.emptyState {
  padding: 24px 12px;
  text-align: center;
  color: rgb(167, 176, 183);
  font-size: 12px;
}
.emptyState code {
  color: var(--rp-skin-ink, currentColor);
  font-weight: 600;
}
</style>
