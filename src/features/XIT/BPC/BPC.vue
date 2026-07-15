<script setup lang="ts">
import MaterialIcon from '@src/components/MaterialIcon.vue';
import PrunLink from '@src/components/PrunLink.vue';
import { cxStore } from '@src/infrastructure/fio/cx';
import { blueprintsStore } from '@src/infrastructure/prun-api/data/blueprints';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getMaterialName } from '@src/infrastructure/prun-ui/i18n';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { fixed0, fixed2 } from '@src/utils/format';
import PrunButton from '@src/components/PrunButton.vue';
import { userData } from '@src/store/user-data';
import { getWarehouseName } from '@src/features/XIT/CART/cart-utils';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';
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
  (blueprintsStore.all.value ?? [])
    .slice()
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')),
);
const blueprintOptions = computed(() =>
  blueprints.value.map(bp => ({
    label: `${bp.name} (${bp.naturalId})`,
    value: bp.naturalId,
  })),
);

const selectedBlueprintId = ref('');
const selectedTickers = ref<Set<string>>(new Set());
watch(
  blueprints,
  list => {
    if (list.length > 0 && !list.some(bp => bp.naturalId === selectedBlueprintId.value)) {
      selectedBlueprintId.value = list[0].naturalId;
    }
  },
  { immediate: true },
);
watch(selectedBlueprintId, () => {
  selectedTickers.value = new Set();
});

const selectedBlueprint = computed(() =>
  blueprints.value.find(bp => bp.naturalId === selectedBlueprintId.value),
);

const exchanges = computed(() => getBpcExchanges());

const needs = computed(() => collectBlueprintNeeds(selectedBlueprint.value));
const components = computed(() => computeComponents(needs.value, exchanges.value));
const totals = computed(() =>
  computeTotals(components.value, exchanges.value, selectedTickers.value),
);

const noData = computed(() => !cxStore.fetched);
const noBlueprints = computed(() => blueprints.value.length === 0);

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

// 已选配件（按 ticker 去重），按全市场最优交易所分组。
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
// 单市场模式：所有配件统一从 cheapestSingle.exchange 买。
// 混合模式（默认）：每个配件按各自最优交易所买。
const actGroups = computed(() => {
  if (singleMarketMode.value) {
    const code = cheapestSingleExchange.value;
    if (!code) {
      return new Map<string, Record<string, number>>();
    }
    const bucket: Record<string, number> = {};
    for (const c of components.value) {
      if (!selectedTickers.value.has(c.ticker)) continue;
      bucket[c.ticker] = (bucket[c.ticker] ?? 0) + c.amount;
    }
    return new Map([[code, bucket]]);
  }
  return selectedByExchange.value;
});

const canGenerateActOptions = computed(() => actGroups.value.size > 0);

function generateAct() {
  if (actGroups.value.size === 0) {
    return;
  }
  const groups: UserData.MaterialGroupData[] = [];
  const actions: UserData.ActionData[] = [];
  for (const [exchangeCode, materials] of actGroups.value) {
    const groupName = `BPC_${exchangeCode}`;
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
      // 不勾"转移到飞船"：跳过 MTRA，由玩家手动从仓库转运。
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
  // 包名用 blueprint.naturalId（必为 ASCII ID 如 BP-DHEZ-4037）做前缀，
  // 配合 blueprint.name 做完整可读名（如 "BP-DHEZ-4037 HWS Defense Missile Buy"）。
  // 这样既避开了 PrUn 对非 ASCII 参数解析失败的问题，
  // 又让 ACT 列表里包名可读。
  const bp = selectedBlueprint.value;
  const bpId = bp?.naturalId ?? 'Blueprint';
  // 仅保留 name 中的可打印 ASCII 部分，避免中文 / 特殊字符干扰 PrUn XIT 参数解析。
  const asciiName = (bp?.name ?? '').replace(/[^\x20-\x7E]/g, '').trim();
  const name = asciiName ? `${bpId} ${asciiName} Buy` : `${bpId} Buy`;
  const pkg: UserData.ActionPackageData = { global: { name }, groups, actions };
  // 与 CART.generateAct 一致：若同名包已存在则覆盖，避免重复建包。
  const existing = userData.actionPackages.findIndex(p => p.global.name === name);
  if (existing >= 0) {
    userData.actionPackages[existing] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }
  const commandName = name.replace(/\s+/g, '_');
  showBuffer(`XIT ACT_${commandName}`);
}

// 与 ARB 一致：对当前可见的所有 (ticker, 交易所) 打开 CXOB 缓冲窗，
// 拉取实时订单簿（cxobStore 收到数据后 bp-utils.ts 会自动切换到 live 价格）。
function refreshPrices() {
  const requested = new Set<string>();
  for (const component of components.value) {
    for (const exchange of exchanges.value) {
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
      <PrunButton primary @click="refreshPrices">更新价格</PrunButton>
      <label :class="$style.control">
        <input v-model="singleMarketMode" type="checkbox" :disabled="!cheapestSingleExchange" />
        <span :class="$style.controlLabel">单市场购买</span>
      </label>
      <label :class="$style.control">
        <input v-model="transferToShip" type="checkbox" />
        <span :class="$style.controlLabel">转移到飞船</span>
      </label>
      <PrunButton primary :disabled="!canGenerateActOptions" @click="generateAct"
        >生成 ACT</PrunButton
      >
    </div>

    <div v-if="noBlueprints" :class="$style.empty">尚未加载到任何蓝图（请先打开 BLU 命令）。</div>
    <div v-else-if="noData" :class="$style.empty">正在加载 FIO 价格数据，请稍候…</div>
    <template v-else>
      <div :class="$style.summaryBar">
        <span :class="$style.summaryItem">
          配件 ·
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
          <span v-else :class="$style.summaryWarn">无交易所凑齐全部配件</span>
        </span>
        <span :class="[$style.summaryItem, $style.summaryProfit]">
          最优混合总价 ·
          <strong>{{ fixed0(totals.mixedTotal) }}</strong>
          <span :class="$style.summaryNote">（1:1 不含汇率）</span>
        </span>
      </div>

      <div :class="$style.tableWrap">
        <div
          :class="$style.table"
          :style="{
            gridTemplateColumns: `32px 56px 70px repeat(${exchanges.length}, 100px) 100px 130px`,
          }">
          <div :class="$style.head">
            <div :class="[$style.cell, $style.checkCol]">
              <input
                type="checkbox"
                :checked="allSelected"
                :indeterminate.prop="partialSelected"
                @change="toggleAll" />
            </div>
            <div :class="[$style.cell, $style.materialCell]">配件</div>
            <div :class="[$style.cell, $style.numCol]">需求</div>
            <div
              v-for="ex in exchanges"
              :key="ex.code"
              :class="[$style.cell, $style.priceCol]"
              :data-tooltip="`${ex.code} · ${ex.currency}`"
              data-tooltip-position="bottom">
              {{ ex.code }}
            </div>
            <div :class="[$style.cell, $style.bestPriceCol]">最优价</div>
            <div :class="[$style.cell, $style.sourceCol]">最优来源</div>
          </div>
          <div v-if="filtered.length === 0" :class="$style.empty">
            {{ components.length === 0 ? '该蓝图暂无物料清单。' : '没有匹配的配件。' }}
          </div>
          <div v-else :class="$style.body">
            <div v-for="c in filtered" :key="c.ticker" :class="$style.row">
              <div :class="[$style.cell, $style.checkCol]">
                <input
                  type="checkbox"
                  :checked="selectedTickers.has(c.ticker)"
                  @change="toggleTicker(c.ticker)" />
              </div>
              <div :class="[$style.cell, $style.materialCell]">
                <MaterialIcon :ticker="c.ticker" size="medium" />
              </div>
              <div :class="[$style.cell, $style.numCell]">{{ fixed0(c.amount) }}</div>
              <div
                v-for="ex in exchanges"
                :key="ex.code"
                :class="[$style.cell, $style.priceCell, isBest(c, ex.code) ? $style.best : '']">
                <PrunLink
                  v-if="priceOf(c, ex.code)"
                  inline
                  :command="`CXPO ${c.ticker}.${ex.code}`">
                  {{ fixed2(priceOf(c, ex.code)!.price) }}
                </PrunLink>
                <span v-else :class="$style.muted">--</span>
              </div>
              <div :class="[$style.cell, $style.numCell, $style.bestPrice]">
                <span v-if="c.bestPrice !== undefined">{{ fixed2(c.bestPrice) }}</span>
                <span v-else :class="$style.muted">--</span>
              </div>
              <div :class="[$style.cell, $style.sourceCell]">
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
              </div>
            </div>
          </div>
        </div>
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
  overflow-y: visible;
}

.table {
  display: grid;
  width: 100%;
  position: relative;
  z-index: 0;
}

.head,
.row {
  display: grid;
  grid-template-columns: subgrid;
  grid-column: 1 / -1;
  align-items: center;
  position: relative;
}

.row:hover {
  z-index: 1;
}

.body {
  display: contents;
}

.cell {
  padding: 4px 8px;
  text-align: left;
  vertical-align: middle;
  white-space: nowrap;
  min-width: 0;
}

.head .cell {
  color: rgb(200, 208, 214);
  font-weight: normal;
  border-bottom: 1px solid rgb(61, 74, 84);
}

.row .cell {
  border-bottom: 1px solid transparent;
}

.row:hover {
  background: rgb(40, 49, 56);
}

.materialCell {
  text-align: center;
}

.checkCol {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
}

.checkCol input {
  cursor: pointer;
}

.numCol,
.numCell,
.priceCol,
.priceCell,
.bestPriceCol,
.bestPrice {
  text-align: right;
}

.empty {
  grid-column: 1 / -1;
  padding: 16px;
  text-align: center;
  color: rgb(148, 158, 166);
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
  min-width: 110px;
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
