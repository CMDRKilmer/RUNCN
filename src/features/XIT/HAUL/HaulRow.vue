<script setup lang="ts">
import { computed } from 'vue';
import ContractLink from '@src/features/XIT/CONTS/ContractLink.vue';
import PartnerLink from '@src/features/XIT/CONTS/PartnerLink.vue';
import ProgressBarWithText from '@src/components/ProgressBarWithText.vue';
import {
  formatAmount,
  getStatusText,
  getStatusClass,
  calculateProgress,
} from '@src/features/XIT/CONTS/utils';
import $style from '../CONTS/conts-shared.module.css';

const { contract } = defineProps<{
  contract: PrunApi.Contract;
  type: 'carrier' | 'shipper';
}>();

// 格式化地址
function formatAddress(address?: PrunApi.Address): string {
  if (!address?.lines) return '-';
  const parts: string[] = [];
  for (const line of address.lines) {
    if (line.entity) {
      parts.push(line.entity.name);
    }
  }
  return parts.join(' / ') || '-';
}

// 提取起点地址（从 PICKUP_SHIPMENT/PROVISION_SHIPMENT 条件）
const origin = computed(() => {
  const pickup = contract.conditions.find(c => c.type === 'PICKUP_SHIPMENT');
  if (pickup?.address) return formatAddress(pickup.address);
  const provision = contract.conditions.find(c => c.type === 'PROVISION_SHIPMENT');
  if (provision?.address) return formatAddress(provision.address);
  return '-';
});

// 提取终点地址（从 DELIVERY_SHIPMENT 条件）
const destination = computed(() => {
  const delivery = contract.conditions.find(c => c.type === 'DELIVERY_SHIPMENT');
  if (delivery?.destination) return formatAddress(delivery.destination);
  if (delivery?.address) return formatAddress(delivery.address);
  return '-';
});

// 货物信息（总重量/总体积）
// 同一批货物会出现在多个条件类型中（PROVISION + DELIVERY 等），只取一种类型累加。
const cargo = computed(() => {
  const types = ['PROVISION_SHIPMENT', 'PICKUP_SHIPMENT', 'DELIVERY_SHIPMENT'] as const;
  for (const type of types) {
    const conds = contract.conditions.filter(
      c => c.type === type && c.weight != null && c.volume != null,
    );
    if (conds.length > 0) {
      let w = 0;
      let v = 0;
      for (const c of conds) {
        w += c.weight!;
        v += c.volume!;
      }
      return `${w.toFixed(2)}t / ${v.toFixed(2)}m³`;
    }
  }
  return '-';
});

// 运费（PAYMENT 条件）
const payment = computed(() => {
  const pay = contract.conditions.find(c => c.type === 'PAYMENT');
  if (!pay?.amount) return '-';
  return formatAmount(pay.amount.amount, pay.amount.currency);
});

// 条件完成进度
const progress = computed(() => calculateProgress(contract));

// 合同状态
const statusText = computed(() => getStatusText(contract.status));
const statusClass = computed(() => $style[getStatusClass(contract.status)]);
</script>

<template>
  <tr>
    <td>
      <ContractLink :contract="contract" />
    </td>
    <td>
      <PartnerLink :contract="contract" />
    </td>
    <td>{{ origin }}</td>
    <td>{{ destination }}</td>
    <td>{{ cargo }}</td>
    <td>{{ payment }}</td>
    <td>
      <ProgressBarWithText
        :current="progress.fulfilled"
        :total="progress.total"
        :show-text="true" />
    </td>
    <td :class="statusClass">{{ statusText }}</td>
  </tr>
</template>
