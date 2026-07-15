<script setup lang="ts">
import MaterialIcon from '@src/components/MaterialIcon.vue';
import PrunLink from '@src/components/PrunLink.vue';
import { cxStore } from '@src/infrastructure/fio/cx';
import { blueprintsStore } from '@src/infrastructure/prun-api/data/blueprints';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getMaterialName } from '@src/infrastructure/prun-ui/i18n';
import { timestampEachMinute } from '@src/utils/dayjs';
import { fixed0, fixed2 } from '@src/utils/format';
import {
  collectBlueprintNeeds,
  computeComponents,
  computeTotals,
  getBpcExchanges,
} from './bp-utils';

const search = ref('');

// 蓝图列表按名称排序。访问 blueprintsStore.all 会触发一次 BLU 缓冲窗请求
// （request-hooks 内部有 singleBufferRequest 守卫，只开一次）。
const blueprints = computed(() =>
  (blueprintsStore.all.value ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)),
);
const blueprintOptions = computed(() =>
  blueprints.value.map(bp => ({
    label: `${bp.name} (${bp.naturalId})`,
    value: bp.naturalId,
  })),
);

const selectedBlueprintId = ref('');
watch(
  blueprints,
  list => {
    if (list.length > 0 && !list.some(bp => bp.naturalId === selectedBlueprintId.value)) {
      selectedBlueprintId.value = list[0].naturalId;
    }
  },
  { immediate: true },
);

const selectedBlueprint = computed(() =>
  blueprints.value.find(bp => bp.naturalId === selectedBlueprintId.value),
);

const exchanges = computed(() => getBpcExchanges());

const needs = computed(() => collectBlueprintNeeds(selectedBlueprint.value));
const components = computed(() => computeComponents(needs.value, exchanges.value));
const totals = computed(() => computeTotals(components.value, exchanges.value));

const noData = computed(() => !cxStore.fetched);
const noBlueprints = computed(() => blueprints.value.length === 0);

// Reactive data age (re-evaluates each minute via timestampEachMinute).
const dataAgeMinutes = computed(() => {
  if (cxStore.age === 0) {
    return null;
  }
  void timestampEachMinute.value;
  return Math.max(0, Math.floor((Date.now() - cxStore.age) / 60000));
});

function localized(component: { ticker: string; name: string }): string {
  const material = materialsStore.getByTicker(component.ticker);
  return getMaterialName(material) ?? component.name ?? component.ticker;
}

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) {
    return components.value;
  }
  return components.value.filter(c =>
    `${c.ticker} ${c.name} ${localized(c)}`.toLowerCase().includes(query),
  );
});

function priceOf(
  component: { prices: Map<string, { price: number; amount: number; live: boolean }> },
  code: string,
) {
  return component.prices.get(code);
}

function isBest(component: { bestExchange?: string }, code: string) {
  return component.bestExchange === code;
}
</script>

<template>
  <div :class="$style.page">
    <div :class="$style.warning">
      <span>
        市场价格有时效性，采购需谨慎
        <span v-if="dataAgeMinutes !== null" :class="$style.warningAge">
          · FIO 数据 {{ dataAgeMinutes }} 分钟前
        </span>
      </span>
    </div>

    <div :class="$style.controls">
      <label :class="$style.control">
        <span :class="$style.controlLabel">蓝图</span>
        <select v-model="selectedBlueprintId" :class="$style.select" style="width: 260px">
          <option v-for="opt in blueprintOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <input
        v-model="search"
        :class="$style.input"
        type="text"
        placeholder="搜索配件 ticker 或名称" />
    </div>

    <div v-if="noBlueprints" :class="$style.empty">尚未加载到任何蓝图（请先打开 BLU 命令）。</div>
    <div v-else-if="noData" :class="$style.empty">正在加载 FIO 价格数据，请稍候…</div>
    <template v-else>
      <div :class="$style.summaryBar">
        <span :class="$style.summaryItem">
          配件 ·
          <strong>{{ components.length }}</strong> 种
          <span v-if="totals.mixedMissing > 0" :class="$style.summaryWarn">
            · {{ totals.mixedMissing }} 种无报价</span
          >
        </span>
        <span :class="$style.summaryItem">
          最便宜单交易所 ·
          <strong v-if="totals.cheapestSingle">
            {{ totals.cheapestSingle.code }}
            {{ fixed0(totals.cheapestSingle.total) }}
            {{ totals.cheapestSingle.currency }}</strong
          >
          <span v-else :class="$style.summaryWarn">无交易所凑齐全部配件</span>
        </span>
        <span :class="[$style.summaryItem, $style.summaryProfit]">
          最优混合总价 ·
          <strong>{{ fixed0(totals.mixedTotal) }}</strong>
          <span :class="$style.summaryNote">（1:1 不含汇率）</span>
        </span>
      </div>

      <div :class="$style.tableWrap">
        <table :class="$style.table">
          <thead>
            <tr>
              <th :class="$style.materialCol">配件</th>
              <th :class="$style.numCol">需求</th>
              <th
                v-for="ex in exchanges"
                :key="ex.code"
                :class="$style.priceCol"
                :data-tooltip="`${ex.code} · ${ex.currency}`"
                data-tooltip-position="bottom">
                {{ ex.code }}
              </th>
              <th :class="$style.numCol">最优价</th>
              <th :class="$style.sourceCol">最优来源</th>
            </tr>
          </thead>
          <tbody v-if="filtered.length === 0">
            <tr>
              <td :colspan="exchanges.length + 4" :class="$style.empty">
                {{ components.length === 0 ? '该蓝图暂无物料清单。' : '没有匹配的配件。' }}
              </td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr v-for="c in filtered" :key="c.ticker">
              <td :class="$style.materialCell">
                <MaterialIcon :ticker="c.ticker" size="medium" />
              </td>
              <td :class="$style.numCell">{{ fixed0(c.amount) }}</td>
              <td
                v-for="ex in exchanges"
                :key="ex.code"
                :class="[$style.priceCell, isBest(c, ex.code) ? $style.best : '']">
                <PrunLink
                  v-if="priceOf(c, ex.code)"
                  inline
                  :command="`CXPO ${c.ticker}.${ex.code}`">
                  {{ fixed2(priceOf(c, ex.code)!.price) }}
                </PrunLink>
                <span v-else :class="$style.muted">--</span>
              </td>
              <td :class="[$style.numCell, $style.bestPrice]">
                <span v-if="c.bestPrice !== undefined">{{ fixed2(c.bestPrice) }}</span>
                <span v-else :class="$style.muted">--</span>
              </td>
              <td :class="$style.sourceCell">
                <template v-if="c.bestExchange">
                  <PrunLink inline :command="`CXPO ${c.ticker}.${c.bestExchange}`">
                    <span :class="$style.sourceBadge">{{ c.bestExchange }}</span>
                  </PrunLink>
                  <span
                    v-if="c.bestAmount !== undefined && c.bestAmount > 0"
                    :class="$style.sourceQty"
                    data-tooltip="该价位挂单量"
                    data-tooltip-position="top"
                    >×{{ fixed0(c.bestAmount) }}</span
                  >
                  <span
                    v-if="c.bestLive"
                    :class="$style.liveDot"
                    data-tooltip="实时订单簿"
                    data-tooltip-position="top"></span>
                </template>
                <span v-else :class="$style.muted">--</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div :class="$style.exchangeTotals">
        <div
          v-for="et in totals.exchanges"
          :key="et.code"
          :class="[
            $style.exchangeCard,
            totals.cheapestSingle && totals.cheapestSingle.code === et.code
              ? $style.exchangeCardBest
              : '',
            !et.complete ? $style.exchangeCardIncomplete : '',
          ]">
          <div :class="$style.exchangeCardHead">
            <strong>{{ et.code }}</strong>
            <span :class="$style.exchangeCurrency">{{ et.currency }}</span>
          </div>
          <div :class="$style.exchangeTotal">{{ fixed0(et.total) }}</div>
          <div :class="$style.exchangeMeta">
            <span v-if="et.complete" :class="$style.completeTag">凑齐</span>
            <span v-else :class="$style.incompleteTag">缺 {{ et.missing }} 种</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style module>
.page {
  overflow-x: hidden;
}

.warning {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  margin-bottom: 4px;
  border: 1px solid rgb(204, 110, 56);
  border-left-width: 3px;
  background: rgba(204, 110, 56, 0.1);
  color: rgb(238, 154, 89);
  font-size: 12px;
  font-weight: 600;
}

.warningAge {
  color: rgb(194, 120, 70);
  font-weight: normal;
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
  width: 160px;
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

.select {
  box-sizing: border-box;
  padding: 3px 6px;
  border: 1px solid rgb(61, 74, 84);
  background: rgb(26, 33, 38);
  color: rgb(226, 230, 233);
  font: inherit;
  outline: none;
}

.select:focus {
  border-color: rgb(255, 176, 0);
  box-shadow: inset 0 0 0 1px rgb(255, 176, 0);
  background: rgb(30, 38, 44);
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

.summaryBar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 6px 8px;
  margin-bottom: 6px;
  border: 1px solid rgb(61, 74, 84);
  background: rgba(255, 176, 0, 0.06);
  border-radius: 4px;
}

.summaryItem {
  color: rgb(200, 208, 214);
  font-size: 12px;
}

.summaryItem strong {
  color: rgb(255, 176, 0);
  font-size: 13px;
  padding: 0 2px;
}

.summaryWarn {
  color: rgb(229, 115, 115);
}

.summaryProfit strong {
  color: rgb(126, 217, 87);
}

.summaryNote {
  color: rgb(148, 158, 166);
  font-size: 11px;
}

.tableWrap {
  min-width: 0;
  overflow-x: auto;
}

.table {
  width: 100%;
  border-collapse: collapse;
  table-layout: auto;
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

.materialCol {
  width: 54px;
}

.materialCell {
  text-align: center;
}

.numCol {
  width: 72px;
  text-align: right;
}

.priceCol {
  width: 64px;
  text-align: right;
}

.priceCell {
  text-align: right;
  font-variant-numeric: tabular-nums;
  border-left: 2px solid transparent;
}

.priceCell.best {
  background: rgba(129, 199, 132, 0.14);
  border-left-color: rgb(129, 199, 132);
  color: rgb(129, 199, 132);
  font-weight: 600;
}

.numCell {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.bestPrice {
  color: rgb(126, 217, 87);
  font-weight: 600;
}

.sourceCol {
  width: 110px;
}

.sourceCell {
  white-space: nowrap;
}

.sourceBadge {
  display: inline-block;
  min-width: 32px;
  padding: 0 6px;
  border-radius: 2px;
  background: rgba(126, 217, 87, 0.2);
  color: rgb(126, 217, 87);
  font-size: 11px;
  font-weight: 600;
  text-align: center;
}

.sourceQty {
  color: rgb(148, 158, 166);
  font-size: 11px;
  margin-left: 4px;
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

.muted {
  color: rgb(120, 130, 138);
}

.empty {
  padding: 16px 8px;
  text-align: center;
  color: rgb(167, 176, 183);
}

.exchangeTotals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 6px;
  margin-top: 8px;
}

.exchangeCard {
  padding: 6px 8px;
  border: 1px solid rgb(61, 74, 84);
  border-radius: 4px;
  background: rgb(26, 33, 38);
}

.exchangeCardBest {
  border-color: rgb(126, 217, 87);
  background: rgba(126, 217, 87, 0.08);
}

.exchangeCardIncomplete {
  opacity: 0.7;
}

.exchangeCardHead {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.exchangeCardHead strong {
  color: rgb(255, 176, 0);
}

.exchangeCurrency {
  color: rgb(148, 158, 166);
  font-size: 11px;
}

.exchangeTotal {
  color: rgb(226, 230, 233);
  font-size: 15px;
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
}

.exchangeMeta {
  margin-top: 2px;
  font-size: 11px;
}

.completeTag {
  color: rgb(126, 217, 87);
}

.incompleteTag {
  color: rgb(229, 115, 115);
}
</style>
