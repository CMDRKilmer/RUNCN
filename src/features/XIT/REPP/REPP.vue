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

// 折叠状态:按 (naturalId, ticker) 索引展开/折叠。true = 展开。
const expanded = ref<Record<string, boolean>>({});

function siteGroupKey(naturalId: string): string {
  return naturalId;
}

interface RepairGroup {
  naturalId: string;
  target: string;
  // 该基地下所有 tickers(汇总后保留类型集合便于 UI 显示)。
  tickers: string[];
  members: NonNullable<typeof predictions.value>[number][];
  // 加权累加后的整组数据(全站所有建筑求和)。
  // 当所有成员都缺数据时,值为 0;UI 通过对比 g.count 与 g.members.length 检查。
  dailyRevenue: number;
  optimalDay: number | undefined;
  optimalDailyProfit: number;
  optimalRepairCost: number;
  // 聚合统计。
  count: number;
  ageMin: number;
  ageMax: number;
  // 触发时间:取最早的。
  triggerTimestamp: number;
  daysUntilTrigger: number;
  dueCount: number; // 组内已到期成员数
}

const groups = computed<RepairGroup[]>(() => {
  const list = predictions.value ?? [];
  const map = new Map<string, RepairGroup>();
  for (const p of list) {
    const key = siteGroupKey(p.naturalId);
    let g = map.get(key);
    if (!g) {
      g = {
        naturalId: p.naturalId,
        target: p.target,
        tickers: [],
        members: [],
        // 累加所有成员的 per-building 数字,反映"整组作为一个 sweep 整体"的视角。
        // 与 PRUNplanner 的 dailyRevenue × building.amount 语义一致(后者也是把整组看作整体)。
        dailyRevenue: 0,
        optimalDay: p.optimalDay,
        optimalDailyProfit: 0,
        optimalRepairCost: 0,
        count: 0,
        ageMin: Infinity,
        ageMax: -Infinity,
        triggerTimestamp: p.triggerTimestamp,
        daysUntilTrigger: p.daysUntilTrigger,
        dueCount: 0,
      };
      map.set(key, g);
    }
    if (!g.tickers.includes(p.ticker)) {
      g.tickers.push(p.ticker);
    }
    g.members.push(p);
    g.count++;
    g.ageMin = Math.min(g.ageMin, p.ageDays);
    g.ageMax = Math.max(g.ageMax, p.ageDays);
    // 加权累加:全站每建筑的真实数据相加。
    if (p.dailyRevenue !== undefined) {
      g.dailyRevenue = (g.dailyRevenue ?? 0) + p.dailyRevenue;
    }
    if (p.optimalDailyProfit !== undefined) {
      g.optimalDailyProfit = (g.optimalDailyProfit ?? 0) + p.optimalDailyProfit;
    }
    if (p.optimalRepairCost !== undefined) {
      g.optimalRepairCost = (g.optimalRepairCost ?? 0) + p.optimalRepairCost;
    }
    // optimalDay 共享(同 line 同 ticker,所有建筑 sweep 起点相同)。
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
  // 组内按 ageDays 升序(最该修的在上),按 triggerTimestamp 升序排序组。
  for (const g of map.values()) {
    g.members.sort((a, b) => a.ageDays - b.ageDays);
  }
  return [...map.values()].sort((a, b) => a.triggerTimestamp - b.triggerTimestamp);
});

const totalMembers = computed(() => groups.value.reduce((s, g) => s + g.count, 0));
const totalDue = computed(() => groups.value.reduce((s, g) => s + g.dueCount, 0));

// 用于倒计时区显示最早触发的"组"。
const earliest = computed(() => groups.value[0]);

// 数据就绪统计(基于 members 粒度)。
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

function ageRangeText(g: RepairGroup): string {
  // 当所有建筑 age 相同时不显示范围(即使是 count > 1 的同基地聚合)。
  if (g.count === 1 || g.ageMin === g.ageMax) {
    return `${fixed1(g.ageMin)} 天`;
  }
  return `${fixed1(g.ageMin)}–${fixed1(g.ageMax)} 天`;
}

function isExpanded(g: RepairGroup): boolean {
  return expanded.value[g.naturalId] === true;
}

function toggle(g: RepairGroup) {
  expanded.value[g.naturalId] = !isExpanded(g);
}

// 组内是否至少有一个成员有日产估值(用于 UI 决定显示数字还是 --)。
// 不能简单看 g.dailyRevenue > 0,因为全 0 时也是 0(语义不明确)。
function hasGroupData(g: RepairGroup): boolean {
  return g.members.some(m => m.dailyRevenue !== undefined);
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
          {{ earliest.tickers.join(' + ') }} @ {{ earliest.target }} —
          {{ triggerText(earliest) }}
        </span>
        <span v-else>暂无预测</span>
      </div>
      <div>
        待维修建筑数:
        <span :class="totalDue > 0 ? C.ColoredValue.negative : ''">{{ totalDue }}</span>
        / {{ totalMembers }}（{{ groups.length }} 组）
      </div>
      <div :class="$style.hint">
        数据就绪: 日产 {{ stats.withDailyRevenue }}/{{ stats.total }}, 修满
        {{ stats.withRepairCost }}/{{ stats.total }}, 最优 {{ stats.withOptimal }}/{{ stats.total }}
        <template v-if="!cxStore.fetched">(CX 价格加载中…)</template>
      </div>
    </div>

    <SectionHeader>逐建筑(按基地 + 类型聚合)</SectionHeader>
    <table>
      <thead>
        <tr>
          <th></th>
          <th>代码</th>
          <th v-if="isMultiSite">目标</th>
          <th>数量</th>
          <th>年龄</th>
          <th>日产估值</th>
          <th>当前修满成本</th>
          <th>最优间隔</th>
          <th>触发时间</th>
          <th>日均净利润</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="groups.length === 0">
          <td
            :colspan="isMultiSite ? 10 : 9"
            style="text-align: center; opacity: 0.5; padding: 12px">
            无可维修建筑
          </td>
        </tr>
        <template v-for="g in groups" :key="g.naturalId">
          <tr :class="$style.groupRow">
            <td>
              <button
                type="button"
                :class="$style.foldBtn"
                :aria-label="isExpanded(g) ? '折叠' : '展开'"
                @click="toggle(g)">
                {{ isExpanded(g) ? '▼' : '▶' }}
              </button>
            </td>
            <td
              ><strong>{{ g.tickers.join(' + ') }}</strong></td
            >
            <td v-if="isMultiSite">
              <PrunLink :command="`XIT REPP ${g.naturalId}`">{{ g.target }}</PrunLink>
            </td>
            <td>{{ g.count }}</td>
            <td>
              <span :class="g.daysUntilTrigger <= 0 ? C.ColoredValue.negative : ''">
                {{ ageRangeText(g) }}
              </span>
            </td>
            <td>
              <span
                v-if="hasGroupData(g)"
                :data-tooltip="
                  g.count > 1
                    ? `${g.count} 座建筑 per-day 总产值加权求和`
                    : 'PRUNplanner 算法:outputs×Bid − inputs×Ask × maxDailyRuns − 劳动力 − 建造成本/180'
                "
                data-tooltip-position="left"
                >{{ formatCurrency(g.dailyRevenue, fixed1) }}</span
              >
              <span v-else data-tooltip="无活跃生产订单">--</span>
            </td>
            <td>
              <span
                :data-tooltip="g.count > 1 ? `${g.count} 座建筑修满成本的总和` : undefined"
                data-tooltip-position="left"
                >{{
                  formatCurrency(
                    g.members.reduce((s, m) => s + (m.currentRepairCost ?? 0), 0),
                    fixed1,
                  )
                }}</span
              >
            </td>
            <td>
              <span
                v-if="g.optimalDay !== undefined"
                :data-tooltip="
                  '按 PRUNplanner 模型,每 ' + g.optimalDay + ' 天维修一次的日均利润最大'
                "
                data-tooltip-position="left"
                >{{ g.optimalDay }} 天</span
              >
              <span v-else data-tooltip="无日产估值或全建材料">--</span>
            </td>
            <td :class="urgencyClass(g)">
              <span v-if="g.optimalDay !== undefined">{{ triggerText(g) }}</span>
              <span v-else>--</span>
            </td>
            <td>{{ formatCurrency(g.optimalDailyProfit, fixed1) }}</td>
          </tr>
          <template v-if="isExpanded(g)">
            <tr v-for="m in g.members" :key="objectId(m)" :class="$style.memberRow">
              <td></td>
              <td colspan="2" style="text-align: right; opacity: 0.7">↳ {{ m.ticker }}</td>
              <td></td>
              <td :class="m.daysUntilTrigger <= 0 ? C.ColoredValue.negative : ''">
                {{ fixed1(m.ageDays) }} 天
              </td>
              <td></td>
              <td>{{ formatCurrency(m.currentRepairCost, fixed1) }}</td>
              <td colspan="3"></td>
            </tr>
          </template>
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
