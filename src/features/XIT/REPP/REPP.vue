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
import { computed } from 'vue';

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
// 注意:RESOURCES(extractor/colony) 与 PRODUCTION 都有 production line 数据
// (PrUn 统一通过 PRODUCTION_PRODUCTION_LINES 消息推送),只是没有 active orders,
// output 来自 productionTemplates。
// 沿用 core/production.ts 的 reactorName ↔ line.type 1:1 匹配。
function resolveBuildingDailyRevenue(
  building: PrunApi.Platform,
  site: PrunApi.Site,
): number | undefined {
  if (building.module.type !== 'PRODUCTION' && building.module.type !== 'RESOURCES') {
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
  const perLineRevenue = calculateProductionRevenue(line);
  if (perLineRevenue === undefined) {
    console.warn(
      '[REPP] No queued orders / templates for',
      building.module.reactorName,
      '@',
      site.siteId,
    );
    return undefined;
  }
  // calculateProductionRevenue 返回 per-line 产值(含 line.capacity 个并行槽位)。
  // 拆成 per-building:若 capacity=0(异常),跳过。
  if (line.capacity <= 0) {
    return undefined;
  }
  return perLineRevenue / line.capacity;
}

const predictions = computed(() => {
  return calculateRepairPredictions(sites.value, {
    resolveBuildingDailyRevenue,
  });
});

const isMultiSite = computed(() => (sites.value?.length ?? 0) > 1);

// 主面板聚合(多站) vs 详情视图(单站)的判别:
// 多站 → 聚合行;单站 → 逐建筑行。
const isAggregateView = computed(() => isMultiSite.value);

// 主面板聚合:每行 = 一个 naturalId(整站)的所有 ticker 多建筑求和视图。
// 多站模式下按基地聚合(一行 = 一个基地的所有 ticker × 所有建筑);
// 单站模式下同 naturalId 也只有一行(同基地跨 ticker 合并)。
// sweep 的整站最优日(optimalDay / optimalRepairCost)由
// core/repair-plan.calculateRepairPredictions 在内部按基地聚合后下发到每栋建筑,
// 这里取该 naturalId 内任一建筑的共享值(同基地 sweep 边际最优日一致)。
interface AggregateRow {
  naturalId: string;
  target: string;
  tickers: string[]; // 该基地下所有 ticker 集合(去重保序)
  count: number;
  ageMin: number;
  ageMax: number;
  dailyRevenue: number; // 全站所有建筑 per-day 总产值
  currentRepairCost: number; // 全站所有建筑修满成本之和
  optimalDay: number | undefined;
  optimalRepairCost: number; // 全站所有建筑最优日修满成本之和
  triggerTimestamp: number;
  daysUntilTrigger: number;
  dueCount: number;
}

// 详情视图:每行 = 一栋建筑的真实 per-day 数据,无聚合。
// 单站 detail buffer 中展示,使用户能看到每个建筑的具体情况。
interface DetailRow {
  naturalId: string;
  target: string;
  ticker: string;
  ageDays: number;
  dailyRevenue: number | undefined;
  currentRepairCost: number | undefined;
  optimalDay: number | undefined;
  optimalRepairCost: number | undefined;
  triggerTimestamp: number;
  daysUntilTrigger: number;
}

function aggregateKey(p: NonNullable<typeof predictions.value>[number]): string {
  // 按整站聚合(不区分 ticker):同基地的所有 ticker 建筑合并为一行。
  return p.naturalId;
}

const aggregateRows = computed<AggregateRow[]>(() => {
  const list = predictions.value ?? [];
  const map = new Map<string, AggregateRow>();
  for (const p of list) {
    const key = aggregateKey(p);
    let g = map.get(key);
    if (!g) {
      g = {
        naturalId: p.naturalId,
        target: p.target,
        tickers: [],
        count: 0,
        ageMin: Infinity,
        ageMax: -Infinity,
        dailyRevenue: 0,
        currentRepairCost: 0,
        optimalDay: p.optimalDay,
        optimalRepairCost: p.optimalRepairCost ?? 0,
        triggerTimestamp: p.triggerTimestamp,
        daysUntilTrigger: p.daysUntilTrigger,
        dueCount: 0,
      };
      map.set(key, g);
    }
    if (!g.tickers.includes(p.ticker)) {
      g.tickers.push(p.ticker);
    }
    g.count++;
    g.ageMin = Math.min(g.ageMin, p.ageDays);
    g.ageMax = Math.max(g.ageMax, p.ageDays);
    if (p.dailyRevenue !== undefined) {
      g.dailyRevenue += p.dailyRevenue;
    }
    if (p.currentRepairCost !== undefined) {
      g.currentRepairCost += p.currentRepairCost;
    }
    if (p.optimalRepairCost !== undefined) {
      g.optimalRepairCost += p.optimalRepairCost;
    }
    if (p.optimalDay !== undefined) {
      g.optimalDay = p.optimalDay;
    }
    if (p.triggerTimestamp < g.triggerTimestamp) {
      g.triggerTimestamp = p.triggerTimestamp;
      g.daysUntilTrigger = p.daysUntilTrigger;
    }
    if (p.daysUntilTrigger <= 0) {
      g.dueCount++;
    }
  }
  return [...map.values()].sort((a, b) => a.triggerTimestamp - b.triggerTimestamp);
});

const detailRows = computed<DetailRow[]>(() => {
  const list = predictions.value ?? [];
  return list.map(p => ({
    naturalId: p.naturalId,
    target: p.target,
    ticker: p.ticker,
    ageDays: p.ageDays,
    dailyRevenue: p.dailyRevenue,
    currentRepairCost: p.currentRepairCost,
    optimalDay: p.optimalDay,
    optimalRepairCost: p.optimalRepairCost,
    triggerTimestamp: p.triggerTimestamp,
    daysUntilTrigger: p.daysUntilTrigger,
  }));
});

// 模板实际使用的行:
//   - 多站主面板(无参数 / 多参数):聚合视图,每行 = (基地,ticker)
//   - 单站 detail buffer(已传 naturalId):逐建筑视图,每行 = 1 栋
const rows = computed(() => (isAggregateView.value ? aggregateRows.value : detailRows.value));

// 总览统计:在聚合视图下对 (count, dueCount) 求和;在详情视图下取长度 / due 计数。
const totalMembers = computed(() =>
  isAggregateView.value
    ? aggregateRows.value.reduce((s, g) => s + g.count, 0)
    : detailRows.value.length,
);
const totalDue = computed(() =>
  isAggregateView.value
    ? aggregateRows.value.reduce((s, g) => s + g.dueCount, 0)
    : detailRows.value.filter(r => r.daysUntilTrigger <= 0).length,
);

// 用于倒计时区显示最早触发的"行"。
const earliest = computed(() => rows.value[0]);

// 数据就绪统计(基于建筑粒度)。
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

function ageRangeText(g: AggregateRow): string {
  // 聚合视图:当所有建筑 age 相同时不显示范围(即使是 count > 1 的同 ticker 聚合)。
  if (g.count === 1 || g.ageMin === g.ageMax) {
    return `${fixed1(g.ageMin)} 天`;
  }
  return `${fixed1(g.ageMin)}–${fixed1(g.ageMax)} 天`;
}

// 把 "最早触发" 行的 ticker 列表渲染成 "SD + SE + SL" 形式。
// 聚合视图 → 用 tickers 数组;详情视图 → 单 ticker。
function formatTickers(row: AggregateRow | DetailRow | undefined): string {
  if (!row) {
    return '';
  }
  if ('tickers' in row) {
    return row.tickers.join(' + ');
  }
  return row.ticker;
}

function hasAggregateData(g: AggregateRow): boolean {
  // 不能简单看 g.dailyRevenue > 0,因为全 0 时也是 0(语义不明确)。
  return g.count > 0;
}

function hasDetailData(r: DetailRow): boolean {
  return r.dailyRevenue !== undefined;
}

function detailAgeText(r: DetailRow): string {
  return `${fixed1(r.ageDays)} 天`;
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
          {{ formatTickers(earliest) }} @ {{ earliest.target }} —
          {{ triggerText(earliest) }}
        </span>
        <span v-else>暂无预测</span>
      </div>
      <div>
        待维修建筑数:
        <span :class="totalDue > 0 ? C.ColoredValue.negative : ''">{{ totalDue }}</span>
        / {{ totalMembers }}（{{ rows.length }} 行）
      </div>
      <div :class="$style.hint">
        数据就绪: 日产 {{ stats.withDailyRevenue }}/{{ stats.total }}, 修满
        {{ stats.withRepairCost }}/{{ stats.total }}, 最优 {{ stats.withOptimal }}/{{ stats.total }}
        <template v-if="!cxStore.fetched">(CX 价格加载中…)</template>
      </div>
    </div>

    <SectionHeader>{{ isAggregateView ? '建筑聚合(按基地)' : '逐建筑详情' }}</SectionHeader>
    <table>
      <thead>
        <tr>
          <th>代码</th>
          <th v-if="isMultiSite">目标</th>
          <th v-if="isAggregateView">数量</th>
          <th>年龄</th>
          <th>日产估值</th>
          <th>当前修满成本</th>
          <th>最优间隔</th>
          <th>触发时间</th>
          <th>BRA</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="rows.length === 0">
          <td
            :colspan="isMultiSite ? (isAggregateView ? 9 : 8) : isAggregateView ? 8 : 7"
            style="text-align: center; opacity: 0.5; padding: 12px">
            无可维修建筑
          </td>
        </tr>
        <!-- 聚合视图:多站主面板,每行 = (基地, ticker) -->
        <template v-if="isAggregateView">
          <tr v-for="r in aggregateRows" :key="`agg::${r.naturalId}`">
            <td
              ><strong>{{ r.tickers.join(' + ') }}</strong></td
            >
            <td v-if="isMultiSite">
              <PrunLink :command="`XIT REPP ${r.naturalId}`">{{ r.target }}</PrunLink>
            </td>
            <td>{{ r.count }}</td>
            <td :class="urgencyClass(r)">{{ ageRangeText(r) }}</td>
            <td>
              <span
                v-if="hasAggregateData(r)"
                :data-tooltip="
                  r.count > 1
                    ? `${r.count} 座建筑 per-day 总产值加权求和`
                    : 'PRUNplanner 算法:outputs×Bid − inputs×Ask × maxDailyRuns − 劳动力 − 建造成本/180'
                "
                data-tooltip-position="left"
                >{{ formatCurrency(r.dailyRevenue, fixed1) }}</span
              >
              <span v-else data-tooltip="无活跃生产订单">--</span>
            </td>
            <td>
              <span
                :data-tooltip="r.count > 1 ? `${r.count} 座建筑修满成本的总和` : undefined"
                data-tooltip-position="left"
                >{{ formatCurrency(r.currentRepairCost, fixed1) }}</span
              >
            </td>
            <td>
              <span
                v-if="r.optimalDay !== undefined"
                :data-tooltip="
                  '按 PRUNplanner 模型,每 ' + r.optimalDay + ' 天维修一次的日均利润最大'
                "
                data-tooltip-position="left"
                >{{ r.optimalDay }} 天</span
              >
              <span v-else data-tooltip="无日产估值或全建材料">--</span>
            </td>
            <td :class="urgencyClass(r)">
              <span v-if="r.optimalDay !== undefined">{{ triggerText(r) }}</span>
              <span v-else>--</span>
            </td>
            <td>
              <PrunLink inline :command="`BRA ${r.naturalId}`">
                <span :class="$style.braBtn">BRA</span>
              </PrunLink>
            </td>
          </tr>
        </template>
        <!-- 详情视图:单站 buffer,每行 = 1 栋建筑 -->
        <template v-else>
          <tr v-for="r in detailRows" :key="`det::${r.naturalId}::${r.ticker}::${r.ageDays}`">
            <td
              ><strong>{{ r.ticker }}</strong></td
            >
            <td v-if="isMultiSite">
              <PrunLink :command="`XIT REPP ${r.naturalId}`">{{ r.target }}</PrunLink>
            </td>
            <td :class="urgencyClass(r)">{{ detailAgeText(r) }}</td>
            <td>
              <span
                v-if="hasDetailData(r)"
                data-tooltip="PRUNplanner 算法:outputs×Bid − inputs×Ask × maxDailyRuns − 劳动力 − 建造成本/180"
                data-tooltip-position="left"
                >{{ formatCurrency(r.dailyRevenue, fixed1) }}</span
              >
              <span v-else data-tooltip="无活跃生产订单">--</span>
            </td>
            <td>{{ formatCurrency(r.currentRepairCost, fixed1) }}</td>
            <td>
              <span
                v-if="r.optimalDay !== undefined"
                :data-tooltip="
                  '按 PRUNplanner 模型,每 ' + r.optimalDay + ' 天维修一次的日均利润最大'
                "
                data-tooltip-position="left"
                >{{ r.optimalDay }} 天</span
              >
              <span v-else data-tooltip="无日产估值或全建材料">--</span>
            </td>
            <td :class="urgencyClass(r)">
              <span v-if="r.optimalDay !== undefined">{{ triggerText(r) }}</span>
              <span v-else>--</span>
            </td>
            <td>
              <PrunLink inline :command="`BRA ${r.naturalId}`">
                <span :class="$style.braBtn">BRA</span>
              </PrunLink>
            </td>
          </tr>
        </template>
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

.groupRow {
  font-weight: 500;
}

.memberRow td {
  padding: 2px 6px;
  font-size: 0.92em;
  opacity: 0.85;
}

.braBtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 40px;
  padding: 2px 8px;
  border: 1px solid currentColor;
  border-radius: 4px;
  font-size: 0.85em;
  line-height: 1;
  opacity: 0.85;
}

.braBtn:hover {
  opacity: 1;
}

.foldBtn {
  background: transparent;
  border: 1px solid currentColor;
  color: inherit;
  cursor: pointer;
  padding: 0 6px;
  border-radius: 3px;
  line-height: 1;
  font-size: 11px;
  opacity: 0.7;
}

.foldBtn:hover {
  opacity: 1;
}

table tr > :not(:first-child):not(:nth-child(2)) {
  text-align: right;
}
</style>
