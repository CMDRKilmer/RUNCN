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

// 货物重量与体积（用于计算单位费率）
const cargoMetrics = computed(() => {
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
      return { weight: w, volume: v };
    }
  }
  return undefined;
});

// 单位费率（每吨/每立方米）
const ratePerT = computed(() => {
  const pay = contract.conditions.find(c => c.type === 'PAYMENT')?.amount;
  const cargo = cargoMetrics.value;
  if (!pay || !cargo || cargo.weight === 0) return undefined;
  return pay.amount / cargo.weight;
});

const ratePerM3 = computed(() => {
  const pay = contract.conditions.find(c => c.type === 'PAYMENT')?.amount;
  const cargo = cargoMetrics.value;
  if (!pay || !cargo || cargo.volume === 0) return undefined;
  return pay.amount / cargo.volume;
});

const rateText = computed(() => {
  const t = ratePerT.value;
  const m = ratePerM3.value;
  if (t === undefined && m === undefined) return '-';
  const parts: string[] = [];
  if (t !== undefined) parts.push(`${t.toFixed(0)}/t`);
  if (m !== undefined) parts.push(`${m.toFixed(0)}/m³`);
  return parts.join(' ');
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
      <PartnerLink :contract="contract" />
    </td>
    <td>{{ origin }}</td>
    <td>{{ destination }}</td>
    <td>{{ cargo }}</td>
    <td>{{ payment }}</td>
    <td>{{ rateText }}</td>
    <td>
      <ProgressBarWithText
        :current="progress.fulfilled"
        :total="progress.total"
        :show-text="true" />
    </td>
    <td :class="statusClass">{{ statusText }}</td>
  </tr>
</template>
