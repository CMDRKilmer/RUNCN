<script setup lang="ts">
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import FinHeader from '@src/features/XIT/FIN/FinHeader.vue';
import KeyFigures from '@src/features/XIT/FIN/KeyFigures.vue';
import { calculateSiteProfitability } from '@src/core/profitability';
import { sumBy } from '@src/utils/sum-by';
import { fixed0, formatCurrency, percent2 } from '@src/utils/format';
import { map } from '@src/utils/map-values';

const entries = computed(() => {
  return (
    sitesStore.all.value
      ?.map(x => calculateSiteProfitability(x))
      .filter(x => x !== undefined)
      .sort((a, b) => b.profit - a.profit) ?? []
  );
});

const dailyWorkforceCost = computed(() => sumBy(entries.value, x => x.workforceCost));
const dailyMaterialCost = computed(() => sumBy(entries.value, x => x.materialCost));
const dailyRepairs = computed(() => sumBy(entries.value, x => x.repairs));
const dailyRevenue = computed(() => sumBy(entries.value, x => x.revenue));
const dailyProfit = computed(() => sumBy(entries.value, x => x.profit));
const dailyMargin = computed(() => {
  return map([dailyRevenue.value, dailyProfit.value], (revenue, profit) =>
    revenue !== 0 ? profit / revenue : 0,
  );
});

const figures = computed(() => {
  return [
    { name: '每日劳动力', value: formatCurrency(dailyWorkforceCost.value) },
    { name: '每日材料', value: formatCurrency(dailyMaterialCost.value) },
    { name: '每日维修', value: formatCurrency(dailyRepairs.value) },
    { name: '每日收入', value: formatCurrency(dailyRevenue.value) },
    { name: '每日利润', value: formatCurrency(dailyProfit.value) },
    {
      name: '每日利润率',
      value: dailyMargin.value !== undefined ? percent2(dailyMargin.value) : '--',
    },
  ];
});

function profitClass(value: number) {
  return {
    [C.ColoredValue.positive]: value > 0,
    [C.ColoredValue.negative]: value < 0,
  };
}
</script>

<template>
  <div>
    <FinHeader>生产概览</FinHeader>
    <KeyFigures :figures="figures" />
    <FinHeader>按星球分布</FinHeader>
    <table>
      <colgroup span="7" style="width: calc(100% / 7)"></colgroup>
      <thead>
        <tr>
          <th>名称</th>
          <th>劳动力</th>
          <th>材料</th>
          <th>维修</th>
          <th>收入</th>
          <th>利润</th>
          <th>利润率</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in entries" :key="entry.name">
          <td>{{ entry.name }}</td>
          <td>{{ fixed0(entry.workforceCost) }}</td>
          <td>{{ fixed0(entry.materialCost) }}</td>
          <td>{{ fixed0(entry.repairs) }}</td>
          <td>{{ fixed0(entry.revenue) }}</td>
          <td>{{ fixed0(entry.profit) }}</td>
          <td :class="profitClass(entry.margin)">{{ percent2(entry.margin) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
table tr > :not(:first-child) {
  text-align: right;
}
</style>
