<script setup lang="ts">
import { computed } from 'vue';
import { PlatformProduction } from '@src/core/production';
import MaterialIcon from '@src/components/MaterialIcon.vue';
import IconCell from './IconCell.vue';
import { timestampEachMinute } from '@src/utils/dayjs';

const $style = useCssModule();

const { productionLine, headers } = defineProps<{
  productionLine: PlatformProduction;
  headers?: boolean;
}>();

interface StackedOrderGroup {
  ticker: string;
  count: number;
  amount: number;
  ts?: number;
  label?: string;
  isPlaceholder?: boolean;
  isQueued?: boolean;
}

const stackedActive = computed(() => {
  const groups: Record<string, StackedOrderGroup> = {};
  const BUCKET_MS = 10 * 60 * 1000;

  // Group existing orders.
  for (const order of productionLine.orders) {
    const output = order.outputs[0];
    if (output === undefined) {
      continue;
    }

    const ts = order.completion ? new Date(order.completion.timestamp).getTime() : 0;
    const bucket = Math.round(ts / BUCKET_MS);
    const key = `${order.recipeId}-${bucket}`;

    groups[key] ??= { ticker: output.material.ticker, count: 0, amount: 0, ts };
    groups[key].count += 1;
    groups[key].amount += output.amount;
  }

  const results = Object.values(groups);

  // Unused Capacity logic.
  if (productionLine.inactiveCapacity > 0) {
    results.push({
      ticker: 'N/A',
      count: productionLine.inactiveCapacity,
      amount: 0,
      label: '未激活',
      isPlaceholder: true,
    });
  }

  return results;
});

const stackedQueued = computed(() => {
  const groups: Record<string, StackedOrderGroup> = {};

  for (const order of productionLine.queuedOrders) {
    const output = order.outputs[0];
    if (output === undefined) {
      continue;
    }

    const key = order.recipeId;
    groups[key] ??= { ticker: output.material.ticker, count: 0, amount: 0 };
    groups[key].count += 1;
    groups[key].amount += output.amount;
  }

  const results = Object.values(groups);

  // Missing Queue logic.
  if (productionLine.queuedOrders.length === 0) {
    results.push({
      ticker: 'N/A',
      count: 0,
      amount: 0,
      label: '未排队',
      isPlaceholder: true,
    });
  }

  return results;
});

const allStackedOrders = computed(() => {
  return [
    ...stackedActive.value.map(group => ({ ...group, isQueued: false })),
    ...stackedQueued.value.map(group => ({ ...group, isQueued: true })),
  ];
});

function statusClass(group: StackedOrderGroup) {
  if (group.isPlaceholder) {
    return $style.placeholderStatus;
  }
  return group.isQueued ? $style.queuedStatus : $style.activeStatus;
}

function groupKey(group: StackedOrderGroup, index: number) {
  return (group.isQueued ? 'q-' : 'a-') + group.ticker + (group.ts ?? index);
}

const hasStacks = computed(() => allStackedOrders.value.some(x => x.count > 1));

const formatTime = (ts: number) => {
  const mins = Math.max(0, Math.floor((ts - timestampEachMinute.value) / 60000));
  if (mins === 0) {
    return '完成中...';
  }
  return mins > 60 ? `${Math.floor(mins / 60)}小时 ${mins % 60}分钟后` : `${mins}分钟后`;
};
</script>

<template>
  <div>
    <table :class="$style.orderTable">
      <thead>
        <tr v-if="headers" :class="$style.headerRow">
          <th />
          <th v-if="hasStacks" />
          <th :class="$style.numericColumn">数量</th>
          <th :class="$style.numericColumn">状态 / 预计完成时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(group, index) in allStackedOrders" :key="groupKey(group, index)">
          <IconCell>
            <MaterialIcon :ticker="group.ticker" size="inline-table" />
          </IconCell>
          <td v-if="hasStacks" :class="$style.stackColumn">
            <div v-if="group.count > 1" :class="$style.stackCount">x{{ group.count }}</div>
          </td>
          <td :class="$style.numericColumn">{{ group.isPlaceholder ? '-' : group.amount }}</td>
          <td :class="[$style.numericColumn, statusClass(group)]">
            <template v-if="group.isPlaceholder">
              {{ group.label }}
            </template>
            <template v-else>
              {{ group.isQueued ? '排队中' : group.ts ? formatTime(group.ts) : '错误' }}
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style module>
.placeholderStatus {
  color: var(--rp-color-red);
  font-weight: bold;
}

.orderTable {
  width: 100%;
  font-size: 11px;
  padding: 0;
}

.headerRow th {
  text-align: left;
  padding-bottom: 2px;
  font-weight: normal;
  text-transform: uppercase;
  font-size: calc(9px + 2px * var(--rp-font-enlargement));
}

.numericColumn {
  text-align: right;
}

.stackColumn {
  width: 32px;
}

.stackCount {
  /* FIO primary blue. */
  color: #3faabf;
  font-weight: bold;
}

.activeStatus {
  color: var(--rp-color-orange);
}

.queuedStatus {
  opacity: 0.7;
}
</style>
