<script setup lang="ts">
import { computed } from 'vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import PrunLink from '@src/components/PrunLink.vue';
import BaseAlias from '@src/components/BaseAlias.vue';
import { useTitleBarToggle } from '@src/features/XIT/title-bar-toggle';
import { useTileState } from '@src/store/user-data-tiles';

import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { workforcesStore } from '@src/infrastructure/prun-api/data/workforces';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { percent0, percent2 } from '@src/utils/format';

const LEVEL_LABELS: Record<string, string> = {
  PIONEER: '先驱者',
  SETTLER: '定居者',
  TECHNICIAN: '技术员',
  ENGINEER: '工程师',
  SCIENTIST: '科学家',
};

interface WorkforceRow {
  planetName: string;
  naturalId: string;
  level: string;
  levelLabel: string;
  population: number;
  required: number;
  shortage: number;
  satisfaction: number;
  unmetNeeds: { ticker: string; satisfaction: number; essential: boolean }[];
}

const rows = computed<WorkforceRow[] | undefined>(() => {
  const sites = sitesStore.all.value;
  if (!sites) {
    return undefined;
  }

  const result: WorkforceRow[] = [];

  for (const site of sites) {
    const workforce = workforcesStore.getById(site.siteId)?.workforces;
    if (!workforce) {
      continue;
    }

    const planetName = getEntityNameFromAddress(site.address) ?? '';
    const naturalId = getEntityNaturalIdFromAddress(site.address) ?? '';

    for (const wf of workforce) {
      if (wf.required === 0) {
        continue;
      }
      const unmetNeeds: { ticker: string; satisfaction: number; essential: boolean }[] = [];
      for (const need of wf.needs) {
        if (need.satisfaction < 1) {
          unmetNeeds.push({
            ticker: need.material.ticker,
            satisfaction: need.satisfaction,
            essential: need.essential,
          });
        }
      }
      unmetNeeds.sort((a, b) => a.satisfaction - b.satisfaction);

      result.push({
        planetName,
        naturalId,
        level: wf.level,
        levelLabel: LEVEL_LABELS[wf.level] ?? wf.level,
        population: wf.population,
        required: wf.required,
        shortage: wf.required - wf.population,
        satisfaction: wf.satisfaction,
        unmetNeeds,
      });
    }
  }

  return result.sort((a, b) => a.satisfaction - b.satisfaction);
});

// 「只看异常」：劳动力有缺口，或存在任何未满足需求（含未标 ★ 的非必需短供）的基地。
// 只影响显示，不改变行内数据口径。状态随磁贴持久化（默认关 = 显示全部）。
const onlyIssues = useTileState('onlyIssues', false);

useTitleBarToggle({
  ui: 'wfor-only-issues',
  label: '只看异常',
  active: onlyIssues,
});

const visibleRows = computed(() => {
  const all = rows.value ?? [];
  if (!onlyIssues.value) {
    return all;
  }
  return all.filter(row => row.shortage > 0 || row.unmetNeeds.length > 0);
});

function satisfactionClass(value: number) {
  if (value < 0.8) {
    return C.ColoredValue.negative;
  }
  if (value < 1) {
    return '';
  }
  return C.ColoredValue.positive;
}

function unmetText(needs: { ticker: string; satisfaction: number; essential: boolean }[]): string {
  if (needs.length === 0) {
    return '--';
  }
  return needs
    .slice(0, 5)
    .map(n => `${n.essential ? '★' : ''}${n.ticker}:${percent0(n.satisfaction)}`)
    .join(' ');
}
</script>

<template>
  <LoadingSpinner v-if="rows === undefined" />
  <table v-else>
    <thead>
      <tr>
        <th>星球</th>
        <th>层级</th>
        <th>人口/需求</th>
        <th>缺口</th>
        <th>满足度</th>
        <th>未满足必需品</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="visibleRows.length === 0">
        <td colspan="6" style="text-align: center; opacity: 0.5; padding: 12px">
          {{ onlyIssues ? '没有缺口或未满足需求的基地' : '暂无劳动力数据' }}
        </td>
      </tr>
      <tr v-for="row in visibleRows" :key="`${row.naturalId}:${row.level}`">
        <td>
          <PrunLink inline :command="`BS ${row.naturalId}`">
            {{ row.planetName }}
            <BaseAlias :natural-id="row.naturalId" />
          </PrunLink>
        </td>
        <td>{{ row.levelLabel }}</td>
        <td>{{ row.population }}/{{ row.required }}</td>
        <td :style="{ color: row.shortage > 0 ? '#d9534f' : '' }">
          {{ row.shortage > 0 ? row.shortage : '--' }}
        </td>
        <td :class="satisfactionClass(row.satisfaction)">{{ percent2(row.satisfaction) }}</td>
        <td style="font-size: 11px">{{ unmetText(row.unmetNeeds) }}</td>
      </tr>
    </tbody>
  </table>
</template>

<style scoped>
table tr > :not(:first-child) {
  text-align: right;
}
table tr > :last-child {
  text-align: left;
}
</style>
