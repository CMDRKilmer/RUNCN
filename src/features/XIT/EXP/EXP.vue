<script setup lang="ts">
import { computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import PrunLink from '@src/components/PrunLink.vue';
import BaseAlias from '@src/components/BaseAlias.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { expertsStore } from '@src/infrastructure/prun-api/data/experts';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { timestampEachMinute } from '@src/utils/dayjs';
import { formatEta, percent2 } from '@src/utils/format';
import { calculateEta, getTotalExperts, MS_IN_DAY } from '@src/core/experts';

const CATEGORY_LABELS: Record<string, string> = {
  AGRICULTURE: '农业',
  CHEMISTRY: '化学',
  CONSTRUCTION: '建筑材料',
  ELECTRONICS: '电子',
  FOOD_INDUSTRIES: '食品工业',
  FUEL_REFINING: '燃料精炼',
  MANUFACTURING: '制造',
  METALLURGY: '冶金',
  RESOURCE_EXTRACTION: '资源开采',
};

interface ExpertRow {
  planetName: string;
  naturalId: string;
  category: string;
  categoryLabel: string;
  progress: number;
  total: number;
  limit: number;
  available: number;
  maxed: boolean;
  etaText: string;
  sortKey: number;
}

const rows = computed<ExpertRow[] | undefined>(() => {
  const sites = sitesStore.all.value;
  if (!sites) {
    return undefined;
  }

  const result: ExpertRow[] = [];
  const now = timestampEachMinute.value;

  for (const site of sites) {
    const experts = expertsStore.getBySiteId(site.siteId);
    const production = productionStore.getBySiteId(site.siteId);
    const planetName = getEntityNameFromAddress(site.address) ?? '';
    const naturalId = getEntityNaturalIdFromAddress(site.address) ?? '';

    if (!experts) {
      continue;
    }

    for (const field of experts.experts) {
      const entry = field.entry;
      const total = getTotalExperts(entry);
      const maxed = total >= entry.limit;

      const lines = production?.filter(line =>
        line.efficiencyFactors.some(
          x => x.type === 'EXPERTS' && x.expertiseCategory === field.category,
        ),
      );

      const eta = lines ? calculateEta(entry, lines) : undefined;

      let etaText = '--';
      let sortKey = Infinity;

      if (maxed) {
        etaText = 'Maxed';
        sortKey = Infinity;
      } else if (eta) {
        if (eta.type === 'precise') {
          etaText = formatEta(now, eta.ms);
          sortKey = eta.ms;
        } else if (eta.type === 'estimate') {
          etaText = isFinite(eta.ms) ? `~${(eta.ms / MS_IN_DAY).toFixed(1)}d` : '∞';
          sortKey = now + eta.ms;
        }
      }

      result.push({
        planetName,
        naturalId,
        category: field.category,
        categoryLabel: CATEGORY_LABELS[field.category] ?? field.category,
        progress: entry.progress,
        total,
        limit: entry.limit,
        available: entry.available,
        maxed,
        etaText,
        sortKey,
      });
    }
  }

  return result.filter(x => x.etaText !== '--').sort((a, b) => a.sortKey - b.sortKey);
});
</script>

<template>
  <LoadingSpinner v-if="rows === undefined" />
  <table v-else>
    <thead>
      <tr>
        <th>星球</th>
        <th>行业</th>
        <th>进度</th>
        <th>当前/上限</th>
        <th>可分配</th>
        <th>预计时间</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="rows.length === 0">
        <td colspan="6" style="text-align: center; opacity: 0.5; padding: 12px">暂无专家数据</td>
      </tr>
      <tr v-for="row in rows" :key="`${row.naturalId}:${row.category}`">
        <td>
          <PrunLink inline :command="`EXP ${row.naturalId}`">
            {{ row.planetName }}
            <BaseAlias :natural-id="row.naturalId" />
          </PrunLink>
        </td>
        <td>{{ row.categoryLabel }}</td>
        <td>{{ percent2(row.progress) }}</td>
        <td>{{ row.total }}/{{ row.limit }}</td>
        <td :style="{ color: row.available > 0 ? '#f0ad4e' : '' }">
          {{ row.available > 0 ? row.available : '--' }}
        </td>
        <td :style="{ opacity: row.maxed ? 0.5 : 1 }">{{ row.etaText }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
table tr > :not(:first-child) {
  text-align: right;
}
</style>
