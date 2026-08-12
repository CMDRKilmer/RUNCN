<script setup lang="ts">
import PrunLink from '@src/components/PrunLink.vue';
import PrunButton from '@src/components/PrunButton.vue';
import InvBar from '@src/features/XIT/BS/InvBar.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { getPlanetBurn } from '@src/core/burn';
import { countDays } from '@src/features/XIT/BURN/utils';
import { getStorageAlarmLevel } from '@src/core/storage-analysis';
import { fixed1 } from '@src/utils/format';
import { getPlanetProduction } from '@src/core/production';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { userData } from '@src/store/user-data';
import { getRepairOffset, getRepairThreshold } from '@src/core/buildings';
import { getPlanetRepairAge } from '@src/features/XIT/REP/entries';
import { timestampEachMinute } from '@src/utils/dayjs';
import { sumBy } from '@src/utils/sum-by';

const {
  siteId,
  naturalId,
  planetName,
  storeId,
  optimalDay,
  showCmds,
  showBurn,
  showProd,
  showRepair,
  showInv,
  showWar,
} = defineProps<{
  siteId: string;
  naturalId: string;
  planetName: string;
  storeId: string;
  // REPP 整站 sweep 算出的最优维修间隔天数。数据缺失(CX 价格未加载、
  // 无活跃订单 / 模板、无 build options 等)时为 undefined,显示 "-"
  // 并回退到 userData.settings.repair 的阈值做颜色提示。
  optimalDay: number | undefined;
  showCmds: boolean;
  showBurn: boolean;
  showProd: boolean;
  showRepair: boolean;
  showInv: boolean;
  showWar: boolean;
}>();

const burn = computed(() => getPlanetBurn(siteId));
const days = computed(() => (burn.value ? countDays(burn.value.burn) : undefined));

const burnBgClass = computed(() => {
  if (days.value === undefined) {
    return {};
  }
  const d = Math.floor(days.value);
  return {
    [C.Workforces.daysMissing]: d <= userData.settings.burn.red,
    [C.Workforces.daysWarning]: d <= userData.settings.burn.yellow,
    [C.Workforces.daysSupplied]: d > userData.settings.burn.yellow,
  };
});

const daysText = computed(() => {
  if (days.value === undefined) {
    return undefined;
  }
  const d = Math.floor(days.value);
  return d < 500 ? String(d) : '∞';
});

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
  return totals.orders >= totals.capacity ? '✓' : '∅';
});

// 维修列展示 REPP sweep 出的最优间隔天数(语义:"每 N 天修一次"),
// 颜色按"当前 age vs optimalDay"判断:
//
//   age >= optimalDay → 红(已过最优触发日,应立即维修)
//   age >= optimalDay - userData.settings.repair.offset → 黄(进入预警区)
//   else → 绿(还在最优周期内)
//
// 与 XIT REPP 表格的 `urgencyClass` 语义一致;offset 与原 REP 阈值共用
// userData.settings.repair.offset,保持统一的预警宽度。
// 当 REPP 算不出 optimalDay(CX 价格未加载、无活跃订单等)时回退到
// userData.settings.repair.threshold,沿用旧 BS 列的颜色行为,避免显示黑洞。
const repairAge = computed(() => getPlanetRepairAge(siteId, timestampEachMinute.value));

const repairBgClass = computed(() => {
  const age = repairAge.value;
  if (age === undefined) {
    return {};
  }
  const d = Math.floor(age);
  if (optimalDay !== undefined) {
    const offset = getRepairOffset(naturalId);
    return {
      [C.Workforces.daysMissing]: d >= optimalDay,
      [C.Workforces.daysWarning]: d >= optimalDay - offset,
      [C.Workforces.daysSupplied]: d < optimalDay - offset,
    };
  }
  const threshold = getRepairThreshold(naturalId);
  const offset = getRepairOffset(naturalId);
  return {
    [C.Workforces.daysMissing]: d >= threshold,
    [C.Workforces.daysWarning]: d >= threshold - offset,
    [C.Workforces.daysSupplied]: d < threshold - offset,
  };
});

// 维修列文案优先显示 REPP 的最优间隔天数(语义:"每 N 天修一次"),
// REPP 算不出时回退到当前 maxAge(兼容旧展示)。
const repairDaysText = computed(() => {
  if (optimalDay !== undefined) {
    return String(optimalDay);
  }
  const age = repairAge.value;
  if (age === undefined) {
    return undefined;
  }
  return String(Math.floor(age));
});

const repairDaysTooltip = computed(() => {
  if (optimalDay !== undefined) {
    const age = repairAge.value;
    if (age !== undefined) {
      const d = Math.floor(age);
      return d >= optimalDay
        ? `REPP: 每 ${optimalDay} 天维修一次最优。当前 age ${d} 天已超过触发日,建议立即维修。`
        : `REPP: 每 ${optimalDay} 天维修一次最优(PRUNplanner 算法)。当前 age ${d} 天。`;
    }
    return `REPP: 每 ${optimalDay} 天维修一次最优(PRUNplanner 算法)。`;
  }
  return undefined;
});

const storageAlarm = computed(() => getStorageAlarmLevel(siteId));
const fillDaysText = computed(() =>
  storageAlarm.value?.days !== undefined ? fixed1(storageAlarm.value.days) : undefined,
);
// 黄色告警携带自己的徽章，由其管理 tooltip。仅红色告警（无徽章）在条上显示原因。
const barAlarmReason = computed(() =>
  storageAlarm.value?.level === 'red' ? storageAlarm.value.reason : undefined,
);

const warehouse = computed(() => warehousesStore.getByEntityNaturalId(naturalId));
const warehouseStore = computed(() =>
  storagesStore
    .getByAddressableId(warehouse.value?.warehouseId)
    ?.find(x => x.type === 'WAREHOUSE_STORE'),
);
</script>

<template>
  <tr :class="$style.row">
    <td :class="$style.planetCell">
      <PrunLink inline :command="`BS ${naturalId}`" :class="$style.planetLink">{{
        planetName
      }}</PrunLink>
    </td>
    <td v-if="showCmds" :class="$style.cmdCell">
      <PrunButton dark inline>命令▸</PrunButton>
      <div :class="$style.expandedButtons">
        <PrunButton dark inline @click="showBuffer(`BBL ${siteId}`)">建筑</PrunButton>
        <PrunButton dark inline @click="showBuffer(`BBC ${naturalId}`)">建造</PrunButton>
        <PrunButton dark inline @click="showBuffer(`WF ${siteId}`)">劳动力</PrunButton>
        <PrunButton dark inline @click="showBuffer(`EXP ${siteId}`)">专家</PrunButton>
        <PrunButton dark inline @click="showBuffer(`BRA ${naturalId}`)">BRA</PrunButton>
        <PrunButton dark inline @click="showBuffer('HQ')">HQ</PrunButton>
      </div>
    </td>
    <td v-if="showBurn" :class="$style.statusCell">
      <div :class="[$style.statusContent, burnBgClass]">
        <span :class="$style.statusNum" @click="showBuffer(`XIT BURN ${naturalId}`)">{{
          daysText ?? '-'
        }}</span>
        <PrunButton dark inline @click="showBuffer(`XIT BURNGEN ${naturalId}`)">{{
          '补'
        }}</PrunButton>
      </div>
    </td>
    <td v-if="showProd" :class="$style.statusCell">
      <div :class="[$style.statusContent, prodBgClass]">
        <span :class="$style.statusNum" @click="showBuffer(`XIT PROD ${naturalId}`)">{{
          prodText ?? '-'
        }}</span>
        <PrunButton dark inline @click="showBuffer(`XIT PROD ${naturalId}`)">{{ '查' }}</PrunButton>
      </div>
    </td>
    <td v-if="showRepair" :class="$style.statusCell">
      <div :class="[$style.statusContent, repairBgClass]">
        <span
          :class="$style.statusNum"
          :data-tooltip="repairDaysTooltip"
          data-tooltip-position="top"
          @click="showBuffer(`XIT REP ${naturalId}`)"
          >{{ repairDaysText ?? '-' }}</span
        >
        <PrunButton dark inline @click="showBuffer(`BRA ${naturalId}`)">{{ '修' }}</PrunButton>
      </div>
    </td>
    <td v-if="showInv" :class="$style.invCell">
      <div :class="$style.invCellContent">
        <InvBar
          :store-id="storeId"
          :natural-id="naturalId"
          :on-click-cmd="`INV ${storeId.substring(0, 8)}`"
          :alarm-level="storageAlarm?.level"
          :alarm-reason="barAlarmReason" />
        <div
          v-if="storageAlarm?.level === 'yellow'"
          :class="[C.ProgressBar.progress, $style.fillWarningBox, C.Workforces.daysWarning]"
          :data-tooltip="storageAlarm.reason"
          data-tooltip-position="top">
          <span :class="$style.statusNum">{{ fillDaysText }}</span>
        </div>
      </div>
    </td>
    <td v-if="showWar" :class="$style.invCell">
      <InvBar
        v-if="warehouseStore"
        :store-id="warehouseStore.id"
        :on-click-cmd="`INV ${warehouseStore.id.substring(0, 8)}`" />
    </td>
  </tr>
</template>

<style module>
.planetCell {
  max-width: 30ch;
  font-weight: bold;
  font-size: 12px;
}

.planetLink {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: inherit;
}

.cmdCell {
  position: relative;
  overflow: visible;
  white-space: nowrap;
  width: 0;
}

.expandedButtons {
  display: none;
  position: absolute;
  left: 100%;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  flex-direction: row;
  align-items: center;
  gap: 0.25rem;
  padding: 0 4px;
  white-space: nowrap;
}

.cmdCell:hover .expandedButtons {
  display: flex;
}

.row:has(.cmdCell:hover) .statusCell > *,
.row:has(.cmdCell:hover) .invCell > * {
  visibility: hidden;
}

.row {
  border-bottom: 1px solid #2b485a;
}

.statusCell {
  width: 0;
  white-space: nowrap;
  padding: 2px;
  text-align: center;
}

.statusContent {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  vertical-align: middle;
  padding: 2px 4px;
}

.statusNum {
  min-width: 3ch;
  text-align: center;
  flex-shrink: 0;
}

.invCell {
  min-width: 60px;
  padding: 2px;
}

.invCellContent {
  display: flex;
  align-items: center;
  gap: 2px;
}

.fillWarningBox {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  height: 13px;
  padding: 0 1px;
}
</style>
