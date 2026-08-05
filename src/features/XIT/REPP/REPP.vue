<script setup lang="ts">
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import PrunLink from '@src/components/PrunLink.vue';
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { productionStore } from '@src/infrastructure/prun-api/data/production';
import { cxStore } from '@src/infrastructure/fio/cx';
import { calculateRepairPredictions } from '@src/core/repair-plan';
import { calculateProductionRevenue } from '@src/core/production-revenue';
import { diffDays } from '@src/utils/time-diff';
import { timestampEachMinute } from '@src/utils/dayjs';
import { ddmm, fixed1, formatCurrency, hhmm } from '@src/utils/format';
import { objectId } from '@src/utils/object-id';

const parameters = useXitParameters();

const sites = computed(() => {
  if (sitesStore.all.value === undefined) {
    return undefined;
  }
  if (parameters.length === 0) {
    return sitesStore.all.value;
  }
  const list: PrunApi.Site[] = [];
  for (const p of parameters) {
    const site = sitesStore.getByPlanetNaturalIdOrName(p);
    if (site) {
      list.push(site);
    }
  }
  return list;
});

// 严格照搬 PRUNplanner:从 productionStore 找该建筑对应的 ProductionLine,
// 计算 per-line per-day net productionRevenue 作为 sweep 输入。
// 注意:仅 PRODUCTION 类型建筑有 production line;RESOURCES(extractor/colony) 没有,
// 该类建筑本特性不支持自动读取(需要外部 recipe 数据)。
// 沿用 core/production.ts 的 reactorName ↔ line.type 1:1 匹配。
function resolveBuildingDailyRevenue(
  building: PrunApi.Platform,
  site: PrunApi.Site,
): number | undefined {
  // RESOURCES 建筑不在 production line 体系里,无法自动读取。
  if (building.module.type !== 'PRODUCTION') {
    return undefined;
  }
  const lines = productionStore.getBySiteId(site.siteId);
  if (!lines) {
    // store 还没拉数据。getBySiteId 内部会触发 request.production,数据到达后会重新计算。
    return undefined;
  }
  const line = lines.find(l => l.type === building.module.reactorName);
  if (!line) {
    console.warn('[REPP] No production line for', building.module.reactorName, '@', site.siteId);
    return undefined;
  }
  const result = calculateProductionRevenue(line);
  if (result === undefined) {
    console.warn('[REPP] No active order for', building.module.reactorName, '@', site.siteId);
  }
  return result;
}

const predictions = computed(() => {
  return calculateRepairPredictions(sites.value, {
    resolveBuildingDailyRevenue,
  });
});

const isMultiSite = computed(() => (sites.value?.length ?? 0) > 1);

const earliest = computed(() => predictions.value?.[0]);
const dueCount = computed(
  () => predictions.value?.filter(p => p.daysUntilTrigger <= 0).length ?? 0,
);

// 数据就绪统计:用于在面板顶部提示"等待 CX / 等待生产数据"等。
const stats = computed(() => {
  const list = predictions.value ?? [];
  const total = list.length;
  let withDailyRevenue = 0;
  let withRepairCost = 0;
  let withOptimal = 0;
  for (const p of list) {
    if (p.dailyRevenue !== undefined) withDailyRevenue++;
    if (p.currentRepairCost !== undefined) withRepairCost++;
    if (p.optimalDay !== undefined) withOptimal++;
  }
  return { total, withDailyRevenue, withRepairCost, withOptimal };
});

function triggerText(p: { triggerTimestamp: number; daysUntilTrigger: number }): string {
  if (p.daysUntilTrigger <= 0) {
    return '已到触发';
  }
  const now = timestampEachMinute.value;
  const days = Math.floor(diffDays(now, p.triggerTimestamp));
  const time = hhmm(p.triggerTimestamp);
  return days === 0 ? `今天 ${time}` : `${days} 天后 (${ddmm(p.triggerTimestamp)})`;
}

function urgencyClass(p: { daysUntilTrigger: number }): string {
  if (p.daysUntilTrigger <= 0) {
    return C.ColoredValue.negative;
  }
  return '';
}
</script>

<template>
  <LoadingSpinner v-if="predictions === undefined" />
  <template v-else>
    <SectionHeader>倒计时</SectionHeader>
    <div :class="$style.summary">
      <div>
        最早触发:
        <span v-if="earliest && earliest.optimalDay !== undefined" :class="urgencyClass(earliest)">
          {{ earliest.ticker }} @ {{ earliest.target }} — {{ triggerText(earliest) }}
        </span>
        <span v-else>暂无预测</span>
      </div>
      <div>
        待维修建筑数:
        <span :class="dueCount > 0 ? C.ColoredValue.negative : ''">{{ dueCount }}</span>
        / {{ predictions.length }}
      </div>
      <div :class="$style.hint">
        数据就绪: 日产 {{ stats.withDailyRevenue }}/{{ stats.total }}, 修满
        {{ stats.withRepairCost }}/{{ stats.total }}, 最优 {{ stats.withOptimal }}/{{ stats.total }}
        <template v-if="!cxStore.fetched">(CX 价格加载中…)</template>
      </div>
    </div>

    <SectionHeader>逐建筑</SectionHeader>
    <table>
      <thead>
        <tr>
          <th>代码</th>
          <th v-if="isMultiSite">目标</th>
          <th>年龄</th>
          <th>日产估值</th>
          <th>当前修满成本</th>
          <th>最优间隔</th>
          <th>触发时间</th>
          <th>日均净利润</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="predictions.length === 0">
          <td colspan="8" style="text-align: center; opacity: 0.5; padding: 12px">
            无可维修建筑
          </td>
        </tr>
        <tr v-for="p in predictions" :key="objectId(p)">
          <td>{{ p.ticker }}</td>
          <td v-if="isMultiSite">
            <PrunLink :command="`XIT REPP ${p.naturalId}`">{{ p.target }}</PrunLink>
          </td>
          <td :class="p.daysUntilTrigger <= 0 ? C.ColoredValue.negative : ''">
            {{ fixed1(p.ageDays) }} 天
          </td>
          <td>
            <span
              v-if="p.dailyRevenue !== undefined"
              :data-tooltip="'PRUNplanner 算法:(outputs×Bid − inputs×Ask) × maxDailyRuns,从 PrUn ProductionLine 读取'"
              data-tooltip-position="left"
              >{{ formatCurrency(p.dailyRevenue, fixed1) }}</span
            >
            <span v-else data-tooltip="无活跃生产订单或全建材料未找到">--</span>
          </td>
          <td>{{ formatCurrency(p.currentRepairCost, fixed1) }}</td>
          <td>
            <span
              v-if="p.optimalDay !== undefined"
              :data-tooltip="'按 PRUNplanner 模型,每 ' + p.optimalDay + ' 天维修一次的日均利润最大'"
              data-tooltip-position="left"
              >{{ p.optimalDay }} 天</span
            >
            <span v-else data-tooltip="无日产估值或全建材料">--</span>
          </td>
          <td :class="urgencyClass(p)">
            <span v-if="p.optimalDay !== undefined">{{ triggerText(p) }}</span>
            <span v-else>--</span>
          </td>
          <td>{{ formatCurrency(p.optimalDailyProfit, fixed1) }}</td>
        </tr>
      </tbody>
    </table>
  </template>
</template>

<style module>
.summary {
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.hint {
  font-size: 11px;
  opacity: 0.65;
  margin-top: 4px;
}

table tr > :not(:first-child) {
  text-align: right;
}
</style>
