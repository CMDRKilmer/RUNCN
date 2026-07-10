<script setup lang="ts">
import { computed } from 'vue';
import ContractLink from '@src/features/XIT/CONTS/ContractLink.vue';
import PartnerLink from '@src/features/XIT/CONTS/PartnerLink.vue';
import ProgressBarWithText from '@src/components/ProgressBarWithText.vue';
import { formatAmount, getStatusText, getStatusClass } from '@src/features/XIT/CONTS/utils';
import $style from '../CONTS/conts-shared.module.css';

const { contract } = defineProps<{
  contract: PrunApi.Contract;
  type: 'borrow' | 'lend';
}>();

// 贷款发放条件
const payoutCondition = computed(() => contract.conditions.find(c => c.type === 'LOAN_PAYOUT'));

// 所有分期还款条件
const installments = computed(() => contract.conditions.filter(c => c.type === 'LOAN_INSTALLMENT'));

// 本金金额
const principal = computed(() => {
  const payout = payoutCondition.value;
  if (!payout?.amount) return '';
  return formatAmount(payout.amount.amount, payout.amount.currency);
});

// 每期利息（取第一个分期的利息信息）
const interest = computed(() => {
  const first = installments.value[0];
  if (!first?.interest) return '-';
  return formatAmount(first.interest.amount, first.interest.currency);
});

// 已完成的分期数
const fulfilledCount = computed(
  () => installments.value.filter(c => c.status === 'FULFILLED').length,
);

// 总分期数
const totalCount = computed(() => installments.value.length);

// 合同状态
const statusText = computed(() => getStatusText(contract.status));
const statusClass = computed(() => getStatusClass(contract.status));

// 格式化日期函数
function formatDate(item: { timestamp: number }): string {
  let timestamp = item.timestamp;
  // 检测时间戳格式
  if (timestamp < 1e12) {
    timestamp *= 1000;
  }

  const now = Date.now();
  const diff = timestamp - now;

  // 处理过期情况
  if (diff < 0) {
    return '已过期';
  }

  // 计算时间差
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  // 根据时间差选择合适的格式
  if (days > 0) {
    const remainingHours = hours % 24;
    return `${days}天${remainingHours}小时`;
  } else if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}小时${remainingMinutes}分钟`;
  } else if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}分钟${remainingSeconds}秒`;
  } else {
    return `${seconds}秒`;
  }
}

// 下次还款/收款时间
const nextPaymentTime = computed(() => {
  // 找到第一个未完成的分期
  const nextInstallment = installments.value.find(c => c.status !== 'FULFILLED');
  if (!nextInstallment?.deadline) return '-';
  return formatDate(nextInstallment.deadline);
});

// 下次还款/收款金额
const nextPaymentAmount = computed(() => {
  const nextInstallment = installments.value.find(c => c.status !== 'FULFILLED');
  if (!nextInstallment?.repayment || !nextInstallment?.interest) return '-';
  const totalAmount = nextInstallment.repayment.amount + nextInstallment.interest.amount;
  return formatAmount(totalAmount, nextInstallment.repayment.currency);
});
</script>

<template>
  <tr>
    <td>
      <ContractLink :contract="contract" />
    </td>
    <td>
      <PartnerLink :contract="contract" />
    </td>
    <td>{{ principal }}</td>
    <td>{{ interest }}</td>
    <td>
      <div>
        <div>{{ nextPaymentTime }}</div>
        <div :class="$style.nextPaymentAmount">{{ nextPaymentAmount }}</div>
      </div>
    </td>
    <td>
      <ProgressBarWithText :current="fulfilledCount" :total="totalCount" :show-text="true" />
    </td>
    <td :class="statusClass">{{ statusText }}</td>
  </tr>
</template>
