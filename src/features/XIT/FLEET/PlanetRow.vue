<script setup lang="ts">
import PrunLink from '@src/components/PrunLink.vue';
import PrunButton from '@src/components/PrunButton.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import GripCell from '@src/components/grip/GripCell.vue';
import InvBar from '@src/features/XIT/FLEET/InvBar.vue';
import BaseAlias from '@src/components/BaseAlias.vue';
import { getPlanetBurn } from '@src/core/burn';
import { countDays } from '@src/features/XIT/BURN/utils';
import { getPlanetRepairAge } from '@src/features/XIT/REP/entries';
import { timestampEachMinute } from '@src/utils/dayjs';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { fixed0 } from '@src/utils/format';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { getPlanetProduction } from '@src/core/production';
import { sumBy } from '@src/utils/sum-by';
import { getStorageAlarmLevel } from '@src/core/storage-analysis';
import type { BaseStorageAnalysis } from '@src/core/storage-analysis';
import type { DispatchBaseConfig } from '@src/features/XIT/FLEET/utils';
import { billTotals, burnDaysClass, formatBurnDays } from '@src/features/XIT/FLEET/utils';

// 黄色告警提前天数。维修列颜色基于 REPP 模型(optimalDay)三色:
//   age ≥ optimalDay         → 红色(已到触发,应维修)
//   optimalDay - 15 ≤ age < optimalDay → 黄色(警告期)
//   age < optimalDay - 15    → 绿色(健康)
const repairWarningOffset = 3;

const {
  siteId,
  naturalId,
  planetName,
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
  repairPlan,
} = defineProps<{
  siteId: string;
  naturalId: string;
  planetName: string;
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
  repairPlan?: { optimalDay: number | undefined };
}>();

const emit = defineEmits<{
  fit: [];
}>();

const canFit = computed(() => !!config.ship);

// 天数输入不能超过基地「可容纳供应天数」。
// analysis.daysOfSuppliesFit = 出货后填到 N% 时基地可容纳的总消耗天数;
// 配置天数超过这个值会导致补给账单超出仓储,在 FLEET 的「适配」与「装载」计算中也按此上限截断。
// 同时监听 days 与 cap,确保持久化的初始超 cap 值以及 cap 后置变小的情况都能被截断。
watch(
  [() => config.days, () => analysis?.daysOfSuppliesFit],
  ([days, cap]) => {
    if (cap === undefined || !isFinite(cap)) {
      return;
    }
    if (days > cap) {
      config.days = cap;
    }
  },
  { immediate: true },
);

const burn = computed(() => getPlanetBurn(siteId));
const days = computed(() => (burn.value ? countDays(burn.value.burn) : undefined));

const burnBgClass = computed(() => (days.value === undefined ? {} : burnDaysClass(days.value)));

const daysText = computed(() => (days.value === undefined ? '-' : formatBurnDays(days.value)));

const repairAge = computed(() => getPlanetRepairAge(siteId, timestampEachMinute.value));

const repairBgClass = computed(() => {
  const age = repairAge.value;
  const optimalDay = repairPlan?.optimalDay;
  if (age === undefined || optimalDay === undefined) {
    return {};
  }
  const d = Math.floor(age);
  if (d >= optimalDay) {
    return { [C.Workforces.daysMissing]: true };
  }
  if (d >= optimalDay - repairWarningOffset) {
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

const fillText = computed(() => {
  const days = analysis?.daysUntilFull;
  if (days === undefined || !isFinite(days)) {
    return '∞';
  }
  return formatBurnDays(days);
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

  // Validate ship remaining capacity (against this row's bill) before assigning.
  const ship = shipsStore.getById(shipId);
  if (ship && ship.idShipStore) {
    const store = storagesStore.getById(ship.idShipStore);
    if (store && bill) {
      const totals = billTotals(bill);
      const freeWeight = store.weightCapacity - store.weightLoad;
      const freeVolume = store.volumeCapacity - store.volumeLoad;
      if (totals.weight > freeWeight || totals.volume > freeVolume) {
        const msg = `飞船剩余容量不足：需要 ${fixed0(totals.weight)}t / ${fixed0(totals.volume)}m³，剩余 ${fixed0(freeWeight)}t / ${fixed0(freeVolume)}m³`;
        // Surface a message to the user — open a small buffer with the text so it's visible.
        void showBuffer(`echo ${msg}`, { autoClose: true, autoSubmit: false });
        return;
      }
    }
  }

  setTimeout(() => {
    config.ship = shipId;
  }, 0);
}

function clearShip() {
  config.ship = undefined;
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
      <PrunLink inline :command="`BS ${naturalId}`" :class="$style.planetLink">
        {{ planetName }}
        <BaseAlias :site-id="siteId" />
      </PrunLink>
    </td>
    <td :class="$style.toggleCell">
      <RadioItem v-model="config.resupply" />
    </td>
    <td :class="$style.inputCell">
      <NumberInput v-model="config.days" :class="$style.faintInput" />
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
      <div :class="[$style.statusContent, repairBgClass]">
        <span :class="$style.statusNum" @click="showBuffer(`BRA ${naturalId}`)">{{
          repairDaysText
        }}</span>
      </div>
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
