<script setup lang="ts">
import { computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { timestampEachMinute } from '@src/utils/dayjs';
import { formatEta } from '@src/utils/format';
import { calcCompletionDate } from '@src/core/production-line';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';

interface WarningRow {
  planetName: string;
  naturalId: string;
  lineId: string;
  reactorTicker: string;
  active: number;
  capacity: number;
  queued: number;
  status: 'idle' | 'stopping' | 'empty-queue' | 'idle-slot';
  nextStopMs?: number;
  sortKey: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const rows = computed<WarningRow[] | undefined>(() => {
  const sites = sitesStore.all.value;
  if (!sites) {
    return undefined;
  }

  const result: WarningRow[] = [];

  for (const site of sites) {
    const lines = productionStore.getBySiteId(site.siteId);
    if (!lines) {
      continue;
    }

    const planetName = getEntityNameFromAddress(site.address) ?? '';
    const naturalId = getEntityNaturalIdFromAddress(site.address) ?? '';

    for (const line of lines) {
      const activeOrders = line.orders.filter(x => x.started !== null && !x.halted);
      const queuedOrders = line.orders.filter(x => x.started === null || x.halted);
      const active = activeOrders.length;
      const capacity = line.capacity;
      const queued = queuedOrders.length;

      let status: WarningRow['status'];
      let nextStopMs: number | undefined;
      let sortKey: number;

      if (active === 0) {
        // 产线完全空闲
        status = 'idle';
        nextStopMs = undefined;
        sortKey = 0; // 最严重
      } else if (queued === 0) {
        // 有活跃订单但无队列，即将停机
        status = 'empty-queue';
        // 取最早完成的活跃订单时间
        let earliest = Infinity;
        for (const order of activeOrders) {
          const completion = calcCompletionDate(line, order);
          if (completion !== undefined && completion < earliest) {
            earliest = completion;
          }
        }
        nextStopMs = earliest === Infinity ? undefined : earliest;
        sortKey = nextStopMs ?? Date.now();
      } else {
        // 有队列，计算最早停机时间（第一个活跃订单完成且无后续队列时）
        // 简化：取最早活跃订单完成时间作为"下一次状态变化"
        let earliest = Infinity;
        for (const order of activeOrders) {
          const completion = calcCompletionDate(line, order);
          if (completion !== undefined && completion < earliest) {
            earliest = completion;
          }
        }
        if (active < capacity) {
          status = 'idle-slot';
          nextStopMs = undefined;
          sortKey = Date.now(); // 当前就有空槽
        } else {
          // 满负荷运转，不在预警范围
          continue;
        }
      }

      result.push({
        planetName,
        naturalId,
        lineId: line.id,
        reactorTicker:
          site.platforms.find(p => p.module.reactorName === line.type)?.module.reactorTicker ??
          line.type,
        active,
        capacity,
        queued,
        status,
        nextStopMs,
        sortKey,
      });
    }
  }

  return result.sort((a, b) => a.sortKey - b.sortKey);
});

const STATUS_LABELS: Record<WarningRow['status'], string> = {
  idle: '完全空闲',
  stopping: '即将停机',
  'empty-queue': '队列已空',
  'idle-slot': '有空槽',
};

function statusClass(status: WarningRow['status']) {
  if (status === 'idle' || status === 'empty-queue') return C.ColoredValue.negative;
  if (status === 'idle-slot') return C.ColoredValue.positive;
  return '';
}

function etaText(ms: number | undefined): string {
  if (ms === undefined) return '--';
  const now = timestampEachMinute.value;
  if (ms <= now) return '现在';
  return formatEta(now, ms);
}

function isUrgent(ms: number | undefined): boolean {
  if (ms === undefined) return false;
  return ms - timestampEachMinute.value < DAY_MS;
}
</script>

<template>
  <LoadingSpinner v-if="rows === undefined" />
  <table v-else>
    <thead>
      <tr>
        <th>星球</th>
        <th>建筑</th>
        <th>状态</th>
        <th>活跃/容量</th>
        <th>队列</th>
        <th>下次变化</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="rows.length === 0">
        <td colspan="7" style="text-align: center; opacity: 0.5; padding: 12px">
          所有产线运转正常
        </td>
      </tr>
      <tr v-for="row in rows" :key="row.lineId">
        <td>{{ row.planetName }}</td>
        <td>{{ row.reactorTicker }}</td>
        <td :class="statusClass(row.status)">{{ STATUS_LABELS[row.status] }}</td>
        <td>{{ row.active }}/{{ row.capacity }}</td>
        <td :style="{ color: row.queued === 0 ? '#d9534f' : '' }">{{ row.queued }}</td>
        <td :style="{ color: isUrgent(row.nextStopMs) ? '#f0ad4e' : '' }">
          {{ etaText(row.nextStopMs) }}
        </td>
        <td>
          <button
            :class="[C.Button.btn, C.Button.primary, C.Button.inline]"
            @click="showBuffer(`PRODQ ${row.lineId}`)">
            PRODQ
          </button>
        </td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
table tr > :not(:first-child) {
  text-align: right;
}
</style>
