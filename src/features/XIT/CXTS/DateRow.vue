<script setup lang="ts">
import { fixed0, ddmm, ddmmyyyy, mmyyyy } from '@src/utils/format';

type Granularity = 'daily' | 'weekly' | 'monthly';

const props = defineProps<{
  date: number;
  hideTotals?: boolean;
  totals: { [currency: string]: { purchases: number; sales: number } };
  granularity: Granularity;
}>();

const totalsLabels = computed(() => {
  return Object.keys(props.totals)
    .sort()
    .map(x => ({
      currency: x,
      purchases: props.totals[x].purchases,
      sales: props.totals[x].sales,
      total: props.totals[x].sales - props.totals[x].purchases,
    }));
});

const dateLabel = computed(() => {
  switch (props.granularity) {
    case 'weekly': {
      const end = new Date(props.date + 6 * 24 * 60 * 60 * 1000);
      return `${ddmm(props.date)} - ${ddmm(end.getTime())} ${new Date(props.date).getFullYear()}`;
    }
    case 'monthly': {
      return mmyyyy(props.date);
    }
    default: {
      return ddmmyyyy(props.date);
    }
  }
});
</script>

<template>
  <tr>
    <td colspan="2" :class="$style.column">
      <span>{{ dateLabel }}</span>
    </td>
    <!-- 需要这个 <tr> 以保证另外两个 <tr> 颜色相同 -->
    <td :style="{ display: 'none' }" />
    <td colspan="5" :class="$style.column">
      <div v-if="!hideTotals" :class="$style.totals">
        <div :class="$style.totalsColumn">
          <span v-for="total in totalsLabels" :key="total.currency">{{ fixed0(total.sales) }}</span>
        </div>
        <div :class="[$style.totalsColumn, $style.totalsSeparator]">
          <span v-for="i in totalsLabels.length" :key="i">-</span>
        </div>
        <div :class="$style.totalsColumn">
          <span v-for="total in totalsLabels" :key="total.currency">
            {{ fixed0(total.purchases) }}
          </span>
        </div>
        <div :class="[$style.totalsColumn, $style.totalsSeparator]">
          <span v-for="i in totalsLabels.length" :key="i">=</span>
        </div>
        <div :class="$style.totalsColumn">
          <span v-for="total in totalsLabels" :key="total.currency">
            {{ fixed0(total.total) }} {{ total.currency }}
          </span>
        </div>
      </div>
    </td>
  </tr>
</template>

<style module>
.column {
  border-left: none;
  border-bottom: 1px solid #2b485a;
  border-top: 1px solid #2b485a;
}

.totals {
  display: flex;
  flex-direction: row;
  justify-content: flex-end;
  text-align: right;
}

.totalsColumn {
  display: flex;
  flex-direction: column;
}

.totalsSeparator {
  margin-left: 10px;
  margin-right: 10px;
  justify-content: center;
  align-items: center;
}
</style>
