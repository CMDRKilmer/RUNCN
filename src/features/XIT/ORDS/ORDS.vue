<script setup lang="ts">
import { computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { cxosStore } from '@src/infrastructure/prun-api/data/cxos';
import { fxosStore } from '@src/infrastructure/prun-api/data/fxos';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { fixed0, fixed2, fixed4, hhmm } from '@src/utils/format';
import { isEmpty } from 'ts-extras';
import $style from '../CONTS/conts-shared.module.css';

// 仅展示未完全成交的订单
const activeCxOrders = computed(() =>
  (cxosStore.all.value ?? []).filter(o => o.status !== 'FILLED'),
);
const activeFxOrders = computed(() =>
  (fxosStore.all.value ?? []).filter(o => o.status !== 'FILLED'),
);

const cxBuys = computed(() => activeCxOrders.value.filter(o => o.type === 'BUYING'));
const cxSells = computed(() => activeCxOrders.value.filter(o => o.type === 'SELLING'));
const fxBuys = computed(() => activeFxOrders.value.filter(o => o.type === 'BUYING'));
const fxSells = computed(() => activeFxOrders.value.filter(o => o.type === 'SELLING'));

// CX 订单统计：买入锁定现金 = amount * limit；卖出锁定货物，潜在收入 = amount * limit
const cxBuyLocked = computed(() => {
  const byCur = new Map<string, number>();
  for (const o of cxBuys.value) {
    const cur = o.limit.currency;
    byCur.set(cur, (byCur.get(cur) ?? 0) + o.amount * o.limit.amount);
  }
  return byCur;
});

const cxSellProceeds = computed(() => {
  const byCur = new Map<string, number>();
  for (const o of cxSells.value) {
    const cur = o.limit.currency;
    byCur.set(cur, (byCur.get(cur) ?? 0) + o.amount * o.limit.amount);
  }
  return byCur;
});

// FX 订单统计：买入时付出 quote = amount * rate；卖出时收入 quote = amount * rate
const fxBuyLocked = computed(() => {
  const byCur = new Map<string, number>();
  for (const o of fxBuys.value) {
    const cur = o.limit.quote;
    byCur.set(cur, (byCur.get(cur) ?? 0) + o.amount.amount * o.limit.rate);
  }
  return byCur;
});

const fxSellProceeds = computed(() => {
  const byCur = new Map<string, number>();
  for (const o of fxSells.value) {
    const cur = o.limit.quote;
    byCur.set(cur, (byCur.get(cur) ?? 0) + o.amount.amount * o.limit.rate);
  }
  return byCur;
});

function formatMap(m: Map<string, number>) {
  if (m.size === 0) return '--';
  return Array.from(m.entries())
    .map(([cur, val]) => `${fixed0(val)} ${cur}`)
    .join(' | ');
}

function progress(order: { amount: number; initialAmount: number }) {
  if (order.initialAmount <= 0) return 0;
  return (order.initialAmount - order.amount) / order.initialAmount;
}

function progressClass(p: number) {
  if (p >= 0.5) return C.ColoredValue.positive;
  if (p > 0) return C.ColoredValue.negative;
  return '';
}

function statusText(s: PrunApi.CXOrderStatus) {
  return s === 'PARTIALLY_FILLED' ? '部分成交' : '已挂单';
}

function openCxob(material: string, exchange: string) {
  void showBuffer(`CXOB ${material}.${exchange}`);
}

function openCxo(id: string) {
  void showBuffer(`CXO ${id.substring(0, 8)}`);
}

function openFxob(base: string, quote: string) {
  void showBuffer(`FXOB ${base}/${quote}`);
}

function openFxo(id: string) {
  void showBuffer(`FXO ${id.substring(0, 8)}`);
}
</script>

<template>
  <LoadingSpinner v-if="!cxosStore.fetched || !fxosStore.fetched" />
  <div v-else :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <!-- CX 买入订单 -->
    <table>
      <thead>
        <tr>
          <th colspan="7" :class="$style.sectionHeader">
            📥 CX 买入订单
            <span v-if="!isEmpty(cxBuys)" :class="$style.summary">
              共 {{ cxBuys.length }} 单 | 锁定资金: {{ formatMap(cxBuyLocked) }}
            </span>
          </th>
        </tr>
        <tr>
          <th>物料</th>
          <th>剩余/初始</th>
          <th>进度</th>
          <th>限价</th>
          <th>锁定资金</th>
          <th>状态</th>
          <th>创建</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(cxBuys)">
          <td colspan="7" :class="$style.empty">无在挂买单</td>
        </tr>
        <tr v-for="o in cxBuys" :key="o.id">
          <td>
            <span :class="C.Link.link" @click="openCxob(o.material.ticker, o.exchange.code)">
              {{ o.material.ticker }}.{{ o.exchange.code }}
            </span>
          </td>
          <td :class="C.ComExOrdersTable.number">
            {{ fixed0(o.amount) }} / {{ fixed0(o.initialAmount) }}
          </td>
          <td :class="[C.ComExOrdersTable.number, progressClass(progress(o))]">
            {{ (progress(o) * 100).toFixed(1) }}%
          </td>
          <td :class="C.ComExOrdersTable.number"
            >{{ fixed2(o.limit.amount) }} {{ o.limit.currency }}</td
          >
          <td :class="[$style.payable, C.ComExOrdersTable.number]">
            {{ fixed0(o.amount * o.limit.amount) }} {{ o.limit.currency }}
          </td>
          <td>{{ statusText(o.status) }}</td>
          <td>
            <span :class="C.Link.link" @click="openCxo(o.id)">{{ hhmm(o.created.timestamp) }}</span>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- CX 卖出订单 -->
    <table :class="$style.secondTable">
      <thead>
        <tr>
          <th colspan="7" :class="$style.sectionHeader">
            📤 CX 卖出订单
            <span v-if="!isEmpty(cxSells)" :class="$style.summary">
              共 {{ cxSells.length }} 单 | 潜在收入: {{ formatMap(cxSellProceeds) }}
            </span>
          </th>
        </tr>
        <tr>
          <th>物料</th>
          <th>剩余/初始</th>
          <th>进度</th>
          <th>限价</th>
          <th>潜在收入</th>
          <th>状态</th>
          <th>创建</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(cxSells)">
          <td colspan="7" :class="$style.empty">无在挂卖单</td>
        </tr>
        <tr v-for="o in cxSells" :key="o.id">
          <td>
            <span :class="C.Link.link" @click="openCxob(o.material.ticker, o.exchange.code)">
              {{ o.material.ticker }}.{{ o.exchange.code }}
            </span>
          </td>
          <td :class="C.ComExOrdersTable.number">
            {{ fixed0(o.amount) }} / {{ fixed0(o.initialAmount) }}
          </td>
          <td :class="[C.ComExOrdersTable.number, progressClass(progress(o))]">
            {{ (progress(o) * 100).toFixed(1) }}%
          </td>
          <td :class="C.ComExOrdersTable.number"
            >{{ fixed2(o.limit.amount) }} {{ o.limit.currency }}</td
          >
          <td :class="[$style.receivable, C.ComExOrdersTable.number]">
            {{ fixed0(o.amount * o.limit.amount) }} {{ o.limit.currency }}
          </td>
          <td>{{ statusText(o.status) }}</td>
          <td>
            <span :class="C.Link.link" @click="openCxo(o.id)">{{ hhmm(o.created.timestamp) }}</span>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- FX 买入订单 -->
    <table :class="$style.secondTable">
      <thead>
        <tr>
          <th colspan="7" :class="$style.sectionHeader">
            💱 FX 买入订单
            <span v-if="!isEmpty(fxBuys)" :class="$style.summary">
              共 {{ fxBuys.length }} 单 | 锁定资金: {{ formatMap(fxBuyLocked) }}
            </span>
          </th>
        </tr>
        <tr>
          <th>交易对</th>
          <th>剩余/初始</th>
          <th>进度</th>
          <th>限价</th>
          <th>锁定资金</th>
          <th>状态</th>
          <th>创建</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(fxBuys)">
          <td colspan="7" :class="$style.empty">无在挂买单</td>
        </tr>
        <tr v-for="o in fxBuys" :key="o.id">
          <td>
            <span :class="C.Link.link" @click="openFxob(o.limit.base, o.limit.quote)">
              {{ o.limit.base }}/{{ o.limit.quote }}
            </span>
          </td>
          <td :class="C.ForExOrdersTable.number">
            {{ fixed0(o.amount.amount) }} / {{ fixed0(o.initialAmount.amount) }}
            {{ o.amount.currency }}
          </td>
          <td
            :class="[
              C.ForExOrdersTable.number,
              progressClass(
                progress({ amount: o.amount.amount, initialAmount: o.initialAmount.amount }),
              ),
            ]">
            {{
              (
                progress({ amount: o.amount.amount, initialAmount: o.initialAmount.amount }) * 100
              ).toFixed(1)
            }}%
          </td>
          <td :class="C.ForExOrdersTable.number">{{ fixed4(o.limit.rate) }}</td>
          <td :class="[$style.payable, C.ForExOrdersTable.number]">
            {{ fixed0(o.amount.amount * o.limit.rate) }} {{ o.limit.quote }}
          </td>
          <td>{{ statusText(o.status) }}</td>
          <td>
            <span :class="C.Link.link" @click="openFxo(o.id)">{{ hhmm(o.created.timestamp) }}</span>
          </td>
        </tr>
      </tbody>
    </table>

    <!-- FX 卖出订单 -->
    <table :class="$style.secondTable">
      <thead>
        <tr>
          <th colspan="7" :class="$style.sectionHeader">
            💱 FX 卖出订单
            <span v-if="!isEmpty(fxSells)" :class="$style.summary">
              共 {{ fxSells.length }} 单 | 潜在收入: {{ formatMap(fxSellProceeds) }}
            </span>
          </th>
        </tr>
        <tr>
          <th>交易对</th>
          <th>剩余/初始</th>
          <th>进度</th>
          <th>限价</th>
          <th>潜在收入</th>
          <th>状态</th>
          <th>创建</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(fxSells)">
          <td colspan="7" :class="$style.empty">无在挂卖单</td>
        </tr>
        <tr v-for="o in fxSells" :key="o.id">
          <td>
            <span :class="C.Link.link" @click="openFxob(o.limit.base, o.limit.quote)">
              {{ o.limit.base }}/{{ o.limit.quote }}
            </span>
          </td>
          <td :class="C.ForExOrdersTable.number">
            {{ fixed0(o.amount.amount) }} / {{ fixed0(o.initialAmount.amount) }}
            {{ o.amount.currency }}
          </td>
          <td
            :class="[
              C.ForExOrdersTable.number,
              progressClass(
                progress({ amount: o.amount.amount, initialAmount: o.initialAmount.amount }),
              ),
            ]">
            {{
              (
                progress({ amount: o.amount.amount, initialAmount: o.initialAmount.amount }) * 100
              ).toFixed(1)
            }}%
          </td>
          <td :class="C.ForExOrdersTable.number">{{ fixed4(o.limit.rate) }}</td>
          <td :class="[$style.receivable, C.ForExOrdersTable.number]">
            {{ fixed0(o.amount.amount * o.limit.rate) }} {{ o.limit.quote }}
          </td>
          <td>{{ statusText(o.status) }}</td>
          <td>
            <span :class="C.Link.link" @click="openFxo(o.id)">{{ hhmm(o.created.timestamp) }}</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
