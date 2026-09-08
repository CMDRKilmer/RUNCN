<script setup lang="ts">
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import { getMaterialNameByTicker } from '@src/core/game-lookups';
import { fixed0, fixed2, formatCountdown } from '@src/utils/format';

const FIO = 'https://rest.fnar.net';

// ── FIO 返回类型 ──
interface FioCompany {
  CompanyCode?: string;
  CompanyId?: string;
  CompanyName?: string;
  UserName?: string;
  CountryName?: string;
  CorporationName?: string;
  SubscriptionLevel?: string;
  OverallRating?: string | null;
}

interface FioOrderEntry {
  Count: number;
  Cost: number;
}

interface FioCxTicker {
  Ticker: string;
  Buys?: FioOrderEntry[];
  Sells?: FioOrderEntry[];
}

interface FioCommodityAd {
  PlanetNaturalId?: string;
  PlanetName?: string;
  ContractNaturalId?: number;
  MaterialTicker?: string;
  MaterialName?: string;
  MaterialAmount?: number;
  Price?: number;
  PriceCurrency?: string;
  MinimumRating?: string;
  ExpiryTimeEpochMs?: number;
}

interface FioShippingAd {
  PlanetNaturalId?: string;
  PlanetName?: string;
  ContractNaturalId?: number;
  OriginPlanetName?: string;
  DestinationPlanetName?: string;
  CargoWeight?: number;
  CargoVolume?: number;
  PayoutPrice?: number;
  PayoutCurrency?: string;
  MinimumRating?: string;
  ExpiryTimeEpochMs?: number;
}

interface FioLmData {
  BuyingAds?: FioCommodityAd[];
  SellingAds?: FioCommodityAd[];
  ShippingAds?: FioShippingAd[];
}

// 交易所代码 → 结算货币（交易所币种固定，不与订单数据一起返回）。
const EXCHANGE_CURRENCIES: Record<string, string> = {
  AI1: 'AIC',
  CI1: 'CIS',
  CI2: 'CIS',
  IC1: 'ICA',
  NC1: 'NCC',
  NC2: 'NCC',
};

interface CxRow {
  exchange: string;
  material: string;
  side: 'BUY' | 'SELL';
  count: number;
  cost: number;
  currency: string;
}

interface LmRow {
  kind: '买入' | '卖出' | '运输';
  location: string;
  title: string;
  ticker: string;
  detail: string;
  total: string;
  unit: string;
  rating: string;
  expiry: string;
  planetNaturalId: string;
  adId: number | null;
}

const parameters = useXitParameters();
const query = ref(parameters[0] ?? '');
const loading = ref(false);
const error = ref('');
const result = ref<{ company: FioCompany; cx: FioCxTicker[] | null; lm: FioLmData | null }>();

async function fetchJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url);
  if (response.status === 204) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`FIO HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

async function resolveCompany(input: string): Promise<FioCompany | null> {
  const raw = input.trim();
  // 依次按公司代码（大写）、公司名、用户名解析。FIO /user 端点也返回
  // CompanyCode/CompanyId，可直接复用同一数据结构继续查订单。
  const code = raw.toUpperCase();
  const byCode = await fetchJson<FioCompany>(`${FIO}/company/code/${encodeURIComponent(code)}`);
  if (byCode?.CompanyCode) {
    return byCode;
  }
  const byName = await fetchJson<FioCompany>(`${FIO}/company/name/${encodeURIComponent(raw)}`);
  if (byName?.CompanyCode) {
    return byName;
  }
  const byUser = await fetchJson<FioCompany>(`${FIO}/user/${encodeURIComponent(raw)}`);
  return byUser?.CompanyCode ? byUser : null;
}

async function run() {
  if (loading.value) {
    return;
  }
  const input = query.value.trim();
  if (!input) {
    error.value = '请输入公司代码、名称或用户名。';
    result.value = undefined;
    return;
  }

  loading.value = true;
  error.value = '';
  try {
    const company = await resolveCompany(input);
    if (!company) {
      error.value = `未找到「${input}」（FIO 未收录或输入有误）。`;
      result.value = undefined;
      return;
    }

    const code = company.CompanyCode!;
    const companyId = company.CompanyId ?? company.CompanyName ?? code;
    const [cx, lm] = await Promise.all([
      fetchJson<FioCxTicker[]>(`${FIO}/exchange/orders/${encodeURIComponent(code)}`),
      fetchJson<FioLmData>(`${FIO}/localmarket/company/${encodeURIComponent(companyId)}`),
    ]);
    result.value = { company, cx, lm };
  } catch (e) {
    error.value = `查询失败：${e instanceof Error ? e.message : String(e)}`;
    result.value = undefined;
  } finally {
    loading.value = false;
  }
}

function onEnter() {
  void run();
}

const cxRows = computed<CxRow[] | null>(() => {
  const data = result.value?.cx;
  if (!data) {
    return null;
  }
  const rows: CxRow[] = [];
  for (const item of data) {
    const dot = item.Ticker.lastIndexOf('.');
    const material = dot >= 0 ? item.Ticker.slice(0, dot) : item.Ticker;
    const exchange = dot >= 0 ? item.Ticker.slice(dot + 1) : '';
    const currency = EXCHANGE_CURRENCIES[exchange] ?? '';
    for (const entry of item.Buys ?? []) {
      rows.push({
        exchange,
        material,
        side: 'BUY',
        count: entry.Count,
        cost: entry.Cost,
        currency,
      });
    }
    for (const entry of item.Sells ?? []) {
      rows.push({
        exchange,
        material,
        side: 'SELL',
        count: entry.Count,
        cost: entry.Cost,
        currency,
      });
    }
  }
  rows.sort((a, b) => {
    if (a.exchange !== b.exchange) {
      return a.exchange.localeCompare(b.exchange);
    }
    return a.material.localeCompare(b.material);
  });
  return rows;
});

const cxTotal = computed(() => {
  const rows = cxRows.value;
  if (!rows) {
    return undefined;
  }
  const buyCount = rows.filter(x => x.side === 'BUY').length;
  const sellCount = rows.filter(x => x.side === 'SELL').length;
  return { buyCount, sellCount, count: rows.length };
});

function materialName(ticker: string): string {
  return getMaterialNameByTicker(ticker) ?? ticker;
}

function fmtAmount(value: number): string {
  return Number.isInteger(value) ? fixed0(value) : fixed2(value);
}

function fmtMoney(amount: number, currency: string): string {
  return `${fmtAmount(amount)} ${currency}`;
}

function addCommodityRows(kind: '买入' | '卖出', ads: FioCommodityAd[] | undefined, rows: LmRow[]) {
  for (const ad of ads ?? []) {
    const amount = ad.MaterialAmount ?? 0;
    const price = ad.Price ?? 0;
    const currency = ad.PriceCurrency ?? '';
    const ticker = ad.MaterialTicker ?? '';
    const unit =
      amount > 0 && currency
        ? fmtMoney(price / amount, currency)
        : currency
          ? fmtMoney(price, currency)
          : '--';
    rows.push({
      kind,
      location: ad.PlanetName ?? ad.PlanetNaturalId ?? '--',
      title: materialName(ticker) || ticker || ad.MaterialName || '--',
      ticker,
      detail: amount > 0 ? fmtAmount(amount) : '--',
      total: currency ? fmtMoney(price, currency) : '--',
      unit,
      rating: ad.MinimumRating ?? '--',
      expiry: ad.ExpiryTimeEpochMs !== undefined ? expiryText(ad.ExpiryTimeEpochMs) : '--',
      planetNaturalId: ad.PlanetNaturalId ?? '',
      adId: ad.ContractNaturalId ?? null,
    });
  }
}

function addShippingRows(ads: FioShippingAd[] | undefined, rows: LmRow[]) {
  for (const ad of ads ?? []) {
    const from = ad.OriginPlanetName ?? '?';
    const to = ad.DestinationPlanetName ?? '?';
    const cargo = [ad.CargoWeight ?? 0, ad.CargoVolume ?? 0];
    rows.push({
      kind: '运输',
      location: ad.PlanetName ?? ad.PlanetNaturalId ?? '--',
      title: `${from} → ${to}`,
      ticker: '',
      detail: `重 ${fmtAmount(cargo[0])}t / 容 ${fmtAmount(cargo[1])}m³`,
      total: ad.PayoutCurrency ? fmtMoney(ad.PayoutPrice ?? 0, ad.PayoutCurrency) : '--',
      unit: '--',
      rating: ad.MinimumRating ?? '--',
      expiry: ad.ExpiryTimeEpochMs !== undefined ? expiryText(ad.ExpiryTimeEpochMs) : '--',
      planetNaturalId: ad.PlanetNaturalId ?? '',
      adId: ad.ContractNaturalId ?? null,
    });
  }
}

function openCxob(ticker: string, exchange: string) {
  showBuffer(`CXOB ${ticker}.${exchange}`);
}

function openLm(row: LmRow) {
  // 商品广告打开 LMA {planet}/{naturalId}；运输广告打开 LM {planet}（没有 LMA 单独入口）。
  if (row.planetNaturalId === '') {
    return;
  }
  const cmd =
    row.adId !== null ? `LMA ${row.planetNaturalId}/${row.adId}` : `LM ${row.planetNaturalId}`;
  showBuffer(cmd);
}

function expiryText(ms: number): string {
  const remaining = ms - Date.now();
  return remaining <= 0 ? '已过期' : formatCountdown(remaining);
}

const lmRows = computed<LmRow[] | null>(() => {
  const data = result.value?.lm;
  if (!data) {
    return null;
  }
  const rows: LmRow[] = [];
  addCommodityRows('买入', data.BuyingAds, rows);
  addCommodityRows('卖出', data.SellingAds, rows);
  addShippingRows(data.ShippingAds, rows);
  return rows;
});

const lmTotal = computed(() => {
  const rows = lmRows.value;
  if (!rows) {
    return undefined;
  }
  const buy = rows.filter(x => x.kind === '买入').length;
  const sell = rows.filter(x => x.kind === '卖出').length;
  const ship = rows.filter(x => x.kind === '运输').length;
  return { buy, sell, ship, count: rows.length };
});
</script>

<template>
  <div :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <!-- ═══ 查询栏 ═══ -->
    <div :class="$style.toolbar">
      <input
        v-model="query"
        :class="$style.searchInput"
        type="text"
        placeholder="公司代码 / 名称 / 用户名（如 KI / Kodiak / Xk37）"
        @keyup.enter="onEnter" />
      <PrunButton primary inline :disabled="loading" @click="onEnter">
        {{ loading ? '查询中…' : '查询' }}
      </PrunButton>
      <span :class="$style.hint">数据来自 FIO 社区上传，非游戏实时全量</span>
    </div>

    <LoadingSpinner v-if="loading" />

    <div v-else-if="error" :class="$style.error">{{ error }}</div>

    <div v-else-if="!result" :class="$style.empty">
      输入公司代码 / 名称 / 用户名，查询其在全部交易所（CX）与本地市场（LM）的挂单/广告。
    </div>

    <template v-else>
      <!-- ═══ 公司信息 ═══ -->
      <div :class="$style.companyBar">
        <b>{{ result.company.CompanyName }}</b>
        <span v-if="result.company.CompanyCode">（{{ result.company.CompanyCode }}）</span>
        <span v-if="result.company.UserName"> · 用户 {{ result.company.UserName }}</span>
        <span v-if="result.company.CountryName"> · {{ result.company.CountryName }}</span>
        <span v-if="result.company.CorporationName"> · {{ result.company.CorporationName }} </span>
        <span v-if="result.company.OverallRating"> · 评级 {{ result.company.OverallRating }}</span>
      </div>

      <!-- ═══ CX 挂单 ═══ -->
      <div :class="$style.section">
        <div :class="$style.sectionTitle">
          <b>交易所挂单（CX）</b>
          <span v-if="cxTotal" :class="$style.sectionStat">
            {{ cxTotal.count }} 单（买 {{ cxTotal.buyCount }} / 卖 {{ cxTotal.sellCount }}）
          </span>
        </div>
        <table v-if="cxRows && cxRows.length > 0">
          <thead>
            <tr>
              <th>交易所</th>
              <th>材料</th>
              <th>方向</th>
              <th>数量</th>
              <th>单价</th>
              <th>总额</th>
              <th :class="$style.colAction">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in cxRows" :key="i">
              <td>{{ row.exchange }}</td>
              <td>
                <div :class="$style.materialCell">
                  <span>{{ materialName(row.material) }}</span>
                  <span :class="$style.tickerSmall">{{ row.material }}</span>
                </div>
              </td>
              <td :class="row.side === 'BUY' ? $style.buy : $style.sell">
                {{ row.side === 'BUY' ? '买入' : '卖出' }}
              </td>
              <td :class="$style.number">{{ fmtAmount(row.count) }}</td>
              <td :class="$style.number">{{ fmtMoney(row.cost, row.currency) }}</td>
              <td :class="$style.number">{{ fmtMoney(row.count * row.cost, row.currency) }}</td>
              <td :class="$style.actionCell">
                <PrunButton dark inline @click="openCxob(row.material, row.exchange)">
                  CXOB
                </PrunButton>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else :class="$style.empty">FIO 未收录该公司在交易所的挂单。</div>
      </div>

      <!-- ═══ LM 广告 ═══ -->
      <div :class="$style.section">
        <div :class="$style.sectionTitle">
          <b>本地市场广告（LM）</b>
          <span v-if="lmTotal" :class="$style.sectionStat">
            {{ lmTotal.count }} 条（收 {{ lmTotal.buy }} / 售 {{ lmTotal.sell }} / 运
            {{ lmTotal.ship }}）
          </span>
        </div>
        <table v-if="lmRows && lmRows.length > 0">
          <thead>
            <tr>
              <th>类型</th>
              <th>地点</th>
              <th>材料 / 路线</th>
              <th>数量 / 载货</th>
              <th>总价</th>
              <th>单价</th>
              <th>评级</th>
              <th>剩余</th>
              <th :class="$style.colAction">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, i) in lmRows" :key="i">
              <td
                :class="
                  row.kind === '买入' ? $style.buy : row.kind === '卖出' ? $style.sell : $style.ship
                ">
                {{ row.kind }}
              </td>
              <td>{{ row.location }}</td>
              <td>
                <div :class="$style.materialCell">
                  <span>{{ row.title }}</span>
                  <span v-if="row.ticker" :class="$style.tickerSmall">{{ row.ticker }}</span>
                </div>
              </td>
              <td :class="$style.number">{{ row.detail }}</td>
              <td :class="$style.number">{{ row.total }}</td>
              <td :class="$style.number">{{ row.unit }}</td>
              <td>{{ row.rating }}</td>
              <td :class="$style.number">{{ row.expiry }}</td>
              <td :class="$style.actionCell">
                <PrunButton dark inline :disabled="row.planetNaturalId === ''" @click="openLm(row)">
                  {{ row.adId !== null ? 'LMA' : 'LM' }}
                </PrunButton>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-else :class="$style.empty">FIO 未收录该公司在本地市场的广告。</div>
      </div>
    </template>
  </div>
</template>

<style module>
.container {
  padding: 4px;
  box-sizing: border-box;
  overflow: auto;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
}

.searchInput {
  background: #1a2632;
  color: #ccc;
  border: 1px solid #2b485a;
  padding: 2px 8px;
  font-size: 0.9em;
  min-width: 220px;
}

.hint {
  font-size: 0.75em;
  opacity: 0.6;
}

.companyBar {
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  font-size: 0.95em;
}

.section {
  padding: 6px 8px;
}

.section + .section {
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.sectionTitle {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 2px 0 6px;
}

.sectionStat {
  font-size: 0.8em;
  opacity: 0.7;
}

.container table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.9em;
}

.container table th {
  text-align: left;
  opacity: 0.7;
  font-weight: normal;
  padding: 2px 6px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.12);
}

.container table td {
  padding: 2px 6px;
}

.materialCell {
  display: flex;
  flex-direction: column;
  gap: 1px;
  line-height: 1.2;
}

.tickerSmall {
  font-size: 0.75em;
  opacity: 0.55;
  font-family: var(--rp-font-mono, monospace);
}

.colAction {
  width: 80px;
}

.actionCell {
  white-space: nowrap;
}

.number {
  text-align: right;
  white-space: nowrap;
}

.buy {
  color: #5cb85c;
}

.sell {
  color: #d9534f;
}

.ship {
  color: #f0ad4e;
}

.error {
  padding: 12px;
  color: #d9534f;
}

.empty {
  padding: 10px 8px;
  opacity: 0.55;
}
</style>
