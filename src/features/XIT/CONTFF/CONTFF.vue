<script setup lang="ts">
import { ref, computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import StatusFilter from '@src/components/StatusFilter.vue';
import ProgressBarWithText from '@src/components/ProgressBarWithText.vue';
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import ContractLink from '@src/features/XIT/CONTS/ContractLink.vue';
import PartnerLink from '@src/features/XIT/CONTS/PartnerLink.vue';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import ShipmentIcon from '@src/components/ShipmentIcon.vue';
import { isEmpty } from 'ts-extras';
import {
  canAcceptContract,
  isFactionContract,
  calculateContractTotals,
  calculateContractReceivable,
  getContractIcons,
  formatAmount,
  calculateProgress,
  getStatusText,
  getStatusClass,
} from '@src/features/XIT/CONTS/utils';
import { timestampEachSecond } from '@src/utils/dayjs';
import { objectId } from '@src/utils/object-id';
import dayjs from 'dayjs';
import '@src/utils/dayjs';
import $style from '../CONTS/conts-shared.module.css';

const activeFilters = ref(
  new Set<string>(['OPEN', 'CLOSED', 'PARTIALLY_FULFILLED', 'DEADLINE_EXCEEDED']),
);
const showFilters = ref(true);

const filtered = computed(() =>
  (contractsStore.all.value ?? [])
    .filter(c => isFactionContract(c))
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

const totals = computed(() => calculateContractTotals(filtered.value));

// 待收款（对方需要付给我的）
function getReceivable(contract: PrunApi.Contract) {
  return calculateContractReceivable(contract);
}

function getDeadline(contract: PrunApi.Contract): string {
  const deadline = contract.dueDate;
  if (!deadline || deadline.timestamp === undefined || deadline.timestamp === null) return '-';
  const remaining = deadline.timestamp - timestampEachSecond.value;
  if (remaining <= 0) return '已逾期';
  const d = dayjs.duration(remaining);
  if (d.days() > 0) return `${d.days()}天 ${d.hours()}小时`;
  if (d.hours() > 0) return `${d.hours()}小时 ${d.minutes()}分钟`;
  return `${d.minutes()}分钟`;
}
</script>

<template>
  <LoadingSpinner v-if="!contractsStore.fetched" />
  <div v-else :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <!-- 筛选栏 -->
    <StatusFilter v-model="activeFilters" v-model:show-filters="showFilters" />

    <div v-if="totals.currency" :class="$style.totalsBar">
      <span>共 {{ filtered.length }} 单</span>

      <!-- 混合货币警告 -->
      <span v-if="totals.hasMixedCurrency" :class="$style.warningText">
        ⚠️ 检测到不同货币，金额统计可能不准确
      </span>

      <span v-if="totals.receivable > 0" :class="$style.receivableText">
        待收: {{ formatAmount(totals.receivable, totals.currency) }}
      </span>
    </div>

    <table>
      <thead>
        <tr>
          <th>合同</th>
          <th>物品</th>
          <th>对方</th>
          <th>待收款</th>
          <th>限期</th>
          <th>进度</th>
          <th>状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(filtered)">
          <td colspan="7" :class="$style.empty">没有活动派系合同</td>
        </tr>
        <template v-else>
          <tr v-for="contract in filtered" :key="contract.id">
            <td>
              <ContractLink :contract="contract" />
            </td>
            <td>
              <div :class="$style.iconGrid">
                <template v-for="icon in getContractIcons(contract)" :key="objectId(icon)">
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
              {{ formatAmount(getReceivable(contract).total, getReceivable(contract).currency) }}
            </td>
            <td :class="$style.deadlineCell">{{ getDeadline(contract) }}</td>
            <td>
              <ProgressBarWithText
                :current="calculateProgress(contract).fulfilled"
                :total="calculateProgress(contract).total"
                :show-text="true" />
            </td>
            <td :class="getStatusClass(contract.status)">
              {{ getStatusText(contract.status) }}
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>
