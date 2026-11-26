<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import { findStationBySystemId } from '@src/infrastructure/prun-ui/utils/select-address';
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
import { recordNativeRoute, removeNativeRoute } from './native-route-registry';
import {
  RouteCreateUnconfirmedError,
  socketDeleteRoute,
  socketGetRoutes,
  socketSetRouteRepeats,
  writeNativeRouteBySocket,
} from './native-route-socket';
import {
  DEFAULT_WAYPOINT_FUEL_PERCENT,
  editableNativeSteps,
  hoursInvalidatedBySettingChange,
  isWaypointPercent,
  withOriginRefuels,
  type NativeRouteStep,
  type RouteTank,
} from './native-route-plan';
import {
  billWeightVolume,
  loopRecurringBill,
  loopStockingBill,
  loopStockingRounds,
  stockingRoundsMax,
} from './native-route-loop';
import {
  billFromLoadSteps,
  billShortfall,
  cxShortfallPackage,
  nativeRoutePlannedPurchasePackage,
  nativeRouteUsableDays,
  readOriginStock,
} from './native-route-purchase';
import { shipChainCapacity } from './chain-allocation';
import { chainShipFirstRefill } from './chain-flight-time';
import { formatFlightDuration } from './chain-format';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { stagedDispatch } from './staged';
import type { NativeRouteGeneration } from './native-route-generation';

// 清理上一次未完成航线失败时抛出：绝不能继续写新航线，否则旧航线会变成无人认领的残留。
class PartialRouteCleanupError extends Error {}

const { candidate, initialWaypoints, checkedRoute, chainName, loopPlan } =
  defineProps<NativeRouteGeneration>();
const emit = defineEmits<{ close: []; viewInFleet: [naturalId: string] }>();

const loop = loopPlan !== undefined;
// 出发地默认补满 STL 与 FTL（不做线路检测：自动流程没有勾选时机，循环几圈后
// 任何一箱油耗尽都会把航线阻塞）。
const tanks = ref<RouteTank[]>(['STL', 'FTL']);
const fuelUsagePercents = ref(
  initialWaypoints.map(
    (_, index) => loopPlan?.legs[index]?.fuelPercent ?? DEFAULT_WAYPOINT_FUEL_PERCENT,
  ),
);
// 空串 = 该航点不写反应堆使用量（无自然跃迁或 BTF 未设置），保持游戏原值。
const reactorUsagePercents = ref<(number | '')[]>(
  initialWaypoints.map((_, index) => loopPlan?.legs[index]?.reactorPercent ?? ''),
);
// 与航点等长：飞到该航点的预计飞行时长（小时），由 FTC/BTF 计算时顺带带回。
const legHours = ref<(number | undefined)[]>(loopPlan?.legs.map(leg => leg.hours) ?? []);
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
const waypoints = computed(() => withOriginRefuels(initialWaypoints, tanks.value));
const purchase = nativeRoutePlannedPurchasePackage(candidate.ship, candidate.plan);
const hasPurchase = purchase.groups.some(group => Object.keys(group.materials ?? {}).length > 0);

// ── 循环备货（N 轮）─────────────────────────────────────────────
// 首轮备齐周转货和当前缺油量，之后仅补每轮的外部消耗。
const origin = computed(() => waypoints.value[0]?.location.trim() ?? '');
const cxBill = computed(() => billFromLoadSteps(waypoints.value[0]?.steps ?? []));
const loopReturn = candidate.plan.loopOriginReturn ?? {};
const cycleFuel = loopPlan?.fuel ?? { stl: 0, ftl: 0 };
const firstRefill = computed(() => chainShipFirstRefill(candidate.ship.ship, cycleFuel));
const firstRoundBill = computed(() =>
  loopStockingBill(cxBill.value, loopReturn, cycleFuel, firstRefill.value, 1),
);
const originStock = computed(() => readOriginStock(origin.value));
const recurringBill = computed(() => loopRecurringBill(cxBill.value, loopReturn, cycleFuel));
const stockingTickers = computed(
  () => new Set([...Object.keys(firstRoundBill.value), ...Object.keys(recurringBill.value)]),
);
const roundMaterials = computed(() => {
  const mats: Record<string, { weight: number; volume: number }> = {};
  for (const ticker of stockingTickers.value) {
    const mat = materialsStore.getByTicker(ticker);
    if (mat !== undefined) {
      mats[ticker] = { weight: mat.weight, volume: mat.volume };
    }
  }
  return mats;
});
// 物料没下发时算不出重量/体积，宁可只备 1 轮，也不按偏小的体积报出偏大的 N。
const roundsUnweighable = computed(() =>
  [...stockingTickers.value].some(ticker => roundMaterials.value[ticker] === undefined),
);
const nMax = computed(() => {
  const cap = shipChainCapacity(candidate.ship);
  if (cap === undefined || roundsUnweighable.value) {
    return 1;
  }
  return stockingRoundsMax(
    { weight: cap.weight, volume: cap.volume },
    billWeightVolume(recurringBill.value, roundMaterials.value),
    billWeightVolume(firstRoundBill.value, roundMaterials.value),
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
  [exchangeCode, stockingTickers],
  ([code, tickers]) => {
    if (!loop || code === undefined) {
      return;
    }
    for (const ticker of ['SF', 'FF']) {
      if (tickers.has(ticker)) {
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
    if (!stockingTickers.value.has(ticker)) {
      return false;
    }
    const book = cxobStore.getByTicker(`${ticker}.${code}`);
    return book !== undefined && book.sellingOrders.length === 0;
  });
});
const stockingBill = computed(() => {
  const bill = loopStockingBill(
    cxBill.value,
    loopReturn,
    cycleFuel,
    firstRefill.value,
    stockingRounds.value,
  );
  for (const ticker of unbuyableFuel.value) {
    delete bill[ticker];
  }
  return bill;
});
const stockingPackage = computed(() =>
  cxShortfallPackage(origin.value, stockingBill.value, loopReturn),
);
const firstShortfall = computed(() => billShortfall(firstRoundBill.value, originStock.value));
const sustain = computed(() =>
  loopStockingRounds(firstRoundBill.value, recurringBill.value, originStock.value),
);
const cycleText = computed(() =>
  loopPlan === undefined ? '' : formatFlightDuration(loopPlan.cycleHours * 3600000),
);
// 满载可用 = 满载加权分摊：船总舱容 ÷ ΣBURN 净日耗（自给材料不计）。
const supplyText = computed(() => {
  const cap = shipChainCapacity(candidate.ship);
  const days = cap === undefined ? undefined : nativeRouteUsableDays(waypoints.value, cap);
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
  for (const ticker of Object.keys(loopReturn)) {
    const missing = firstShortfall.value[ticker];
    if (missing !== undefined) {
      warnings.push(`首轮请在出发地备好周转货 ${ticker} ×${missing}，后续由归航补回。`);
    }
  }
  for (const ticker of unbuyableFuel.value) {
    warnings.push(`${ticker} 在该交易所没有卖单，请手动准备燃料。`);
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
const partialRoute = shallowRef<{ id: string; naturalId: string }>();
const knownNaturalId = computed(() => routeNaturalId.value ?? partialRoute.value?.naturalId);
const busy = ref(false);
const autoFilling = ref(false);
const error = ref<string>();
const canRetryStep = ref(false);
const repeats = ref<boolean>();
const waypointIndex = ref(0);
const socketWrittenWaypoints = ref(0);
const stepIndex = ref(0);
const usingNativeEditor = ref(false);
const editorWaypoints = computed(() =>
  waypoints.value.map(waypoint => ({ ...waypoint, steps: editableNativeSteps(waypoint.steps) })),
);
const displayedWaypoints = computed(() =>
  usingNativeEditor.value ? editorWaypoints.value : waypoints.value,
);
const waypoint = computed(() => editorWaypoints.value[waypointIndex.value]);
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

const progress = shallowRef<Progress>({ phase: loop ? 'write' : 'scan-fuel' });
const completedWaypoints = computed(() =>
  progress.value.phase === 'write' ? socketWrittenWaypoints.value : waypointIndex.value,
);
const editing = computed(() => !autoFilling.value && progress.value.phase !== 'done');
const routeCreationUnconfirmed = ref(false);
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
    cycleHours: loopPlan?.cycleHours,
    repeats: repeats.value,
    fuelPerRound: loopPlan?.fuel,
    loopOriginReturn: loopPlan === undefined ? undefined : loopReturn,
    waypoints: displayedWaypoints.value.map((waypoint, index) => {
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
  if (partialRoute.value !== undefined) {
    void socketDeleteRoute(partialRoute.value.id).catch(() => undefined);
    partialRoute.value = undefined;
  }
});

onMounted(() => void advance(true));

const retryAction = computed(() => {
  if (routeCreationUnconfirmed.value) {
    return undefined;
  }
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
  if (item.kind === 'unload-all') {
    return '卸载全部';
  }
  if (item.minimum === 0) {
    return `最多卸 ${item.amount} ${item.ticker}`;
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
      return '创建航线';
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
    if (!loop) {
      checkLoop();
    }
    if (routeId.value !== undefined) {
      recordRoute(routeId.value, routeNaturalId.value ?? routeId.value);
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
// 开关与航点、步骤独立；失败时保留已写好的航线，分配前需手动开启 Loop。
async function enableLoop() {
  const routeKey = routeId.value;
  if (!loop || routeKey === undefined) {
    return;
  }
  try {
    const id =
      routeKey === routeNaturalId.value
        ? (await socketGetRoutes()).find(route => route.naturalId === routeKey)?.id
        : routeKey;
    if (id === undefined) {
      throw new Error('未找到已创建航线的服务端 ID。');
    }
    const route = await socketSetRouteRepeats(id, true);
    repeats.value = route.repeats === true;
    // 重试成功后清掉上一次的失败提示，避免「已开」和「未生效」同时挂在页面上。
    setLoopWarning(
      repeats.value
        ? undefined
        : '循环开关未生效（服务端 repeats 仍为关），请在原生 RT 手动开启 Loop。',
    );
    if (progress.value.phase === 'done') {
      if (routeKey !== id) {
        removeNativeRoute(routeKey);
        routeId.value = id;
      }
      recordRoute(id, route.naturalId);
    }
  } catch (err) {
    repeats.value = false;
    setLoopWarning(
      `循环开关打开失败：${err instanceof Error ? err.message : String(err)}。` +
        '已保留航线，请在原生 RT 手动开启 Loop 后再分配。',
    );
  }
}

async function retryLoop() {
  if (busy.value) {
    return;
  }
  busy.value = true;
  try {
    await enableLoop();
  } finally {
    busy.value = false;
  }
}

async function cleanupPartialRoute() {
  const route = partialRoute.value;
  if (route === undefined) {
    return;
  }
  try {
    await socketDeleteRoute(route.id);
  } catch (err) {
    const routes = await socketGetRoutes().catch(() => undefined);
    if (routes === undefined || routes.some(found => found.id === route.id)) {
      throw new PartialRouteCleanupError(
        `上次未完成的航线 ${route.naturalId} 删除失败` +
          `（${err instanceof Error ? err.message : String(err)}）。` +
          '请先在原生 RT 手动删除或稍后重试。',
      );
    }
  }
  partialRoute.value = undefined;
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
    socketWrittenWaypoints.value = 0;
    fuelStatus.value = '准备创建原生 RT';
    try {
      await cleanupPartialRoute();
      controller.signal.throwIfAborted();
      const legs = waypoints.value.map((_, index) => {
        const reactor = reactorUsagePercents.value[index];
        return {
          fuelPercent: fuelUsagePercents.value[index] ?? DEFAULT_WAYPOINT_FUEL_PERCENT,
          reactorPercent: reactor === undefined || reactor === '' ? undefined : reactor,
        };
      });
      const result = await writeNativeRouteBySocket(
        { waypoints: waypoints.value, legs, name: chainName, checkedRoute },
        controller.signal,
        (status, completed) => {
          fuelStatus.value = status;
          socketWrittenWaypoints.value = completed;
        },
        (id, naturalId) => {
          partialRoute.value = { id, naturalId };
          // 窗口在建航线响应回来之前就已关闭：终止清理钩子已经跑过，这里立即补删。
          if (disposed) {
            void socketDeleteRoute(id).catch(() => undefined);
            partialRoute.value = undefined;
          }
        },
      );
      if (controller.signal.aborted) {
        return;
      }
      partialRoute.value = undefined;
      routeId.value = result.routeId;
      routeNaturalId.value = result.naturalId;
      socketWrittenWaypoints.value = waypoints.value.length;
      repeats.value = result.repeats;
      fuelWarnings.value = [...fuelWarnings.value, ...result.warnings];
      // 先开 Loop、再落记录：记录里的 repeats 要反映服务端真实结果。顺序反过来时开关
      // 失败会留下「loop: true + repeats 未定」的记录，卡片把没在循环的航线当循环航线。
      if (loop) {
        fuelStatus.value = '开启循环执行';
        await enableLoop();
      }
      recordRoute(result.routeId, result.naturalId);
      progress.value = { phase: 'done' };
    } catch (err) {
      if (err instanceof RouteCreateUnconfirmedError) {
        routeCreationUnconfirmed.value = true;
        throw err;
      }
      if (controller.signal.aborted) {
        throw err;
      }
      // 半成品未清理成功：保留 id、停在 write 阶段，不要回退界面路径再建一条。
      if (err instanceof PartialRouteCleanupError) {
        throw err;
      }
      await cleanupPartialRoute();
      controller.signal.throwIfAborted();
      fuelWarnings.value = [
        ...fuelWarnings.value,
        `socket 写入失败：${err instanceof Error ? err.message : String(err)}。改用界面填写。`,
      ];
      if (waypoints.value.some(x => x.steps.some(step => step.kind === 'unload-all'))) {
        fuelWarnings.value.push('界面回退按计划逐项卸货。');
      }
      usingNativeEditor.value = true;
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
  const id = knownNaturalId.value;
  await showBuffer(id === undefined ? 'RT' : `RT ${id}`);
}
</script>

<template>
  <div :class="$style.body">
    <div :class="$style.header">
      <strong>原生 RT</strong>
      <span>{{ loop ? '循环' : '单趟' }}</span>
      <span v-if="knownNaturalId">{{ knownNaturalId }}</span>
    </div>
    <p v-if="!usageValid" :class="$style.status" role="alert">
      燃料消耗必须为 1–100% 的整数，反应堆使用量留空或填 1–100% 的整数。
    </p>
    <p v-else-if="error" :class="$style.status" role="alert">
      {{ error }}
      <template v-if="routeCreationUnconfirmed">
        请打开原生 RT 核对是否已创建航线，再决定是否重新生成。
      </template>
      <template v-else-if="!retryAction"> 请打开原生 RT 核对已写入的内容，再手动补齐。 </template>
    </p>
    <p v-else-if="fuelStatus" :class="$style.status" role="status">{{ fuelStatus }}</p>
    <p v-else-if="waitingForNativeStep && step" :class="$style.status" role="status">
      在原生 RT 将鼠标移到航点 {{ waypoint?.location }}。向导会自动点「{{
        nativeStepLabels[step.kind]
      }}」。
    </p>
    <p v-else-if="progress.phase === 'done'" :class="$style.status" role="status">
      已生成。
      <template v-if="loop && repeats === true"
        >循环已开启。关闭 Loop 生效时，飞船会停在末个基地。</template
      >
      <template v-else-if="loop">循环尚未开启，请先打开 Loop。</template>
      <template v-else-if="repeats === false">循环已关闭。</template>
      <template v-else-if="repeats === true">循环已开启，请先在原生 RT 关闭 Loop。</template>
      <template v-else>请在原生 RT 核对 Loop 设置。</template>
      备货后在原生 RT 分配飞船。
    </p>
    <p v-else :class="$style.status" role="status">
      {{ busy ? '正在填写' : '已暂停' }} · {{ actionLabel }}
    </p>
    <div
      v-if="
        progress.phase !== 'scan-fuel' && progress.phase !== 'done' && !routeCreationUnconfirmed
      "
      :class="$style.writeProgress">
      <progress :value="completedWaypoints" :max="waypoints.length" aria-label="航点写入进度" />
      <span>航点 {{ completedWaypoints }}/{{ waypoints.length }}</span>
    </div>

    <div :class="$style.controls">
      <PrunButton
        v-if="actionLabel && (!error || retryAction) && !autoFilling"
        primary
        :disabled="busy || !usageValid"
        data-tooltip="按计算出的燃料消耗与反应堆使用量连续创建航点、保存档位并写入装卸步骤。"
        @click="advance(true)">
        {{ routeId ? '继续自动填写' : '自动填写' }}
      </PrunButton>
      <PrunButton v-if="autoFilling || fuelStatus" dark @click="stopAutoFill">
        {{ progress.phase === 'scan-fuel' ? '停止计算燃料消耗' : '停止自动填写' }}
      </PrunButton>
      <PrunButton
        v-if="actionLabel && (!error || retryAction) && !autoFilling"
        dark
        :disabled="busy || !usageValid"
        @click="advance()">
        {{ error ? retryAction : actionLabel }}
      </PrunButton>
      <PrunButton
        v-if="knownNaturalId || error"
        dark
        :disabled="busy && !waitingForNativeStep"
        @click="showRoute">
        查看原生 RT
      </PrunButton>
      <PrunButton
        v-if="progress.phase === 'done' && routeNaturalId"
        dark
        :disabled="busy"
        @click="emit('viewInFleet', routeNaturalId)">
        在 FLEET 查看航线
      </PrunButton>
      <PrunButton v-if="waitingForNativeStep && !autoFilling" dark @click="cancelNativeStepWait">
        取消等待
      </PrunButton>
      <PrunButton
        v-if="tile && !loop && progress.phase === 'done' && repeats !== false"
        dark
        @click="checkLoop">
        复查循环设置
      </PrunButton>
      <PrunButton
        v-if="loop && progress.phase === 'done' && routeId && repeats !== true"
        dark
        :disabled="busy"
        @click="retryLoop">
        重试开启循环
      </PrunButton>
      <template v-if="loop && !busy">
        <label>
          备货轮数
          <input
            v-model.number="stockingRoundsInput"
            :class="$style.fuelInput"
            type="number"
            min="1"
            :max="nMax"
            step="1"
            aria-label="备货轮数"
            @change="normalizeStockingRounds" />
          / {{ nMax }}
        </label>
        <PrunButton
          dark
          :disabled="!stockingPackage"
          data-tooltip="按首轮和后续轮次的外部补给缺口生成 CX 采购包。"
          @click="openStocking">
          打开备货包
        </PrunButton>
      </template>
      <PrunButton v-else-if="!loop && !busy && hasPurchase" dark @click="openPurchase">
        打开采购包
      </PrunButton>
      <PrunButton dark :disabled="busy" @click="emit('close')">关闭</PrunButton>
    </div>

    <details v-show="!busy" :class="$style.details">
      <summary>
        航点与设置
        <template v-if="fuelWarnings.length + stockingWarnings.length > 0">
          （{{ fuelWarnings.length + stockingWarnings.length }} 条提示）
        </template>
      </summary>
      <div v-if="loop" :class="$style.loopPanel">
        <div
          >本轮周期：<strong>{{ cycleText || '—' }}</strong
          >（预计，随出发时刻漂移）</div
        >
        <div
          >满载可用：<strong>{{ supplyText || '—' }}</strong></div
        >
        <div
          >出发地库存可支撑：<strong>{{ sustainText }}</strong> 轮</div
        >
      </div>
      <div v-if="editing && !loop && routeId === undefined" :class="$style.controls">
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
      <p v-if="editing && loop">航点档位和出发地补满设置沿用循环规划，备货量按这套档位计算。</p>
      <p v-else-if="editing"
        >燃料消耗与反应堆使用量按飞往各航点的航段计算：优先用 FTC
        公式模型。确认余油不足时停止创建。缺少轨道、环境或网关数据时改用 BTF
        试飞，试飞也无结果时保留默认档。创建航线前可以修改百分比。</p
      >
      <ol :class="$style.stops">
        <li v-for="(stop, i) in displayedWaypoints" :key="i">
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
              :disabled="loop || busy || routeId !== undefined"
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
              :disabled="loop || busy || routeId !== undefined"
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
    </details>
  </div>
</template>

<style module>
.body {
  padding: 6px 0;
  border-block: 1px solid #2b485a;
}

.header {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 8px;
}

.status {
  margin: 4px 0 8px;
}

.writeProgress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.writeProgress > progress {
  width: min(180px, 55%);
  accent-color: rgb(63, 162, 222);
}

.details {
  margin-top: 8px;
}

.details > summary {
  cursor: pointer;
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
