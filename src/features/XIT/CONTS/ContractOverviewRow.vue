<script setup lang="ts">
import ContractLink from '@src/features/XIT/CONTS/ContractLink.vue';
import PartnerLink from '@src/features/XIT/CONTS/PartnerLink.vue';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import ShipmentIcon from '@src/components/ShipmentIcon.vue';
import { isSelfCondition } from '@src/features/XIT/CONTS/utils';
import { objectId } from '@src/utils/object-id';

const { contract } = defineProps<{ contract: PrunApi.Contract }>();

const $style = useCssModule();

// 物品图标列表（小尺寸）
interface ShipmentIconProps {
  type: 'SHIPMENT';
  shipmentId: string;
  fulfilled: boolean;
}

interface MaterialIconProps {
  type: 'MATERIAL';
  ticker: string;
  amount: number;
  fulfilled: boolean;
}

const icons = computed(() => {
  const result: (ShipmentIconProps | MaterialIconProps)[] = [];
  for (const condition of contract.conditions) {
    switch (condition.type) {
      case 'DELIVERY_SHIPMENT': {
        if (isSelfCondition(contract, condition)) {
          result.push({
            type: 'SHIPMENT',
            shipmentId: condition.shipmentItemId!,
            fulfilled: condition.status === 'FULFILLED',
          });
          continue;
        }
        break;
      }
      case 'PROVISION':
      case 'PICKUP_SHIPMENT': {
        continue;
      }
    }

    const quantity = condition.quantity;
    if (!quantity?.material) {
      continue;
    }

    result.push({
      type: 'MATERIAL',
      ticker: quantity.material.ticker,
      amount: quantity.amount,
      fulfilled: condition.status === 'FULFILLED',
    });
  }
  return result;
});

// 待收款（对方需要付给我的）
const receivable = computed(() => {
  let total = 0;
  let currency = '';
  for (const cond of contract.conditions) {
    if (cond.type === 'PAYMENT' && cond.amount && cond.status !== 'FULFILLED') {
      if (cond.party !== contract.party) {
        total += cond.amount.amount;
        if (!currency) currency = cond.amount.currency;
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
        if (!currency) currency = cond.amount.currency;
      }
    }
  }
  return { total, currency };
});

function formatAmount(amount: number, currency: string) {
  if (!currency || amount === 0) return '-';
  return `${amount.toLocaleString()} ${currency}`;
}

// 条件完成进度
const fulfilledCount = computed(
  () => contract.conditions.filter(c => c.status === 'FULFILLED').length,
);
const totalCount = computed(() => contract.conditions.length);
const progress = computed(() => {
  if (totalCount.value === 0) return 0;
  return Math.round((fulfilledCount.value / totalCount.value) * 100);
});

// 合同状态
const statusText = computed(() => {
  switch (contract.status) {
    case 'OPEN':
      return '待接受';
    case 'CLOSED':
      return '进行中';
    case 'FULFILLED':
      return '已完成';
    case 'PARTIALLY_FULFILLED':
      return '部分完成';
    case 'BREACHED':
      return '已违约';
    case 'TERMINATED':
      return '已终止';
    case 'CANCELLED':
      return '已取消';
    case 'REJECTED':
      return '已拒绝';
    case 'DEADLINE_EXCEEDED':
      return '已逾期';
    default:
      return contract.status;
  }
});

const statusClass = computed(() => {
  switch (contract.status) {
    case 'FULFILLED':
      return $style.fulfilled;
    case 'CLOSED':
    case 'PARTIALLY_FULFILLED':
      return $style.active;
    case 'BREACHED':
    case 'TERMINATED':
    case 'DEADLINE_EXCEEDED':
      return $style.failed;
    case 'OPEN':
      return $style.pending;
    default:
      return '';
  }
});

const progressClass = computed(() => {
  if (progress.value >= 100) return $style.fulfilled;
  if (progress.value > 50) return $style.active;
  return $style.pending;
});
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
      <div :class="$style.progressContainer">
        <div :class="$style.progressBar">
          <div :class="[$style.progressFill, progressClass]" :style="{ width: progress + '%' }" />
        </div>
        <span :class="$style.progressText">{{ fulfilledCount }}/{{ totalCount }}</span>
      </div>
    </td>
    <td :class="statusClass">{{ statusText }}</td>
  </tr>
</template>

<style module>
.iconGrid {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: center;
}

.dimmed {
  opacity: 0.3;
  filter: grayscale(0.6);
}

.receivable {
  color: var(--rp-color-green);
  white-space: nowrap;
}

.payable {
  color: var(--rp-color-orange);
  white-space: nowrap;
}

.fulfilled {
  color: var(--rp-color-green);
}

.active {
  color: var(--rp-color-orange);
}

.failed {
  color: var(--rp-color-red);
}

.pending {
  color: var(--rp-color-text);
}

.progressContainer {
  display: flex;
  align-items: center;
  gap: 6px;
}

.progressBar {
  flex: 1;
  height: 6px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  min-width: 40px;
}

.progressFill {
  height: 100%;
  border-radius: 3px;
  background: var(--rp-color-green);
  transition: width 0.3s ease;
}

.progressFill.active {
  background: var(--rp-color-orange);
}

.progressFill.pending {
  background: var(--rp-color-text);
}

.progressText {
  font-size: 11px;
  white-space: nowrap;
}
</style>
