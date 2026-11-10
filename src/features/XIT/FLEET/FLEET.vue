<script setup lang="ts">
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { buildDispatchActionPlan, type IncludedBase } from './dispatch-actions';
import PrunButton from '@src/components/PrunButton.vue';
import Tooltip from '@src/components/Tooltip.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import PlanetRow from '@src/features/XIT/FLEET/PlanetRow.vue';
import ShipPool from '@src/features/XIT/FLEET/ShipPool.vue';
import InventoryView from '@src/features/XIT/FLEET/InventoryView.vue';
import ChainView from '@src/features/XIT/FLEET/ChainView.vue';
import type { ChainPlannerBase } from '@src/features/XIT/FLEET/chain-types';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { getBaseStorageAnalysis } from '@src/core/storage-analysis';
import type { BaseStorageAnalysis } from '@src/core/storage-analysis';
import { comparePlanets } from '@src/core/game-lookups';
import { useTileState } from '@src/store/user-data-tiles';
import { normalizeDispatchBaseConfigs } from '@src/store/user-data-migrations';
import { getPlanetBurn, getResupplyDays } from '@src/core/burn';
import { countDays } from '@src/features/XIT/BURN/utils';
import { setBufferSize, showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { userData } from '@src/store/user-data';
import { stagedDispatch } from '@src/features/XIT/FLEET/staged';
import { vDraggable } from 'vue-draggable-plus';
import { grip } from '@src/components/grip';
import GripHeaderCell from '@src/components/grip/GripHeaderCell.vue';
import { useTile } from '@src/hooks/use-tile';
import fa from '@src/utils/font-awesome.module.css';
import {
  DispatchBaseConfig,
  DispatchShip,
  billTotals,
  combinedBaseBill,
  fitDaysForShip,
  getShipsAtCX,
  regroupByShip,
} from '@src/features/XIT/FLEET/utils';

interface BaseEntry {
  siteId: string;
  naturalId: string;
  planetName: string;
  site: PrunApi.Site;
  storeId: string;
  warehouseStoreId?: string;
}

const exchangeFilterOptions: { label: string; code: string }[] = [
  { label: 'ANT', code: 'AI1' },
  { label: 'HRT', code: 'IC1' },
  { label: 'MOR', code: 'NC1' },
  { label: 'BEN', code: 'CI1' },
];

// 加油不在 FLEET 处理：XIT TRIGGER 面板已提供独立的自动加油触发器，
// 重复加油会让仓库循环抽料。故 FLEET 不再保留 refuel 配置与包动作。

const tile = useTile();
// 嵌在其他面板里（例如 FB）时可以收紧「分配」列，独立使用时保持原样。
const props = defineProps<{ compactShip?: boolean }>();
const panesEl = ref<HTMLElement | null>(null);

// Mode
type ViewMode = 'plan' | 'inventory' | 'chain';
const viewMode = useTileState<ViewMode>('viewMode', 'plan');

// Plan mode state
const baseConfigs = useTileState<Record<string, DispatchBaseConfig>>('baseConfigs', {});
const baseOrder = useTileState<string[]>('baseOrder', []);
// 默认按列头排序；用户拖过行之后只认手动顺序，再点列头又回到自动排序。
// 没有这个开关时 baseOrder（拖拽 / 飞船分组写入）会永久覆盖列排序。
const manualOrder = useTileState<boolean>('manualOrder', false);
const orderedIds = ref<string[]>([]);
const exchangeFilter = useTileState<string | undefined>('exchangeFilter', undefined);
// 执行时同步在 TRIGGER 面板创建一次性到港卸货触发器。
const autoUnloadTrigger = useTileState<boolean>('autoUnloadTrigger', true);
// 自动发船：在每个 OPEN SFC 步骤后追加 DEPART，执行时自动点击「开始」。
const autoLaunch = useTileState<boolean>('autoLaunch', false);

// Column visibility。「消耗」列常驻且可排序，因此不提供开关；
// 「维修」开关同时控制 维修 / 维护 / 提前 三列。
const showProd = useTileState('showProd', true);
const showRepair = useTileState('showRepair', true);
const showInv = useTileState('showInv', true);
const showWar = useTileState('showWar', true);
const showFill = useTileState('showFill', true);

// Sort：只有「消耗」列可排序（按剩余天数），点表头切换升/降序。
// 「维护」列是普通表头，不再有排序按钮，也不参与排序。
type SortDirection = 'asc' | 'desc';
const sortDirection = useTileState<SortDirection>('sortDirection', 'asc');
const planetFilter = ref('');

function toggleBurnSort() {
  sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
  // 点列头即要求按这一列重排，放弃手动拖拽 / 飞船分组固化的顺序。
  manualOrder.value = false;
  baseOrder.value = [];
}

function createBaseConfig(naturalId: string): DispatchBaseConfig {
  return {
    resupply: true,
    repair: false,
    days: getResupplyDays(naturalId) ?? 10,
    repAdvance: 'now',
    consumablesOnly: true,
    includeConsumables: true,
    cxBuy: true,
  };
}

function burnDaysRemaining(siteId: string) {
  const burn = getPlanetBurn(siteId);
  return burn ? countDays(burn.burn) : Infinity;
}

const bases = computed<BaseEntry[] | undefined>(() => {
  const sites = sitesStore.all.value;
  if (!sites) {
    return undefined;
  }

  return sites
    .map(site => {
      const naturalId = getEntityNaturalIdFromAddress(site.address) ?? '';
      const baseStore = storagesStore.getByAddressableId(site.siteId)?.[0];
      const warehouse = warehousesStore.getByEntityNaturalId(naturalId);
      const warehouseStore = warehouse
        ? storagesStore
            .getByAddressableId(warehouse.warehouseId)
            ?.find(x => x.type === 'WAREHOUSE_STORE')
        : undefined;
      return {
        siteId: site.siteId,
        naturalId,
        planetName: getEntityNameFromAddress(site.address) ?? '',
        site,
        storeId: baseStore?.id ?? '',
        warehouseStoreId: warehouseStore?.id,
      };
    })
    .filter(x => x.naturalId);
});

// Storage analyses for expandable detail
const baseAnalyses = computed<Map<string, BaseStorageAnalysis> | undefined>(() => {
  const sites = sitesStore.all.value;
  if (!sites) {
    return undefined;
  }
  const map = new Map<string, BaseStorageAnalysis>();
  for (const site of sites) {
    const analysis = getBaseStorageAnalysis(site);
    if (analysis) {
      map.set(analysis.naturalId, analysis);
    }
  }
  return map;
});

// Fill in configs for bases that do not have one yet.
// Legacy config shapes are normalized by the user data migrations,
// and on import by importDispatchConfig.
watchEffect(() => {
  const list = bases.value;
  if (!list) {
    return;
  }
  let next = baseConfigs.value;
  let changed = false;
  for (const base of list) {
    if (next[base.naturalId] === undefined) {
      if (!changed) {
        next = { ...next };
        changed = true;
      }
      next[base.naturalId] = createBaseConfig(base.naturalId);
    }
  }
  if (changed) {
    baseConfigs.value = next;
  }
});

// Bases paired with their configs; configs are filled by the watcher above.
const rows = computed(() =>
  (bases.value ?? [])
    .map(base => ({ base, config: baseConfigs.value[base.naturalId] }))
    .filter(x => x.config !== undefined),
);

// 产业链环线模式的基地输入（天数等配置沿用规划模式的 baseConfigs）。
const chainBases = computed<ChainPlannerBase[]>(() =>
  rows.value.map(({ base, config }) => ({
    siteId: base.siteId,
    naturalId: base.naturalId,
    planetName: base.planetName,
    site: base.site,
    config,
  })),
);

// Filtered and sorted rows
const filteredRows = computed(() => {
  let result = rows.value;

  const filter = planetFilter.value.trim().toUpperCase();
  if (filter) {
    result = result.filter(
      x =>
        x.base.naturalId.toUpperCase().includes(filter) ||
        x.base.planetName.toUpperCase().includes(filter),
    );
  }

  const dir = sortDirection.value === 'asc' ? 1 : -1;
  return [...result].sort((a, b) => {
    const daysA = burnDaysRemaining(a.base.siteId);
    const daysB = burnDaysRemaining(b.base.siteId);
    if (daysA !== daysB) {
      // 两边都是 Infinity 时做减法会得到 NaN，比较器失效等于没排序。
      return (daysA < daysB ? -1 : 1) * dir;
    }
    return comparePlanets(a.base.naturalId, b.base.naturalId) * dir;
  });
});

const filteredNaturalIds = computed(() => new Set(filteredRows.value.map(x => x.base.naturalId)));

// Size the window body to content width after the first data render.
const stopWidthWatch = watch(
  [() => filteredRows.value.length, panesEl],
  async ([length, panes]) => {
    if (length === 0 || !panes) {
      return;
    }
    stopWidthWatch();
    await nextTick();
    const windowEl = tile.frame.closest(`.${C.Window.window}`) as HTMLElement | null;
    const bodyEl = windowEl ? (_$(windowEl, C.Window.body) as HTMLElement | null) : null;
    if (!bodyEl) {
      return;
    }
    let contentWidth = 0;
    for (const child of Array.from(panes.children)) {
      contentWidth += (child as HTMLElement).offsetWidth;
    }
    if (panes.scrollWidth > panes.clientWidth) {
      contentWidth = panes.scrollWidth;
    }
    const chrome = bodyEl.offsetWidth - panes.clientWidth;
    const width = Math.min(contentWidth + chrome, window.innerWidth - 60);
    const parsedHeight = parseInt(bodyEl.style.height, 10);
    const height = isNaN(parsedHeight) ? 500 : parsedHeight;
    setBufferSize(tile.id, width, height);
  },
);

const rowById = computed(() => {
  const map = new Map<string, { base: BaseEntry; config: DispatchBaseConfig }>();
  for (const row of rows.value) {
    map.set(row.base.naturalId, { base: row.base, config: row.config! });
  }
  return map;
});

// Per-base resupply+repair bill.
const billByBase = computed(() => {
  const map = new Map<string, Record<string, number>>();
  for (const { base, config } of rows.value) {
    if (!config.resupply && !config.repair) {
      continue;
    }
    const bill = combinedBaseBill(base.naturalId, config, base.site);
    if (bill) {
      map.set(base.naturalId, bill);
    }
  }
  return map;
});

// Keep orderedIds in sync with the active ordering mode.
// 自动模式：行序就是 filteredRows 的列排序结果，点列头 / 天数变化都会即时反映。
// 手动模式：baseOrder 里的排前面，其余缺失基地沿用 filteredRows 的顺序补在后面。
watchEffect(() => {
  const list = filteredRows.value;
  const ids = list.map(x => x.base.naturalId);
  let next: string[];
  if (!manualOrder.value) {
    next = ids;
  } else {
    const present = new Set(ids);
    const ordered = baseOrder.value.filter(id => present.has(id));
    const orderedSet = new Set(ordered);
    const remaining = ids.filter(id => !orderedSet.has(id));
    next = [...ordered, ...remaining];
  }
  if (next.length !== orderedIds.value.length || next.some((id, i) => id !== orderedIds.value[i])) {
    orderedIds.value = next;
  }
});

// Ship assignment grouping.
const shipAssignments = computed(() => {
  const map = new Map<string, string>();
  for (const row of rows.value) {
    if (row.config?.ship) {
      map.set(row.base.naturalId, row.config.ship);
    }
  }
  return map;
});

watch(shipAssignments, map => {
  // 自动排序模式下不按飞船重新分组，否则会把刚排好的列顺序又打乱。
  if (!manualOrder.value) {
    return;
  }
  const next = regroupByShip(orderedIds.value, map);
  if (next.some((id, i) => id !== orderedIds.value[i])) {
    orderedIds.value = next;
    baseOrder.value = next;
  }
});

const dragOptions = {
  ...grip.draggable,
  onEnd: (evt: unknown) => {
    grip.draggable.onEnd?.(evt as never);
    manualOrder.value = true;
    baseOrder.value = [...orderedIds.value];
  },
};

const dragBinding = [orderedIds, dragOptions];

const cxShips = computed(() => getShipsAtCX() ?? []);

const filteredCxShips = computed(() =>
  exchangeFilter.value
    ? cxShips.value.filter(x => x.exchangeCode === exchangeFilter.value)
    : cxShips.value,
);

const cxShipById = computed(() => {
  const map = new Map<string, DispatchShip>();
  for (const entry of cxShips.value) {
    map.set(entry.ship.id, entry);
  }
  return map;
});

const overloadedShips = computed(() => {
  const totals = new Map<string, { weight: number; volume: number }>();
  for (const { base, config } of rows.value) {
    if (!config.ship || (!config.resupply && !config.repair)) {
      continue;
    }
    const bill = billByBase.value.get(base.naturalId);
    if (!bill) {
      continue;
    }
    const billT = billTotals(bill);
    const acc = totals.get(config.ship) ?? { weight: 0, volume: 0 };
    acc.weight += billT.weight;
    acc.volume += billT.volume;
    totals.set(config.ship, acc);
  }
  const result = new Set<string>();
  for (const [shipId, t] of totals) {
    const store = cxShipById.value.get(shipId)?.cargoStore;
    if (!store) {
      continue;
    }
    if (
      t.weight > store.weightCapacity - store.weightLoad ||
      t.volume > store.volumeCapacity - store.volumeLoad
    ) {
      result.add(shipId);
    }
  }
  return result;
});

const hasAssignedShip = computed(() => {
  const list = bases.value;
  if (!list) {
    return false;
  }
  for (const base of list) {
    const config = baseConfigs.value[base.naturalId];
    if (config?.ship && cxShipById.value.has(config.ship)) {
      return true;
    }
  }
  return false;
});

const executeTooltip = computed(() => {
  if (!hasAssignedShip.value) {
    return '请先为至少一个基地分配船只';
  }
  if (overloadedShips.value.size > 0) {
    return '有船只装载超过容量';
  }
  return undefined;
});

const includedBases = computed(() => {
  const result: IncludedBase[] = [];
  for (const id of orderedIds.value) {
    const row = rowById.value.get(id);
    if (!row) {
      continue;
    }
    const { base, config } = row;
    if (!config.ship || (!config.resupply && !config.repair)) {
      continue;
    }
    const dispatchShip = cxShipById.value.get(config.ship);
    if (!dispatchShip?.warehouseStore || !dispatchShip.cargoStore) {
      continue;
    }
    result.push({
      naturalId: base.naturalId,
      planetName: base.planetName,
      site: base.site,
      config,
      dispatchShip,
    });
  }
  return result;
});

function fitBase(naturalId: string) {
  const config = baseConfigs.value[naturalId];
  if (!config?.ship) {
    return;
  }
  const dispatchShip = cxShipById.value.get(config.ship);
  if (!dispatchShip?.cargoStore) {
    return;
  }

  const sharingBases = rows.value.map(x => ({
    naturalId: x.base.naturalId,
    config: x.config!,
    site: x.base.site,
  }));

  const days = fitDaysForShip(config.ship, sharingBases, dispatchShip.cargoStore);
  if (days === undefined) {
    return;
  }

  for (const base of sharingBases) {
    if (base.config.ship === config.ship && base.config.resupply) {
      base.config.days = days;
    }
  }
}

function execute() {
  if (includedBases.value.length === 0) {
    setNotice('无可执行基地：请先在表格中分配船只');
    return;
  }
  if (overloadedShips.value.size > 0) {
    setNotice('有船只装载超过容量，已阻止执行');
    return;
  }

  const plan = buildDispatchActionPlan(includedBases.value, billByBase.value, {
    autoLaunch: autoLaunch.value,
    autoUnload: autoUnloadTrigger.value,
  });
  if (plan.notices.length > 0) {
    setNotice(plan.notices.join('；'));
  }
  if (plan.pkg === undefined) {
    return;
  }
  for (const pkg of plan.unloadPackages) {
    const index = userData.actionPackages.findIndex(x => x.global.name === pkg.global.name);
    if (index >= 0) {
      userData.actionPackages[index] = pkg;
    } else {
      userData.actionPackages.push(pkg);
    }
  }
  for (const trigger of plan.triggers) {
    const index = userData.triggers.findIndex(x => x.packageName === trigger.packageName);
    if (index >= 0) {
      userData.triggers[index] = trigger;
    } else {
      userData.triggers.push(trigger);
    }
  }
  stagedDispatch.value = { pkg: JSON.parse(JSON.stringify(plan.pkg)) };
  showBuffer('XIT FLEETACT');
}

function reset() {
  baseConfigs.value = {};
  baseOrder.value = [];
  manualOrder.value = false;
}

const dispatchConfigType = 'rp-dispatch-config';

interface DispatchConfigPayload {
  baseConfigs?: Record<string, DispatchBaseConfig>;
  baseOrder?: string[];
  exchangeFilter?: string;
}

const notice = ref<string | undefined>(undefined);
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function setNotice(text: string) {
  notice.value = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = undefined;
  }, 3000);
}

function collectDispatchConfig(): DispatchConfigPayload {
  return {
    baseConfigs: JSON.parse(JSON.stringify(baseConfigs.value)),
    baseOrder: [...baseOrder.value],
    exchangeFilter: exchangeFilter.value,
  };
}

onUnmounted(() => clearTimeout(noticeTimer));

async function exportDispatchConfig() {
  const json = JSON.stringify({ type: dispatchConfigType, data: collectDispatchConfig() });
  try {
    await navigator.clipboard.writeText(json);
  } catch {
    setNotice('复制失败');
    return;
  }
  setNotice('配置已复制到剪贴板');
}

function extractDispatchConfig(parsed: unknown): DispatchConfigPayload | undefined {
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  const root = parsed as Record<string, unknown>;
  if (root.type === dispatchConfigType && root.data && typeof root.data === 'object') {
    return root.data as DispatchConfigPayload;
  }
  if (root.type === 'rp-user-data' && root.data && typeof root.data === 'object') {
    const userData = root.data as { tileState?: Record<string, unknown> };
    for (const state of Object.values(userData.tileState ?? {})) {
      if (state && typeof state === 'object' && 'baseConfigs' in state) {
        return state as DispatchConfigPayload;
      }
    }
  }
  return undefined;
}

async function importDispatchConfig() {
  let clipText: string;
  try {
    clipText = await navigator.clipboard.readText();
  } catch {
    setNotice('无法读取剪贴板');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(clipText);
  } catch {
    setNotice('剪贴板内容不是有效的 JSON');
    return;
  }
  const config = extractDispatchConfig(parsed);
  if (!config) {
    setNotice('剪贴板内容不是 FLEET 配置');
    return;
  }
  const configs = config.baseConfigs ?? {};
  normalizeDispatchBaseConfigs(configs);
  baseConfigs.value = configs;
  baseOrder.value = config.baseOrder ?? [];
  manualOrder.value = (config.baseOrder?.length ?? 0) > 0;
  exchangeFilter.value = config.exchangeFilter;
  setNotice('配置已导入');
}
</script>

<template>
  <div :class="$style.layout">
    <!-- 顶部工具栏分两行：第一行是视图模式、列开关与操作按钮（右上按钮位置不变）；
         第二行放交易所筛选与发船 / 卸货开关。 -->
    <div :class="[C.ComExOrdersPanel.filter, $style.filterBar]">
      <div :class="$style.filterRow">
        <RadioItem
          :model-value="viewMode === 'plan'"
          horizontal
          @update:model-value="viewMode = 'plan'">
          基地规划
        </RadioItem>
        <RadioItem
          :model-value="viewMode === 'inventory'"
          horizontal
          @update:model-value="viewMode = 'inventory'">
          库存总览
        </RadioItem>
        <RadioItem
          :model-value="viewMode === 'chain'"
          horizontal
          @update:model-value="viewMode = 'chain'">
          产业链环线
        </RadioItem>
        <template v-if="viewMode === 'plan'">
          <div :class="$style.separator" />
          <RadioItem v-model="showProd" horizontal>生产</RadioItem>
          <RadioItem v-model="showRepair" horizontal>维修</RadioItem>
          <RadioItem v-model="showInv" horizontal>库存</RadioItem>
          <RadioItem v-model="showWar" horizontal>仓储</RadioItem>
          <RadioItem v-model="showFill" horizontal>填满</RadioItem>
          <div :class="$style.searchContainer">
            <TextInput v-model="planetFilter" />
            <PrunButton
              v-if="planetFilter"
              dark
              :class="[fa.solid, $style.clearButton]"
              @click="planetFilter = ''">
              {{ '' }}
            </PrunButton>
          </div>
          <PrunButton dark @click="exportDispatchConfig">导出配置</PrunButton>
          <PrunButton dark @click="importDispatchConfig">导入配置</PrunButton>
          <span v-if="notice" :class="$style.notice">{{ notice }}</span>
          <div :class="$style.spacer" />
          <PrunButton dark @click="reset">重置</PrunButton>
          <Tooltip v-if="executeTooltip" position="top" :tooltip="executeTooltip" no-icon>
            <PrunButton primary :disabled="overloadedShips.size > 0" @click="execute">
              执行
            </PrunButton>
          </Tooltip>
          <PrunButton v-else primary :disabled="overloadedShips.size > 0" @click="execute">
            执行
          </PrunButton>
        </template>
      </div>
      <div v-if="viewMode === 'plan'" :class="$style.filterRow">
        <span :class="$style.rowLabel">出发CX：</span>
        <RadioItem
          v-for="option in exchangeFilterOptions"
          :key="option.code"
          :model-value="exchangeFilter === option.code"
          horizontal
          @update:model-value="v => (exchangeFilter = v ? option.code : undefined)">
          {{ option.label }}
        </RadioItem>
        <div :class="$style.separator" />
        <!-- 自动发船 / 到港卸货 属同一组，中间不放分隔线，
             只沿用 .filterRow 的 3px gap，与第一行同组选项一致。 -->
        <RadioItem v-model="autoLaunch" horizontal>自动发船</RadioItem>
        <RadioItem v-model="autoUnloadTrigger" horizontal>到港卸货</RadioItem>
      </div>
    </div>

    <!-- Inventory mode -->
    <InventoryView v-if="viewMode === 'inventory'" />

    <!-- Chain loop mode -->
    <ChainView v-else-if="viewMode === 'chain'" :ships="filteredCxShips" :bases="chainBases" />

    <!-- Plan mode -->
    <template v-else>
      <LoadingSpinner v-if="bases === undefined" />
      <div v-else ref="panesEl" :class="$style.panes">
        <ShipPool :ships="filteredCxShips" :base-configs="baseConfigs" />
        <div :class="$style.left">
          <table :class="[$style.table, props.compactShip && $style.compactShip]">
            <thead>
              <tr>
                <th :class="[$style.narrowCol, $style.centered]">分配</th>
                <GripHeaderCell />
                <th :class="[$style.narrowCol, $style.centered]">星球</th>
                <th :class="[$style.narrowCol, $style.centered]">补给</th>
                <th :class="[$style.narrowCol, $style.centered]">天数</th>
                <th
                  :class="[$style.narrowCol, $style.centered, $style.sortable]"
                  @click="toggleBurnSort()">
                  消耗
                  <span :class="$style.sortActive">{{ sortDirection === 'asc' ? '▲' : '▼' }}</span>
                </th>
                <th v-if="showProd" :class="[$style.narrowCol, $style.centered]">生产</th>
                <th v-if="showRepair" :class="[$style.narrowCol, $style.centered]">维修</th>
                <th v-if="showRepair" :class="[$style.narrowCol, $style.centered]">维护</th>
                <th v-if="showRepair" :class="[$style.narrowCol, $style.centered]">提前</th>
                <th :class="[$style.narrowCol, $style.centered]">装载</th>
                <th :class="[$style.narrowCol, $style.centered]">物资</th>
                <th :class="[$style.narrowCol, $style.centered]">适配</th>
                <th :class="[$style.narrowCol, $style.centered]">CX</th>
                <th v-if="showFill" :class="[$style.narrowCol, $style.centered]">填满</th>
                <th v-if="showInv" :class="$style.invHeaderCol">库存</th>
                <th v-if="showWar" :class="$style.warHeaderCol">仓储</th>
              </tr>
            </thead>
            <tbody v-draggable="dragBinding">
              <template v-for="id in orderedIds" :key="id">
                <PlanetRow
                  v-if="filteredNaturalIds.has(id) && rowById.get(id)"
                  :site-id="rowById.get(id)!.base.siteId"
                  :natural-id="rowById.get(id)!.base.naturalId"
                  :config="rowById.get(id)!.config"
                  :bill="billByBase.get(id)"
                  :store-id="rowById.get(id)!.base.storeId"
                  :warehouse-store-id="rowById.get(id)!.base.warehouseStoreId"
                  :analysis="baseAnalyses?.get(rowById.get(id)!.base.naturalId)"
                  :show-prod="showProd"
                  :show-repair="showRepair"
                  :show-inv="showInv"
                  :show-war="showWar"
                  :show-fill="showFill"
                  :overloaded="
                    !!rowById.get(id)!.config.ship &&
                    overloadedShips.has(rowById.get(id)!.config.ship!)
                  "
                  @fit="fitBase(rowById.get(id)!.base.naturalId)" />
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </template>
  </div>
</template>

<style module>
.layout {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  height: 100%;
  /* 窗口高度固定：不随内容变高，也不在根上产生内层滚动条；
     各模式（基地规划/库存/环线）的列表区自行在剩余高度内滚动。 */
  overflow: hidden;
}

.spacer {
  flex: 1;
}

/* 顶部工具栏固定两行；右上「重置 / 执行」仍由 .spacer 推在第一行最右。 */
.filterBar {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  flex-wrap: nowrap;
  gap: 2px;
}

.filterRow {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 3px;
  width: 100%;
  min-width: 0;
}

/* 第二行交易所组的说明文字。字号与 RadioItem 对齐（全局 11px），
   颜色不写死、继承工具栏文字色，三套主题与原样主题都能自动跟随。 */
.rowLabel {
  flex: 0 0 auto;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  margin-right: 4px;
}

.separator {
  width: 1px;
  align-self: stretch;
  background-color: #2b485a;
  margin: 0 0.25rem;
}

.notice {
  white-space: nowrap;
  margin: 0 0.25rem;
  color: #8a9aa8;
}

.searchContainer {
  display: flex;
  align-items: center;
}

.searchContainer :global(input) {
  background-color: #42361d;
  border-width: 0 0 1px;
  border-bottom: 1px solid #8d6411;
  color: #cccccc;
  padding: 0 5px;
  width: 80px;
}

.searchContainer :global(input:focus) {
  outline: none;
}

.clearButton {
  display: flex;
  justify-content: center;
  align-items: center;
  margin-left: 2px;
  width: 18px;
  height: 18px;
  font-size: 11px;
}

.panes {
  display: flex;
  flex-direction: row;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  width: 100%;
  overflow: auto;
}

/* 细窄深色滚动条（游戏/项目风格） */
.panes {
  scrollbar-width: thin;
  scrollbar-color: rgb(61, 74, 84) rgb(26, 33, 38);
}

.panes::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.panes::-webkit-scrollbar-track {
  background: rgb(26, 33, 38);
}

.panes::-webkit-scrollbar-thumb {
  background: rgb(61, 74, 84);
  border-radius: 4px;
}

.panes::-webkit-scrollbar-thumb:hover {
  background: rgb(90, 105, 118);
}

.left {
  flex: 1 1 auto;
  min-width: 0;
}

.table {
  border-collapse: collapse;
}

/* 收紧「分配」列：船名不会太长，6 个汉字左右够用，超长省略号。 */
.compactShip td:first-child > div {
  width: 64px;
  max-width: 64px;
  min-width: 0;
  overflow: hidden;
}

.compactShip td:first-child > div > button {
  min-width: 0;
  overflow: hidden;
}

.compactShip td:first-child span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.table thead tr {
  border-bottom: 1px solid #2b485a;
  box-sizing: border-box;
}

.narrowCol {
  width: 0;
  white-space: nowrap;
}

.centered {
  text-align: center;
}

.sortable {
  cursor: pointer;
  user-select: none;
}

.sortActive {
  color: rgb(171, 198, 128);
  font-weight: bold;
}

.invHeaderCol {
  width: 67%;
  white-space: nowrap;
}

.warHeaderCol {
  width: 33%;
  /* 只打开「仓储」时表格里没有 67% 的库存列，十几个 .narrowCol(width:0) 会把
     这一列挤到不足两个汉字宽，「仓储」折成上下两行，表头行变高、表体随之下移
     一格。nowrap 把 min-content 抬到两字宽，auto 布局就会给足宽度，行高恒定。 */
  min-width: 28px;
  white-space: nowrap;
}
</style>
