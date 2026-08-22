<script setup lang="ts">
import Active from '@src/components/forms/Active.vue';
import Commands from '@src/components/forms/Commands.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { userData } from '@src/store/user-data';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { fixed0, fixed02 } from '@src/utils/format';
import { getSellLimitPrice } from '@src/core/orders';
import { companyStore } from '@src/infrastructure/prun-api/data/company';
import { getMaterialNameByTicker } from '@src/util';
import { consumeDraggedTickers } from '@src/features/XIT/SELL/drag-import';

// 四大交易所的 CX 仓库。
const exchanges = ['IC1', 'NC1', 'AI1', 'CI1'];

const exchange = ref('IC1');
const tickersInput = ref('');
const jsonInput = ref('');
const jsonError = ref('');
const mode = ref<'LIMIT' | 'FILL'>('LIMIT');

interface SellRow {
  ticker: string;
  /** 该行的售卖交易所（可经 JSON 每项覆盖）。 */
  exchange: string;
  found: boolean;
  warehouseAmount: number;
  amount: number;
  /** 挂单排名（1=卖价第一名，默认 1）。 */
  rank: number;
}

const rows = ref<SellRow[]>([]);
const loaded = ref(false);

// 仓库框选物品拖入输入框的 drop 状态。
const isDragOver = ref(false);
const dropZone = useTemplateRef<HTMLElement>('dropZone');

function onDragLeave(event: DragEvent) {
  if (!dropZone.value?.contains(event.relatedTarget as Node | null)) {
    isDragOver.value = false;
  }
}

function onDropTickers(event: DragEvent) {
  isDragOver.value = false;
  const custom = event.dataTransfer?.getData('text/xit-sell') ?? '';
  let tickers = custom
    .split(/[,，\s]+/)
    .map(x => x.trim().toUpperCase())
    .filter(Boolean);
  if (tickers.length === 0) {
    tickers = consumeDraggedTickers();
  }
  if (tickers.length > 0) {
    tickersInput.value = tickers.join(', ');
    loadInventory();
  }
}

function rowKey(row: SellRow) {
  return `${row.exchange}|${row.ticker}`;
}

function currencyCodeOf(exchangeCode: string) {
  return exchangesStore.getByCode(exchangeCode)?.currency.code ?? '';
}

// 实时自动价格：挂单按排名压价（默认卖价第一名），填单取买一价。
const livePrices = computed<Record<string, number>>(() => {
  const result: Record<string, number> = {};
  for (const row of rows.value) {
    const orderBook = cxobStore.getByTicker(`${row.ticker}.${row.exchange}`);
    if (!orderBook) {
      continue;
    }
    if (mode.value === 'FILL') {
      const bids = [...orderBook.buyingOrders].sort((a, b) => b.limit.amount - a.limit.amount);
      const best = bids.at(0);
      if (best) {
        result[rowKey(row)] = best.limit.amount;
      }
    } else {
      const asks = [...orderBook.sellingOrders].sort((a, b) => a.limit.amount - b.limit.amount);
      const price = getSellLimitPrice(asks, row.rank, companyStore.value?.id);
      if (price !== undefined) {
        result[rowKey(row)] = price;
      }
    }
  }
  return result;
});

function warehouseOf(exchangeCode: string) {
  const naturalId = exchangesStore.getNaturalIdFromCode(exchangeCode);
  const warehouse = warehousesStore.getByEntityNaturalId(naturalId);
  return storagesStore.getById(warehouse?.storeId);
}

function warehouseAmountOf(storage: PrunApi.Store | undefined, ticker: string) {
  return (
    storage?.items
      .map(x => x.quantity ?? undefined)
      .filter(x => x !== undefined)
      .find(x => x.material.ticker === ticker)?.amount ?? 0
  );
}

function loadInventory() {
  const tickers = [
    ...new Set(
      tickersInput.value
        .split(/[,，\s]+/)
        .map(x => x.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  const storage = warehouseOf(exchange.value);
  rows.value = tickers.map(ticker => {
    const found = materialsStore.getByTicker(ticker) !== undefined;
    const held = found ? warehouseAmountOf(storage, ticker) : 0;
    return {
      ticker,
      exchange: exchange.value,
      found,
      warehouseAmount: held,
      amount: held,
      rank: 1,
    };
  });
  loaded.value = true;
}

type UnknownRecord = Record<string, unknown>;

// 兼容两种 JSON 形态：裸数组 [{ticker, amount, rank}] 或 { items: [...] }。
function extractJsonItems(parsed: unknown): UnknownRecord[] {
  const list = Array.isArray(parsed) ? parsed : (parsed as UnknownRecord | null)?.items;
  if (!Array.isArray(list)) {
    return [];
  }
  return list.filter((x): x is UnknownRecord => x !== null && typeof x === 'object');
}

function toPositiveNumber(value: unknown) {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

function toPositiveInt(value: unknown) {
  const num = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(num) && num > 0 ? num : undefined;
}

function loadFromJson() {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonInput.value);
  } catch {
    jsonError.value = 'JSON 解析失败';
    return;
  }
  // 顶层对象可携带 exchange / mode（裸数组则保持面板当前选择）。
  const record =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as UnknownRecord)
      : null;
  if (record?.exchange !== undefined) {
    const code = String(record.exchange).trim().toUpperCase();
    if (!exchanges.includes(code)) {
      jsonError.value = `交易所 ${record.exchange} 无效（可选：${exchanges.join(' / ')}）`;
      return;
    }
    exchange.value = code;
  }
  if (record?.mode !== undefined) {
    const m = String(record.mode).trim().toUpperCase();
    if (m !== 'LIMIT' && m !== 'FILL') {
      jsonError.value = `模式 ${record.mode} 无效（LIMIT 或 FILL）`;
      return;
    }
    mode.value = m;
  }
  const items = extractJsonItems(parsed);
  if (items.length === 0) {
    jsonError.value = '未识别到物品（需要 ticker 和 amount 字段）';
    return;
  }
  // 每项可带 exchange（缺省用顶层/面板交易所）；非法值整体报错。
  for (const item of items) {
    if (item.exchange !== undefined) {
      const code = String(item.exchange).trim().toUpperCase();
      if (!exchanges.includes(code)) {
        jsonError.value = `物品 ${item.ticker} 的交易所 ${item.exchange} 无效（可选：${exchanges.join(' / ')}）`;
        return;
      }
    }
  }
  jsonError.value = '';
  // 按 (交易所, ticker) 去重，仓库按交易所分别读取。
  const storages = new Map<string, PrunApi.Store | undefined>();
  const seen = new Set<string>();
  const parsedRows: SellRow[] = [];
  for (const item of items) {
    const ticker = String(item.ticker ?? '')
      .trim()
      .toUpperCase();
    const rowExchange =
      item.exchange !== undefined ? String(item.exchange).trim().toUpperCase() : exchange.value;
    const key = `${rowExchange}|${ticker}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (!storages.has(rowExchange)) {
      storages.set(rowExchange, warehouseOf(rowExchange));
    }
    const found = materialsStore.getByTicker(ticker) !== undefined;
    const held = found ? warehouseAmountOf(storages.get(rowExchange), ticker) : 0;
    parsedRows.push({
      ticker,
      exchange: rowExchange,
      found,
      warehouseAmount: held,
      amount: toPositiveNumber(item.amount) ?? held,
      rank: toPositiveInt(item.rank) ?? 1,
    });
  }
  rows.value = parsedRows;
  loaded.value = true;
}

function proceedsOf(row: SellRow) {
  const price = livePrices.value[rowKey(row)];
  if (price === undefined) {
    return undefined;
  }
  return price * row.amount;
}

function generate() {
  const items = rows.value.filter(r => r.found && r.amount > 0);
  if (items.length === 0) {
    return;
  }
  // 包名仅用 ASCII（XIT 命令参数在 PrUn 端只吃 ASCII），时间戳保证唯一。
  const exchangeSet = new Set(items.map(r => r.exchange));
  const name =
    exchangeSet.size === 1
      ? `SELL ${[...exchangeSet][0]} ${Date.now().toString(36)}`
      : `SELL ${Date.now().toString(36)}`;
  const actions: UserData.ActionData[] = items.map(row => ({
    type: 'CX Sell',
    name: `Sell_${row.exchange}_${row.ticker}`,
    exchange: row.exchange,
    ticker: row.ticker,
    amount: row.amount,
    sellMode: mode.value,
    rank: Math.max(1, Math.floor(row.rank)),
  }));
  // 一次性操作包：执行成功后自动从列表删除（失败保留，便于重试）。
  const pkg: UserData.ActionPackageData = {
    global: { name },
    groups: [],
    actions,
    autoDelete: true,
  };
  const existing = userData.actionPackages.findIndex(x => x.global.name === name);
  if (existing >= 0) {
    userData.actionPackages[existing] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }
  showBuffer(`XIT ACT_${name.replace(/\s+/g, '_')}`);
}
</script>

<template>
  <Active label="交易所">
    <div :class="$style.exchangeButtons">
      <PrunButton
        v-for="code in exchanges"
        :key="code"
        :primary="exchange === code"
        :dark="exchange !== code"
        @click="exchange = code">
        {{ code }}
      </PrunButton>
    </div>
  </Active>
  <Active
    label="物品代码"
    tooltip="逗号分隔，如：FE, ICE, H2O；也可从仓库框选物品后拖到此处自动识别">
    <div
      ref="dropZone"
      :class="[$style.tickerField, isDragOver && $style.tickerFieldDragOver]"
      @dragover.prevent.stop="isDragOver = true"
      @dragleave="onDragLeave"
      @drop.prevent.stop="onDropTickers">
      <TextInput v-model="tickersInput" />
    </div>
  </Active>
  <Active
    label="JSON 识别"
    tooltip='顶层可带 exchange（AI1/NC1/AI1/CI1）与 mode（LIMIT/FILL）；items 每项 { "ticker": "FE", "amount": 5000, "rank": 1, "exchange": "AI1" }，exchange/rank 可省，缺省用面板当前交易所、排名 1'>
    <textarea
      v-model="jsonInput"
      :class="[$style.surfaceInput, $style.jsonInput]"
      spellcheck="false"
      placeholder='{ "mode": "LIMIT", "items": [{ "ticker": "NN", "amount": 1, "exchange": "IC1", "rank": 1 }, { "ticker": "NN", "amount": 5, "exchange": "AI1" }] }' />
  </Active>
  <div v-if="jsonError" :class="$style.jsonError">{{ jsonError }}</div>
  <Active label="售卖方式">
    <RadioItem :model-value="mode === 'LIMIT'" @update:model-value="() => (mode = 'LIMIT')">
      挂单售卖
    </RadioItem>
    <RadioItem :model-value="mode === 'FILL'" @update:model-value="() => (mode = 'FILL')">
      填单售卖
    </RadioItem>
  </Active>
  <Commands>
    <PrunButton primary :disabled="!tickersInput.trim()" @click="loadInventory">
      读取库存
    </PrunButton>
    <PrunButton primary :disabled="!jsonInput.trim()" @click="loadFromJson"> 识别 JSON </PrunButton>
  </Commands>
  <table v-if="loaded" :class="$style.table">
    <thead>
      <tr>
        <th>物品</th>
        <th>交易所</th>
        <th>名称</th>
        <th>仓库数量</th>
        <th>售卖数量</th>
        <th>挂单排名</th>
        <th>自动价格</th>
        <th>预计入账</th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="row in rows" :key="rowKey(row)">
        <td>{{ row.ticker }}</td>
        <td>{{ row.exchange }}</td>
        <td :class="$style.muted">
          {{ row.found ? getMaterialNameByTicker(row.ticker) : '未知物品' }}
        </td>
        <td>{{ fixed0(row.warehouseAmount) }}</td>
        <td>
          <div :class="[C.forms.input, $style.tableInput]">
            <NumberInput v-model="row.amount" :min="0" />
          </div>
        </td>
        <td>
          <div :class="[C.forms.input, $style.tableInput]">
            <NumberInput v-model="row.rank" :min="1" />
          </div>
        </td>
        <td :class="$style.muted">
          {{ livePrices[rowKey(row)] !== undefined ? fixed02(livePrices[rowKey(row)]) : '--' }}
        </td>
        <td>
          <span v-if="proceedsOf(row) !== undefined">
            {{ fixed0(proceedsOf(row)!) }} {{ currencyCodeOf(row.exchange) }}
          </span>
          <span v-else :class="$style.muted">--</span>
        </td>
      </tr>
    </tbody>
  </table>
  <Commands>
    <PrunButton
      primary
      :disabled="!loaded || !rows.some(r => r.found && r.amount > 0)"
      @click="generate">
      生成售卖包
    </PrunButton>
  </Commands>
</template>

<style module>
.exchangeButtons {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}

.tickerField input {
  width: 240px;
  height: 40px;
  font-size: 14px;
}

.tickerFieldDragOver {
  outline: 2px dashed rgb(255, 176, 0);
  outline-offset: 2px;
}

.surfaceInput {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid rgb(61, 74, 84);
  background: rgb(26, 33, 38);
  color: rgb(226, 230, 233);
  font: inherit;
  outline: none;
}

.surfaceInput:focus {
  border-color: rgb(255, 176, 0);
  box-shadow: inset 0 0 0 1px rgb(255, 176, 0);
}

.jsonInput {
  min-height: 104px;
  padding: 6px 8px;
  resize: vertical;
}

.jsonInput::-webkit-scrollbar {
  width: 10px;
}

.jsonInput::-webkit-scrollbar-track {
  background: rgb(26, 33, 38);
}

.jsonInput::-webkit-scrollbar-thumb {
  background: rgb(61, 74, 84);
  border-radius: 5px;
}

.jsonInput::-webkit-scrollbar-thumb:hover {
  background: rgb(90, 105, 118);
}

.jsonError {
  margin: 0 6px;
  color: rgb(217, 83, 79);
  font-size: 11px;
}

.tableInput {
  width: 50%;
  min-width: 45px;
}

.tableInput input {
  width: 100%;
}

.table {
  margin: 4px 6px;
  width: calc(100% - 12px);
  border-collapse: collapse;
}

.table th,
.table td {
  padding: 2px 6px;
  text-align: left;
  font-size: 11px;
}

.table th {
  color: #888;
  font-weight: 600;
}

.muted {
  color: #777;
}
</style>
