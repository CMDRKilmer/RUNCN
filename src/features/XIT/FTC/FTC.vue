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
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { sleep } from '@src/utils/sleep';
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
  hasSystemData,
} from '@src/infrastructure/fio/orbit';
import { routesStore } from '@src/infrastructure/fio/routes';
import { downloadFile } from '@src/utils/dom';
import ProgressBar from '@src/components/ProgressBar.vue';
import { formatCurrency, fixed2, fixed4 } from '@src/utils/format';
import {
  planRoutes,
  routeMetrics,
  PlannedRoute,
  RouteSegmentRow,
  findNativeFlightPlan,
  buildNativeSegmentRows,
  buildEstimatedSegmentRows,
} from './route-planner';
import { resolveSystemId } from './route-model';
import {
  scanFuelOptions,
  autoFuelGrid,
  autoReactorGrid,
  paretoFrontier,
  findBalanceOption,
  FuelOption,
  ShipPerformance,
} from './fuel-model';
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
// 自动浏览星系（不止空间站）：逐个打开目标星系的星系详情（游戏命令
// `MS <systemId>`，Map: Star System），客户端自动请求 DATA_DATA["systems", id]，
// orbit.ts 监听积累该星系全部数据——恒星质量 + 行星/空间站轨道（celestialBodies），
// 不只空间站。DATA_DATA 到达后自动关闭窗口。FIO 无空间站数据，这是唯一能离线
// 补全空间站轨道的方式（模拟用户浏览星系，符合"插件不主动请求数据"约束）。
// 在计算时调用：起终点星系阻塞等待（保证本次计算 STL 起降距离可用），
// 其余无轨道空间站的归属星系后台渐进（不阻塞，为后续计算积累）。
async function browseSystems(systemIds: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const id of systemIds) {
    const key = id.trim().toUpperCase();
    if (key !== '' && !seen.has(key)) {
      seen.add(key);
      list.push(key);
    }
  }
  const browsed: string[] = [];
  for (const systemId of list) {
    // 本会话已浏览过（DATA_DATA 已积累）：跳过，避免重复打开窗口。
    if (hasSystemData(systemId)) {
      browsed.push(systemId);
      continue;
    }
    const done = ref(false);
    const timeout = window.setTimeout(() => {
      done.value = true;
    }, 25000);
    let ok = false;
    try {
      // 打开星系详情并提交命令（竞速保护：地图渲染慢时不等窗口，DATA_DATA 已触发）。
      await Promise.race([
        showBuffer(`MS ${systemId}`, {
          autoClose: true,
          closeWhen: done,
        }).catch(() => {
          done.value = true;
        }),
        sleep(10000),
      ]);
      // 轮询数据积累（DATA_DATA 到达即完成；done=true 让 closeWhenDone 关闭窗口）。
      while (!done.value && !hasSystemData(systemId)) {
        await sleep(400);
      }
      ok = hasSystemData(systemId);
    } catch {
      // 单星系失败不中断：标记完成，继续下一个。
    } finally {
      done.value = true;
      window.clearTimeout(timeout);
    }
    if (ok) {
      browsed.push(systemId);
    }
  }
  return browsed;
}

// 收集计算需要浏览的星系：起终点所在星系（关键，阻塞）+ 无轨道空间站的归属星系（后台）。
// 不止空间站：起终点为行星/星系时同样浏览其星系，积累恒星质量与行星轨道。
function collectBrowseTargets(
  from: string,
  to: string,
): {
  critical: string[];
  background: string[];
} {
  const critical = new Set<string>();
  const fromSys = resolveSystemId(from);
  const toSys = resolveSystemId(to);
  if (fromSys !== undefined) {
    critical.add(fromSys);
  }
  if (toSys !== undefined) {
    critical.add(toSys);
  }
  const background = new Set<string>();
  for (const st of exportStationOrbits()) {
    if (!st.orbit) {
      background.add(st.systemId);
    }
  }
  return {
    critical: [...critical],
    background: [...background].filter(s => !critical.has(s)),
  };
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
  // 时间↔燃料的 Pareto 权衡前沿（自动扫描全范围滑块后的非支配方案，按时间升序）。
  frontier: FuelOption[];
  // 完整航线段（严格按游戏 SFC 表格）：优先服务器原生飞行计划，否则模型估算。
  segments: RouteSegmentRow[];
  segmentsNative: boolean;
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

// 等待飞船蓝图加载：FTL 航速/充能时间/燃料罐容量/STL 引擎/最大 G 等性能全部来自蓝图
// （blueprintsStore 只含公司蓝图列表，首次访问 getByNaturalId 会触发 BLU 窗口请求，
// 响应异步到达——不等待则本次计算全部落到默认值，误差巨大，如把省油引擎当超推力）。
// 返回是否成功取得蓝图；失败（非公司蓝图/响应超时）时继续用默认值计算并提示。
async function ensureShipBlueprint(s: PrunApi.Ship): Promise<boolean> {
  if (blueprintsStore.getByNaturalId(s.blueprintNaturalId)) {
    return true;
  }
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await sleep(100);
    if (blueprintsStore.getByNaturalId(s.blueprintNaturalId)) {
      return true;
    }
  }
  return false;
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
  const s = ship.value;
  if (!s) {
    calcMessage.value = '请选择停靠中的飞船';
    return;
  }
  // 关键：计算前等待飞船蓝图加载（决定 FTL 航速/充能/燃料罐/引擎等性能）。
  const bpOk = await ensureShipBlueprint(s);
  const perf = shipPerformance();
  if (!perf) {
    calcMessage.value = '请选择停靠中的飞船';
    return;
  }
  if (!bpOk) {
    calcMessage.value = '未获取到飞船蓝图（非公司蓝图或请求超时），已用默认性能估算，结果可能不准';
  }
  // 计算时自动浏览星系（无需手动按钮）：起终点星系阻塞获取轨道/恒星质量数据，
  // 其余无轨道空间站星系后台渐进。浏览后可离线预测起降位置，STL 距离更准。
  const targets = collectBrowseTargets(from, to);
  if (targets.critical.length > 0) {
    calcMessage.value = `正在获取起终点星系轨道数据（${targets.critical.join('、')}）…`;
    await browseSystems(targets.critical);
  }
  if (targets.background.length > 0) {
    void browseSystems(targets.background);
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
  // 无需玩家设置档位：自动扫描全范围燃料滑块 f 与反应堆 r（含滑块下限）。
  const options = scanFuelOptions(
    perf,
    metrics,
    autoFuelGrid(),
    autoReactorGrid(perf),
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
    calcMessage.value = '计算失败：未能生成有效的滑块组合';
    return;
  }
  // 平衡点：设了时间价值（₳/小时）时按总成本（燃料费 + 时间价值）最优，
  // 即经济上的真正平衡；未设时用 Pareto 拐点——尽量快的同时燃料消耗少，两端都不极端。
  const tv = timeValue.value ?? 0;
  const best = tv > 0 ? options[0] : (findBalanceOption(options) ?? options[0]);
  const frontier = paretoFrontier(options);
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
      landingRadius: landingEnv?.radiusKm,
      landingPressure: landingEnv?.pressure,
      departureRadius: departEnv?.radiusKm,
      departurePressure: departEnv?.pressure,
    });
    segmentsNative = false;
  }
  result.value = {
    label: route.label,
    route,
    metrics,
    options,
    best,
    frontier,
    segments,
    segmentsNative,
  };
  const radiusText =
    landingEnv !== undefined ? `，目的地半径 ${fixed2v(landingEnv.radiusKm)}km` : '';
  const fuelText =
    best.fuelEstimated && (best.stlFuel > 0 || best.ftlFuel > 0)
      ? `，STL ${Math.round(best.stlFuel)} + FTL ${Math.round(best.ftlFuel)} 燃料`
      : '';
  calcMessage.value =
    `最优方案（平衡点）：燃料滑块 ${best.fuel} / 反应堆 ${best.reactor}，预计 ${formatDuration(best.totalHours * 3600000)}` +
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

// 表格中高亮平衡点行（按燃料滑块+反应堆精确匹配）。
function isBestOption(o: FuelOption) {
  const b = result.value?.best;
  return b !== undefined && b.fuel === o.fuel && b.reactor === o.reactor;
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
        无需设置滑块档位：自动扫描全范围燃料滑块（0.05–1）与反应堆使用量（滑块下限–1），
        计算每种组合的时间与燃料消耗，找出「尽量快同时耗油少」的平衡点。
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
        下表为时间 ↔ 燃料的 Pareto 权衡前沿（自动扫描全范围滑块后的非支配方案，按时间升序）；
        绿色高亮行为平衡点（{{ balanceNote }}）。
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
          <tr
            v-for="o in result.frontier"
            :key="`${o.fuel}-${o.reactor}`"
            :class="[$style.row, { [$style.best]: isBestOption(o) }]">
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
