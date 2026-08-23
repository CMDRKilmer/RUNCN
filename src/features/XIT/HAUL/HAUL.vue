<script setup lang="ts">
import { ref, computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import StatusFilter from '@src/components/StatusFilter.vue';
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import HaulRow from '@src/features/XIT/HAUL/HaulRow.vue';
import { isEmpty } from 'ts-extras';
import { isTransportContract, formatAmount } from '@src/features/XIT/CONTS/utils';
import $style from '../CONTS/conts-shared.module.css';

const activeFilters = ref(
  new Set<string>(['OPEN', 'CLOSED', 'PARTIALLY_FULFILLED', 'DEADLINE_EXCEEDED']),
);
const showFilters = ref(true);

// 判断我是否为承运方（我负责提货和交付）
function isCarrier(contract: PrunApi.Contract) {
  // 承运方负责 PICKUP_SHIPMENT 和 DELIVERY_SHIPMENT
  const pickup = contract.conditions.find(c => c.type === 'PICKUP_SHIPMENT');
  if (pickup) {
    return pickup.party === contract.party;
  }
  const delivery = contract.conditions.find(c => c.type === 'DELIVERY_SHIPMENT');
  if (delivery) {
    return delivery.party === contract.party;
  }
  return false;
}

// 所有运输合同（应用状态筛选）
const transportContracts = computed(() =>
  (contractsStore.all.value ?? []).filter(
    c => isTransportContract(c) && activeFilters.value.has(c.status),
  ),
);

// 承运合同（我负责运输）
const carrying = computed(() =>
  transportContracts.value
    .filter(isCarrier)
    .sort((a, b) => (b.date?.timestamp ?? 0) - (a.date?.timestamp ?? 0)),
);

// 委托运输（别人帮我运）
const shipping = computed(() =>
  transportContracts.value
    .filter(c => !isCarrier(c))
    .sort((a, b) => (b.date?.timestamp ?? 0) - (a.date?.timestamp ?? 0)),
);

// 摘要统计
function getTransportSummary(contracts: PrunApi.Contract[]) {
  let totalPayment = 0;
  let currency = '';
  let totalContracts = contracts.length;
  let completedContracts = 0;
  let totalWeight = 0;
  let totalVolume = 0;
  const shipTypes = ['PROVISION_SHIPMENT', 'PICKUP_SHIPMENT', 'DELIVERY_SHIPMENT'] as const;

  for (const contract of contracts) {
    if (contract.status === 'FULFILLED') {
      completedContracts++;
    }
    for (const cond of contract.conditions) {
      if (cond.type === 'PAYMENT' && cond.amount) {
        totalPayment += cond.amount.amount;
        if (!currency) {
          currency = cond.amount.currency;
        }
      }
    }
    // 同一批货物出现在多种条件类型中，只取第一种有数据的类型累加。
    for (const type of shipTypes) {
      const conds = contract.conditions.filter(
        c => c.type === type && c.weight != null && c.volume != null,
      );
      if (conds.length > 0) {
        for (const c of conds) {
          totalWeight += c.weight!;
          totalVolume += c.volume!;
        }
        break;
      }
    }
  }

  return {
    totalPayment,
    currency,
    totalContracts,
    completedContracts,
    totalWeight,
    totalVolume,
    avgRatePerT: totalWeight > 0 ? totalPayment / totalWeight : 0,
    avgRatePerM3: totalVolume > 0 ? totalPayment / totalVolume : 0,
  };
}

const carryingSummary = computed(() => getTransportSummary(carrying.value));
const shippingSummary = computed(() => getTransportSummary(shipping.value));
</script>

<template>
  <LoadingSpinner v-if="!contractsStore.fetched" />
  <div v-else :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <!-- 筛选栏 -->
    <StatusFilter v-model="activeFilters" v-model:show-filters="showFilters" />

    <!-- 承运合同 -->
    <table>
      <thead>
        <tr>
          <th colspan="9" :class="$style.sectionHeader">
            🚀 承运合同
            <span v-if="!isEmpty(carrying)" :class="$style.summary">
              共 {{ carryingSummary.totalContracts }} 单 | 已完成
              {{ carryingSummary.completedContracts }} 单 | 运费合计:
              {{ formatAmount(carryingSummary.totalPayment, carryingSummary.currency) }}
              | {{ carryingSummary.totalWeight.toFixed(2) }}t /
              {{ carryingSummary.totalVolume.toFixed(2) }}m³ | 均:
              {{ carryingSummary.avgRatePerT.toFixed(0) }}/t
            </span>
          </th>
        </tr>
        <tr>
          <th>合同</th>
          <th>对方</th>
          <th>起点</th>
          <th>终点</th>
          <th>货物</th>
          <th>运费</th>
          <th>费率</th>
          <th>进度</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(carrying)">
          <td colspan="9" :class="$style.empty">暂无承运合同</td>
        </tr>
        <template v-else>
          <HaulRow
            v-for="contract in carrying"
            :key="contract.id"
            :contract="contract"
            type="carrier" />
        </template>
      </tbody>
    </table>

    <!-- 委托运输 -->
    <table :class="$style.secondTable">
      <thead>
        <tr>
          <th colspan="9" :class="$style.sectionHeader">
            📦 委托运输
            <span v-if="!isEmpty(shipping)" :class="$style.summary">
              共 {{ shippingSummary.totalContracts }} 单 | 已完成
              {{ shippingSummary.completedContracts }} 单 | 运费合计:
              {{ formatAmount(shippingSummary.totalPayment, shippingSummary.currency) }}
              | {{ shippingSummary.totalWeight.toFixed(2) }}t /
              {{ shippingSummary.totalVolume.toFixed(2) }}m³ | 均:
              {{ shippingSummary.avgRatePerT.toFixed(0) }}/t
            </span>
          </th>
        </tr>
        <tr>
          <th>合同</th>
          <th>对方</th>
          <th>起点</th>
          <th>终点</th>
          <th>货物</th>
          <th>运费</th>
          <th>费率</th>
          <th>进度</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(shipping)">
          <td colspan="9" :class="$style.empty">暂无委托运输</td>
        </tr>
        <template v-else>
          <HaulRow
            v-for="contract in shipping"
            :key="contract.id"
            :contract="contract"
            type="shipper" />
        </template>
      </tbody>
    </table>
  </div>
</template>
