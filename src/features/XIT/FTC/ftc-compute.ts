import { ref } from 'vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { blueprintsStore } from '@src/infrastructure/prun-api/data/blueprints';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { sleep } from '@src/utils/sleep';
import { hasSystemData, exportStationOrbits } from '@src/infrastructure/fio/orbit';
import { planRoutes, routeMetrics } from './route-planner';
import type { PlannedRoute } from './route-planner';
import { resolveSystemId } from './route-model';
import {
  scanFuelOptions,
  autoFuelGrid,
  autoReactorGrid,
  findBalanceOption,
  FuelOption,
  ShipPerformance,
} from './fuel-model';
import { ftcFuelSlider, ftcReactorUsage } from './ftc-fuel-settings';

// FTC 最优燃料计算的共享编排层：不依赖 FTC 面板（Vue 组件），
// SFC 自动设置（features/basic/sfc-auto-fuel-settings）与 FTC 面板共用。
// 计算成功后把最优参数写入 ftc-fuel-settings 的共享 ref，SFC 滑块自动跟随。

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
  // 进度提示回调（可选：FTC 面板用它更新状态栏；SFC 自动计算时忽略）。
  onProgress?: (message: string) => void;
}

export interface FtcComputeOutput {
  ok: boolean;
  message: string;
  route?: PlannedRoute;
  metrics?: ReturnType<typeof routeMetrics>;
  best?: FuelOption;
  reactorRelevant?: boolean;
  // 跨星系航线起/终点行星环境（模型分段用）。
  landingRadius?: number;
  landingPressure?: number;
  departureRadius?: number;
  departurePressure?: number;
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
  // 计算时自动浏览星系（无需手动按钮）：起终点星系阻塞获取轨道/恒星质量数据，
  // 其余无轨道空间站星系后台渐进。浏览后可离线预测起降位置，STL 距离更准。
  const targets = collectBrowseTargets(from, to);
  if (targets.critical.length > 0) {
    progress(`正在获取起终点星系轨道数据（${targets.critical.join('、')}）…`);
    await browseSystems(targets.critical);
  }
  if (targets.background.length > 0) {
    void browseSystems(targets.background);
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
  const [landingEnv, departEnv] = await Promise.all([
    isCrossSystem && metrics.toBody !== undefined ? fetchPlanetEnv(metrics.toBody) : undefined,
    isCrossSystem && metrics.fromBody !== undefined ? fetchPlanetEnv(metrics.fromBody) : undefined,
  ]);
  // 无需玩家设置档位：自动扫描全范围燃料滑块 f；反应堆 r 仅在存在自然跃迁时扫描
  // （全程系内/纯网关飞行没有自然跃迁，反应堆不影响时长与燃料，无需计算）。
  const reactorRelevant = (metrics.natPc ?? 0) > 0 || (metrics.natJumpCount ?? 0) > 0;
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
  );
  if (options.length === 0) {
    return { ok: false, message: '计算失败：未能生成有效的滑块组合' };
  }
  // 平衡点：设了时间价值（₳/小时）时按总成本（燃料费 + 时间价值）最优，
  // 即经济上的真正平衡；未设时用 Pareto 拐点——尽量快的同时燃料消耗少，两端都不极端。
  const tv = input.timeValue ?? 0;
  const best = tv > 0 ? options[0] : (findBalanceOption(options) ?? options[0]);
  // 共享给 SFC 自动设置：写入本次计算的最优燃料滑块 / 反应堆使用量。
  ftcFuelSlider.value = best.fuel;
  ftcReactorUsage.value = best.reactor;
  return {
    ok: true,
    message: '',
    route,
    metrics,
    best,
    reactorRelevant,
    landingRadius: landingEnv?.radiusKm,
    landingPressure: landingEnv?.pressure,
    departureRadius: departEnv?.radiusKm,
    departurePressure: departEnv?.pressure,
  };
}
