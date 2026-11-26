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
import {
  getDepartTargets,
  openSfcAndFill,
  type DepartTarget,
  type ShipmentIndex,
} from '@src/core/contract-shipment';
import { attachFloatingTooltip } from '@src/utils/floating-tooltip';
import $style from './conts-shared.module.css';
import { onBeforeUnmount } from 'vue';

const { contract, deadline, deadlineStyle, shipIndex } = defineProps<{
  contract: PrunApi.Contract;
  deadline?: string;
  deadlineStyle?: string;
  /** 由列表一次性建好的 shipmentItemId → 飞船索引，避免每行都遍历库存 */
  shipIndex?: ShipmentIndex;
}>();

// 「起飞」目标：货运合同装完货后，打开装货那条船的 SFC 并填入卸货地。
// 判定逻辑与原生 CONTS、CONT 详情共用 @src/core/contract-shipment。
//
// 一条合同可能有多条交付条款（不同船、不同批次），必须**全部**渲染：只取 [0] 时，
// 若第一条已在途，总览里就只剩一个灰色的「在途」，后面已就绪的那批点不到 ——
// 原生 CONTS 本来就是每批一个按钮，这里保持一致。
const departTargets = computed(() => getDepartTargets(contract, shipIndex));
const departingKeys = ref<Set<string>>(new Set());

function targetByKey(key: string) {
  return departTargets.value.find(target => target.key === key);
}

// 自动填目的地失败时（SFC 渲染超时 / 选不到地址）把原因顶到提示上，
// 与原生 CONTS、CONT 详情的口径一致；成功一次就清掉。
const departErrors = ref<Map<string, string>>(new Map());

function hintFor(key: string) {
  const error = departErrors.value.get(key);
  return error ?? targetByKey(key)?.hint ?? '';
}

function setDepartError(key: string, message: string | undefined) {
  const next = new Map(departErrors.value);
  if (message === undefined) {
    next.delete(key);
  } else {
    next.set(key, message);
  }
  departErrors.value = next;
}

// 「指令」列贴着磁贴右缘，游戏自带的 data-tooltip（元素上的绝对定位伪元素）
// 会被滚动容器裁掉，这里改用 body 上的 fixed 浮层。
// 每条目标一个按钮，浮层按 key 分别解绑：函数式 ref 在元素卸载时会以 null 回调，
// 正好用来收尾（v-if 摘掉元素不会触发 mouseleave，浮层会一直留在屏幕上）。
//
// 但函数式 ref 在**每次重渲染**都会再回调一次：`XIT CONTSS` 的截止时间每秒更新，
// 行会重新渲染，无条件 detach 会把共享浮层的 hide() 调掉 —— 悬停中的气泡不到 1 秒
// 就消失，且要重新移入才回来。所以只在元素**换人**（或卸载传 null）时才解绑。
const detachTooltips = new Map<string, () => void>();
const boundButtons = new Map<string, HTMLButtonElement>();

function bindDepartButton(el: Element | null, key: string) {
  if (el === boundButtons.get(key)) {
    return; // 同一个按钮重复回调：保持现有绑定，别动浮层
  }
  detachTooltips.get(key)?.();
  detachTooltips.delete(key);
  boundButtons.delete(key);
  if (!(el instanceof HTMLButtonElement)) {
    return;
  }
  boundButtons.set(key, el);
  detachTooltips.set(
    key,
    attachFloatingTooltip(el, () => hintFor(key)),
  );
}

onBeforeUnmount(() => {
  for (const detach of detachTooltips.values()) {
    detach();
  }
  detachTooltips.clear();
  boundButtons.clear();
});

async function onDepart(target: DepartTarget) {
  if (!target.ready || departingKeys.value.has(target.key)) {
    return;
  }
  departingKeys.value = new Set(departingKeys.value).add(target.key);
  try {
    // openSfcAndFill 失败时返回 { ok: false, message } 而不是抛错，不能丢掉：
    // 原生 CONTS / CONT 详情都会把原因顶到按钮提示上，这里保持一致。
    const result = await openSfcAndFill(target);
    setDepartError(target.key, result.ok ? undefined : result.message);
  } finally {
    const next = new Set(departingKeys.value);
    next.delete(target.key);
    departingKeys.value = next;
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
        v-for="target in departTargets"
        :key="target.key"
        :ref="el => bindDepartButton(el as Element | null, target.key)"
        type="button"
        :class="[
          C.Button.btn,
          C.Button.primary,
          target.ready && !departingKeys.has(target.key) ? undefined : C.Button.disabled,
        ]"
        @click="onDepart(target)">
        {{ departingKeys.has(target.key) ? '…' : target.label }}
      </button>
      <span v-if="departTargets.length === 0">--</span>
    </td>
  </tr>
</template>
