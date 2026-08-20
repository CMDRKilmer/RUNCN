<script setup lang="ts">
import { ref, computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import StatusFilter from '@src/components/StatusFilter.vue';
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import ContractOverviewRow from '@src/features/XIT/CONTS/ContractOverviewRow.vue';
import { isEmpty } from 'ts-extras';
import {
  calculateContractTotals,
  compareContracts,
  formatAmount,
} from '@src/features/XIT/CONTS/utils';
import { calculateDeadline } from '@src/core/balance/contract-conditions';
import { timestampEachSecond } from '@src/utils/dayjs';
import { formatCountdown } from '@src/utils/format';
import $style from '../CONTS/conts-shared.module.css';

const activeFilters = ref(
  new Set<string>(['OPEN', 'CLOSED', 'PARTIALLY_FULFILLED', 'DEADLINE_EXCEEDED']),
);
const showFilters = ref(true);

const filtered = computed(() =>
  (contractsStore.all.value ?? [])
    .filter(c => activeFilters.value.has(c.status))
    .sort(compareContracts),
);

// 总待收款和应付款统计
const totals = computed(() => calculateContractTotals(filtered.value));

// 计算每个合同最近的截止时间
const contractDeadlines = computed(() => {
  const map = new Map<string, number | undefined>();
  for (const contract of filtered.value) {
    let nearest = Infinity;
    for (const condition of contract.conditions) {
      if (condition.status === 'FULFILLED') {
        continue;
      }
      const deadline = calculateDeadline(contract, condition);
      if (Number.isFinite(deadline) && deadline < nearest) {
        nearest = deadline;
      }
    }
    map.set(contract.id, nearest === Infinity ? undefined : nearest);
  }
  return map;
});

const dayMs = 24 * 60 * 60 * 1000;

function deadlineStyle(ms?: number) {
  if (ms === undefined) {
    return '';
  }
  const remaining = ms - timestampEachSecond.value;
  if (remaining <= 0) {
    return 'color: #d9534f';
  }
  if (remaining <= dayMs * 3) {
    return 'color: #f0ad4e';
  }
  return '';
}

function deadlineText(ms?: number) {
  if (ms === undefined) {
    return '--';
  }
  const remaining = ms - timestampEachSecond.value;
  if (remaining <= 0) {
    return '已过期';
  }
  return formatCountdown(remaining);
}
</script>

<template>
  <LoadingSpinner v-if="!contractsStore.fetched" />
  <div v-else :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <!-- 筛选栏 -->
    <StatusFilter v-model="activeFilters" v-model:show-filters="showFilters" />

    <!-- 汇总栏 -->
    <div v-if="totals.currency" :class="$style.totalsBar">
      <span>共 {{ filtered.length }} 单</span>

      <!-- 混合货币警告 -->
      <span v-if="totals.hasMixedCurrency" :class="$style.warningText">
        检测到不同货币，金额统计可能不准确
      </span>

      <span v-if="totals.receivable > 0" :class="$style.receivableText">
        待收: {{ formatAmount(totals.receivable, totals.currency) }}
      </span>
      <span v-if="totals.payable > 0" :class="$style.payableText">
        应付: {{ formatAmount(totals.payable, totals.currency) }}
      </span>
    </div>

    <table>
      <thead>
        <tr>
          <th>合同</th>
          <th>物品</th>
          <th>对方</th>
          <th>待收款</th>
          <th>应付款</th>
          <th>进度</th>
          <th>状态</th>
          <th>截止</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(filtered)">
          <td colspan="8" :class="$style.empty">没有活动合同</td>
        </tr>
        <template v-else>
          <ContractOverviewRow
            v-for="contract in filtered"
            :key="contract.id"
            :contract="contract"
            :deadline="deadlineText(contractDeadlines.get(contract.id))"
            :deadline-style="deadlineStyle(contractDeadlines.get(contract.id))" />
        </template>
      </tbody>
    </table>
  </div>
</template>
