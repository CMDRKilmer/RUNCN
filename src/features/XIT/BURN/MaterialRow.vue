<script setup lang="ts">
import { getResupplyDays } from '@src/core/burn';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import DaysCell from '@src/features/XIT/BURN/DaysCell.vue';
import { fixed0, fixed01, fixed02, fixed1, fixed2 } from '@src/utils/format';
import { useTileState } from '@src/features/XIT/BURN/tile-state';
import { userData } from '@src/store/user-data';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { clampTargetDays, getSuppliesCap } from '@src/features/XIT/FLEET/supplies-cap';
import type { BurnReportRow } from '@src/features/XIT/BURN/utils';
import { burnReportNeed } from '@src/features/XIT/BURN/burn-purchase';

const { alwaysVisible, burn, material, naturalId } = defineProps<{
  alwaysVisible?: boolean;
  burn: BurnReportRow;
  material: PrunApi.Material;
  // 所属星球编码：用于读取该星球的补给天数覆盖与仓储容量上限，
  // 使「需要」列与 FLEET 执行预览、XIT CBUY 的数量完全一致。
  // 「整体消耗」等虚拟汇总行没有该值，退回全局补给天数。
  naturalId?: string;
}>();

const production = computed(() => burn.dailyAmount);
const invAmount = computed(() => {
  if (burn.inventory === undefined) {
    return '—';
  }
  const amount = burn.inventory + burn.remainingAllocation;
  if (amount >= 100) {
    return fixed0(amount);
  }
  if (amount >= 10) {
    return fixed01(amount);
  }
  return fixed02(amount);
});
const invWhole = computed(() => {
  const dot = invAmount.value.indexOf('.');
  return dot === -1 ? invAmount.value : invAmount.value.slice(0, dot);
});
const invFraction = computed(() => {
  const dot = invAmount.value.indexOf('.');
  return dot === -1 ? '' : invAmount.value.slice(dot);
});
const isInf = computed(() => production.value !== undefined && production.value >= 0);
const days = computed(() => (isInf.value ? 1000 : burn.daysLeft));

const red = useTileState('red');
const yellow = useTileState('yellow');
const green = useTileState('green');
const inf = useTileState('inf');
const io = useTileState('io');

const isVisible = computed(() => {
  if (alwaysVisible || days.value === undefined) {
    return true;
  }
  if (isInf.value) {
    return inf.value;
  }
  return (
    (days.value <= userData.settings.burn.red && red.value) ||
    (days.value <= userData.settings.burn.yellow && yellow.value) ||
    (days.value > userData.settings.burn.yellow && green.value)
  );
});

function formatAmount(value: number) {
  const abs = Math.abs(value);
  return abs >= 1000 ? fixed0(abs) : abs >= 100 ? fixed1(abs) : fixed2(abs);
}

function formatChange(value: number | undefined) {
  if (value === undefined) {
    return '—';
  }
  if (value === 0) {
    return 0;
  }
  return (value > 0 ? '+' : '-') + formatAmount(value);
}

const changeText = computed(() => formatChange(production.value));
const changeClass = computed(() => ({
  [C.ColoredValue.positive]: (production.value ?? 0) > 0,
}));

const outAmount = computed(() => burn.output);
const inText = computed(() =>
  formatChange(burn.input === undefined ? undefined : -burn.input - burn.workforce),
);
const outText = computed(() => formatChange(outAmount.value));

const outClass = computed(() => ({
  [C.ColoredValue.positive]: (outAmount.value ?? 0) > 0,
}));

// 「需要」列：补到目标天数的缺口。目标天数 = 该星球的补给天数（含单星球
// 覆盖），再按基地仓储容量上限钳制；缺口算法统一走 core/burn 的 computeNeed
// （只看 inventory，不含 remainingAllocation），与 FLEET 账单口径一致。
const needAmt = computed(() => {
  const site = naturalId ? sitesStore.getByPlanetNaturalIdOrName(naturalId) : undefined;
  const targetDays = clampTargetDays(getResupplyDays(naturalId) ?? 10, getSuppliesCap(site));
  return burnReportNeed(burn, targetDays);
});
</script>

<template>
  <tr v-if="isVisible">
    <td :class="$style.materialContainer">
      <MaterialIcon size="inline-table" :ticker="material.ticker" />
    </td>
    <td>
      <span>
        {{ invWhole }}<span :class="$style.fraction">{{ invFraction }}</span>
      </span>
    </td>
    <template v-if="io">
      <td>
        <span>{{ inText }}</span>
      </td>
      <td>
        <span :class="outClass">{{ outText }}</span>
      </td>
      <td>
        <span :class="changeClass">{{ changeText }}</span>
      </td>
    </template>
    <td v-else>
      <span :class="changeClass">{{ changeText }}</span>
    </td>
    <td>
      <span>{{ needAmt === undefined ? '—' : fixed0(needAmt) }}</span>
    </td>
    <DaysCell v-if="days !== undefined" :days="days" />
    <td v-else>—</td>
  </tr>
</template>

<style module>
.materialContainer {
  width: 32px;
  padding: 0;
}

.fraction {
  color: #999;
}
</style>
