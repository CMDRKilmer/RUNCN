<script setup lang="ts">
import { BaseStorageAnalysis } from '@src/core/storage-analysis';
import { computeNeed, getPlanetBurn, getResupplyDays } from '@src/core/burn';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import VisitationTable from '@src/features/XIT/FLEET/VisitationTable.vue';
import { fixed01, fixed0, percent0 } from '@src/utils/format';
import { formatDays } from '@src/features/XIT/FLEET/storage-utils';

const { analysis } = defineProps<{ analysis: BaseStorageAnalysis }>();

interface MaterialRow {
  ticker: string;
  weight: number;
  volume: number;
  amount: number;
}

const planetBurn = computed(() => getPlanetBurn(analysis.siteId));

const shippingOut = computed<MaterialRow[]>(() => {
  const pb = planetBurn.value;
  if (!pb) {
    return [];
  }
  const rows: MaterialRow[] = [];
  for (const ticker of Object.keys(pb.burn)) {
    const mb = pb.burn[ticker];
    if (mb.dailyAmount <= 0 || mb.inventory <= 0) {
      continue;
    }
    const mat = materialsStore.getByTicker(ticker);
    if (!mat) {
      continue;
    }
    rows.push({
      ticker,
      amount: mb.inventory,
      weight: mb.inventory * mat.weight,
      volume: mb.inventory * mat.volume,
    });
  }
  rows.sort((a, b) => b.weight - a.weight);
  return rows;
});

const resupplyDays = computed(() => getResupplyDays(analysis.naturalId));

const adding = computed<MaterialRow[]>(() => {
  const pb = planetBurn.value;
  if (!pb) {
    return [];
  }
  const resupply = resupplyDays.value;
  const rows: MaterialRow[] = [];
  for (const ticker of Object.keys(pb.burn)) {
    const mb = pb.burn[ticker];
    const need = computeNeed(mb, resupply);
    if (need <= 0) {
      continue;
    }
    const mat = materialsStore.getByTicker(ticker);
    if (!mat) {
      continue;
    }
    rows.push({
      ticker,
      amount: need,
      weight: need * mat.weight,
      volume: need * mat.volume,
    });
  }
  rows.sort((a, b) => b.weight - a.weight);
  return rows;
});

const afterShipOutWeightLoad = computed(
  () => analysis.weightCapacity - analysis.availableAfterShipOutWeight,
);
const afterShipOutVolumeLoad = computed(
  () => analysis.volumeCapacity - analysis.availableAfterShipOutVolume,
);

const afterResupplyWeightLoad = computed(
  () => analysis.weightCapacity * analysis.needFillPercentWeight,
);
const afterResupplyVolumeLoad = computed(
  () => analysis.volumeCapacity * analysis.needFillPercentVolume,
);

const fillPercent = computed(() => Math.round((1 - analysis.suppliesReserveFraction) * 100));
const reservePercent = computed(() => Math.round(analysis.suppliesReserveFraction * 100));
const reserveReason = computed(() =>
  analysis.suppliesReserveFraction >= 0.2 ? '产出物料' : '生产波动',
);

const bindingLabel = computed(() => {
  if (analysis.bindingLimit === 't') {
    return '重量(t) 是受限维度';
  }
  if (analysis.bindingLimit === 'm³') {
    return '体积(m³) 是受限维度';
  }
  return '仓储正在排空 — 没有主动填充';
});

const overflowAmount = computed(() => {
  const w = afterResupplyWeightLoad.value - analysis.weightCapacity;
  const v = afterResupplyVolumeLoad.value - analysis.volumeCapacity;
  return { w, v };
});
</script>

<template>
  <div :class="$style.detail">
    <section :class="[$style.panel, $style.blue]">
      <h3 :class="$style.title">填充概览</h3>
      <table :class="$style.numTable">
        <thead>
          <tr>
            <th />
            <th>重量 (t)</th>
            <th>重量 %</th>
            <th>体积 (m³)</th>
            <th>体积 %</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th :class="$style.rowLabel">容量</th>
            <td>{{ fixed0(analysis.weightCapacity) }}</td>
            <td>—</td>
            <td>{{ fixed0(analysis.volumeCapacity) }}</td>
            <td>—</td>
          </tr>
          <tr>
            <th :class="$style.rowLabel">当前</th>
            <td>{{ fixed0(analysis.weightLoad) }}</td>
            <td>{{ percent0(analysis.fillPercentWeight) }}</td>
            <td>{{ fixed0(analysis.volumeLoad) }}</td>
            <td>{{ percent0(analysis.fillPercentVolume) }}</td>
          </tr>
          <tr>
            <th :class="$style.rowLabel">出货后</th>
            <td>{{ fixed0(afterShipOutWeightLoad) }}</td>
            <td>
              {{ percent0(afterShipOutWeightLoad / analysis.weightCapacity) }}
            </td>
            <td>{{ fixed0(afterShipOutVolumeLoad) }}</td>
            <td>
              {{ percent0(afterShipOutVolumeLoad / analysis.volumeCapacity) }}
            </td>
          </tr>
          <tr :class="{ [$style.danger]: analysis.needFillRatio > 1 }">
            <th :class="$style.rowLabel">补给后</th>
            <td>{{ fixed0(afterResupplyWeightLoad) }}</td>
            <td>{{ percent0(analysis.needFillPercentWeight) }}</td>
            <td>{{ fixed0(afterResupplyVolumeLoad) }}</td>
            <td>{{ percent0(analysis.needFillPercentVolume) }}</td>
          </tr>
        </tbody>
      </table>
      <div :class="$style.note">{{ bindingLabel }}。</div>
      <div v-if="overflowAmount.w > 0" :class="[$style.note, $style.alertText]">
        补给后重量溢出:
        <b>超出 {{ fixed0(overflowAmount.w) }} t</b>
      </div>
      <div v-if="overflowAmount.v > 0" :class="[$style.note, $style.alertText]">
        补给后体积溢出:
        <b>超出 {{ fixed0(overflowAmount.v) }} m³</b>
      </div>
      <div v-if="overflowAmount.w <= 0 && overflowAmount.v <= 0" :class="$style.note">
        补给后剩余空间:
        <b>
          {{ fixed0(analysis.weightCapacity - afterResupplyWeightLoad) }} t /
          {{ fixed0(analysis.volumeCapacity - afterResupplyVolumeLoad) }} m³
        </b>
      </div>
      <div :class="$style.note">
        按净产出
        {{ fixed01(analysis.exportWeight - analysis.importWeight) }} t /
        {{ fixed01(analysis.exportVolume - analysis.importVolume) }} m³ 每日计,
        <b>{{ formatDays(analysis.daysUntilFull) }} 天</b>后填满。
      </div>
    </section>

    <section :class="[$style.panel, $style.teal]">
      <h3 :class="$style.title">访问频率</h3>
      <div :class="$style.note"> 给定当前进出速率,各类船型多久需要造访一次。 </div>
      <VisitationTable :analysis="analysis" />
    </section>

    <section :class="[$style.panel, $style.green]">
      <h3 :class="$style.title">可容纳供应天数</h3>
      <div v-if="!isFinite(analysis.daysOfSuppliesFit)" :class="$style.big"> ∞ (无活跃消耗者) </div>
      <div v-else :class="$style.big">{{ fixed01(analysis.daysOfSuppliesFit) }} 天</div>
      <div v-if="isFinite(analysis.daysOfSuppliesFit)" :class="$style.note">
        出货后填到 <b>{{ fillPercent }}%</b>(已扣除 {{ reservePercent }}% 留给 {{ reserveReason }})
        时,基地可容纳的消耗物料总天数。已包含当前库存中的消耗物料。
      </div>
      <div :class="$style.note">当前补给目标: {{ resupplyDays }} 天。</div>
    </section>

    <section :class="[$style.panel, $style.orange]">
      <h3 :class="$style.title">运出 ({{ shippingOut.length }} 种物料)</h3>
      <div v-if="shippingOut.length === 0" :class="$style.empty">暂无产出物料库存。</div>
      <table v-else :class="$style.numTable">
        <thead>
          <tr>
            <th>代码</th>
            <th>数量</th>
            <th>重量 (t)</th>
            <th>体积 (m³)</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in shippingOut" :key="row.ticker">
            <td>{{ row.ticker }}</td>
            <td>{{ fixed0(row.amount) }}</td>
            <td>{{ fixed01(row.weight) }}</td>
            <td>{{ fixed01(row.volume) }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section :class="[$style.panel, $style.purple]">
      <h3 :class="$style.title">补入 — 补给需求 ({{ adding.length }} 种物料)</h3>
      <div v-if="adding.length === 0" :class="$style.empty">当前无需补给。</div>
      <table v-else :class="$style.numTable">
        <thead>
          <tr>
            <th>代码</th>
            <th>需求</th>
            <th>重量 (t)</th>
            <th>体积 (m³)</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in adding" :key="row.ticker">
            <td>{{ row.ticker }}</td>
            <td>{{ fixed0(row.amount) }}</td>
            <td>{{ fixed01(row.weight) }}</td>
            <td>{{ fixed01(row.volume) }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </div>
</template>

<style module>
.detail {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 0.75rem;
  padding: 0.75rem;
}

.panel {
  border-left: 3px solid currentColor;
  border-radius: 3px;
  padding: 0.5rem 0.75rem;
  background-color: rgba(255, 255, 255, 0.03);
}

.title {
  font-size: 11px;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0 0 0.4rem 0;
  color: inherit;
}

.numTable {
  width: 100%;
  font-size: 11px;
}

.numTable th,
.numTable td {
  padding: 2px 6px;
  text-align: right;
}

.numTable th:first-child,
.numTable td:first-child {
  text-align: left;
}

.rowLabel {
  font-weight: normal;
  opacity: 0.8;
}

.note {
  font-size: 11px;
  margin-top: 0.3rem;
  opacity: 0.85;
}

.alertText {
  color: #d9534f;
  font-weight: bold;
  opacity: 1;
}

.big {
  font-size: 14px;
  font-weight: bold;
  margin: 0.2rem 0;
}

.empty {
  font-style: italic;
  opacity: 0.6;
  font-size: 11px;
}

.danger {
  background-color: rgba(217, 83, 79, 0.12);
}

.blue {
  color: #6495ed;
}

.green {
  color: #5cb85c;
}

.orange {
  color: #f0ad4e;
}

.purple {
  color: #b19cd9;
}

.teal {
  color: #5bc0de;
}
</style>
