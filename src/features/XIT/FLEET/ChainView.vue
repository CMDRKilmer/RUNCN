<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import BaseAlias from '@src/components/BaseAlias.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import filterToolbarStyle from '@src/components/filter-toolbar.module.css';
import SelectInput from '@src/components/forms/SelectInput.vue';
import { useChainPlanning } from './use-chain-planning';
import { useChainLoopPlanning } from './use-chain-loop-planning';
import { shipLabel, formatFlightDuration } from './chain-format';
import type { ShipChainPlan } from './chain-allocation';
import type { ChainPlannerBase, ChainPlan, ChainStopPlan } from './chain-types';
import { chainShipFuelCaps, type ChainFlightLeg } from './chain-flight-time';
import { billTotals, type DispatchShip } from '@src/features/XIT/FLEET/utils';
import { matWeightVolume } from './chain-data';
import { getBaseGroups } from '@src/core/base-groups';
import { useTileState } from '@src/store/user-data-tiles';

import { showConfirmationOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { buildNativeWaypoints, DEFAULT_WAYPOINT_FUEL_PERCENT } from './native-route-plan';
import {
  nativeRouteRecords,
  recordNativeRoute,
  removeNativeRoute,
  type NativeRouteRecord,
} from './native-route-registry';
import {
  checkNativeRoute,
  hasPendingRouteRequest,
  socketDeleteRoute,
  socketGetRoutes,
} from './native-route-socket';
import { readRouteExecutions } from './native-route-rte';
import type { RouteStatus } from './native-route-rte';
import {
  matchRunningRoutes,
  recordsToRemoveAfterDelete,
  routeProgressText,
  routeStopStates,
  withoutRouteDefinition,
  type RouteStopState,
} from './native-route-game';
import { gameRouteDefinitions, gameRunningRoutes, liveNativeRoutes } from './native-route-live';
import { stagedNativeRoute } from './native-route-staged';
import { stagedDispatch } from './staged';
import {
  nativeRoutePurchasePackage,
  nativeRouteOriginBill,
  nativeRouteUsableDays,
  cxShortfallPackage,
  readOriginStock,
} from './native-route-purchase';
import { loopSustain, fuelPerRound } from './native-route-loop';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { userDataStore } from '@src/infrastructure/prun-api/data/user-data';
import { fixed0, formatCurrency } from '@src/utils/format';
import { getPrice } from '@src/infrastructure/fio/cx';
import { gameNow } from '@src/infrastructure/fio/orbit';

const { ships, bases } = defineProps<{
  ships: DispatchShip[];
  bases: ChainPlannerBase[];
}>();

// ── 状态 ─────────────────────────────────────────────────────
// 选中的产业链分组（BSN「供应链分组」列录入的自由文本名）。
const chainGroup = useTileState<string | undefined>('chainGroup', undefined);
// 分配到本环线的船只（多选，数量不限）。
const chainShipIds = useTileState<string[] | undefined>('chainShipIds', undefined);
// 分组内勾选参与的基地：undefined = 默认全选。
const chainBaseIds = useTileState<string[] | undefined>('chainBaseIds', undefined);
// 循环模式（原生 RT Loop，v1 仅单船）：开启后按飞行周期重算运量，生成时打开游戏 Loop。
const chainLoopMode = useTileState<boolean>('chainLoopMode', false);

// 换分组时重置基地勾选（新分组默认全选）。
watch(chainGroup, () => {
  chainBaseIds.value = undefined;
});

// ── 分组 ─────────────────────────────────────────────────────
const allGroups = computed(() => {
  const map = new Map<string, string>();
  for (const base of bases) {
    for (const g of getBaseGroups(base.siteId) ?? []) {
      const key = g.toLowerCase();
      if (!map.has(key)) {
        map.set(key, g);
      }
    }
  }
  return [...map.values()].sort((a, b) => a.localeCompare(b));
});

const groupSelect = computed({
  get: () => chainGroup.value ?? '',
  set: (v: string) => {
    chainGroup.value = v === '' ? undefined : v;
  },
});

const groupBases = computed(() => {
  const g = chainGroup.value;
  if (g === undefined) {
    return [];
  }
  const key = g.toLowerCase();
  return bases.filter(x =>
    (getBaseGroups(x.siteId) ?? []).some(name => name.toLowerCase() === key),
  );
});

// 分组内勾选参与环线的基地。
const selectedBaseIds = computed(() => {
  if (chainBaseIds.value === undefined) {
    return groupBases.value.map(x => x.naturalId);
  }
  const present = new Set(groupBases.value.map(x => x.naturalId));
  return chainBaseIds.value.filter(id => present.has(id));
});

const selectedBases = computed(() =>
  groupBases.value.filter(x => selectedBaseIds.value.includes(x.naturalId)),
);

function setBaseSelected(id: string, selected: boolean) {
  const current = selectedBaseIds.value;
  if (selected) {
    chainBaseIds.value = current.includes(id) ? current : [...current, id];
  } else {
    chainBaseIds.value = current.filter(x => x !== id);
  }
}

function selectAllBases() {
  chainBaseIds.value = groupBases.value.map(x => x.naturalId);
}

function clearAllBases() {
  chainBaseIds.value = [];
}

const groupOptions = computed(() => [
  { label: '选择产业链分组…', value: '' },
  ...allGroups.value.map(g => ({ label: g, value: g })),
]);

// ── 船只 ─────────────────────────────────────────────────────
const eligibleShips = computed(() =>
  ships
    .filter(x => x.warehouseStore && x.cargoStore)
    .sort((a, b) => shipLabel(a).localeCompare(shipLabel(b))),
);

const selectedShips = computed(() =>
  eligibleShips.value.filter(x => chainShipIds.value?.includes(x.ship.id)),
);

function setShipSelected(id: string, selected: boolean) {
  const current = chainShipIds.value ?? [];
  chainShipIds.value = selected
    ? current.includes(id)
      ? current
      : [...current, id]
    : current.filter(x => x !== id);
}

function selectAllShips() {
  chainShipIds.value = eligibleShips.value.map(x => x.ship.id);
}

function clearAllShips() {
  chainShipIds.value = [];
}

const {
  flightEstimates,
  flightTimesLoading,
  timeAlloc,
  shipPlans,
  loading,
  unusedShipCount,
  allocBanner,
  filteredStopNotices,
} = useChainPlanning({
  ships: () => selectedShips.value,
  bases: () => selectedBases.value,
});

// ── 循环模式（单船闭环迭代）─────────────────────────────────────
// v1 仅单船：恰好选中 1 艘船时才驱动循环规划；多船/未选船时循环不生效，规划表走原口径。
const loopShip = computed(() =>
  selectedShips.value.length === 1 ? selectedShips.value[0] : undefined,
);
const {
  result: loopPlan,
  computing: loopComputing,
  error: loopError,
} = useChainLoopPlanning({
  ship: () => loopShip.value,
  bases: () => selectedBases.value,
  enabled: () => chainLoopMode.value && loopShip.value !== undefined,
});
// 循环计划可用：开关开 + 单船 + 迭代成功且有计划。规划表与生成向导据此切到循环口径。
const loopActive = computed(
  () =>
    chainLoopMode.value &&
    loopShip.value !== undefined &&
    loopPlan.value?.ok === true &&
    loopPlan.value.plan !== undefined,
);
const loopCycleText = computed(() => {
  const hours = loopPlan.value?.cycleHours;
  return hours === undefined ? '' : formatFlightDuration(hours * 3600000);
});
// 一次运输实际可用天数（满载加权分摊展示口径：总舱容 ÷ Σ净日耗；实际送达按周期稳态）。
const loopSupplyText = computed(() => {
  const days = loopPlan.value?.plan?.fullLoadUsableDays;
  return days === undefined ? '' : `${days.toFixed(1)} 天`;
});
const loopWarnings = computed(() => loopPlan.value?.warnings ?? []);

const routeNotice = ref<string>();
const routeCheck = shallowRef<AbortController>();
const routeCheckIssues = ref<string[]>([]);
const nativeRouteCandidate = computed(() => {
  if (selectedShips.value.length !== 1) {
    return undefined;
  }
  if (chainLoopMode.value) {
    const ship = loopShip.value;
    const plan = loopPlan.value?.plan;
    return loopActive.value && !loopComputing.value && ship && plan ? { ship, plan } : undefined;
  }
  return !loading.value && shipPlans.value.length === 1 ? shipPlans.value[0] : undefined;
});

watch([nativeRouteCandidate, chainGroup], () => {
  routeCheckIssues.value = [];
});
onBeforeUnmount(() => routeCheck.value?.abort());

async function generateNativeRoute() {
  const candidate = nativeRouteCandidate.value;
  if (candidate === undefined || routeCheck.value !== undefined || chainTab.value !== 'plan') {
    return;
  }
  const group = chainGroup.value;
  const check = new AbortController();
  routeCheck.value = check;
  routeCheckIssues.value = [];
  routeNotice.value = undefined;
  try {
    const loop = chainLoopMode.value;
    const waypoints = buildNativeWaypoints(candidate.plan);
    let loopSnapshot;
    if (loop) {
      const estimate = loopPlan.value?.estimate;
      if (estimate === undefined || estimate.legs.length !== waypoints.length - 1) {
        throw new Error('循环估时与航点不匹配。');
      }
      const legs = estimate.legs.map(leg => {
        if (leg.settings === undefined) {
          throw new Error(`${leg.from} → ${leg.to} 缺少循环飞行档位。`);
        }
        return leg.settings;
      });
      loopSnapshot = {
        cycleHours: estimate.totalHours,
        fuel: fuelPerRound(estimate.legs, chainShipFuelCaps(candidate.ship.ship)),
        legs: [{ fuelPercent: DEFAULT_WAYPOINT_FUEL_PERCENT }, ...legs],
      };
    }
    const checkedRoute = await checkNativeRoute(waypoints, check.signal);
    if (check.signal.aborted) {
      return;
    }
    if (nativeRouteCandidate.value !== candidate || chainGroup.value !== group) {
      routeCheckIssues.value = ['规划已更新，请核对后重新生成。'];
      return;
    }
    if (checkedRoute.issues.length > 0) {
      routeCheckIssues.value = checkedRoute.issues;
      return;
    }
    // 校验通过后，在独立窗口显示写入进度。
    stagedNativeRoute.value = {
      sessionId: Date.now(),
      candidate,
      waypoints,
      checkedRoute,
      chainName: group ?? '',
      autoStart: true,
      loop: loopSnapshot,
    };
    await showBuffer('XIT RTWIZ');
  } catch (err) {
    if (!check.signal.aborted) {
      routeCheckIssues.value = [err instanceof Error ? err.message : String(err)];
    }
  } finally {
    routeCheck.value = undefined;
  }
}

interface NativeRouteView {
  record: NativeRouteRecord;
  ship: PrunApi.Ship | undefined;
  loads: NativeRouteLoad[];
  capacity: { weight: number; volume: number };
  // 有船按游戏里的分配在跑（`ship.assignedRoute` / RTE 命中）。
  running: boolean;
  // 游戏侧 Loop 开关（服务端 repeats 为准）：运行中卡片标「循环」。
  repeats: boolean;
  cxBurnCode: string | undefined;
  // 循环航线（本地标记或服务端 repeats 开）：显示周期/支撑轮数，运行中也可补货。
  isLoop: boolean;
  // 生成时快照的飞行周期文本（预计）；非循环或无快照为空。
  cycleText: string;
  // 一次运输实际可用天数文本（满载加权分摊：总舱容 ÷ ΣBURN 净日耗）；非循环或无数据为空。
  supplyText: string;
  // 出发地库存可支撑轮数文本（∞ = 无消耗）。
  sustainText: string;
  // RTE 阻塞/等待状态（待实采校准）：blocked / waiting / undefined。
  status: RouteStatus | undefined;
  // 卡片告警（船况、循环停止、库存不足、阻塞）。
  alerts: string[];
  // 循环补货包：按 1 轮 roundBill 扣出发地库存的缺口（运行中也可用）。
  replenish: UserData.ActionPackageData | undefined;
  // 未运行时的备货采购包：出发地装载清单扣掉仓库现有库存。
  purchase: UserData.ActionPackageData | undefined;
}

// 循环卡片的运行态信息：周期、支撑轮数、补货缺口与告警。燃料只认记录里的每轮快照，
// 没有快照（游戏手建的循环航线）就不给支撑轮数，见 loopSustain。
function loopCardInfo(
  record: NativeRouteRecord,
  ship: PrunApi.Ship | undefined,
  running: boolean,
  status: RouteStatus | undefined,
) {
  const isLoop = record.loop === true || record.repeats === true;
  const alerts: string[] = [];
  if (ship !== undefined && ship.condition < 0.8) {
    alerts.push(`船况 ${Math.round(ship.condition * 100)}%（低于 80%，建议维修后再跑）。`);
  }
  if (record.repeats === true && !running) {
    alerts.push('循环已开但无船执行：可能 PRO 失效或已解除分配，请续费后重新分配。');
  }
  // 状态文案是从手册候选词推的（未实采）：只对循环航线报，别外溢到单趟卡片。
  if (isLoop) {
    if (status === 'blocked') {
      alerts.push('阻塞：步骤缺料或目标仓库无空间；飞行段阻塞需解除分配后重新分配。');
    } else if (status === 'waiting') {
      alerts.push('等待中：上游产出或仓库空间不足。');
    }
  }
  // 非循环卡片不展示周期/支撑轮数/补货，跳过仓库与账单读取。
  if (!isLoop) {
    return {
      isLoop,
      cycleText: '',
      supplyText: '',
      sustainText: '—',
      alerts,
      replenish: undefined,
    };
  }
  const cycleText =
    record.cycleHours === undefined ? '' : formatFlightDuration(record.cycleHours * 3600000);
  // 一次运输实际可用（满载加权分摊展示口径）：船总舱容 ÷ Σ航点基地净日耗；BURN 未加载显示 —。
  const cargoCapacity = nativeRouteCapacity(ship);
  const supplyDays =
    cargoCapacity.weight > 0 ? nativeRouteUsableDays(record.waypoints, cargoCapacity) : undefined;
  const supplyText = supplyDays === undefined ? '' : `${supplyDays.toFixed(1)} 天`;
  const origin = record.waypoints[0]?.location.trim() ?? '';
  // 燃料只认生成时快照（见 loopSustain）：游戏里手建的循环航线没快照时不给支撑轮数，
  // 补货包也只按物料算，避免拿罐容量当整圈油耗去误报「不足 1 轮」。
  const { bill, sustain } = loopSustain(
    nativeRouteOriginBill(record),
    record.fuelPerRound,
    readOriginStock(origin),
  );
  const sustainText = sustain === undefined ? '—' : sustain === Infinity ? '∞' : String(sustain);
  if (sustain !== undefined && sustain < 1) {
    alerts.push('出发地库存不足 1 轮，请补货后再分配。');
  }
  return {
    isLoop,
    cycleText,
    supplyText,
    sustainText,
    alerts,
    replenish: cxShortfallPackage(origin, bill),
  };
}

// 同一条航线可能同时被两艘船执行：key 必须带上船，否则 Vue 会报重复 key。
function nativeRouteRowKey(entry: NativeRouteView) {
  return `${entry.record.routeId}|${entry.ship?.id ?? entry.record.shipId}`;
}

const nativeRoutes = computed<NativeRouteView[]>(() =>
  liveNativeRoutes.value.map(row => {
    const ship = shipsStore.getById(row.shipId);
    const repeats = row.record.repeats === true;
    return {
      record: row.record,
      ship,
      loads: nativeRouteLoads(row.record),
      capacity: nativeRouteCapacity(ship),
      running: row.running,
      repeats,
      cxBurnCode:
        row.running && repeats
          ? exchangesStore.getByNaturalId(row.record.waypoints[0]?.location.trim())?.code
          : undefined,
      status: row.status,
      ...loopCardInfo(row.record, ship, row.running, row.status),
      purchase: row.running ? undefined : nativeRoutePurchasePackage(row.record),
    };
  }),
);

// 未运行的航线：先备齐出发地物料，再去原生 RT 分配船只（分配即开始执行）。
function openRoutePurchase(entry: NativeRouteView) {
  if (entry.purchase === undefined) {
    return;
  }
  stagedDispatch.value = { pkg: entry.purchase };
  void showBuffer('XIT FLEETACT');
}

// 循环航线补货：船离港后出发地仓库空出，按 1 轮缺口补下一轮（运行中也可用）。
function openRouteReplenish(entry: NativeRouteView) {
  if (entry.replenish === undefined) {
    return;
  }
  stagedDispatch.value = { pkg: entry.replenish };
  void showBuffer('XIT FLEETACT');
}

// 用游戏里的真实航线列表校准本地记录：游戏里已经没有的航线（在游戏 UI 里删掉、没写成、
// 早期版本残留）直接丢弃，不再出现在「运行中」。船的分配优先用 `ship.assignedRoute`
// （随船下发），RTE 行只补充旧版游戏缺失该字段时的执行状态。
// 写航线期间不发请求——socket 响应没有 actionId，只能靠 FIFO 顺序匹配，
// 插一条就会让向导的对位错乱；被延后的这次校准（触发它的那次打开/点击）稍后自动补做，
// 不必再点一次页签。
let refreshingGameRoutes = false;
let gameRouteRetry: ReturnType<typeof setTimeout> | undefined;
// 航线增删的序号：刷新期间删掉航线后，旧快照会把已删除的航线写回列表，序号不一致就重拉。
let routeMutationSeq = 0;
function scheduleGameRouteRetry() {
  if (gameRouteRetry !== undefined) {
    return;
  }
  gameRouteRetry = setTimeout(() => {
    gameRouteRetry = undefined;
    void refreshGameRoutes();
  }, 1000);
}
onScopeDispose(() => {
  if (gameRouteRetry !== undefined) {
    clearTimeout(gameRouteRetry);
  }
});
async function refreshGameRoutes() {
  if (refreshingGameRoutes) {
    return;
  }
  if (hasPendingRouteRequest()) {
    scheduleGameRouteRetry();
    return;
  }
  refreshingGameRoutes = true;
  const companyId = userDataStore.companyId;
  try {
    // 响应反映的是发起请求那一刻的航线列表：期间向导可能刚建完一条航线（不在快照里，
    // 不能判定「已删除」），也可能刚删掉一条（不能把快照里的旧定义写回去）。
    for (let attempt = 0; attempt < 3; attempt++) {
      const seq = routeMutationSeq;
      const known = new Set(Object.keys(nativeRouteRecords.value));
      // 先拉航线、再开 RTE：RTE 窗口自己可能发 socket 请求，和航线请求混在一起会
      // 打乱按 FIFO 对位的响应匹配。
      const routes = await socketGetRoutes();
      if (userDataStore.companyId !== companyId) {
        return;
      }
      // 等待期间删过航线：这份快照已经过期，重拉一次；仍未稳定就放弃发布。
      if (seq !== routeMutationSeq) {
        continue;
      }
      for (const record of Object.values(nativeRouteRecords.value)) {
        const server = routes.find(
          x => x.id === record.routeId || sameNaturalId(x.naturalId, record.naturalId),
        );
        if (server === undefined) {
          if (!known.has(record.routeId)) {
            continue;
          }
          removeNativeRoute(record.routeId);
          continue;
        }
        // 界面路径创建时只有 RT 号：校准后换成服务端哈希 id，删除与配对都用它。
        if (server.id !== record.routeId) {
          removeNativeRoute(record.routeId);
          recordNativeRoute({ ...record, routeId: server.id });
          continue;
        }
      }
      // 定义先发布：航线卡片不必等 RTE 窗口读完执行状态。
      gameRouteDefinitions.value = routes;
      // 只有「运行中」页需要执行状态；计划页不做这次窗口操作。
      if (chainTab.value !== 'running') {
        break;
      }
      const executions = await readRouteExecutions();
      if (userDataStore.companyId !== companyId) {
        return;
      }
      // 读执行状态期间删过航线：这份执行状态对不上已发布的列表，重拉一份。
      if (seq !== routeMutationSeq) {
        continue;
      }
      gameRunningRoutes.value =
        executions === undefined ? undefined : matchRunningRoutes(routes, executions);
      break;
    }
  } catch {
    // socket 未就绪或超时：保留上一次结果，按本地记录继续显示，不打断面板。
  } finally {
    refreshingGameRoutes = false;
  }
}

function openNativeRoute(record: NativeRouteRecord) {
  void showBuffer(`RT ${record.naturalId}`);
}

function sameNaturalId(a: string | undefined, b: string | undefined) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a.trim().toUpperCase() === b.trim().toUpperCase()
  );
}

// 界面路径创建的记录没有服务端哈希 id：用游戏航线列表按 RT 号反查。
async function resolveServerRouteId(record: NativeRouteRecord) {
  try {
    const routes = await socketGetRoutes();
    return (
      routes.find(x => x.id === record.routeId || sameNaturalId(x.naturalId, record.naturalId))
        ?.id ?? record.routeId
    );
  } catch {
    return record.routeId;
  }
}

function onDeleteNativeRouteClick(e: Event, record: NativeRouteRecord) {
  const name = record.name.trim();
  const label = name === '' ? record.naturalId : `${name}（${record.naturalId}）`;
  showConfirmationOverlay(e, () => void deleteNativeRoute(record), {
    message: `删除原生 RT ${label}？游戏里的航线会一起删除。`,
    confirmLabel: '删除',
  });
}

async function deleteNativeRoute(record: NativeRouteRecord) {
  try {
    // 界面路径创建的记录只有 RT 号：先换成服务端 id，否则删除会打错对象。
    const routeId = await resolveServerRouteId(record);
    await socketDeleteRoute(routeId);
    // 删除发生在刷新等待期间时，让进行中的那次刷新丢掉旧快照、重新拉取。
    routeMutationSeq++;
    // 只清被删的那条航线：同一艘船 + 同一产业链可以有多条航线（历史记录也合法存在），
    // 删掉其中一条不代表别的航线被删或作废。
    for (const id of recordsToRemoveAfterDelete(
      nativeRouteRecords.value,
      record.routeId,
      record.naturalId,
    )) {
      removeNativeRoute(id);
    }
    // 游戏 UI 手动创建的航线没有本地记录：直接把它从缓存的航线定义与执行列表里摘掉，
    // 不必等下一次校准（否则列表会一直显示这张已删除的卡）。
    gameRouteDefinitions.value = withoutRouteDefinition(
      gameRouteDefinitions.value ?? [],
      record.routeId,
      record.naturalId,
    );
    const running = gameRunningRoutes.value;
    if (running !== undefined) {
      gameRunningRoutes.value = {
        ...running,
        entries: running.entries.filter(
          x => x.route.id !== record.routeId && !sameNaturalId(x.route.naturalId, record.naturalId),
        ),
      };
    }
    routeNotice.value = `已删除原生 RT ${record.naturalId}。`;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    routeNotice.value =
      `删除原生 RT ${record.naturalId} 失败：${reason}` +
      '（游戏里仍有船只在使用该航线时无法删除，先解除分配再试。）';
  }
}

// 原生 RT 的逐段载重：按航点顺序累计（每站先卸后装），返程末行自然归零。
interface NativeRouteLoad {
  onArrival: { weight: number; volume: number };
  onDeparture: { weight: number; volume: number };
  // 出现「按容量装载/卸全部」步骤后，具体吨位无法由计划推算，后续行只显示未知。
  uncertain?: boolean;
}

function nativeRouteLoads(record: NativeRouteRecord): NativeRouteLoad[] {
  const state = { weight: 0, volume: 0 };
  const loads: NativeRouteLoad[] = [];
  let uncertain = false;
  for (const waypoint of record.waypoints) {
    const onArrival = { ...state };
    for (const step of waypoint.steps) {
      if (step.kind === 'refuel') {
        continue;
      }
      if (step.capacity) {
        uncertain = true;
        continue;
      }
      const wv = matWeightVolume(step.ticker, step.amount);
      const sign = step.kind === 'load' ? 1 : -1;
      state.weight += sign * wv.weight;
      state.volume += sign * wv.volume;
    }
    loads.push({ onArrival, onDeparture: { ...state }, uncertain: uncertain || undefined });
  }
  return loads;
}

function nativeRouteCapacity(ship: PrunApi.Ship | undefined) {
  const cargo = ship === undefined ? undefined : storagesStore.getById(ship.idShipStore);
  return { weight: cargo?.weightCapacity ?? 0, volume: cargo?.volumeCapacity ?? 0 };
}

function formatLoadChange(load: NativeRouteLoad) {
  const dw = load.onDeparture.weight - load.onArrival.weight;
  const dv = load.onDeparture.volume - load.onArrival.volume;
  const sign = (n: number) => (n > 0 ? `+${fixed0(n)}` : fixed0(n));
  const arrow = dw > 0 || dv > 0 ? '↑' : dw < 0 || dv < 0 ? '↓' : '·';
  return `${arrow} ${sign(dw)}t／${sign(dv)}m³`;
}

function nativeRouteStepMaterials(
  record: NativeRouteRecord,
  index: number,
  kind: 'load' | 'unload',
) {
  const bills: Record<string, number> = {};
  const capacities: string[] = [];
  for (const step of record.waypoints[index]?.steps ?? []) {
    if (step.kind === 'refuel' || step.kind !== kind) {
      continue;
    }
    if (step.capacity) {
      capacities.push(`${step.ticker}×${kind === 'load' ? '满' : '全部'}`);
      continue;
    }
    bills[step.ticker] = (bills[step.ticker] ?? 0) + step.amount;
  }
  return [...(formatMaterials(bills) ? [formatMaterials(bills)] : []), ...capacities].join('、');
}

function nativeRouteRefuelText(record: NativeRouteRecord, index: number) {
  return (record.waypoints[index]?.steps ?? [])
    .filter(step => step.kind === 'refuel')
    .map(step => step.tank)
    .join('、');
}

function isNativeRouteEnd(record: NativeRouteRecord, index: number) {
  return index === 0 || index === record.waypoints.length - 1;
}

// 第 index 行描述的是「从这一站飞到下一站」：档位存在下一站上（航点档位 = 飞到该航点的设置）。
function nativeRouteNextLeg(record: NativeRouteRecord, index: number) {
  // 第 0 行是出发站，档位同样在下一站上。
  return record.waypoints[index + 1];
}

// 预计飞行时长与档位同一口径：存在「飞到该航点」的航点上。
function nativeRouteLegHours(record: NativeRouteRecord, index: number) {
  return record.waypoints[index + 1]?.flightHours;
}
function stopMarker(state: RouteStopState) {
  switch (state) {
    case 'done':
      return '✓';
    case 'arrived':
      return '●';
    case 'transit':
      return '✈';
    default:
      return '○';
  }
}

function markClassKey(state: RouteStopState): string {
  switch (state) {
    case 'done':
      return 'markDone';
    case 'arrived':
      return 'markArrived';
    case 'transit':
      return 'markTransit';
    default:
      return 'markPending';
  }
}

const planTables = computed<ShipChainPlan[]>(() => {
  if (loopActive.value && loopShip.value !== undefined && loopPlan.value?.plan) {
    return [{ ship: loopShip.value, plan: loopPlan.value.plan }];
  }
  return shipPlans.value;
});

const chainTab = useTileState<'plan' | 'running'>('chainTab', 'plan');
const chainTabs = computed(() => [
  { id: 'plan' as const, label: '规划中', count: planTables.value.length },
  { id: 'running' as const, label: '运行中', count: nativeRoutes.value.length },
]);

// 「运行中」页里原生 RT 也占一张卡：点页签时用游戏里的航线列表校准本地记录。
// 面板打开时就停在这页也自动校准一次——contributing.md「Server Communication & ToS」
// 里批准的例外（原先只有点击能发请求）。
function selectChainTab(tab: 'plan' | 'running') {
  chainTab.value = tab;
  if (tab === 'running') {
    void refreshGameRoutes();
  }
}
// 记录变化（向导新增、删除按钮）后跟游戏列表校准；校准失败就退回本地记录显示。
watch(
  () => Object.keys(nativeRouteRecords.value).sort().join(','),
  () => void refreshGameRoutes(),
);
// 打开面板/切回环线视图时自动校准一次：游戏里新建的航线不必先点页签。
onMounted(() => {
  if (chainTab.value === 'running') {
    void refreshGameRoutes();
  }
});

// ── 展示格式化 ───────────────────────────────────────────────
// 采购金额：purchaseBill × 市价 求和；任一材料无市价时返回 undefined（显示 --）。
function billCost(record: Record<string, number>): number | undefined {
  let total = 0;
  for (const [ticker, amount] of Object.entries(record)) {
    const price = getPrice(ticker);
    if (price === undefined) {
      return undefined;
    }
    total += price * amount;
  }
  return total;
}

function formatMaterials(record: Record<string, number>) {
  return Object.entries(record)
    .filter(([, amount]) => amount > 0)
    .map(([ticker, amount]) => `${ticker}×${amount}`)
    .join('、');
}

// 空间站行（序 0）「取货」：装船总量（cxBill）中不由 CX 采购的部分，
// 即从空间站仓库直接装船的物资（含组内产出取货与仓库已有库存），
// 与「采购」（从 CX 购买）分开展示。
function spaceStationTake(plan: ChainPlan): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [ticker, amount] of Object.entries(plan.cxBill)) {
    const take = amount - (plan.purchaseBill[ticker] ?? 0);
    if (take > 0) {
      result[ticker] = take;
    }
  }
  return result;
}

function formatUnloadChain(stop: ChainStopPlan) {
  return [...stop.unloadChain.entries()]
    .map(([ticker, x]) => `${ticker}×${x.amount}(${x.from})`)
    .join('、');
}

function formatUnloadAt(stop: ChainStopPlan) {
  const cx = formatMaterials(stop.unloadCx);
  const chain = formatUnloadChain(stop);
  if (cx && chain) {
    return `${cx}、${chain}`;
  }
  return cx || chain;
}

function formatLoad(stop: ChainStopPlan) {
  return [...stop.load.entries()]
    .map(([ticker, x]) => `${ticker}×${x.amount}(→${x.to})`)
    .join('、');
}

function formatLoadCell(
  load: { weight: number; volume: number },
  capacity: { weight: number; volume: number },
) {
  const wPct = capacity.weight > 0 ? Math.round((load.weight / capacity.weight) * 100) : 0;
  const vPct = capacity.volume > 0 ? Math.round((load.volume / capacity.volume) * 100) : 0;
  return `${fixed0(load.weight)}t ${wPct}%／${fixed0(load.volume)}m³ ${vPct}%`;
}

function formatLoadDelta(stop: ChainStopPlan) {
  const dw = stop.loadOnDeparture.weight - stop.loadOnArrival.weight;
  const dv = stop.loadOnDeparture.volume - stop.loadOnArrival.volume;
  const sign = (n: number) => (n > 0 ? `+${fixed0(n)}` : fixed0(n));
  const arrow = dw > 0 || dv > 0 ? '↑' : dw < 0 || dv < 0 ? '↓' : '·';
  return `${arrow} ${sign(dw)}t／${sign(dv)}m³`;
}

function formatPercent(value: number, capacity: number) {
  if (capacity <= 0) {
    return '0%';
  }
  return `${Math.round((value / capacity) * 100)}%`;
}

function formatFinalUnloadNotes(plan: {
  finalUnload?: Record<string, number>;
  finalUnloadNotes?: Record<string, string>;
}): string {
  const notes = plan.finalUnloadNotes;
  if (!notes) {
    return '';
  }
  return Object.entries(notes)
    .filter(([ticker]) => (plan.finalUnload?.[ticker] ?? 0) > 0)
    .map(([ticker, note]) => `${ticker}：${note}`)
    .join('；');
}

// ── 飞行时间显示 ─────────────────────────────────────────────
function flightLegFor(shipId: string, legIndex: number): ChainFlightLeg | undefined {
  return flightEstimates.value.get(shipId)?.legs[legIndex];
}

// 到达时刻文本：HH:MM（本地时间，浏览器时区）；跨天时带 MM-DD。
function arrivalClockText(ms: number): string {
  const t = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  const now = new Date(gameNow());
  const sameDay =
    now.getFullYear() === t.getFullYear() &&
    now.getMonth() === t.getMonth() &&
    now.getDate() === t.getDate();
  return sameDay ? clock : `${pad(t.getMonth() + 1)}-${pad(t.getDate())} ${clock}`;
}

function flightCellText(shipId: string, legIndex: number): string {
  const leg = flightLegFor(shipId, legIndex);
  if (!leg) {
    return '';
  }
  if (!leg.ok) {
    // 输入残缺（成因全文见 flightCellTitle）：显式标缺。
    // 写成「--（…）」而不是「0 小时」——否则会被读成「与出发同一时刻到达」。
    if (leg.missingInputs !== undefined && leg.missingInputs.length > 0) {
      return `--（${leg.error ?? '缺规划输入'}）`;
    }
    return leg.error ? `（${leg.error}）` : '';
  }
  // 时长按公式模型预测（不是原生前向记录），前缀 ≈ 标明是预估值。
  const approx = '≈';
  return ` · ${approx}${formatFlightDuration(leg.hours * 3600000)}（${arrivalClockText(leg.arriveAtMs)}到达）`;
}

function flightCellTitle(shipId: string, legIndex: number): string | undefined {
  const leg = flightLegFor(shipId, legIndex);
  const inputs = leg?.ok === false ? leg.missingInputs : undefined;
  return inputs && inputs.length > 0 ? inputs.join('；') : undefined;
}

function flightTotalText(shipId: string): string {
  const est = flightEstimates.value.get(shipId);
  if (!est) {
    return '';
  }
  if (!est.ok) {
    return '（部分航段无法计算）';
  }
  return `约 ${formatFlightDuration(est.totalHours * 3600000)}`;
}
</script>

<template>
  <div :class="$style.layout">
    <div :class="[C.ComExOrdersPanel.filter, filterToolbarStyle.toolbar]">
      <SelectInput
        v-model="groupSelect"
        :options="groupOptions"
        :width="220"
        :class="$style.groupSelect" />
      <div :class="$style.separator" />
      <RadioItem v-model="chainLoopMode" horizontal>循环模式</RadioItem>
      <div :class="$style.spacer" />
      <PrunButton
        v-if="chainTab === 'plan'"
        primary
        :disabled="nativeRouteCandidate === undefined || routeCheck !== undefined"
        @click="generateNativeRoute">
        {{ routeCheck === undefined ? '生成原生 RT' : '检查航线…' }}
      </PrunButton>
    </div>

    <!-- 分组内基地勾选 -->
    <div
      v-if="chainGroup && groupBases.length > 0"
      :class="[C.ComExOrdersPanel.filter, filterToolbarStyle.toolbar]">
      <span :class="$style.barLabel">基地</span>
      <RadioItem
        v-for="base in groupBases"
        :key="base.naturalId"
        :model-value="selectedBaseIds.includes(base.naturalId)"
        horizontal
        @update:model-value="selected => setBaseSelected(base.naturalId, selected)">
        {{ base.naturalId }}<BaseAlias :site-id="base.siteId" />
      </RadioItem>
      <div :class="$style.separator" />
      <PrunButton dark @click="selectAllBases">全选</PrunButton>
      <PrunButton dark @click="clearAllBases">清空</PrunButton>
    </div>

    <!-- 分配船只（多选） -->
    <div
      v-if="selectedBases.length > 0 && eligibleShips.length > 0"
      :class="[C.ComExOrdersPanel.filter, filterToolbarStyle.toolbar]">
      <span :class="$style.barLabel">分配船只</span>
      <RadioItem
        v-for="ship in eligibleShips"
        :key="ship.ship.id"
        :model-value="chainShipIds?.includes(ship.ship.id) ?? false"
        horizontal
        @update:model-value="selected => setShipSelected(ship.ship.id, selected)">
        {{ shipLabel(ship) }}（{{ ship.exchangeCode }}）
      </RadioItem>
      <div :class="$style.separator" />
      <PrunButton dark @click="selectAllShips">全选</PrunButton>
      <PrunButton dark @click="clearAllShips">清空</PrunButton>
    </div>

    <div v-if="routeNotice" :class="$style.notice">{{ routeNotice }}</div>
    <div
      v-if="chainTab === 'plan' && routeCheckIssues.length > 0"
      :class="$style.notice"
      role="alert">
      <div v-for="issue in routeCheckIssues" :key="issue">{{ issue }}</div>
    </div>

    <!-- 规划中 / 运行中 分页：页签始终可见；运行中页列出所有创建过的原生 RT
         （点页签时再向游戏校准航线定义与执行状态）。 -->
    <div :class="$style.content">
      <div :class="[C.Tabs.component, $style.tabsHeader]">
        <div :class="C.Tabs.tabs">
          <div
            v-for="t in chainTabs"
            :key="t.id"
            :class="C.Tabs.header"
            @click="selectChainTab(t.id)">
            <a
              :class="[
                chainTab === t.id ? C.Tabs.tabActive : '',
                C.Tabs.tab,
                C.fonts.fontRegular,
                C.type.typeRegular,
              ]"
              >{{ t.label }}（{{ t.count }}）</a
            >
            <div
              :class="[
                C.Tabs.toggleIndicator,
                chainTab === t.id ? C.Tabs.toggleIndicatorActive : '',
                chainTab === t.id ? C.effects.shadowPrimary : '',
              ]" />
          </div>
        </div>
      </div>

      <div
        v-if="chainTab === 'plan' && chainLoopMode"
        :class="loopActive ? $style.allocOk : $style.notice">
        <template v-if="loopShip === undefined">循环模式仅支持单船：请只分配一艘船。</template>
        <template v-else-if="loopComputing">循环周期估算中…</template>
        <template v-else-if="loopPlan && !loopPlan.ok"
          >循环模式不可用：{{ loopPlan.reasons.join('；') }}</template
        >
        <template v-else-if="loopActive">
          循环模式 · 本轮周期 {{ loopCycleText }}（预计，随出发时刻漂移）<template
            v-if="loopSupplyText">
            · 一次运输实际可用 {{ loopSupplyText }}</template
          >
          <div v-for="warning in loopWarnings" :key="warning">⚠ {{ warning }}</div>
        </template>
        <template v-else
          >循环周期未估算：{{ loopError ?? '请在计划里分配 1 艘船并勾选至少 1 个基地。' }}</template
        >
      </div>
      <div
        v-if="chainTab === 'plan' && allocBanner"
        :class="allocBanner.kind === 'ok' ? $style.allocOk : $style.notice">
        {{ allocBanner.text }}
      </div>
      <div v-if="chainTab === 'plan' && filteredStopNotices.length > 0" :class="$style.notice">
        <div v-for="stop in filteredStopNotices" :key="stop.naturalId">
          已过滤基地 {{ stop.naturalId }}<BaseAlias :natural-id="stop.naturalId" />：{{
            stop.reason
          }}
        </div>
      </div>
      <div
        v-if="chainTab === 'plan' && timeAlloc?.notes && timeAlloc.notes.length > 0"
        :class="$style.allocNotes">
        <div v-for="note in timeAlloc.notes" :key="note" :class="$style.allocNote">
          {{ note }}
        </div>
      </div>

      <div
        v-for="sp in chainTab === 'plan' ? planTables : []"
        :key="sp.ship.ship.id"
        :class="$style.shipPlan">
        <div :class="$style.shipHeader">
          <span>{{ shipLabel(sp.ship) }}（{{ sp.ship.exchangeCode }}）</span>
          <div v-if="sp.plan.stops.length > 0" :class="$style.route">
            <span :class="$style.routeLabel">航线：</span>
            <span :class="$style.routeOrigin">{{ sp.plan.originNaturalId }}</span>
            <template v-for="stop in sp.plan.stops" :key="stop.naturalId">
              <span :class="$style.routeArrow">→</span>
              <span :class="$style.routeNode">
                {{ stop.naturalId || stop.planetName
                }}<BaseAlias v-if="stop.naturalId" :natural-id="stop.naturalId" />
              </span>
            </template>
            <span :class="$style.routeArrow">→</span>
            <span :class="$style.routeOrigin">{{ sp.plan.originNaturalId }}</span>
          </div>
        </div>

        <table :class="$style.table">
          <colgroup>
            <col :class="$style.colSeq" />
            <col :class="$style.colStation" />
            <col :class="$style.colOps" />
            <col :class="$style.colFlight" />
            <col :class="$style.colLoad" />
          </colgroup>
          <thead>
            <tr>
              <th :class="$style.narrowCol">序</th>
              <th :class="$style.narrowCol">星球/空间站</th>
              <th>操作</th>
              <th>飞行</th>
              <th :class="$style.narrowCol">载重</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td :class="$style.narrowCol">0</td>
              <td :class="$style.narrowCol">
                <span :class="$style.routeOrigin">{{ sp.plan.originNaturalId }}</span>
              </td>
              <td :class="$style.matCell">
                <div>
                  <span :class="$style.opsLabel">采购</span>
                  [{{ formatMaterials(sp.plan.purchaseBill) || '无' }}]
                </div>
                <div>
                  <span :class="$style.opsLabel">取货</span>
                  [{{ formatMaterials(spaceStationTake(sp.plan)) || '无' }}]
                </div>
              </td>
              <td :class="$style.matCell">出发</td>
              <td :class="$style.narrowCol">
                {{ formatLoadCell(sp.plan.loadOnDeparture, sp.plan.capacity) }}
              </td>
            </tr>
            <tr v-for="(stop, i) in sp.plan.stops" :key="stop.naturalId">
              <td :class="$style.narrowCol">{{ i + 1 }}</td>
              <td :class="$style.narrowCol">
                {{ stop.naturalId || stop.planetName
                }}<BaseAlias v-if="stop.naturalId" :natural-id="stop.naturalId" />
              </td>
              <td :class="$style.matCell">
                <div>
                  <span :class="$style.opsLabel">卸货</span>
                  [{{ formatUnloadAt(stop) || '无' }}]
                </div>
                <div>
                  <span :class="$style.opsLabel">取货</span>
                  [{{ formatLoad(stop) || '无' }}]
                </div>
                <span v-if="stop.clipped" :class="$style.opsWarn">（限载缩减）</span>
              </td>
              <td
                :class="$style.matCell"
                :data-tooltip="flightCellTitle(sp.ship.ship.id, i)"
                data-tooltip-position="top">
                → {{ stop.planetName }}{{ flightCellText(sp.ship.ship.id, i) }}
              </td>
              <td :class="$style.narrowCol">
                <div>{{ formatLoadCell(stop.loadOnDeparture, sp.plan.capacity) }}</div>
                <div :class="$style.loadSub">{{ formatLoadDelta(stop) }}</div>
              </td>
            </tr>
            <tr>
              <td :class="$style.narrowCol">{{ sp.plan.stops.length + 1 }}</td>
              <td :class="$style.narrowCol">
                <span :class="$style.routeOrigin">{{ sp.plan.originNaturalId }}</span>
              </td>
              <td :class="$style.matCell">
                <span :class="$style.opsLabel">卸货</span>
                [{{ formatMaterials(sp.plan.finalUnload) || '无' }}]
              </td>
              <td
                :class="$style.matCell"
                :data-tooltip="flightCellTitle(sp.ship.ship.id, sp.plan.stops.length)"
                data-tooltip-position="top">
                → {{ sp.plan.originNaturalId
                }}{{ flightCellText(sp.ship.ship.id, sp.plan.stops.length) }}
              </td>
              <td :class="$style.narrowCol">
                {{ formatLoadCell({ weight: 0, volume: 0 }, sp.plan.capacity) }}
              </td>
            </tr>
          </tbody>
        </table>

        <div :class="$style.summary">
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">飞行时长：</span>
            <span>
              <template v-if="flightTimesLoading">计算中…</template>
              <template v-else>{{ flightTotalText(sp.ship.ship.id) || '--' }}</template>
            </span>
          </div>
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">装船：</span>
            <span>
              {{ fixed0(billTotals(sp.plan.cxBill).weight) }}t /
              {{ fixed0(billTotals(sp.plan.cxBill).volume) }}m³
            </span>
          </div>
          <div v-if="Object.keys(sp.plan.purchaseBill).length > 0" :class="$style.summaryRow">
            <span :class="$style.summaryLabel">采购花费：</span>
            <span>{{ formatCurrency(billCost(sp.plan.purchaseBill)) }}</span>
          </div>
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">舱容峰值：</span>
            <span>
              {{ fixed0(sp.plan.peakLoad.weight) }}t / 剩余
              {{ fixed0(sp.plan.freeCapacity.weight) }}t（
              {{ formatPercent(sp.plan.peakLoad.weight, sp.plan.capacity.weight) }} 重量），
              {{ fixed0(sp.plan.peakLoad.volume) }}m³ / 剩余
              {{ fixed0(sp.plan.freeCapacity.volume) }}m³（
              {{ formatPercent(sp.plan.peakLoad.volume, sp.plan.capacity.volume) }} 体积）
            </span>
          </div>
          <div v-if="formatFinalUnloadNotes(sp.plan)" :class="$style.summaryRow">
            <span :class="$style.summaryLabel">运回空间站：</span>
            <span>{{ formatFinalUnloadNotes(sp.plan) }}</span>
          </div>
          <div v-if="sp.plan.overCapacity" :class="$style.warning">
            该船装载超过剩余舱容，请减少货物或换大船。
          </div>
          <div v-for="warning in sp.plan.warnings" :key="warning" :class="$style.warning">
            {{ warning }}
          </div>
        </div>
      </div>

      <!-- 原生 RT（socket 写入）：与「运行中」同一套表格样式，含逐站进度 -->
      <template v-if="chainTab === 'running'">
        <div v-for="entry in nativeRoutes" :key="nativeRouteRowKey(entry)" :class="$style.shipPlan">
          <div :class="$style.shipHeader">
            <span>
              {{
                entry.ship?.name || entry.ship?.registration || entry.record.shipLabel || '未知船只'
              }}
              <span :class="$style.running"
                >（{{ entry.record.name || entry.record.naturalId }} ·
                {{ routeProgressText(entry.record, entry.ship) }}）</span
              >
              <span v-if="entry.repeats" :class="$style.running">（循环）</span>
              <span v-if="entry.status === 'blocked'" :class="$style.routeBlocked">阻塞</span>
              <span v-else-if="entry.status === 'waiting'" :class="$style.routeWaiting">等待</span>
            </span>
            <div v-if="entry.isLoop" :class="$style.loopInfo">
              周期 {{ entry.cycleText || '—' }}（预计） · 一次运输实际可用
              {{ entry.supplyText || '—' }} · 出发地可支撑 {{ entry.sustainText }} 轮
            </div>
            <div :class="$style.route">
              <span :class="$style.routeLabel">航线：</span>
              <template v-for="(stop, index) in entry.record.waypoints" :key="index">
                <span v-if="index > 0" :class="$style.routeArrow">→</span>
                <span
                  :class="[
                    isNativeRouteEnd(entry.record, index) ? $style.routeOrigin : $style.routeNode,
                    routeStopStates(entry.record, entry.ship)[index] === 'done'
                      ? $style.routeDone
                      : '',
                  ]"
                  >{{ stop.location }}</span
                >
              </template>
            </div>
            <ul v-if="entry.alerts.length > 0" :class="$style.routeAlerts" role="status">
              <li v-for="alert in entry.alerts" :key="alert">{{ alert }}</li>
            </ul>
            <div :class="$style.shipActions">
              <PrunButton
                v-if="entry.cxBurnCode"
                dark
                @click="showBuffer(`XIT BURN CX ${entry.cxBurnCode}`)"
                >CX 消耗</PrunButton
              >
              <PrunButton
                v-if="entry.isLoop"
                dark
                :disabled="!entry.replenish"
                :data-tooltip="
                  entry.replenish
                    ? '按 1 轮出发地账单扣掉仓库库存生成 CX 采购包（含每轮 SF/FF）'
                    : '出发地已备齐（或不在交易所），无需补货'
                "
                @click="openRouteReplenish(entry)"
                >补货（1 轮）</PrunButton
              >
              <PrunButton
                v-else-if="!entry.running"
                dark
                :disabled="!entry.purchase"
                :data-tooltip="
                  entry.purchase
                    ? '按出发地装载清单扣掉仓库现有库存，生成 CX 采购包'
                    : '出发地已备齐（或不在交易所），无需采购'
                "
                @click="openRoutePurchase(entry)"
                >购买补给</PrunButton
              >
              <PrunButton dark @click="openNativeRoute(entry.record)">查看原生 RT</PrunButton>
              <PrunButton dark @click="onDeleteNativeRouteClick($event, entry.record)"
                >删除</PrunButton
              >
            </div>
          </div>
          <table :class="$style.table">
            <colgroup>
              <col :class="$style.colSeq" />
              <col :class="$style.colStation" />
              <col :class="$style.colOps" />
              <col :class="$style.colFlight" />
              <col :class="$style.colLoad" />
            </colgroup>
            <thead>
              <tr>
                <th :class="$style.narrowCol">序</th>
                <th :class="$style.narrowCol">星球/空间站</th>
                <th>操作</th>
                <th>飞行</th>
                <th :class="$style.narrowCol">载重</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(stop, index) in entry.record.waypoints" :key="index">
                <td :class="$style.narrowCol">
                  <span
                    :class="[
                      $style.marker,
                      $style[markClassKey(routeStopStates(entry.record, entry.ship)[index])],
                    ]"
                    >{{ stopMarker(routeStopStates(entry.record, entry.ship)[index]) }}</span
                  >
                  {{ index }}
                </td>
                <td :class="$style.narrowCol">
                  <span v-if="isNativeRouteEnd(entry.record, index)" :class="$style.routeOrigin">{{
                    stop.location
                  }}</span>
                  <template v-else
                    >{{ stop.location }}<BaseAlias :natural-id="stop.location"
                  /></template>
                </td>
                <td :class="$style.matCell">
                  <div v-if="nativeRouteStepMaterials(entry.record, index, 'unload')">
                    <span :class="$style.opsLabel">卸船</span>
                    [{{ nativeRouteStepMaterials(entry.record, index, 'unload') }}]
                  </div>
                  <div v-if="nativeRouteStepMaterials(entry.record, index, 'load')">
                    <span :class="$style.opsLabel">装载</span>
                    [{{ nativeRouteStepMaterials(entry.record, index, 'load') }}]
                  </div>
                  <div v-if="nativeRouteRefuelText(entry.record, index)">
                    <span :class="$style.opsLabel">补满</span>
                    [{{ nativeRouteRefuelText(entry.record, index) }}]
                  </div>
                  <span
                    v-if="
                      !nativeRouteStepMaterials(entry.record, index, 'unload') &&
                      !nativeRouteStepMaterials(entry.record, index, 'load') &&
                      !nativeRouteRefuelText(entry.record, index)
                    "
                    >—</span
                  >
                </td>
                <td :class="$style.matCell">
                  <div v-if="index + 1 < entry.record.waypoints.length">
                    → {{ entry.record.waypoints[index + 1]!.location }}
                  </div>
                  <div v-else>归航</div>
                  <!-- 航点的燃料/反应堆档位描述「飞到该航点」的那一段，所以这一行要取下一站的档位。 -->
                  <div v-if="nativeRouteNextLeg(entry.record, index)" :class="$style.loadSub">
                    燃料 {{ nativeRouteNextLeg(entry.record, index)!.fuelPercent }}%<template
                      v-if="nativeRouteNextLeg(entry.record, index)!.reactorPercent !== undefined">
                      · 反应堆
                      {{ nativeRouteNextLeg(entry.record, index)!.reactorPercent }}%</template
                    >
                  </div>
                  <div
                    v-if="nativeRouteLegHours(entry.record, index) !== undefined"
                    :class="$style.loadSub">
                    预计
                    {{ formatFlightDuration(nativeRouteLegHours(entry.record, index)! * 3600000) }}
                  </div>
                </td>
                <td :class="$style.narrowCol">
                  <template v-if="entry.loads[index]">
                    <div
                      v-if="entry.loads[index]!.uncertain"
                      data-tooltip="该航段含「按容量装载」或「卸全部」步骤，载重无法精确计算"
                      >—</div
                    >
                    <template v-else>
                      <div>{{
                        formatLoadCell(entry.loads[index]!.onDeparture, entry.capacity)
                      }}</div>
                      <div :class="$style.loadSub">{{ formatLoadChange(entry.loads[index]!) }}</div>
                    </template>
                  </template>
                  <span v-else>—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <div v-if="chainTab === 'plan' && unusedShipCount > 0" :class="$style.notice">
        已忽略 {{ unusedShipCount }} 艘未参与分配的船。
      </div>
      <template v-if="chainTab === 'plan'">
        <div v-if="!chainGroup" :class="$style.hint">
          选择一个产业链分组（在 BSN 面板为基地标注分组），分组内的基地将作为环线站点。
        </div>
        <div v-else-if="groupBases.length === 0" :class="$style.hint">
          该分组下没有基地。请在 BSN 面板的「供应链分组」列为基地录入此分组名。
        </div>
        <div v-else-if="selectedBases.length === 0" :class="$style.hint">
          请勾选参与环线的基地。
        </div>
        <div v-else-if="eligibleShips.length === 0" :class="$style.hint">
          没有停靠 CX 且有仓库/货舱的可用船只。
        </div>
        <div v-else-if="selectedShips.length === 0" :class="$style.hint"> 请分配至少一艘船。 </div>
        <LoadingSpinner v-else-if="loading" />
        <div v-else-if="selectedShips.length > 1" :class="$style.hint">
          生成原生 RT 时请选择一艘船。
        </div>
        <div v-else-if="planTables.length === 0" :class="$style.hint">
          当前没有可用的环线规划。
        </div>
      </template>
      <div v-else-if="nativeRoutes.length === 0" :class="$style.hint">
        当前没有已创建的原生 RT。
      </div>
    </div>
  </div>
</template>

<style module>
.layout {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  flex: 1 1 auto;
  min-height: 0;
}

.layout .groupSelect {
  max-width: 100%;
  margin: 0;
}

/* 产业链组下拉：与项目其它下拉框一致的游戏风格外观（同 PlanetRow/ARB 样式），
   避免 SelectInput 的裸原生 select 外观突兀。 */
.groupSelect :global(select) {
  box-sizing: border-box;
  padding: 2px 6px;
  border: 1px solid rgb(61, 74, 84);
  background: rgb(26, 33, 38);
  color: rgb(226, 230, 233);
  font: inherit;
  outline: none;
}

.groupSelect :global(select:focus) {
  border-color: rgb(var(--rp-accent-rgb));
  box-shadow: inset 0 0 0 1px rgb(var(--rp-accent-rgb));
  background: rgb(30, 38, 44);
}

.barLabel {
  color: #8a9aa8;
  white-space: nowrap;
  margin-right: 0.25rem;
}

.separator {
  width: 1px;
  align-self: stretch;
  background-color: #2b485a;
  margin: 0 0.25rem;
}

/* 冲突状态：高亮 + 可点击打开「云端同步」对话框处理。 */

.spacer {
  flex: 1;
}

.hint {
  padding: 8px;
  color: #8a9aa8;
}

.notice {
  padding: 4px 8px;
  color: #e8a33d;
  font-size: 11px;
}

.allocOk {
  padding: 4px 8px;
  color: #7ec8a3;
  font-size: 11px;
}

.allocNotes {
  padding: 0 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.allocNote {
  color: #8a9aa8;
  font-size: 11px;
}

.content {
  padding: 8px;
  /* 与父级 .layout 同为 border-box：width:100% 时 padding 计入宽度，
     否则内容区会横向溢出（多算 padding 宽度），导致右侧留白。 */
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: 8px;
  /* 列表区在窗口剩余高度内内部滚动（窗口高度固定，见 FLEET .layout）：
     顶部过滤/页签保持可见，表格行超高时此处滚动。
     width:100% + min-width:0 保证列表横向占满窗口，避免固定列宽的表在右侧留白。 */
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

/* 细窄深色滚动条（游戏/项目风格） */
.content {
  scrollbar-width: thin;
  scrollbar-color: rgb(61, 74, 84) rgb(26, 33, 38);
}

.content::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

.content::-webkit-scrollbar-track {
  background: rgb(26, 33, 38);
}

.content::-webkit-scrollbar-thumb {
  background: rgb(61, 74, 84);
  border-radius: 4px;
}

.content::-webkit-scrollbar-thumb:hover {
  background: rgb(90, 105, 118);
}

.tabsHeader {
  /* 游戏 .Tabs__component 自带固定高度（实测约 359px，为整套页签面板设计），
     仅复用页签头时必须收拢。注意不能设 height:auto —— 该组件子元素脱离
     常规流，auto 会塌缩为 0，页签文字溢出并与下方船卡重叠；实测页签行
     高 29px，故显式给出一行高度。 */
  height: 29px !important;
  min-height: 29px !important;
}

.route {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
}

.routeLabel {
  color: #8a9aa8;
}

/* 航线节点默认蓝色；完成后由 .routeDone 覆盖为绿色。 */
.routeNode {
  color: rgb(63, 162, 222);
}

.routeOrigin {
  color: rgb(63, 162, 222);
}

.routeArrow {
  color: #8a9aa8;
}

/* 完成后（对应站 / 出发 / 归航）标绿；须声明在 .routeNode/.routeOrigin 之后以覆盖默认蓝。 */
.routeDone {
  color: rgb(171, 198, 128);
}

.table {
  border-collapse: collapse;
  width: 100%;
  /* 用 auto 布局：其余列固定 px 宽，多余宽度全部进入 auto 的「操作」列，
     所有船的表格同宽（同为容器 100%），列宽因此天然一致且能撑满容器。
     不要用 table-layout: fixed —— 实测 Chromium 下 fixed 布局不会把剩余
     宽度分给 auto 列（Chrome 152 中最后一列右侧留白约 620px，且对列显式
     设 calc 宽度也无效），auto 布局则能正确分配并铺满。 */
  table-layout: auto;
}

.colSeq {
  width: 36px;
}

.colStation {
  width: 150px;
}

.colOps {
  width: auto;
}

.colFlight {
  width: 120px;
}

.colLoad {
  width: 180px;
}

.table thead tr {
  border-bottom: 1px solid #2b485a;
  box-sizing: border-box;
}

.table tbody tr {
  border-bottom: 1px solid #1d3341;
  box-sizing: border-box;
}

.table td,
.table th {
  padding: 3px 6px;
  text-align: left;
  vertical-align: top;
}

.narrowCol {
  /* 允许换行，避免超长星球名/载重文本把 auto 布局的列撑得过宽。 */
  white-space: normal;
  word-break: break-word;
}

.matCell {
  font-size: 11px;
}

.opsLabel {
  display: inline-block;
  min-width: 2.5em;
  color: #7ec8a3;
  font-weight: 600;
}

.opsWarn {
  color: #e8a33d;
  font-size: calc(10px + 1px * var(--rp-font-enlargement));
}

.loadSub {
  font-size: calc(10px + 1px * var(--rp-font-enlargement));
  color: #8a9aa8;
}

.summary {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.summaryRow {
  font-size: 11px;
}

.summaryLabel {
  color: #8a9aa8;
}

.warning {
  color: var(--rp-skin-warning, #c2410c);
  font-size: 11px;
}

.shipPlan {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid #2b485a;
  border-radius: 4px;
  padding: 8px;
}

.shipHeader {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
  color: rgb(63, 162, 222);
}

.shipActions {
  display: flex;
  gap: 6px;
}

.running {
  color: #f0ad4e;
  font-size: 11px;
  margin-left: 0.5rem;
}

.loopInfo {
  color: #8a9aa8;
  font-size: 11px;
  margin: 2px 0;
}

.routeBlocked {
  color: #d9534f;
  font-size: 11px;
  margin-left: 0.5rem;
}

.routeWaiting {
  color: #f0ad4e;
  font-size: 11px;
  margin-left: 0.5rem;
}

.routeAlerts {
  margin: 4px 0;
  padding-left: 20px;
  color: #f0ad4e;
  font-size: 11px;
  line-height: 1.5;
}

.marker {
  width: 1.2em;
  flex: none;
  text-align: center;
}

.markDone {
  color: rgb(171, 198, 128);
}

.markArrived {
  color: #f0ad4e;
}

.markTransit {
  color: rgb(63, 162, 222);
}

.markPending {
  color: #8a9aa8;
}
</style>
