<script setup lang="ts">
import { ref, computed, watchEffect } from 'vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import PrunButton from '@src/components/PrunButton.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { detectedPositionMessages } from '@src/infrastructure/prun-api/data/system-bodies';
import { getPrice } from '@src/infrastructure/fio/cx';
import { isEmpty } from 'ts-extras';
import { formatCountdown, formatCurrency, fixed2, fixed4 } from '@src/utils/format';
import { runSweep, probeSystemMap, SweepCombo, SweepOutcome } from './flight-query';
import { calibrate, estimateRoute, resolveSystemId, Calibration, RouteResult } from './route-model';
import $style from './FTC.module.css';

// XIT FTC：飞行时间与燃料参数性价比计算器。
// 首段通过离屏 SFC 窗口获得服务器精确结果，多段路线用恒星坐标外推。

interface ResultRow {
  combo: SweepCombo;
  route?: RouteResult;
  plan?: PrunApi.FlightPlan;
  fuelCost?: number;
  damageCost?: number;
  timeCost?: number;
  score?: number;
  error?: string;
}

const MAX_COMBOS = 30;

const registration = ref('');
const waypointsText = ref('');
const fuelText = ref('0.1,0.3,0.5,1');
const reactorText = ref('0.25,0.5,1');

const stlFuelPrice = ref<number | undefined>(undefined);
const ftlFuelPrice = ref<number | undefined>(undefined);
const damageRate = ref<number | undefined>(0);
const timeValue = ref<number | undefined>(0);

const running = ref(false);
const cancelRequested = ref(false);
const progressDone = ref(0);
const progressTotal = ref(0);
const errorMessage = ref<string | undefined>(undefined);
const rows = ref<ResultRow[]>([]);
const selected = ref<ResultRow | undefined>(undefined);
const probeMessage = ref<string | undefined>(undefined);
const probing = ref(false);

const dockedShips = computed(() =>
  (shipsStore.all.value ?? []).filter(x => x.flightId === null && x.address !== null),
);

const ship = computed(() => shipsStore.getByRegistration(registration.value));

// 从飞船燃料仓自动识别燃料材料 ticker。
function storageTicker(storeId?: string | null) {
  if (!storeId) {
    return undefined;
  }
  const store = storagesStore.getById(storeId);
  const item = store?.items.find(x => x.quantity?.material?.ticker !== undefined);
  return item?.quantity?.material.ticker;
}

const fuelTickers = computed(() => ({
  stl: storageTicker(ship.value?.stlFuelStoreId),
  ftl: storageTicker(ship.value?.ftlFuelStoreId),
}));

// 燃料单价自动填充（FIO 价格，按用户定价设置），仅在为空时填一次，允许手动覆盖。
watchEffect(() => {
  if (stlFuelPrice.value === undefined && fuelTickers.value.stl !== undefined) {
    const price = getPrice(fuelTickers.value.stl);
    if (price !== undefined && price > 0) {
      stlFuelPrice.value = price;
    }
  }
  if (ftlFuelPrice.value === undefined && fuelTickers.value.ftl !== undefined) {
    const price = getPrice(fuelTickers.value.ftl);
    if (price !== undefined && price > 0) {
      ftlFuelPrice.value = price;
    }
  }
});

function parseNumbers(text: string) {
  return text
    .split(/[,，\s]+/)
    .map(x => parseFloat(x))
    .filter(x => Number.isFinite(x) && x > 0 && x <= 1);
}

const waypoints = computed(() =>
  waypointsText.value
    .split(/[,，\n]+/)
    .map(x => x.trim())
    .filter(x => x !== ''),
);

const combos = computed<SweepCombo[]>(() => {
  const fuels = parseNumbers(fuelText.value);
  const reactors = parseNumbers(reactorText.value);
  const list: SweepCombo[] = [];
  for (const fuel of fuels) {
    if (reactors.length > 0) {
      for (const reactor of reactors) {
        list.push({ fuel, reactor });
      }
    } else {
      list.push({ fuel });
    }
  }
  return list.slice(0, MAX_COMBOS);
});

function singleLegRoute(cal: Calibration, destination: string): RouteResult {
  return {
    legs: [
      {
        from: '(当前位置)',
        to: destination,
        precise: true,
        durationMs: cal.totalMs,
        stlFuel: cal.stlFuel,
        ftlFuel: cal.ftlFuel,
        damage: cal.damage,
      },
    ],
    totalMs: cal.totalMs,
    totalStlFuel: cal.stlFuel,
    totalFtlFuel: cal.ftlFuel,
    totalDamage: cal.damage,
    allPrecise: true,
  };
}

function buildRow(outcome: SweepOutcome): ResultRow {
  if (!outcome.plan) {
    return { combo: outcome.combo, error: outcome.error ?? '查询失败' };
  }
  const cal = calibrate(outcome.plan);
  const route =
    waypoints.value.length > 1
      ? estimateRoute(cal, waypoints.value)
      : singleLegRoute(cal, waypoints.value[0]);
  const fuelCost =
    route.totalStlFuel * (stlFuelPrice.value ?? 0) + route.totalFtlFuel * (ftlFuelPrice.value ?? 0);
  // 损伤按船体条件百分比计费（segment.damage 为 0–1 分数）。
  const damageCost = route.totalDamage * 100 * (damageRate.value ?? 0);
  const timeCost = (route.totalMs / 3600000) * (timeValue.value ?? 0);
  return {
    combo: outcome.combo,
    route,
    plan: outcome.plan,
    fuelCost,
    damageCost,
    timeCost,
    score: fuelCost + damageCost + timeCost,
  };
}

async function start() {
  if (running.value) {
    return;
  }
  errorMessage.value = undefined;
  selected.value = undefined;
  if (!ship.value) {
    errorMessage.value = '请选择飞船';
    return;
  }
  if (waypoints.value.length === 0) {
    errorMessage.value = '请至少输入一个目的地航点';
    return;
  }
  if (combos.value.length === 0) {
    errorMessage.value = '请输入有效的参数组合（0–1 之间）';
    return;
  }

  running.value = true;
  cancelRequested.value = false;
  progressDone.value = 0;
  progressTotal.value = combos.value.length;
  rows.value = [];

  try {
    const outcomes = await runSweep(registration.value, waypoints.value[0], combos.value, {
      onProgress: (done, total) => {
        progressDone.value = done;
        progressTotal.value = total;
      },
      isCancelled: () => cancelRequested.value,
    });
    rows.value = outcomes.map(buildRow);
  } catch (e: unknown) {
    errorMessage.value = e instanceof Error ? e.message : String(e);
  } finally {
    running.value = false;
  }
}

function cancel() {
  cancelRequested.value = true;
}

// 行排序：无错误且评分最小的排最前；评分全为 0（未配置成本）时按时长排序。
const sortedRows = computed(() => {
  const ok = rows.value.filter(x => x.error === undefined);
  const failed = rows.value.filter(x => x.error !== undefined);
  const hasScore = ok.some(x => (x.score ?? 0) > 0);
  ok.sort((a, b) =>
    hasScore ? (a.score ?? 0) - (b.score ?? 0) : (a.route?.totalMs ?? 0) - (b.route?.totalMs ?? 0),
  );
  return [...ok, ...failed];
});

const probeSystem = computed(() => resolveSystemId(waypoints.value[0] ?? ''));

async function probe() {
  const systemId = probeSystem.value;
  if (!systemId || probing.value) {
    return;
  }
  probing.value = true;
  try {
    const found = await probeSystemMap(systemId);
    probeMessage.value =
      found > 0
        ? `在 ${systemId} 捕获 ${found} 个天体位置（消息类型：${detectedPositionMessages.value.join(', ')}），多段估算已启用行星位置修正`
        : `在 ${systemId} 未捕获到天体位置数据（MS 可能不下发位置，或多段估算已降级为常数外推）`;
  } catch (e: unknown) {
    probeMessage.value = e instanceof Error ? e.message : String(e);
  } finally {
    probing.value = false;
  }
}

function formatDuration(ms: number) {
  return formatCountdown(ms);
}

function formatDamage(fraction: number) {
  return `${fixed2(fraction * 100)}%`;
}

function formatFuel(value: number) {
  return fixed4(value);
}
</script>

<template>
  <LoadingSpinner v-if="!shipsStore.fetched" />
  <div v-else :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <SectionHeader>飞行时间计算器（FTC）</SectionHeader>

    <div :class="$style.form">
      <label :class="$style.field">
        <span>飞船</span>
        <select v-model="registration" :class="$style.select">
          <option value="" disabled>选择停靠中的飞船</option>
          <option v-for="s in dockedShips" :key="s.id" :value="s.registration">
            {{ s.registration }}（{{ s.name }}）
          </option>
        </select>
      </label>

      <label :class="$style.field">
        <span>航点（逗号或换行分隔，首个为精确查询目的地）</span>
        <textarea v-model="waypointsText" rows="2" placeholder="如：KW-655c, KW-013c" />
      </label>

      <div :class="$style.fieldRow">
        <label :class="$style.field">
          <span>燃料消耗组合（0–1）</span>
          <TextInput v-model="fuelText" />
        </label>
        <label :class="$style.field">
          <span>反应堆使用量组合（0–1）</span>
          <TextInput v-model="reactorText" />
        </label>
      </div>

      <details :class="$style.costDetails">
        <summary>成本参数（性价比评分）</summary>
        <div :class="$style.fieldRow">
          <label :class="$style.field">
            <span>STL 燃料单价{{ fuelTickers.stl ? `（${fuelTickers.stl}）` : '' }}</span>
            <NumberInput v-model="stlFuelPrice" optional />
          </label>
          <label :class="$style.field">
            <span>FTL 燃料单价{{ fuelTickers.ftl ? `（${fuelTickers.ftl}）` : '' }}</span>
            <NumberInput v-model="ftlFuelPrice" optional />
          </label>
        </div>
        <div :class="$style.fieldRow">
          <label :class="$style.field">
            <span>损伤修理费（₳/1% 船体）</span>
            <NumberInput v-model="damageRate" optional />
          </label>
          <label :class="$style.field">
            <span>时间价值（₳/小时）</span>
            <NumberInput v-model="timeValue" optional />
          </label>
        </div>
      </details>

      <div :class="$style.actions">
        <PrunButton primary :disabled="running" @click="start">开始扫描</PrunButton>
        <PrunButton v-if="running" danger @click="cancel">取消</PrunButton>
        <PrunButton
          neutral
          :disabled="probing || probeSystem === undefined"
          data-tooltip="打开隐藏的星系地图窗口，捕获行星位置数据以改进多段估算精度"
          @click="probe">
          探测行星位置
        </PrunButton>
        <span v-if="running" :class="$style.progress">
          {{ progressDone }}/{{ progressTotal }}（后台查询中，请勿关闭游戏页面）
        </span>
      </div>

      <div v-if="probeMessage" :class="$style.hint">{{ probeMessage }}</div>
      <div v-if="errorMessage" :class="$style.error">{{ errorMessage }}</div>
    </div>

    <table v-if="!isEmpty(sortedRows)" :class="$style.table">
      <thead>
        <tr>
          <th>燃料消耗</th>
          <th>反应堆</th>
          <th>总时长</th>
          <th>STL 燃料</th>
          <th>FTL 燃料</th>
          <th>损伤</th>
          <th>燃料费</th>
          <th>修理费</th>
          <th>时间成本</th>
          <th>评分</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="(row, i) in sortedRows"
          :key="`${row.combo.fuel}-${row.combo.reactor ?? ''}`"
          :class="[$style.row, { [$style.best]: i === 0 && row.error === undefined }]"
          @click="selected = row">
          <template v-if="row.error === undefined && row.route">
            <td>{{ row.combo.fuel }}</td>
            <td>{{ row.combo.reactor ?? '--' }}</td>
            <td>{{ row.route.allPrecise ? '' : '≈' }}{{ formatDuration(row.route.totalMs) }}</td>
            <td>{{ formatFuel(row.route.totalStlFuel) }}</td>
            <td>{{ formatFuel(row.route.totalFtlFuel) }}</td>
            <td>{{ formatDamage(row.route.totalDamage) }}</td>
            <td>{{ formatCurrency(row.fuelCost ?? 0) }}</td>
            <td>{{ formatCurrency(row.damageCost ?? 0) }}</td>
            <td>{{ formatCurrency(row.timeCost ?? 0) }}</td>
            <td>{{ formatCurrency(row.score ?? 0) }}</td>
          </template>
          <td v-else colspan="10" :class="$style.error">
            燃料 {{ row.combo.fuel }} / 反应堆 {{ row.combo.reactor ?? '--' }}：{{ row.error }}
          </td>
        </tr>
      </tbody>
    </table>

    <div v-if="selected && selected.route" :class="$style.detail">
      <SectionHeader>
        组合详情：燃料 {{ selected.combo.fuel }} / 反应堆 {{ selected.combo.reactor ?? '--' }}
      </SectionHeader>
      <table :class="$style.table">
        <thead>
          <tr>
            <th>段</th>
            <th>起点 → 终点</th>
            <th>时长</th>
            <th>精度</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(leg, i) in selected.route.legs" :key="i">
            <td>{{ i + 1 }}</td>
            <td>{{ leg.from }} → {{ leg.to }}</td>
            <td>{{ leg.precise ? '' : '≈' }}{{ formatDuration(leg.durationMs) }}</td>
            <td>{{ leg.precise ? '服务器精确' : '外推估算' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="selected.plan" :class="$style.hint">
        首段分段明细（服务器）：{{ selected.plan.segments.map(s => s.type).join(' → ') }}
      </div>
    </div>
  </div>
</template>
