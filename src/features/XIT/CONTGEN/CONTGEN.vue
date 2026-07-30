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
import { uploadJson } from '@src/utils/json-file';
import { parseActJson } from '@src/features/XIT/CONTGEN/act-import';
import { fixed02 } from '@src/utils/format';
import { getTileState } from '@src/store/user-data-tiles';

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
// BUY/SELL 模板时使用的"总价"输入。仅作拆分触发器，不进入 ContractJson
// 输出——具体单价仍走 per-row `item.price`，与 SHIP 的顶层 price 语义隔离。
const totalPrice = useTileState<number | undefined>('totalPrice', undefined);
// Items list is local-only — we deliberately do NOT persist it via
// `useTileState`. The tile-state helper returns a fresh default
// array on every read, which silently drops mutations like
// `items.value.push(...)`. The form is small enough that resetting
// on remount is fine.
const items = ref<Item[]>([{ ticker: '', amount: 0, price: 0 }]);

// JSON 导入的临时 UI 状态——不持久化，刷新即丢；这与 uploadJson 的
// "一次性消费"语义对齐。
const importText = ref('');
type ImportStatus = { kind: 'ok' | 'warn' | 'err'; message: string };
const importStatus = ref<ImportStatus | null>(null);

// 其他面板（BPC / CART 等）可通过 'contgen-import' workspace key 把
// JSON 直接喂给当前 tile。挂载时消费一次并立即清空，避免下次刷新
// 再次触发。设计风格与 CART 模块的 "识别 XIT JSON" 一致（消费者
// 拿到即清空），但走显式 key 避免与 cart-utils 的 parseCartImport
// 工作区混淆。
onMounted(() => {
  const pending = getTileState<{ json?: string }>('contgen-import');
  if (typeof pending.json === 'string' && pending.json.length > 0) {
    applyImportedRaw(pending.json);
    delete pending.json;
  }
});

// 预览窗口里的"合同 / 导入"标签页。默认合同 JSON 预览；点切换按钮或
// 「识别/上传」时不自动切（避免误抢用户当前在看的内容）。
type PreviewMode = 'output' | 'import';
const previewMode = ref<PreviewMode>('output');

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
    price.value >= 0 &&
    (isShip.value || !allRowsHaveExplicitPrice)
  ) {
    result.price = Number(price.value);
  }
  if (deadline.value !== undefined && deadline.value > 0) {
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

// ---- JSON 导入 ----

// 其他面板（workspace key）喂过来的字符串路径。先 JSON.parse 再复用统一
// applyImported，所以与「粘贴 / 上传」两条入口走完全相同的解析 / 错误反馈。
function applyImportedRaw(rawJson: string) {
  try {
    applyImported(JSON.parse(rawJson));
  } catch (e) {
    importStatus.value = {
      kind: 'err',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

// 粘贴 / 上传两条入口共用一条 apply 路径：把任意 JSON 形态解析成 ImportedRow[]
// 然后覆盖 items。这里故意不去推断 template/currency/location —— 那些由
// 用户在表单里继续维护，避免脚本写错时静默改了模板。
function applyImported(rawJson: unknown) {
  try {
    const result = parseActJson(rawJson);
    items.value = result.rows.map(row => ({
      ticker: row.ticker,
      amount: row.amount,
      price: row.price ?? 0,
    }));
    importText.value = '';
    // 来源携带 name 时回填合同名称（BPC 导入蓝图名即用此字段）。
    // 已有手动填写的 contractName 不覆盖，保留玩家工作。
    if (result.name !== undefined) {
      contractName.value = result.name;
    }
    previewMode.value = 'output';
    const priceNote =
      result.stats.withPrice < result.stats.unique
        ? `，${result.stats.unique - result.stats.withPrice} 行缺单价`
        : '';
    importStatus.value = {
      kind: result.stats.withPrice < result.stats.unique ? 'warn' : 'ok',
      message: `已导入 ${result.stats.unique} 种 / ${result.stats.totalUnits} 件（来源：${result.source}）${priceNote}`,
    };
  } catch (e) {
    importStatus.value = {
      kind: 'err',
      message: e instanceof Error ? e.message : String(e),
    };
  }
}

function onImportClick() {
  const text = importText.value.trim();
  if (!text) {
    importStatus.value = { kind: 'err', message: '请先粘贴 JSON。' };
    return;
  }
  try {
    applyImported(JSON.parse(text));
  } catch {
    importStatus.value = { kind: 'err', message: 'JSON 解析失败。' };
  }
}

function onUploadClick() {
  uploadJson(json => applyImported(json));
}

// 用户清空粘贴框时同步清掉旧状态——否则红字会黏在屏幕上误
// 导已完成。
watch(
  () => importText.value,
  next => {
    if (next.trim().length === 0) importStatus.value = null;
  },
);

// ---- 总价拆分 ----

// 把总价 T 拆成首行单价 = T / amount（四舍五入到 0.01）；其余行单价 = 1。
// 多个物品时 Σamount*price 自然不等于 T（差额 = n-1），用 warn 状态明示。
const canApplyTotal = computed(
  () => isBuyOrSell.value && typeof totalPrice.value === 'number' && items.value.length > 0,
);

function computeUnit(total: number, amount: number): number {
  const safeAmount = Math.max(1, Math.ceil(amount));
  const raw = total / safeAmount;
  return Math.round(raw * 100) / 100;
}

function applyTotalPrice() {
  if (!canApplyTotal.value) return;
  const total = Number(totalPrice.value);
  if (!Number.isFinite(total) || total < 0) {
    importStatus.value = { kind: 'err', message: '请输入有效的总价。' };
    return;
  }
  const first = items.value[0];
  if (first === undefined || first.amount <= 0) {
    importStatus.value = { kind: 'err', message: '请先添加至少一个有效物品。' };
    return;
  }
  const amount = Math.max(1, Math.ceil(first.amount));
  const unit = computeUnit(total, amount);
  first.price = unit;
  for (let i = 1; i < items.value.length; i++) {
    items.value[i].price = 1;
  }
  const sum = items.value.reduce((s, it) => s + (it.amount ?? 0) * (it.price ?? 0), 0);
  if (items.value.length === 1) {
    importStatus.value = {
      kind: 'ok',
      message: `已应用总价 ${fixed02(total)}：单价 ${fixed02(unit)}`,
    };
  } else {
    importStatus.value = {
      kind: 'warn',
      message: `已应用总价 ${fixed02(total)}；首行单价 ${fixed02(unit)}，其余单价 1；合计 ${fixed02(sum)}（不等于总价）`,
    };
  }
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
        <PrunButton primary @click="onImportClick">识别 JSON</PrunButton>
        <PrunButton primary @click="onUploadClick">上传 JSON</PrunButton>
        <PrunButton primary @click="previewMode = previewMode === 'output' ? 'import' : 'output'">
          {{ previewMode === 'output' ? '切到导入 JSON' : '切到合同 JSON' }}
        </PrunButton>
      </Commands>

      <Active v-if="isBuyOrSell" label="总价" tooltip="拆分到首行单价；其余行单价统一为 1。">
        <input
          v-model.number="totalPrice"
          type="number"
          min="0"
          step="0.01"
          :class="[$style.input, $style.totalInput]"
          placeholder="0.00"
          :aria-label="`总价`" />
        <PrunButton dark :disabled="!canApplyTotal" @click="applyTotalPrice">应用总价</PrunButton>
      </Active>

      <div v-if="newDraftError" :class="$style.errors">
        <div>⚠ {{ newDraftError }}</div>
      </div>
      <div v-else-if="!canSubmit" :class="$style.errors">
        <div v-for="err in validationErrors" :key="err">⚠ {{ err }}</div>
      </div>
    </div>

    <div :class="$style.preview">
      <div :class="$style.previewHeader">
        <div :class="$style.previewLabel">
          {{ previewMode === 'output' ? '合同 JSON' : '导入 JSON' }}
        </div>
        <div :class="$style.previewTabs">
          <button
            type="button"
            :class="[$style.previewTab, previewMode === 'output' ? $style.previewTabActive : null]"
            @click="previewMode = 'output'">
            合同
          </button>
          <button
            type="button"
            :class="[$style.previewTab, previewMode === 'import' ? $style.previewTabActive : null]"
            @click="previewMode = 'import'">
            导入
          </button>
        </div>
      </div>
      <pre v-if="previewMode === 'output'" :class="$style.previewContent">{{ outputJson }}</pre>
      <textarea
        v-else
        v-model="importText"
        :class="[$style.previewContent, $style.previewTextarea]"
        spellcheck="false"
        placeholder="粘贴 ACT JSON、{COF:100} 这样的清单或 CART 导出。点击「识别 JSON」自动覆盖下方物品清单。" />
      <div v-if="previewMode === 'import' && importStatus" :class="$style.previewStatusRow">
        <span
          :class="[
            $style.importStatusText,
            importStatus.kind === 'ok'
              ? $style.statusOk
              : importStatus.kind === 'warn'
                ? $style.statusWarn
                : $style.statusErr,
          ]">
          {{ importStatus.message }}
        </span>
      </div>
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

.previewHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}

.previewLabel {
  font-size: 11px;
  color: #999;
}

.previewTabs {
  display: flex;
  gap: 4px;
}

.previewTab {
  background: transparent;
  border: 1px solid #555;
  color: inherit;
  padding: 1px 8px;
  font-size: 10px;
  cursor: pointer;
}

.previewTab:hover:not(.previewTabActive) {
  background: rgba(255, 255, 255, 0.05);
}

.previewTabActive {
  background: rgba(255, 176, 0, 0.18);
  border-color: #f0ad4e;
  color: #f0ad4e;
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

.previewTextarea {
  resize: vertical;
  white-space: pre;
  color: inherit;
  outline: none;
}

.previewTextarea:focus {
  border-color: #66afe9;
}

.previewStatusRow {
  margin-top: 4px;
  font-size: 11px;
  word-break: break-word;
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

.totalInput {
  flex: 0 0 120px;
}

.importStatusText {
  font-size: 11px;
  word-break: break-word;
}

.statusOk {
  color: #81c784;
}

.statusWarn {
  color: #f0ad4e;
}

.statusErr {
  color: #e57373;
}
</style>
