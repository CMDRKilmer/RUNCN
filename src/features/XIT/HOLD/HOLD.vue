<script setup lang="ts">
import { computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import PrunLink from '@src/components/PrunLink.vue';
import { corporationHoldingsStore } from '@src/infrastructure/prun-api/data/corporation-holdings';
import { alertsStore } from '@src/infrastructure/prun-api/data/alerts';
import { ddmmyyyy, hhmm, fixed0 } from '@src/utils/format';
import { formatAmount } from '@src/features/XIT/CONTS/utils';
import $style from '../CONTS/conts-shared.module.css';

// ── 持仓 ──────────────────────────────────────────────────────────────────────

const holdings = computed(() => {
  const all = corporationHoldingsStore.all.value;
  if (!all) {
    return undefined;
  }
  return [...all].sort((a, b) => {
    // 主持股优先，其次按账面价值降序。
    if (a.primary !== b.primary) {
      return a.primary ? -1 : 1;
    }
    return b.bookValue.amount - a.bookValue.amount;
  });
});

const holdingsTotal = computed(() => {
  if (!holdings.value) {
    return undefined;
  }
  // 按币种汇总账面价值。
  const byCurrency = new Map<string, number>();
  for (const h of holdings.value) {
    byCurrency.set(
      h.bookValue.currency,
      (byCurrency.get(h.bookValue.currency) ?? 0) + h.bookValue.amount,
    );
  }
  return byCurrency;
});

// ── 股息 ──────────────────────────────────────────────────────────────────────

interface DividendEntry {
  date: number;
  corporationName: string;
  corporationCode?: string;
  amount: number;
  currency: string;
}

const dividends = computed<DividendEntry[] | undefined>(() => {
  const alerts = alertsStore.all.value;
  if (!alerts) {
    return undefined;
  }
  const entries: DividendEntry[] = [];
  for (const alert of alerts) {
    if (alert.type !== 'CORPORATION_SHAREHOLDER_DIVIDEND_RECEIVED') {
      continue;
    }
    const amount = getAlertData(alert, 'quantity') as number | undefined;
    const partner = getAlertData(alert, 'partner') as PrunApi.ContractPartner | undefined;
    entries.push({
      date: alert.time.timestamp,
      corporationName: partner?.name ?? '未知公司',
      corporationCode: partner?.code ?? undefined,
      amount: amount ?? 0,
      currency: partner?.currency?.code ?? '',
    });
  }
  return entries.sort((a, b) => b.date - a.date);
});

const dividendsTotal = computed(() => {
  if (!dividends.value) {
    return undefined;
  }
  const byCurrency = new Map<string, number>();
  for (const d of dividends.value) {
    if (d.currency) {
      byCurrency.set(d.currency, (byCurrency.get(d.currency) ?? 0) + d.amount);
    }
  }
  return byCurrency;
});

function getAlertData(alert: PrunApi.Alert, key: string): unknown {
  return alert.data.find(x => x.key === key)?.value;
}

function formatTotal(byCurrency: Map<string, number> | undefined): string {
  if (!byCurrency || byCurrency.size === 0) {
    return '--';
  }
  const parts: string[] = [];
  for (const [currency, amount] of byCurrency) {
    parts.push(formatAmount(fixed0(amount), currency));
  }
  return parts.join(' | ');
}
</script>

<template>
  <LoadingSpinner v-if="holdings === undefined || dividends === undefined" />
  <div v-else :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <!-- 持仓表 -->
    <table>
      <thead>
        <tr>
          <th colspan="5" :class="$style.sectionHeader">
            🏢 公司持股
            <span :class="$style.summary">合计: {{ formatTotal(holdingsTotal) }}</span>
          </th>
        </tr>
        <tr>
          <th>公司</th>
          <th>代码</th>
          <th>股数</th>
          <th>账面价值</th>
          <th>类型</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="holdings.length === 0">
          <td colspan="5" :class="$style.empty">暂无持股</td>
        </tr>
        <tr v-for="h in holdings" :key="h.corporation.id">
          <td>
            <PrunLink v-if="h.corporation.code" inline :command="`CO ${h.corporation.code}`">
              {{ h.corporation.name }}
            </PrunLink>
            <template v-else>{{ h.corporation.name }}</template>
          </td>
          <td>{{ h.corporation.code ?? '--' }}</td>
          <td>{{ h.shares.toLocaleString() }}</td>
          <td :class="$style.receivable">
            {{ formatAmount(fixed0(h.bookValue.amount), h.bookValue.currency) }}
          </td>
          <td>{{ h.primary ? '主持股' : '普通' }}</td>
        </tr>
      </tbody>
    </table>

    <!-- 股息历史 -->
    <table :class="$style.secondTable">
      <thead>
        <tr>
          <th colspan="4" :class="$style.sectionHeader">
            💰 股息收入
            <span :class="$style.summary">合计: {{ formatTotal(dividendsTotal) }}</span>
          </th>
        </tr>
        <tr>
          <th>日期</th>
          <th>公司</th>
          <th>金额</th>
          <th>代码</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="dividends.length === 0">
          <td colspan="4" :class="$style.empty">暂无股息记录</td>
        </tr>
        <tr v-for="(d, i) in dividends" :key="i">
          <td>{{ ddmmyyyy(d.date) }} {{ hhmm(d.date) }}</td>
          <td>{{ d.corporationName }}</td>
          <td :class="$style.receivable">
            {{
              d.currency ? formatAmount(fixed0(d.amount), d.currency) : d.amount.toLocaleString()
            }}
          </td>
          <td>{{ d.corporationCode ?? '--' }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
