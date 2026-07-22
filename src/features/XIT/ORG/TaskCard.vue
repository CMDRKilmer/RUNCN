<script setup lang="ts">
import type { OrgTask, OrgUser } from '@src/infrastructure/org-api/types';
import { computed } from 'vue';
import { formatAmountWithCurrency, formatNumber, statusLabel } from './utils';

const props = defineProps<{ task: OrgTask; currentUser: OrgUser | null }>();

const emit = defineEmits<{ (e: 'click', task: OrgTask): void }>();

// 显示用摘要字段
const itemSummary = computed(() => {
  const items = props.task.contractJson.items ?? [];
  if (items.length === 0) {
    return '无物品';
  }
  const head = `${formatNumber(items[0].amount)}× ${items[0].commodity}`;
  const headPrice =
    items[0].price !== undefined
      ? ` @ ${formatAmountWithCurrency(items[0].price, props.task.contractJson.currency)}`
      : '';
  if (items.length === 1) {
    return `${head}${headPrice}`;
  }
  return `${head}${headPrice} 等 ${items.length} 项`;
});

const locationText = computed(() => {
  const c = props.task.contractJson;
  if (props.task.type === 'SHIP') {
    return `${c.origin ?? '?'} → ${c.destination ?? '?'}`;
  }
  return c.location ?? '无位置';
});

const priceText = computed(() => {
  const c = props.task.contractJson;
  if (c.price !== undefined) {
    return formatAmountWithCurrency(c.price, c.currency);
  }
  // 无顶层 price：BUY/SELL 任务按每行价格合计显示；SHIP 任务此时无金额信息。
  const itemsTotal = (c.items ?? []).reduce((sum, i) => sum + (i.price ?? 0) * i.amount, 0);
  return itemsTotal > 0 ? formatAmountWithCurrency(itemsTotal, c.currency) : '—';
});

// 与发布表单对齐：SHIP 任务的 contractJson.price 在卡片上叫"运费"，
// BUY/SELL 任务下叫"总价"。
const priceLabel = computed(() => (props.task.type === 'SHIP' ? '运费' : '总价'));

const expiresText = computed(() => {
  if (!props.task.expiresAt) {
    return '';
  }
  return `有效期至 ${new Date(props.task.expiresAt).toLocaleString()}`;
});

const typeLabel = computed(() => {
  switch (props.task.type) {
    case 'BUY':
      return '采购';
    case 'SELL':
      return '出售';
    case 'SHIP':
      return '运输';
    case 'LOAN':
      return '借贷';
    default:
      return props.task.type;
  }
});

const statusColor = computed(() => {
  switch (props.task.status) {
    case 'PUBLISHED':
      return 'var(--text-muted)';
    case 'AWAITING_CONTRACT':
      return 'var(--text-warning, #f0ad4e)';
    case 'IN_PROGRESS':
      return 'var(--accent)';
    case 'COMPLETED':
      return 'var(--text-positive, #5cb85c)';
    case 'CANCELLED':
      return 'var(--text-negative, #d9534f)';
  }
});
</script>

<template>
  <!--
    用 PrUn 官方 panel / panelHeader 类做卡片质感。
    cursor:pointer 让整张卡可点击，hover 改用 PrUn 的交互色。
  -->
  <div
    :class="[C.DraftConditionEditor.form, C.fonts.fontRegular, $style.card]"
    @click="emit('click', task)">
    <div :class="$style.header">
      <span :class="[$style.type, C.type.typeSmall]">{{ typeLabel }}</span>
      <span :class="$style.status" :style="{ color: statusColor }">{{
        statusLabel(task.status)
      }}</span>
    </div>
    <div :class="$style.title">{{ task.contractJson.name || task.type }}</div>
    <div :class="$style.row">
      <span>物品：{{ itemSummary }}</span>
      <span>{{ priceLabel }}：{{ priceText }}</span>
    </div>
    <div :class="$style.row">
      <span>位置：{{ locationText }}</span>
      <span>发布者：{{ task.publisherUsername }}</span>
    </div>
    <div v-if="expiresText" :class="$style.expires">{{ expiresText }}</div>
  </div>
</template>

<style module>
.card {
  padding: 8px 12px;
  cursor: pointer;
  margin-bottom: 4px;
}
.card:hover {
  background: rgba(255, 255, 255, 0.04);
}
.header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 2px;
}
.type {
  color: var(--accent);
  font-weight: 600;
}
.title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
}
.row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 1px;
}
.expires {
  font-size: 11px;
  color: var(--text-warning, #f0ad4e);
  margin-top: 2px;
}
</style>
