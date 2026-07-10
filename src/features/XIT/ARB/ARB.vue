<script setup lang="ts">
import SectionHeader from '@src/components/SectionHeader.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import PrunLink from '@src/components/PrunLink.vue';
import { cxStore } from '@src/infrastructure/fio/cx';
import { timestampEachMinute } from '@src/utils/dayjs';
import { fixed0, fixed2, percent2 } from '@src/utils/format';
import { computeOpportunities, getCategories, type ArbOpportunity } from './arb-utils';

const search = ref('');
const categoryFilter = ref('ALL');
const onlyPositive = ref(true);
const sortKey = ref('profitPct');

const categoryOptions = computed(() => [
  { label: '全部类别', value: 'ALL' },
  ...getCategories().map(category => ({ label: category, value: category })),
]);

const sortOptions = [
  { label: '利润率', value: 'profitPct' },
  { label: '单价利润', value: 'profitPerUnit' },
  { label: '总利润', value: 'totalProfit' },
  { label: '可成交量', value: 'executableVolume' },
];

const opportunities = computed(() => computeOpportunities());

const noData = computed(() => !cxStore.fetched);

const positiveCount = computed(() => opportunities.value.filter(o => o.profitPerUnit > 0).length);

// Reactive data age (re-evaluates each minute via timestampEachMinute).
const dataAgeMinutes = computed(() => {
  if (cxStore.age === 0) {
    return null;
  }
  void timestampEachMinute.value;
  return Math.max(0, Math.floor((Date.now() - cxStore.age) / 60000));
});

function sortValue(o: ArbOpportunity): number {
  switch (sortKey.value) {
    case 'profitPerUnit':
      return o.profitPerUnit;
    case 'totalProfit':
      return o.totalProfit ?? -Infinity;
    case 'executableVolume':
      return o.executableVolume ?? -Infinity;
    case 'profitPct':
    default:
      return o.profitPct;
  }
}

const filtered = computed(() => {
  let list = opportunities.value;
  if (onlyPositive.value) {
    list = list.filter(o => o.profitPerUnit > 0);
  }
  if (categoryFilter.value !== 'ALL') {
    list = list.filter(o => o.category === categoryFilter.value);
  }
  const query = search.value.trim().toLowerCase();
  if (query) {
    list = list.filter(o => `${o.ticker} ${o.name}`.toLowerCase().includes(query));
  }
  return list.slice().sort((a, b) => sortValue(b) - sortValue(a));
});
</script>

<template>
  <div :class="$style.page">
    <SectionHeader>倒货助手</SectionHeader>
    <div :class="$style.subTitle">
      跨 CX 交易所价差 · 6 市场 · FX 1:1 假设 · 不含运输/手续费
      <span v-if="dataAgeMinutes !== null" :class="$style.age">
        FIO 数据：{{ dataAgeMinutes }} 分钟前
      </span>
    </div>

    <div :class="$style.controls">
      <input v-model="search" :class="$style.input" type="text" placeholder="搜索 ticker 或名称" />
      <label :class="$style.control">
        <span :class="$style.controlLabel">类别</span>
        <SelectInput v-model="categoryFilter" :options="categoryOptions" />
      </label>
      <label :class="$style.control">
        <span :class="$style.controlLabel">排序</span>
        <SelectInput v-model="sortKey" :options="sortOptions" />
      </label>
      <label :class="$style.checkbox">
        <input v-model="onlyPositive" type="checkbox" />
        <span>仅正机会 ({{ positiveCount }})</span>
      </label>
    </div>

    <div :class="$style.tableWrap">
      <table :class="$style.table">
        <thead>
          <tr>
            <th>商品</th>
            <th>类别</th>
            <th>买入 (最低 ask)</th>
            <th>卖出 (最高 bid)</th>
            <th :class="$style.numCol">单价利润</th>
            <th :class="$style.numCol">利润率</th>
            <th :class="$style.numCol">可成交量</th>
            <th :class="$style.numCol">总利润</th>
          </tr>
        </thead>
        <tbody v-if="noData">
          <tr>
            <td colspan="8" :class="$style.empty">正在加载 FIO 价格数据，请稍候…</td>
          </tr>
        </tbody>
        <tbody v-else-if="filtered.length === 0">
          <tr>
            <td colspan="8" :class="$style.empty">没有符合条件的套利机会。</td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="o in filtered" :key="o.ticker">
            <td :class="$style.materialCell">
              <MaterialIcon :ticker="o.ticker" size="medium" />
              <div :class="$style.materialMeta">
                <strong>{{ o.ticker }}</strong>
                <span>{{ o.name }}</span>
              </div>
            </td>
            <td :class="$style.categoryCell">{{ o.category }}</td>
            <td :class="$style.marketCell">
              <PrunLink inline :command="`CXPO ${o.ticker}.${o.buyExchange}`">
                {{ o.buyExchange }}
              </PrunLink>
              <span :class="$style.price">
                {{ fixed2(o.buyPrice) }} {{ o.buyCurrency }}
                <span
                  v-if="o.buyLive"
                  :class="$style.liveDot"
                  data-tooltip="实时订单簿"
                  data-tooltip-position="top"></span>
              </span>
            </td>
            <td :class="$style.marketCell">
              <PrunLink inline :command="`CXPO ${o.ticker}.${o.sellExchange}`">
                {{ o.sellExchange }}
              </PrunLink>
              <span :class="$style.price">
                {{ fixed2(o.sellPrice) }} {{ o.sellCurrency }}
                <span
                  v-if="o.sellLive"
                  :class="$style.liveDot"
                  data-tooltip="实时订单簿"
                  data-tooltip-position="top"></span>
              </span>
            </td>
            <td :class="[$style.numCell, o.profitPerUnit > 0 ? $style.pos : $style.neg]">
              {{ fixed2(o.profitPerUnit) }}
            </td>
            <td :class="[$style.numCell, o.profitPerUnit > 0 ? $style.pos : $style.neg]">
              {{ percent2(o.profitPct) }}
            </td>
            <td :class="$style.numCell">
              {{ o.executableVolume !== null ? fixed0(o.executableVolume) : '--' }}
            </td>
            <td :class="[$style.numCell, o.profitPerUnit > 0 ? $style.pos : $style.neg]">
              {{ o.totalProfit !== null ? fixed0(o.totalProfit) : '--' }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style module>
.page {
  overflow-x: auto;
}

.subTitle {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 2px 0 6px;
  color: rgb(167, 176, 183);
  font-size: 12px;
}

.age {
  color: rgb(148, 158, 166);
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
}

.input {
  box-sizing: border-box;
  width: 200px;
  padding: 4px 6px;
  border: 1px solid rgb(61, 74, 84);
  background: rgb(26, 33, 38);
  color: rgb(226, 230, 233);
  font: inherit;
  outline: none;
}

.input:focus {
  border-color: rgb(255, 176, 0);
  box-shadow: inset 0 0 0 1px rgb(255, 176, 0);
  background: rgb(30, 38, 44);
}

.input::placeholder {
  color: rgb(148, 158, 166);
}

.control {
  display: flex;
  align-items: center;
  gap: 4px;
}

.controlLabel {
  color: rgb(200, 208, 214);
  white-space: nowrap;
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
  white-space: nowrap;
  color: rgb(200, 208, 214);
}

.checkbox input {
  accent-color: rgb(255, 176, 0);
}

.tableWrap {
  min-width: 0;
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  table-layout: fixed;
}

.table th,
.table td {
  padding: 4px 8px;
  text-align: left;
  vertical-align: middle;
  white-space: nowrap;
}

.table th {
  color: rgb(200, 208, 214);
  font-weight: normal;
  border-bottom: 1px solid rgb(61, 74, 84);
}

.table tbody tr:hover {
  background: rgb(40, 49, 56);
}

.table td:first-child,
.table th:first-child {
  width: auto;
}

.numCol {
  width: 92px;
  text-align: right;
}

.materialCell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.materialMeta {
  min-width: 0;
}

.materialMeta strong {
  display: block;
  color: rgb(255, 176, 0);
}

.materialMeta span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(167, 176, 183);
  font-size: 11px;
}

.categoryCell {
  color: rgb(167, 176, 183);
  font-size: 11px;
}

.marketCell {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.price {
  color: rgb(200, 208, 214);
  font-size: 11px;
}

.liveDot {
  display: inline-block;
  width: 6px;
  height: 6px;
  margin-left: 3px;
  border-radius: 50%;
  background: rgb(129, 199, 132);
  vertical-align: middle;
}

.numCell {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.pos {
  color: rgb(129, 199, 132);
}

.neg {
  color: rgb(229, 115, 115);
}

.empty {
  padding: 16px 8px;
  text-align: center;
  color: rgb(167, 176, 183);
}
</style>
