<script setup lang="ts">
// 阶段 4：MarketView 改读 /listings，删除 tasks 摊平逻辑。
//   单个 listing 已经是单商品实体，按 commodity 聚合后展示。
import { computed, inject, onMounted, ref } from 'vue';
import type { OrgListing } from '@src/infrastructure/org-api/types';
import * as listingsApi from '@src/infrastructure/org-api/listings';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getMaterialName, getMaterialCategoryName } from '@src/infrastructure/prun-ui/i18n';
import SectionHeader from '@src/components/SectionHeader.vue';
import PrunButton from '@src/components/PrunButton.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import EmptyState from './EmptyState.vue';
import TradeOverlay from './TradeOverlay.vue';
import { useOrgTileState } from './tile-state';
import { fixed0, fixed2 } from '@src/utils/format';
import { formatNumber } from './utils';

// 单条挂单：来自 /listings 端点（与任务解耦）。
//   remainingAmount 是当前可接取量；amount 是发布时的原始总量。
interface MarketOrder {
  listingId: string;
  publisher: string;
  type: 'BUY' | 'SELL';
  price: number;
  remainingAmount: number;
  currency: string;
  location?: string;
}

interface MaterialRow {
  ticker: string;
  name: string;
  // PrUn 分类（用于顶部工具栏的分类下拉）
  category: string;
  // 同一商品下所有 BUY/SELL 挂单
  orders: MarketOrder[];
  // 该商品所有挂单合并去重后的交货地点
  allLocations: string[];
}

const loading = ref(false);
const error = ref('');
const expanded = ref<Set<string>>(new Set());

// 顶部工具栏状态
const onlyWithListings = ref<boolean>(true); // 默认只显示有挂单的
const searchQuery = ref<string>(''); // 搜索 ticker / name
const selectedCategory = ref<string>('all'); // 分类 id；'all' 表示不过滤

const listings = ref<OrgListing[]>([]);

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    listings.value = await listingsApi.listListings({ limit: 200 });
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

// TradeOverlay 预填：每个挂单行点击「接取」时打开，参数取自该 listing
interface TradePrefill {
  listingId: string;
  ticker: string;
  side: 'BUY' | 'SELL';
  maxAmount: number;
  price: number;
  currency: string;
  location?: string;
  publisher: string;
}
const tradePrefill = ref<TradePrefill | null>(null);

function openClaim(order: MarketOrder, ticker: string) {
  tradePrefill.value = {
    listingId: order.listingId,
    ticker,
    side: order.type,
    maxAmount: order.remainingAmount,
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
  type: 'BUY' | 'SELL' | 'SHIP';
  ticker: string;
  price: number;
  location?: string;
}) => void;
const injectPrefillSet = inject<PrefillSetFn | null>('orgMarketPrefillSet', null);

function goToPublishEmpty() {
  // 顶部"发布挂单"按钮：直接切到发布 tab，不预填任何商品。
  tab.value = 'publish';
}

function goPublish(row: MaterialRow, side: 'BUY' | 'SELL', suggestedPrice: number) {
  tab.value = 'publish';
  injectPrefillSet?.({
    type: side,
    ticker: row.ticker,
    price: suggestedPrice,
    location: row.allLocations[0],
  });
}

// 聚合：以 PrUn 全商品目录（materialsStore.all）为底，按 commodity 摊平挂单。
//   - 有挂单的行：rows.orders 不空，显示价格/量
//   - 无挂单的行：rows.orders = []，模板自动渲染「--」+「暂无挂单」+「去发布」按钮
//   这样市场展示游戏所有可交易商品（按 ticker 升序），玩家一眼能看出"哪些商品还没人挂"。
//
// 排除：resource=true（纯资源类，无市场）；SHIPPING 模板不影响商品列表。
const materialRows = computed<MaterialRow[]>(() => {
  const map = new Map<string, MaterialRow>();
  // 1) 先用 PrUn 全部商品做底（含无挂单的商品）
  for (const material of materialsStore.all.value ?? []) {
    if (material.resource) continue; // 资源类不参与市场
    const ticker = material.ticker;
    if (!ticker) continue;
    map.set(ticker, {
      ticker,
      name: getMaterialName(material) ?? ticker,
      category: material.category ?? '',
      orders: [],
      allLocations: [],
    });
  }
  // 2) 把所有 OPEN 挂单摊到对应商品行
  for (const listing of listings.value) {
    if (listing.status !== 'OPEN') continue;
    if (listing.type !== 'BUY' && listing.type !== 'SELL') continue;
    if (listing.remainingAmount <= 0) continue;
    if (listing.price <= 0) continue;
    const ticker = listing.commodity;
    let row = map.get(ticker);
    if (!row) {
      // listing 引用的商品在 PrUn materialsStore 里找不到（罕见，
      // 比如自定义 ticker）—— 兜底创建行
      const material = materialsStore.getByTicker(ticker);
      row = {
        ticker,
        name: getMaterialName(material) ?? ticker,
        category: material?.category ?? '',
        orders: [],
        allLocations: [],
      };
      map.set(ticker, row);
    }
    row.orders.push({
      listingId: listing.id,
      publisher: listing.publisherUsername,
      type: listing.type,
      price: listing.price,
      remainingAmount: listing.remainingAmount,
      currency: listing.currency,
      location: listing.location,
    });
    if (listing.location && !row.allLocations.includes(listing.location)) {
      row.allLocations.push(listing.location);
    }
  }
  // 挂单排序：BUY 按 price desc，SELL 按 price asc
  for (const row of map.values()) {
    row.orders.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'BUY' ? -1 : 1;
      }
      if (a.type === 'BUY') return b.price - a.price;
      return a.price - b.price;
    });
  }
  return Array.from(map.values()).sort((a, b) => a.ticker.localeCompare(b.ticker));
});

// 分类下拉选项：从 PrUn materialsStore 提取所有出现过的 category。
//   PrUn 的 Material.category 字段存的是 categoryId（hash），分类名通过 getMaterialCategoryName(id)
//   从 PrUn I18N 系统（PrunI18N["MaterialCategory.<key>"]）查本地化字符串。
//   统一用 PrUn 的中文 i18n 机制，与 PrUn 其他面板显示的分类名保持一致。
//
// selectedCategory 存的是"分类 id"（key 稳定）；下拉 option 的 value 也是 id（key=value），
// label 用 getMaterialCategoryName(id) 给用户看（中文）。
const categoryIdToLabel = computed<Map<string, string>>(() => {
  const map = new Map<string, string>();
  for (const m of materialsStore.all.value ?? []) {
    if (m.resource) continue;
    if (!m.category) continue;
    if (map.has(m.category)) continue;
    const label = getMaterialCategoryName(m.category);
    if (label) map.set(m.category, label);
  }
  return map;
});

const availableCategories = computed<Array<{ value: string; label: string }>>(() => {
  const map = categoryIdToLabel.value;
  return [
    { value: 'all', label: '全部' },
    ...Array.from(map.entries())
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([id, label]) => ({ value: id, label })),
  ];
});

// 实际渲染到表格的行：三层过滤 + 排序。
//   1) onlyWithListings：有挂单的行才显示
//   2) searchQuery：ticker / name 不区分大小写包含
//   3) selectedCategory：category 相等
//   排序：有挂单的在前（按 ticker 升序），无挂单的在后（按 ticker 升序）。
//   这样玩家取消"有挂单"过滤时，市场里"真东西"在前面、"空位"在后面。
const displayRows = computed<MaterialRow[]>(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const cat = selectedCategory.value;
  const rows = materialRows.value.filter(r => {
    if (onlyWithListings.value && r.orders.length === 0) return false;
    // 分类过滤：selectedCategory 是分类 id（'all' 表示不过滤）
    if (cat !== 'all' && r.category !== cat) return false;
    if (q) {
      const hay = `${r.ticker} ${r.name}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return rows.sort((a, b) => {
    // 有挂单的优先（按 ticker 升序）
    if (a.orders.length > 0 && b.orders.length === 0) return -1;
    if (a.orders.length === 0 && b.orders.length > 0) return 1;
    return a.ticker.localeCompare(b.ticker);
  });
});

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
  return orders.filter(o => o.type === type).reduce((s, o) => s + o.remainingAmount, 0);
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
    <!-- 标题行 -->
    <div :class="$style.toolbarTop">
      <SectionHeader>市场</SectionHeader>
      <div :class="$style.toolbarRight">
        <label :class="$style.checkboxLabel">
          <input v-model="onlyWithListings" type="checkbox" />
          有挂单
        </label>
        <PrunButton primary inline @click="goToPublishEmpty">发布挂单</PrunButton>
      </div>
    </div>

    <!-- 过滤行：搜索 + 分类 -->
    <div :class="$style.toolbarFilter">
      <input
        v-model="searchQuery"
        type="text"
        placeholder="搜索商品 (ticker / 名称)"
        :class="$style.searchInput" />
      <SelectInput
        v-model="selectedCategory"
        :options="availableCategories"
        :class="$style.categorySelect" />
    </div>

    <div v-if="loading" :class="$style.info">加载中...</div>
    <div v-else-if="error" :class="$style.error">{{ error }}</div>
    <template v-else-if="materialRows.length === 0">
      <EmptyState message="市场商品目录暂未加载（PrUn 仍在拉取 WORLD_MATERIAL_CATEGORIES）" />
    </template>
    <template v-else-if="displayRows.length === 0">
      <EmptyState message="无匹配商品——调整搜索 / 分类，或取消「有挂单」过滤" />
    </template>
    <template v-else>
      <table :class="$style.table">
        <thead>
          <tr>
            <th :class="$style.materialCol">商品</th>
            <th :class="$style.marketCol">最高买价</th>
            <th :class="$style.marketCol">最低卖价</th>
            <th :class="$style.numCol">买单量</th>
            <th :class="$style.numCol">卖单量</th>
          </tr>
        </thead>
        <tbody v-for="row in displayRows" :key="row.ticker">
          <tr :class="$style.row" @click="toggle(row.ticker)">
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
                <span :class="$style.marketQty">
                  ×{{ fixed0(bestBid(row.orders)!.remainingAmount) }}
                </span>
              </template>
              <span v-else :class="$style.muted">--</span>
            </td>
            <td :class="[$style.marketCell, $style.marketCellSell]">
              <template v-if="bestAsk(row.orders)">
                <span :class="[$style.marketBadge, $style.sellBadge]">卖</span>
                <span :class="$style.marketPrice">
                  {{ fixed2(bestAsk(row.orders)!.price) }}
                </span>
                <span :class="$style.marketQty">
                  ×{{ fixed0(bestAsk(row.orders)!.remainingAmount) }}
                </span>
              </template>
              <span v-else :class="$style.muted">--</span>
            </td>
            <td :class="$style.numCell">{{ fixed0(totalAmount(row.orders, 'BUY')) }}</td>
            <td :class="$style.numCell">{{ fixed0(totalAmount(row.orders, 'SELL')) }}</td>
          </tr>
          <tr v-if="expanded.has(row.ticker)" :class="$style.detailRow">
            <td colspan="5" :class="$style.detailCell">
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
                        <td :class="$style.detailNumCol">{{ formatNumber(o.remainingAmount) }}</td>
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
                        <td :class="$style.detailNumCol">{{ formatNumber(o.remainingAmount) }}</td>
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
      :listing-id="tradePrefill.listingId"
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

/* 顶部工具栏 */
.toolbarTop {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.toolbarRight {
  display: flex;
  align-items: center;
  gap: 12px;
}
.checkboxLabel {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--rp-color-text-component, #bbb);
  cursor: pointer;
  user-select: none;
}
.checkboxLabel input {
  margin: 0;
  cursor: pointer;
}
.toolbarFilter {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0 8px 0;
}
.searchInput {
  flex: 1;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: var(--rp-color-text-component, #bbb);
  padding: 6px 10px;
  border-radius: 2px;
  font-size: 13px;
  outline: none;
}
.searchInput:focus {
  border-color: var(--rp-color-accent-primary, #ffc856);
}
.searchInput::placeholder {
  color: var(--rp-color-text, #999);
}
.categorySelect {
  min-width: 220px;
}
.info {
  padding: 16px;
  color: var(--rp-color-text, #999);
  text-align: center;
}
.error {
  padding: 16px;
  color: var(--rp-color-red, #d9534f);
  text-align: center;
}

.table {
  border-collapse: collapse;
  font-size: 12px;
  table-layout: fixed;
}
.table th,
.table td {
  padding: 4px 8px;
  text-align: left;
  vertical-align: middle;
  white-space: nowrap;
  border-bottom: 1px solid var(--panel-border);
  box-sizing: border-box;
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

.colMaterial {
  width: 180px;
}
.colMarket {
  width: 180px;
}
.colNum {
  width: 90px;
}

.materialCol,
.materialCell {
  width: 180px;
  min-width: 180px;
}
.materialCell {
  display: flex;
  align-items: center;
  gap: 8px;
}
.materialName {
  color: rgb(226, 230, 233);
}

.marketCol,
.marketCell {
  width: 180px;
  min-width: 180px;
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

.numCol,
.numCell {
  width: 90px;
  min-width: 90px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.muted {
  color: rgb(148, 158, 166);
}

.detailRow > td {
  padding: 0;
  background: var(--panel-background-alt);
  width: 720px;
  min-width: 720px;
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
