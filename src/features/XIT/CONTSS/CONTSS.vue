<script setup lang="ts">
import { ref, computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import StatusFilter from '@src/components/StatusFilter.vue';
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import ContractOverviewRow from '@src/features/XIT/CONTS/ContractOverviewRow.vue';
import { isEmpty } from 'ts-extras';
import {
  canAcceptContract,
  calculateContractTotals,
  formatAmount,
} from '@src/features/XIT/CONTS/utils';
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

function compareContracts(a: PrunApi.Contract, b: PrunApi.Contract) {
  if (canAcceptContract(a) && !canAcceptContract(b)) {
    return -1;
  }
  if (canAcceptContract(b) && !canAcceptContract(a)) {
    return 1;
  }
  return (b.date?.timestamp ?? 0) - (a.date?.timestamp ?? 0);
}

// 总待收款和应付款统计
const totals = computed(() => calculateContractTotals(filtered.value));
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
        ⚠️ 检测到不同货币，金额统计可能不准确
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
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(filtered)">
          <td colspan="7" :class="$style.empty">没有活动合同</td>
        </tr>
        <template v-else>
          <ContractOverviewRow
            v-for="contract in filtered"
            :key="contract.id"
            :contract="contract" />
        </template>
      </tbody>
    </table>
  </div>
</template>
