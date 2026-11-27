<script setup lang="ts">
import { computed, ref, watch } from 'vue';

// 嵌入到 CONTD 草案详情时使用：提供后，主按钮改为「填充当前草案」并调用此回调，
// 而不是走独立的「新建合同并填充」流程。各 XIT 页面保持零耦合——填充由宿主注入。
const props = defineProps<{
  fillCurrent?: (json: string) => Promise<void>;
}>();
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

type Template = 'BUY' | 'SELL' | 'SHIP' | 'LOAN_STABLE' | 'LOAN_ANNUITY' | 'LOAN_INTEREST';

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
  // 贷款模板（LOAN_*）专用：身份、本金、利率、间隔，以及各模板专属参数。
  role?: 'LENDER' | 'BORROWER';
  amount?: number;
  interestRate?: number;
  interval?: number;
  duration?: number;
  repaymentRate?: number;
  initialRepaymentRate?: number;
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
  // 嵌入模式下不消费跨面板的 workspace 导入：那是给独立 CONTGEN 页面用的，
  // 且 workspace key 是「拿到即清空」的一次性语义，嵌入实例抢走会破坏独立页面。
  if (props.fillCurrent !== undefined) {
    return;
  }
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
// 下拉外显用中文，内部值保持 BUY/SELL/SHIP（JSON 输出与校验都依赖这些值）。
const templates = [
  { label: '购买', value: 'BUY' },
  { label: '销售', value: 'SELL' },
  { label: '运输', value: 'SHIP' },
  { label: '贷款·等额本金（稳定）', value: 'LOAN_STABLE' },
  { label: '贷款·等额本息（年金）', value: 'LOAN_ANNUITY' },
  { label: '贷款·先息后本（利息）', value: 'LOAN_INTEREST' },
];

const isShip = computed(() => template.value === 'SHIP');
const isBuyOrSell = computed(() => template.value === 'BUY' || template.value === 'SELL');
const isLoan = computed(() => template.value.startsWith('LOAN_'));

// ── 贷款字段 ──
// 利率/还本比例按百分比输入（2 = 2%），输出 JSON 时换算成游戏用的小数（0.02）。
const loanAmount = useTileState<number | undefined>('loanAmount', 1000000);
const loanRatePct = useTileState<number | undefined>('loanRatePct', 2);
const loanInterval = useTileState<number | undefined>('loanInterval', 7);
const loanRole = useTileState<'LENDER' | 'BORROWER'>('loanRole', 'LENDER');
// 利息贷款：期数（interval × 期数 = 总时长）
const loanDuration = useTileState<number | undefined>('loanDuration', 10);
// 稳定贷款：每期固定还本比例
const loanRepaymentPct = useTileState<number | undefined>('loanRepaymentPct', 12);
// 年金贷款：首期还本比例（之后每期总额固定）
const loanInitialRepaymentPct = useTileState<number | undefined>('loanInitialRepaymentPct', 12);

const loanRoles = [
  { label: '出借方（我放贷）', value: 'LENDER' },
  { label: '借入方（我借款）', value: 'BORROWER' },
];

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
  if (isLoan.value) {
    // 贷款没有物品行：金额、利率、间隔、身份，以及各模板专属参数。
    result.items = [];
    result.role = loanRole.value;
    result.amount = Number(loanAmount.value ?? 0);
    result.interestRate = Number(loanRatePct.value ?? 0) / 100;
    result.interval = Number(loanInterval.value ?? 0);
    if (template.value === 'LOAN_INTEREST') {
      result.duration = Number(loanDuration.value ?? 0);
    } else if (template.value === 'LOAN_STABLE') {
      result.repaymentRate = Number(loanRepaymentPct.value ?? 0) / 100;
    } else {
      result.initialRepaymentRate = Number(loanInitialRepaymentPct.value ?? 0) / 100;
    }
  }
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
  if (isLoan.value) {
    const amount = Number(loanAmount.value ?? 0);
    const rate = Number(loanRatePct.value ?? 0);
    const interval = Number(loanInterval.value ?? 0);
    if (!(amount > 0)) {
      errs.push('本金必须大于 0');
    } else if (amount < 100) {
      // 游戏自己的下限：小于 100 时模板弹窗的「应用模板」是禁用的。
      errs.push('本金至少 100（游戏下限）');
    }
    if (!(rate >= 0)) {
      errs.push('利率不能为负');
    }
    if (!(interval >= 1)) {
      errs.push('还款间隔至少 1 天');
    }
    if (template.value === 'LOAN_INTEREST' && !((loanDuration.value ?? 0) >= 1)) {
      errs.push('先息后本至少要 1 期');
    }
    if (template.value === 'LOAN_STABLE' && !((loanRepaymentPct.value ?? 0) > 0)) {
      errs.push('每期还本比例必须大于 0');
    }
    if (template.value === 'LOAN_ANNUITY' && !((loanInitialRepaymentPct.value ?? 0) > 0)) {
      errs.push('首期还本比例必须大于 0');
    }
    return errs;
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

// 填充/新建的运行期错误单独存一份：它无论独立还是嵌入模式都要显示，
// 而表单校验提示只在独立模式显示（见模板）。

// Maps helper milestones to the user-facing status string. Picked
// at await points so the button text updates as work progresses.
const NEW_DRAFT_STATUS_LABELS = {
  starting: '打开 CONTD…',
  filled: '完成',
} as const;
const FILL_CURRENT_STATUS_LABELS = {
  starting: '填充中…',
  filled: '完成',
} as const;
const isEmbedded = computed(() => props.fillCurrent !== undefined);
const primaryLabel = computed(() => (isEmbedded.value ? '填充当前草案' : '新建合同并填充'));
const activeStatusLabels = computed(() =>
  isEmbedded.value ? FILL_CURRENT_STATUS_LABELS : NEW_DRAFT_STATUS_LABELS,
);

async function handleNewDraftAndFill() {
  if (!canSubmit.value || isNewing.value) {
    return;
  }
  newDraftError.value = null;
  newDraftStatus.value = activeStatusLabels.value.starting;
  try {
    if (props.fillCurrent !== undefined) {
      // 嵌入模式：就地填充当前草案，由宿主（CONTD feature）注入填充实现。
      await props.fillCurrent(outputJson.value);
    } else {
      await newContractDraftAndFill(outputJson.value);
    }
    newDraftStatus.value = activeStatusLabels.value.filled;
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
    if (next.trim().length === 0) {
      importStatus.value = null;
    }
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
  if (!canApplyTotal.value) {
    return;
  }
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
  <div :class="[$style.root, { [$style.embedded]: isEmbedded }]">
    <div :class="$style.form">
      <!-- 头部字段：嵌入 CONTD 时用 grid 平均分布成一行（label 上、值下）；
           独立 CONTGEN 页面保持原生的 label 左 + 值右纵向堆叠。 -->
      <div :class="$style.topFields">
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

        <Active
          v-if="isBuyOrSell"
          label="目的地"
          tooltip="行星 naturalId，例如 ZV-307a 或别名 HRT。">
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
      </div>

      <div v-if="isLoan" :class="$style.topFields">
        <Active label="我方身份" tooltip="出借方＝我把钱借出去；借入方＝我借钱。">
          <SelectInput v-model="loanRole" :options="loanRoles" />
        </Active>
        <Active label="本金" tooltip="贷款金额（合同币种）。">
          <input v-model.number="loanAmount" type="number" min="0" step="1" :class="$style.input" />
        </Active>
        <Active label="利率（%/期）" tooltip="每期利率，按百分比填写：2 = 每期 2%。">
          <input
            v-model.number="loanRatePct"
            type="number"
            min="0"
            step="0.01"
            :class="$style.input" />
        </Active>
        <Active label="还款间隔（天）" tooltip="相邻两期还款之间相隔的天数。">
          <input
            v-model.number="loanInterval"
            type="number"
            min="1"
            step="1"
            :class="$style.input" />
        </Active>
        <Active
          v-if="template === 'LOAN_INTEREST'"
          label="还款期数"
          tooltip="先息后本：每期只还利息，最后一期连本带息还清。期数 × 间隔 = 总时长。">
          <input
            v-model.number="loanDuration"
            type="number"
            min="1"
            step="1"
            :class="$style.input" />
        </Active>
        <Active
          v-if="template === 'LOAN_STABLE'"
          label="每期还本比例（%）"
          tooltip="等额本金：每期偿还固定比例的本金，利息按剩余本金另计。">
          <input
            v-model.number="loanRepaymentPct"
            type="number"
            min="0.01"
            step="0.01"
            :class="$style.input" />
        </Active>
        <Active
          v-if="template === 'LOAN_ANNUITY'"
          label="首期还本比例（%）"
          tooltip="等额本息：每期还款总额固定，首期本金占比决定这个固定额。">
          <input
            v-model.number="loanInitialRepaymentPct"
            type="number"
            min="0.01"
            step="0.01"
            :class="$style.input" />
        </Active>
      </div>

      <Active
        v-if="!isLoan"
        label="物品清单"
        tooltip="每行一个物品；BUY/SELL 需填单价，SHIP 共享运费。">
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

      <Commands label="操作">
        <PrunButton :disabled="!canSubmit || isNewing" primary @click="handleNewDraftAndFill">
          {{ isNewing ? newDraftStatus : primaryLabel }}
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
    </div>

    <!-- 运行期失败（填充当前草案 / 新建并填充抛错）两种模式都必须报出来：
         嵌入时若一并抑制，按钮只是悄悄回到初始文字，用户不知道刚才为什么没填进去，
         而原生字段可能已经被填了一部分。 -->
    <div v-if="newDraftError" :class="$style.errors">
      <div>⚠ {{ newDraftError }}</div>
    </div>
    <!-- 表单校验提示只在独立模式显示：嵌入模式下物品清单占满整行，不占版面。 -->
    <div v-else-if="!isEmbedded && !canSubmit" :class="$style.errors">
      <div v-for="err in validationErrors" :key="err">⚠ {{ err }}</div>
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
  /* 按内容高度排布，不撑满剩余空间——否则内容少时表单内部底部留出大片空白，
     把校验提示和 JSON 区顶到很下面。改为内容紧凑在上，剩余空白自然落到容器
     底部（连同校验提示、JSON 区整体上移）。
     但必须允许收缩（flex-shrink: 1）：根节点是 height:100% + overflow:hidden、
     预览区又固定占 200px，若 basis 取内容高度且不可缩小，内容一多（长 CART/BPC
     清单、或把独立 CONTGEN 窗口拉矮）总高就会超出根节点被裁掉，此时表单自己的
     overflow-y 根本不会生效，底部按钮也点不到。basis:auto + shrink:1 让「内容少
     时紧凑、内容多时内部滚动」两者兼得；min-height:0 是让滚动生效的前提。 */
  flex: 0 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 8px;
  border-bottom: 1px solid #444;
}

/* 头部字段容器：独立页面保持原生纵向堆叠（display:contents 不产生布局盒）。 */
.topFields {
  display: contents;
}

/* 嵌入 CONTD 时：头部字段合并成一行、平均分布。
   用 grid + auto-fit 让列数随字段数自适应（BUY/SELL 5 列、SHIP 7 列时缩小列宽）。
   原生 Active 是 label 左 + input 右的横向布局，此处覆盖为 label 上 + 值下，
   让每个字段在窄列里也能完整显示。 */
.embedded .topFields {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  gap: 6px;
  margin-bottom: 4px;
}
.embedded .topFields > :global([class*='FormComponent__containerActive']) {
  flex-direction: column !important;
  align-items: stretch !important;
  min-width: 0 !important;
  height: auto !important;
}
/* 去掉原生 FormComponent 的浅蓝底色——表头合并一行后，输入框下方的底色块
   显得多余，改为透明融入面板背景（label 自身的深色标题条保留）。
   主题引擎用 `html[data-rp-theme="light"][data-rp-theme] [class*=...]` 高特异性
   + !important 设底色，这里必须匹配同等特异性才能覆盖。 */
:global(html[data-rp-theme])
  .embedded
  .topFields
  > :global([class*='FormComponent__containerActive']) {
  background: transparent !important;
}
.embedded .topFields > :global([class*='FormComponent__containerActive']) > label {
  width: auto !important;
  min-width: 0 !important;
  flex: 0 0 18px !important;
  line-height: 18px !important;
  height: 18px !important;
  white-space: nowrap !important;
}
/* 值区：放宽到 22px 容纳控件并垂直居中；去掉原生 DynamicInput 左右 4px
   内边距，让下拉框/输入框与上方标题左右对齐（否则两边各留 4px 余量）。 */
.embedded
  .topFields
  > :global([class*='FormComponent__containerActive'])
  > :global([class*='FormComponent__input']) {
  flex: 0 0 22px !important;
  width: 100% !important;
  min-width: 0 !important;
  height: 22px !important;
  display: flex !important;
  align-items: center !important;
  padding: 0 !important;
}
.embedded
  .topFields
  > :global([class*='FormComponent__containerActive'])
  > :global([class*='FormComponent__input'])
  > :global([class*='DynamicInput__dynamic']) {
  width: 100% !important;
  padding: 0 !important;
}
.embedded
  .topFields
  > :global([class*='FormComponent__containerActive'])
  > :global([class*='FormComponent__input'])
  > :global([class*='DynamicInput__dynamic'])
  > * {
  width: 100% !important;
  box-sizing: border-box !important;
}
/* 统一 5 个字段的控件框高度：原生 select 与 input 的默认高度不同（select 17px、
   input 19px，前者还受 UA 的 13.33px 字号影响），合并成一行后前两个下拉框比后
   三个输入框矮一截。这里强制三者同高同字号，5 个框视觉严格一致。 */
.embedded .topFields input,
.embedded .topFields select {
  height: 19px !important;
  min-height: 19px !important;
  max-height: 19px !important;
  box-sizing: border-box !important;
  padding: 0 4px !important;
  margin: 0 !important;
  line-height: 17px !important;
  font-size: 11px !important;
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
  font-size: calc(10px + 1px * var(--rp-font-enlargement));
  cursor: pointer;
}

.previewTab:hover:not(.previewTabActive) {
  background: rgba(255, 255, 255, 0.05);
}

.previewTabActive {
  /* 原先是硬编码 #f0ad4e + rgba(var(--rp-accent-rgb), 0.18)：
     主题引擎把文字重映射成暖米纸的石板棕 rgb(138,90,28)，压在 0.18 的
     暖棕半透明底上只有 4.33:1。文字/描边改走主题选中色（三套主题都定义，
     原样主题回退橙色），底色 alpha 降到 0.10 让底更浅，对比度过 4.5:1。 */
  background: rgba(var(--rp-accent-rgb), 0.1);
  border-color: var(--rp-skin-selection, #f0ad4e);
  color: var(--rp-skin-selection, #f0ad4e);
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

/* 仅嵌入模式：Ticker 列（表头 + 每行的 MaterialPicker）吃掉剩余宽度，物品清单
   表格整体随窗口伸缩；数量/单价/删除保持固定宽度不被拉伸。独立 CONTGEN 维持
   原有固定列宽。MaterialPicker 根元素自带 flex: 0 0 80px，需 !important 覆盖。
   min-width 取 0（不设像素下限），窄窗口下可继续收缩而非溢出。 */
.embedded .itemHeaderCellTicker {
  flex: 1 1 auto !important;
  min-width: 0 !important;
}
.embedded .itemRow > :first-child {
  flex: 1 1 auto !important;
  min-width: 0 !important;
}

.itemHeader {
  display: flex;
  gap: 4px;
  align-items: center;
  padding: 0 2px 4px;
  font-size: calc(10px + 1px * var(--rp-font-enlargement));
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
  flex: 0 0 auto;
  margin: 0 8px 4px;
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
