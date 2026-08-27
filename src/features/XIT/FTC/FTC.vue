<script setup lang="ts">
import { ref, computed, watchEffect } from 'vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import PrunButton from '@src/components/PrunButton.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { getPrice } from '@src/infrastructure/fio/cx';
import { exportStlSegments } from '@src/infrastructure/prun-api/data/system-bodies';
import {
  collectAllPlanetStl,
  clearCollectProgress,
  collectProgressCount,
} from '@src/infrastructure/prun-api/data/flight-test-collector';
import {
  orbitStore,
  prefetchAllOrbits,
  exportAllPlanetData,
  exportStationOrbits,
} from '@src/infrastructure/fio/orbit';
import { routesStore } from '@src/infrastructure/fio/routes';
import { downloadFile } from '@src/utils/dom';
import ProgressBar from '@src/components/ProgressBar.vue';
import { formatCurrency, fixed2, fixed4 } from '@src/utils/format';
import {
  PlannedRoute,
  RouteSegmentRow,
  findNativeFlightPlan,
  buildNativeSegmentRows,
  buildEstimatedSegmentRows,
} from './route-planner';
import {
  computeFtcPlan,
  shipPerformanceFor,
  blueprintInfoFor,
  FtcComputeOutput,
} from './ftc-compute';
import { FuelOption } from './fuel-model';
import $style from './FTC.module.css';

// XIT FTC：飞船性能驱动的飞行燃料性价比计算器。
// - 输入起终点 + 网关开关（玩家自选），规划航线（自然/网关）
// - 用飞船实时性能（质量/加速度/船体条件）+ 经验模型扫描燃料/反应堆滑块
// - 输出最优最性价比的燃料消耗方案（燃料费 + 时间价值）
// - 保留星球/网关数据获取与导出工具

// ---- 数据工具（保留）----
const prefetching = ref(false);
async function prefetchOrbits() {
  prefetching.value = true;
  try {
    await prefetchAllOrbits();
  } finally {
    prefetching.value = false;
  }
}
const exporting = ref(false);
const exportDone = ref(0);
const exportTotal = ref(0);
const exportLog = ref<string[]>([]);
async function exportPlanets() {
  exporting.value = true;
  exportDone.value = 0;
  exportTotal.value = 0;
  exportLog.value = [];
  try {
    const result = await exportAllPlanetData(
      (done, total) => {
        exportDone.value = done;
        exportTotal.value = total;
      },
      message => {
        exportLog.value = [...exportLog.value, message];
      },
    );
    downloadFile(result.data, 'prun-all-planets.json', true);
  } finally {
    exporting.value = false;
  }
}
const gatewayMessage = ref<string | undefined>(undefined);
function checkGateways() {
  const n = routesStore.gatewayCount;
  const c = routesStore.gatewayConnectionCount;
  if (n > 0 || c > 0) {
    const parts: string[] = [];
    if (n > 0) {
      parts.push(`已加载 ${n} 个网关（打开星图后自动读取）`);
    }
    if (c > 0) {
      parts.push(`已提取 ${c} 条网关连接（飞行计划/名称配对自动记录）`);
    }
    gatewayMessage.value = parts.join('；') + '，可直接导出';
    return;
  }
  gatewayMessage.value =
    '暂无网关数据：请打开一次星图（星系地图）读取网关实体，或执行一次网关飞行（自动记录网关连接）';
}
function exportGateways() {
  const data = routesStore.getAllGateways();
  if (data.length === 0) {
    gatewayMessage.value = '暂无网关数据：请先打开一次星图（星系地图），再导出';
    return;
  }
  downloadFile(data, 'prun-gateways.json', true);
}
// 导出已积累的空间站数据（轨道 + 归属星系），供 build-station-data.mjs 精简内置。
// FIO 无空间站数据端点，空间站轨道只能靠游戏内星系详情（DATA_DATA celestialBodies）
// 与访问过的空间站（stationsStore）积累；导出后内置到 public/json/stations.json，
// FTC 即可离线解析空间站起终点并预测其位置。
function exportStations() {
  const data = exportStationOrbits();
  if (data.length === 0) {
    gatewayMessage.value =
      '暂无空间站数据：请先在游戏里打开含空间站的星系详情（积累轨道），或访问空间站后重试';
    return;
  }
  downloadFile(data, 'prun-stations.json', true);
  gatewayMessage.value = `已导出 ${data.length} 个空间站（轨道+归属星系）；运行 build-station-data.mjs 精简后内置`;
}
// 导出已积累的 STL 段数据（原生离港/进近段距离，SFC/BTF 计划时自动记录），
// 供 build-stl-data.mjs 精简内置到 public/json/stl-segments.json。内置后 FTC
// 对所有已采集航线精确复现原生 STL 路程，运行中记录继续校准。
function exportStlSegmentsData() {
  const data = exportStlSegments();
  if (data.depart.length === 0 && data.approach.length === 0) {
    gatewayMessage.value =
      '暂无 STL 段数据：请先在 SFC/BTF 计划过相关航线（离港/进近段会自动记录），再导出';
    return;
  }
  downloadFile(data, 'prun-stl-segments.json', true);
  gatewayMessage.value =
    `已导出 ${data.depart.length} 条离港 + ${data.approach.length} 条进近；` +
    '运行 node scripts/build-stl-data.mjs <文件> 精简后内置';
}
// ---- 全部星球 STL 自动采集 ----
// 通过游戏 socket 主动请求 SHIP_FLIGHT_CALCULATE_TEST_FLIGHT（无需打开 BTF），
// 为内置 4155 行星逐个计算离港（行星→探针）与进近（探针→行星）原生 STL 距离，
// 响应自动进入 stlSegmentsStore；支持并发/停止/断点续采，完成后导出内置。
const collecting = ref(false);
const collectCancelled = ref(false);
const collectDone = ref(0);
const collectTotal = ref(0);
const collectCurrent = ref('');
const collectMessage = ref('');
const collectProbe = ref('VH-192c');

async function startCollect() {
  collecting.value = true;
  collectCancelled.value = false;
  collectMessage.value = '';
  try {
    const result = await collectAllPlanetStl({
      probe: collectProbe.value.trim() || 'VH-192c',
      concurrency: 4,
      onProgress: info => {
        collectDone.value = info.done;
        collectTotal.value = info.total;
        collectCurrent.value = info.current;
        collectMessage.value = info.message;
      },
      shouldCancel: () => collectCancelled.value,
    });
    collectMessage.value = result.cancelled
      ? `已停止：完成 ${result.ok} 个（失败 ${result.failed.length}）。再次采集会从断点继续。`
      : `采集完成：成功 ${result.ok} 个，失败 ${result.failed.length} 个` +
        (result.failed.length > 0 ? `（${result.failed.slice(0, 6).join('、')}…）` : '') +
        '。请点「导出 STL 段数据」后把文件发给我内置';
  } catch (e) {
    collectMessage.value = '采集失败：' + String(e);
  } finally {
    collecting.value = false;
  }
}

function stopCollect() {
  collectCancelled.value = true;
}

function resetCollectProgress() {
  clearCollectProgress();
  collectDone.value = 0;
  collectTotal.value = 0;
  collectMessage.value = '已清空采集断点，下次从头开始';
}
// ---- 燃料性价比计算器 ----
const registration = ref('');
const routeFrom = ref('');
const routeTo = ref('');
// 网关开关：玩家自选是否走网关跃迁（网关不耗 FTL 燃料，但可能收现金）。
const useGateway = ref(false);
const stlFuelPrice = ref<number | undefined>(undefined);
const ftlFuelPrice = ref<number | undefined>(undefined);
const timeValue = ref<number | undefined>(0);

const dockedShips = computed(() =>
  (shipsStore.all.value ?? []).filter(x => x.flightId === null && x.address !== null),
);
const ship = computed(() => shipsStore.getByRegistration(registration.value));
// 蓝图性能（FTL 最大航速、STL 引擎、FTL 充能/燃料参数）——提取逻辑在 ftc-compute 共享模块。
const blueprintInfo = computed(() => (ship.value ? blueprintInfoFor(ship.value) : undefined));

// 从飞船燃料仓自动识别燃料材料 ticker，用于自动填价。
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

interface PlanResult {
  label: string;
  route: PlannedRoute;
  metrics: NonNullable<FtcComputeOutput['metrics']>;
  best: FuelOption;
  // 是否有自然跃迁（否 = 全程系内/纯网关飞行，反应堆滑块不影响结果，无需计算）。
  reactorRelevant: boolean;
  // 完整航线段（严格按游戏 SFC 表格）：优先服务器原生飞行计划，否则模型估算。
  segments: RouteSegmentRow[];
  segmentsNative: boolean;
}

const result = ref<PlanResult | undefined>(undefined);
const calcMessage = ref<string | undefined>(undefined);

async function planAndCompute() {
  calcMessage.value = undefined;
  result.value = undefined;
  const from = routeFrom.value.trim();
  const to = routeTo.value.trim();
  if (!from || !to) {
    calcMessage.value = '请输入起点和终点';
    return;
  }
  const s = ship.value;
  if (!s) {
    calcMessage.value = '请选择停靠中的飞船';
    return;
  }
  // 计算编排（蓝图等待/星系浏览/滑块扫描）在 ftc-compute 共享模块，FTC 面板与 SFC 自动计算共用。
  const out = await computeFtcPlan({
    shipRegistration: registration.value,
    from,
    to,
    useGateway: useGateway.value,
    stlPrice: stlFuelPrice.value,
    ftlPrice: ftlFuelPrice.value,
    timeValue: timeValue.value,
    onProgress: msg => {
      calcMessage.value = msg;
    },
  });
  if (!out.ok) {
    calcMessage.value = out.message;
    return;
  }
  const route = out.route!;
  const metrics = out.metrics!;
  const best = out.best!;
  const reactorRelevant = out.reactorRelevant ?? false;
  const perf = shipPerformanceFor(s);
  // 完整航线段（严格按游戏 SFC 表格）：
  // 优先复用服务器原生飞行计划（flightPlansStore 捕获的 SHIP_FLIGHT_MISSION，
  // 与 SFC 表格逐段一致）；无原生计划时用模型估算分段。
  // 用解析后的起/终点实体（非原始输入别名）匹配，输入 'Euu'/'Liuli Central Sector - Euu'
  // 等别名也能命中原生计划。
  const nativePlan = findNativeFlightPlan(route.fromBody ?? from, route.toBody ?? to);
  let segments: RouteSegmentRow[];
  let segmentsNative: boolean;
  if (nativePlan) {
    segments = buildNativeSegmentRows(nativePlan);
    segmentsNative = true;
  } else {
    segments = buildEstimatedSegmentRows(route, metrics, perf, best.fuel, best.reactor, {
      landingRadius: out.landingRadius,
      landingPressure: out.landingPressure,
      departureRadius: out.departureRadius,
      departurePressure: out.departurePressure,
    });
    segmentsNative = false;
  }
  result.value = {
    label: route.label,
    route,
    metrics,
    best,
    reactorRelevant,
    segments,
    segmentsNative,
  };
  const radiusText =
    out.landingRadius !== undefined ? `，目的地半径 ${fixed2v(out.landingRadius)}km` : '';
  const fuelText =
    best.fuelEstimated && (best.stlFuel > 0 || best.ftlFuel > 0)
      ? `，STL ${Math.round(best.stlFuel)} + FTL ${Math.round(best.ftlFuel)} 燃料`
      : '';
  const reactorText = reactorRelevant ? ` / 反应堆 ${best.reactor}` : '';
  calcMessage.value =
    `最优方案（平衡点）：燃料滑块 ${best.fuel}` +
    reactorText +
    `，预计 ${formatDuration(best.totalHours * 3600000)}` +
    fuelText +
    `，总成本 ${formatCurrency(best.totalCost)}` +
    radiusText +
    (useGateway.value && metrics.gwCount > 0
      ? '（网关航线：FTL 燃料为 0）'
      : useGateway.value
        ? '（未找到可用网关，已按自然航线计算）'
        : '');
}

// 精确时长（中文单位，完整精度）：≥1 天显示 天/小时/分钟，<1 天显示 小时/分钟/秒。
// 例：1天 7小时 26分钟、7小时 26分钟 35秒、26分钟 35秒、35秒。
function formatPreciseDuration(ms: number) {
  if (ms <= 0) {
    return '--';
  }
  const totalSec = Math.floor(ms / 1000);
  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) {
    return `${days}天 ${hours}小时 ${minutes}分钟`;
  }
  if (hours > 0) {
    return `${hours}小时 ${minutes}分钟 ${seconds}秒`;
  }
  if (minutes > 0) {
    return `${minutes}分钟 ${seconds}秒`;
  }
  return `${seconds}秒`;
}

// 总时长（最优方案表 / 计算提示）：精确到 天/时/分（≥1 天）或 时/分/秒（<1 天）。
function formatDuration(ms: number) {
  return formatPreciseDuration(ms);
}
function formatFuel(value: number) {
  return fixed4(value);
}
function fixed2v(value: number) {
  return fixed2(value);
}

// 分段耗时：与 SFC 表格一致，中文单位完整精度（如 "21分钟 1秒"、"2小时 14分钟 58秒"）。
function formatSegmentDuration(ms: number) {
  return formatPreciseDuration(ms);
}
// 分段损伤：SFC 表格显示百分比（如 "0.018%"）。
function formatDamage(damage: number) {
  if (damage <= 0) {
    return '--';
  }
  return `${(damage * 100).toFixed(3)}%`;
}
// 分段燃料消耗：与 SFC 表格一致（如 "87 低光速 + 20 超光速"）。
function formatSegmentFuel(stlFuel?: number, ftlFuel?: number) {
  const parts: string[] = [];
  if (stlFuel !== undefined && stlFuel > 0) {
    parts.push(`${Math.round(stlFuel)} 低光速`);
  }
  if (ftlFuel !== undefined && ftlFuel > 0) {
    parts.push(`${Math.round(ftlFuel)} 超光速`);
  }
  return parts.length > 0 ? parts.join(' + ') : '--';
}

// 平衡点说明（结果表提示）：设了时间价值按总成本，否则按 Pareto 拐点折衷。
const balanceNote = computed(() => {
  const tv = timeValue.value ?? 0;
  return tv > 0 ? '按总成本（燃料费 + 时间价值）最优' : '快与省油的折衷（Pareto 拐点）';
});
</script>

<template>
  <LoadingSpinner v-if="!shipsStore.fetched" />
  <div v-else :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <SectionHeader>飞行燃料性价比计算器（FTC）</SectionHeader>

    <div :class="$style.form">
      <label :class="$style.field">
        <span>飞船（自动读取性能：质量/加速度/船体条件）</span>
        <select v-model="registration" :class="$style.select">
          <option value="" disabled>选择停靠中的飞船</option>
          <option v-for="s in dockedShips" :key="s.id" :value="s.registration">
            {{ s.registration }}（{{ s.name }}）
          </option>
        </select>
      </label>
      <div v-if="blueprintInfo" :class="$style.hint">
        蓝图 {{ ship?.blueprintNaturalId }} ｜ STL 引擎 {{ blueprintInfo.stlEngine ?? '未知' }} ｜
        罐 {{ blueprintInfo.stlFuelCapacity ?? '--' }} ｜ G
        {{ blueprintInfo.maxGFactor ?? '--' }} ｜ 加速 {{ ship?.acceleration ?? '--' }} m/s² ｜ 空重
        {{ ship?.operatingEmptyMass ?? '--' }}t ｜ 流量 {{ ship?.stlFuelFlowRate ?? '--' }} u/s ｜
        FTL {{ fixed2v(blueprintInfo.ftlMaxSpeed ?? 0) }} pc/h
      </div>

      <div :class="$style.fieldRow">
        <label :class="$style.field">
          <span>起点（空间站/行星/星系）</span>
          <TextInput v-model="routeFrom" placeholder="如：HRT 或 VH-331" />
        </label>
        <label :class="$style.field">
          <span>终点</span>
          <TextInput v-model="routeTo" placeholder="如：MOR 或 OT-580" />
        </label>
      </div>

      <div :class="$style.hint">
        无需设置滑块档位：自动扫描全范围燃料滑块（0.05–1），计算每种组合的时间与燃料消耗，
        找出「尽量快同时耗油少」的平衡点。含自然跃迁时还会扫描反应堆使用量（滑块下限–1）。
      </div>

      <label :class="$style.field">
        <span>
          使用网关跃迁（玩家自选；网关不消耗 FTL 燃料、速度 3.0 pc/h，但可能收现金过路费）
        </span>
        <span>
          <input v-model="useGateway" type="checkbox" />
          启用网关（{{ routesStore.gatewayConnectionCount }} 条已记录连接）
        </span>
      </label>

      <details :class="$style.costDetails">
        <summary>成本参数（性价比评分 = 燃料费 + 时间价值）</summary>
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
            <span>时间价值（₳/小时）</span>
            <NumberInput v-model="timeValue" optional />
          </label>
        </div>
      </details>

      <div :class="$style.actions">
        <PrunButton primary :disabled="!ship" @click="planAndCompute">计算最优方案</PrunButton>
        <PrunButton
          neutral
          :disabled="prefetching"
          data-tooltip="从 FIO 逐个请求所有行星的轨道根数（4155 个，后台低并发渐进）。配合游戏轨道模型可离线预测任意时刻的天体位置。"
          @click="prefetchOrbits">
          {{ prefetching ? '预取中…' : `预取全部轨道（${orbitStore.planetCount}/4155）` }}
        </PrunButton>
        <PrunButton
          neutral
          :disabled="exporting"
          data-tooltip="一次性拉取所有行星的完整参数（轨道根数/质量等），下载为 JSON；同时更新轨道缓存。"
          @click="exportPlanets">
          {{ exporting ? '导出中…' : '导出全部行星参数' }}
        </PrunButton>
        <PrunButton
          neutral
          data-tooltip="网关在打开星图（星系地图）后自动读取，名称配对/飞行计划自动记录连接。检查当前已加载状态。"
          @click="checkGateways">
          网关{{ routesStore.gatewayCount > 0 ? `（${routesStore.gatewayCount}）` : '' }}
        </PrunButton>
        <PrunButton
          neutral
          data-tooltip="导出当前已加载的网关数据（naturalId/名称/所属星系/行星/状态）为 JSON。"
          @click="exportGateways">
          导出网关
        </PrunButton>
        <PrunButton
          neutral
          data-tooltip="从已积累数据导出空间站轨道+归属星系（FIO 无空间站数据，需先在游戏里打开含空间站的星系详情/访问空间站积累）。导出后运行 build-station-data.mjs 精简，即可离线预测空间站位置。"
          @click="exportStations">
          导出空间站
        </PrunButton>
        <PrunButton
          neutral
          data-tooltip="导出已记录的原生 STL 离港/进近段距离（SFC/BTF 计划时自动记录）。运行 build-stl-data.mjs 精简后内置，FTC 即对所有已采集航线精确复现原生路程。"
          @click="exportStlSegmentsData">
          导出 STL 段数据
        </PrunButton>
      </div>
      <div :class="$style.fieldRow">
        <label :class="$style.field">
          <span>采集探针（全部行星的离港/进近都以它为目标/来源，建议用你自己的行星或站点）</span>
          <TextInput v-model="collectProbe" placeholder="如：VH-192c" />
        </label>
        <div :class="$style.actions">
          <PrunButton
            primary
            :disabled="collecting"
            data-tooltip="自动为内置全部行星（4155 个）逐个请求原生 STL 离港/进近距离（游戏服务器计算，无需打开 BTF）。并发 4、支持停止与断点续采；响应自动入库，完成后点「导出 STL 段数据」发给我内置。"
            @click="startCollect">
            {{
              collecting
                ? '采集中…'
                : `采集全部星球 STL${collectProgressCount() > 0 ? `（已完成 ${collectProgressCount()}）` : ''}`
            }}
          </PrunButton>
          <PrunButton v-if="collecting" neutral @click="stopCollect">停止</PrunButton>
          <PrunButton :disabled="collecting" neutral @click="resetCollectProgress"
            >清空断点</PrunButton
          >
        </div>
      </div>
      <div v-if="collecting || collectDone > 0" :class="$style.exportBar">
        <ProgressBar :value="collectDone" :max="collectTotal || 1" />
        <span :class="$style.progress">
          {{ collectDone }}/{{ collectTotal }}（{{ collectCurrent }}）
        </span>
      </div>
      <div v-if="collectMessage" :class="$style.hint">{{ collectMessage }}</div>
      <div v-if="exporting" :class="$style.exportBar">
        <ProgressBar :value="exportDone" :max="exportTotal || 1" />
        <span :class="$style.progress">{{ exportDone }}/{{ exportTotal }}</span>
      </div>
      <div v-if="gatewayMessage" :class="$style.hint">{{ gatewayMessage }}</div>
      <div v-if="exportLog.length > 0" :class="$style.exportLog">
        <div v-for="(line, i) in exportLog" :key="i">{{ line }}</div>
      </div>
      <div v-if="calcMessage" :class="$style.hint">{{ calcMessage }}</div>
    </div>

    <template v-if="result">
      <SectionHeader>最优燃料方案（{{ result.label }}航线）</SectionHeader>
      <div :class="$style.hint">
        平衡点（{{ balanceNote }}）
        <template v-if="!result.reactorRelevant"
          >：全程系内飞行没有自然跃迁，反应堆不适用（--）。</template
        >
      </div>
      <table :class="$style.table">
        <thead>
          <tr>
            <th>燃料滑块</th>
            <th>反应堆</th>
            <th>总时长</th>
            <th>STL 燃料</th>
            <th>FTL 燃料</th>
            <th>燃料费</th>
            <th>时间成本</th>
            <th>总成本</th>
          </tr>
        </thead>
        <tbody>
          <tr :class="$style.best">
            <td>{{ result.best.fuel }}</td>
            <td>{{ result.reactorRelevant ? result.best.reactor : '--' }}</td>
            <td>{{ formatDuration(result.best.totalHours * 3600000) }}</td>
            <td>{{
              result.best.fuelEstimated ? formatFuel(result.best.stlFuel) : '需位置观测'
            }}</td>
            <td>{{ formatFuel(result.best.ftlFuel) }}</td>
            <td>{{ formatCurrency(result.best.fuelCost) }}</td>
            <td>{{ formatCurrency(result.best.timeCost) }}</td>
            <td>{{ formatCurrency(result.best.totalCost) }}</td>
          </tr>
        </tbody>
      </table>
      <details :class="$style.costDetails">
        <summary>航线明细</summary>
        <div :class="$style.hint">
          {{ result.route.systemIds.join(' → ') }}
        </div>
        <div :class="$style.hint">
          跳数 {{ result.route.systemIds.length - 1 }} ｜ FTL
          {{ fixed2v(result.route.totalPc) }} pc（自然 {{ fixed2v(result.metrics.natPc) }} + 网关
          {{ fixed2v(result.metrics.gwPc) }}， 网关 {{ result.metrics.gwCount }} 段）
          <template v-if="result.metrics.stlDistanceKm !== undefined">
            ｜ STL 起降 ≈ {{ formatFuel(result.metrics.stlDistanceKm / 1e6) }}M km
            <template
              v-if="
                result.metrics.departKm !== undefined && result.metrics.approachKm !== undefined
              ">
              （离港 {{ formatFuel(result.metrics.departKm / 1e6) }}M + 进近
              {{ formatFuel(result.metrics.approachKm / 1e6) }}M）
            </template>
            <template v-if="result.metrics.stlRecorded">（飞行计划原生记录）</template>
            <template v-else>（统计/轨道估算，采集中会逐步精确）</template>
          </template>
        </div>
      </details>
      <SectionHeader>
        航线分段（{{ result.segmentsNative ? '服务器原生飞行计划' : '模型估算' }}）
      </SectionHeader>
      <table :class="$style.planTable">
        <thead>
          <tr>
            <th>#</th>
            <th>类型</th>
            <th>目的地</th>
            <th>耗时</th>
            <th>距离</th>
            <th>损伤</th>
            <th>消耗</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(s, i) in result.segments" :key="i">
            <td>{{ i }}</td>
            <td>{{ s.type }}</td>
            <td>{{ s.destination }}</td>
            <td>{{ formatSegmentDuration(s.durationMs) }}</td>
            <td>
              <template v-if="s.distanceKm !== undefined">
                {{ formatFuel(s.distanceKm / 1e6) }}M km
              </template>
              <template v-else-if="s.distancePc !== undefined">
                {{ fixed2v(s.distancePc) }} pc
              </template>
              <template v-else>--</template>
            </td>
            <td>{{ formatDamage(s.damage) }}</td>
            <td>{{ formatSegmentFuel(s.stlFuel, s.ftlFuel) }}</td>
          </tr>
        </tbody>
      </table>
    </template>
  </div>
</template>
