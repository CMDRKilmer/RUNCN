<script setup lang="ts">
import { ref, computed, watchEffect } from 'vue';
import SectionHeader from '@src/components/SectionHeader.vue';
import PrunButton from '@src/components/PrunButton.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { blueprintsStore } from '@src/infrastructure/prun-api/data/blueprints';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { getPrice } from '@src/infrastructure/fio/cx';
import {
  orbitStore,
  prefetchAllOrbits,
  exportAllPlanetData,
  exportStationOrbits,
} from '@src/infrastructure/fio/orbit';
import { routesStore } from '@src/infrastructure/fio/routes';
import { downloadFile } from '@src/utils/dom';
import ProgressBar from '@src/components/ProgressBar.vue';
import { formatCountdown, formatCurrency, fixed2, fixed4 } from '@src/utils/format';
import { planRoutes, routeMetrics, PlannedRoute } from './route-planner';
import { scanFuelOptions, FuelOption, ShipPerformance } from './fuel-model';
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

// ---- 燃料性价比计算器 ----
const registration = ref('');
const routeFrom = ref('');
const routeTo = ref('');
// 网关开关：玩家自选是否走网关跃迁（网关不耗 FTL 燃料，但可能收现金）。
const useGateway = ref(false);
const fuelText = ref('0.05,0.1,0.3,0.5,0.8,1');
const reactorText = ref('0.25,0.5,0.75,1');
const stlFuelPrice = ref<number | undefined>(undefined);
const ftlFuelPrice = ref<number | undefined>(undefined);
const timeValue = ref<number | undefined>(0);

const dockedShips = computed(() =>
  (shipsStore.all.value ?? []).filter(x => x.flightId === null && x.address !== null),
);
const ship = computed(() => shipsStore.getByRegistration(registration.value));
// 蓝图性能（FTL 最大航速、STL 引擎、FTL 充能/燃料参数）。
const blueprintInfo = computed(() => {
  const s = ship.value;
  if (!s) {
    return undefined;
  }
  const bp = blueprintsStore.getByNaturalId(s.blueprintNaturalId);
  if (!bp) {
    return undefined;
  }
  const ftlMaxSpeed =
    bp.performance.ftlMaxSpeed > 0 ? bp.performance.ftlMaxSpeed * 3600 : undefined;
  // 蓝图 STL 燃料罐容量（跨星系离港/进近燃料按罐比例算）。
  const stlFuelCapacity =
    bp.performance.stlFuelCapacity > 0 ? bp.performance.stlFuelCapacity : undefined;
  // 蓝图最小反应堆使用量 / 发射器充能时间（充能时间 = eT/m × r）。
  const minReactorUsage =
    bp.performance.minReactorUsage > 0 ? bp.performance.minReactorUsage : undefined;
  const emitterChargeTime =
    bp.performance.emitterChargeTime > 0 ? bp.performance.emitterChargeTime : undefined;
  // 蓝图最大 G力过载因子（用于 STL v_cruise 经验公式）。
  const maxGFactor = bp.performance.maxGFactor;
  // 从 selections 中查 STL_ENGINE 选项与反应堆功率（FTL_POWER，燃料系数用）。
  let stlEngine: string | undefined;
  let reactorPower: number | undefined;
  for (const sel of bp.selections) {
    if (sel.amount <= 0) {
      continue;
    }
    if (sel.type === 'STL_ENGINE') {
      stlEngine = sel.option;
    } else if (sel.type === 'FTL_REACTOR') {
      for (const mod of sel.modifiers) {
        if (mod.type === 'FTL_POWER') {
          reactorPower = mod.value;
        }
      }
    }
  }
  return {
    ftlMaxSpeed,
    stlEngine,
    reactorPower,
    stlFuelCapacity,
    minReactorUsage,
    emitterChargeTime,
    maxGFactor,
  };
});

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

function parseNumbers(text: string) {
  return text
    .split(/[,，\s]+/)
    .map(x => parseFloat(x))
    .filter(x => Number.isFinite(x) && x > 0 && x <= 1);
}
const fuels = computed(() => parseNumbers(fuelText.value));
const reactors = computed(() => parseNumbers(reactorText.value));

// 飞船实时性能 → 模型输入。
function shipPerformance(): ShipPerformance | undefined {
  const s = ship.value;
  if (!s) {
    return undefined;
  }
  // FTL 最大航速优先从蓝图读取（pc/s → pc/h），无蓝图时回退到 2.26 pc/h。
  const ftlMaxSpeed = blueprintInfo.value?.ftlMaxSpeed ?? 2.26;
  return {
    mass: s.mass,
    operatingEmptyMass: s.operatingEmptyMass,
    acceleration: s.acceleration,
    thrust: s.thrust,
    ftlMaxSpeed,
    stlFuelFlowRate: s.stlFuelFlowRate,
    reactorPower: blueprintInfo.value?.reactorPower ?? s.reactorPower,
    condition: s.condition,
    stlEngineOption: blueprintInfo.value?.stlEngine,
    maxGFactor: blueprintInfo.value?.maxGFactor,
    minReactorUsage: blueprintInfo.value?.minReactorUsage,
    emitterChargeTime: blueprintInfo.value?.emitterChargeTime,
    stlFuelCapacity: blueprintInfo.value?.stlFuelCapacity,
  };
}

interface PlanResult {
  label: string;
  route: PlannedRoute;
  metrics: ReturnType<typeof routeMetrics>;
  options: FuelOption[];
  best: FuelOption;
}

const result = ref<PlanResult | undefined>(undefined);
const calcMessage = ref<string | undefined>(undefined);

// 行星环境数据（半径 km / 气压）内置静态 JSON（FIO 全量导出，避免运行时查询）。
// 格式：{ "PG-241H": { r: 8000, p: 1.2 }, ... }。
type PlanetEnvEntry = { r: number; p?: number };
let planetEnvData: Record<string, PlanetEnvEntry> | undefined;
let planetEnvLoading: Promise<void> | undefined;

async function loadPlanetEnv(): Promise<void> {
  if (planetEnvData !== undefined || planetEnvLoading !== undefined) {
    return planetEnvLoading;
  }
  planetEnvLoading = (async () => {
    try {
      const resp = await fetch(config.url.planetEnv);
      planetEnvData = (await resp.json()) as Record<string, PlanetEnvEntry>;
    } catch {
      // 内置文件加载失败：回退常数近似（无起降精确项）。
      planetEnvData = {};
    }
  })();
  return planetEnvLoading;
}

// 从内置数据查行星环境（半径 km + 气压）。找不到（空间站/星系/无数据）返回 undefined。
async function fetchPlanetEnv(
  naturalId: string,
): Promise<{ radiusKm: number; pressure?: number } | undefined> {
  await loadPlanetEnv();
  const env = planetEnvData?.[naturalId.toUpperCase()];
  if (env === undefined) {
    return undefined;
  }
  return { radiusKm: env.r, pressure: env.p };
}

async function planAndCompute() {
  calcMessage.value = undefined;
  result.value = undefined;
  const from = routeFrom.value.trim();
  const to = routeTo.value.trim();
  if (!from || !to) {
    calcMessage.value = '请输入起点和终点';
    return;
  }
  const perf = shipPerformance();
  if (!perf) {
    calcMessage.value = '请选择停靠中的飞船';
    return;
  }
  const planned = planRoutes(from, to);
  const route = useGateway.value ? (planned.gateway ?? planned.natural) : planned.natural;
  if (!route) {
    calcMessage.value = '无法解析起终点或航线不可达（需恒星位置数据，请先打开星图）';
    return;
  }
  const metrics = routeMetrics(route);
  // 跨星系航线的起/终点行星环境（内置 JSON）：着陆（半径+气压）与起飞段（出发行星）。
  // 空间站（全大写 naturalId）不在行星数据中 → undefined → 无着陆/起飞段（无大气）。
  const isCrossSystem = (metrics.natPc ?? 0) > 0 || (metrics.gwPc ?? 0) > 0;
  const [landingEnv, departEnv] = await Promise.all([
    isCrossSystem && metrics.toBody !== undefined ? fetchPlanetEnv(metrics.toBody) : undefined,
    isCrossSystem && metrics.fromBody !== undefined ? fetchPlanetEnv(metrics.fromBody) : undefined,
  ]);
  const options = scanFuelOptions(
    perf,
    metrics,
    fuels.value,
    reactors.value,
    {
      stlPrice: stlFuelPrice.value ?? 0,
      ftlPrice: ftlFuelPrice.value ?? 0,
      timeValue: timeValue.value ?? 0,
    },
    {
      landingRadius: landingEnv?.radiusKm,
      landingPressure: landingEnv?.pressure,
      departureRadius: departEnv?.radiusKm,
      departurePressure: departEnv?.pressure,
    },
  );
  if (options.length === 0) {
    calcMessage.value = '请输入有效的滑块组合（0–1 之间）';
    return;
  }
  result.value = { label: route.label, route, metrics, options, best: options[0] };
  const b = options[0];
  const radiusText =
    landingEnv !== undefined ? `，目的地半径 ${fixed2v(landingEnv.radiusKm)}km` : '';
  calcMessage.value =
    `最优方案：燃料滑块 ${b.fuel} / 反应堆 ${b.reactor}，预计 ${formatDuration(b.totalHours * 3600000)}，总成本 ${formatCurrency(b.totalCost)}` +
    radiusText +
    (useGateway.value && metrics.gatewayCount > 0
      ? '（网关航线：FTL 燃料为 0）'
      : useGateway.value
        ? '（未找到可用网关，已按自然航线计算）'
        : '');
}

function formatDuration(ms: number) {
  return formatCountdown(ms);
}
function formatFuel(value: number) {
  return fixed4(value);
}
function fixed2v(value: number) {
  return fixed2(value);
}
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

      <label :class="$style.field">
        <span>
          使用网关跃迁（玩家自选；网关不消耗 FTL 燃料、速度 3.0 pc/h，但可能收现金过路费）
        </span>
        <span>
          <input v-model="useGateway" type="checkbox" />
          启用网关（{{ routesStore.gatewayConnectionCount }} 条已记录连接）
        </span>
      </label>

      <div :class="$style.fieldRow">
        <label :class="$style.field">
          <span>燃料消耗滑块组合（0–1）</span>
          <TextInput v-model="fuelText" />
        </label>
        <label :class="$style.field">
          <span>反应堆使用量组合（0–1，仅自然跃迁相关）</span>
          <TextInput v-model="reactorText" />
        </label>
      </div>

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
      </div>
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
          <tr
            v-for="(o, i) in result.options"
            :key="`${o.fuel}-${o.reactor}`"
            :class="[$style.row, { [$style.best]: i === 0 }]">
            <td>{{ o.fuel }}</td>
            <td>{{ o.reactor }}</td>
            <td>{{ formatDuration(o.totalHours * 3600000) }}</td>
            <td>{{ o.fuelEstimated ? formatFuel(o.stlFuel) : '需位置观测' }}</td>
            <td>{{ formatFuel(o.ftlFuel) }}</td>
            <td>{{ formatCurrency(o.fuelCost) }}</td>
            <td>{{ formatCurrency(o.timeCost) }}</td>
            <td>{{ formatCurrency(o.totalCost) }}</td>
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
          </template>
        </div>
      </details>
    </template>
  </div>
</template>
