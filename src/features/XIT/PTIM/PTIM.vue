<script setup lang="ts">
import { computed, ref } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { calcCompletionDate } from '@src/core/production-line';
import { timestampEachMinute } from '@src/utils/dayjs';
import { fixed0 } from '@src/utils/format';
import { isEmpty } from 'ts-extras';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import $style from '../CONTS/conts-shared.module.css';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

interface TimelineEntry {
  siteId: string;
  planetName: string;
  lineType: string;
  orderId: string;
  completion: number;
  outputs: PrunApi.MaterialAmountValue[];
  started: boolean;
  recurring: boolean;
}

// 时间范围筛选（小时）
const timeRangeHours = ref(48);

const allEntries = computed<TimelineEntry[]>(() => {
  const sites = sitesStore.all.value ?? [];
  const out: TimelineEntry[] = [];
  for (const site of sites) {
    const planetName = getEntityNaturalIdFromAddress(site.address) ?? '--';
    const lines = productionStore.getBySiteId(site.siteId) ?? [];
    for (const line of lines) {
      for (const order of line.orders) {
        if (order.halted) continue;
        const completion = calcCompletionDate(line, order);
        if (completion === undefined) continue;
        out.push({
          siteId: site.siteId,
          planetName,
          lineType: line.type,
          orderId: order.id,
          completion,
          outputs: order.outputs,
          started: order.started !== null,
          recurring: order.recurring,
        });
      }
    }
  }
  // 按完成时间升序
  out.sort((a, b) => a.completion - b.completion);
  return out;
});

// 应用时间范围筛选（仅展示未来 N 小时内完成）
const filteredEntries = computed(() => {
  const now = timestampEachMinute.value;
  const cutoff = now + timeRangeHours.value * HOUR_MS;
  return allEntries.value.filter(e => e.completion > now && e.completion <= cutoff);
});

// ETA 文本
function etaText(ts: number) {
  const r = ts - timestampEachMinute.value;
  if (r <= 0) return '已完成';
  const days = Math.floor(r / DAY_MS);
  const hours = Math.floor((r % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((r % HOUR_MS) / (60 * 1000));
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

// 绝对时间文本
function absTime(ts: number) {
  const d = new Date(ts);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

// 紧急色阶：<1h 红、<6h 橙
function urgencyStyle(ts: number) {
  const r = ts - timestampEachMinute.value;
  if (r < HOUR_MS) return 'color: #d9534f';
  if (r < 6 * HOUR_MS) return 'color: #f0ad4e';
  return '';
}

// 按产出物料汇总
const outputSummary = computed(() => {
  const m = new Map<string, number>();
  for (const e of filteredEntries.value) {
    for (const o of e.outputs) {
      const key = o.material.ticker;
      m.set(key, (m.get(key) ?? 0) + o.amount);
    }
  }
  return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
});

function openProd(planet: string) {
  void showBuffer(`PROD ${planet}`);
}

function openProdq(planet: string) {
  void showBuffer(`PRODQ ${planet}`);
}
</script>

<template>
  <LoadingSpinner v-if="!sitesStore.fetched || !productionStore.fetched" />
  <div v-else :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <!-- 控制栏 -->
    <div :class="$style.totalsBar">
      <span>
        时间范围:
        <select v-model.number="timeRangeHours">
          <option :value="6">未来 6 小时</option>
          <option :value="12">未来 12 小时</option>
          <option :value="24">未来 24 小时</option>
          <option :value="48">未来 48 小时</option>
          <option :value="168">未来 7 天</option>
        </select>
      </span>
      <span
        >待完成订单: <strong>{{ filteredEntries.length }}</strong></span
      >
      <span v-if="!isEmpty(outputSummary)">
        产出汇总:
        <strong>
          <span v-for="(item, i) in outputSummary.slice(0, 8)" :key="item[0]">
            <span v-if="i > 0"> | </span>
            {{ fixed0(item[1]) }} {{ item[0] }}
          </span>
          <span v-if="outputSummary.length > 8"> ...</span>
        </strong>
      </span>
    </div>

    <table>
      <thead>
        <tr>
          <th>完成时间</th>
          <th>ETA</th>
          <th>星球</th>
          <th>产线</th>
          <th>产出</th>
          <th>状态</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="isEmpty(filteredEntries)">
          <td colspan="7" :class="$style.empty">所选时间范围内无待完成订单</td>
        </tr>
        <tr v-for="e in filteredEntries" :key="e.orderId">
          <td>{{ absTime(e.completion) }}</td>
          <td :style="urgencyStyle(e.completion)">{{ etaText(e.completion) }}</td>
          <td>
            <span :class="C.Link.link" @click="openProd(e.planetName)">{{ e.planetName }}</span>
          </td>
          <td>{{ e.lineType }}</td>
          <td>
            <span v-for="(o, i) in e.outputs" :key="o.material.ticker">
              <span v-if="i > 0"> | </span>
              {{ fixed0(o.amount) }} {{ o.material.ticker }}
            </span>
          </td>
          <td>
            <span v-if="e.started">运行中</span>
            <span v-else style="opacity: 0.7">排队中</span>
            <span v-if="e.recurring" style="color: #5cb85c; margin-left: 4px">↻</span>
          </td>
          <td>
            <span :class="C.Link.link" @click="openProdq(e.planetName)">队列</span>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
