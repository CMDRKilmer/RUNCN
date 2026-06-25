<script setup lang="ts">
import { computed, useCssModule } from 'vue';
import { cxStore, TickerPriceInfo } from '@src/infrastructure/fio/cx';
import { fixed01, formatCurrency, fixed0 } from '@src/utils/format';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';

const props = defineProps<{
  ticker: string;
  exchange: string;
}>();

const info = computed<TickerPriceInfo | undefined>(() => {
  if (!props.ticker || !props.exchange || !cxStore.fetched) {
    return undefined;
  }
  return cxStore.prices.get(props.exchange)?.get(props.ticker) as TickerPriceInfo | undefined;
});

const material = computed(() => materialsStore.getByTicker(props.ticker));

// Ask 与 7D 均价偏差百分比（正数=高于均价）
const askVs7D = computed(() => deviation(info.value?.Ask, info.value?.VWAP7D));

function deviation(current?: number | null, average?: number | null) {
  if (current === undefined || current === null) return undefined;
  if (average === undefined || average === null) return undefined;
  if (average === 0) return undefined;
  return (current - average) / average;
}

// Ask 是否明显偏离 7D 均价（>10%），用于加粗显示
const isAskFarFrom7D = computed(() => {
  const d = askVs7D.value;
  return d !== undefined && Math.abs(d) > 0.1;
});

const style = useCssModule();

function priceClass(d: number | undefined) {
  if (d === undefined) return undefined;
  if (d > 0) return style.priceHigh;
  if (d < 0) return style.priceLow;
  return undefined;
}

function formatPercent(d: number | undefined) {
  if (d === undefined) return '-';
  const sign = d > 0 ? '+' : '';
  return `${sign}${fixed01(d * 100)}%`;
}

function formatVolume(v: number | undefined | null) {
  if (v === undefined || v === null) return '-';
  if (v >= 1_000_000) return `${fixed01(v / 1_000_000)}M`;
  if (v >= 1_000) return `${fixed01(v / 1_000)}K`;
  return fixed0(v);
}

function nullable(v: number | null | undefined) {
  return v ?? undefined;
}
</script>

<template>
  <div :class="$style.root">
    <div :class="$style.header">
      <MaterialIcon v-if="material" size="inline-table" :ticker="ticker" />
      <span :class="$style.ticker">{{ ticker }}</span>
    </div>
    <template v-if="!info">
      <span :class="$style.muted">无价格数据</span>
    </template>
    <template v-else>
      <div :class="$style.row">
        <span :class="$style.label">Ask</span>
        <span
          :class="[$style.value, priceClass(askVs7D), isAskFarFrom7D && $style.bold]"
          :data-tooltip="
            askVs7D !== undefined ? `相对 7D 均价 ${formatPercent(askVs7D)}` : '无 7D 均价数据'
          ">
          {{ formatCurrency(nullable(info.Ask), fixed01) }}
        </span>
        <span :class="$style.label">Bid</span>
        <span :class="$style.value">{{ formatCurrency(nullable(info.Bid), fixed01) }}</span>
      </div>
      <div :class="$style.row">
        <span :class="$style.label">7D 均价</span>
        <span :class="$style.value">
          {{ formatCurrency(nullable(info.VWAP7D), fixed01) }}
          <span :class="$style.sub">{{ formatVolume(info.Traded7D) }}</span>
        </span>
        <span :class="$style.label">30D 均价</span>
        <span :class="$style.value">
          {{ formatCurrency(nullable(info.VWAP30D), fixed01) }}
          <span :class="$style.sub">{{ formatVolume(info.Traded30D) }}</span>
        </span>
      </div>
    </template>
  </div>
</template>

<style module>
.root {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 6px;
  font-size: 11px;
  color: #bbbbbb;
  background: rgba(0, 0, 0, 0.15);
  border-left: 2px solid #2b485a;
  margin: 2px 0 4px;
}

.header {
  display: flex;
  align-items: center;
  gap: 4px;
  color: #ccc;
}

.ticker {
  font-weight: 600;
  letter-spacing: 0.5px;
}

.row {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
}

.label {
  color: #888;
}

.value {
  color: #ddd;
}

.sub {
  color: #777;
  margin-left: 4px;
  font-size: 10px;
}

.muted {
  color: #777;
  font-style: italic;
}

.priceHigh {
  color: rgb(217, 83, 79);
}

.priceLow {
  color: rgb(92, 184, 92);
}

.bold {
  font-weight: 700;
}
</style>
