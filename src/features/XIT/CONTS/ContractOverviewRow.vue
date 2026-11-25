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
import { getDepartTargets, openSfcAndFill, type ShipmentIndex } from '@src/core/contract-shipment';
import { attachFloatingTooltip } from '@src/utils/floating-tooltip';
import $style from './conts-shared.module.css';
import { onBeforeUnmount, watch } from 'vue';

const { contract, deadline, deadlineStyle, shipIndex } = defineProps<{
  contract: PrunApi.Contract;
  deadline?: string;
  deadlineStyle?: string;
  /** 由列表一次性建好的 shipmentItemId → 飞船索引，避免每行都遍历库存 */
  shipIndex?: ShipmentIndex;
}>();

// 「起飞」目标：货运合同装完货后，打开装货那条船的 SFC 并填入卸货地。
// 判定逻辑与原生 CONTS、CONT 详情共用 @src/core/contract-shipment。
const departTarget = computed(() => getDepartTargets(contract, shipIndex)[0]);
const departing = ref(false);

// 「指令」列贴着磁贴右缘，游戏自带的 data-tooltip（元素上的绝对定位伪元素）
// 会被滚动容器裁掉，这里改用 body 上的 fixed 浮层。
const departButton = ref<HTMLButtonElement>();
let detachTooltip: (() => void) | undefined;
watch(departButton, el => {
  detachTooltip?.();
  detachTooltip = el ? attachFloatingTooltip(el, () => departTarget.value?.hint ?? '') : undefined;
});
onBeforeUnmount(() => detachTooltip?.());

async function onDepart() {
  const target = departTarget.value;
  if (!target?.ready || departing.value) {
    return;
  }
  departing.value = true;
  try {
    await openSfcAndFill(target);
  } finally {
    departing.value = false;
  }
}

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
    <td :class="$style.departCell">
      <button
        v-if="departTarget"
        ref="departButton"
        type="button"
        :class="[
          C.Button.btn,
          C.Button.primary,
          departTarget.ready && !departing ? undefined : C.Button.disabled,
        ]"
        @click="onDepart">
        {{ departing ? '…' : departTarget.label }}
      </button>
      <span v-else>--</span>
    </td>
  </tr>
</template>
