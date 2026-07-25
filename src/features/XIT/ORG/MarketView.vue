<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue';
import type { OrgTask } from '@src/infrastructure/org-api/types';
import * as tasksApi from '@src/infrastructure/org-api/tasks';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getMaterialName } from '@src/infrastructure/prun-ui/i18n';
import SectionHeader from '@src/components/SectionHeader.vue';
import PrunButton from '@src/components/PrunButton.vue';
import EmptyState from './EmptyState.vue';
import TradeOverlay from './TradeOverlay.vue';
import { useOrgTileState } from './tile-state';
import { fixed0, fixed2 } from '@src/utils/format';
import { formatNumber } from './utils';

// 单条任务的"市场挂单"：一个原 BUY/SELL 任务对应一条挂单行。
// 这里不按 price 聚合——保留 taskId 是因为接取动作必须指明具体任务。
interface MarketOrder {
  taskId: string;
  publisher: string;
  type: 'BUY' | 'SELL';
  price: number;
  amount: number;
  currency: string;
  location?: string;
}

interface MaterialRow {
  ticker: string;
  name: string;
  // 同一商品下所有 BUY/SELL 任务的挂单
  orders: MarketOrder[];
  // 该商品所有任务合并去重后的交货地点
  allLocations: string[];
}

const loading = ref(false);
const error = ref('');
const expanded = ref<Set<string>>(new Set());

const tasks = ref<OrgTask[]>([]);

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    const result = await tasksApi.listTasks({ scope: 'board', limit: 100 });
    tasks.value = result.items.filter(t => t.type === 'BUY' || t.type === 'SELL');
  } catch (err) {
    error.value = String(err);
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);

function toggle(ticker: string) {
  const next = new Set(expanded.value);
  if (next.has(ticker)) next.delete(ticker);
  else next.add(ticker);
  expanded.value = next;
}

// TradeOverlay 预填：每个挂单行点击「接取」时打开，参数取自该行原任务
interface TradePrefill {
  taskId: string;
  ticker: string;
  side: 'BUY' | 'SELL';
  maxAmount: number;
  price: number;
  currency: string;
  location?: string;
  publisher: string;
}
const tradePrefill = ref<TradePrefill | null>(null);

// 每个挂单行右侧的 ticker 在表格上下文里已知（来自所属商品的 ticker），
// 我们需要把 ticker 一起传给 TradeOverlay。
function openClaim(order: MarketOrder, ticker: string) {
  tradePrefill.value = {
    taskId: order.taskId,
    ticker,
    side: order.type,
    maxAmount: order.amount,
    price: order.price,
    currency: order.currency,
    location: order.location,
    publisher: order.publisher,
  };
}
function closeTrade() {
  tradePrefill.value = null;
}
async function onTradeClaimed() {
  await refresh();
}

// 「去发布」切到 PublishTask 并预填
const tab = useOrgTileState('tab');
type PrefillSetFn = (data: {
  type: 'BUY' | 'SELL';
  ticker: string;
  price: number;
  location?: string;
}) => void;
const injectPrefillSet = inject<PrefillSetFn | null>('orgMarketPrefillSet', null);

function goPublish(row: MaterialRow, side: 'BUY' | 'SELL', suggestedPrice: number) {
  tab.value = 'publish';
  injectPrefillSet?.({
    type: side,
    ticker: row.ticker,
    price: suggestedPrice,
    location: row.allLocations[0],
  });
}

// 聚合：把 tasks 摊平成 (commodity → orders[])。
// 每条挂单来自任务的第一个有价 item。
const materialRows = computed<MaterialRow[]>(() => {
  const map = new Map<string, MaterialRow>();
  for (const task of tasks.value) {
    const items = task.contractJson.items ?? [];
    const taskLocation = task.contractJson.location ?? '';
    const currency = task.contractJson.currency ?? 'ICA';
    for (const item of items) {
      if (!item.commodity) continue;
      if (!Number.isFinite(item.price) || (item.price ?? 0) <= 0) continue;
      const ticker = item.commodity;
      let row = map.get(ticker);
      if (!row) {
        const material = materialsStore.getByTicker(ticker);
        row = {
          ticker,
          name: getMaterialName(material) ?? ticker,
          orders: [],
          allLocations: [],
        };
        map.set(ticker, row);
      }
      row.orders.push({
        taskId: task.id,
        publisher: task.publisherUsername,
        type: task.type as 'BUY' | 'SELL',
        price: item.price as number,
        amount: item.amount,
        currency,
        location: taskLocation || undefined,
      });
      if (taskLocation && !row.allLocations.includes(taskLocation)) {
        row.allLocations.push(taskLocation);
      }
    }
  }
  // 挂单排序：BUY 按 price desc，SELL 按 price asc
  for (const row of map.values()) {
    row.orders.sort((a, b) => {
      if (a.type !== b.type) {
        // BUY 排前
        return a.type === 'BUY' ? -1 : 1;
      }
      if (a.type === 'BUY') return b.price - a.price;
      return a.price - b.price;
    });
  }
  return Array.from(map.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
});

// 顶层摘要：BUY 最高价 / SELL 最低价 / 各侧总量
function bestBidPrice(orders: MarketOrder[]): number | undefined {
  const bids = orders.filter(o => o.type === 'BUY');
  if (bids.length === 0) return undefined;
  return Math.max(...bids.map(o => o.price));
}
function bestAskPrice(orders: MarketOrder[]): number | undefined {
  const asks = orders.filter(o => o.type === 'SELL');
  if (asks.length === 0) return undefined;
  return Math.min(...asks.map(o => o.price));
}
function totalAmount(orders: MarketOrder[], type: 'BUY' | 'SELL'): number {
  return orders.filter(o => o.type === type).reduce((s, o) => s + o.amount, 0);
}
function bestBid(orders: MarketOrder[]): MarketOrder | undefined {
  const bids = orders.filter(o => o.type === 'BUY');
  if (bids.length === 0) return undefined;
  return bids.reduce((a, b) => (a.price >= b.price ? a : b));
}
function bestAsk(orders: MarketOrder[]): MarketOrder | undefined {
  const asks = orders.filter(o => o.type === 'SELL');
  if (asks.length === 0) return undefined;
  return asks.reduce((a, b) => (a.price <= b.price ? a : b));
}
</script>

<template>
  <div :class="$style.market">
    <SectionHeader>市场</SectionHeader>

    <div v-if="loading" :class="$style.info">加载中...</div>
    <div v-else-if="error" :class="$style.error">{{ error }}</div>
    <template v-else-if="materialRows.length === 0">
      <EmptyState message="暂无可显示的商品（无 BUY/SELL 任务或未填单价）" />
    </template>
    <template v-else>
      <table :class="$style.table">
        <thead>
          <tr>
            <th :class="$style.expandCol" />
            <th :class="$style.materialCol">商品</th>
            <th :class="$style.marketCol">最高买价</th>
            <th :class="$style.marketCol">最低卖价</th>
            <th :class="$style.numCol">买单量</th>
            <th :class="$style.numCol">卖单量</th>
          </tr>
        </thead>
        <tbody v-for="row in materialRows" :key="row.ticker">
          <tr :class="$style.row" @click="toggle(row.ticker)">
            <td :class="$style.expand">
              {{ expanded.has(row.ticker) ? '−' : '+' }}
            </td>
            <td :class="$style.materialCell">
              <MaterialIcon :ticker="row.ticker" size="medium" />
              <span :class="$style.materialName">{{ row.name }}</span>
            </td>
            <td :class="[$style.marketCell, $style.marketCellBuy]">
              <template v-if="bestBid(row.orders)">
                <span :class="[$style.marketBadge, $style.buyBadge]">买</span>
                <span :class="$style.marketPrice">
                  {{ fixed2(bestBid(row.orders)!.price) }}
                </span>
                <span :class="$style.marketQty"> ×{{ fixed0(bestBid(row.orders)!.amount) }} </span>
              </template>
              <span v-else :class="$style.muted">--</span>
            </td>
            <td :class="[$style.marketCell, $style.marketCellSell]">
              <template v-if="bestAsk(row.orders)">
                <span :class="[$style.marketBadge, $style.sellBadge]">卖</span>
                <span :class="$style.marketPrice">
                  {{ fixed2(bestAsk(row.orders)!.price) }}
                </span>
                <span :class="$style.marketQty"> ×{{ fixed0(bestAsk(row.orders)!.amount) }} </span>
              </template>
              <span v-else :class="$style.muted">--</span>
            </td>
            <td :class="$style.numCell">{{ fixed0(totalAmount(row.orders, 'BUY')) }}</td>
            <td :class="$style.numCell">{{ fixed0(totalAmount(row.orders, 'SELL')) }}</td>
          </tr>
          <tr v-if="expanded.has(row.ticker)" :class="$style.detailRow">
            <td colspan="6" :class="$style.detailCell">
              <!--
                位置信息区：详情展示区域中清晰、准确地显示相关位置信息
                （架构要求）。row.allLocations 是 BUY + SELL 任务 location
                去重合并后的列表。
              -->
              <div :class="$style.locationBar">
                <span :class="$style.locationLabel">交货地点：</span>
                <template v-if="row.allLocations.length > 0">
                  <span v-for="loc in row.allLocations" :key="loc" :class="$style.locationChip">
                    {{ loc }}
                  </span>
                </template>
                <span v-else :class="$style.muted">未填写（发布者未指定地点）</span>
              </div>

              <!-- 顶部动作栏：发布新任务快捷入口 -->
              <div :class="$style.actionBar">
                <PrunButton
                  primary
                  inline
                  @click.stop="
                    goPublish(row, 'BUY', bestBidPrice(row.orders) ?? bestAskPrice(row.orders) ?? 0)
                  ">
                  去发布（买入）
                </PrunButton>
                <PrunButton
                  primary
                  inline
                  @click.stop="
                    goPublish(
                      row,
                      'SELL',
                      bestAskPrice(row.orders) ?? bestBidPrice(row.orders) ?? 0,
                    )
                  ">
                  去发布（卖出）
                </PrunButton>
              </div>

              <div :class="$style.detailGrid">
                <!-- 买单：来自 BUY 任务；接取表示"我要卖给发布者" -->
                <div :class="$style.detailPane">
                  <div :class="[$style.detailHeader, $style.detailHeaderBuy]">
                    <span :class="[$style.marketBadge, $style.buyBadge]">买</span>
                    买单（{{ row.orders.filter(o => o.type === 'BUY').length }} 单）
                  </div>
                  <table :class="$style.detailTable">
                    <thead>
                      <tr>
                        <th :class="$style.detailNumCol">单价</th>
                        <th :class="$style.detailNumCol">数量</th>
                        <th>地点</th>
                        <th>发布者</th>
                        <th :class="$style.actionCol">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(o, i) in row.orders.filter(o => o.type === 'BUY')" :key="`b${i}`">
                        <td :class="$style.detailNumCol">{{ fixed2(o.price) }}</td>
                        <td :class="$style.detailNumCol">{{ formatNumber(o.amount) }}</td>
                        <td :class="$style.locCell">
                          <span v-if="o.location" :class="$style.locationChipSm">
                            {{ o.location }}
                          </span>
                          <span v-else :class="$style.muted">—</span>
                        </td>
                        <td>{{ o.publisher }}</td>
                        <td :class="$style.actionCol">
                          <PrunButton primary inline @click.stop="openClaim(o, row.ticker)">
                            接取
                          </PrunButton>
                        </td>
                      </tr>
                      <tr v-if="row.orders.filter(o => o.type === 'BUY').length === 0">
                        <td colspan="5" :class="$style.empty">暂无买单</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
                <!-- 卖单：来自 SELL 任务；接取表示"我要从发布者买" -->
                <div :class="$style.detailPane">
                  <div :class="[$style.detailHeader, $style.detailHeaderSell]">
                    <span :class="[$style.marketBadge, $style.sellBadge]">卖</span>
                    卖单（{{ row.orders.filter(o => o.type === 'SELL').length }} 单）
                  </div>
                  <table :class="$style.detailTable">
                    <thead>
                      <tr>
                        <th :class="$style.detailNumCol">单价</th>
                        <th :class="$style.detailNumCol">数量</th>
                        <th>地点</th>
                        <th>发布者</th>
                        <th :class="$style.actionCol">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr
                        v-for="(o, i) in row.orders.filter(o => o.type === 'SELL')"
                        :key="`s${i}`">
                        <td :class="$style.detailNumCol">{{ fixed2(o.price) }}</td>
                        <td :class="$style.detailNumCol">{{ formatNumber(o.amount) }}</td>
                        <td :class="$style.locCell">
                          <span v-if="o.location" :class="$style.locationChipSm">
                            {{ o.location }}
                          </span>
                          <span v-else :class="$style.muted">—</span>
                        </td>
                        <td>{{ o.publisher }}</td>
                        <td :class="$style.actionCol">
                          <PrunButton primary inline @click.stop="openClaim(o, row.ticker)">
                            接取
                          </PrunButton>
                        </td>
                      </tr>
                      <tr v-if="row.orders.filter(o => o.type === 'SELL').length === 0">
                        <td colspan="5" :class="$style.empty">暂无卖单</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </template>

    <!-- 独立 Modal overlay：市场接取入口 -->
    <TradeOverlay
      v-if="tradePrefill"
      :task-id="tradePrefill.taskId"
      :ticker="tradePrefill.ticker"
      :side="tradePrefill.side"
      :max-amount="tradePrefill.maxAmount"
      :price="tradePrefill.price"
      :currency="tradePrefill.currency"
      :location="tradePrefill.location"
      :publisher="tradePrefill.publisher"
      @close="closeTrade"
      @claimed="onTradeClaimed" />
  </div>
</template>

<style module>
.market {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 4px 0;
}
.info {
  padding: 16px;
  color: var(--text-muted);
  text-align: center;
}
.error {
  padding: 16px;
  color: var(--text-negative);
  text-align: center;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.table th,
.table td {
  padding: 4px 8px;
  text-align: left;
  vertical-align: middle;
  white-space: nowrap;
  border-bottom: 1px solid var(--panel-border);
}
.table th {
  color: rgb(200, 208, 214);
  font-weight: normal;
  background: var(--panel-background-alt);
}

.row {
  cursor: pointer;
}
.row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.expandCol {
  width: 24px;
  text-align: center;
}
.expand {
  text-align: center;
  font-family: monospace;
  user-select: none;
}

.materialCol {
  width: 30%;
  min-width: 160px;
}
.materialCell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.materialName {
  color: rgb(226, 230, 233);
}

.marketCol {
  width: 20%;
  min-width: 150px;
}
.marketCell {
  padding: 2px 6px;
  border-left: 2px solid rgb(46, 56, 64);
}
.marketCellBuy {
  background: rgba(129, 199, 132, 0.08);
  border-left-color: rgb(129, 199, 132);
}
.marketCellSell {
  background: rgba(229, 115, 115, 0.08);
  border-left-color: rgb(229, 115, 115);
}
.marketPrice {
  color: rgb(226, 230, 233);
  font-variant-numeric: tabular-nums;
}
.marketQty {
  color: rgb(148, 158, 166);
  font-size: 11px;
  margin-left: 4px;
  font-variant-numeric: tabular-nums;
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
  margin-right: 4px;
  vertical-align: middle;
}
.buyBadge {
  background: rgb(129, 199, 132);
  color: rgb(26, 33, 38);
}
.sellBadge {
  background: rgb(229, 115, 115);
  color: rgb(255, 255, 255);
}

.numCol {
  width: 80px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.muted {
  color: rgb(148, 158, 166);
}

.detailRow > td {
  padding: 0;
  background: var(--panel-background-alt);
}
.detailCell {
  padding: 8px 12px;
}
.locationBar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  margin-bottom: 6px;
  border: 1px solid rgb(61, 74, 84);
  background: rgb(26, 33, 38);
}
.locationLabel {
  color: rgb(167, 176, 183);
  font-size: 11px;
  font-weight: 600;
}
.locationChip {
  display: inline-block;
  padding: 1px 8px;
  border-radius: 8px;
  background: rgba(255, 176, 0, 0.18);
  color: rgb(255, 200, 64);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.locationChipSm {
  display: inline-block;
  padding: 0 6px;
  border-radius: 6px;
  background: rgba(255, 176, 0, 0.12);
  color: rgb(255, 200, 64);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.actionBar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 4px 8px;
  margin-bottom: 8px;
  border-bottom: 1px solid rgb(46, 56, 64);
}
.detailGrid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.detailPane {
  border: 1px solid rgb(61, 74, 84);
  background: rgb(26, 33, 38);
}
.detailHeader {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-weight: 600;
  border-bottom: 1px solid rgb(46, 56, 64);
}
.detailHeaderBuy {
  background: rgba(129, 199, 132, 0.08);
}
.detailHeaderSell {
  background: rgba(229, 115, 115, 0.08);
}
.detailTable {
  width: 100%;
  border-collapse: collapse;
}
.detailTable th,
.detailTable td {
  padding: 2px 6px;
  font-size: 11px;
  border-bottom: 1px solid rgb(46, 56, 64);
}
.detailTable th {
  color: rgb(167, 176, 183);
  font-weight: normal;
  text-align: left;
}
.detailNumCol {
  text-align: right;
  font-variant-numeric: tabular-nums;
  width: 70px;
}
.actionCol {
  text-align: right;
  width: 70px;
}
.locCell {
  white-space: normal;
}
.empty {
  text-align: center;
  color: rgb(148, 158, 166);
  padding: 4px;
}
</style>
