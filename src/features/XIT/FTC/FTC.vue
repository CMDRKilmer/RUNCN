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
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { getPrice } from '@src/infrastructure/fio/cx';
import { ensureOrbitData } from '@src/infrastructure/fio/orbit';
import { convertToPlanetNaturalId } from '@src/core/planet-natural-id';
import { isEmpty } from 'ts-extras';
import { formatCountdown, formatCurrency, fixed2, fixed4 } from '@src/utils/format';
import {
  runSweep,
  captureBodyPositions,
  captureAnchor,
  SweepCombo,
  SweepOutcome,
} from './flight-query';
import {
  calibrate,
  estimateRoute,
  scaleCalibration,
  Calibration,
  RouteResult,
} from './route-model';
import { anchorFromPlan, anchorMatchesRoute, getAnchor, saveAnchor, ShipAnchor } from './anchor';
import $style from './FTC.module.css';

// XIT FTC：飞行时间与燃料参数性价比计算器。
// 两种计算模式：
// - 本地计算（默认）：一份「标定计划」+ 飞船性能物理关系（scaleCalibration）
//   本地推算所有参数组合，不写滑块。标定是针对「当前飞船位置 → 首航点」
//   这条航线的服务器精确结果：航线一致（含被动捕获/上次扫描）时复用缓存，
//   否则打开一次离屏 SFC 窗口重新捕获（只选目的地，不写滑块）。
// - 服务器扫描：离屏 SFC 窗口逐组写入滑块获得服务器精确结果。

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
const mode = ref<'local' | 'server'>('local');
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
const anchorMessage = ref<string | undefined>(undefined);
// 对照诊断用：当前生效的标定锚点（本地模式）。展示其原始服务器值，
// 与当前飞船性能并列，用于定位本地计算与服务器不一致的来源。
const activeAnchor = ref<ShipAnchor | undefined>(undefined);

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

function buildRowFromRoute(
  combo: SweepCombo,
  route: RouteResult,
  plan?: PrunApi.FlightPlan,
): ResultRow {
  const fuelCost =
    route.totalStlFuel * (stlFuelPrice.value ?? 0) + route.totalFtlFuel * (ftlFuelPrice.value ?? 0);
  // 损伤按船体条件百分比计费（segment.damage 为 0–1 分数）。
  const damageCost = route.totalDamage * 100 * (damageRate.value ?? 0);
  const timeCost = (route.totalMs / 3600000) * (timeValue.value ?? 0);
  return {
    combo,
    route,
    plan,
    fuelCost,
    damageCost,
    timeCost,
    score: fuelCost + damageCost + timeCost,
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
  return buildRowFromRoute(outcome.combo, route, outcome.plan);
}

// 本地计算：锚点是「当前航线」的服务器标定，首段直接使用标定数据
// （精确），仅按参数组合缩放；续航段由 estimateRoute 距离外推（≈）。
function buildLocalRow(anchor: ShipAnchor, combo: SweepCombo): ResultRow {
  const cal = scaleCalibration(
    anchor.cal,
    { fuel: anchor.fuel, reactor: anchor.reactor ?? 1, mass: anchor.mass },
    { fuel: combo.fuel, reactor: combo.reactor, mass: ship.value!.mass },
  );
  const route = estimateRoute(cal, waypoints.value);
  return buildRowFromRoute(combo, route);
}

function anchorStatusLabel(anchor: ShipAnchor, source: string) {
  const captured = new Date(anchor.capturedMs).toLocaleString();
  const route = `${anchor.originEntity ?? '?'} → ${anchor.destinationEntity ?? '?'}`;
  const massNote =
    anchor.mass !== undefined && ship.value && ship.value.mass !== anchor.mass
      ? ` · 装载修正 √(${fixed2(ship.value.mass)}/${fixed2(anchor.mass)})`
      : '';
  return `标定航线 ${route}：燃料 ${anchor.fuel} / 反应堆 ${anchor.reactor ?? '--'} · ${source}（${captured}）${massNote}`;
}

async function start() {
  if (running.value) {
    return;
  }
  errorMessage.value = undefined;
  anchorMessage.value = undefined;
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
  activeAnchor.value = undefined;

  try {
    // 预取航点行星的 FIO 轨道根数（含缓存），供多段估算的轨道位置预测。
    // 失败不阻塞扫描（估算自动降级为静态坐标）。
    await ensureOrbitData(waypoints.value).catch(() => undefined);

    if (mode.value === 'local') {
      // 本地计算：缓存锚点仅在航线匹配（飞船当前位置 + 首航点）时复用，
      // 否则重新捕获——离屏窗口只选目的地、被动读滑块，不写入。
      const shipLocation = getEntityNaturalIdFromAddress(ship.value.address);
      const destId = convertToPlanetNaturalId(waypoints.value[0]) ?? waypoints.value[0];
      let anchor = getAnchor(registration.value);
      let source: string;
      if (anchor !== undefined && anchorMatchesRoute(anchor, shipLocation, destId)) {
        source = '缓存';
      } else {
        anchor = undefined;
        progressTotal.value = 1;
        const captured = await captureAnchor(registration.value, waypoints.value[0], {
          isCancelled: () => cancelRequested.value,
        });
        anchor = anchorFromPlan(
          registration.value,
          captured.plan,
          captured.fuel,
          captured.reactor,
          ship.value!.mass,
        );
        saveAnchor(anchor);
        source = '本次捕获';
        progressDone.value = 1;
        progressTotal.value = combos.value.length;
      }
      anchorMessage.value = anchorStatusLabel(anchor, source);
      activeAnchor.value = anchor;
      rows.value = combos.value.map(combo => buildLocalRow(anchor!, combo));
    } else {
      const outcomes = await runSweep(registration.value, waypoints.value[0], combos.value, {
        // 扫描结束后自动切换到后续航点，捕获天体位置供多段估算使用。
        probeDestinations: waypoints.value.slice(1),
        onProgress: (done, total) => {
          progressDone.value = done;
          progressTotal.value = total;
        },
        isCancelled: () => cancelRequested.value,
      });
      // 每组服务器精确结果都是高质量标定锚点，保存供本地计算复用。
      for (const outcome of outcomes) {
        if (outcome.plan !== undefined) {
          saveAnchor(
            anchorFromPlan(
              registration.value,
              outcome.plan,
              outcome.combo.fuel,
              outcome.combo.reactor,
              ship.value?.mass,
            ),
          );
        }
      }
      rows.value = outcomes.map(buildRow);
    }
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

async function probe() {
  if (!registration.value || waypoints.value.length === 0 || probing.value) {
    return;
  }
  probing.value = true;
  try {
    const found = await captureBodyPositions(registration.value, waypoints.value);
    probeMessage.value =
      found > 0
        ? `捕获 ${found} 个天体位置（来源：${detectedPositionMessages.value.join(', ')}），多段估算已启用行星位置修正`
        : '未捕获到天体位置（飞行计划中可能不含轨迹数据，多段估算按常数外推）';
  } catch (e: unknown) {
    probeMessage.value = e instanceof Error ? e.message : String(e);
  } finally {
    probing.value = false;
  }
}

function formatDuration(ms: number) {
  return formatCountdown(ms);
}

function precisionLabel(leg: RouteResult['legs'][number]) {
  if (leg.precise) {
    return '服务器精确';
  }
  return leg.orbitPredicted ? '轨道预测' : '外推估算';
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
        <span>计算模式</span>
        <select v-model="mode" :class="$style.select">
          <option value="local">本地计算（飞船性能缩放，不写滑块）</option>
          <option value="server">服务器扫描（逐组精确查询）</option>
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
        <PrunButton primary :disabled="running" @click="start">
          {{ mode === 'local' ? '开始计算' : '开始扫描' }}
        </PrunButton>
        <PrunButton v-if="running" danger @click="cancel">取消</PrunButton>
        <PrunButton
          neutral
          :disabled="probing || registration === '' || waypoints.length === 0"
          data-tooltip="通过离屏 SFC 窗口查询各航点的飞行计划，从轨迹数据捕获天体位置以改进多段估算精度（开始扫描时也会自动捕获）"
          @click="probe">
          捕获天体位置
        </PrunButton>
        <span v-if="running" :class="$style.progress">
          {{ progressDone }}/{{ progressTotal }}（后台查询中，请勿关闭游戏页面）
        </span>
      </div>

      <div
        v-if="anchorMessage"
        :class="$style.hint"
        data-tooltip="本地计算基于一份已知参数的服务器标定计划，按飞船性能物理关系（推力∝燃料滑块、充能/跃迁速度∝反应堆使用量）缩放到各参数组合"
        >{{ anchorMessage }}</div
      >
      <details v-if="activeAnchor" :class="$style.diagnostic">
        <summary>对照诊断（锚点原始服务器值 vs 当前飞船）</summary>
        <table :class="$style.table">
          <thead>
            <tr>
              <th>项目</th>
              <th>锚点（捕获时）</th>
              <th>当前飞船</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>燃料消耗滑块</td>
              <td>{{ activeAnchor.fuel }}</td>
              <td>--</td>
            </tr>
            <tr>
              <td>反应堆使用量</td>
              <td>{{ activeAnchor.reactor ?? '--' }}</td>
              <td>--</td>
            </tr>
            <tr>
              <td>质量 (t)</td>
              <td>{{ activeAnchor.mass ?? '--' }}</td>
              <td>{{ ship?.mass ?? '--' }}</td>
            </tr>
            <tr>
              <td>STL 燃料消耗</td>
              <td>{{ formatFuel(activeAnchor.cal.stlFuel) }}</td>
              <td>--</td>
            </tr>
            <tr>
              <td>FTL 燃料消耗</td>
              <td>{{ formatFuel(activeAnchor.cal.ftlFuel) }}</td>
              <td>--</td>
            </tr>
            <tr>
              <td>STL 时长</td>
              <td>{{ formatDuration(activeAnchor.cal.stlMs) }}</td>
              <td>--</td>
            </tr>
            <tr>
              <td>充能时长</td>
              <td>{{ formatDuration(activeAnchor.cal.chargeMs) }}</td>
              <td>--</td>
            </tr>
            <tr>
              <td>跃迁时长</td>
              <td>{{ formatDuration(activeAnchor.cal.jumpMs) }}</td>
              <td>--</td>
            </tr>
            <tr>
              <td>总时长</td>
              <td>{{ formatDuration(activeAnchor.cal.totalMs) }}</td>
              <td>--</td>
            </tr>
            <tr>
              <td>STL 距离</td>
              <td>{{ activeAnchor.cal.stlDistance }}</td>
              <td>--</td>
            </tr>
            <tr>
              <td>stlFuelFlowRate</td>
              <td>--</td>
              <td>{{ ship?.stlFuelFlowRate ?? '--' }}</td>
            </tr>
            <tr>
              <td>加速度 (m/s²)</td>
              <td>--</td>
              <td>{{ ship?.acceleration ?? '--' }}</td>
            </tr>
            <tr>
              <td>整备质量 (t)</td>
              <td>--</td>
              <td>{{ ship?.operatingEmptyMass ?? '--' }}</td>
            </tr>
            <tr>
              <td>船体条件</td>
              <td>--</td>
              <td>{{ ship?.condition ?? '--' }}</td>
            </tr>
          </tbody>
        </table>
      </details>
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
            <td>{{ precisionLabel(leg) }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="selected.plan" :class="$style.hint">
        首段分段明细（服务器）：{{ selected.plan.segments.map(s => s.type).join(' → ') }}
      </div>
    </div>
  </div>
</template>
