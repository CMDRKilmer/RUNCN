<script setup lang="ts">
import ContractLink from '@src/features/XIT/CONTS/ContractLink.vue';
import PartnerLink from '@src/features/XIT/CONTS/PartnerLink.vue';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import ShipmentIcon from '@src/components/ShipmentIcon.vue';
import ProgressBarWithText from '@src/components/ProgressBarWithText.vue';
import {
  getContractIcons,
  getStatusText,
  getStatusClass,
  calculateProgress,
  formatAmount,
} from '@src/features/XIT/CONTS/utils';
import { objectId } from '@src/utils/object-id';
import $style from './conts-shared.module.css';

const { contract, deadline, deadlineStyle } = defineProps<{
  contract: PrunApi.Contract;
  deadline?: string;
  deadlineStyle?: string;
}>();

const icons = computed(() => getContractIcons(contract));

// 待收款（对方需要付给我的）
const receivable = computed(() => {
  let total = 0;
  let currency = '';
  for (const cond of contract.conditions) {
    if (cond.type === 'PAYMENT' && cond.amount && cond.status !== 'FULFILLED') {
      if (cond.party !== contract.party) {
        total += cond.amount.amount;
        if (!currency) {
          currency = cond.amount.currency;
        }
      }
    }
  }
  return { total, currency };
});

// 应付款（我需要付给对方的）
const payable = computed(() => {
  let total = 0;
  let currency = '';
  for (const cond of contract.conditions) {
    if (cond.type === 'PAYMENT' && cond.amount && cond.status !== 'FULFILLED') {
      if (cond.party === contract.party) {
        total += cond.amount.amount;
        if (!currency) {
          currency = cond.amount.currency;
        }
      }
    }
  }
  return { total, currency };
});

// 条件完成进度
const progress = computed(() => calculateProgress(contract));

// 合同状态
const statusText = computed(() => getStatusText(contract.status));
const statusClass = computed(() => getStatusClass(contract.status));
</script>

<template>
  <tr>
    <td>
      <ContractLink :contract="contract" />
    </td>
    <td>
      <div :class="$style.iconGrid">
        <template v-for="icon in icons" :key="objectId(icon)">
          <div :class="[icon.fulfilled && $style.dimmed]">
            <ShipmentIcon
              v-if="icon.type === 'SHIPMENT'"
              size="small"
              :shipment-id="icon.shipmentId" />
            <MaterialIcon
              v-if="icon.type === 'MATERIAL'"
              size="small"
              compact
              :ticker="icon.ticker"
              :amount="icon.amount" />
          </div>
        </template>
      </div>
    </td>
    <td>
      <PartnerLink :contract="contract" />
    </td>
    <td :class="$style.receivable">
      {{ formatAmount(receivable.total, receivable.currency) }}
    </td>
    <td :class="$style.payable">
      {{ formatAmount(payable.total, payable.currency) }}
    </td>
    <td>
      <ProgressBarWithText
        :current="progress.fulfilled"
        :total="progress.total"
        :show-text="true" />
    </td>
    <td :class="statusClass">{{ statusText }}</td>
    <td :style="deadlineStyle">{{ deadline ?? '--' }}</td>
  </tr>
</template>
