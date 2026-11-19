<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import { findStationBySystemId } from '@src/infrastructure/prun-ui/utils/select-address';
import type { ShipChainPlan } from './chain-allocation';
import { chainPurchasePackage } from './chain-actions';
import { getActiveChainRuns } from './chain-run';
import {
  addNativeStep,
  addWaypoint,
  createNativeRoute,
  fillNativeStep,
  fillNativeWaypointFuel,
  isNativeRouteOpen,
  NativeStepButtonUnavailable,
  nativeRouteRepeats,
  nameNativeRoute,
  openNativeRoute,
  openNativeStep,
  openNativeWaypointEditor,
  openRouteList,
  parkWindow,
  prepareWaypoint,
  saveNativeStep,
  saveNativeWaypointFuel,
  unparkWindow,
} from './native-route-editor';
import { computeNativeRouteFuel } from './native-route-fuel';
import { recordNativeRoute } from './native-route-registry';
import {
  socketDeleteRoute,
  socketSetRouteRepeats,
  writeNativeRouteBySocket,
} from './native-route-socket';
import {
  DEFAULT_WAYPOINT_FUEL_PERCENT,
  hoursInvalidatedBySettingChange,
  isWaypointPercent,
  type NativeRouteStep,
  type NativeWaypoint,
  type RouteTank,
} from './native-route-plan';
import {
  billWeightVolume,
  roundBill as buildRoundBill,
  stockingRoundsMax,
  sustainRounds,
  cycleDaysFromHours,
} from './native-route-loop';
import { billFromLoadSteps, cxShortfallPackage, readOriginStock } from './native-route-purchase';
import { shipChainCapacity } from './chain-allocation';
import { formatFlightDuration } from './chain-format';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { stagedDispatch } from './staged';

// 清理上一次未完成航线失败时抛出：绝不能继续写新航线，否则旧航线会变成无人认领的残留。
class PartialRouteCleanupError extends Error {}

const {
  candidate,
  initialWaypoints,
  chainName = '',
  autoStart = false,
  loop = false,
  cycleHours,
  loopFuel,
} = defineProps<{
  candidate: ShipChainPlan;
  initialWaypoints: NativeWaypoint[];
  // 产业链名称：写入原生 RT 的航线名，同时记录到 FLEET 展示。
  chainName?: string;
  // 首次打开向导时直接跑燃料计算与写入（FLEET「生成原生 RT」默认开启）。
  autoStart?: boolean;
  // 循环模式：写完航点/步骤后打开游戏 Loop，按轮备货（v1 单船）。
  loop?: boolean;
  // 生成时快照的飞行周期（小时），界面标「预计」。
  cycleHours?: number;
  // 每轮 SF/FF 消耗。循环模式必有（ChainView 用 fuelPerRound 算，缺逐段油耗时它自己已回退罐容量）；
  // 只有非循环暂存才没有，此时 roundBill 不含燃料、也不展示备货口径。
  loopFuel?: { stl: number; ftl: number };
}>();
const emit = defineEmits<{ close: []; started: [] }>();

// 出发地默认补满 STL 与 FTL（不做线路检测：自动流程没有勾选时机，循环几圈后
// 任何一箱油耗尽都会把航线阻塞）。
const tanks = ref<RouteTank[]>(['STL', 'FTL']);
const fuelUsagePercents = ref(initialWaypoints.map(() => DEFAULT_WAYPOINT_FUEL_PERCENT));
// 空串 = 该航点不写反应堆使用量（无自然跃迁或 BTF 未设置），保持游戏原值。
const reactorUsagePercents = ref<(number | '')[]>(initialWaypoints.map(() => ''));
// 与航点等长：飞到该航点的预计飞行时长（小时），由 FTC/BTF 计算时顺带带回。
const legHours = ref<(number | undefined)[]>([]);
// 计算时长时对应的档位快照：玩家手改任一档位后，该段时长失效。
const legHoursBasis = ref<{ fuel: number | undefined; reactor: number | '' }[]>([]);
watch(
  tanks,
  () => {
    // 补油选择改变会让「满罐起飞」的假设失效：之前算的时长全部作废。
    legHours.value = [];
    legHoursBasis.value = [];
  },
  { deep: true },
);

watch(
  [fuelUsagePercents, reactorUsagePercents],
  () => {
    if (legHours.value.length === 0) {
      return;
    }
    for (let index = 0; index < legHours.value.length; index++) {
      const basis = legHoursBasis.value[index];
      if (basis === undefined) {
        continue;
      }
      const fuel = fuelUsagePercents.value[index];
      const reactor = reactorUsagePercents.value[index] ?? '';
      // 改了档位：本段时长失效；中途不补油时后续段的出发余量也跟着变，时长一并作废，
      // 直到对应油罐补满。燃料档只影响 STL 消耗，反应堆档只影响 FTL 消耗。
      const tanksAffected: RouteTank[] = [];
      if (fuel !== basis.fuel) {
        tanksAffected.push('STL');
      }
      if (reactor !== basis.reactor) {
        tanksAffected.push('FTL');
      }
      for (const k of hoursInvalidatedBySettingChange(
        waypoints.value,
        index,
        legHours.value.length,
        tanksAffected,
      )) {
        legHours.value[k] = undefined;
      }
    }
  },
  { deep: true },
);
const fuelUsageValid = computed(() => fuelUsagePercents.value.every(isWaypointPercent));
const reactorUsageValid = computed(() =>
  reactorUsagePercents.value.every(x => x === '' || isWaypointPercent(x)),
);
const usageValid = computed(() => fuelUsageValid.value && reactorUsageValid.value);
const fuelStatus = ref<string>();
const fuelWarnings = ref<string[]>([]);
const waypoints = computed(() =>
  initialWaypoints.map((stop, index) =>
    index === 0
      ? {
          ...stop,
          steps: [...tanks.value.map(tank => ({ kind: 'refuel' as const, tank })), ...stop.steps],
        }
      : stop,
  ),
);
const purchase = chainPurchasePackage(candidate.ship, candidate.plan);
const hasPurchase = purchase.groups.some(group => Object.keys(group.materials ?? {}).length > 0);

// ── 循环备货（N 轮）─────────────────────────────────────────────
// 每轮出发地账单 = 航点 0 装载（cxBill）+ 每轮 SF/FF；N 轮总量不超过一船满载。
const origin = computed(() => waypoints.value[0]?.location.trim() ?? '');
const cxBill = computed(() => billFromLoadSteps(waypoints.value[0]?.steps ?? []));
// 每轮账单：循环模式带 fuelPerRound 的 SF/FF；非循环暂存没有燃料数据，按 0 算（此时不展示备货）。
const roundBill = computed(() => buildRoundBill(cxBill.value, loopFuel ?? { stl: 0, ftl: 0 }));
const roundMaterials = computed(() => {
  const mats: Record<string, { weight: number; volume: number }> = {};
  for (const ticker of Object.keys(roundBill.value)) {
    const mat = materialsStore.getByTicker(ticker);
    if (mat !== undefined) {
      mats[ticker] = { weight: mat.weight, volume: mat.volume };
    }
  }
  return mats;
});
// 物料没下发时算不出重量/体积，宁可只备 1 轮，也不按偏小的体积报出偏大的 N。
const roundsUnweighable = computed(() =>
  Object.keys(roundBill.value).some(ticker => roundMaterials.value[ticker] === undefined),
);
const nMax = computed(() => {
  const cap = shipChainCapacity(candidate.ship);
  if (cap === undefined || roundsUnweighable.value) {
    return 1;
  }
  return stockingRoundsMax(
    { weight: cap.weight, volume: cap.volume },
    billWeightVolume(roundBill.value, roundMaterials.value),
  );
});
// 输入框原样保留键入内容（清空时是 ''），只在计费/回显时钳到 1..Nmax：逐键回写会把
// 「清空后输入 5」变成「15 → 钳成 Nmax」，用户输的 5 悄悄变成上限。
const stockingRoundsInput = ref<number | string>(1);
const stockingRounds = computed(() => {
  const raw = Number(stockingRoundsInput.value);
  return Number.isFinite(raw) ? Math.min(Math.max(1, Math.round(raw)), nMax.value) : 1;
});
watch(nMax, max => {
  const raw = Number(stockingRoundsInput.value);
  if (Number.isFinite(raw) && raw > max) {
    stockingRoundsInput.value = max;
  }
});
function normalizeStockingRounds() {
  stockingRoundsInput.value = stockingRounds.value;
}
const exchangeCode = computed(() =>
  origin.value === '' ? undefined : exchangesStore.getByNaturalId(origin.value)?.code,
);
// CXOB 只随 COMEX_BROKER_DATA 推送到达（要先开过该订单簿窗口）。没有订单簿 ≠ 不可买：
// 先静默拉一次隐藏窗口读回来；仍读不到按「未知」处理（燃料照进备货包），
// 只有确认订单簿存在且卖单为空才算不可买——否则默认路径会把每轮 SF/FF 都丢掉。
const requestedOrderBooks = new Set<string>();
function requestOrderBook(ticker: string, code: string) {
  const key = `${ticker}.${code}`;
  if (cxobStore.getByTicker(key) !== undefined || requestedOrderBooks.has(key)) {
    return;
  }
  requestedOrderBooks.add(key);
  void showBuffer(`CXOB ${key}`, {
    autoClose: true,
    closeWhen: computed(() => cxobStore.getByTicker(key) !== undefined),
  });
}
watch(
  [exchangeCode, roundBill],
  ([code, bill]) => {
    if (!loop || code === undefined) {
      return;
    }
    for (const ticker of ['SF', 'FF']) {
      if ((bill[ticker] ?? 0) > 0) {
        requestOrderBook(ticker, code);
      }
    }
  },
  { immediate: true },
);
// 确认不可买的燃料：只提示缺口、不进备货包。
const unbuyableFuel = computed(() => {
  const code = exchangeCode.value;
  if (code === undefined) {
    return [];
  }
  return ['SF', 'FF'].filter(ticker => {
    if ((roundBill.value[ticker] ?? 0) <= 0) {
      return false;
    }
    const book = cxobStore.getByTicker(`${ticker}.${code}`);
    return book !== undefined && book.sellingOrders.length === 0;
  });
});
const stockingBill = computed(() => {
  const bill: Record<string, number> = {};
  for (const [ticker, amount] of Object.entries(roundBill.value)) {
    if (unbuyableFuel.value.includes(ticker)) {
      continue;
    }
    bill[ticker] = amount * stockingRounds.value;
  }
  return bill;
});
const stockingPackage = computed(() => cxShortfallPackage(origin.value, stockingBill.value));
const sustain = computed(() => sustainRounds(roundBill.value, readOriginStock(origin.value)));
const cycleText = computed(() =>
  cycleHours === undefined ? '' : formatFlightDuration(cycleHours * 3600000),
);
const supplyText = computed(() =>
  cycleHours === undefined ? '' : `${cycleDaysFromHours(cycleHours).toFixed(1)} 天`,
);
// 一船满载补给能撑几天（只算基地日耗，不含链上输送与返航货占舱）：与每轮补给天数
// 对照，说明短周期环线每轮只送一个周期的量。
const capacityText = computed(() => {
  const days = candidate.plan.supplyCapacityDays;
  return days === undefined ? '' : `${days.toFixed(1)} 天`;
});
const sustainText = computed(() => (sustain.value === Infinity ? '∞' : String(sustain.value)));
const stockingWarnings = computed(() => {
  if (!loop) {
    return [];
  }
  const warnings: string[] = [];
  if (sustain.value < 1) {
    warnings.push('出发地库存不足 1 轮，请先备货再分配飞船。');
  }
  for (const ticker of unbuyableFuel.value) {
    warnings.push(`${ticker} 在该交易所无订单簿，请手动补给每轮 ${roundBill.value[ticker]} 单位。`);
  }
  return warnings;
});
async function openStocking() {
  if (stockingPackage.value === undefined) {
    return;
  }
  stagedDispatch.value = { pkg: stockingPackage.value };
  await showBuffer('XIT FLEETACT');
}
const routeId = ref<string>();
// 游戏内航线号（RT-XXXX-NNNN）：打开窗口用它，`routeId` 是服务端哈希。
const routeNaturalId = ref<string>();
// socket 写入中途停止时已创建的服务端 id：重试前先删掉，避免出现两条航线。
const partialRouteId = ref<string>();
const busy = ref(false);
const autoFilling = ref(false);
const error = ref<string>();
const canRetryStep = ref(false);
const repeats = ref<boolean>();
const waypointIndex = ref(0);
const stepIndex = ref(0);
const waypoint = computed(() => waypoints.value[waypointIndex.value]);
const step = computed(() => waypoint.value?.steps[stepIndex.value]);

type Progress =
  | { phase: 'scan-fuel' }
  | { phase: 'write' }
  | { phase: 'open' }
  | { phase: 'create'; list: Awaited<ReturnType<typeof openRouteList>> }
  | { phase: 'open-route' }
  | { phase: 'select' }
  | { phase: 'add'; prepared: Awaited<ReturnType<typeof prepareWaypoint>> }
  | { phase: 'waypoint-fuel'; target: WaypointTarget; editor?: HTMLElement }
  | { phase: 'save-waypoint-fuel'; target: WaypointTarget; editor: HTMLElement }
  | { phase: 'add-step'; target: WaypointTarget }
  | { phase: 'fill'; target: WaypointTarget; edit: HTMLElement; editor?: HTMLElement }
  | { phase: 'save'; target: WaypointTarget; editor: HTMLElement }
  | { phase: 'done' };

type WaypointTarget = Awaited<ReturnType<typeof addWaypoint>>;

const progress = shallowRef<Progress>({ phase: 'scan-fuel' });
let tile: Awaited<ReturnType<typeof openNativeRoute>> | undefined;
let nativeStepClick: AbortController | undefined;
let fuelScan: AbortController | undefined;
let writeTask: AbortController | undefined;
let disposed = false;
// 自动填写时移出视线的原生窗口（结束后恢复原位，便于玩家核对结果）。
const parked = new Set<Element>();
const waitingForNativeStep = ref(false);
const nativeStepLabels = { load: '装载', unload: '卸船', refuel: '加油' };

function cancelNativeStepWait() {
  nativeStepClick?.abort();
}

function parkForAutoFill(window: Element | undefined) {
  if (window === undefined) {
    return;
  }
  parkWindow(window);
  parked.add(window);
}

function restoreParkedWindows() {
  for (const window of parked) {
    unparkWindow(window);
  }
  parked.clear();
}

// 记录本次创建的航线，供 FLEET 只读展示（socket 与界面两条路径共用）。
// naturalId 才是 `RT <id>` 打开窗口用的航线号，routeId 是服务端哈希 id。
function recordRoute(routeId: string, naturalId: string) {
  const name = chainName.trim();
  recordNativeRoute({
    routeId,
    naturalId,
    name: name === '' ? naturalId : name,
    shipId: candidate.ship.ship.id,
    shipLabel: candidate.ship.ship.name ?? candidate.ship.ship.registration,
    chainName: name,
    createdAt: Date.now(),
    loop: loop ? true : undefined,
    cycleHours: loop ? cycleHours : undefined,
    repeats: repeats.value,
    fuelPerRound: loop ? loopFuel : undefined,
    waypoints: waypoints.value.map((waypoint, index) => {
      const reactor = reactorUsagePercents.value[index];
      return {
        location: waypoint.location,
        fuelPercent: fuelUsagePercents.value[index] ?? DEFAULT_WAYPOINT_FUEL_PERCENT,
        reactorPercent: reactor === undefined || reactor === '' ? undefined : reactor,
        // 两条路径都按「使用跃迁点」并且着陆计算与写入（socket 与试飞同口径）。
        useGateways: true,
        landing: true,
        flightHours: legHours.value[index],
        steps: waypoint.steps,
      };
    }),
  });
}

function stopAutoFill() {
  autoFilling.value = false;
  cancelNativeStepWait();
  fuelScan?.abort();
  writeTask?.abort();
  restoreParkedWindows();
}

onBeforeUnmount(() => {
  disposed = true;
  stopAutoFill();
  // 半成品航线不留给玩家自己排查：关向导时尽力删掉。删除失败（已无 socket）就保留。
  if (partialRouteId.value !== undefined) {
    void socketDeleteRoute(partialRouteId.value).catch(() => undefined);
    partialRouteId.value = undefined;
  }
});

// FLEET「生成原生 RT」默认自动跑：先算燃料（FTC/BTF），随后直写航线，不需要再点按钮。
// 已经建过航线（routeId 有值）或不在初始阶段时不再重跑，避免重复创建。
function startAutoFill() {
  if (
    disposed ||
    busy.value ||
    routeId.value !== undefined ||
    progress.value.phase !== 'scan-fuel' ||
    initialWaypoints.length === 0
  ) {
    return;
  }
  emit('started');
  void advance(true);
}

onMounted(() => {
  if (autoStart) {
    startAutoFill();
  }
});
// 同一个向导窗口里再次点「生成原生 RT」时组件不会重挂，靠 prop 变化重新触发。
watch(
  () => autoStart,
  value => {
    if (value) {
      startAutoFill();
    }
  },
);

const retryAction = computed(() => {
  const phase = progress.value.phase;
  if (phase === 'scan-fuel') {
    return '重试计算燃料消耗';
  }
  if (phase === 'write') {
    return '重试 socket 写入';
  }
  if (phase === 'waypoint-fuel') {
    return '重试填写燃料消耗';
  }
  if (phase === 'fill') {
    return '重试填写当前步骤';
  }
  if (phase === 'select') {
    return '重试选择航点';
  }
  if (phase === 'add-step' && canRetryStep.value) {
    return '重试添加步骤';
  }
  if (phase === 'open' || phase === 'open-route') {
    return '重试打开原生 RT';
  }
  return undefined;
});

function describe(item: NativeRouteStep) {
  if (item.kind === 'refuel') {
    return `从本站仓库补满 ${item.tank}`;
  }
  return `${item.kind === 'load' ? '装' : '卸'} ${item.amount} ${item.ticker}`;
}

const actionLabel = computed(() => {
  switch (progress.value.phase) {
    case 'scan-fuel':
      return '计算燃料消耗';
    case 'write':
      return '写入原生 RT';
    case 'open':
      return '打开原生 RT';
    case 'create':
      return '创建单趟航线';
    case 'open-route':
      return `打开 ${routeId.value ?? 'RT'}`;
    case 'select':
      return `选择航点 ${waypoint.value?.location ?? ''}`;
    case 'add':
      return `添加航点 ${waypoint.value?.location ?? ''}`;
    case 'waypoint-fuel':
      return `填写燃料消耗 · ${fuelUsagePercents.value[waypointIndex.value]}%`;
    case 'save-waypoint-fuel':
      return '保存航点燃料消耗';
    case 'add-step':
      return step.value === undefined ? '' : `添加步骤 · ${describe(step.value)}`;
    case 'fill':
      return '填写步骤';
    case 'save':
      return '保存步骤';
    case 'done':
      return '';
  }
});

function nextWaypoint() {
  waypointIndex.value++;
  stepIndex.value = 0;
  progress.value = { phase: waypoint.value === undefined ? 'done' : 'select' };
  if (progress.value.phase === 'done') {
    if (loop) {
      void enableLoop();
    } else {
      checkLoop();
    }
  }
}

function isAbortError(err: unknown) {
  return (
    typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError'
  );
}

function checkLoop() {
  repeats.value = tile === undefined ? undefined : nativeRouteRepeats(tile);
}

// 循环开关的提示只保留一条：这个按钮可以反复重试，同一条消息不该逐次堆叠。
const LOOP_WARNING_PREFIX = '循环开关';
function setLoopWarning(message: string | undefined) {
  const others = fuelWarnings.value.filter(x => !x.startsWith(LOOP_WARNING_PREFIX));
  fuelWarnings.value = message === undefined ? others : [...others, message];
}

// 循环模式：航点/步骤写完后打开游戏 Loop（SHIP_ROUTES_SET_REPEAT），用响应 repeats 校验。
// 失败保留单趟航线并提示手动开启——开关与航点/步骤独立，socket 不可用时不阻断已写好的航线。
async function enableLoop() {
  if (!loop || routeId.value === undefined) {
    return;
  }
  const id = routeId.value;
  try {
    const route = await socketSetRouteRepeats(id, true);
    repeats.value = route.repeats === true;
    // 重试成功后清掉上一次的失败提示，避免「已开」和「未生效」同时挂在页面上。
    setLoopWarning(
      repeats.value
        ? undefined
        : '循环开关未生效（服务端 repeats 仍为关），请在原生 RT 手动开启 Loop。',
    );
  } catch (err) {
    repeats.value = false;
    setLoopWarning(
      `循环开关打开失败：${err instanceof Error ? err.message : String(err)}。` +
        '已保留单趟航线，请在原生 RT 手动开启 Loop 后再分配。',
    );
  }
}

function waypointNames(location: string) {
  const station = stationsStore.getByNaturalId(location) ?? findStationBySystemId(location);
  return station === undefined ? [location] : [station.name, location];
}

async function advance(automatic = false) {
  if (
    disposed ||
    busy.value ||
    !actionLabel.value ||
    !usageValid.value ||
    (error.value !== undefined && retryAction.value === undefined)
  ) {
    return;
  }
  let retrying = error.value !== undefined;
  error.value = undefined;
  canRetryStep.value = false;
  busy.value = true;
  autoFilling.value = automatic;
  if (automatic && tile !== undefined) {
    parkForAutoFill(tile.window);
  }
  try {
    let previous: Progress;
    do {
      previous = progress.value;
      await advanceOnce(retrying);
      retrying = false;
    } while (
      autoFilling.value &&
      !disposed &&
      progress.value.phase !== 'done' &&
      progress.value !== previous
    );
  } catch (err) {
    // 玩家主动停止（abort）不是错误：保持当前阶段，可以直接点「继续」。
    if (isAbortError(err)) {
      return;
    }
    error.value = err instanceof Error ? err.message : String(err);
    canRetryStep.value = err instanceof NativeStepButtonUnavailable;
  } finally {
    nativeStepClick = undefined;
    autoFilling.value = false;
    busy.value = false;
    restoreParkedWindows();
  }
}

async function advanceOnce(retrying: boolean) {
  const state = progress.value;
  if (state.phase === 'scan-fuel') {
    const controller = new AbortController();
    fuelScan = controller;
    fuelWarnings.value = [];
    fuelStatus.value = `正在计算 ${candidate.ship.ship.registration} 的各段燃料消耗`;
    try {
      const results = await computeNativeRouteFuel(
        candidate,
        waypoints.value,
        controller.signal,
        status => {
          fuelStatus.value = status;
        },
      );
      if (!controller.signal.aborted) {
        fuelUsagePercents.value = results.legs.map(x => x.fuelPercent);
        reactorUsagePercents.value = results.legs.map(x => x.reactorPercent ?? '');
        legHours.value = results.legs.map(x => x.hours);
        legHoursBasis.value = results.legs.map((x, index) => ({
          fuel: x.fuelPercent,
          reactor: reactorUsagePercents.value[index] ?? '',
        }));
        fuelWarnings.value = results.warnings;
        progress.value = { phase: 'write' };
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        throw err;
      }
    } finally {
      fuelScan = undefined;
      fuelStatus.value = undefined;
    }
    return;
  }
  if (state.phase === 'write') {
    const controller = new AbortController();
    writeTask = controller;
    fuelStatus.value = '正在通过 socket 写入原生 RT';
    try {
      // 上一轮在创建航线后被打断：先删掉半成品，再从头写，否则重试会多出一条航线。
      if (partialRouteId.value !== undefined) {
        try {
          await socketDeleteRoute(partialRouteId.value);
        } catch (err) {
          throw new PartialRouteCleanupError(
            `上次未完成的航线 ${partialRouteId.value} 删除失败` +
              `（${err instanceof Error ? err.message : String(err)}）。请先在原生 RT 手动删除或稍后重试；` +
              '为避免出现重复航线，本次不会继续创建。',
          );
        }
        partialRouteId.value = undefined;
      }
      const legs = waypoints.value.map((_, index) => {
        const reactor = reactorUsagePercents.value[index];
        return {
          fuelPercent: fuelUsagePercents.value[index] ?? DEFAULT_WAYPOINT_FUEL_PERCENT,
          reactorPercent: reactor === undefined || reactor === '' ? undefined : reactor,
        };
      });
      const result = await writeNativeRouteBySocket(
        { waypoints: waypoints.value, legs, name: chainName },
        controller.signal,
        status => {
          fuelStatus.value = status;
        },
        id => {
          partialRouteId.value = id;
          // 窗口在建航线响应回来之前就已关闭：终止清理钩子已经跑过，这里立即补删。
          if (disposed) {
            void socketDeleteRoute(id).catch(() => undefined);
            partialRouteId.value = undefined;
          }
        },
      );
      if (controller.signal.aborted) {
        return;
      }
      partialRouteId.value = undefined;
      routeId.value = result.routeId;
      routeNaturalId.value = result.naturalId;
      fuelWarnings.value = [...fuelWarnings.value, ...result.warnings];
      // 先开 Loop、再落记录：记录里的 repeats 要反映服务端真实结果。顺序反过来时开关
      // 失败会留下「loop: true + repeats 未定」的记录，卡片把没在循环的航线当循环航线。
      if (loop) {
        await enableLoop();
      }
      recordRoute(result.routeId, result.naturalId);
      progress.value = { phase: 'done' };
    } catch (err) {
      if (controller.signal.aborted) {
        throw err;
      }
      // 半成品未清理成功：保留 id、停在 write 阶段，不要回退界面路径再建一条。
      if (err instanceof PartialRouteCleanupError) {
        throw err;
      }
      // socket 写入失败（游戏未连接/接口变化）：退回界面填写路径。
      fuelWarnings.value = [
        ...fuelWarnings.value,
        `socket 写入失败：${err instanceof Error ? err.message : String(err)}。改用界面填写（可能残留未完成的航线）。`,
      ];
      progress.value = { phase: 'open' };
    } finally {
      writeTask = undefined;
      fuelStatus.value = undefined;
    }
    return;
  }
  if (state.phase === 'open') {
    const list = await openRouteList(retrying);
    if (autoFilling.value) {
      parkForAutoFill(list.window);
    }
    progress.value = { phase: 'create', list };
    return;
  }
  if (state.phase === 'create') {
    if (getActiveChainRuns().some(run => run.shipId === candidate.ship.ship.id)) {
      throw new Error('该船仍有旧环线在执行，请在归航后切换。');
    }
    routeId.value = await createNativeRoute(state.list);
    routeNaturalId.value = routeId.value;
    progress.value = { phase: 'open-route' };
    return;
  }
  if (state.phase === 'open-route' && routeId.value !== undefined) {
    tile = await openNativeRoute(routeId.value);
    if (autoFilling.value) {
      parkForAutoFill(tile.window);
    }
    const name = chainName.trim();
    if (name !== '' && !(await nameNativeRoute(tile, name))) {
      fuelWarnings.value = [
        ...fuelWarnings.value,
        `未能自动把航线改名为「${name}」，请在原生 RT 里手动改名。`,
      ];
    }
    if (loop) {
      // 界面路径不碰 socket，Loop 只能玩家自己开：先按「未开」记录，
      // 否则卡片会把没在循环的航线当循环航线展示（周期/备货照列，却发不出未执行告警）。
      repeats.value = false;
      setLoopWarning('循环开关未开启：界面路径不自动开启 Loop，请在原生 RT 手动开启后再分配飞船。');
    }
    recordRoute(routeId.value, routeId.value);
    progress.value = { phase: 'select' };
    return;
  }
  const stop = waypoint.value;
  if (
    tile === undefined ||
    routeId.value === undefined ||
    !isNativeRouteOpen(tile, routeId.value) ||
    stop === undefined
  ) {
    throw new Error('原生 RT 窗口已关闭或切换。');
  }
  if (state.phase === 'select') {
    progress.value = { phase: 'add', prepared: await prepareWaypoint(tile, stop.location) };
    return;
  }
  if (state.phase === 'add') {
    const names = waypointNames(stop.location);
    const target = await addWaypoint(tile, state.prepared, names);
    progress.value = { phase: 'waypoint-fuel', target };
    return;
  }
  if (state.phase === 'waypoint-fuel' || state.phase === 'save-waypoint-fuel') {
    const percent = fuelUsagePercents.value[waypointIndex.value];
    if (!isWaypointPercent(percent)) {
      throw new Error('燃料消耗必须为 1–100% 的整数。');
    }
    const reactor = reactorUsagePercents.value[waypointIndex.value];
    const reactorPercent = reactor === '' ? undefined : reactor;
    if (reactorPercent !== undefined && !isWaypointPercent(reactorPercent)) {
      throw new Error('反应堆使用量必须为 1–100% 的整数。');
    }
    if (state.phase === 'waypoint-fuel') {
      const editor = state.editor ?? (await openNativeWaypointEditor(tile, state.target));
      progress.value = { ...state, editor };
      await fillNativeWaypointFuel(tile, editor, percent, reactorPercent);
      progress.value = { phase: 'save-waypoint-fuel', target: state.target, editor };
      return;
    }
    await saveNativeWaypointFuel(tile, state.editor, percent, reactorPercent);
    if (stop.steps.length === 0) {
      nextWaypoint();
    } else {
      progress.value = { phase: 'add-step', target: state.target };
    }
    return;
  }
  const item = step.value;
  if (item === undefined) {
    throw new Error('当前航点没有待写入的步骤。');
  }
  if (state.phase === 'add-step') {
    nativeStepClick = new AbortController();
    const edit = await addNativeStep(tile, state.target, item, {
      signal: nativeStepClick.signal,
      onWaiting: waiting => (waitingForNativeStep.value = waiting),
    });
    if (edit !== undefined) {
      progress.value = { phase: 'fill', target: state.target, edit };
    }
  } else if (state.phase === 'fill') {
    const editor = state.editor ?? (await openNativeStep(tile, state.edit, item));
    progress.value = { ...state, editor };
    await fillNativeStep(tile, editor, item);
    progress.value = { phase: 'save', target: state.target, editor };
  } else if (state.phase === 'save') {
    await saveNativeStep(tile, state.editor, item);
    stepIndex.value++;
    if (step.value === undefined) {
      nextWaypoint();
    } else {
      progress.value = { phase: 'add-step', target: state.target };
    }
  }
}

async function openPurchase() {
  stagedDispatch.value = { pkg: purchase };
  await showBuffer('XIT FLEETACT');
}

async function showRoute() {
  const id = routeNaturalId.value ?? routeId.value;
  await showBuffer(id === undefined ? 'RT' : `RT ${id}`);
}
</script>

<template>
  <div :class="$style.body">
    <h2>生成原生 RT · {{ candidate.ship.ship.name ?? candidate.ship.ship.registration }}</h2>
    <p v-if="loop"
      >循环执行。写完航点与步骤后自动打开游戏 Loop，按轮备货后在原生 RT
      分配船只，分配即开始循环（关掉页面仍继续跑）。</p
    >
    <p v-else>单趟归航。备货和核对燃料后，在原生 RT 手动分配船只。分配即开始执行。</p>
    <div v-if="loop" :class="$style.loopPanel">
      <div
        >本轮周期：<strong>{{ cycleText || '—' }}</strong
        >（预计，随出发时刻漂移）</div
      >
      <div
        >每轮补给：<strong>{{ supplyText || '—' }}</strong> 库存（稳态下等于周期<template
          v-if="capacityText"
          >；满载可至 {{ capacityText }}</template
        >）</div
      >
      <label
        >备货轮数
        <input
          v-model.number="stockingRoundsInput"
          :class="$style.fuelInput"
          type="number"
          min="1"
          :max="nMax"
          step="1"
          :disabled="busy"
          aria-label="备货轮数"
          @change="normalizeStockingRounds" />
        / {{ nMax }} 轮（一船满载上限）</label
      >
      <div
        >出发地库存可支撑：<strong>{{ sustainText }}</strong> 轮</div
      >
    </div>
    <div v-if="routeId === undefined" :class="$style.controls">
      <label
        ><input
          v-model="tanks"
          type="checkbox"
          value="STL"
          :disabled="busy || routeId !== undefined || progress.phase !== 'scan-fuel'" />
        出发地补满 STL</label
      >
      <label
        ><input
          v-model="tanks"
          type="checkbox"
          value="FTL"
          :disabled="busy || routeId !== undefined || progress.phase !== 'scan-fuel'" />
        出发地补满 FTL</label
      >
    </div>
    <p
      >燃料消耗与反应堆使用量按飞往各航点的航段计算：优先用 FTC
      公式模型；该段缺模型输入（轨道／环境／网关 数据）时改用 BTF
      试飞实测，两者都算不出时保留游戏默认档。创建航线前可以修改百分比。</p
    >
    <ol :class="$style.stops">
      <li v-for="(stop, i) in waypoints" :key="i">
        <strong>{{ stop.location }}</strong>
        <label>
          · 燃料消耗
          <input
            v-model.number="fuelUsagePercents[i]"
            :class="$style.fuelInput"
            type="number"
            min="1"
            max="100"
            step="1"
            :disabled="busy || routeId !== undefined"
            :title="`燃料消耗 ${fuelUsagePercents[i]}%`"
            :aria-label="`${stop.location} 燃料消耗百分比`" />%
        </label>
        <label>
          · 反应堆
          <input
            v-model.number="reactorUsagePercents[i]"
            :class="$style.fuelInput"
            type="number"
            min="1"
            max="100"
            step="1"
            placeholder="—"
            :disabled="busy || routeId !== undefined"
            :title="`反应堆使用量 ${reactorUsagePercents[i]}%`"
            :aria-label="`${stop.location} 反应堆使用量百分比`" />%
        </label>
        <span v-if="stop.steps.length > 0"> · {{ stop.steps.map(describe).join('、') }}</span>
      </li>
    </ol>
    <ul v-if="fuelWarnings.length > 0" :class="$style.warnings" role="status">
      <li v-for="warning in fuelWarnings" :key="warning">{{ warning }}</li>
    </ul>
    <ul v-if="stockingWarnings.length > 0" :class="$style.warnings" role="status">
      <li v-for="warning in stockingWarnings" :key="warning">{{ warning }}</li>
    </ul>
    <p v-if="routeId"
      >航线 {{ routeId }} · {{ Math.min(waypointIndex + 1, waypoints.length) }}/{{
        waypoints.length
      }}
      站</p
    >
    <p v-if="!usageValid" role="alert"
      >燃料消耗必须为 1–100% 的整数，反应堆使用量留空或填 1–100% 的整数。</p
    >
    <p v-else-if="error" role="alert">
      {{ error }}
      <template v-if="!retryAction">请打开原生 RT 核对已写入的内容，再手动补齐。</template>
    </p>
    <p v-else-if="fuelStatus" role="status">{{ fuelStatus }}</p>
    <p v-else-if="waitingForNativeStep && step" role="status">
      在原生 RT 将鼠标移到航点 {{ waypoint?.location }}。向导会自动点「{{
        nativeStepLabels[step.kind]
      }}」。
    </p>
    <p v-else-if="autoFilling" role="status"> 正在自动填写 · {{ actionLabel }} </p>
    <p v-else-if="progress.phase === 'done'" role="status"
      >航点、燃料消耗和步骤已写入。
      <template v-if="loop">
        <template v-if="repeats === true"
          >循环已开启。备货后在原生 RT 分配飞船，分配即开始循环。</template
        >
        <template v-else>循环尚未开启，请在原生 RT 手动打开 Loop，核对备货后再分配飞船。</template>
      </template>
      <template v-else-if="repeats === false"
        >循环已关闭。请核对备货和飞行参数，再分配飞船。</template
      >
      <template v-else>请在原生 RT 确认 Loop 已关闭，核对备货和飞行参数后再分配飞船。</template>
    </p>
    <div :class="$style.controls">
      <PrunButton
        v-if="actionLabel && (!error || retryAction) && !autoFilling"
        primary
        :disabled="busy || !fuelUsageValid"
        data-tooltip="按计算出的燃料消耗与反应堆使用量连续创建航点、保存档位并写入装卸步骤。"
        @click="advance(true)"
        >{{ routeId ? '继续自动填写' : '自动填写' }}</PrunButton
      >
      <PrunButton v-if="autoFilling" dark @click="stopAutoFill">停止自动填写</PrunButton>
      <PrunButton v-else-if="fuelStatus" dark @click="stopAutoFill">停止计算燃料消耗</PrunButton>
      <PrunButton
        v-if="actionLabel && (!error || retryAction) && !autoFilling"
        dark
        :disabled="busy || !fuelUsageValid"
        @click="advance()"
        >{{ error ? retryAction : actionLabel }}</PrunButton
      >
      <PrunButton
        v-if="routeId || error"
        dark
        :disabled="busy && !waitingForNativeStep"
        @click="showRoute"
        >查看原生 RT</PrunButton
      >
      <PrunButton v-if="waitingForNativeStep && !autoFilling" dark @click="cancelNativeStepWait"
        >取消等待</PrunButton
      >
      <PrunButton
        v-if="!loop && progress.phase === 'done' && repeats !== false"
        dark
        @click="checkLoop">
        复查循环设置
      </PrunButton>
      <PrunButton
        v-if="loop && routeId && repeats !== true && !autoFilling"
        dark
        :disabled="busy"
        @click="enableLoop">
        重试开启循环
      </PrunButton>
      <PrunButton
        v-if="loop"
        dark
        :disabled="busy || !stockingPackage"
        data-tooltip="按 N 轮出发地账单扣掉仓库库存生成 CX 采购包（含每轮 SF/FF）。"
        @click="openStocking"
        >打开备货包（{{ stockingRounds }} 轮）</PrunButton
      >
      <PrunButton v-else-if="hasPurchase" dark :disabled="busy" @click="openPurchase"
        >打开采购包</PrunButton
      >
      <PrunButton dark :disabled="busy" @click="emit('close')">关闭</PrunButton>
    </div>
  </div>
</template>

<style module>
.body {
  padding: 12px;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.stops {
  padding-left: 24px;
  line-height: 1.6;
}

.warnings {
  padding-left: 24px;
  line-height: 1.6;
}

.loopPanel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0;
  padding: 8px 10px;
  border: 1px solid var(--color-border, #3a3f4b);
  border-radius: 4px;
  line-height: 1.6;
}

/* 数字输入的 spin 按钮会占掉内容宽度，5ch 时「100」会被裁成「10」——隐藏 spin 并留足宽度。 */
.fuelInput {
  width: 6ch;
  appearance: textfield;
  -moz-appearance: textfield;
}

.fuelInput::-webkit-inner-spin-button,
.fuelInput::-webkit-outer-spin-button {
  appearance: none;
  -webkit-appearance: none;
  margin: 0;
}
</style>
