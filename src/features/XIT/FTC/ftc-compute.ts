import { ref } from 'vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { blueprintsStore } from '@src/infrastructure/prun-api/data/blueprints';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { sleep } from '@src/utils/sleep';
import { hasSystemData, exportStationOrbits } from '@src/infrastructure/fio/orbit';
import { planRoutes, routeMetrics, findNativeFlightPlan } from './route-planner';
import type { PlannedRoute } from './route-planner';
import { resolveSystemId } from './route-model';
import {
  scanFuelOptions,
  autoFuelGrid,
  autoReactorGrid,
  findBalanceOption,
  nearbyFuelOptions,
  missingModelInputs,
  FuelOption,
  ShipPerformance,
} from './fuel-model';
import { ftcRouteKey, setFtcFuelSlider, setFtcReactorUsage } from './ftc-fuel-settings';

// 最近一次 FTC 计算完成的航线 key（供等待方轮询：每段飞行前先确保 FTC 最优方案算完）。
// key 格式 = ftcRouteKey(船|起点|终点|gw|nat)，与 ftc-fuel-settings 的航线键逐位一致
// （同一份键同时用于「写入滑块参数」与「等待计算完成」，两者必须能对照）。
// complete=false 表示本次计算输入不完整（缺起终点轨道/罐容量）→ 参数未写入滑块，
// 等待方应直接沿用当前设置，不要按「已就绪」等待滑块变化。
export const lastFtcCompute = ref<{ key: string; at: number; complete: boolean } | undefined>(
  undefined,
);

// 等待某船某航线最近的 FTC 计算完成（OPEN_SFC 设目的地后调用，确保最优燃料
// 滑块应用后再提交飞行；自然/网关任一航线完成即视为就绪）。
// 返回值：ok = 已算出并已写入参数；incomplete = 算完但输入残缺（未写参数）；
// timeout = 超时（由调用方决定沿用当前设置还是报错）。
export async function waitForFtcCompute(
  shipRegistration: string,
  from: string,
  to: string,
  useGateway: boolean,
  timeoutMs = 8000,
): Promise<'ok' | 'incomplete' | 'timeout'> {
  // 与写入方（computeFtcPlan）用同一个键构造器：只差网关标志（调用方读到的单选状态
  // 可能与推送时的快照不同，故两个标志都接受）。
  const key = ftcRouteKey(shipRegistration, from, to, useGateway);
  const alternateKey = ftcRouteKey(shipRegistration, from, to, !useGateway);
  const start = Date.now();
  const deadline = start + timeoutMs;
  while (Date.now() < deadline) {
    const last = lastFtcCompute.value;
    if (last !== undefined && last.at >= start && (last.key === key || last.key === alternateKey)) {
      return last.complete ? 'ok' : 'incomplete';
    }
    await sleep(100);
  }
  return 'timeout';
}

// FTC 最优燃料计算的共享编排层：不依赖 FTC 面板（Vue 组件），
// SFC 自动设置（features/basic/sfc-auto-fuel-settings）与 FTC 面板共用。
// 计算成功后把最优参数写入 ftc-fuel-settings 的共享 ref，SFC 滑块自动跟随。

// ⚠️ 曾经有过「航线几何缓存」（面板算完存 metrics，SFC 联动复用），2026-09-23 复核
// 后删除：不可达 + 键/TTL 有缺陷。三条几何来源全部是进程内共享且跨会话持久化的
// store（orbit.ts `planets` → `rprun.fio.orbit.v1`、system-bodies.ts `positions` →
// `rprun.ftc.bodies.v1`、原生 STL 段 → `rprun.ftc.stl-segments.v1`），面板与 SFC 联动
// 是同一个 content script 里的同一模块实例 —— 「面板算得完整几何」本身就已把共享
// 数据补齐，SFC 重算时不可能仍缺 → 读缓存分支不可达。且其键用的是 planRoutes 的
// 原始输入文本（别名必 miss）、不含飞船（跨船复用 departSeconds）、TTL 6h 无依据
// （6h 轨道半径漂移可达 d 的 ~1%，反而放大误差）。不再缓存：几何要么当场完整、
// 要么按 missingModelInputs 判定为残缺并跳过参数写入。

// ---- 蓝图性能提取（飞船 → 模型输入）----

export interface BlueprintInfo {
  ftlMaxSpeed?: number;
  stlEngine?: string;
  reactorPower?: number;
  stlFuelCapacity?: number;
  minReactorUsage?: number;
  emitterChargeTime?: number;
  maxGFactor?: number;
}

// 蓝图性能（FTL 最大航速、STL 引擎、FTL 充能/燃料参数）。
export function blueprintInfoFor(s: PrunApi.Ship): BlueprintInfo | undefined {
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
}

// 飞船实时性能 → 模型输入。
export function shipPerformanceFor(s: PrunApi.Ship): ShipPerformance {
  // FTL 最大航速优先从蓝图读取（pc/s → pc/h），无蓝图时回退到 2.26 pc/h。
  const info = blueprintInfoFor(s);
  const ftlMaxSpeed = info?.ftlMaxSpeed ?? 2.26;
  // 当前 STL 罐余量（油罐 store 实测）：段燃料/段速度基准用余量而非罐容量。
  const remaining = shipFuelRemainingFor(s);
  return {
    mass: s.mass,
    operatingEmptyMass: s.operatingEmptyMass,
    acceleration: s.acceleration,
    thrust: s.thrust,
    ftlMaxSpeed,
    stlFuelFlowRate: s.stlFuelFlowRate,
    reactorPower: info?.reactorPower ?? s.reactorPower,
    condition: s.condition,
    stlEngineOption: info?.stlEngine,
    maxGFactor: info?.maxGFactor,
    minReactorUsage: info?.minReactorUsage,
    emitterChargeTime: info?.emitterChargeTime,
    stlFuelCapacity: info?.stlFuelCapacity,
    stlRemaining: remaining.stlRemaining > 0 ? remaining.stlRemaining : undefined,
  };
}

// 飞船当前剩余 STL / FTL 燃料（从飞船油罐 store 实测）。
// 油罐 store 含 INVENTORY 项，quantity.amount 即剩余单位数（与 BTF 滑块同单位）。
// 飞船未停靠或油罐 store 暂不可用时返回 0（避免误报）。
export interface ShipFuelRemaining {
  stlRemaining: number;
  ftlRemaining: number;
  stlCap: number;
  ftlCap: number;
}

export function shipFuelRemainingFor(s: PrunApi.Ship): ShipFuelRemaining {
  // ⚠️ 必须用 getById（键 = store id），**不是** getByAddressableId（键 = 仓库可寻址地址 /
  // siteId / warehouseId）：两者键类型不同，传 store id 进后者永远查不到 → 余量恒 0
  // （用户 2026-09-25 实测症状「当前油量 STL 0/0 ｜ FTL 0/0」+ 假缺口警告的根因）。
  // 飞船同时有 stlFuelStoreId 与 idStlFuelStore 两个字段（见 ships.types.d.ts），与
  // QuickRefuelDialog.vue 同口径：优先前者、回退后者（实测两者都下发，留回退防缺字段）。
  // getById 对 undefined/未 fetched 入参安全（create-entity-store.ts 内 `!id` 判空）。
  const stlStore = storagesStore.getById(s.stlFuelStoreId ?? s.idStlFuelStore);
  const ftlStore = storagesStore.getById(s.ftlFuelStoreId ?? s.idFtlFuelStore);
  const sumQty = (store?: PrunApi.Store) =>
    store?.items
      .filter(i => i.type === 'INVENTORY')
      .reduce((sum, i) => sum + (i.quantity?.amount ?? 0), 0) ?? 0;
  return {
    stlRemaining: sumQty(stlStore),
    ftlRemaining: sumQty(ftlStore),
    stlCap: stlStore?.weightCapacity ?? 0,
    ftlCap: ftlStore?.weightCapacity ?? 0,
  };
}

// 等待飞船蓝图加载：FTL 航速/充能时间/燃料罐容量/STL 引擎/最大 G 等性能全部来自蓝图
// （blueprintsStore 只含公司蓝图列表，首次访问 getByNaturalId 会触发 BLU 窗口请求，
// 响应异步到达——不等待则本次计算全部落到默认值，误差巨大，如把省油引擎当超推力）。
// 返回是否成功取得蓝图；失败（非公司蓝图/响应超时）时继续用默认值计算。
export async function ensureShipBlueprint(s: PrunApi.Ship): Promise<boolean> {
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

// 自动浏览星系（不止空间站）：逐个打开目标星系的星系详情（游戏命令
// `MS <systemId>`，Map: Star System），客户端自动请求 DATA_DATA["systems", id]，
// orbit.ts 监听积累该星系全部数据——恒星质量 + 行星/空间站轨道（celestialBodies）。
// DATA_DATA 到达后自动关闭窗口。FIO 无空间站数据，这是唯一能离线补全空间站轨道的
// 方式（模拟用户浏览星系，符合"插件不主动请求数据"约束）。
// 在计算时调用：起终点星系阻塞等待，其余无轨道空间站的归属星系后台渐进（不阻塞）。
// ⚠️ 2026-09-23 起 STL 起降几何只取服务器原生记录（自建轨道模型回退已删除），浏览星系
// 积累的轨道数据**不再**参与几何计算 —— 这里保留开窗仅为兼容既有行为与导出/诊断用途；
// 「是否还有必要阻塞等待」待评估（本轮只记录，不改 browse 语义）。
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

// 行星环境数据（半径 km / 气压）内置静态 JSON（FIO 全量导出，避免运行时查询）。
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
export async function fetchPlanetEnv(
  naturalId: string,
): Promise<{ radiusKm: number; pressure?: number } | undefined> {
  await loadPlanetEnv();
  const env = planetEnvData?.[naturalId.toUpperCase()];
  if (env === undefined) {
    return undefined;
  }
  return { radiusKm: env.r, pressure: env.p };
}

// ---- 计算入口 ----

export interface FtcComputeInput {
  shipRegistration: string;
  from: string;
  to: string;
  useGateway?: boolean;
  stlPrice?: number;
  ftlPrice?: number;
  timeValue?: number;
  // 是否自动浏览星系轨道数据（默认 true）。SFC 自动联动（环线/飞行前）传 false：
  // 计算时不开星系窗口——环线自动执行时开窗会抢占缓冲槽位、干扰 SFC 面板导致
  // 无法自动出发；星系数据未积累时用已有数据（**无回退**，几何缺失即判 incomplete
  // 不写滑块，等服务器下发该航线的原生 STL 段记录）。
  browse?: boolean;
  // 进度提示回调（可选：FTC 面板用它更新状态栏；SFC 自动计算时忽略）。
  onProgress?: (message: string) => void;
}

export interface FtcComputeOutput {
  ok: boolean;
  message: string;
  route?: PlannedRoute;
  metrics?: ReturnType<typeof routeMetrics>;
  best?: FuelOption;
  // 邻档对比：最优燃料滑块前后各 5 档（同反应堆）的方案，供面板展示边际代价。
  // 残缺输入时同样返回（玩家可借它看到退化形态），面板按 inputIncomplete 自行提示。
  nearby?: FuelOption[];
  reactorRelevant?: boolean;
  // 跨星系航线起/终点行星环境（模型分段用）。
  landingRadius?: number;
  landingPressure?: number;
  departureRadius?: number;
  departurePressure?: number;
  // 飞船当前剩余 STL/FTL 燃料（油罐 store 实测），供面板显示当前油量与缺口。
  remaining?: { stlRemaining: number; ftlRemaining: number; stlCap: number; ftlCap: number };
  // 服务器当前对该航线下发的原生 FlightPlan（与 SFC「蓝图试航模拟」显示一致）——
  // 供面板展示「实测总时长」对照（与最优方案并列）；不随 FTC 建议的 f 变化，故仅作并行展示。
  // 缺值（= 服务器还没下发该航线计划）→ 面板不显示该提示，与 best 的可选标记独立。
  nativePlan?: PrunApi.FlightPlan;
  // 模型必需输入缺失（见 fuel-model.missingModelInputs）：undefined = 输入完整、
  // best 可采信且已写入共享参数；有值时 best 基于残缺输入（退化），**未**写入共享参数，
  // SFC 自动联动须跳过滑块写入。
  inputIncomplete?: string[];
}

// 计算最优燃料方案并写入共享参数（ftc-fuel-settings），无需 FTC 面板打开。
export async function computeFtcPlan(input: FtcComputeInput): Promise<FtcComputeOutput> {
  const from = input.from.trim();
  const to = input.to.trim();
  if (!from || !to) {
    return { ok: false, message: '请输入起点和终点' };
  }
  const s = shipsStore.getByRegistration(input.shipRegistration);
  if (!s) {
    return { ok: false, message: '请选择停靠中的飞船' };
  }
  const progress = input.onProgress ?? (() => {});
  // 关键：计算前等待飞船蓝图加载（决定 FTL 航速/充能/燃料罐/引擎等性能）。
  const bpOk = await ensureShipBlueprint(s);
  if (!bpOk) {
    progress('未获取到飞船蓝图（非公司蓝图或请求超时），已用默认性能估算，结果可能不准');
  }
  const perf = shipPerformanceFor(s);
  // 计算时自动浏览星系（可选）：起终点星系阻塞获取轨道/恒星质量数据，
  // 其余无轨道空间站星系后台渐进。SFC 联动（browse=false）跳过开窗，避免干扰。
  if (input.browse !== false) {
    const targets = collectBrowseTargets(from, to);
    if (targets.critical.length > 0) {
      progress(`正在获取起终点星系轨道数据（${targets.critical.join('、')}）…`);
      await browseSystems(targets.critical);
    }
    if (targets.background.length > 0) {
      void browseSystems(targets.background);
    }
  }
  const planned = planRoutes(from, to);
  const route = input.useGateway ? (planned.gateway ?? planned.natural) : planned.natural;
  if (!route) {
    return { ok: false, message: '无法解析起终点或航线不可达（需恒星位置数据，请先打开星图）' };
  }
  const metrics = routeMetrics(route);
  // 跨星系航线的起/终点行星环境（内置 JSON）：着陆（半径+气压）与起飞段（出发行星）。
  // 空间站（全大写 naturalId）不在行星数据中 → undefined → 无着陆/起飞段（无大气）。
  const isCrossSystem = (metrics.natPc ?? 0) > 0 || (metrics.gwPc ?? 0) > 0;
  // ⚠️ 2026-09-23：原先「勾选「使用跃迁点」的**跨星系**航线一律判缺（网关结构不产生按跳键）」
  // 已删除 —— 那是错误认知。服务器计划照常写出航线级 STL 记录（含网关跃迁时键带 `#gw`
  // 后缀，见 system-bodies.recordStlSegments），缺几何只意味着服务器还没下发这条航线的记录，
  // 与是否勾选无关；系内勾选与不勾选是同一条路、同一份原生几何。
  // 输入完整性（决定结果能否写入 SFC 滑块）：仍缺关键几何/罐容量时模型必然退化
  // （同星系 stlFuel ≡ 0 → 燃料无梯度），此时绝不能把结果写进滑块 —— 宁可不动，
  // 也不要用残缺输入得出的假值覆盖掉面板已经算好的参数。
  const inputIncomplete = missingModelInputs(perf, metrics);
  const [landingEnv, departEnv] = await Promise.all([
    isCrossSystem && metrics.toBody !== undefined ? fetchPlanetEnv(metrics.toBody) : undefined,
    isCrossSystem && metrics.fromBody !== undefined ? fetchPlanetEnv(metrics.fromBody) : undefined,
  ]);
  // 无需玩家设置档位：自动扫描全范围燃料滑块 f；反应堆 r 仅在存在自然跃迁时扫描
  // （全程系内/纯网关飞行没有自然跃迁，反应堆不影响时长与燃料，无需计算）。
  const reactorRelevant = (metrics.natPc ?? 0) > 0 || (metrics.natJumpCount ?? 0) > 0;
  // 读飞船当前剩余 STL/FTL 燃料（油罐 store 实测）。后续给每条方案算缺口，
  // FTC 面板显示「当前油够不够这趟飞」。
  const remaining = shipFuelRemainingFor(s);
  const options = scanFuelOptions(
    perf,
    metrics,
    autoFuelGrid(),
    reactorRelevant ? autoReactorGrid(perf) : [1],
    {
      stlPrice: input.stlPrice ?? 0,
      ftlPrice: input.ftlPrice ?? 0,
      timeValue: input.timeValue ?? 0,
    },
    {
      landingRadius: landingEnv?.radiusKm,
      landingPressure: landingEnv?.pressure,
      departureRadius: departEnv?.radiusKm,
      departurePressure: departEnv?.pressure,
    },
    remaining,
  );
  if (options.length === 0) {
    return { ok: false, message: '计算失败：未能生成有效的滑块组合' };
  }
  // 平衡点：设了时间价值（₳/小时）时按总成本（燃料费 + 时间价值）最优，
  // 即经济上的真正平衡；未设时用 Pareto 拐点——尽量快的同时燃料消耗少，两端都不极端。
  const tv = input.timeValue ?? 0;
  const best = tv > 0 ? options[0] : (findBalanceOption(options) ?? options[0]);
  // 共享给 SFC 自动设置：按**航线**（船 + 起终点 + 网关标志）写入本次计算的最优燃料滑块 /
  // 反应堆使用量。按航线键控后，同船换新目的地时读不到上一条航线的值（读不到 = 不改滑块），
  // 不会再出现「上一条航线的参数落到新航线」；多船 SFC 面板同时打开时各写各自的键，
  // 互不覆盖。
  // ⚠️ 仅在输入完整时写入：残缺输入下 best 必然退化（f = 1 / 0.05 这类假值），
  // 写进去会覆盖面板刚算好的正确参数，正是「SFC 自动拉条 ≠ FTC 面板结果」的成因。
  const routeKey = ftcRouteKey(input.shipRegistration, from, to, input.useGateway === true);
  if (inputIncomplete.length === 0) {
    setFtcFuelSlider(routeKey, best.fuel);
    setFtcReactorUsage(routeKey, best.reactor);
  }
  // 记录本次计算的航线，供 OPEN_SFC 等动作等待（每段飞行前先算好最优燃油）。
  // key 与上面的滑块参数键**同一个字符串**（等待方按 key 匹配 + 按同一键读滑块值）；
  // complete=false：输入残缺、参数未写入滑块，等待方直接沿用当前设置。
  lastFtcCompute.value = {
    key: routeKey,
    at: Date.now(),
    complete: inputIncomplete.length === 0,
  };
  // 服务器当前对该航线下发的原生 FlightPlan（用于面板并行展示实测总时长）。
  // 用反查后的实体键匹配（SFC 把空间站目的地规范化成所属星系 id，原生计划的目标端是
  // 不可变实体 id，与 metrics.fromLookup/toLookup 一致）；查不到即 undefined，面板不显示。
  const nativePlan = findNativeFlightPlan(
    metrics.fromLookup ?? route.fromBody ?? from,
    metrics.toLookup ?? route.toBody ?? to,
  );
  return {
    ok: true,
    message:
      inputIncomplete.length > 0
        ? `⚠ 输入不完整（缺 ${inputIncomplete.join('、')}）：结果基于残缺输入退化，` +
          '未应用到 SFC 滑块（按缺失项里的说明处理后重算）'
        : '',
    route,
    metrics,
    best,
    nearby: nearbyFuelOptions(options, best),
    reactorRelevant,
    inputIncomplete: inputIncomplete.length > 0 ? inputIncomplete : undefined,
    landingRadius: landingEnv?.radiusKm,
    landingPressure: landingEnv?.pressure,
    departureRadius: departEnv?.radiusKm,
    departurePressure: departEnv?.pressure,
    remaining,
    nativePlan,
  };
}
