<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import GripCell from '@src/components/grip/GripCell.vue';
import InvBar from '@src/features/XIT/FLEET/InvBar.vue';
import BaseAlias from '@src/components/BaseAlias.vue';
import Tooltip from '@src/components/Tooltip.vue';
import { getPlanetBurn } from '@src/core/burn';
import { countDays } from '@src/features/XIT/BURN/utils';
import { getPlanetRepairAge } from '@src/features/XIT/REP/entries';
import { calculateSiteOptimalDay, calcRepairCostTotal } from '@src/core/repair-plan';
import { getBuildingBuildMaterials, isRepairableBuilding } from '@src/core/buildings';
import { getBuildingLastRepair } from '@src/infrastructure/prun-api/data/sites';
import { timestampEachMinute } from '@src/utils/dayjs';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { fixed0 } from '@src/utils/format';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { selectAddress } from '@src/infrastructure/prun-ui/utils/select-address';
import { getPlanetProduction } from '@src/core/production';
import { sumBy } from '@src/utils/sum-by';
import { getStorageAlarmLevel } from '@src/core/storage-analysis';
import type { BaseStorageAnalysis } from '@src/core/storage-analysis';
import { clampDaysInput, normalizeSuppliesCap } from '@src/features/XIT/FLEET/supplies-cap';
import type { DispatchBaseConfig } from '@src/features/XIT/FLEET/utils';
import { billTotals, burnDaysClass, formatBurnDays } from '@src/features/XIT/FLEET/utils';

const {
  siteId,
  naturalId,
  config,
  overloaded,
  bill,
  showProd,
  showRepair,
  showInv,
  showWar,
  storeId,
  warehouseStoreId,
  analysis,
} = defineProps<{
  siteId: string;
  naturalId: string;
  config: DispatchBaseConfig;
  overloaded: boolean;
  bill?: Record<string, number>;
  showProd: boolean;
  showRepair: boolean;
  showInv: boolean;
  showWar: boolean;
  storeId: string;
  warehouseStoreId?: string;
  analysis?: BaseStorageAnalysis;
}>();

const emit = defineEmits<{
  fit: [];
}>();

const canFit = computed(() => !!config.ship);

const burn = computed(() => getPlanetBurn(siteId));
const days = computed(() => (burn.value ? countDays(burn.value.burn) : undefined));

// 天数输入为「总目标天数」(补到第 N 天),与 BURN/ACT Resupply 语义一致:
// 不得超过 suppliesCapDays(下次到港前仓储不超限反算,含产出累积,防止补给填满
// 仓库导致产出无处存放);不耦合全局推荐项。
// computeResupplyBill 按同一上限逐物料截断,此处钳制输入使其与账单一致。
// cap <= 0 时不动 days（保留用户输入）:cap=0 表示仓储已被产出堆满、确实不需要补给,
// 但被 active change watch 钳成 0 会阻止后续 cap 上调后用户天数恢复。
watch(
  [() => config.days, () => analysis?.suppliesCapDays],
  ([daysVal, capDays]) => {
    // 截断到上限,向下取两位小数(与适配 fitDaysForShip 的精度一致)。
    config.days = clampDaysInput(daysVal, capDays);
  },
  { immediate: true },
);

const burnBgClass = computed(() => (days.value === undefined ? {} : burnDaysClass(days.value)));

const daysText = computed(() => (days.value === undefined ? '-' : formatBurnDays(days.value)));

const repairAge = computed(() => getPlanetRepairAge(siteId, timestampEachMinute.value));

// 维修列三色:沿用原 REPP 模型语义(基于整站 economic sweep 的 optimalDay)。
//   age ≥ optimalDay            → 红 (daysMissing,已到触发)
//   optimalDay − 3 ≤ age < optimalDay → 黄 (daysWarning,警告期)
//   age < optimalDay − 3        → 绿 (daysSupplied,健康)
const REPAIR_WARN_OFFSET = 3;
const optimalDay = computed(() => calculateSiteOptimalDay(siteId));
const repairBgClass = computed(() => {
  const age = repairAge.value;
  const od = optimalDay.value;
  if (age === undefined || od === undefined) {
    return {};
  }
  const d = Math.floor(age);
  if (d >= od) {
    return { [C.Workforces.daysMissing]: true };
  }
  if (d >= od - REPAIR_WARN_OFFSET) {
    return { [C.Workforces.daysWarning]: true };
  }
  return { [C.Workforces.daysSupplied]: true };
});

const repairDaysText = computed(() => {
  const age = repairAge.value;
  if (age === undefined) {
    return '-';
  }
  return String(Math.floor(age));
});

// 维修列悬浮框:只显示整站当前维修价格。
// 严格照搬 PRUNplanner 公式 RepairAmount(material, age) = input − floor(input × (180 − min(180, age)) / 180),
// 基于全建材料 × 当前 age 推算需要补充的材料量,再乘以 BUY 价。
// 旧版用 building.repairMaterials 是 PrUn API 给的"最近一次实际剩余维修量",
// 与当前 age 应维修量可能不一致(玩家可能从来没修过满)。
const repairTooltip = computed(() => {
  const site = sitesStore.getById(siteId);
  if (!site) {
    return undefined;
  }
  const now = timestampEachMinute.value;
  let totalRepairCost = 0;
  let hasPrice = false;
  for (const building of site.platforms.filter(isRepairableBuilding)) {
    const fullMaterials = getBuildingBuildMaterials(building, site);
    if (fullMaterials.length === 0) {
      continue;
    }
    const ageDays = Math.max(0, (now - getBuildingLastRepair(building)) / 86400000);
    const cost = calcRepairCostTotal(ageDays, fullMaterials);
    if (cost !== undefined) {
      totalRepairCost += cost;
      hasPrice = true;
    }
  }
  return hasPrice ? `${fixed0(totalRepairCost)} €` : '--';
});

const fillText = computed(() => {
  const days = analysis?.daysUntilFull;
  if (days === undefined || !isFinite(days)) {
    return '∞';
  }
  return formatBurnDays(days);
});

// 补给天数输入框悬浮提示:输入为「总目标天数」(补到第 N 天),
// 不得超过 suppliesCapDays(下次到港前仓储不超限反算)。
// inputDaysCap 与 watch 共用钳制公式,绑定到 NumberInput 的 max 以约束浏览器原生箭头。
const inputDaysCap = computed(() => {
  const cap = normalizeSuppliesCap(analysis?.suppliesCapDays);
  return Math.max(0, cap);
});

const daysTooltip = computed(() => {
  const capDays = analysis?.suppliesCapDays;
  if (capDays === undefined) {
    return '天数上限: -- (仓储分析未加载)';
  }
  if (!isFinite(capDays)) {
    return '天数上限: ∞ 天 (补给后总天数无上限)';
  }
  if (capDays <= 0) {
    return '天数上限: 0 天 (基地无可用补给空间)';
  }
  return `天数上限: ${formatBurnDays(capDays)} 天 (补给后总天数不超过此值,防止撑爆仓库)`;
});

const fillBgClass = computed(() => {
  if (!storageAlarm.value) {
    return {};
  }
  switch (storageAlarm.value.level) {
    case 'red':
      return { [C.Workforces.daysMissing]: true };
    case 'yellow':
      return { [C.Workforces.daysWarning]: true };
    default:
      return { [C.Workforces.daysSupplied]: true };
  }
});

const loadText = computed(() => {
  if (!config.resupply && !config.repair) {
    return '--';
  }
  if (!bill) {
    return '--';
  }
  const totals = billTotals(bill);
  return `${fixed0(totals.weight)}t - ${fixed0(totals.volume)}m³`;
});

const assignedShip = computed(() => (config.ship ? shipsStore.getById(config.ship) : undefined));

const shipLabel = computed(
  () => assignedShip.value?.name ?? assignedShip.value?.registration ?? config.ship,
);

const dragOver = ref(false);

function onDragEnter(event: DragEvent) {
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer!.dropEffect = 'copy';
  dragOver.value = true;
}

function onDragOver(event: DragEvent) {
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer!.dropEffect = 'copy';
  dragOver.value = true;
}

function onDragLeave() {
  dragOver.value = false;
}

function onDrop(event: DragEvent) {
  event.preventDefault();
  event.stopPropagation();
  dragOver.value = false;
  const shipId = event.dataTransfer?.getData('text/plain');
  if (!shipId) {
    return;
  }

  setTimeout(() => {
    config.ship = shipId;
  }, 0);
}

function clearShip() {
  config.ship = undefined;
}

// 点击基地行时：若当前有正在聚焦/打开的游戏原生 AddressSelector（如 SFC 目的地框），
// 则直接将该基地填入该框；否则维持现状打开 BS 命令。
// PrUn 不会让地址框 <input> 成为 document.activeElement——焦点停留在 tile 根部的
// tabindex="-1" 容器上，所以 activeElement 方案永远拿不到地址框。
// 改用 react-autosuggest 的"打开/聚焦"信号：被聚焦的输入框带 aria-expanded="true"
// (同一时间只允许一个 listbox 打开)；兜底是容器上的 containerOpen 状态类。
let focusedAddressSelector: Element | undefined;

function getOpenAddressSelector(): Element | undefined {
  // react-autosuggest 只有在输入框聚焦时才会把打开的 listbox 渲染进 #autosuggest-portal，
  // 且同一时间只允许一个 listbox 打开。listbox 一定带 role="listbox"，用其作为稳定判据。
  const portal = document.getElementById('autosuggest-portal');
  const listOpen =
    portal != null &&
    (portal.querySelector('[role="listbox"]') != null || portal.children.length > 0);
  if (!listOpen) {
    return undefined;
  }
  const containers = Array.from(document.querySelectorAll(`.${C.AddressSelector.container}`));
  // 通过 aria-controls / aria-owns 把门户里的 listbox 反查到拥有它的输入框所属容器。
  const openListIds = new Set(Array.from(portal.querySelectorAll('[id]')).map(el => el.id));
  return (
    containers.find(c => c.classList.contains(C.AddressSelector.containerOpen)) ??
    containers.find(c => {
      const controlled = c.querySelector('[aria-controls], [aria-owns]');
      const ref =
        controlled?.getAttribute('aria-controls') ?? controlled?.getAttribute('aria-owns');
      return ref != null && openListIds.has(ref);
    }) ??
    // 页面上同一时刻往往只有一个地址框容器，直接命中它。
    (containers.length === 1 ? containers[0] : undefined)
  );
}

function captureFocusedAddressSelector() {
  // 必须在 mousedown 阶段捕获：mousedown 一过，react-autosuggest 的 outside-click
  // 会把 listbox 关掉、把输入框 blur，到 click 阶段就拿不到"打开"状态了。
  focusedAddressSelector = getOpenAddressSelector();
}

async function onPlanetClick() {
  if (focusedAddressSelector && (await selectAddress(focusedAddressSelector, naturalId))) {
    return;
  }
  showBuffer(`BS ${naturalId}`);
}

// Production status (from BS)
const production = computed(() => getPlanetProduction(siteId));
const prodTotals = computed(() => {
  const prod = production.value;
  if (!prod || prod.production.length === 0) {
    return undefined;
  }
  return {
    orders: sumBy(prod.production, x => x.orders.length),
    capacity: sumBy(prod.production, x => x.capacity),
  };
});
const prodBgClass = computed(() => {
  const totals = prodTotals.value;
  if (!totals) {
    return {};
  }
  return {
    [C.Workforces.daysMissing]: totals.orders < totals.capacity,
    [C.Workforces.daysSupplied]: totals.orders >= totals.capacity,
  };
});
const prodText = computed(() => {
  const totals = prodTotals.value;
  if (!totals) {
    return undefined;
  }
  return `${totals.orders}/${totals.capacity}`;
});

// Storage alarm (from BS)
const storageAlarm = computed(() => getStorageAlarmLevel(siteId));
const barAlarmReason = computed(() =>
  storageAlarm.value?.level === 'red' ? storageAlarm.value.reason : undefined,
);
</script>

<template>
  <tr :class="$style.row">
    <td
      :class="[$style.shipCell, dragOver && $style.shipCellOver]"
      @dragenter="onDragEnter"
      @dragover="onDragOver"
      @dragleave="onDragLeave"
      @drop="onDrop">
      <template v-if="config.ship && shipLabel">
        <div :class="$style.shipAssigned">
          <PrunButton primary inline :class="$style.shipButton">
            <span :class="$style.shipLabel">{{ shipLabel }}</span>
          </PrunButton>
          <PrunButton dark inline :class="$style.clearButton" @click="clearShip"
            >&times;</PrunButton
          >
        </div>
      </template>
      <div v-else :class="$style.shipPlaceholder" />
    </td>
    <GripCell />
    <td :class="$style.planetCell">
      <div
        :class="[C.Link.link, $style.planetLink]"
        @mousedown="captureFocusedAddressSelector"
        @click.stop="onPlanetClick">
        {{ naturalId }}
        <BaseAlias :site-id="siteId" />
      </div>
    </td>
    <td :class="$style.toggleCell">
      <RadioItem v-model="config.resupply" />
    </td>
    <td :class="$style.inputCell">
      <Tooltip no-icon position="top" :tooltip="daysTooltip">
        <NumberInput
          v-model="config.days"
          :min="0"
          :max="inputDaysCap"
          :class="$style.faintInput" />
      </Tooltip>
    </td>
    <td :class="$style.statusCell">
      <div :class="[$style.statusContent, burnBgClass]">
        <span :class="$style.statusNum" @click="showBuffer(`XIT BURN ${naturalId}`)">{{
          daysText
        }}</span>
      </div>
    </td>
    <td v-if="showProd" :class="$style.prodCell">
      <div :class="[$style.statusContent, prodBgClass]">
        <span :class="$style.statusNum" @click="showBuffer(`XIT PROD ${naturalId}`)">{{
          prodText
        }}</span>
      </div>
    </td>
    <td v-if="showRepair" :class="$style.toggleCell">
      <RadioItem v-model="config.repair" />
    </td>
    <td v-if="showRepair" :class="$style.statusCell">
      <Tooltip no-icon position="top" :tooltip="repairTooltip">
        <div :class="[$style.statusContent, repairBgClass]">
          <span :class="$style.statusNum" @click="showBuffer(`BRA ${naturalId}`)">{{
            repairDaysText
          }}</span>
        </div>
      </Tooltip>
    </td>
    <td :class="[$style.inputCell, $style.advanceCell]">
      <SelectInput
        v-model="config.repAdvance"
        :width="72"
        :class="$style.faintSelect"
        :options="[
          { label: '现在', value: 'now' },
          { label: '+24h', value: '24' },
          { label: '+48h', value: '48' },
        ]" />
    </td>
    <td
      :class="[
        C.type.typeSmall,
        $style.loadCell,
        overloaded && [C.Workforces.daysMissing, $style.loadOverloaded],
      ]">
      {{ loadText }}
    </td>
    <td :class="$style.selectCell">
      <div :class="$style.selectWrap">
        <RadioItem v-model="config.consumablesOnly" horizontal>消耗品</RadioItem>
        <RadioItem v-model="config.includeConsumables" horizontal>原料</RadioItem>
      </div>
    </td>
    <td :class="$style.fitCell">
      <PrunButton dark inline :disabled="!canFit" @click="emit('fit')">适配</PrunButton>
    </td>
    <td :class="$style.advToggleCell">
      <RadioItem v-model="config.cxBuy" horizontal>购买</RadioItem>
    </td>
    <td :class="$style.statusCell">
      <div :class="[$style.statusContent, fillBgClass]">
        <span :class="$style.statusNum">{{ fillText }}</span>
      </div>
    </td>
    <td v-if="showInv" :class="$style.invCell">
      <InvBar
        :store-id="storeId"
        :natural-id="naturalId"
        :on-click-cmd="`INV ${storeId.substring(0, 8)}`"
        :alarm-level="storageAlarm?.level"
        :alarm-reason="barAlarmReason" />
    </td>
    <td v-if="showWar && warehouseStoreId" :class="$style.invCell">
      <InvBar
        :store-id="warehouseStoreId"
        :on-click-cmd="`INV ${warehouseStoreId.substring(0, 8)}`" />
    </td>
  </tr>
</template>

<style module>
.row {
  height: 24px;
  border-bottom: 1px solid #2b485a;
  box-sizing: border-box;
}

.planetCell {
  max-width: 30ch;
  font-weight: bold;
  font-size: 12px;
  padding: 0 4px;
  line-height: 22px;
  white-space: nowrap;
}

.planetLink {
  display: inline;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: inherit;
}

.statusCell {
  width: 44px;
  min-width: 44px;
  box-sizing: border-box;
  white-space: nowrap;
  padding: 2px;
  text-align: center;
  border-left: none;
}

.statusContent {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 18px;
  box-sizing: border-box;
  padding: 2px 4px;
}

.statusNum {
  min-width: 3ch;
  text-align: center;
}

.toggleCell {
  width: 0;
  padding: 0 1px 0 3px;
  vertical-align: middle;
  border-right: none;
}

.loadCell {
  width: 0;
  white-space: nowrap;
  padding: 0 6px;
  text-align: center;
  color: #f7a600;
}

.loadOverloaded {
  color: inherit;
}

.shipCell {
  width: 0;
  white-space: nowrap;
  padding: 0 4px;
  vertical-align: middle;
}

.row .shipCell {
  border-left: 1px solid #f7a600;
}

.shipCellOver {
  background: #2b485a;
}

.shipPlaceholder {
  border: 1px dashed #444;
  height: 18px;
  width: 84px;
  border-radius: 2px;
  box-sizing: border-box;
}

.shipAssigned {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  width: 84px;
  box-sizing: border-box;
}

.shipButton {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.shipLabel {
  display: block;
  width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.clearButton {
  display: flex;
  justify-content: center;
  align-items: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  font-size: 11px;
  padding: 0;
}

.inputCell {
  width: 0;
  white-space: nowrap;
  padding: 0 2px;
  line-height: 22px;
  vertical-align: middle;
}

.faintInput {
  width: 48px;
}

.faintInput :global(input) {
  width: 48px;
  height: 17px;
  background-color: transparent;
  border-width: 0 0 1px;
  border-bottom: 1px solid transparent;
  color: #888;
  padding: 0 4px;
  box-sizing: border-box;
}

.faintInput :global(input:focus) {
  outline: none;
  color: #ccc;
  border-bottom-color: #666;
}

.faintSelect {
  margin-right: 0;
  margin-left: auto;
}

/* 提前列字体对齐星球列,但去掉粗体、降低色彩饱和,保持柔和。 */
.advanceCell {
  font-weight: normal;
  font-size: 12px;
  color: inherit;
}
.advanceCell :global(select) {
  font-weight: normal;
  font-size: 12px;
  color: inherit;
  background-color: transparent;
  border-color: rgba(61, 74, 84, 0.5);
}

.faintSelect :global(select) {
  height: 18px;
  box-sizing: border-box;
  padding: 0 6px;
  border: 1px solid rgb(61, 74, 84);
  background: rgb(26, 33, 38);
  color: rgb(226, 230, 233);
  font: inherit;
  outline: none;
}

.faintSelect :global(select:focus) {
  border-color: rgb(255, 176, 0);
  box-shadow: inset 0 0 0 1px rgb(255, 176, 0);
  background: rgb(30, 38, 44);
}

.selectCell {
  width: 0;
  white-space: nowrap;
  padding: 0 2px;
  line-height: 22px;
  vertical-align: middle;
}

.selectWrap {
  display: flex;
}

.advToggleCell {
  width: 0;
  white-space: nowrap;
  padding: 0 2px;
  vertical-align: middle;
  text-align: center;
}

.fitCell {
  width: 0;
  white-space: nowrap;
  padding: 0 4px;
  line-height: 22px;
  vertical-align: middle;
}

.invCell {
  min-width: 60px;
  padding: 2px;
}
</style>
