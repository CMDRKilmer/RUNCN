<script setup lang="ts">
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Tooltip from '@src/components/Tooltip.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import PlanetRow from '@src/features/XIT/FLEET/PlanetRow.vue';
import ShipPool from '@src/features/XIT/FLEET/ShipPool.vue';
import InventoryView from '@src/features/XIT/FLEET/InventoryView.vue';
import ChainView from '@src/features/XIT/FLEET/ChainView.vue';
import type { ChainPlannerBase } from '@src/features/XIT/FLEET/chain-planner';
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
import { serializeStorage } from '@src/features/XIT/ACT/actions/utils';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { setBufferSize, showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { userData } from '@src/store/user-data';
import { createId } from '@src/store/create-id';
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
  mergeBills,
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
const panesEl = ref<HTMLElement | null>(null);

// Mode
type ViewMode = 'plan' | 'inventory' | 'chain';
const viewMode = useTileState<ViewMode>('viewMode', 'plan');

// Plan mode state
const baseConfigs = useTileState<Record<string, DispatchBaseConfig>>('baseConfigs', {});
const baseOrder = useTileState<string[]>('baseOrder', []);
const orderedIds = ref<string[]>([]);
const exchangeFilter = useTileState<string | undefined>('exchangeFilter', undefined);
// 执行时同步在 TRIGGER 面板创建一次性到港卸货触发器。
const autoUnloadTrigger = useTileState<boolean>('autoUnloadTrigger', true);
// 自动发船：在每个 OPEN SFC 步骤后追加 DEPART，执行时自动点击「开始」。
const autoLaunch = useTileState<boolean>('autoLaunch', false);

// Column visibility
const showBurn = useTileState('showBurn', true);
const showProd = useTileState('showProd', true);
const showRepair = useTileState('showRepair', true);
const showInv = useTileState('showInv', true);
const showWar = useTileState('showWar', true);

// Sort
type SortKey = 'name' | 'burn' | 'repair';
type SortDirection = 'asc' | 'desc';
const sortKey = useTileState<SortKey>('sortKey', 'burn');
const sortDirection = useTileState<SortDirection>('sortDirection', 'asc');
const planetFilter = ref('');

function setSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDirection.value = 'asc';
  }
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
    if (sortKey.value === 'burn') {
      const daysA = burnDaysRemaining(a.base.siteId);
      const daysB = burnDaysRemaining(b.base.siteId);
      if (daysA !== daysB) {
        return (daysA - daysB) * dir;
      }
    }
    if (sortKey.value === 'repair') {
      return comparePlanets(a.base.naturalId, b.base.naturalId) * dir;
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

// Keep orderedIds in sync with bases + baseOrder.
watchEffect(() => {
  const list = filteredRows.value;
  const present = new Map(list.map(x => [x.base.naturalId, x.base]));
  const ordered: string[] = [];
  for (const id of baseOrder.value) {
    if (present.has(id)) {
      ordered.push(id);
    }
  }
  const orderedSet = new Set(ordered);
  const remaining = list
    .filter(x => !orderedSet.has(x.base.naturalId))
    .map(x => x.base)
    .sort((a, b) => {
      const daysA = burnDaysRemaining(a.siteId);
      const daysB = burnDaysRemaining(b.siteId);
      if (daysA !== daysB) {
        return daysA - daysB;
      }
      return comparePlanets(a.naturalId, b.naturalId);
    })
    .map(x => x.naturalId);
  const next = [...ordered, ...remaining];
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

interface IncludedBase {
  naturalId: string;
  planetName: string;
  site: PrunApi.Site;
  config: DispatchBaseConfig;
  dispatchShip: DispatchShip;
}

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

  const groupNameOf = (base: IncludedBase) => base.planetName || base.naturalId;

  const groups: UserData.MaterialGroupData[] = [];
  const cxBuyActions: UserData.ActionData[] = [];
  const exchangeBills = new Map<string, Record<string, number>>();
  const stagedBases: IncludedBase[] = [];

  for (const base of includedBases.value) {
    const { naturalId, config, dispatchShip } = base;
    const bill = billByBase.value.get(naturalId);
    if (bill === undefined) {
      setNotice(`${base.planetName}: burn 数据未加载，稍后再试`);
      continue;
    }
    if (Object.keys(bill).length === 0) {
      setNotice(`${base.planetName}: 当前库存已满足目标天数，无需补给`);
      continue;
    }

    stagedBases.push(base);

    groups.push({
      type: 'Manual',
      name: groupNameOf(base),
      planet: naturalId,
      materials: bill,
    });

    if (config.cxBuy) {
      const code = dispatchShip.exchangeCode;
      exchangeBills.set(code, mergeBills(exchangeBills.get(code), bill)!);
    }
  }

  if (stagedBases.length === 0) {
    setNotice('所有选中基地当前无需补给或维修');
    return;
  }

  const byShip = new Map<string, IncludedBase[]>();
  for (const base of stagedBases) {
    const shipId = base.config.ship!;
    let list = byShip.get(shipId);
    if (!list) {
      list = [];
      byShip.set(shipId, list);
    }
    list.push(base);
  }

  const multiShipGroups: IncludedBase[][] = [];
  const singleShipBases: IncludedBase[] = [];
  for (const shipBases of byShip.values()) {
    if (shipBases.length >= 2) {
      multiShipGroups.push(shipBases);
    } else {
      singleShipBases.push(shipBases[0]!);
    }
  }

  const mtraActions: UserData.ActionData[] = [];
  const sfcActions: UserData.ActionData[] = [];

  const pushShipMtra = (shipBases: IncludedBase[]) => {
    const first = shipBases[0]!;
    const dispatchShip = first.dispatchShip;
    const shipName = dispatchShip.ship.name ?? dispatchShip.ship.registration;
    const loadName = `装载 ${shipName}`;
    const origin = serializeStorage(dispatchShip.warehouseStore!);
    const dest = serializeStorage(dispatchShip.cargoStore!);

    let materials: Record<string, number> | undefined;
    for (const base of shipBases) {
      const group = groups.find(x => x.name === groupNameOf(base));
      materials = mergeBills(materials, group?.materials);
    }

    groups.push({
      type: 'Manual',
      name: loadName,
      materials: materials!,
    });

    mtraActions.push({ type: 'MTRA', name: loadName, group: loadName, origin, dest });
    sfcActions.push({
      type: 'OPEN SFC',
      name: `卸货 ${shipName}`,
      destination: first.naturalId,
      shipSourceAction: loadName,
    });
    if (autoLaunch.value) {
      sfcActions.push({
        type: 'DEPART',
        name: `出发 ${shipName}`,
        registration: dispatchShip.ship.registration,
      });
    }
  };

  for (const shipBases of multiShipGroups) {
    pushShipMtra(shipBases);
  }

  for (const base of singleShipBases) {
    pushShipMtra([base]);
  }

  for (const [code, materials] of exchangeBills) {
    if (Object.keys(materials).length === 0) {
      continue;
    }
    const groupName = `购买 ${code}`;
    groups.push({
      type: 'Manual',
      name: groupName,
      materials,
    });
    cxBuyActions.push({
      type: 'CX Buy',
      name: groupName,
      group: groupName,
      exchange: code,
      useCXInv: true,
    });
  }

  const pkg: UserData.ActionPackageData = {
    global: { name: '派遣' },
    groups,
    actions: [...cxBuyActions, ...mtraActions, ...sfcActions],
  };

  stagedDispatch.value = {
    pkg: JSON.parse(JSON.stringify(pkg)),
  };
  showBuffer('XIT FLEETACT');

  for (const base of stagedBases) {
    const bill = billByBase.value.get(base.naturalId);
    if (!bill) {
      continue;
    }
    const unloadName = `${base.planetName} Unload`;
    const unloadPkg: UserData.ActionPackageData = {
      global: { name: unloadName },
      autoDelete: true,
      groups: [
        {
          type: 'Manual',
          name: 'Unload',
          materials: bill,
        },
      ],
      actions: [
        {
          type: 'MTRA',
          name: 'Unload',
          group: 'Unload',
          origin: configurableValue,
          dest: `${base.planetName || base.naturalId} Base`,
          originType: 'SHIP_STORE',
        },
      ],
    };
    const existingUnload = userData.actionPackages.find(x => x.global.name === unloadName);
    if (existingUnload) {
      const index = userData.actionPackages.indexOf(existingUnload);
      userData.actionPackages[index] = unloadPkg;
    } else {
      userData.actionPackages.push(unloadPkg);
    }

    // 到港自动卸货：同步创建一次性触发器，飞船到达该基地时执行上方操作包。
    if (autoUnloadTrigger.value) {
      const trigger: UserData.TriggerData = {
        id: createId(),
        name: `${base.planetName} 卸货`,
        enabled: true,
        event: {
          type: 'FLIGHT_ENDED',
          ship: base.dispatchShip.ship.registration,
          planet: base.naturalId,
        },
        packageName: unloadName,
        mode: 'CONFIRM',
        cooldownMin: 60,
        createdAt: Date.now(),
        autoDelete: true,
      };
      const existingTrigger = userData.triggers.find(x => x.packageName === unloadName);
      if (existingTrigger) {
        const index = userData.triggers.indexOf(existingTrigger);
        userData.triggers[index] = trigger;
      } else {
        userData.triggers.push(trigger);
      }
    }
  }
}

function reset() {
  baseConfigs.value = {};
  baseOrder.value = [];
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
  exchangeFilter.value = config.exchangeFilter;
  setNotice('配置已导入');
}
</script>

<template>
  <div :class="$style.layout">
    <!-- Mode toggle -->
    <div :class="[C.ComExOrdersPanel.filter, $style.filterBar]">
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
      <div :class="$style.separator" />
      <template v-if="viewMode === 'plan'">
        <RadioItem
          v-for="option in exchangeFilterOptions"
          :key="option.code"
          :model-value="exchangeFilter === option.code"
          horizontal
          @update:model-value="v => (exchangeFilter = v ? option.code : undefined)">
          {{ option.label }}
        </RadioItem>
        <div :class="$style.separator" />
        <RadioItem v-model="autoLaunch" horizontal>自动发船</RadioItem>
        <div :class="$style.separator" />
        <RadioItem v-model="autoUnloadTrigger" horizontal>到港卸货</RadioItem>
        <div :class="$style.separator" />
        <RadioItem v-model="showBurn" horizontal>消耗</RadioItem>
        <RadioItem v-model="showProd" horizontal>生产</RadioItem>
        <RadioItem v-model="showRepair" horizontal>维修</RadioItem>
        <RadioItem v-model="showInv" horizontal>库存</RadioItem>
        <RadioItem v-model="showWar" horizontal>仓储</RadioItem>
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
          <table :class="$style.table">
            <thead>
              <tr>
                <th :class="[$style.narrowCol, $style.centered]">分配</th>
                <GripHeaderCell />
                <th :class="[$style.narrowCol, $style.centered]">星球</th>
                <th :class="[$style.narrowCol, $style.centered]">补给</th>
                <th :class="[$style.narrowCol, $style.centered]">天数</th>
                <th
                  :class="[$style.narrowCol, $style.centered, $style.sortable]"
                  @click="setSort('burn')">
                  消耗
                  <span :class="sortKey === 'burn' ? $style.sortActive : $style.sortInactive">{{
                    sortKey === 'burn' ? (sortDirection === 'asc' ? '▲' : '▼') : '▲'
                  }}</span>
                </th>
                <th v-if="showProd" :class="[$style.narrowCol, $style.centered]">生产</th>
                <th v-if="showRepair" :class="[$style.narrowCol, $style.centered]">维修</th>
                <th
                  v-if="showRepair"
                  :class="[$style.narrowCol, $style.centered, $style.sortable]"
                  @click="setSort('repair')">
                  维护
                  <span :class="sortKey === 'repair' ? $style.sortActive : $style.sortInactive">{{
                    sortKey === 'repair' ? (sortDirection === 'asc' ? '▲' : '▼') : '▲'
                  }}</span>
                </th>
                <th :class="[$style.narrowCol, $style.centered]">提前</th>
                <th :class="[$style.narrowCol, $style.centered]">装载</th>
                <th :class="[$style.narrowCol, $style.centered]">物资</th>
                <th :class="[$style.narrowCol, $style.centered]">适配</th>
                <th :class="[$style.narrowCol, $style.centered]">CX</th>
                <th :class="[$style.narrowCol, $style.centered]">填满</th>
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

.filterBar {
  flex-wrap: wrap;
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

.sortInactive {
  color: rgb(63, 162, 222);
}

.invHeaderCol {
  width: 67%;
}

.warHeaderCol {
  width: 33%;
}
</style>
