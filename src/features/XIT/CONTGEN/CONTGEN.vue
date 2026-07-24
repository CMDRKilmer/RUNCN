<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import Active from '@src/components/forms/Active.vue';
import Commands from '@src/components/forms/Commands.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import PrunButton from '@src/components/PrunButton.vue';
import MaterialPicker from '@src/features/XIT/CONTGEN/MaterialPicker.vue';
import AddressPicker from '@src/features/XIT/CONTGEN/AddressPicker.vue';
import { useTileState } from '@src/store/user-data-tiles';
import { newContractDraftAndFill } from '@src/features/XIT/CONTGEN/new-and-fill';
import { useClipboard } from '@src/hooks/use-clipboard';

type Template = 'BUY' | 'SELL' | 'SHIP';

interface Item {
  // Internal picker field — kept as `ticker` for clarity. On emit we
  // rename to `commodity` (the field the auto-fill consumer expects).
  ticker: string;
  amount: number;
  price?: number;
}

interface OutputItem {
  commodity: string;
  amount: number;
  price?: number;
}

interface ContractJson {
  template: Template;
  currency: string;
  name?: string;
  location?: string;
  origin?: string;
  destination?: string;
  price?: number;
  deadline?: number;
  items: OutputItem[];
}

const template = useTileState<Template>('template', 'BUY');
const currency = useTileState<string>('currency', 'ICA');
const contractName = useTileState<string>('contractName', '');
const location = useTileState<string>('location', '');
const origin = useTileState<string>('origin', '');
const destination = useTileState<string>('destination', '');
const price = useTileState<number | undefined>('price', undefined);
const deadline = useTileState<number | undefined>('deadline', undefined);
// Items list is local-only — we deliberately do NOT persist it via
// `useTileState`. The tile-state helper returns a fresh default
// array on every read, which silently drops mutations like
// `items.value.push(...)`. The form is small enough that resetting
// on remount is fine.
const items = ref<Item[]>([{ ticker: '', amount: 0, price: 0 }]);

const currencies = ['ICA', 'NCC', 'AIC', 'CIS'];
const templates: Template[] = ['BUY', 'SELL', 'SHIP'];

const isShip = computed(() => template.value === 'SHIP');
const isBuyOrSell = computed(() => template.value === 'BUY' || template.value === 'SELL');

// Watch template changes and reset fields that don't apply.
watch(template, (next, prev) => {
  if (next === 'SHIP' && prev !== 'SHIP') {
    // Leave per-row price optional for SHIP; user fills `price` instead.
    return;
  }
  if ((next === 'BUY' || next === 'SELL') && prev === 'SHIP') {
    price.value = undefined;
  }
});

function addItem() {
  items.value.push({ ticker: '', amount: 0, price: 0 });
}

function removeItem(index: number) {
  if (items.value.length <= 1) {
    // Always keep at least one row.
    items.value = [{ ticker: '', amount: 0, price: 0 }];
    return;
  }
  items.value.splice(index, 1);
}

// Build the contract JSON, dropping empty rows and unset optional fields
// Build the contract JSON, dropping empty rows and unset optional fields
// so the user sees a clean, ready-to-paste output.
const output = computed<ContractJson>(() => {
  // The CONTD auto-fill consumer expects `items[i].commodity` (the
  // material name/ticker), not `ticker`. We keep the picker using
  // `ticker` internally for clarity but rename on emit so the JSON
  // is ready to paste.
  const cleanedItems = items.value
    .filter(it => it.ticker.trim().length > 0 && it.amount > 0)
    .map(it => {
      const row: { commodity: string; amount: number; price?: number } = {
        commodity: it.ticker.trim().toUpperCase(),
        amount: it.amount,
      };
      // Per-row price only included when the user actually set it.
      // For BUY/SELL with no per-row price set, validateConfig in
      // contd-auto-fill will fall back to the top-level `price`.
      if (isBuyOrSell.value && it.price !== undefined && it.price > 0) {
        row.price = it.price;
      }
      return row;
    });

  const result: ContractJson = {
    template: template.value,
    currency: currency.value,
    items: cleanedItems,
  };
  if (contractName.value.trim().length > 0) {
    result.name = contractName.value.trim();
  }
  if (isBuyOrSell.value && location.value.trim().length > 0) {
    result.location = location.value.trim().toUpperCase();
  }
  if (isShip.value) {
    if (origin.value.trim().length > 0) {
      result.origin = origin.value.trim().toUpperCase();
    }
    if (destination.value.trim().length > 0) {
      result.destination = destination.value.trim().toUpperCase();
    }
  }
  // Top-level `price` is shared: SHIP (single global price for all
  // rows) and BUY/SELL when every item should use the same price.
  // For BUY/SELL with mixed prices, leave per-row `price` only.
  const allRowsHaveExplicitPrice =
    cleanedItems.length > 0 && cleanedItems.every(it => typeof it.price === 'number');
  if (
    price.value !== undefined &&
    price.value !== null &&
    price.value !== '' &&
    price.value >= 0 &&
    (isShip.value || !allRowsHaveExplicitPrice)
  ) {
    result.price = Number(price.value);
  }
  if (
    deadline.value !== undefined &&
    deadline.value !== null &&
    deadline.value !== '' &&
    deadline.value > 0
  ) {
    result.deadline = Number(deadline.value);
  }
  return result;
});

const outputJson = computed(() => JSON.stringify(output.value, null, 2));

// Light validation that mirrors validateConfig in the auto-fill feature
// so the user sees errors here instead of inside CONTD.
const validationErrors = computed<string[]>(() => {
  const errs: string[] = [];
  if (!currencies.includes(currency.value)) {
    errs.push(`未知的币种 "${currency.value}"`);
  }
  if (output.value.items.length === 0) {
    errs.push('至少需要 1 个物品');
  }
  if (isBuyOrSell.value) {
    // For BUY/SELL, each row needs an explicit per-row price OR a
    // shared top-level `price`. validateConfig in contd-auto-fill
    // mirrors this rule.
    const anyRowMissingPrice = output.value.items.some(it => it.price === undefined);
    if (anyRowMissingPrice && output.value.price === undefined) {
      errs.push('BUY/SELL 每行物品必须填写单价，或在顶部填写统一单价');
    }
    if (!output.value.location) {
      errs.push('BUY/SELL 必须填写目的地');
    }
  } else {
    if (!output.value.origin) {
      errs.push('SHIP 必须填写出发地');
    }
    if (!output.value.destination) {
      errs.push('SHIP 必须填写目的地');
    }
    if (output.value.price === undefined) {
      errs.push('SHIP 必须填写运费');
    }
    if (
      output.value.origin &&
      output.value.destination &&
      output.value.origin === output.value.destination
    ) {
      errs.push('SHIP 出发地和目的地不能相同');
    }
  }
  return errs;
});

const canSubmit = computed(() => validationErrors.value.length === 0);

// Tracks the in-flight "新建并填充" run so the button can show a
// spinner-style disabled state and surface errors. The string is
// the user-facing status; `null` means idle.
const newDraftStatus = ref<string | null>(null);
const newDraftError = ref<string | null>(null);
const isNewing = computed(() => newDraftStatus.value !== null);

// Maps helper milestones to the user-facing status string. Picked
// at await points so the button text updates as work progresses.
const NEW_DRAFT_STATUS_LABELS = {
  starting: '打开 CONTD…',
  filled: '完成',
} as const;

async function handleNewDraftAndFill() {
  if (!canSubmit.value || isNewing.value) {
    return;
  }
  newDraftError.value = null;
  newDraftStatus.value = NEW_DRAFT_STATUS_LABELS.starting;
  try {
    await newContractDraftAndFill(outputJson.value);
    newDraftStatus.value = NEW_DRAFT_STATUS_LABELS.filled;
    // Clear the status after a short delay so the user can see
    // "完成" before the button returns to its default label.
    setTimeout(() => {
      if (newDraftStatus.value === NEW_DRAFT_STATUS_LABELS.filled) {
        newDraftStatus.value = null;
      }
    }, 1500);
  } catch (e) {
    newDraftError.value = e instanceof Error ? e.message : String(e);
    newDraftStatus.value = null;
  }
}

const { copy } = useClipboard();
async function copyJson() {
  await copy(outputJson.value);
}
</script>

<template>
  <div :class="$style.root">
    <div :class="$style.form">
      <Active label="合同类型">
        <SelectInput v-model="template" :options="templates" />
      </Active>
      <Active label="币种">
        <SelectInput v-model="currency" :options="currencies" />
      </Active>
      <Active label="合同名称" tooltip="可选。生成后会自动写入 CONTD 合同的标题。">
        <input
          v-model="contractName"
          type="text"
          :class="$style.input"
          placeholder="例如: Hortus → Animus 运输" />
      </Active>

      <Active v-if="isBuyOrSell" label="目的地" tooltip="行星 naturalId，例如 ZV-307a 或别名 HRT。">
        <AddressPicker v-model="location" />
      </Active>

      <template v-if="isShip">
        <Active label="出发地" tooltip="行星 naturalId，例如 VH-331a。">
          <AddressPicker v-model="origin" />
        </Active>
        <Active label="目的地" tooltip="行星 naturalId，不能与出发地相同。">
          <AddressPicker v-model="destination" />
        </Active>
        <Active label="运费" tooltip="所有物品共享同一运费。">
          <input
            v-model.number="price"
            type="number"
            min="0"
            step="0.01"
            :class="$style.input"
            placeholder="0.00" />
        </Active>
      </template>

      <Active label="限期（天）" tooltip="可选。不填则使用模板默认值（约 3 天）。">
        <input
          v-model.number="deadline"
          type="number"
          min="1"
          step="1"
          :class="$style.input"
          placeholder="3" />
      </Active>

      <Active label="物品清单" tooltip="每行一个物品；BUY/SELL 需填单价，SHIP 共享运费。">
        <div :class="$style.items">
          <div :class="$style.itemHeader">
            <div :class="$style.itemHeaderCellTicker">物品 (Ticker)</div>
            <div :class="$style.itemHeaderCellAmount">数量</div>
            <div v-if="isBuyOrSell" :class="$style.itemHeaderCellPrice">单价</div>
            <div :class="$style.itemHeaderCellRemove"></div>
          </div>
          <div v-for="(item, idx) in items" :key="idx" :class="$style.itemRow">
            <MaterialPicker v-model="item.ticker" />
            <input
              v-model.number="item.amount"
              type="number"
              min="1"
              step="1"
              :class="[$style.input, $style.itemAmount]"
              placeholder="数量"
              :aria-label="`第 ${idx + 1} 行数量`" />
            <input
              v-if="isBuyOrSell"
              v-model.number="item.price"
              type="number"
              min="0"
              step="0.01"
              :class="[$style.input, $style.itemPrice]"
              placeholder="单价"
              :aria-label="`第 ${idx + 1} 行单价`" />
            <button
              type="button"
              :class="$style.removeBtn"
              :disabled="items.length <= 1"
              :aria-label="`删除第 ${idx + 1} 行`"
              @click="removeItem(idx)">
              ×
            </button>
          </div>
          <button type="button" :class="$style.addBtn" @click="addItem">+ 添加一行</button>
        </div>
      </Active>

      <Commands label="操作">
        <PrunButton :disabled="!canSubmit || isNewing" primary @click="handleNewDraftAndFill">
          {{ isNewing ? newDraftStatus : '新建合同并填充' }}
        </PrunButton>
        <PrunButton :disabled="!canSubmit || isNewing" primary @click="copyJson"
          >复制 JSON</PrunButton
        >
      </Commands>

      <div v-if="newDraftError" :class="$style.errors">
        <div>⚠ {{ newDraftError }}</div>
      </div>
      <div v-else-if="!canSubmit" :class="$style.errors">
        <div v-for="err in validationErrors" :key="err">⚠ {{ err }}</div>
      </div>
    </div>

    <div :class="$style.preview">
      <div :class="$style.previewLabel">JSON 预览</div>
      <pre :class="$style.previewContent">{{ outputJson }}</pre>
    </div>
  </div>
</template>

<style module>
.root {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.form {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 8px;
  border-bottom: 1px solid #444;
}

.preview {
  flex: 0 0 200px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 6px 8px;
  background: rgba(0, 0, 0, 0.2);
}

.previewLabel {
  font-size: 11px;
  color: #999;
  margin-bottom: 4px;
}

.previewContent {
  flex: 1;
  margin: 0;
  padding: 8px;
  font-family: monospace;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.3);
  border-radius: 2px;
  border: 1px solid #555;
}

.input {
  width: 100%;
  max-width: 280px;
  box-sizing: border-box;
  background: transparent;
  color: inherit;
  border: 1px solid transparent;
  padding: 2px 4px;
  font-family: inherit;
  font-size: inherit;
}

.input:focus {
  outline: none;
  border-color: #66afe9;
}

.items {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}

.itemHeader {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 0 2px 4px;
  font-size: 10px;
  color: #888;
}

.itemHeaderCellTicker {
  flex: 0 0 80px;
}

.itemHeaderCellAmount {
  flex: 0 0 90px;
}

.itemHeaderCellPrice {
  flex: 0 0 110px;
}

.itemHeaderCellRemove {
  flex: 0 0 22px;
}

.itemRow {
  display: flex;
  gap: 4px;
  align-items: center;
  width: 100%;
}

.itemAmount {
  flex: 0 0 90px;
}

.itemPrice {
  flex: 0 0 110px;
}

.addBtn,
.removeBtn {
  background: transparent;
  border: 1px solid #555;
  color: inherit;
  padding: 2px 8px;
  cursor: pointer;
  font-size: 11px;
}

.removeBtn {
  flex: 0 0 22px;
  padding: 2px 0;
  text-align: center;
}

.addBtn:hover,
.removeBtn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
}

.removeBtn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.addBtn {
  margin-top: 4px;
  align-self: flex-start;
}

.errors {
  margin-top: 8px;
  padding: 6px 8px;
  background: rgba(217, 83, 79, 0.15);
  border: 1px solid rgba(217, 83, 79, 0.5);
  border-radius: 2px;
  font-size: 11px;
  color: #d9534f;
}
</style>
