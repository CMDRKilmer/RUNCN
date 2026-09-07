<script setup lang="ts">
import MaterialIcon from '@src/components/MaterialIcon.vue';
import PrunLink from '@src/components/PrunLink.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { cxStore } from '@src/infrastructure/fio/cx';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getMaterialName } from '@src/infrastructure/prun-ui/i18n';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { fixed0, fixed2 } from '@src/utils/format';
import { userData } from '@src/store/user-data';
import { getTileState } from '@src/store/user-data-tiles';
import { getWarehouseName } from '@src/features/XIT/CART/cart-utils';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
import { computeComponents, computeTotals, type BpcExchange } from '../BPC/bp-utils';

const cart = computed(() => userData.cart);

// 购物车物品即购买表的需求清单（同一 ticker 在 CART 内已合并）。
const needs = computed(() =>
  cart.value.items
    .filter(item => item.ticker && Number.isFinite(item.amount) && item.amount > 0)
    .map(item => ({
      ticker: item.ticker,
      name: item.ticker,
      amount: item.amount,
    })),
);

const selectedTickers = ref<Set<string>>(new Set());

// 硬编码 4 个玩家 CX 交易所（与 BPC/BMAT/ARB 一致），避免运行时依赖 exchangesStore。
const exchanges: BpcExchange[] = [
  { code: 'AI1', currency: 'AIC' },
  { code: 'CI1', currency: 'CIS' },
  { code: 'IC1', currency: 'ICA' },
  { code: 'NC1', currency: 'NCC' },
];

const components = computed(() => computeComponents(needs.value, exchanges));
const totals = computed(() => computeTotals(components.value, exchanges, selectedTickers.value));

const noItems = computed(() => needs.value.length === 0);
const noData = computed(() => !cxStore.fetched);

function openCart() {
  showBuffer('XIT CART');
}

function toggleTicker(ticker: string) {
  const next = new Set(selectedTickers.value);
  if (next.has(ticker)) {
    next.delete(ticker);
  } else {
    next.add(ticker);
  }
  selectedTickers.value = next;
}

function toggleAll() {
  if (allSelected.value) {
    selectedTickers.value = new Set();
  } else {
    selectedTickers.value = new Set(components.value.map(c => c.ticker));
  }
}

const allSelected = computed(
  () =>
    components.value.length > 0 && components.value.every(c => selectedTickers.value.has(c.ticker)),
);
const partialSelected = computed(
  () => !allSelected.value && components.value.some(c => selectedTickers.value.has(c.ticker)),
);

// 已选物品（按 ticker 去重），按全市场最优交易所分组。
// 返回值：exchangeCode -> { ticker: amount }。
const selectedByExchange = computed(() => {
  const groups = new Map<string, Record<string, number>>();
  for (const c of components.value) {
    if (!selectedTickers.value.has(c.ticker) || c.bestExchange === undefined) {
      continue;
    }
    const bucket = groups.get(c.bestExchange) ?? {};
    bucket[c.ticker] = (bucket[c.ticker] ?? 0) + c.amount;
    groups.set(c.bestExchange, bucket);
  }
  return groups;
});

// ACT 生成选项。
const singleMarketMode = ref(false);
const transferToShip = ref(false);

const cheapestSingleExchange = computed(() => totals.value.cheapestSingle?.code);

// 按"单市场"或"混合最优"分组的 selectedByExchange。
const actGroups = computed(() => {
  if (singleMarketMode.value) {
    const code = cheapestSingleExchange.value;
    if (!code) {
      return new Map<string, Record<string, number>>();
    }
    const bucket: Record<string, number> = {};
    for (const c of components.value) {
      if (!selectedTickers.value.has(c.ticker)) {
        continue;
      }
      bucket[c.ticker] = (bucket[c.ticker] ?? 0) + c.amount;
    }
    return new Map([[code, bucket]]);
  }
  return selectedByExchange.value;
});

const canGenerateActOptions = computed(() => actGroups.value.size > 0);

// 与 BPC/BMAT 一致的 ASCII 净化：XIT 参数仅吃 ASCII。
function asciiSafe(value: string): string {
  return value
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function generateAct() {
  if (actGroups.value.size === 0) {
    return;
  }
  const groups: UserData.MaterialGroupData[] = [];
  const actions: UserData.ActionData[] = [];
  for (const [exchangeCode, materials] of actGroups.value) {
    const groupName = `CBUY_${exchangeCode}`;
    groups.push({ type: 'Manual', name: groupName, materials });
    actions.push({
      type: 'CX Buy',
      name: `Buy_${exchangeCode}`,
      group: groupName,
      exchange: exchangeCode,
      priceLimits: {},
      buyPartial: false,
      allowUnfilled: false,
      useCXInv: true,
    });
    if (!transferToShip.value) {
      continue;
    }
    actions.push({
      type: 'MTRA',
      name: `Transfer_${exchangeCode}`,
      group: groupName,
      origin: getWarehouseName(exchangeCode),
      dest: configurableValue,
    });
  }
  // 包名用购物车名 + " Buy" 后缀，避免与 CART 生成的同名 ACT 包互相覆盖。
  const asciiName = asciiSafe(cart.value.name);
  const name = asciiName ? `${asciiName} Buy` : 'Shopping Cart Buy';
  const pkg: UserData.ActionPackageData = { global: { name }, groups, actions };
  const existing = userData.actionPackages.findIndex(p => p.global.name === name);
  if (existing >= 0) {
    userData.actionPackages[existing] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }
  const commandName = name.replace(/\s+/g, '_');
  showBuffer(`XIT ACT_${commandName}`);
}

// 把当前已选物品（未选则全部）以顶层 materials 形态发给 CONTGEN 起草合同。
function sendToContgen() {
  if (components.value.length === 0) {
    return;
  }
  const tickersToSend =
    selectedTickers.value.size > 0
      ? new Set(selectedTickers.value)
      : new Set(components.value.map(c => c.ticker));
  const materials: Record<string, number> = {};
  for (const c of components.value) {
    if (!tickersToSend.has(c.ticker)) {
      continue;
    }
    materials[c.ticker] = (materials[c.ticker] ?? 0) + c.amount;
  }
  if (Object.keys(materials).length === 0) {
    return;
  }
  const payload: { materials: Record<string, number>; name?: string } = { materials };
  const asciiName = asciiSafe(cart.value.name);
  if (asciiName.length > 0) {
    payload.name = asciiName;
  }
  const ws = getTileState<{ json?: string }>('contgen-import');
  ws.json = JSON.stringify(payload);
  showBuffer('XIT CONTGEN');
}

const canSendToContgen = computed(() => components.value.length > 0);

// 与 BPC/BMAT 一致：对当前所有 (ticker, 交易所) 打开 CXOB 缓冲窗拉取实时订单簿。
function refreshPrices() {
  const requested = new Set<string>();
  for (const component of components.value) {
    for (const exchange of exchanges) {
      const key = `${component.ticker}.${exchange.code}`;
      if (requested.has(key) || cxobStore.getByTicker(key) !== undefined) {
        continue;
      }
      requested.add(key);
      showBuffer(`CXOB ${key}`, {
        autoClose: true,
        closeWhen: computed(() => cxobStore.getByTicker(key) !== undefined),
      });
    }
  }
}

function localized(component: { ticker: string; name: string }): string {
  const material = materialsStore.getByTicker(component.ticker);
  return getMaterialName(material) ?? component.name ?? component.ticker;
}

const search = ref('');

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

function currencyOf(code: string): string {
  return exchanges.find(x => x.code === code)?.currency ?? '';
}

function isBest(component: { bestExchange?: string }, code: string) {
  return component.bestExchange === code;
}
</script>

<template>
  <div :class="$style.page">
    <div :class="$style.controls">
      <span :class="$style.controlLabel">购物车</span>
      <span :class="$style.cartMeta">
        <strong>{{ cart.name }}</strong>
        <template v-if="cart.exchange"> · {{ cart.exchange }}</template>
        · {{ cart.items.length }} 种
      </span>
      <input
        id="cbu-search"
        v-model="search"
        name="cbu-search"
        :class="$style.input"
        type="text"
        placeholder="搜索物品 ticker 或名称" />
      <PrunButton primary :disabled="noItems" @click="refreshPrices">更新价格</PrunButton>
      <label :class="$style.control">
        <input
          id="cbu-single-market"
          v-model="singleMarketMode"
          name="cbu-single-market"
          type="checkbox"
          :disabled="!cheapestSingleExchange" />
        <span :class="$style.controlLabel">单市场购买</span>
      </label>
      <label :class="$style.control">
        <input
          id="cbu-transfer-ship"
          v-model="transferToShip"
          name="cbu-transfer-ship"
          type="checkbox" />
        <span :class="$style.controlLabel">转移到飞船</span>
      </label>
      <PrunButton primary :disabled="!canGenerateActOptions" @click="generateAct"
        >生成 ACT</PrunButton
      >
      <PrunButton
        primary
        :disabled="!canSendToContgen"
        data-tooltip="把当前已选物品清单发送到 CONTGEN 用于起草合同"
        data-tooltip-position="top"
        @click="sendToContgen"
        >导入到 CONTGEN</PrunButton
      >
    </div>

    <div v-if="noItems" :class="$style.empty">
      购物车是空的。请先到
      <PrunButton dark inline @click="openCart">XIT CART</PrunButton>
      添加要购买的物品。
    </div>
    <div v-else-if="noData" :class="$style.empty">正在加载 FIO 价格数据，请稍候…</div>
    <template v-else>
      <div :class="$style.summaryBar">
        <span :class="$style.summaryItem">
          物品 ·
          <strong>{{ components.length }}</strong> 种
          <span v-if="selectedTickers.size > 0" :class="$style.summaryProfit">
            · 已选 <strong>{{ selectedTickers.size }}</strong> 种</span
          >
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
          <span v-else :class="$style.summaryWarn">无交易所凑齐全部物品</span>
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
              <th :class="$style.checkCol">
                <input
                  type="checkbox"
                  :checked="allSelected"
                  :indeterminate.prop="partialSelected"
                  @change="toggleAll" />
              </th>
              <th :class="$style.materialCol">物品</th>
              <th :class="$style.numCol">数量</th>
              <th
                v-for="ex in exchanges"
                :key="ex.code"
                :class="$style.priceCol"
                :title="`${ex.code} · ${ex.currency}`">
                {{ ex.code }}
              </th>
              <th :class="$style.bestPriceCol">最优价</th>
              <th :class="$style.sourceCol">最优来源</th>
            </tr>
          </thead>
          <tbody v-if="filtered.length === 0">
            <tr>
              <td colspan="100" :class="$style.empty">
                {{ components.length === 0 ? '购物车暂无可比价的物品。' : '没有匹配的物品。' }}
              </td>
            </tr>
          </tbody>
          <tbody v-else>
            <tr v-for="c in filtered" :key="c.ticker">
              <td :class="$style.checkCell">
                <input
                  type="checkbox"
                  :checked="selectedTickers.has(c.ticker)"
                  @change="toggleTicker(c.ticker)" />
              </td>
              <td :class="$style.materialCell">
                <MaterialIcon :ticker="c.ticker" size="medium" />
                <span :class="$style.materialName" :title="`${c.ticker} · ${localized(c)}`">{{
                  localized(c)
                }}</span>
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
                  <span :class="$style.currencyTag">{{ ex.currency }}</span>
                </PrunLink>
                <span v-else :class="$style.muted">--</span>
              </td>
              <td :class="[$style.numCell, $style.bestPrice]">
                <span v-if="c.bestPrice !== undefined">
                  {{ fixed2(c.bestPrice) }}
                  <span :class="$style.currencyTag">{{ currencyOf(c.bestExchange!) }}</span>
                </span>
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

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding-bottom: 8px;
}

.controlLabel {
  color: rgb(200, 208, 214);
  white-space: nowrap;
}

.cartMeta {
  color: rgb(148, 158, 166);
  font-size: 12px;
  white-space: nowrap;
}

.cartMeta strong {
  color: rgb(255, 176, 0);
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

.control {
  display: flex;
  align-items: center;
  gap: 4px;
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
  vertical-align: middle;
}

.table td {
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.table th {
  color: rgb(200, 208, 214);
  font-weight: normal;
  border-bottom: 1px solid rgb(61, 74, 84);
  white-space: nowrap;
}

.table tbody tr:hover {
  background: rgb(40, 49, 56);
}

.checkCol {
  text-align: center;
  padding: 2px 4px;
}

.checkCol input {
  cursor: pointer;
  accent-color: rgb(255, 176, 0);
}

.checkCell {
  text-align: center;
  padding: 2px 4px;
  border-bottom: 1px solid rgb(36, 44, 52);
}

.checkCell input {
  cursor: pointer;
  accent-color: rgb(255, 176, 0);
}

.materialCol {
  text-align: left;
  min-width: 180px;
}

.materialCell {
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid rgb(36, 44, 52);
}

.materialName {
  display: inline-block;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgb(226, 230, 233);
}

.numCol {
  text-align: center;
  min-width: 60px;
}

.numCell {
  text-align: center;
  font-variant-numeric: tabular-nums;
  border-bottom: 1px solid rgb(36, 44, 52);
}

.priceCol {
  text-align: center;
  min-width: 100px;
}

.priceCell {
  text-align: center;
  font-variant-numeric: tabular-nums;
  border-bottom: 1px solid rgb(36, 44, 52);
}

.priceCell.best {
  background: rgba(129, 199, 132, 0.14);
  border-left: 2px solid rgb(129, 199, 132);
  color: rgb(129, 199, 132);
  font-weight: 600;
}

.bestPriceCol {
  text-align: center;
  min-width: 110px;
}

.bestPrice {
  color: rgb(126, 217, 87);
  font-weight: 600;
  text-align: center;
}

.sourceCol {
  text-align: center;
  min-width: 110px;
}

.sourceCell {
  white-space: nowrap;
  border-bottom: 1px solid rgb(36, 44, 52);
  text-align: center;
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

.currencyTag {
  color: rgb(148, 158, 166);
  font-size: 10px;
  margin-left: 3px;
  font-weight: normal;
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
