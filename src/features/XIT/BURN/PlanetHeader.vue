<script setup lang="ts">
import DaysCell from '@src/features/XIT/BURN/DaysCell.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { getBaseAlias } from '@src/core/base-aliases';
import { useTileState } from '@src/features/XIT/BURN/tile-state';
import { countDays, type BurnReportSection } from '@src/features/XIT/BURN/utils';
import { openExchangeBurnGenerator } from '@src/features/XIT/BURN/exchange-burn-actions';

const { burn } = defineProps<{
  burn: BurnReportSection;
  hasMinimize?: boolean;
  minimized?: boolean;
  onClick: () => void;
}>();

const days = computed(() => {
  if (
    burn.exchangeCode !== undefined &&
    Object.values(burn.burn).some(x => x.daysLeft === undefined)
  ) {
    return undefined;
  }
  return countDays(burn.burn);
});

// 总览行（naturalId 为空）没有基地可打开，不显示 ACT。
const isRealPlanet = computed(() => burn.naturalId !== '');

// 基地别名（总览行没有 siteId，不显示别名）。
const alias = computed(() => (burn.siteId ? getBaseAlias(burn.siteId) : undefined));
const production = useTileState('prod');
const workforce = useTileState('wf');

function onGenerateActClick() {
  if (burn.exchangeCode !== undefined) {
    openExchangeBurnGenerator(burn.exchangeCode, production.value, workforce.value);
    return;
  }
  showBuffer(`XIT BURNGEN ${burn.planetName}`);
}

// 星球行：名称跨到天数列之前，随后是天数与「命令」列（BS / INV / ACT）。
// 命令列显隐由 basic/burn-command-column 功能控制（XIT SET → 功能）。
const io = useTileState('io');
const nameColSpan = computed(() => (io.value ? 6 : 4));
</script>

<template>
  <tr :class="$style.row">
    <td :colspan="nameColSpan" :class="$style.cell" @click="onClick">
      <span v-if="hasMinimize" :class="$style.minimize">
        {{ minimized ? '+' : '-' }}
      </span>
      <span>{{ burn.planetName }}</span>
      <span v-if="alias" :class="$style.alias">（{{ alias }}）</span>
    </td>
    <DaysCell v-if="days !== undefined" :days="days" />
    <td v-else>—</td>
    <td data-rp-burn-commands-col :class="$style.buttonsCell">
      <div :class="$style.buttons">
        <PrunButton
          v-if="burn.exchangeCode"
          dark
          inline
          @click="showBuffer(`CX ${burn.exchangeCode}`)">
          CX
        </PrunButton>
        <PrunButton v-else dark inline @click="showBuffer(`BS ${burn.naturalId}`)">BS</PrunButton>
        <PrunButton
          v-if="!burn.exchangeCode || burn.storeId"
          dark
          inline
          @click="showBuffer(`INV ${burn.storeId.substring(0, 8)}`)">
          INV
        </PrunButton>
        <PrunButton v-if="isRealPlanet || burn.exchangeCode" dark inline @click="onGenerateActClick"
          >ACT</PrunButton
        >
      </div>
    </td>
  </tr>
</template>

<style module>
.row {
  border-bottom: 1px solid #2b485a;
}

.cell {
  font-weight: bold;
  font-size: 12px;
  cursor: pointer;
}

.alias {
  color: #888;
  margin-left: 4px;
}

.minimize {
  display: inline-block;
  width: 26px;
  text-align: center;
}

.buttonsCell {
  white-space: nowrap;
}

.buttons {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  column-gap: 0.25rem;
}
</style>
