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
import { loadFioBuildings, fioBuildingsStore } from '@src/features/XIT/PLAN/fio-buildings';
import {
  collectPlanMaterials,
  fetchPlanetEnv,
  buildingCount,
  type PlanetEnv,
} from '@src/features/XIT/PLAN/plan-materials';
import type { PlannedBuilding } from '@src/features/XIT/PLAN/tile-state';
import { computeComponents, computeTotals, type BpcExchange } from '../BPC/bp-utils';

// 建材需求依赖 FIO 建筑数据（一次会话只请求一次）。
loadFioBuildings();

// JH 已保存计划列表，按保存时间倒序（最近保存靠前）。
const plans = computed(() =>
  (userData.basePlans ?? []).slice().sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0)),
);
const planOptions = computed(() =>
  plans.value.map(p => ({
    label: p.planet ? `${p.name} (${p.planet})` : p.name,
    value: p.id,
  })),
);

const selectedPlanId = ref('');
// 从 JH「购买表」按钮跳转时带过来的计划 id（tile-state key 即时传递）。
const pendingPlanId = (() => {
  const ws = getTileState<{ planId?: string }>('bmat-plan-id');
  const id = ws.planId;
  if (id) {
    delete ws.planId;
  }
  return id ?? '';
})();

const selectedTickers = ref<Set<string>>(new Set());
watch(
  plans,
  list => {
    if (list.length === 0) {
      return;
    }
    if (!list.some(p => p.id === selectedPlanId.value)) {
      selectedPlanId.value = list.some(p => p.id === pendingPlanId) ? pendingPlanId : list[0].id;
    }
  },
  { immediate: true },
);

const selectedPlan = computed(() => plans.value.find(p => p.id === selectedPlanId.value));

// 星球环境参数异步拉取（与 JH「购材」对话框同源）。切换计划时丢弃过期结果。
const planetEnv = ref<PlanetEnv | undefined>(undefined);
let envRequestPlan = '';
watch(
  selectedPlan,
  plan => {
    selectedTickers.value = new Set();
    planetEnv.value = undefined;
    const planet = plan?.planet ?? '';
    envRequestPlan = planet;
    if (!planet) {
      return;
    }
    void fetchPlanetEnv(planet).then(env => {
      if (envRequestPlan === planet) {
        planetEnv.value = env;
      }
    });
  },
  { immediate: true },
);

// 建材需求：基础 BuildingCosts + 星球环境建材。
const needs = computed(() => {
  const plan = selectedPlan.value;
  if (!plan) {
    return [];
  }
  const materials = collectPlanMaterials(plan, planetEnv.value);
  return Array.from(materials.entries(), ([ticker, amount]) => ({
    ticker,
    name: ticker,
    amount,
  }));
});

// 计划内建筑总数（用于信息展示）。
const totalBuildingCount = computed(() => {
  const plan = selectedPlan.value;
  if (!plan) {
    return 0;
  }
  const buildings = (plan.buildings ?? []) as PlannedBuilding[];
  return buildings.reduce((sum, pb) => sum + buildingCount(pb), 0);
});

// 硬编码 4 个玩家 CX 交易所（与 BPC/ARB 一致），避免运行时依赖 exchangesStore。
const exchanges: BpcExchange[] = [
  { code: 'AI1', currency: 'AIC' },
  { code: 'CI1', currency: 'CIS' },
  { code: 'IC1', currency: 'ICA' },
  { code: 'NC1', currency: 'NCC' },
];

const components = computed(() => computeComponents(needs.value, exchanges));
const totals = computed(() => computeTotals(components.value, exchanges, selectedTickers.value));

const noPlans = computed(() => plans.value.length === 0);
const noFioBuildings = computed(() => !fioBuildingsStore.buildings);
const fioError = computed(() => fioBuildingsStore.error);
const noData = computed(() => !cxStore.fetched);

function openJH() {
  showBuffer('XIT JH');
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

// 已选建材（按 ticker 去重），按全市场最优交易所分组。
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

// 与 BPC 一致的 ASCII 净化：XIT 参数仅吃 ASCII。
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
    const groupName = `BMAT_${exchangeCode}`;
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
  const plan = selectedPlan.value;
  const asciiName = asciiSafe(plan?.name ?? '');
  const asciiPlanet = asciiSafe(plan?.planet ?? '');
  // 用星球 + 计划名做可读包名（如 "Mars Alpha Plan Buy"），避免与
  // GenerateConstructionActDialog 的 GOUCAI_<planet> 冲突。
  const name = [asciiPlanet, asciiName, 'Buy'].filter(Boolean).join(' ') || 'BMAT Buy';
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

// 把当前已选建材（未选则全部）以顶层 materials 形态发给 CONTGEN 起草合同。
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
  const asciiName = asciiSafe(selectedPlan.value?.name ?? '');
  if (asciiName.length > 0) {
    payload.name = asciiName;
  }
  const ws = getTileState<{ json?: string }>('contgen-import');
  ws.json = JSON.stringify(payload);
  showBuffer('XIT CONTGEN');
}

const canSendToContgen = computed(() => components.value.length > 0);

// 与 BPC/ARB 一致：对当前所有 (ticker, 交易所) 打开 CXOB 缓冲窗拉取实时订单簿。
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
      <label :class="$style.control">
        <span :class="$style.controlLabel">基地计划</span>
        <select
          id="bmat-plan"
          v-model="selectedPlanId"
          name="bmat-plan"
          :class="$style.select"
          style="width: 280px">
          <option v-for="opt in planOptions" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>
      </label>
      <span
        v-if="selectedPlan"
        :class="$style.planMeta"
        data-tooltip="该计划包含的建筑总数（用于估算建材需求）"
        data-tooltip-position="top"
        >{{ totalBuildingCount }} 座建筑</span
      >
      <input
        id="bmat-search"
        v-model="search"
        name="bmat-search"
        :class="$style.input"
        type="text"
        placeholder="搜索建材 ticker 或名称" />
      <PrunButton primary :disabled="needs.length === 0" @click="refreshPrices"
        >更新价格</PrunButton
      >
      <label :class="$style.control">
        <input
          id="bmat-single-market"
          v-model="singleMarketMode"
          name="bmat-single-market"
          type="checkbox"
          :disabled="!cheapestSingleExchange" />
        <span :class="$style.controlLabel">单市场购买</span>
      </label>
      <label :class="$style.control">
        <input
          id="bmat-transfer-ship"
          v-model="transferToShip"
          name="bmat-transfer-ship"
          type="checkbox" />
        <span :class="$style.controlLabel">转移到飞船</span>
      </label>
      <PrunButton primary :disabled="!canGenerateActOptions" @click="generateAct"
        >生成 ACT</PrunButton
      >
      <PrunButton
        primary
        :disabled="!canSendToContgen"
        data-tooltip="把当前已选建材清单发送到 CONTGEN 用于起草合同"
        data-tooltip-position="top"
        @click="sendToContgen"
        >导入到 CONTGEN</PrunButton
      >
    </div>

    <div v-if="noPlans" :class="$style.empty">
      还没有保存的基地计划。请先到
      <PrunButton dark inline @click="openJH">XIT JH</PrunButton>
      新建或保存一份基地规划。
    </div>
    <div v-else-if="fioBuildingsStore.loading" :class="$style.empty">正在载入建筑数据，请稍候…</div>
    <div v-else-if="fioError" :class="$style.empty">建筑数据加载失败，无法连接 FIO。</div>
    <div v-else-if="noFioBuildings" :class="$style.empty">尚无建筑数据可计算建材需求。</div>
    <div v-else-if="needs.length === 0" :class="$style.empty">
      该计划中没有可识别的建筑，或建材需求为空。
    </div>
    <div v-else-if="noData" :class="$style.empty">正在加载 FIO 价格数据，请稍候…</div>
    <template v-else>
      <div :class="$style.summaryBar">
        <span :class="$style.summaryItem">
          建材 ·
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
          <span v-else :class="$style.summaryWarn">无交易所凑齐全部建材</span>
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
              <th :class="$style.materialCol">建材</th>
              <th :class="$style.numCol">需求</th>
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
                {{ components.length === 0 ? '该计划暂无可比价的建材。' : '没有匹配的建材。' }}
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

.planMeta {
  color: rgb(148, 158, 166);
  font-size: 11px;
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
