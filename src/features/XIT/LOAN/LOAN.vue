<script setup lang="ts">
import { ref, computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import StatusFilter from '@src/components/StatusFilter.vue';
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import LoanRow from '@src/features/XIT/LOAN/LoanRow.vue';
import { isEmpty } from 'ts-extras';
import { isLoanContract, formatAmount } from '@src/features/XIT/CONTS/utils';
import $style from '../CONTS/conts-shared.module.css';

const activeFilters = ref(
  new Set<string>(['OPEN', 'CLOSED', 'PARTIALLY_FULFILLED', 'DEADLINE_EXCEEDED']),
);
const showFilters = ref(true);

// 判断我是否为借款方（对方发放贷款给我）
function isBorrowing(contract: PrunApi.Contract) {
  const payout = contract.conditions.find(c => c.type === 'LOAN_PAYOUT');
  if (!payout) {
    return false;
  }
  return payout.party !== contract.party;
}

// 所有贷款合同（应用状态筛选）
const loanContracts = computed(() =>
  (contractsStore.all.value ?? []).filter(
    c => isLoanContract(c) && activeFilters.value.has(c.status),
  ),
);

// 借入贷款
const borrowed = computed(() =>
  loanContracts.value
    .filter(isBorrowing)
    .sort((a, b) => (b.date?.timestamp ?? 0) - (a.date?.timestamp ?? 0)),
);

// 放出贷款
const lent = computed(() =>
  loanContracts.value
    .filter(c => !isBorrowing(c))
    .sort((a, b) => (b.date?.timestamp ?? 0) - (a.date?.timestamp ?? 0)),
);

// 获取贷款摘要信息
function getLoanSummary(contracts: PrunApi.Contract[]) {
  let totalPrincipal = 0;
  let totalPaid = 0;
  let remainingInterest = 0;
  let totalInstallments = 0;
  let fulfilledInstallments = 0;
  let currency = '';

  for (const contract of contracts) {
    for (const cond of contract.conditions) {
      if (cond.type === 'LOAN_PAYOUT' && cond.amount) {
        totalPrincipal += cond.amount.amount;
        if (!currency) {
          currency = cond.amount.currency;
        }
      }
      if (cond.type === 'LOAN_INSTALLMENT') {
        totalInstallments++;
        if (cond.status === 'FULFILLED') {
          fulfilledInstallments++;
          if (cond.repayment) {
            totalPaid += cond.repayment.amount;
          }
        } else {
          // 累计未完成期数的剩余利息
          if (cond.interest) {
            remainingInterest += cond.interest.amount;
          }
        }
      }
    }
  }

  // 未还/未收本金 = 原始本金 - 已归还本金
  const remainingPrincipal = totalPrincipal - totalPaid;
  const remainingInstallments = totalInstallments - fulfilledInstallments;
  return {
    totalPrincipal: remainingPrincipal,
    totalInterest: remainingInterest,
    totalInstallments: remainingInstallments,
    fulfilledInstallments,
    currency,
  };
}

const borrowedSummary = computed(() => getLoanSummary(borrowed.value));
const lentSummary = computed(() => getLoanSummary(lent.value));
</script>

<template>
  <LoadingSpinner v-if="!contractsStore.fetched" />
  <div v-else :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <!-- 筛选栏 -->
    <StatusFilter v-model="activeFilters" v-model:show-filters="showFilters" />

    <!-- 借入贷款 -->
    <table>
      <thead>
        <tr>
          <th colspan="7" :class="$style.sectionHeader">
            📥 借入贷款
            <span v-if="!isEmpty(borrowed)" :class="$style.summary">
              未还本金:
              {{ formatAmount(borrowedSummary.totalPrincipal, borrowedSummary.currency) }}
              | 未还利息:
              {{ formatAmount(borrowedSummary.totalInterest, borrowedSummary.currency) }}
              | 已还: {{ borrowedSummary.fulfilledInstallments }} | 剩余:
              {{ borrowedSummary.totalInstallments }} 期
            </span>
          </th>
        </tr>
        <tr>
          <th>合同</th>
          <th>对方</th>
          <th>本金</th>
          <th>利息</th>
          <th>下次还款</th>
          <th>还款进度</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(borrowed)">
          <td colspan="7" :class="$style.empty">暂无借入贷款</td>
        </tr>
        <template v-else>
          <LoanRow
            v-for="contract in borrowed"
            :key="contract.id"
            :contract="contract"
            type="borrow" />
        </template>
      </tbody>
    </table>

    <!-- 放出贷款 -->
    <table :class="$style.secondTable">
      <thead>
        <tr>
          <th colspan="7" :class="$style.sectionHeader">
            📤 放出贷款
            <span v-if="!isEmpty(lent)" :class="$style.summary">
              未收本金:
              {{ formatAmount(lentSummary.totalPrincipal, lentSummary.currency) }}
              | 未收利息:
              {{ formatAmount(lentSummary.totalInterest, lentSummary.currency) }}
              | 已收: {{ lentSummary.fulfilledInstallments }} | 剩余:
              {{ lentSummary.totalInstallments }} 期
            </span>
          </th>
        </tr>
        <tr>
          <th>合同</th>
          <th>对方</th>
          <th>本金</th>
          <th>利息</th>
          <th>下次收款</th>
          <th>回收进度</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(lent)">
          <td colspan="7" :class="$style.empty">暂无放出贷款</td>
        </tr>
        <template v-else>
          <LoanRow v-for="contract in lent" :key="contract.id" :contract="contract" type="lend" />
        </template>
      </tbody>
    </table>
  </div>
</template>
