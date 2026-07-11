<script setup lang="ts">
import SectionHeader from '@src/components/SectionHeader.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import PrunLink from '@src/components/PrunLink.vue';
import { cxStore } from '@src/infrastructure/fio/cx';
import { getMaterialName } from '@src/infrastructure/prun-ui/i18n';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { timestampEachMinute } from '@src/utils/dayjs';
import { fixed0, fixed2, percent2 } from '@src/utils/format';
import {
  computeOpportunities,
  getArbExchanges,
  getCategories,
  resolveCategoryLabel,
  type ArbOpportunity,
} from './arb-utils';

const search = ref('');
const categoryFilter = ref('ALL');
const onlyPositive = ref(true);
const sortKey = ref('profitPct');

// 路线选择：出发地（买入）/ 目的地（卖出）。
const allExchanges = computed(() => getArbExchanges());
const exchangeOptions = computed(() =>
  allExchanges.value.map(x => ({ label: x.code, value: x.code })),
);
const sourceExchange = ref('IC1');
const destExchange = ref('');
watch(
  allExchanges,
  list => {
    if (list.length > 0 && !destExchange.value) {
      destExchange.value = list.find(x => x.code === 'AI1')?.code ?? list.at(-1)?.code ?? '';
    }
  },
  { immediate: true },
);

const categoryOptions = computed(() => [
  { label: '全部类别', value: 'ALL' },
  ...getCategories().map(id => ({ label: resolveCategoryLabel(id), value: id })),
]);

const sortOptions = [
  { label: '利润率', value: 'profitPct' },
  { label: '单价利润', value: 'profitPerUnit' },
  { label: '总利润', value: 'totalProfit' },
  { label: '可成交量', value: 'executableVolume' },
];

const opportunities = computed(() =>
  computeOpportunities(sourceExchange.value, destExchange.value),
);

const noData = computed(() => !cxStore.fetched);

const positiveCount = computed(() => opportunities.value.filter(o => o.profitPerUnit > 0).length);

// 飞船选择 + 容量优化。
const ships = computed(() => shipsStore.all.value ?? []);
const shipOptions = computed(() => [
  { label: '不选飞船', value: '' },
  ...ships.value.map(s => ({
    label: `${s.registration} ${s.name} (${fixed0(s.volume)} m³)`,
    value: s.id,
  })),
]);
const selectedShipId = ref('');
const selectedShip = computed(() => ships.value.find(s => s.id === selectedShipId.value) ?? null);
const shipCapacity = computed(() => selectedShip.value?.volume ?? 0);

// 用户手动勾选的商品 ticker 集合。
const checkedTickers = ref<Set<string>>(new Set());

// 单商品体积（m³/单位），优先用最小成交量换算（≈50kg/m³ 假设）。
// 实际游戏中材料密度固定，我们使用最小的可成交单位估算单件重量。
function unitVolume(opp: ArbOpportunity): number {
  // 优先用材料定义的真实单件体积。PrUn 中每件材料同时拥有 weight (kg) 和 volume (m³)，
  // 飞船容量按 m³ 计量，优先取 volume；缺失则用 weight/50 (50 kg/m³) 估算；都没有则回退 0.02。
  const material = materialsStore.getByTicker(opp.ticker);
  if (material !== undefined) {
    if (material.volume > 0) {
      return material.volume;
    }
    if (material.weight > 0) {
      return material.weight / 50;
    }
  }
  return 0.02;
}

function maxUnitsFor(opp: ArbOpportunity): number {
  if (shipCapacity.value <= 0) return opp.executableVolume ?? 0;
  return Math.min(opp.executableVolume ?? 0, Math.floor(shipCapacity.value / unitVolume(opp)));
}

function shipFitsAll(opp: ArbOpportunity): boolean {
  if (shipCapacity.value <= 0) return true;
  const units = maxUnitsFor(opp);
  return units > 0;
}

function toggleChecked(ticker: string, ev: Event) {
  const checked = (ev.target as HTMLInputElement).checked;
  const next = new Set(checkedTickers.value);
  if (checked) next.add(ticker);
  else next.delete(ticker);
  checkedTickers.value = next;
}

// 0/1 背包：在勾选商品中，按"利润密度 = 单价利润 / 单件体积"贪心分配剩余容量。
const suggestedUnits = (() => {
  const cache = new Map<string, number>();
  return (opp: ArbOpportunity): number => {
    if (!selectedShip.value) return 0;
    const key = `${selectedShipId.value}|${opp.ticker}|${checkedTickers.value.size}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    if (!checkedTickers.value.has(opp.ticker)) {
      cache.set(key, 0);
      return 0;
    }

    const items = filtered.value.filter(
      o => checkedTickers.value.has(o.ticker) && o.profitPerUnit > 0 && shipFitsAll(o),
    );
    if (items.length === 0) {
      cache.set(key, 0);
      return 0;
    }

    let remaining = shipCapacity.value;
    let mine = 0;
    // 贪心：按 profitPerUnit / vol 降序，每个商品能装多少装多少。
    const sorted = items
      .map(o => ({ o, vol: unitVolume(o), density: o.profitPerUnit / unitVolume(o) }))
      .sort((a, b) => b.density - a.density);
    for (const it of sorted) {
      const units = Math.min(maxUnitsFor(it.o), Math.floor(remaining / it.vol));
      if (units <= 0) continue;
      remaining -= units * it.vol;
      if (it.o.ticker === opp.ticker) mine = units;
    }
    cache.set(key, mine);
    return mine;
  };
})();

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
    list = list.filter(o => {
      const localized = localizedName(o).toLowerCase();
      return `${o.ticker} ${o.name} ${localized}`.toLowerCase().includes(query);
    });
  }
  return list.slice().sort((a, b) => sortValue(b) - sortValue(a));
});

function localizedName(o: ArbOpportunity): string {
  const material = materialsStore.getByTicker(o.ticker);
  return getMaterialName(material) ?? o.name;
}

function localizedCategory(o: ArbOpportunity): string {
  return resolveCategoryLabel(o.category);
}
</script>

<template>
  <div :class="$style.page">
    <SectionHeader>倒货助手</SectionHeader>
    <div :class="$style.subTitle">
      跨 CX 交易所价差 · FX 1:1 假设 · 不含运输/手续费
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
      <label :class="$style.control">
        <span :class="$style.controlLabel">出发地</span>
        <SelectInput v-model="sourceExchange" :options="exchangeOptions" />
      </label>
      <label :class="$style.control">
        <span :class="$style.controlLabel">目的地</span>
        <SelectInput v-model="destExchange" :options="exchangeOptions" />
      </label>
      <label :class="$style.checkbox">
        <input v-model="onlyPositive" type="checkbox" />
        <span>仅正机会 ({{ positiveCount }})</span>
      </label>
      <label :class="$style.control">
        <span :class="$style.controlLabel">飞船</span>
        <SelectInput v-model="selectedShipId" :options="shipOptions" />
      </label>
      <span v-if="selectedShip" :class="$style.shipInfo">
        {{ selectedShip.registration }} · 容量 <strong>{{ fixed0(selectedShip.volume) }}</strong> m³
      </span>
    </div>

    <div :class="$style.tableWrap">
      <table :class="$style.table">
        <thead>
          <tr>
            <th :class="$style.checkCol">选</th>
            <th :class="$style.materialCol">商品</th>
            <th :class="$style.categoryCol">类别</th>
            <th :class="$style.marketCol">买入 (最低 ask)</th>
            <th :class="$style.marketCol">卖出 (最高 bid)</th>
            <th :class="$style.numCol">单价利润</th>
            <th :class="$style.numCol">利润率</th>
            <th :class="$style.numCol">可成交量</th>
            <th :class="$style.numCol">建议装载</th>
            <th :class="$style.numCol">总利润</th>
          </tr>
        </thead>
        <tbody v-if="noData">
          <tr>
            <td colspan="10" :class="$style.empty">正在加载 FIO 价格数据，请稍候…</td>
          </tr>
        </tbody>
        <tbody v-else-if="filtered.length === 0">
          <tr>
            <td colspan="10" :class="$style.empty">没有符合条件的套利机会。</td>
          </tr>
        </tbody>
        <tbody v-else>
          <tr v-for="o in filtered" :key="o.ticker">
            <td :class="$style.checkCell">
              <input
                type="checkbox"
                :checked="checkedTickers.has(o.ticker)"
                :disabled="!shipFitsAll(o)"
                @change="toggleChecked(o.ticker, $event)" />
            </td>
            <td :class="$style.materialCell">
              <MaterialIcon :ticker="o.ticker" size="medium" />
            </td>
            <td :class="$style.categoryCell">{{ localizedCategory(o) }}</td>
            <td :class="[$style.marketCell, $style.marketCellBuy]">
              <span :class="[$style.marketBadge, $style.buyBadge]">买</span>
              <span :class="$style.marketExchange">
                <PrunLink inline :command="`CXPO ${o.ticker}.${o.buyExchange}`">
                  {{ o.buyExchange }}
                </PrunLink>
                <span :class="$style.marketPrice"
                  >{{ fixed2(o.buyPrice) }} {{ o.buyCurrency }}</span
                >
                <span
                  v-if="o.buyLive"
                  :class="$style.liveDot"
                  data-tooltip="实时订单簿"
                  data-tooltip-position="top"></span>
              </span>
            </td>
            <td :class="[$style.marketCell, $style.marketCellSell]">
              <span :class="[$style.marketBadge, $style.sellBadge]">卖</span>
              <span :class="$style.marketExchange">
                <PrunLink inline :command="`CXPO ${o.ticker}.${o.sellExchange}`">
                  {{ o.sellExchange }}
                </PrunLink>
                <span :class="$style.marketPrice"
                  >{{ fixed2(o.sellPrice) }} {{ o.sellCurrency }}</span
                >
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
            <td :class="$style.numCell">
              <span v-if="suggestedUnits(o) > 0" :class="$style.suggestedBadge">
                {{ fixed0(suggestedUnits(o)) }}
              </span>
              <span v-else>--</span>
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

.shipInfo {
  color: rgb(167, 176, 183);
  font-size: 12px;
  padding-left: 4px;
}

.shipInfo strong {
  color: rgb(255, 176, 0);
}

.checkCol {
  width: 32px;
  text-align: center;
  padding: 2px 4px;
}

.checkCell {
  text-align: center;
  padding: 2px 4px;
  border-bottom: 1px solid rgb(36, 44, 52);
}

.checkCell input {
  accent-color: rgb(255, 176, 0);
  cursor: pointer;
}

.checkCell input:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.suggestedBadge {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(255, 176, 0, 0.2);
  color: rgb(255, 200, 64);
  font-weight: 600;
  font-size: 11px;
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

.materialCol {
  width: 54px;
}

.materialCell {
  text-align: center;
}

.categoryCol {
  width: 12%;
  min-width: 80px;
}

.numCol {
  width: 92px;
  text-align: right;
}

.categoryCell {
  color: rgb(167, 176, 183);
  font-size: 11px;
}

.marketCell {
  padding: 2px 6px;
  border-left: 2px solid rgb(46, 56, 64);
  overflow: hidden;
  text-overflow: ellipsis;
}

.marketExchange {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  vertical-align: middle;
}

.marketPrice {
  color: rgb(200, 208, 214);
  font-size: 11px;
}

.marketCellBuy {
  background: rgba(129, 199, 132, 0.08);
  border-left-color: rgb(129, 199, 132);
}

.marketCellSell {
  background: rgba(229, 115, 115, 0.08);
  border-left-color: rgb(229, 115, 115);
}

.marketBadge {
  display: inline-block;
  min-width: 14px;
  padding: 0 4px;
  border-radius: 2px;
  font-size: 10px;
  line-height: 14px;
  text-align: center;
  font-weight: bold;
  color: rgb(26, 33, 38);
}

.buyBadge {
  background: rgb(129, 199, 132);
}

.sellBadge {
  background: rgb(229, 115, 115);
  color: rgb(255, 255, 255);
}

.marketCol {
  width: 18%;
  min-width: 180px;
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
