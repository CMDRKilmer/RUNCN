// 受控 BTF 扫描：系内转移段 f 曲线（2026-10-13）。
//
// 目的：补齐 `STL_INTRA_TRANSIT_SPEED_KM_S` 缺失的地面真值。
//   `fuel-model.ts` 的系内转移段速度 = 27,512 ,km/s × (质量幂律) × (引擎 f 曲线)，
//   而 27,512 这个锚点来自 BTF 样本 `VH-331g → HRT`（599,220,390 km / 21,780 s），
//   **该样本没有记录 f** —— 全模型的 f 依赖只有这一个点 + 一条假设的曲线形状。
//   本扫描固定船/航线/罐，只变 f，逐点取服务器原生时长与燃料作真值。
//
// 与 `flight-test-collector` 共用同一条服务器通道（socket.io 直接发
// SHIP_FLIGHT_CALCULATE_TEST_FLIGHT，无需打开面板），故 `calculateTestFlight`
// 已参数化（2026-10-13）。
//
// ⚠️ 只读：只发「计算一次飞行计划」的请求，不提交飞行、不改游戏状态。
// 会触发服务器计算，量级由调用方（面板按钮）控制。

import { calculateTestFlight } from './flight-test-collector';
import { blueprintsStore } from './blueprints';
import { shipsStore } from './ships';
import { sendServerMessage } from '../socket-io-middleware';
import { companyContextId } from './user-data';
import { sleep } from '@src/utils/sleep';
import { watchUntil } from '@src/utils/watch';

// ---- 地址编码（与 flight-test-collector 同口径，避免两处漂移）----

/** 把「星系|类型,实体id」地址编码为测试飞行请求的 origin/destination。 */
export function encodeTestAddress(systemId: string, kind: 'PLA' | 'STA', bodyId: string): string {
  return `${systemId}|${kind},${bodyId}`;
}

// ---- 单点测量 ----

/** 一个 f 档的实测结果（全部取自服务器原生 FlightPlan）。 */
export interface TransitSample {
  fuelUsageFactor: number;
  // 原生段（全部 STL 段之和，含 TRANSIT）
  totalSeconds: number;
  totalStlKm: number;
  stlFuel: number;
  // 「转移」（TRANSIT）段单独统计（系内航线的真实结构）
  transitSeconds: number;
  transitKm: number;
  transitFuel: number;
  // 由原生数据反推的平均速度（km/s）
  totalAvgKmS: number;
  transitAvgKmS: number;
  segmentTypes: string[];
}

// 从一个原生 FlightPlan 提取 STL 量化指标。
export function summarizeStl(plan: PrunApi.FlightPlan, fuelUsageFactor: number): TransitSample {
  const secs = (a?: PrunApi.DateTime, b?: PrunApi.DateTime) =>
    Math.max(0, ((a?.timestamp ?? 0) - (b?.timestamp ?? 0)) / 1000);
  let totalSeconds = 0;
  let totalStlKm = 0;
  let stlFuel = 0;
  let transitSeconds = 0;
  let transitKm = 0;
  let transitFuel = 0;
  for (const seg of plan.segments) {
    const s = secs(seg.arrival, seg.departure);
    totalSeconds += s;
    if (seg.stlDistance !== null && seg.stlDistance > 0) {
      totalStlKm += seg.stlDistance;
    }
    if (seg.stlFuelConsumption !== null && seg.stlFuelConsumption > 0) {
      stlFuel += seg.stlFuelConsumption;
    }
    if (seg.type === 'TRANSIT') {
      transitSeconds += s;
      if (seg.stlDistance !== null && seg.stlDistance > 0) {
        transitKm += seg.stlDistance;
      }
      if (seg.stlFuelConsumption !== null && seg.stlFuelConsumption > 0) {
        transitFuel += seg.stlFuelConsumption;
      }
    }
  }
  return {
    fuelUsageFactor,
    totalSeconds,
    totalStlKm,
    stlFuel,
    transitSeconds,
    transitKm,
    transitFuel,
    totalAvgKmS: totalSeconds > 0 ? totalStlKm / totalSeconds : 0,
    transitAvgKmS: transitSeconds > 0 ? transitKm / transitSeconds : 0,
    segmentTypes: plan.segments.map(x => x.type),
  };
}

// ---- 扫描 ----

export interface TransitFScanOptions {
  // 探针（固定不动的另一端）naturalId，如 'HRT'。
  probe: string;
  // 目标行星/空间站 naturalId，如 'VH-331g'。
  target: string;
  // 蓝图 naturalId；缺省取公司第一份蓝图。
  blueprintId?: string;
  // f 档位列表。
  fuelFactors: number[];
  // 段可用 STL 燃料（u）。★罐容量代理；系内转移段燃料口径 = 0.98×罐×min(f,0.5)。
  stlFuel: number;
  // 载重（t）。缺省 0。
  payload?: number;
  // 船体状况。缺省 1。
  condition?: number;
  // 反应堆使用量。缺省 0.6510416666666667。
  reactorUsageFactor?: number;
  // 变体标签：随结果回传，供矩阵扫描区分「这套配件测出来的是哪组数据」。
  // 例：'STL=SAVING,TANK=MED,REACTOR=STD'。同一次扫描内不变。
  variant?: string;
  onProgress?: (info: {
    index: number;
    total: number;
    sample?: TransitSample;
    error?: string;
  }) => void;
  shouldCancel?: () => boolean;
}

// 该变体所测蓝图的**部件快照**。
// 为什么必须带上：2026-10-13 那次采集传给服务器的罐（8000）与该蓝图真实罐（1500）不一致，
// 而产物里只有一个 stlFuel 数字，事后无法判断「这组速度到底属于哪套部件」——
// 整批数据作废且无法复核。把部件写进产物，数据才能自证当次配置。
export interface BlueprintSnapshot {
  // STL 引擎选项（selections 里 type === 'STL_ENGINE' 的 option）
  stlEngine?: string;
  // STL 燃料罐选项（selections 里 type === 'STL_FUEL_TANK' 的 option）
  stlFuelTank?: string;
  // 蓝图整备质量（t）
  operatingEmptyMass?: number;
  // 蓝图 STL 罐容量（u）。**应与本次请求的 stlFuel 相同**；不同即口径错配，该变体应作废。
  stlFuelCapacity?: number;
  // 全部 selections 原样转储（type -> option），供事后追查任何部件。
  selections?: Record<string, string>;
}

/** 从蓝图提取部件快照。字段缺失时留空，不编造。 */
export function blueprintSnapshotOf(bp: PrunApi.Blueprint): BlueprintSnapshot {
  const selections: Record<string, string> = {};
  for (const s of bp.selections ?? []) {
    if (s.type !== undefined && s.option !== undefined) {
      selections[s.type] = s.option;
    }
  }
  const perf = bp.performance ?? {};
  const num = (v: number | undefined) =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  return {
    stlEngine: selections.STL_ENGINE,
    stlFuelTank: selections.STL_FUEL_TANK,
    operatingEmptyMass: num(perf.operatingEmptyMass),
    stlFuelCapacity: num(perf.stlFuelCapacity),
    selections,
  };
}

export interface TransitFScanResult {
  probe: string;
  target: string;
  blueprintId: string;
  stlFuel: number;
  payload: number;
  condition: number;
  // 部件快照（见上）。采集时写入，供事后复核当次测得的是哪套部件。
  blueprint: BlueprintSnapshot;
  // 变体标签（矩阵扫描用：同一次扫描内不变，但跨扫描用于区分是哪套配件）。
  // 由调用方传入并原样回传，便于离线把「哪套配件」与「哪组速度」对上。
  variant?: string;
  samples: TransitSample[];
  errors: { fuelUsageFactor: number; error: string }[];
}

/** 确保蓝图已加载（与采集流程同一等待策略）。 */
async function ensureBlueprint(): Promise<PrunApi.Blueprint | undefined> {
  blueprintsStore.request();
  const ready = watchUntil(() => blueprintsStore.fetched.value || false)
    .then(() => true)
    .catch(() => false);
  const ok = await Promise.race([ready, sleep(20000).then(() => false)]);
  return ok ? blueprintsStore.all.value?.[0] : undefined;
}

/**
 * 固定船/航线/罐，只扫 f —— 系内转移段 f 曲线。
 * 返回每个 f 档的原生时长/距离/燃料，由调用方导出比对模型。
 */
export async function scanTransitFuelCurve(
  options: TransitFScanOptions,
): Promise<TransitFScanResult> {
  const bp =
    options.blueprintId !== undefined
      ? blueprintsStore.getByNaturalId(options.blueprintId)
      : await ensureBlueprint();
  if (!bp) {
    throw new Error('没有可用蓝图，请先在游戏里打开一次蓝图界面');
  }
  const fromAddr = options.probe;
  const toAddr = options.target;
  const result: TransitFScanResult = {
    probe: options.probe,
    target: options.target,
    blueprintId: bp.naturalId,
    stlFuel: options.stlFuel,
    payload: options.payload ?? 0,
    condition: options.condition ?? 1,
    blueprint: blueprintSnapshotOf(bp),
    ...(options.variant !== undefined ? { variant: options.variant } : {}),
    samples: [],
    errors: [],
  };
  const total = options.fuelFactors.length;
  for (let i = 0; i < total; i++) {
    if (options.shouldCancel?.()) {
      break;
    }
    const f = options.fuelFactors[i]!;
    try {
      const plan = await calculateTestFlight(fromAddr, toAddr, bp.id, 20000, {
        fuelUsageFactor: f,
        stlFuel: options.stlFuel,
        payload: options.payload ?? 0,
        condition: options.condition ?? 1,
        reactorUsageFactor: options.reactorUsageFactor,
        landing: true,
      });
      if (!plan) {
        result.errors.push({ fuelUsageFactor: f, error: '超时/无响应' });
        options.onProgress?.({ index: i + 1, total, error: '超时/无响应' });
        continue;
      }
      const sample = summarizeStl(plan, f);
      result.samples.push(sample);
      options.onProgress?.({ index: i + 1, total, sample });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.errors.push({ fuelUsageFactor: f, error: msg });
      options.onProgress?.({ index: i + 1, total, error: msg });
    }
    // 服务器限速礼貌间隔
    await sleep(300);
  }
  return result;
}

// 供面板探针解析：把 naturalId 解析成可请求的地址编码。
// 行星：XX-XXX + 小写字母（VH-331g）；空间站：全大写（HRT）。
export function entityKindOf(naturalId: string): 'PLA' | 'STA' {
  return /^[A-Za-z]{2}-\d{3}[A-Za-z]$/.test(naturalId.trim()) ? 'PLA' : 'STA';
}

export function systemIdOfEntity(naturalId: string): string | undefined {
  return naturalId
    .trim()
    .toUpperCase()
    .match(/^([A-Z]{2}-\d{3})/)?.[1];
}

// 供诊断：确认 socket 通道可用（与 collector 同判据）。
export function testChannelReady(): boolean {
  return sendServerMessage({
    messageType: '__rprun_probe__',
    actionId: crypto.randomUUID(),
    contextId: companyContextId.value,
    payload: {},
  });
}

// 供扫描脚本读取当前可用蓝图清单。
export function listBlueprintIds(): { naturalId: string; name: string }[] {
  return (blueprintsStore.all.value ?? []).map(b => ({
    naturalId: b.naturalId,
    name: b.name ?? '',
  }));
}

// 供扫描脚本读取当前飞船（对照 mass/operatingEmptyMass/罐）。
export function listShipSummaries() {
  return (shipsStore.all.value ?? []).map(s => ({
    registration: s.registration,
    name: s.name,
    blueprintNaturalId: s.blueprintNaturalId,
    mass: s.mass,
    operatingEmptyMass: s.operatingEmptyMass,
    acceleration: s.acceleration,
    stlFuelFlowRate: s.stlFuelFlowRate,
    condition: s.condition,
  }));
}

// ---- 配件矩阵扫描 ----

/** 矩阵扫描的一个变体：一套配件 + 一个蓝图。 */
export interface TransitMatrixEntry {
  // 该变体的蓝图 naturalId（现实里 = 你在游戏里为这套配件建的那份蓝图）。
  blueprintId: string;
  // 人类可读标签，原样回传，用于把「哪套配件」与「哪组数据」对上。
  variant: string;
  // 该变体的段可用 STL 燃料（u）。★应与该蓝图 performance.stlFuelCapacity 一致，
  // 否则测到的是「另一个罐」的数据 —— 2026-10-13 第一次扫描就踩过这个坑
  // （蓝图罐 1500，扫描传 8000，得到的绝对速度/燃料与船不对应）。
  stlFuel: number;
}

export interface TransitMatrixScanOptions {
  probe: string;
  target: string;
  entries: TransitMatrixEntry[];
  fuelFactors: number[];
  payload?: number;
  condition?: number;
  reactorUsageFactor?: number;
  onVariantStart?: (info: { index: number; total: number; variant: string }) => void;
  onProgress?: (info: {
    variant: string;
    index: number;
    total: number;
    sample?: TransitSample;
    error?: string;
  }) => void;
  shouldCancel?: () => boolean;
}

export interface TransitMatrixScanResult {
  probe: string;
  target: string;
  fuelFactors: number[];
  variants: TransitFScanResult[];
}

/**
 * 跨蓝图扫 f 曲线：每个变体（= 一套配件）各自跑一遍完整 f 档位。
 *
 * 两个必须由调用方保证的前提（否则数据不可比）：
 *   1. 每个变体的 stlFuel 必须等于该蓝图 performance.stlFuelCapacity
 *      —— 否则测的不是这套配件的真实罐状态；
 *   2. 变体之间只应差一个部件才可比（单变量），否则只能得到混合效应。
 *      本函数不校验这一点（它看不到你的实验设计），请由调用方的 entry 列表保证。
 */
export async function scanTransitMatrix(
  options: TransitMatrixScanOptions,
): Promise<TransitMatrixScanResult> {
  const variants: TransitFScanResult[] = [];
  const total = options.entries.length;
  for (let i = 0; i < total; i++) {
    if (options.shouldCancel?.()) {
      break;
    }
    const entry = options.entries[i]!;
    options.onVariantStart?.({ index: i + 1, total, variant: entry.variant });
    const r = await scanTransitFuelCurve({
      probe: options.probe,
      target: options.target,
      blueprintId: entry.blueprintId,
      fuelFactors: options.fuelFactors,
      stlFuel: entry.stlFuel,
      payload: options.payload,
      condition: options.condition,
      reactorUsageFactor: options.reactorUsageFactor,
      variant: entry.variant,
      onProgress: info => {
        options.onProgress?.({ variant: entry.variant, ...info });
      },
      shouldCancel: options.shouldCancel,
    });
    variants.push(r);
  }
  return {
    probe: options.probe,
    target: options.target,
    fuelFactors: options.fuelFactors,
    variants,
  };
}
