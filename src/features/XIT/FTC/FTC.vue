<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import PrunButton from '@src/components/PrunButton.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import { requestStars, starsStore, starsVersion } from '@src/infrastructure/prun-api/data/stars';
import { blueprintsStore } from '@src/infrastructure/prun-api/data/blueprints';
import {
  getEntityNaturalIdFromAddress,
  getSystemLineFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
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
  getNativePlanetEnvironment,
  snapshotOrbitInputs,
} from '@src/infrastructure/fio/orbit';
import { routesStore } from '@src/infrastructure/fio/routes';
import { ensureGatewayConnections } from './gateway-loader';
import { downloadFile } from '@src/utils/dom';
import {
  scanTransitFuelCurve,
  scanTransitMatrix,
  listBlueprintIds,
  type ScanFtlPreference,
} from '@src/infrastructure/prun-api/data/transit-f-scan';
import {
  resolveEntity,
  encodeAddress,
} from '@src/infrastructure/prun-api/data/flight-test-collector';
import ProgressBar from '@src/components/ProgressBar.vue';
import { fetchPlanetEnv } from '@src/infrastructure/fio/planet-environment';
import FlightCalculator from './FlightCalculator.vue';
import $style from './FTC.module.css';

const calculatorBlueprintId = ref('');
onMounted(() => {
  void ensureGatewayConnections();
});

// Data collection remains separate from formula-based calculations.
const prefetching = ref(false);
const requestingStars = ref(false);
const starsMessage = ref<string | undefined>(undefined);
async function refreshStars() {
  if (requestingStars.value) {
    return;
  }
  requestingStars.value = true;
  starsMessage.value = undefined;
  const previousVersion = starsVersion.value;
  try {
    if (!requestStars()) {
      starsMessage.value = '游戏 socket 未就绪：请刷新游戏页面后重试';
      return;
    }
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
      if (starsVersion.value > previousVersion) {
        const count = starsStore.all.value?.length ?? 0;
        starsMessage.value = `已从游戏加载 ${count} 个星系`;
        return;
      }
    }
    starsMessage.value = '等待星图响应超时；可在游戏星图内重试';
  } finally {
    requestingStars.value = false;
  }
}
async function prefetchOrbits() {
  prefetching.value = true;
  try {
    await prefetchAllOrbits();
    orbitMessage.value =
      orbitStore.prefetchFailed > 0
        ? `轨道预取完成：${orbitStore.prefetchFailed} 个失败，可稍后重试`
        : `轨道预取完成：新增 ${orbitStore.prefetchTotal} 个请求`;
  } finally {
    prefetching.value = false;
  }
}
const orbitMessage = ref<string | undefined>(undefined);
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
let loadingGateways = false;
// 「网关」按钮：本地没有网关数据时立刻向服务器请求一次（与原生星图发出的
// DATA_GET_DATA{path:['gateways']} 相同），不需要玩家手动打开星图。
async function checkGateways() {
  if (
    !loadingGateways &&
    routesStore.gatewayCount === 0 &&
    routesStore.gatewayConnectionCount === 0
  ) {
    loadingGateways = true;
    gatewayMessage.value = '正在向服务器请求网关数据…';
    await ensureGatewayConnections({ cooldownMs: 0 });
    loadingGateways = false;
  }
  const n = routesStore.gatewayCount;
  const c = routesStore.gatewayConnectionCount;
  if (n > 0 || c > 0) {
    const parts: string[] = [];
    if (n > 0) {
      parts.push(`已加载 ${n} 个网关`);
    }
    if (c > 0) {
      parts.push(`已提取 ${c} 条网关连接（飞行计划/名称配对自动记录）`);
    }
    gatewayMessage.value = parts.join('；') + '，可直接导出';
    return;
  }
  gatewayMessage.value =
    '暂无网关数据：请求未拿到响应，请刷新游戏页面后重试，或执行一次网关飞行（自动记录网关连接）';
}
async function exportGateways() {
  if (routesStore.gatewayCount === 0) {
    await ensureGatewayConnections({ cooldownMs: 0 });
  }
  const data = routesStore.getAllGateways();
  if (data.length === 0) {
    gatewayMessage.value = '暂无网关数据：请求未拿到响应，请刷新游戏页面后重试';
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
// 供旧模型的数据表与离线诊断使用。新 FTC 计算器直接预测轨道几何。
function exportStlSegmentsData() {
  const data = exportStlSegments();
  if (data.depart.length === 0 && data.approach.length === 0 && data.sameSystem.length === 0) {
    gatewayMessage.value =
      '暂无 STL 段数据：请先在 SFC/BTF 计划过相关航线（离港/进近段会自动记录），再导出';
    return;
  }
  downloadFile(data, 'prun-stl-segments.json', true);
  gatewayMessage.value =
    `已导出 ${data.depart.length} 条离港 + ${data.approach.length} 条进近 + ` +
    `${data.sameSystem.length} 条同星系航线；` +
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

/**
 * 该蓝图实际的 STL 罐容量（performance.stlFuelCapacity）。
 * 矩阵扫描用它做 stlFuel，保证「扫描传的罐」=「蓝图真实的罐」。
 * 取不到返回 0（调用方据此判定该行无效）。
 */
// Explicit scan selections override the calculator blueprint.
const scanBlueprintId = ref('');

// 蓝图下拉选项：直接读 blueprintsStore.all（响应式）。
// 打开一次蓝图界面后即有数据；空列表时面板显示「跟随选中飞船」。
const blueprintOptions = computed(() =>
  (blueprintsStore.all.value ?? []).map(b => ({
    naturalId: b.naturalId,
    name: b.name ?? '',
    stlFuelCapacity: b.performance?.stlFuelCapacity ?? 0,
  })),
);

function blueprintIdOfSelection(): string {
  if (scanBlueprintId.value.trim() !== '') {
    return scanBlueprintId.value.trim();
  }
  return calculatorBlueprintId.value;
}

function blueprintStlCapacityOf(blueprintNaturalId: string): number {
  const bp = blueprintsStore.getByNaturalId(blueprintNaturalId);
  const cap = bp?.performance?.stlFuelCapacity;
  return typeof cap === 'number' && cap > 0 ? cap : 0;
}

async function snapshotFlightInputs(origin: PrunApi.Address, destination: PrunApi.Address) {
  const endpoints = [origin, destination].map(address => ({
    naturalId: getEntityNaturalIdFromAddress(address),
    systemId: getSystemLineFromAddress(address)?.entity.naturalId,
  }));
  const environment = await Promise.all(
    endpoints.map(async ({ naturalId, systemId }) => {
      if (naturalId === undefined) {
        return { naturalId, systemId };
      }
      const nativeEnv = getNativePlanetEnvironment(naturalId);
      const env = nativeEnv ? { ...nativeEnv, source: 'native' } : await fetchPlanetEnv(naturalId);
      return { naturalId, systemId, env };
    }),
  );
  const stars = (starsStore.all.value ?? []).map(({ systemId, address, position, connections }) => {
    const naturalId = getSystemLineFromAddress(address)?.entity.naturalId;
    return {
      systemId,
      naturalId,
      position: { ...position },
      connections: [...connections],
      neighbors: naturalId === undefined ? [] : routesStore.getNeighbors(naturalId),
    };
  });
  return {
    capturedAt: Date.now(),
    environment,
    orbit: snapshotOrbitInputs(
      endpoints.flatMap(({ naturalId, systemId }) =>
        naturalId === undefined || systemId === undefined ? [] : [{ naturalId, systemId }],
      ),
    ),
    stars,
    gateways: routesStore.getAllGateways().map(x => ({ ...x })),
    gatewayConnections: routesStore.getGatewayConnections().map(x => ({ ...x })),
  };
}
// ---- 配件矩阵扫描（2026-10-14）----
// 单变量隔离每个可配置部件：每套配件对应**一份蓝图**，各自跑完整 f 档位。
// ⚠️ 调用方需保证每个变体的 stlFuel 等于该蓝图 performance.stlFuelCapacity
//    （否则测到的是另一个罐的数据 —— 2026-10-13 踩过）。
const matrixScanning = ref(false);
const matrixCancelled = ref(false);
const matrixMessage = ref('');
// 每行一个变体：蓝图 naturalId + 罐容量（必须与 blueprint.performance.stlFuelCapacity 一致）。
const matrixRows = ref<{ blueprintId: string; variant: string; stlFuel: number }[]>([]);
const matrixProbe = ref('VH-331g');
const matrixTarget = ref('VH-331e');
const matrixFactors = ref('0.05,0.1,0.2,0.3,0.4,0.5');

// 从当前公司蓝图自动生成变体行：每份蓝图一行，罐容量直接取 performance.stlFuelCapacity，
// 杜绝「扫描传的罐」与「蓝图实际罐」不一致（上次数据不可比的主因）。
function autoFillMatrixRows() {
  const bps = listBlueprintIds();
  if (bps.length === 0) {
    matrixMessage.value = '没有蓝图：请先在游戏里打开一次蓝图界面';
    return;
  }
  matrixRows.value = bps.map(b => ({
    blueprintId: b.naturalId,
    variant: b.name !== '' ? b.name : b.naturalId,
    // 罐容量需要 performance；此处用 blueprintsStore 直接读，避免再导一个 store。
    stlFuel: blueprintStlCapacityOf(b.naturalId),
  }));
  matrixMessage.value = '已按公司蓝图生成 ' + matrixRows.value.length + ' 行';
}

async function startMatrixScan() {
  matrixScanning.value = true;
  matrixCancelled.value = false;
  matrixMessage.value = '';
  try {
    const probe = matrixProbe.value.trim();
    const target = matrixTarget.value.trim();
    const probeAddr = await resolveEntity(probe);
    const targetAddr = await resolveEntity(target);
    if (!probeAddr || !targetAddr) {
      matrixMessage.value = '无法解析探针或目标天体';
      return;
    }
    const from = encodeAddress(probeAddr);
    const to = encodeAddress(targetAddr);
    if (!from || !to) {
      matrixMessage.value = '地址缺少实体 id';
      return;
    }
    const factors = matrixFactors.value
      .split(',')
      .map(x => Number(x.trim()))
      .filter(x => Number.isFinite(x) && x > 0 && x <= 1);
    const rows = matrixRows.value.filter(r => r.blueprintId.trim() !== '');
    if (rows.length === 0) {
      matrixMessage.value = '没有变体行：点「按蓝图自动填充」';
      return;
    }
    const bad = rows.filter(r => !(r.stlFuel > 0));
    if (bad.length > 0) {
      matrixMessage.value = '这些行的罐容量无效：' + bad.map(b => b.variant).join('、');
      return;
    }
    if (from.split('|')[0] !== to.split('|')[0]) {
      matrixMessage.value = '正在读取网关数据…';
      if (!(await ensureGatewayConnections())) {
        matrixMessage.value = '未能读取网关连接，请稍后重试。';
        return;
      }
    }
    const flightInputs = await snapshotFlightInputs(probeAddr, targetAddr);
    const result = await scanTransitMatrix({
      probe: from,
      target: to,
      entries: rows,
      fuelFactors: factors,
      onVariantStart: info => {
        matrixMessage.value = '变体 ' + info.index + '/' + info.total + '：' + info.variant;
      },
      shouldCancel: () => matrixCancelled.value,
    });
    downloadFile({ ...result, flightInputs }, 'prun-transit-matrix.json', true);
    const done = result.variants.filter(v => v.samples.length > 0).length;
    const pts = result.variants.reduce((a, v) => a + v.samples.length, 0);
    matrixMessage.value =
      '矩阵扫描完成：' +
      done +
      '/' +
      result.variants.length +
      ' 个变体有数据，共 ' +
      pts +
      ' 个点。已下载 prun-transit-matrix.json';
  } catch (e) {
    matrixMessage.value = '矩阵扫描失败：' + String(e);
  } finally {
    matrixScanning.value = false;
  }
}

function stopMatrixScan() {
  matrixCancelled.value = true;
}
// ---- 系内转移段 f 曲线扫描 ----
// 目的：补齐系内转移段速度里「档位 f」这一维的地面真值 —— 旧口径的锚点来自
// VH-331g → HRT 的 BTF 样本（599,220,390 km / 21,780 s），而**那个样本没记 f**，
// 那套模型的 f 依赖只有这一点 + 一条假设的曲线形状（当前口径见 src/core/flight/stl.ts，
// 不再使用这条速度曲线）。本扫描固定船/航线/罐只变 f。
// ⚠️ 会向服务器发多笔计算请求（每档 1 次），仅用户点按钮时触发。
const fScanning = ref(false);
const fScanCancelled = ref(false);
const fScanMessage = ref('');
// 探针与目标都默认用**行星**：resolveEntity 的原始匹配逻辑对空间站名/naturalId
// 曾不兼容（2026-10-13 已修），而行星侧一直可靠。同星系内两点才能测纯 TRANSIT 段。
const fScanProbe = ref('VH-331g');
const fScanTarget = ref('VH-331e');
const fScanFactors = ref('0.05,0.1,0.2,0.3,0.4,0.5');
// 罐覆写（受控实验入口）：留空 = 用选中蓝图的真实罐容量（默认口径，防错配）。
// 填值 = 固定蓝图（质量/部件都不变）只改请求里的段可用 STL 燃料，
// 用来分离「罐」与「质量」两个变量 —— 矩阵扫描做不到这点，它强制用各蓝图自己的罐。
const fScanStlFuelOverride = ref('');
const fScanFtlFuelOverride = ref('');
const fScanReactor = ref('');
const fScanCondition = ref('1');
const fScanLanding = ref(true);
const fScanGateways = ref(true);
const fScanFtlPreference = ref<ScanFtlPreference>('LEAST_JUMPS');
// 载重覆写：留空或 0 = 空载。填值 = 受控实验：固定蓝图/引擎/罐，只加质量
// （游戏把载重计入飞船总质量），用来在**不改动账号里任何蓝图**的前提下扫质量。
const fScanPayloadOverride = ref('');

async function startFScan() {
  fScanning.value = true;
  fScanCancelled.value = false;
  fScanMessage.value = '';
  try {
    const probe = fScanProbe.value.trim();
    const target = fScanTarget.value.trim();
    const probeAddr = await resolveEntity(probe);
    const targetAddr = await resolveEntity(target);
    if (!probeAddr || !targetAddr) {
      fScanMessage.value = '无法解析探针或目标天体，请检查名称';
      return;
    }
    // 用采集器同一套地址编码（systemId|KIND,id）—— 不在此处复制一份，避免两处漂移
    const from = encodeAddress(probeAddr);
    const to = encodeAddress(targetAddr);
    if (!from || !to) {
      fScanMessage.value = '地址缺少实体 id，无法请求';
      return;
    }
    const factors = fScanFactors.value
      .split(',')
      .map(x => Number(x.trim()))
      .filter(x => Number.isFinite(x) && x > 0 && x <= 1);
    if (factors.length === 0) {
      fScanMessage.value = '没有有效的 f 档位';
      return;
    }
    // 罐容量必须取自**当前选中的蓝图**，而不是面板手填值 —— 2026-10-13 第一次扫描
    // 就是手填 8000 而蓝图实际只有 1500，得到的绝对速度/燃料与船不对应，整批数据不可比。
    // 取不到（蓝图未加载）时退回面板值并明确告知，让使用者知道这批数据可能不可比。
    const bpCap = blueprintStlCapacityOf(blueprintIdOfSelection());
    const overrideText = fScanStlFuelOverride.value.trim();
    const override = overrideText === '' ? undefined : Number(overrideText);
    if (
      override !== undefined &&
      (!Number.isFinite(override) || override < 0 || override > bpCap)
    ) {
      fScanMessage.value = 'STL 出发余油必须在 0 与蓝图罐容量之间。';
      return;
    }
    const payloadText = fScanPayloadOverride.value.trim();
    const payloadOverride = payloadText === '' ? 0 : Number(payloadText);
    if (!Number.isFinite(payloadOverride) || payloadOverride < 0) {
      fScanMessage.value = '载重覆写必须是非负数；留空视为 0。';
      return;
    }
    if (override === undefined && bpCap <= 0) {
      fScanMessage.value =
        '读不到选中蓝图的 STL 罐容量（performance.stlFuelCapacity）——' +
        '请先在游戏里打开蓝图界面；或用矩阵扫描（它强制从蓝图取罐）。';
      return;
    }
    const bpId = blueprintIdOfSelection();
    const perf = blueprintsStore.getByNaturalId(bpId)?.performance;
    const ftlText = fScanFtlFuelOverride.value.trim();
    const ftlTiers =
      ftlText === ''
        ? [undefined]
        : [...new Set(ftlText.split(',').map(x => (x.trim() === '' ? NaN : Number(x.trim()))))];
    const ftlCap = perf?.ftlFuelCapacity ?? 0;
    if (ftlTiers.some(x => x !== undefined && (!Number.isFinite(x) || x < 0 || x > ftlCap))) {
      fScanMessage.value = `每个 FTL 出发余油值必须在 0 与 ${ftlCap} 之间。`;
      return;
    }
    const reactorText = fScanReactor.value.trim();
    const reactorFloor = perf?.minReactorUsage ?? 0;
    const reactorTiers =
      reactorText === ''
        ? [undefined]
        : [...new Set(reactorText.split(',').map(x => (x.trim() === '' ? NaN : Number(x.trim()))))];
    if (
      reactorTiers.some(x => x !== undefined && (!Number.isFinite(x) || x < reactorFloor || x > 1))
    ) {
      fScanMessage.value = `每个反应堆档位必须在 ${reactorFloor} 与 1 之间。`;
      return;
    }
    const condition = Number(fScanCondition.value);
    if (
      fScanCondition.value.trim() === '' ||
      !Number.isFinite(condition) ||
      condition < 0 ||
      condition > 1
    ) {
      fScanMessage.value = '船况必须在 0 与 1 之间。';
      return;
    }
    const scanOptions = {
      probe: from,
      target: to,
      blueprintId: bpId,
      fuelFactors: factors,
      stlFuel: override ?? bpCap,
      payload: payloadOverride,
      condition,
      landing: fScanLanding.value,
      useGateways: fScanGateways.value,
      ftlPreference: fScanFtlPreference.value,
      shouldCancel: () => fScanCancelled.value,
    };
    if (scanOptions.useGateways && from.split('|')[0] !== to.split('|')[0]) {
      fScanMessage.value = '正在读取网关数据…';
      if (!(await ensureGatewayConnections())) {
        fScanMessage.value = '未能读取网关连接，请稍后重试。';
        return;
      }
    }
    const flightInputs = await snapshotFlightInputs(probeAddr, targetAddr);
    const variants: Awaited<ReturnType<typeof scanTransitFuelCurve>>[] = [];
    const configurations = ftlTiers.flatMap(ftlFuel =>
      reactorTiers.map(reactorUsageFactor => ({ ftlFuel, reactorUsageFactor })),
    );
    for (const { ftlFuel, reactorUsageFactor } of configurations) {
      if (fScanCancelled.value) {
        break;
      }
      const result = await scanTransitFuelCurve({
        ...scanOptions,
        ftlFuel,
        reactorUsageFactor,
        onProgress: ({ index, error }) => {
          const tier = `STL ${factors[index - 1]} / FTL 余油 ${ftlFuel ?? ftlCap} / 反应堆 ${reactorUsageFactor ?? '蓝图默认'}`;
          fScanMessage.value = error === undefined ? `已测 ${tier}` : `${tier}：${error}`;
        },
      });
      variants.push(result);
    }
    const first = variants.at(0);
    if (first === undefined) {
      fScanMessage.value = '扫描已停止。';
      return;
    }
    const exportData = variants.length === 1 ? first : { variants };
    downloadFile({ ...exportData, flightInputs }, 'prun-transit-f-scan.json', true);
    const successes = variants.reduce((sum, x) => sum + x.samples.length, 0);
    const failures = variants.reduce((sum, x) => sum + x.errors.length, 0);
    fScanMessage.value = `扫描${fScanCancelled.value ? '已停止' : '完成'}：${successes} 次成功，${failures} 次失败，已导出原始记录。`;
  } catch (e) {
    fScanMessage.value = '扫描失败：' + String(e);
  } finally {
    fScanning.value = false;
  }
}

function stopFScan() {
  fScanCancelled.value = true;
}
</script>

<template>
  <div :class="[$style.container, C.type.typeRegular, C.fonts.fontRegular]">
    <FlightCalculator @blueprint="calculatorBlueprintId = $event" />
    <details :class="$style.diagnostic">
      <summary>数据工具与试飞采集</summary>
      <div :class="$style.form">
        <div :class="$style.actions">
          <PrunButton
            neutral
            :disabled="requestingStars"
            data-tooltip="向游戏服务器请求原生星图（恒星位置与连接），只在点击时请求。用于补全路线规划所需的星系数据。"
            @click="refreshStars">
            {{ requestingStars ? '加载星图…' : '刷新原生星图' }}
          </PrunButton>
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
            data-tooltip="点这里向服务器请求一次网关快照（8 秒等待、60 秒内不重复请求），不需要打开星图；入库后公式模型即可用网关连接。面板其它路径只读已入库数据。"
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
            data-tooltip="导出已记录的原生 STL 段距离，用于离线对照与旧模型数据维护。"
            @click="exportStlSegmentsData">
            导出 STL 段数据
          </PrunButton>
        </div>

        <div v-if="fScanMessage" :class="$style.hint">
          {{ fScanMessage }}
        </div>
        <div :class="$style.scanFields">
          <label :class="$style.field">
            <span>出发天体</span>
            <TextInput v-model="fScanProbe" placeholder="如：HRT" />
          </label>
          <label :class="$style.field">
            <span>目标天体</span>
            <TextInput v-model="fScanTarget" placeholder="如：VH-331g" />
          </label>
          <label :class="$style.field">
            <span>STL 档位（逗号分隔）</span>
            <TextInput v-model="fScanFactors" placeholder="0.05,0.1,0.2,0.3,0.4,0.5" />
          </label>
          <label :class="$style.field">
            <span>反应堆档位（逗号分隔）</span>
            <TextInput v-model="fScanReactor" placeholder="留空按蓝图" />
          </label>
          <label :class="$style.field">
            <span>STL 出发余油（留空按满罐）</span>
            <TextInput v-model="fScanStlFuelOverride" placeholder="留空，或如 3500" />
          </label>
          <label :class="$style.field">
            <span>载重（留空按空载）</span>
            <TextInput v-model="fScanPayloadOverride" placeholder="留空，或如 3000" />
          </label>
          <label :class="$style.field">
            <span>FTL 出发余油（留空按满罐）</span>
            <TextInput v-model="fScanFtlFuelOverride" placeholder="多组用逗号分隔，如 300,0" />
          </label>
          <label :class="$style.field">
            <span>船况（0–1）</span>
            <TextInput v-model="fScanCondition" />
          </label>
          <label :class="$style.field">
            <span>跃迁偏好</span>
            <select v-model="fScanFtlPreference" :class="$style.select">
              <option value="LEAST_JUMPS">最少跳数</option>
              <option value="SHORTEST_FTL">最短 FTL</option>
            </select>
          </label>
          <div :class="[$style.actions, $style.scanActions]">
            <label><input v-model="fScanLanding" type="checkbox" /> 着陆</label>
            <label>
              <input v-model="fScanGateways" type="checkbox" /> 使用网关（{{
                routesStore.gatewayConnectionCount
              }}
              条连接）</label
            >
            <PrunButton
              primary
              :disabled="fScanning || matrixScanning"
              data-tooltip="逐档请求一次 BTF 试飞计划，导出实际请求和服务器分段响应。"
              @click="startFScan">
              {{ fScanning ? '扫描中…' : '扫描试飞档位' }}
            </PrunButton>
            <PrunButton v-if="fScanning" neutral @click="stopFScan">停止</PrunButton>
          </div>
        </div>
        <div :class="$style.fieldRow">
          <label :class="$style.field">
            <span>扫描蓝图（部件编辑在这份上；罐容量自动跟随它）</span>
            <select v-model="scanBlueprintId" :class="$style.select">
              <option value="">跟随计算器蓝图</option>
              <option v-for="b in blueprintOptions" :key="b.naturalId" :value="b.naturalId">
                {{ b.name !== '' ? b.name : b.naturalId }}（{{ b.naturalId }}）
              </option>
            </select>
          </label>
        </div>
        <div v-if="fScanMessage" :class="$style.hint">{{ fScanMessage }}</div>
        <div :class="$style.fieldRow">
          <label :class="$style.field">
            <span>矩阵探针</span>
            <TextInput v-model="matrixProbe" placeholder="如：VH-331g" />
          </label>
          <label :class="$style.field">
            <span>矩阵目标</span>
            <TextInput v-model="matrixTarget" placeholder="如：VH-331e" />
          </label>
          <label :class="$style.field">
            <span>f 档位</span>
            <TextInput v-model="matrixFactors" placeholder="0.05,0.1,0.2,0.3,0.4,0.5" />
          </label>
          <div :class="$style.actions">
            <PrunButton
              neutral
              data-tooltip="按公司现有蓝图生成变体行，罐容量自动取 blueprint.performance.stlFuelCapacity（避免传错罐）。"
              @click="autoFillMatrixRows">
              按蓝图自动填充
            </PrunButton>
            <PrunButton
              primary
              :disabled="matrixScanning || fScanning"
              data-tooltip="跨蓝图矩阵扫描：每个变体（=一套配件）各自跑完整 f 档位。请保证各变体只差一个部件，否则得到的是混合效应。"
              @click="startMatrixScan">
              {{ matrixScanning ? '矩阵扫描中…' : '矩阵扫描' }}
            </PrunButton>
            <PrunButton v-if="matrixScanning" neutral @click="stopMatrixScan">停止</PrunButton>
          </div>
        </div>
        <div v-if="matrixRows.length > 0" :class="$style.hint">
          变体行：
          <span v-for="(r, i) in matrixRows" :key="i">
            {{ r.variant }}（{{ r.blueprintId }}｜罐 {{ r.stlFuel }}）{{
              i < matrixRows.length - 1 ? '、' : ''
            }}
          </span>
        </div>
        <div v-if="matrixMessage" :class="$style.hint">{{ matrixMessage }}</div>
        <div v-if="starsMessage" :class="$style.hint">{{ starsMessage }}</div>
        <div v-if="orbitMessage" :class="$style.hint">{{ orbitMessage }}</div>
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
      </div>
    </details>
  </div>
</template>
