<script setup lang="ts">
import { BaseStorageAnalysis, buildProjectedStore } from '@src/core/storage-analysis';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { userData } from '@src/store/user-data';
import PrunButton from '@src/components/PrunButton.vue';
import CargoBar from '@src/components/CargoBar.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { fillRatioClass, formatDays, formatDaysCompact } from '@src/features/XIT/STO/utils';
import { fixed01 } from '@src/utils/format';

const { analysis } = defineProps<{
  analysis: BaseStorageAnalysis;
  hasMinimize?: boolean;
  minimized?: boolean;
  onClick: () => void;
  tooltipPosition?: string;
  hideButtons?: boolean;
  showColumnTooltips?: boolean;
  planetOnlyClick?: boolean;
}>();

const COLUMN_LIMIT_TOOLTIP = '按当前净产出速率,距离仓储填满的天数 — 也是必须派船访问的临界点。';
const COLUMN_SUPPLY_TOOLTIP =
  '按当前装载阈值(填满中 80%,排空中 95%)出货后,基地能容纳的供应总天数。颜色与 XIT BURN 一致。';
const COLUMN_CURRENT_FILL_TOOLTIP = '基地当前仓储的实际状态。按材料类别着色。';
const COLUMN_AFTER_RESUPPLY_TOOLTIP =
  '假设所有产出物料运走、所有消耗物料按 XIT BURN 的 Need 量补足后的预计状态。红色斜纹表示超过容量的溢出。';

const currentStore = computed(() => storagesStore.getById(analysis.storeId));
const projectedStore = computed(() => buildProjectedStore(analysis.siteId));

const stripeClass = computed(() => {
  if (analysis.needFillRatio === 0) {
    return undefined;
  }
  return fillRatioClass(analysis.needFillRatio);
});

const limitTooltip = computed(() => {
  if (analysis.bindingLimit === undefined) {
    return '仓储正在排空 — 没有主动填充。';
  }
  return analysis.bindingLimit === 't' ? '重量是受限维度。' : '体积是受限维度。';
});

const supplyTooltip = computed(() => {
  if (!isFinite(analysis.daysOfSuppliesFit)) {
    return '无活跃消耗者 — 不需要供应。';
  }
  const pct = Math.round((1 - analysis.suppliesReserveFraction) * 100);
  const reason = analysis.suppliesReserveFraction >= 0.2 ? '持续累积的产出物料' : '生产波动';
  return `出货后按 ${pct}% 填充(剩余 ${fixed01(analysis.suppliesReserveFraction * 100)}% 为 ${reason} 预留)时,总共可容纳 ${fixed01(analysis.daysOfSuppliesFit)} 天供应。`;
});

const supplyClass = computed(() => {
  const floored = Math.floor(analysis.daysOfSuppliesFit);
  if (!isFinite(analysis.daysOfSuppliesFit)) {
    return undefined;
  }
  return {
    [C.Workforces.daysMissing]: floored <= userData.settings.burn.red,
    [C.Workforces.daysWarning]: floored <= userData.settings.burn.yellow,
    [C.Workforces.daysSupplied]: floored > userData.settings.burn.yellow,
  };
});
</script>

<template>
  <tr :class="$style.row">
    <td :class="[$style.planet, $style.clickable]" @click="onClick">
      <div v-if="stripeClass" :class="[$style.stripe, stripeClass]" />
      <span v-if="hasMinimize" :class="$style.minimize">
        {{ minimized ? '+' : '-' }}
      </span>
      <span>{{ analysis.planetName }}</span>
    </td>
    <td
      :class="[!planetOnlyClick && $style.clickable, $style.noWrap]"
      v-on="planetOnlyClick ? {} : { click: onClick }">
      <span
        v-if="showColumnTooltips"
        :class="[C.Tooltip.container, $style.tooltipSpan]"
        :data-tooltip="COLUMN_LIMIT_TOOLTIP"
        :data-tooltip-position="tooltipPosition ?? 'bottom'">
        {{ formatDays(analysis.daysUntilFull) }}
      </span>
      <span
        v-else
        :data-tooltip="limitTooltip"
        :data-tooltip-position="tooltipPosition ?? 'bottom'">
        {{ formatDays(analysis.daysUntilFull) }}
      </span>
    </td>
    <td
      :class="[!planetOnlyClick && $style.clickable, $style.supplyCell, $style.noWrap]"
      v-on="planetOnlyClick ? {} : { click: onClick }">
      <div v-if="supplyClass" :class="[$style.supplyBg, supplyClass]" />
      <span
        v-if="showColumnTooltips"
        :class="[C.Tooltip.container, $style.tooltipSpan]"
        :data-tooltip="COLUMN_SUPPLY_TOOLTIP"
        :data-tooltip-position="tooltipPosition ?? 'bottom'">
        {{ formatDaysCompact(analysis.daysOfSuppliesFit) }}
      </span>
      <span
        v-else
        :data-tooltip="supplyTooltip"
        :data-tooltip-position="tooltipPosition ?? 'bottom'">
        {{ formatDaysCompact(analysis.daysOfSuppliesFit) }}
      </span>
    </td>
    <td
      :class="[!planetOnlyClick && $style.clickable, $style.barCell]"
      v-on="planetOnlyClick ? {} : { click: onClick }">
      <div
        v-if="showColumnTooltips"
        :class="$style.colBg"
        :data-tooltip="COLUMN_CURRENT_FILL_TOOLTIP"
        :data-tooltip-position="tooltipPosition ?? 'bottom'">
        <CargoBar :store="currentStore" disable-mini-mode />
      </div>
      <CargoBar v-else :store="currentStore" disable-mini-mode />
    </td>
    <td
      :class="[!planetOnlyClick && $style.clickable, $style.barCell]"
      v-on="planetOnlyClick ? {} : { click: onClick }">
      <div
        v-if="showColumnTooltips"
        :class="[$style.colBg, $style.rightAlignedTooltip]"
        :data-tooltip="COLUMN_AFTER_RESUPPLY_TOOLTIP"
        :data-tooltip-position="tooltipPosition ?? 'bottom'">
        <CargoBar :store="projectedStore" disable-mini-mode />
      </div>
      <CargoBar v-else :store="projectedStore" disable-mini-mode />
    </td>
    <td v-if="!hideButtons">
      <div :class="$style.buttons">
        <PrunButton dark inline @click="showBuffer(`BS ${analysis.naturalId}`)">BS</PrunButton>
        <PrunButton dark inline @click="showBuffer(`INV ${analysis.storeId.substring(0, 8)}`)">
          INV
        </PrunButton>
      </div>
    </td>
  </tr>
</template>

<style module>
.row {
  border-bottom: 1px solid #2b485a;
}

.planet {
  font-weight: bold;
  font-size: 12px;
  position: relative;
  padding-left: 12px;
  white-space: nowrap;
}

.stripe {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 3px;
}

.clickable {
  cursor: pointer;
}

.noWrap {
  white-space: nowrap;
}

/* tooltip ::before 默认会继承父 td 的 white-space:nowrap,会让 tooltip 文本无法换行;
   这里重置为 normal,让 tooltip 框内可正常换行。 */
.tooltipSpan {
  white-space: normal;
}

.minimize {
  display: inline-block;
  width: 20px;
  text-align: center;
}

.buttons {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  column-gap: 0.25rem;
}

/* 让两个 CargoBar 单元等宽。各占 50% 时,固定列(行星/天数/命令)之外的空间会被它们平分。 */
.barCell {
  width: 50%;
  vertical-align: middle;
}

.supplyCell {
  position: relative;
}

.supplyBg {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
}

/* 占满 td,让背景色覆盖数值周围的空白区域。 */
.colBg {
  display: block;
  position: relative;
  z-index: 1;
}

/* tooltip 框右对齐,避免溢出右侧 buffer 边界。
   游戏默认把 'top' tooltip 居中,这里改为右对齐到元素右边缘。 */
.rightAlignedTooltip {
  &::before {
    left: auto;
    right: 0;
    transform: translateX(0);
  }
}
</style>
