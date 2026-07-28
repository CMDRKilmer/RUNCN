<script setup lang="ts">
// 阶段 4：TradeOverlay 改打 /listings/:id/claim 端点。
//   接取挂单：扣 listing.remaining_amount + 创建一个独立 task（AWAITING_CONTRACT）。
//   amount 是接取量（≤ remainingAmount）；部分接取也走同一端点。

import { computed, ref, watch } from 'vue';
import * as listingsApi from '@src/infrastructure/org-api/listings';
import { HttpError } from '@src/infrastructure/org-api/client';
import { getMaterialName } from '@src/infrastructure/prun-ui/i18n';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import Header from '@src/components/Header.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import ActionBar from '@src/components/ActionBar.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Active from '@src/components/forms/Active.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import { fixed2 } from '@src/utils/format';

type Side = 'BUY' | 'SELL';

const props = defineProps<{
  // 目标挂单 ID
  listingId: string;
  ticker: string;
  // 挂单剩余可接取量（接取量必须 ≤ 此值）
  maxAmount: number;
  // 挂单单价 / 货币 / 交货地点（仅展示）
  price: number;
  currency: string;
  location?: string;
  // 挂单类型：B 接取表示我要卖给发布者；S 接取表示我要从发布者处买
  side: Side;
  // 发布者用户名（展示）
  publisher: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  // 接取成功后让 MarketView 刷新（挂单从 OPEN → 扣 remaining / CLOSED）
  (e: 'claimed'): void;
}>();

const material = computed(() => materialsStore.getByTicker(props.ticker));
const materialName = computed(() => getMaterialName(material.value) ?? props.ticker);

// 接取数量：默认 = 挂单 remainingAmount
const amount = ref<number>(props.maxAmount);
const error = ref('');
const loading = ref(false);
const claimedTaskId = ref<string | null>(null);

const canSubmit = computed(() => {
  if (loading.value) return false;
  if (!Number.isFinite(amount.value) || (amount.value ?? 0) <= 0) return false;
  if ((amount.value ?? 0) > props.maxAmount) return false;
  return true;
});

watch(
  () => props.maxAmount,
  v => {
    amount.value = v;
  },
);

const totalCost = computed(() => {
  const amt = amount.value ?? 0;
  const pr = props.price;
  if (!Number.isFinite(amt) || !Number.isFinite(pr)) return 0;
  return amt * pr;
});

function inc(delta: number) {
  const current = Number.isFinite(amount.value) ? (amount.value ?? 0) : 0;
  const next = current + delta;
  if (next < 1) {
    amount.value = 1;
    return;
  }
  if (next > props.maxAmount) {
    amount.value = props.maxAmount;
    return;
  }
  amount.value = next;
}

async function onClaim() {
  if (!canSubmit.value) return;
  loading.value = true;
  error.value = '';
  try {
    // claimListing 返回 { task, listing }：
    //   task 是新建的反向合同载体（AWAITING_CONTRACT）
    //   listing 扣 remaining 后的最新快照
    const result = await listingsApi.claimListing(props.listingId, amount.value);
    claimedTaskId.value = result.task.id;
    emit('claimed');
  } catch (err) {
    error.value = err instanceof HttpError ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

function onClose() {
  emit('close');
}
</script>

<template>
  <div :class="$style.overlay" @click.self="onClose">
    <div :class="[C.DraftConditionEditor.form, C.fonts.fontRegular, $style.card]">
      <Header>{{ side === 'SELL' ? '市场接取 · 买' : '市场接取 · 卖' }}</Header>

      <!-- 上下文：商品 + 原任务 -->
      <div :class="$style.context">
        <MaterialIcon :ticker="ticker" size="medium" />
        <div :class="$style.contextText">
          <div :class="$style.materialName">{{ materialName }}（{{ ticker }}）</div>
          <div :class="$style.taskMeta">
            发布者：<strong>{{ publisher }}</strong> · 单价 <strong>{{ fixed2(price) }}</strong>
            {{ currency }}
          </div>
          <div v-if="location" :class="$style.taskLocation">交货地点：{{ location }}</div>
        </div>
      </div>

      <SectionHeader>接取数量</SectionHeader>
      <div :class="$style.form">
        <!--
          数量自定义控件：NumberInput + ± 按钮组。
          - 上限是原任务 amount（裁剪）
          - 默认填满（接取全部）
        -->
        <Active label="接取数量">
          <div :class="$style.qty">
            <button :class="$style.qtyBtn" type="button" @click="inc(-100)">−100</button>
            <button :class="$style.qtyBtn" type="button" @click="inc(-10)">−10</button>
            <button :class="$style.qtyBtn" type="button" @click="inc(-1)">−1</button>
            <NumberInput v-model="amount" :min="1" :max="maxAmount" />
            <button :class="$style.qtyBtn" type="button" @click="inc(1)">+1</button>
            <button :class="$style.qtyBtn" type="button" @click="inc(10)">+10</button>
            <button :class="$style.qtyBtn" type="button" @click="inc(100)">+100</button>
            <button :class="$style.qtyBtn" type="button" @click="amount = maxAmount">MAX</button>
          </div>
          <div :class="$style.qtyHint">
            挂单剩余可接取量：<strong>{{ maxAmount }}</strong>
            （接取后将扣减挂单剩余量，反向合同的 amount = 接取量）
          </div>
        </Active>

        <div :class="$style.total">
          预估总价：<strong>{{ fixed2(totalCost) }}</strong> {{ currency }}
        </div>

        <div v-if="error" :class="$style.error">{{ error }}</div>

        <div v-if="claimedTaskId" :class="$style.success">
          接取成功，任务 #{{ claimedTaskId }} 已进入「待关联合同」状态。
          <span v-if="amount < maxAmount">挂单剩余 {{ maxAmount - amount }} 仍在市场上。</span>
        </div>

        <ActionBar>
          <PrunButton dark inline type="button" @click="onClose">关闭</PrunButton>
          <PrunButton
            primary
            type="button"
            :disabled="!canSubmit || !!claimedTaskId"
            @click="onClaim">
            {{ loading ? '接取中…' : '接取此任务' }}
          </PrunButton>
        </ActionBar>
      </div>
    </div>
  </div>
</template>

<style module>
.overlay {
  /* position: absolute so the popup is constrained to the closest
     positioned ancestor (ORG window tile frame body), not the viewport. */
  position: absolute;
  inset: 0;
  z-index: 1200;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  /* Prevent the dim overlay from scrolling with the underlying list. */
  overflow: auto;
}
.card {
  width: 100%;
  max-width: 480px;
  padding: 16px 20px 20px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.6);
}
.context {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--panel-background-alt);
  border: 1px solid var(--panel-border);
  margin: 8px 0 4px;
}
.contextText {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.materialName {
  color: rgb(226, 230, 233);
  font-weight: 600;
}
.taskMeta {
  color: rgb(167, 176, 183);
  font-size: 11px;
}
.taskMeta strong {
  color: rgb(255, 200, 64);
  font-variant-numeric: tabular-nums;
}
.taskLocation {
  color: rgb(167, 176, 183);
  font-size: 11px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 6px;
}
.qty {
  display: flex;
  align-items: stretch;
  gap: 2px;
}
.qtyBtn {
  padding: 0 8px;
  border: 1px solid rgb(61, 74, 84);
  background: rgb(26, 33, 38);
  color: rgb(226, 230, 233);
  cursor: pointer;
  font: inherit;
  font-size: 11px;
}
.qtyBtn:hover {
  border-color: rgb(255, 176, 0);
}
.qtyHint {
  font-size: 11px;
  color: rgb(148, 158, 166);
  margin-top: 4px;
}
.qtyHint strong {
  color: rgb(255, 200, 64);
  font-variant-numeric: tabular-nums;
}
.total {
  font-size: 12px;
  color: rgb(200, 208, 214);
  padding: 4px 0;
}
.total strong {
  color: rgb(255, 200, 64);
  font-variant-numeric: tabular-nums;
}
.error {
  color: var(--text-negative);
  font-size: 12px;
  padding: 4px 0;
}
.success {
  color: var(--text-positive, #5cb85c);
  font-size: 12px;
  padding: 4px 0;
}
</style>
