<script setup lang="ts">
import type { OrgTask, OrgUser } from '@src/infrastructure/org-api/types';
import { computed } from 'vue';

const props = defineProps<{ task: OrgTask; currentUser: OrgUser | null }>();

const emit = defineEmits<{ (e: 'click', task: OrgTask): void }>();

// 显示用摘要字段
const itemSummary = computed(() => {
  const items = props.task.contractJson.items ?? [];
  if (items.length === 0) {
    return '无物品';
  }
  if (items.length === 1) {
    return `${items[0].amount}× ${items[0].commodity}`;
  }
  return `${items[0].amount}× ${items[0].commodity} 等 ${items.length} 项`;
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
    return `${c.price} ${c.currency}`;
  }
  const itemsTotal = (c.items ?? []).reduce((sum, i) => sum + (i.price ?? 0) * i.amount, 0);
  return itemsTotal > 0 ? `${itemsTotal} ${c.currency}` : '—';
});

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
  <div :class="$style.card" @click="emit('click', task)">
    <div :class="$style.header">
      <span :class="$style.type">{{ typeLabel }}</span>
      <span :class="$style.status" :style="{ color: statusColor }">{{ task.status }}</span>
    </div>
    <div :class="$style.title">{{ task.contractJson.name || task.type }}</div>
    <div :class="$style.row">
      <span>物品：{{ itemSummary }}</span>
      <span>价格：{{ priceText }}</span>
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
  padding: 12px;
  border: 1px solid var(--panel-border);
  background: var(--panel-background);
  cursor: pointer;
}
.card:hover {
  background: var(--panel-background-alt);
}
.header {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  margin-bottom: 4px;
}
.type {
  color: var(--accent);
  font-weight: 600;
}
.title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 6px;
}
.row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 2px;
}
.expires {
  font-size: 11px;
  color: var(--text-warning, #f0ad4e);
  margin-top: 4px;
}
</style>
