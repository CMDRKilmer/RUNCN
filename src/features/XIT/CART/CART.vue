<script setup lang="ts">
import ActionBar from '@src/components/ActionBar.vue';
import PrunButton from '@src/components/PrunButton.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import { sortMaterials } from '@src/core/sort-materials';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { userData } from '@src/store/user-data';
import { fixed02 } from '@src/utils/format';
import { uploadJson } from '@src/utils/json-file';
import GripCell from '@src/components/grip/GripCell.vue';
import GripHeaderCell from '@src/components/grip/GripHeaderCell.vue';
import { grip } from '@src/components/grip';
import { vDraggable } from 'vue-draggable-plus';
import {
  buildActionPackage,
  getExchangeOptions,
  getStationName,
  getWarehouseName,
  normalizeCartItems,
  normalizeCartName,
  parseCartImport,
} from './cart-utils';

const cart = computed(() => userData.cart);
const search = ref('');
const importText = ref('');
const selectedTickers = ref<string[]>([]);
const cartDropActive = ref(false);
const statusMessage = ref('');
const statusError = ref(false);

const exchangeOptions = computed(() => getExchangeOptions());

watch(
  exchangeOptions,
  options => {
    if (!cart.value.exchange && options.length > 0) {
      cart.value.exchange = options[0].value;
    }
  },
  { immediate: true },
);

watch(
  () => cart.value.items.map(item => item.ticker),
  tickers => {
    const allowed = new Set(tickers);
    selectedTickers.value = selectedTickers.value.filter(ticker => allowed.has(ticker));
  },
  { immediate: true },
);

const filteredMaterials = computed(() => {
  const query = search.value.trim().toLowerCase();
  const materials = sortMaterials(materialsStore.all.value ?? []);
  if (!query) {
    return materials;
  }

  return materials.filter(material => {
    const haystack = `${material.ticker} ${material.name}`.toLowerCase();
    return haystack.includes(query);
  });
});

const cartRows = computed(() =>
  cart.value.items.map(item => ({
    item,
    material: materialsStore.getByTicker(item.ticker),
  })),
);

const allSelected = computed(
  () =>
    cart.value.items.length > 0 &&
    cart.value.items.every(item => selectedTickers.value.includes(item.ticker)),
);

const hasSelection = computed(() => selectedTickers.value.length > 0);

const totalUnits = computed(() =>
  cart.value.items.reduce((sum, item) => sum + (Number.isFinite(item.amount) ? item.amount : 0), 0),
);

const totalWeight = computed(() =>
  cartRows.value.reduce((sum, row) => sum + (row.material?.weight ?? 0) * row.item.amount, 0),
);

const totalVolume = computed(() =>
  cartRows.value.reduce((sum, row) => sum + (row.material?.volume ?? 0) * row.item.amount, 0),
);

const stationName = computed(() => getStationName(cart.value.exchange) ?? '--');
const warehouseName = computed(() => getWarehouseName(cart.value.exchange));

function addMaterial(ticker: string, amount = 1) {
  const normalizedAmount = Math.max(1, Math.ceil(amount));
  const existing = cart.value.items.find(item => item.ticker === ticker);
  if (existing) {
    existing.amount += normalizedAmount;
  } else {
    cart.value.items.push({
      ticker,
      amount: normalizedAmount,
    });
  }

  setStatus(`已加入 ${ticker} x${normalizedAmount}。`);
}

function addFirstFilteredMaterial() {
  if (filteredMaterials.value.length === 0) {
    setStatus('没有匹配的物品。', true);
    return;
  }

  const first = filteredMaterials.value[0];
  addMaterial(first.ticker);
}

function onCatalogDragStart(event: DragEvent, ticker: string) {
  event.dataTransfer?.setData('text/plain', ticker);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copy';
  }
}

function onCartDrop(event: DragEvent) {
  event.preventDefault();
  cartDropActive.value = false;
  const ticker = event.dataTransfer?.getData('text/plain')?.trim().toUpperCase();
  if (!ticker) {
    return;
  }

  addMaterial(ticker);
}

function onCartDragLeave(event: DragEvent) {
  if (event.currentTarget === event.target) {
    cartDropActive.value = false;
  }
}

function normalizeAmount(item: UserData.CartItem) {
  const num = Number(item.amount);
  const isValidNumber = Number.isFinite(num) && num > 0;
  item.amount = Math.max(1, Math.ceil(isValidNumber ? num : 1));
}

function isSelected(ticker: string) {
  return selectedTickers.value.includes(ticker);
}

function setSelected(ticker: string, selected: boolean) {
  if (selected) {
    if (!selectedTickers.value.includes(ticker)) {
      selectedTickers.value.push(ticker);
    }
    return;
  }

  selectedTickers.value = selectedTickers.value.filter(value => value !== ticker);
}

function replaceCartItems(items: UserData.CartItem[]) {
  cart.value.items.splice(0, cart.value.items.length, ...items);
}

function toggleSelectAll(selected: boolean) {
  selectedTickers.value = selected ? cart.value.items.map(item => item.ticker) : [];
}

function onSelectAllChange(event: Event) {
  toggleSelectAll((event.target as HTMLInputElement).checked);
}

function onSelectChange(event: Event, ticker: string) {
  setSelected(ticker, (event.target as HTMLInputElement).checked);
}

function removeItem(ticker: string) {
  const index = cart.value.items.findIndex(item => item.ticker === ticker);
  if (index < 0) {
    return;
  }

  cart.value.items.splice(index, 1);
  setSelected(ticker, false);
  setStatus(`已删除 ${ticker}。`);
}

function removeSelectedItems() {
  if (!hasSelection.value) {
    return;
  }

  const selected = new Set(selectedTickers.value);
  replaceCartItems(cart.value.items.filter(item => !selected.has(item.ticker)));
  selectedTickers.value = [];
  setStatus('已删除选中的物品。');
}

function clearCart() {
  if (cart.value.items.length === 0) {
    return;
  }

  replaceCartItems([]);
  selectedTickers.value = [];
  setStatus('购物车已清空。');
}

function importFromText() {
  if (!importText.value.trim()) {
    setStatus('请先粘贴 JSON。', true);
    return;
  }

  try {
    applyImportedCart(JSON.parse(importText.value));
  } catch {
    setStatus('JSON 解析失败。', true);
  }
}

function uploadImportJson() {
  uploadJson(json => applyImportedCart(json));
}

function applyImportedCart(json: unknown) {
  try {
    const imported = parseCartImport(json);
    cart.value.name = normalizeCartName(imported.name ?? cart.value.name);
    if (imported.exchange) {
      cart.value.exchange = imported.exchange;
    }
    replaceCartItems(imported.items);
    selectedTickers.value = [];
    importText.value = '';
    setStatus(`已识别 ${imported.items.length} 种物品。`);
  } catch (error) {
    const message = error instanceof Error ? error.message : '无法识别购物车 JSON。';
    setStatus(message, true);
  }
}

function generateAct() {
  cart.value.name = normalizeCartName(cart.value.name);
  replaceCartItems(normalizeCartItems(cart.value.items));

  const pkg = buildActionPackage(cart.value);
  if (!pkg) {
    setStatus('请先选择空间站，并确保购物车里至少有一个有效物品。', true);
    return;
  }

  const existing = userData.actionPackages.find(entry => entry.global.name === pkg.global.name);
  if (existing) {
    const index = userData.actionPackages.indexOf(existing);
    userData.actionPackages[index] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }

  const commandName = pkg.global.name.trim().replace(/\s+/g, '_');
  showBuffer(`XIT ACT_${commandName}`);
  setStatus(`已生成 ACT 包 ${pkg.global.name}。`);
}

function setStatus(message: string, isError = false) {
  statusMessage.value = message;
  statusError.value = isError;
}
</script>

<template>
  <div :class="$style.page">
    <ActionBar>
      <PrunButton primary @click="generateAct">生成 ACT</PrunButton>
      <PrunButton primary @click="importFromText">识别 JSON</PrunButton>
      <PrunButton primary @click="uploadImportJson">上传 JSON</PrunButton>
      <PrunButton dark :disabled="!hasSelection" @click="removeSelectedItems">删除选中</PrunButton>
      <PrunButton dark :disabled="cart.items.length === 0" @click="clearCart">清空全部</PrunButton>
    </ActionBar>

    <div :class="[C.DraftConditionEditor.form, $style.formCard]">
      <SectionHeader>购物车</SectionHeader>
      <form>
        <Active label="名称">
          <TextInput v-model="cart.name" />
        </Active>
        <Active label="空间站">
          <SelectInput v-model="cart.exchange" :options="exchangeOptions" />
        </Active>
        <Active label="站点">
          <span :class="$style.secondaryText">{{ stationName }}</span>
        </Active>
        <Active label="仓库">
          <span :class="$style.secondaryText">{{ warehouseName }}</span>
        </Active>
        <Active label="汇总">
          <span :class="$style.secondaryText">
            {{ cart.items.length }} 种 / {{ totalUnits.toLocaleString() }} 件 /
            {{ fixed02(totalWeight) }} t / {{ fixed02(totalVolume) }} m³
          </span>
        </Active>
        <Active label="识别 XIT JSON">
          <textarea
            v-model="importText"
            :class="[$style.surfaceInput, $style.jsonInput]"
            spellcheck="false"
            placeholder='粘贴 XIT ACT JSON 或 { "COF": 100 } 这样的物品清单' />
        </Active>
        <Active v-if="statusMessage" label="状态">
          <span :class="[statusError ? $style.statusError : $style.statusOk]">{{
            statusMessage
          }}</span>
        </Active>
      </form>
    </div>

    <div :class="$style.layout">
      <section :class="$style.section">
        <SectionHeader>物品目录</SectionHeader>
        <div :class="$style.panel">
          <input
            v-model="search"
            :class="[$style.surfaceInput, $style.searchInput]"
            type="text"
            placeholder="搜索 ticker 或名称"
            @keydown.enter.prevent="addFirstFilteredMaterial" />

          <div :class="$style.materialList">
            <div
              v-for="material in filteredMaterials"
              :key="material.ticker"
              :class="$style.materialRow"
              draggable="true"
              @dragstart="onCatalogDragStart($event, material.ticker)">
              <div :class="$style.materialMeta">
                <strong :class="$style.materialTicker">{{ material.ticker }}</strong>
                <span :class="$style.materialName">{{ material.name }}</span>
              </div>
              <PrunButton primary inline @click="addMaterial(material.ticker)">添加</PrunButton>
            </div>
            <div v-if="filteredMaterials.length === 0" :class="$style.emptyState"
              >没有匹配的物品。</div
            >
          </div>
        </div>
      </section>

      <section :class="$style.section">
        <SectionHeader>购物车明细</SectionHeader>
        <div
          :class="[$style.panel, $style.dropzone, cartDropActive ? $style.dropActive : '']"
          @dragover.prevent="cartDropActive = true"
          @dragleave="onCartDragLeave"
          @drop="onCartDrop">
          <table :class="$style.cartTable">
            <thead>
              <tr>
                <GripHeaderCell />
                <th :class="$style.checkboxColumn">
                  <input
                    :checked="allSelected"
                    :class="$style.checkbox"
                    type="checkbox"
                    @change="onSelectAllChange" />
                </th>
                <th>物品</th>
                <th :class="$style.amountColumn">数量</th>
                <th :class="$style.metricColumn">重量</th>
                <th :class="$style.metricColumn">体积</th>
                <th :class="$style.actionColumn" />
              </tr>
            </thead>
            <tbody v-if="cart.items.length === 0">
              <tr>
                <td colspan="7" :class="$style.emptyState">
                  把左侧物品拖到这里，或点击“添加”放入购物车。
                </td>
              </tr>
            </tbody>
            <tbody v-else v-draggable="[cart.items, grip.draggable]">
              <tr v-for="row in cartRows" :key="row.item.ticker">
                <GripCell />
                <td :class="$style.checkboxColumn">
                  <input
                    :checked="isSelected(row.item.ticker)"
                    :class="$style.checkbox"
                    type="checkbox"
                    @change="onSelectChange($event, row.item.ticker)" />
                </td>
                <td :class="$style.materialCell">
                  <strong>{{ row.item.ticker }}</strong>
                  <span>{{ row.material?.name ?? '未知物品' }}</span>
                </td>
                <td :class="$style.amountColumn">
                  <input
                    v-model.number="row.item.amount"
                    :class="[$style.surfaceInput, $style.amountInput]"
                    min="1"
                    step="1"
                    type="number"
                    @change="normalizeAmount(row.item)" />
                </td>
                <td :class="$style.metricCell">
                  {{ row.material ? `${fixed02(row.material.weight * row.item.amount)} t` : '--' }}
                </td>
                <td :class="$style.metricCell">
                  {{ row.material ? `${fixed02(row.material.volume * row.item.amount)} m³` : '--' }}
                </td>
                <td :class="$style.actionColumn">
                  <PrunButton danger inline @click="removeItem(row.item.ticker)">删除</PrunButton>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

<style module>
.page {
  overflow-x: hidden;
}

.formCard {
  overflow: hidden;
}

.layout {
  display: grid;
  grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
  gap: 8px;
  align-items: start;
  min-width: 0;
}

.section {
  min-width: 0;
}

.panel {
  min-width: 0;
  overflow: hidden;
}

.secondaryText {
  display: inline-block;
  max-width: 100%;
  overflow-wrap: anywhere;
  color: rgb(200, 208, 214);
}

.surfaceInput {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid rgb(61, 74, 84);
  background: rgb(26, 33, 38);
  color: rgb(226, 230, 233);
  font: inherit;
  outline: none;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease,
    background 0.15s ease;
}

.surfaceInput:focus {
  border-color: rgb(255, 176, 0);
  box-shadow: inset 0 0 0 1px rgb(255, 176, 0);
  background: rgb(30, 38, 44);
}

.surfaceInput::placeholder {
  color: rgb(148, 158, 166);
}

.jsonInput {
  min-height: 104px;
  padding: 6px 8px;
  resize: vertical;
}

.searchInput {
  margin-bottom: 8px;
  padding: 4px 6px;
}

.materialList {
  max-height: 360px;
  overflow: auto;
}

.materialRow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px;
  cursor: grab;
}

.materialRow:hover {
  background: rgb(40, 49, 56);
}

.materialMeta {
  min-width: 0;
}

.materialTicker {
  display: block;
  color: rgb(255, 176, 0);
}

.materialName {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(167, 176, 183);
}

.dropzone {
  transition:
    box-shadow 0.15s ease,
    background 0.15s ease;
}

.dropActive {
  box-shadow: inset 0 0 0 1px rgb(255, 176, 0);
  background: rgb(36, 44, 50);
}

.cartTable {
  width: 100%;
  table-layout: fixed;
}

.checkboxColumn {
  width: 28px;
  text-align: center;
}

.checkbox {
  accent-color: rgb(255, 176, 0);
}

.amountColumn {
  width: 78px;
}

.metricColumn {
  width: 62px;
}

.actionColumn {
  width: 60px;
  text-align: right;
}

.materialCell {
  overflow: hidden;
}

.materialCell strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.materialCell span {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgb(167, 176, 183);
}

.amountInput {
  padding: 4px 6px;
  text-align: right;
}

.metricCell {
  color: rgb(200, 208, 214);
  font-size: 11px;
  white-space: nowrap;
}

.emptyState {
  padding: 12px 8px;
  text-align: center;
  color: rgb(167, 176, 183);
}

.statusOk {
  color: rgb(129, 199, 132);
}

.statusError {
  color: rgb(229, 115, 115);
}

@media (max-width: 960px) {
  .layout {
    grid-template-columns: 1fr;
  }

  .materialList {
    max-height: 220px;
  }
}
</style>
