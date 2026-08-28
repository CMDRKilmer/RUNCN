<script lang="ts">
import { onApiMessage } from '@src/infrastructure/prun-api/data/api-messages';

// 模块级状态：跨组件实例共享（ChainView 在切换页签时会卸载/重挂载，
// 组件内 let 每实例一份，无法跨实例共享）。
// 自动恢复每个「数据就绪周期」至多执行一次；服务器重连时重置以便再次恢复。
let chainAutoRecovered = false;
// 区分首次连接与重连：首次连接在扩展加载早期触发，先于本面板挂载。
let chainFirstConnect = true;
// 重连提示：由模块级连接监听置位，组件数据就绪时消费并展示。
let chainReconnectNotice = false;

// 服务器重连检测：断联后游戏通常原地重连而非整页刷新，各数据 store 会重置后
// 重新推送。重置自动恢复标志，数据重载完成后自动重新检测环线断线阶段
//（断联期间到港告警可能错过，页面未刷新导致原先的自动恢复不会再次触发）。
onApiMessage({
  CLIENT_CONNECTION_OPENED() {
    if (chainFirstConnect) {
      chainFirstConnect = false;
      return;
    }
    chainAutoRecovered = false;
    chainReconnectNotice = true;
  },
});
</script>

<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import Tooltip from '@src/components/Tooltip.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import {
  planChainRoute,
  buildChainActionPackages,
  sanitizeActName,
  splitChainPlanAcrossShips,
  shipOriginNaturalId,
  shipWarehouseStock,
  buildCombinedCapacity,
  type ChainPlannerBase,
  type ChainPlan,
  type ChainStopPlan,
  type ShipChainPlan,
} from '@src/features/XIT/FLEET/chain-planner';
import {
  estimateChainFlightTimes,
  type ChainFlightEstimate,
  type ChainFlightLeg,
} from '@src/features/XIT/FLEET/chain-flight-time';
import { billTotals, type DispatchShip } from '@src/features/XIT/FLEET/utils';
import { getBaseGroups } from '@src/core/base-groups';
import { useTileState } from '@src/store/user-data-tiles';
import { userData } from '@src/store/user-data';
import { stagedDispatch, dispatchFinished } from '@src/features/XIT/FLEET/staged';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import {
  queueTriggerRun,
  getPackageFinished,
  hasPendingTriggerRun,
} from '@src/features/XIT/ACT/trigger-queue';
import { watchUntil } from '@src/utils/watch';
import { createId } from '@src/store/create-id';
import { showTileOverlay, showConfirmationOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import ChainSyncDialog from '@src/features/XIT/FLEET/ChainSyncDialog.vue';
import {
  CONFIG_KEY,
  createChainSyncController,
  isChainPackageName,
  isChainTrigger,
  type ChainSyncState,
} from '@src/features/XIT/FLEET/chain-sync';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
  getSystemLineFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { fixed0, formatCurrency } from '@src/utils/format';
import { getPrice } from '@src/infrastructure/fio/cx';
import { gameNow } from '@src/infrastructure/fio/orbit';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';

const props = defineProps<{
  ships: DispatchShip[];
  bases: ChainPlannerBase[];
}>();

const { ships, bases } = props;

// ── 状态 ─────────────────────────────────────────────────────
// 选中的产业链分组（BSN「供应链分组」列录入的自由文本名）。
const chainGroup = useTileState<string | undefined>('chainGroup', undefined);
// 分配到本环线的船只（多选，数量不限）。
const chainShipIds = useTileState<string[] | undefined>('chainShipIds', undefined);
// 分组内勾选参与的基地：undefined = 默认全选。
const chainBaseIds = useTileState<string[] | undefined>('chainBaseIds', undefined);
// 生成包时自动发船（主包与每站包尾追加 DEPART）。
const chainAutoLaunch = useTileState<boolean>('chainAutoLaunch', true);
// 到港触发器模式：开启 → AUTO（到港自动执行），关闭 → CONFIRM（通知确认）。
const chainAutoTrigger = useTileState<boolean>('chainAutoTrigger', false);
// 自动恢复：页面加载后自动检测并执行环线断线阶段的下一步（网页关闭期间错过到港触发器）。
const chainAutoRecover = useTileState<boolean>('chainAutoRecover', true);

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
function shipLabel(entry: DispatchShip) {
  return entry.ship.name ?? entry.ship.registration;
}

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

// ── 环线计划（合并容量，单一路线） ───────────────────────────
const planOrigin = computed(() =>
  selectedShips.value.length > 0 ? shipOriginNaturalId(selectedShips.value[0]!) : '',
);

const plan = computed(() => {
  if (selectedBases.value.length === 0 || selectedShips.value.length === 0) {
    return undefined;
  }
  const capacity = buildCombinedCapacity(selectedShips.value);
  if (!capacity) {
    return undefined;
  }
  return planChainRoute({
    originNaturalId: planOrigin.value,
    capacity,
    bases: selectedBases.value,
    // 出发地空间站仓库库存：组内产出的缺口由仓库以「取货」补足。
    originStock: shipWarehouseStock(selectedShips.value[0]!),
    // 出发地交易所：CX 采购下单处，用于检测空间站订单簿库存。
    exchangeCode: selectedShips.value[0]!.exchangeCode,
  });
});

const loading = computed(
  () =>
    selectedBases.value.length > 0 && selectedShips.value.length > 0 && plan.value === undefined,
);
const hasStops = computed(() => (plan.value?.stops.length ?? 0) > 0);

// ── 多船分配结果 ─────────────────────────────────────────────
// 并行分段：每艘船跑航线的连续一段，同时出动，总耗时 ≈ 单环线 / 船数。
const shipPlans = computed(() => {
  const p = plan.value;
  if (!p || selectedShips.value.length === 0) {
    return [];
  }
  return splitChainPlanAcrossShips(p, selectedShips.value, selectedBases.value);
});

// 未参与分配的船（无货舱，或船多于站点数）。
const unusedShipCount = computed(() =>
  selectedShips.value.length > 0 ? selectedShips.value.length - shipPlans.value.length : 0,
);

// ── 各段飞行时间预估（FTC 最优燃油计划） ─────────────────────
// 每艘船一条环线预估（shipId → 逐段时长）。计算在后台进行，
// 显示在「飞行」列与汇总「飞行时长」行；下游基地用未来预计位置计算。
const flightEstimates = ref<Map<string, ChainFlightEstimate>>(new Map());
const flightTimesLoading = ref(false);

// 环线计划变化时逐段估算飞行时间（FTC 最优燃油计划，下游基地用未来位置）。
// 同时响应规划（shipPlans）与执行中环线（activeRuns）：执行中船已离港时不在
// eligibleShips / shipPlans 中，但飞行列仍需读取预估——按 shipId 收集
// 起点与站点一并估算。计划为空（未规划/无执行中）时保留已有预估。
// 注：watch 内部会引用 activeRuns，必须在 activeRuns 定义之后再注册；放在下方
// 「环线执行进度」computed 之后调用 registerFlightTimeWatch()。
let flightTimeToken = 0;
function registerFlightTimeWatch() {
  watch(
    [shipPlans, activeRuns, () => shipsStore.fetched.value],
    async ([plans, runs, shipsFetched]) => {
      // 船数据未就绪时跳过（估算需读取飞船实时质量/加速度与蓝图）。
      if (!shipsFetched) {
        return;
      }
      const token = ++flightTimeToken;
      // 统一为 shipId → {ship, origin, stops}：规划取实时计划，执行中取链快照/持久化链记录。
      const entries = new Map<
        string,
        {
          ship: PrunApi.Ship;
          origin: string;
          stops: { naturalId: string; planetName: string }[];
        }
      >();
      for (const sp of plans) {
        if (sp.plan.stops === undefined) {
          continue;
        }
        entries.set(sp.ship.ship.id, {
          ship: sp.ship.ship,
          origin: sp.plan.originNaturalId,
          stops: sp.plan.stops.map(s => ({
            naturalId: s.naturalId,
            planetName: s.planetName,
          })),
        });
      }
      for (const run of runs) {
        if (entries.has(run.shipId)) {
          continue;
        }
        const ship = shipsStore.getById(run.shipId);
        if (!ship) {
          continue;
        }
        if (run.run.stops === undefined) {
          continue;
        }
        entries.set(run.shipId, {
          ship,
          origin: run.run.originNaturalId,
          stops: run.run.stops.map(s => ({ naturalId: s.naturalId, planetName: s.planetName })),
        });
      }
      if (entries.size === 0) {
        return;
      }
      flightTimesLoading.value = true;
      const estimates = new Map<string, ChainFlightEstimate>(flightEstimates.value);
      try {
        for (const [shipId, info] of entries) {
          const est = await estimateChainFlightTimes(info);
          if (token !== flightTimeToken) {
            return; // 计划已变化，丢弃过期结果。
          }
          estimates.set(shipId, est);
        }
        if (token !== flightTimeToken) {
          return;
        }
        flightEstimates.value = estimates;
      } catch (e) {
        console.warn('[XIT/FLEET] flightTime estimate failed', e);
      } finally {
        if (token === flightTimeToken) {
          flightTimesLoading.value = false;
        }
      }
    },
    { immediate: true },
  );
}

// ── 执行 ─────────────────────────────────────────────────────
const executeTooltip = computed(() => {
  if (chainGroup.value === undefined) {
    return '请先选择产业链分组';
  }
  if (selectedBases.value.length === 0) {
    return '请勾选参与环线的基地';
  }
  if (selectedShips.value.length === 0) {
    return '请分配至少一艘船';
  }
  return undefined;
});

function upsertPackage(pkg: UserData.ActionPackageData) {
  const index = userData.actionPackages.findIndex(x => x.global.name === pkg.global.name);
  if (index >= 0) {
    userData.actionPackages[index] = pkg;
  } else {
    userData.actionPackages.push(pkg);
  }
}

function upsertTrigger(trigger: UserData.TriggerData) {
  const index = userData.triggers.findIndex(
    x => x.packageName === trigger.packageName && x.event.type === 'FLIGHT_ENDED',
  );
  if (index >= 0) {
    userData.triggers[index] = trigger;
  } else {
    userData.triggers.push(trigger);
  }
}

// 删除指定船的全部环线 ACT 操作包与一次性触发器（含未 autoDelete 的历史残留）。
// 用于「清理计划」按钮（含已完成）与重执行前清理旧脚本。
function removeShipChainScripts(shipName: string) {
  for (let i = userData.actionPackages.length - 1; i >= 0; i--) {
    const name = userData.actionPackages[i]!.global.name;
    if (
      (isChainPackageName(name) && name.endsWith(` ${shipName}`)) ||
      name === `环线派遣 ${shipName}`
    ) {
      userData.actionPackages.splice(i, 1);
    }
  }
  for (let i = userData.triggers.length - 1; i >= 0; i--) {
    const trigger = userData.triggers[i]!;
    const name = trigger.packageName;
    if (
      (isChainPackageName(name) && name.endsWith(` ${shipName}`)) ||
      name === `环线派遣 ${shipName}`
    ) {
      userData.triggers.splice(i, 1);
    }
  }
}

const executeNotice = ref<string | undefined>(undefined);
// 状态检查结果提示：环线运行中网页关闭导致到港触发器错过时，提示自动恢复情况。
const statusCheckNotice = ref<string | undefined>(undefined);

// 执行时的计划快照：环线执行中船离港后 shipPlans 为空，
// 用快照保持「与规划一致」的表格显示，仅在序列叠加进度图标。
// 快照同时持久化到 chainRuns.plan，页面刷新后仍可显示阶段载重。
const planSnapshot = ref<ShipChainPlan[]>([]);

// 完成清理定时器（历史遗留）：完成态环线保留在状态列表不再自动清理；
// 仅重执行/清理计划时用于取消旧定时器。
const finishedCleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearFinishedCleanup(shipId: string) {
  const timer = finishedCleanupTimers.get(shipId);
  if (timer !== undefined) {
    clearTimeout(timer);
    finishedCleanupTimers.delete(shipId);
  }
}

onBeforeUnmount(() => {
  for (const timer of finishedCleanupTimers.values()) {
    clearTimeout(timer);
  }
  finishedCleanupTimers.clear();
});

// 按船清理计划（含已完成）：确认后删除该船环线运行记录 + 相关 ACT 操作包与触发器。
function onClearShipPlanClick(
  e: Event,
  sp: { shipId: string; ship?: DispatchShip; shipName?: string },
) {
  const rawName = sp.ship ? (sp.ship.ship.name ?? sp.ship.ship.registration) : (sp.shipName ?? '');
  const shipName = sanitizeActName(rawName) || rawName;
  const label = sp.ship ? shipLabel(sp.ship) : shipName;
  showConfirmationOverlay(
    e,
    () => {
      removeShipChainScripts(shipName);
      clearFinishedCleanup(sp.shipId);
      delete userData.chainRuns[sp.shipId];
      planSnapshot.value = planSnapshot.value.filter(p => p.ship.ship.id !== sp.shipId);
      statusCheckNotice.value = `已清理 ${label} 的环线计划及 ACT 脚本/触发器。`;
    },
    { message: `删除 ${label} 的环线计划及其 ACT 脚本/触发器？`, confirmLabel: '删除' },
  );
}

function execute() {
  const allPlans = shipPlans.value;
  if (allPlans.length === 0) {
    return;
  }
  // 多环线并行：正在执行环线的船不能重复生成（会覆盖其脚本与运行状态），
  // 跳过并提示；其余船照常生成新环线。
  const runningIds = new Set(activeRuns.value.map(r => r.shipId));
  const plans = allPlans.filter(p => !runningIds.has(p.ship.ship.id));
  if (plans.length === 0) {
    executeNotice.value = '所选船只均在执行环线中，无法重复生成。请等待归航或先清理计划。';
    return;
  }

  const triggerMode: UserData.TriggerMode = chainAutoTrigger.value ? 'AUTO' : 'CONFIRM';
  const mainPkgs: UserData.ActionPackageData[] = [];

  for (const { ship, plan: shipPlan } of plans) {
    const actionPlan = buildChainActionPackages(ship, shipPlan, {
      autoLaunch: chainAutoLaunch.value,
      triggerMode,
    });
    if (!actionPlan) {
      continue;
    }
    // 重新执行时清掉旧完成清理定时器，避免误删新记录；
    // 先清掉该船旧版/已完成的环线脚本，防止 ACT 列表残留过期包。
    clearFinishedCleanup(ship.ship.id);
    const shipName =
      sanitizeActName(ship.ship.name ?? ship.ship.registration) || ship.ship.registration;
    removeShipChainScripts(shipName);

    // 记录环线运行进度（以船为键），并持久化计划快照：
    // 页面刷新后仍按规划样式显示各阶段操作与「当前阶段载重」。
    userData.chainRuns[ship.ship.id] = {
      shipId: ship.ship.id,
      shipName: ship.ship.name ?? ship.ship.registration,
      startedAt: Date.now(),
      originNaturalId: shipPlan.originNaturalId,
      stops: shipPlan.stops.map((stop, i) => {
        const unloadAt: Record<string, number> = { ...stop.unloadCx };
        for (const [ticker, entry] of stop.unloadChain) {
          unloadAt[ticker] = (unloadAt[ticker] ?? 0) + entry.amount;
        }
        const loadAt: Record<string, number> = {};
        const loadTo: Record<string, string> = {};
        for (const [ticker, entry] of stop.load) {
          loadAt[ticker] = entry.amount;
          loadTo[ticker] = entry.to;
        }
        return {
          naturalId: stop.naturalId,
          planetName: stop.planetName,
          pkgName: actionPlan.stopPkgs[i]!.pkg.global.name,
          // 持久化进度状态：删除 ACT/触发器后列表仍能正确展示。
          state: 'pending',
          plan: {
            unloadAt,
            loadAt,
            loadTo,
            loadOnArrival: stop.loadOnArrival,
            loadOnDeparture: stop.loadOnDeparture,
            clipped: stop.clipped,
          },
        };
      }),
      finalPkgName: actionPlan.finalPkg?.pkg.global.name,
      mainPkgName: actionPlan.mainPkg.global.name,
      originState: 'pending',
      finalState: 'pending',
      plan: {
        capacity: shipPlan.capacity,
        originLoadOnDeparture: shipPlan.loadOnDeparture,
        loadOnReturn: shipPlan.loadOnReturn,
        purchaseBill: shipPlan.purchaseBill,
        originPickup: shipPlan.originPickup,
        finalUnload: shipPlan.finalUnload,
        finalUnloadNotes: shipPlan.finalUnloadNotes,
      },
    };

    // 阶段脚本按序写入 ACT 列表：0 主包 → 1..N 站点包 → N+1 归航包；
    // 各包执行成功后自动删除（主包改由 autoDelete 处理）。
    upsertPackage(actionPlan.mainPkg);
    for (const { pkg, trigger } of actionPlan.stopPkgs) {
      upsertPackage(pkg);
      upsertTrigger(trigger);
    }
    if (actionPlan.finalPkg) {
      upsertPackage(actionPlan.finalPkg.pkg);
      upsertTrigger(actionPlan.finalPkg.trigger);
    }
    mainPkgs.push(actionPlan.mainPkg);
  }

  if (mainPkgs.length === 0) {
    executeNotice.value = '未生成任何主包（所选船只缺少货舱/仓库）';
    return;
  }
  // 保存计划快照：环线执行期间显示它（格式与规划一致，序列叠加进度图标）。
  // 多环线并行时按船合并，避免覆盖其他运行中环线的快照。
  planSnapshot.value = [
    ...planSnapshot.value.filter(p => !plans.some(np => np.ship.ship.id === p.ship.ship.id)),
    ...plans,
  ];

  if (mainPkgs.length === 1) {
    stageMainPackage(mainPkgs[0]!);
  } else {
    // 多船并行分段：全部主包一次性暂存到 FLEETACT（所有船可见可执行），
    // 自动模式下按顺序自动执行；DEPART 后各船独立飞行，飞行阶段并行。
    for (const pkg of mainPkgs) {
      upsertPackage(pkg);
    }
    const stagedPkgs = mainPkgs.map(p => JSON.parse(JSON.stringify(p)));
    stagedDispatch.value = { pkgs: stagedPkgs };
    if (chainAutoTrigger.value) {
      void runStagedPkgs(stagedPkgs);
    } else {
      showBuffer('XIT FLEETACT');
    }
    executeNotice.value = `已生成 ${mainPkgs.length} 艘船的主包，全部暂存至 FLEETACT 逐艘执行（飞行阶段并行）。`;
  }
}

// 多船自动执行：按顺序触发各主包（FLEETACT 窗口内多个执行实例），
// 前一艘执行完成后再触发下一艘，避免多个 ActionRunner 并发抢占游戏窗口；
// 所有包执行完后自动关闭 FLEETACT 窗口。
async function runStagedPkgs(pkgs: UserData.ActionPackageData[]) {
  dispatchFinished.value = false;
  // getPackageFinished 复用已存在的 ref：上次执行留下的 true 会让
  // watchUntil 立即 resolve（并发触发）并让 closeWhen 初始为 true（窗口早关）。
  // 与 trigger-engine 一致，入队前重置为 false。
  for (const pkg of pkgs) {
    getPackageFinished(pkg.global.name).value = false;
  }
  void showBuffer('XIT FLEETACT', {
    force: true,
    autoClose: true,
    closeWhen: computed(() => pkgs.every(p => getPackageFinished(p.global.name).value)),
  });
  for (const pkg of pkgs) {
    queueTriggerRun({ triggerId: createId(), packageName: pkg.global.name });
    await watchUntil(getPackageFinished(pkg.global.name));
  }
}

function stageMainPackage(pkg: UserData.ActionPackageData) {
  stagedDispatch.value = { pkg: JSON.parse(JSON.stringify(pkg)) };
  if (chainAutoTrigger.value) {
    dispatchFinished.value = false;
    queueTriggerRun({ triggerId: createId(), packageName: pkg.global.name });
    void showBuffer('XIT FLEETACT', {
      force: true,
      autoClose: true,
      closeWhen: computed(() => dispatchFinished.value),
    });
  } else {
    showBuffer('XIT FLEETACT');
  }
}

// ── 状态检查（断线恢复） ─────────────────────────────────────
// 环线运行中若网页关闭，到港触发器（FLIGHT_ENDED 告警事件）错过触发，
// 重新打开页面后环线会卡在当前阶段。状态检查依据船当前停靠位置与
// 持久化阶段状态，判断当前阶段并自动执行下一步操作包。
interface PendingChainStep {
  pkgName: string;
  label: string;
}

// 刷新后脚本一致性校验：chainRuns 中「持久化为未完成」的阶段，其操作包应仍存在。
// 执行过的阶段包会被 autoDelete 删除（属正常）；旧记录无持久化状态则跳过校验
// （回退到「包消失 = 完成」的推导）。
function verifyChainRunScript(run: UserData.ChainRun): { ok: boolean; missing: string[] } {
  const pkgExists = (name: string) => userData.actionPackages.some(p => p.global.name === name);
  const missing: string[] = [];
  if (
    run.originState === 'pending' &&
    run.mainPkgName !== undefined &&
    !pkgExists(run.mainPkgName)
  ) {
    missing.push(run.mainPkgName);
  }
  for (const stop of run.stops) {
    if (stop.state === 'pending' && stop.pkgName && !pkgExists(stop.pkgName)) {
      missing.push(stop.pkgName);
    }
  }
  if (
    run.finalState === 'pending' &&
    run.finalPkgName !== undefined &&
    !pkgExists(run.finalPkgName)
  ) {
    missing.push(run.finalPkgName);
  }
  return { ok: missing.length === 0, missing };
}

function verifyAllChainRuns(): { ok: boolean; diffs: string[] } {
  const diffs: string[] = [];
  for (const run of Object.values(userData.chainRuns)) {
    const { ok, missing } = verifyChainRunScript(run);
    if (!ok) {
      diffs.push(`${run.shipName}：缺失 ${missing.join('、')}`);
    }
  }
  return { ok: diffs.length === 0, diffs };
}

// 扫描全部运行中的环线，找出「船已就位但操作包未执行」的下一阶段。
// includeOrigin=false：刷新自动恢复时不自动执行第 0 步（出发），
// 仅刷新状态显示为「未开始」，出发由用户手动触发。
function collectPendingChainSteps(includeOrigin = true): PendingChainStep[] {
  const steps: PendingChainStep[] = [];
  for (const run of Object.values(userData.chainRuns)) {
    const ship = shipsStore.getById(run.shipId);
    if (ship === undefined) {
      continue;
    }
    const dockedAt = ship.address ? getEntityNaturalIdFromAddress(ship.address) : undefined;
    const pkgExists = (name: string) => userData.actionPackages.some(p => p.global.name === name);
    // 出发阶段：船仍在出发地、主包未执行（包未被 autoDelete 删除）时执行主包。
    if (
      includeOrigin &&
      run.mainPkgName !== undefined &&
      run.originState !== 'done' &&
      dockedAt === run.originNaturalId &&
      pkgExists(run.mainPkgName) &&
      !hasPendingTriggerRun(run.mainPkgName)
    ) {
      steps.push({ pkgName: run.mainPkgName, label: `${run.shipName} 出发` });
      continue;
    }
    // 站点阶段：取第一个未完成站，若船正停靠该站则执行该站包。
    let allStopsDone = true;
    for (const stop of run.stops) {
      if (stop.state === 'done') {
        continue;
      }
      allStopsDone = false;
      if (
        dockedAt === stop.naturalId &&
        pkgExists(stop.pkgName) &&
        !hasPendingTriggerRun(stop.pkgName)
      ) {
        steps.push({ pkgName: stop.pkgName, label: `${run.shipName} ${stop.planetName}` });
      }
      break;
    }
    // 归航阶段：全部站点完成、船已回出发地且归航包未执行时执行归航包。
    if (
      allStopsDone &&
      run.finalPkgName !== undefined &&
      run.finalState !== 'done' &&
      dockedAt === run.originNaturalId &&
      pkgExists(run.finalPkgName) &&
      !hasPendingTriggerRun(run.finalPkgName)
    ) {
      steps.push({ pkgName: run.finalPkgName, label: `${run.shipName} 归航卸货` });
    }
  }
  return steps;
}

// 静默执行环线操作包：与触发器引擎同通道（入队 + 隐藏窗口自动执行、结束自动关窗）。
function runChainStepSilently(pkgName: string) {
  const finished = getPackageFinished(pkgName);
  finished.value = false;
  queueTriggerRun({ triggerId: createId(), packageName: pkgName });
  showBuffer(`XIT ACT_${pkgName.replace(' ', '_')}`, {
    force: true,
    autoClose: true,
    closeWhen: computed(() => finished.value),
  });
}

// 状态检查：自动判断当前阶段并自动处理下一步。
function onStatusCheckClick() {
  const steps = collectPendingChainSteps();
  if (steps.length === 0) {
    // 诊断：无运行中环线 vs 船已就位但未匹配到可执行阶段。
    // 后一种情况给出每艘船的实际停靠位置与预期阶段，便于核对位置/脚本差异。
    const runs = Object.values(userData.chainRuns).filter(
      r => shipsStore.getById(r.shipId) !== undefined,
    );
    if (runs.length === 0) {
      statusCheckNotice.value =
        '状态检查：未发现需要恢复的环线步骤（无运行中的环线，或船数据未加载完成，可稍后再试）。';
    } else {
      const details = runs.map(run => {
        const ship = shipsStore.getById(run.shipId)!;
        const dockedAt = ship.address ? getEntityNaturalIdFromAddress(ship.address) : undefined;
        const progress = runProgress(run);
        const next = progress.stops.find(s => s.state !== 'done');
        const expected = next ? `${next.planetName}（${next.naturalId}）` : '归航';
        return `${run.shipName}：停靠 ${dockedAt ?? '未知'}，预期 ${expected}`;
      });
      statusCheckNotice.value =
        `状态检查：${runs.length} 艘运行中但无待恢复步骤 —— ` +
        details.join('；') +
        '。请核对停靠位置、货舱与操作包是否一致。';
    }
    return;
  }
  for (const step of steps) {
    runChainStepSilently(step.pkgName);
  }
  statusCheckNotice.value = `状态检查：${steps.length} 个阶段待恢复，已自动执行 —— ${steps
    .map(s => s.label)
    .join('、')}。`;
}

// ── 自动恢复（断线自动续跑） ────────────────────────────────
// 船数据就绪且「自动恢复」开启后运行：扫描运行中的环线，自动执行断线阶段。
// 服务器重连（页面未自动刷新）时 store 会重置后重新推送；数据就绪时若本次
// 来自重连（模块级监听置位）则提示用户，并自动再次检测断线阶段。
watch(
  () => shipsStore.fetched.value,
  fetched => {
    if (!fetched) {
      return;
    }
    // 刷新后脚本一致性校验：未完成阶段的脚本应仍存在；缺失则提示差异，
    // 且不自动恢复（避免执行到错误/被另一端改动的脚本）。
    const { ok, diffs } = verifyAllChainRuns();
    if (!ok) {
      statusCheckNotice.value = `环线脚本差异：${diffs.join('；')}。请检查 ACT/TRIGGER 列表或执行云端同步。`;
      return;
    }
    // 消费重连提示（模块级标志跨实例共享，避免首次连接误报）。
    if (chainReconnectNotice) {
      chainReconnectNotice = false;
      if (chainAutoRecover.value && Object.keys(userData.chainRuns).length > 0) {
        statusCheckNotice.value = '检测到服务器重连（页面未自动刷新），自动恢复已重新启用。';
      }
    }
    if (!chainAutoRecover.value || chainAutoRecovered) {
      return;
    }
    chainAutoRecovered = true;
    // 刷新后不自动执行第 0 步（出发）：状态显示「未开始」，出发由用户手动触发。
    const steps = collectPendingChainSteps(false);
    if (steps.length === 0) {
      return;
    }
    for (const step of steps) {
      runChainStepSilently(step.pkgName);
    }
    statusCheckNotice.value = `自动恢复：检测到 ${steps.length} 个环线阶段断线，已自动执行 —— ${steps
      .map(s => s.label)
      .join('、')}。`;
  },
  { immediate: true },
);

// ── 环线多端同步（org-api 服务器，跨浏览器/设备） ─────────────
// 按船同步：每艘船（chainRuns + 该船环线 ACT 包/触发器）独立一条快照，
// 互不覆盖；'__config__' 存全局配置。无自动轮询——仅在本地环线状态改变时
// 防抖推送；覆盖仅由「云端同步」对话框手动选择。
const chainSyncState = ref<ChainSyncState>({
  syncing: false,
  lastSyncAt: null,
  dirty: false,
  conflict: false,
  error: null,
});
const syncNotice = ref<string | undefined>(undefined);

const chainSync = createChainSyncController({
  getConfig: () => ({
    chainGroup: chainGroup.value,
    chainShipIds: chainShipIds.value,
    chainBaseIds: chainBaseIds.value,
    chainAutoLaunch: chainAutoLaunch.value,
    chainAutoTrigger: chainAutoTrigger.value,
    chainAutoRecover: chainAutoRecover.value,
  }),
  // chainGroup 的 watch 会清空 chainBaseIds（用户切换分组的语义）：
  // 先设 group 并等其 watch flush，再设其余字段，避免远端 chainBaseIds 被误清。
  applyConfig: async config => {
    if (config.chainGroup !== undefined && config.chainGroup !== chainGroup.value) {
      chainGroup.value = config.chainGroup;
    }
    await nextTick();
    if (config.chainBaseIds !== undefined) {
      chainBaseIds.value = config.chainBaseIds;
    }
    if (config.chainShipIds !== undefined) {
      chainShipIds.value = config.chainShipIds;
    }
    if (config.chainAutoLaunch !== undefined) {
      chainAutoLaunch.value = config.chainAutoLaunch;
    }
    if (config.chainAutoTrigger !== undefined) {
      chainAutoTrigger.value = config.chainAutoTrigger;
    }
    if (config.chainAutoRecover !== undefined) {
      chainAutoRecover.value = config.chainAutoRecover;
    }
  },
  // shipId → 该船净化后的名字（环线包名后缀），用于按船收集/匹配脚本。
  resolveShipName: shipId => {
    const ship = shipsStore.getById(shipId);
    if (!ship) {
      return undefined;
    }
    return sanitizeActName(ship.name ?? ship.registration) || ship.registration;
  },
  onState: s => {
    chainSyncState.value = s;
  },
  onNotice: msg => {
    syncNotice.value = msg;
  },
});

// 环线数据变化 → 按船标记脏 → 防抖推送（每船只推自己的数据）。
// 远端应用引发的变化由 controller 抑制，避免「应用远端 → 重推 → 远端更新」循环。
watch(
  () => [
    chainGroup.value,
    chainShipIds.value,
    chainBaseIds.value,
    chainAutoLaunch.value,
    chainAutoTrigger.value,
    chainAutoRecover.value,
    userData.chainRuns,
    userData.actionPackages.filter(p => isChainPackageName(p.global.name)),
    userData.triggers.filter(isChainTrigger),
  ],
  () => {
    for (const shipId of Object.keys(userData.chainRuns)) {
      chainSync.markDirtyShip(shipId);
    }
    chainSync.markDirtyConfig();
  },
  { deep: true },
);

onMounted(() => {
  chainSync.start();
});
onUnmounted(() => {
  chainSync.stop();
});

const syncStateText = computed(() => {
  const s = chainSyncState.value;
  if (s.syncing) {
    return '同步中…';
  }
  if (s.error) {
    return '同步失败';
  }
  if (s.conflict) {
    return '有冲突';
  }
  if (s.dirty) {
    return '待同步';
  }
  if (s.lastSyncAt !== null) {
    return `已同步 ${new Date(s.lastSyncAt).toLocaleTimeString()}`;
  }
  return '未同步';
});

// 打开云端同步对比对话框：拉取云端 + 收集本地（配置 + 各活跃船），
// 由用户逐项选择覆盖方向（按船/配置）。
async function onChainSyncClick(e: Event) {
  const cmp = await chainSync.prepareComparison();
  if (!cmp) {
    return; // 拉取失败/进行中：错误已写入 chainSyncState。
  }
  showTileOverlay(e, ChainSyncDialog, {
    comparison: cmp,
    onApply: (target, direction) => {
      if (direction === 'pull') {
        // 用云端覆盖本地（指定船或配置）。
        if (target === CONFIG_KEY) {
          if (cmp.remoteConfig) {
            chainSync.confirmPull(CONFIG_KEY, cmp.remoteConfig);
          }
        } else {
          const doc = cmp.remoteShips.get(target);
          if (doc) {
            chainSync.confirmPull(target, doc);
          }
        }
      } else {
        // 用本地覆盖云端（强制推送该目标）。
        void chainSync.pushNow(true, target);
      }
    },
  });
}

// ── 环线执行进度（多船简化列表） ─────────────────────────────
function deriveChainRun(shipId: string): UserData.ChainRun | undefined {
  const ship = shipsStore.getById(shipId);
  if (!ship) {
    return undefined;
  }
  const shipName = sanitizeActName(ship.name ?? ship.registration) || ship.registration;
  const stopTriggers = userData.triggers
    .filter(
      t =>
        t.event.type === 'FLIGHT_ENDED' &&
        (t.packageName.endsWith(` Loop ${shipName}`) ||
          t.packageName.endsWith(` 环线 ${shipName}`)),
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  if (stopTriggers.length === 0) {
    return undefined;
  }
  const stops = stopTriggers.map(t => {
    const naturalId = t.event.type === 'FLIGHT_ENDED' ? t.event.planet : undefined;
    const site = naturalId ? sitesStore.getByPlanetNaturalId(naturalId) : undefined;
    return {
      naturalId: naturalId ?? '',
      planetName: site
        ? (getEntityNameFromAddress(site.address) ?? naturalId ?? t.packageName)
        : (naturalId ?? t.packageName),
      pkgName: t.packageName,
    };
  });
  const finalTrigger = userData.triggers.find(
    t =>
      t.event.type === 'FLIGHT_ENDED' &&
      (t.packageName.endsWith(`Chain Return ${shipName}`) ||
        t.packageName === `环线归航 ${shipName}`),
  );
  return {
    shipId: ship.id,
    shipName: ship.name ?? ship.registration,
    startedAt: stopTriggers[0]!.createdAt,
    // 归航触发器以出发地为 planet，取它作为出发地标记。
    originNaturalId:
      finalTrigger && finalTrigger.event.type === 'FLIGHT_ENDED'
        ? (finalTrigger.event.planet ?? '')
        : '',
    stops,
    finalPkgName: finalTrigger?.packageName,
  };
}

// 逆推：从操作包还原站点操作清单（无快照时——页面刷新 / 旧版本环线）。
// 已完成站的包已被 autoDelete 删除，无法还原（对应进度「完成」）。
function deriveStopOps(pkgName: string): {
  unload: Record<string, number>;
  load: Record<string, number>;
} {
  const pkg = userData.actionPackages.find(p => p.global.name === pkgName);
  return {
    unload: pkg?.groups.find(g => g.name === '卸货')?.materials ?? {},
    load: pkg?.groups.find(g => g.name === '提取')?.materials ?? {},
  };
}

// 归航卸货：从归航包（Chain Return 船名）的「卸货」组还原。
function deriveFinalOps(pkgName: string): Record<string, number> {
  const pkg = userData.actionPackages.find(p => p.global.name === pkgName);
  return pkg?.groups.find(g => g.name === '卸货')?.materials ?? {};
}

// 持久化快照 → 计划对象：页面刷新后仍按规划样式显示阶段操作与载重。
function chainPlanFromRun(run: UserData.ChainRun): ChainPlan | undefined {
  const snap = run.plan;
  if (snap === undefined) {
    return undefined;
  }
  const stops: ChainStopPlan[] = run.stops.map(s => {
    const unloadAt = s.plan?.unloadAt ?? {};
    const loadAt = s.plan?.loadAt ?? {};
    return {
      naturalId: s.naturalId,
      planetName: s.planetName,
      days: 0,
      cxBuy: false,
      unloadCx: unloadAt,
      unloadChain: new Map(),
      load: new Map(
        Object.entries(loadAt).map(([ticker, amount]) => [
          ticker,
          { amount, to: s.plan?.loadTo?.[ticker] ?? '' },
        ]),
      ),
      clipped: s.plan?.clipped ?? false,
      loadOnArrival: s.plan?.loadOnArrival ?? { weight: 0, volume: 0 },
      loadOnDeparture: s.plan?.loadOnDeparture ?? { weight: 0, volume: 0 },
    };
  });
  const cxBill: Record<string, number> = { ...snap.purchaseBill };
  for (const [ticker, amount] of Object.entries(snap.originPickup)) {
    cxBill[ticker] = (cxBill[ticker] ?? 0) + amount;
  }
  const loads = [snap.originLoadOnDeparture, ...stops.map(s => s.loadOnDeparture)];
  const peak = loads.reduce(
    (acc, l) => ({
      weight: Math.max(acc.weight, l.weight),
      volume: Math.max(acc.volume, l.volume),
    }),
    { weight: 0, volume: 0 },
  );
  return {
    originNaturalId: run.originNaturalId,
    stops,
    finalUnload: snap.finalUnload,
    cxBill,
    purchaseBill: snap.purchaseBill,
    originPickup: snap.originPickup,
    warnings: [],
    peakLoad: peak,
    freeCapacity: {
      weight: Math.max(0, snap.capacity.weight - peak.weight),
      volume: Math.max(0, snap.capacity.volume - peak.volume),
    },
    capacity: snap.capacity,
    loadOnDeparture: snap.originLoadOnDeparture,
    loadOnReturn: snap.loadOnReturn,
    overCapacity: false,
    finalUnloadNotes: snap.finalUnloadNotes,
  };
}

// 计算一批材料的重量/体积（用于从旧 ACT 包还原阶段载重）。
function materialsLoad(record: Record<string, number>) {
  let weight = 0;
  let volume = 0;
  for (const [ticker, amount] of Object.entries(record)) {
    const mat = materialsStore.getByTicker(ticker);
    if (mat) {
      weight += mat.weight * amount;
      volume += mat.volume * amount;
    }
  }
  return { weight, volume };
}

// 旧版/导入的环线记录没有 plan 快照时，从现有 ACT 包（主包/站点包/归航包）
// 反推一份计划载重快照，让「载重」列显示阶段载重而非实时舱载。
function buildPlanFromPackages(
  run: UserData.ChainRun,
): { plan: UserData.ChainRunPlan; stops: UserData.ChainRunStop[] } | undefined {
  const firstPkgName = run.stops[0]?.pkgName ?? '';
  const idx = firstPkgName.lastIndexOf(' Loop ');
  if (idx < 0) {
    return undefined;
  }
  const shipName = firstPkgName.slice(idx + ' Loop '.length);
  const mainPkg = userData.actionPackages.find(p => p.global.name.endsWith(`Chain ${shipName}`));
  const buyGroup = mainPkg?.groups.find(g => (g.name ?? '').startsWith('购买 '));
  const loadGroup = mainPkg?.groups.find(g => (g.name ?? '').startsWith('装载 '));
  const purchaseBill = buyGroup?.materials ?? {};
  const cxBill = loadGroup?.materials ?? {};
  const originPickup: Record<string, number> = {};
  for (const [ticker, amount] of Object.entries(cxBill)) {
    const pickup = amount - (purchaseBill[ticker] ?? 0);
    if (pickup > 0) {
      originPickup[ticker] = pickup;
    }
  }
  const finalPkg = run.finalPkgName
    ? userData.actionPackages.find(p => p.global.name === run.finalPkgName)
    : undefined;
  const finalUnload = finalPkg?.groups.find(g => g.name === '卸货')?.materials ?? {};
  // 旧版单船主包未写入 ACT 列表：用站点包「卸货」之和近似原始装载量。
  const fallbackBill: Record<string, number> = {};
  if (Object.keys(cxBill).length === 0) {
    for (const stop of run.stops) {
      const pkg = userData.actionPackages.find(p => p.global.name === stop.pkgName);
      const unload = pkg?.groups.find(g => g.name === '卸货')?.materials ?? {};
      for (const [ticker, amount] of Object.entries(unload)) {
        fallbackBill[ticker] = (fallbackBill[ticker] ?? 0) + amount;
      }
    }
    for (const [ticker, amount] of Object.entries(finalUnload)) {
      fallbackBill[ticker] = (fallbackBill[ticker] ?? 0) + amount;
    }
  }
  const originBill = Object.keys(cxBill).length > 0 ? cxBill : fallbackBill;
  const ship = shipsStore.getById(run.shipId);
  const cargo = ship ? storagesStore.getById(ship.idShipStore) : undefined;
  const capacity = cargo
    ? { weight: cargo.weightCapacity, volume: cargo.volumeCapacity }
    : { weight: 0, volume: 0 };
  let current = materialsLoad(originBill);
  const stops: UserData.ChainRunStop[] = run.stops.map((stop, i) => {
    if (stop.plan !== undefined) {
      return stop;
    }
    const pkg = userData.actionPackages.find(p => p.global.name === stop.pkgName);
    const unload = pkg?.groups.find(g => g.name === '卸货')?.materials ?? {};
    const load = pkg?.groups.find(g => g.name === '提取')?.materials ?? {};
    const unloadLoad = materialsLoad(unload);
    const loadLoad = materialsLoad(load);
    const next = run.stops[i + 1]?.planetName ?? run.originNaturalId;
    const loadOnArrival = {
      weight: Math.max(0, current.weight - unloadLoad.weight),
      volume: Math.max(0, current.volume - unloadLoad.volume),
    };
    current = {
      weight: loadOnArrival.weight + loadLoad.weight,
      volume: loadOnArrival.volume + loadLoad.volume,
    };
    const loadTo: Record<string, string> = {};
    for (const ticker of Object.keys(load)) {
      loadTo[ticker] = next;
    }
    return {
      ...stop,
      plan: {
        unloadAt: unload,
        loadAt: load,
        loadTo,
        loadOnArrival,
        loadOnDeparture: current,
        clipped: false,
      },
    };
  });
  return {
    plan: {
      capacity,
      originLoadOnDeparture: materialsLoad(originBill),
      loadOnReturn: current,
      purchaseBill,
      originPickup,
      finalUnload,
    },
    stops,
  };
}

// 出发行采购：从主包（Chain 船名）的「购买」组还原。
// 主包名由站点包名反推（取最后一个「 Loop 」之后的部分作为船名）。
function derivePurchaseBill(stopPkgName: string): Record<string, number> {
  const idx = stopPkgName.lastIndexOf(' Loop ');
  if (idx < 0) {
    return {};
  }
  const shipName = stopPkgName.slice(idx + ' Loop '.length);
  const mainPkg = userData.actionPackages.find(p => p.global.name.endsWith(`Chain ${shipName}`));
  return mainPkg?.groups.find(g => (g.name ?? '').startsWith('购买 '))?.materials ?? {};
}

type StopState = UserData.ChainRunStopState;

function stopMarker(state: StopState) {
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

function markClassKey(state: StopState): string {
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

interface RunProgress {
  originNaturalId: string;
  stops: { naturalId: string; planetName: string; state: StopState }[];
  done: number;
  total: number;
  originState: StopState;
  finalState: StopState;
}

// 单船各站状态：与执行前一致，沿「origin → 各站 → origin」给出每站进度。
// 新版本将状态持久化到 chainRuns：删除 ACT/触发器后列表仍能展示站点与操作；
// 旧记录（无持久化状态）回退到「包消失 = 完成」的推导。
// 是否已完成（全部站点 + 归航完成）：状态列表据此显示「已完成」标记。
function isRunFinished(sp: { progress?: RunProgress }): boolean {
  return (
    sp.progress !== undefined &&
    sp.progress.finalState === 'done' &&
    sp.progress.done >= sp.progress.total
  );
}

// 空间站 naturalId → 所属系统 naturalId（空间站地址被 AddressSelector 规范化为系统，
// 归航/飞往空间站的航段比较需先解析到系统）。
function stationSystemOf(naturalId: string): string | undefined {
  const station = stationsStore.getByNaturalId(naturalId);
  if (!station) {
    return undefined;
  }
  return getSystemLineFromAddress(station.address)?.entity.naturalId;
}

function runProgress(run: UserData.ChainRun): RunProgress {
  const ship = shipsStore.getById(run.shipId);
  const flight = ship?.flightId ? flightsStore.getById(ship.flightId) : undefined;
  const flightDest = flight ? getEntityNaturalIdFromAddress(flight.destination) : undefined;
  const dockedAt = ship?.address ? getEntityNaturalIdFromAddress(ship.address) : undefined;
  // 环线按序执行：船已通过（停靠或飞行途中的目标站）之前的所有站必然已执行完成。
  // 中断恢复后船可能已在途（正飞往后续站），上一站状态可能未持久化为 done——
  // 按停靠位置（dockedAt）或飞行目的站（flightDest）前推为完成。
  const stopIndexAt = (id: string | undefined) =>
    id === undefined ? -1 : run.stops.findIndex(s => s.naturalId === id);
  const dockedStopIndex = stopIndexAt(dockedAt);
  // 归航在途：飞行目的地是出发地（空间站地址可能被规范化为系统，按归属系统比较）。
  const homeward =
    flightDest !== undefined &&
    (flightDest.toUpperCase() === run.originNaturalId.toUpperCase() ||
      (stationSystemOf(run.originNaturalId) ?? '').toUpperCase() === flightDest.toUpperCase());
  // 已通过前缀终点（不含该站本身）：停靠站 > 在途目的站 > 归航（全部站）。
  const passedUpTo =
    dockedStopIndex >= 0 ? dockedStopIndex : homeward ? run.stops.length : stopIndexAt(flightDest);
  const stops = run.stops.map((stop, i) => {
    const pkgExists = userData.actionPackages.some(p => p.global.name === stop.pkgName);
    const fired = (userData.triggers.find(t => t.packageName === stop.pkgName)?.runCount ?? 0) > 0;
    let state: StopState;
    if (stop.state === 'done' || (passedUpTo >= 0 && i < passedUpTo)) {
      state = 'done';
    } else if (dockedAt === stop.naturalId || (pkgExists && fired)) {
      state = 'arrived';
    } else if (flightDest === stop.naturalId) {
      state = 'transit';
    } else if (stop.state !== undefined) {
      // 持久化状态优先：删除 ACT/触发器不会把未完成站误判为「完成」。
      state = stop.state;
    } else if (!pkgExists) {
      state = 'done';
    } else {
      state = 'pending';
    }
    return { naturalId: stop.naturalId, planetName: stop.planetName, state };
  });
  const done = stops.filter(s => s.state === 'done').length;
  const allStopsDone = stops.every(s => s.state === 'done');
  const originState: StopState =
    run.originState === 'done' || (stops.length > 0 && stops[0]!.state !== 'pending')
      ? 'done'
      : 'pending';
  const finalPkgExists =
    run.finalPkgName !== undefined &&
    userData.actionPackages.some(p => p.global.name === run.finalPkgName);
  let finalState: StopState;
  if (run.finalState === 'done') {
    finalState = 'done';
  } else if (allStopsDone) {
    if (dockedAt === run.originNaturalId) {
      // 新记录保留持久化状态（避免删除归航包被误判完成）；旧记录按原逻辑处理。
      finalState = run.finalState === undefined ? (finalPkgExists ? 'arrived' : 'done') : 'arrived';
    } else if (homeward) {
      // 归航在途：目的地为出发地（空间站地址可能被规范化为系统）。
      finalState = 'transit';
    } else {
      finalState = run.finalState ?? 'pending';
    }
  } else {
    finalState = run.finalState ?? 'pending';
  }
  return {
    originNaturalId: run.originNaturalId,
    stops,
    done,
    total: stops.length,
    originState,
    finalState,
  };
}

const activeRuns = computed(() => {
  const result: { shipId: string; run: UserData.ChainRun; progress: RunProgress }[] = [];
  // 主：执行中的环线记录。不限于「可分配船只」——船 DEPART 后离开空间站，
  // 已不在 ships props / eligibleShips 中，只要船仍存在就持续显示进度。
  for (const run of Object.values(userData.chainRuns)) {
    if (shipsStore.getById(run.shipId) === undefined) {
      continue;
    }
    result.push({ shipId: run.shipId, run, progress: runProgress(run) });
  }
  // 兜底：从触发器推导环线（旧版本执行 / chainRuns 记录丢失时）。
  // 遍历全部船而非仅选中船——执行中的船已不在 CX，selectedShips 为空。
  for (const ship of shipsStore.all.value ?? []) {
    if (result.some(x => x.shipId === ship.id)) {
      continue;
    }
    const run = deriveChainRun(ship.id);
    if (run === undefined) {
      continue;
    }
    const progress = runProgress(run);
    // 全部站点与归航包都完成后视为已结束，不再显示（避免占用进度区）。
    if (progress.done >= progress.total) {
      const finalDone =
        run.finalPkgName === undefined ||
        !userData.actionPackages.some(p => p.global.name === run.finalPkgName);
      if (finalDone) {
        continue;
      }
    }
    result.push({ shipId: ship.id, run, progress });
  }
  return result;
});

// 各船环线进度索引（按 shipId）。
const progressByShip = computed(() => {
  const map = new Map<string, RunProgress>();
  for (const entry of activeRuns.value) {
    map.set(entry.shipId, entry.progress);
  }
  return map;
});

// 飞行时间 watch（依赖 activeRuns，需在 activeRuns 之后注册）。
registerFlightTimeWatch();

// 把推导出的进度状态持久化到 chainRuns：列表全局状态与 ACT/触发器解耦，
// 删除 ACT 脚本或触发器后，站点与操作内容仍能完整展示。
watchEffect(() => {
  for (const run of Object.values(userData.chainRuns)) {
    const progress = runProgress(run);
    if (run.originState !== progress.originState) {
      run.originState = progress.originState;
    }
    if (run.finalState !== progress.finalState) {
      run.finalState = progress.finalState;
    }
    for (let i = 0; i < run.stops.length; i++) {
      const stop = run.stops[i]!;
      const state = progress.stops[i]!.state;
      if (stop.state !== state) {
        stop.state = state;
      }
    }
  }
});

// 兜底：逆推出的旧版环线记录直接持久化，删除触发器后站点列表不再丢失。
watchEffect(() => {
  for (const ship of shipsStore.all.value ?? []) {
    if (userData.chainRuns[ship.id] !== undefined) {
      continue;
    }
    const derived = deriveChainRun(ship.id);
    if (derived === undefined) {
      continue;
    }
    const progress = runProgress(derived);
    const finished = progress.finalState === 'done' && progress.done >= progress.total;
    if (!finished) {
      userData.chainRuns[ship.id] = derived;
    }
  }
});

// 旧版/导入记录无 plan 快照时，从现有 ACT 包反推并持久化计划载重，
// 使「载重」列显示阶段载重而不是实时舱载。
watchEffect(() => {
  for (const run of Object.values(userData.chainRuns)) {
    if (run.plan !== undefined) {
      continue;
    }
    const built = buildPlanFromPackages(run);
    if (built === undefined) {
      continue;
    }
    // 舱容数据未加载前不落盘，等数据就绪后再重建（避免 0 容量占位）。
    if (built.plan.capacity.weight <= 0 && built.plan.capacity.volume <= 0) {
      continue;
    }
    run.plan = built.plan;
    for (let i = 0; i < run.stops.length; i++) {
      const stopPlan = built.stops[i]?.plan;
      if (stopPlan !== undefined) {
        run.stops[i]!.plan = stopPlan;
      }
    }
  }
});

type ChainTableRow = {
  shipId: string;
  ship?: DispatchShip;
  shipName?: string;
  plan?: ChainPlan;
  progress?: RunProgress;
  // 无快照时的逆推操作（页面刷新 / 旧版本环线）。
  derivedStops?: { unload: Record<string, number>; load: Record<string, number> }[];
  derivedPurchase?: Record<string, number>;
  derivedFinal?: Record<string, number>;
};

// 「规划中」页签：当前选中配置的实时规划（跳过运行中的船，避免同船重复），
// 有环线运行中仍可规划其他环线。
const planTables = computed<ChainTableRow[]>(() => {
  const runningIds = new Set(activeRuns.value.map(e => e.shipId));
  return shipPlans.value
    .filter(sp => !runningIds.has(sp.ship.ship.id))
    .map(sp => ({ shipId: sp.ship.ship.id, ship: sp.ship, plan: sp.plan, progress: undefined }));
});

// 「运行中」页签：正在执行的环线（进度），优先计划快照，快照未覆盖的
// （刷新后 / 旧版本）从 chainRuns 还原。
const runningTables = computed<ChainTableRow[]>(() => {
  const result: ChainTableRow[] = [];
  const snapshotIds = new Set<string>();
  for (const sp of planSnapshot.value) {
    const progress = progressByShip.value.get(sp.ship.ship.id);
    if (progress === undefined) {
      continue;
    }
    snapshotIds.add(sp.ship.ship.id);
    result.push({ shipId: sp.ship.ship.id, ship: sp.ship, plan: sp.plan, progress });
  }
  for (const entry of activeRuns.value) {
    if (snapshotIds.has(entry.shipId)) {
      continue;
    }
    // 新版本环线：持久化计划快照可完整还原阶段载重/操作。
    const plan = chainPlanFromRun(entry.run);
    if (plan) {
      result.push({
        shipId: entry.shipId,
        shipName: entry.run.shipName,
        plan,
        progress: entry.progress,
      });
      continue;
    }
    // 旧版本环线（无快照）：退回逆推模式，载重列显示实时舱载。
    result.push({
      shipId: entry.shipId,
      shipName: entry.run.shipName,
      progress: entry.progress,
      derivedStops: entry.run.stops.map(stop => deriveStopOps(stop.pkgName)),
      derivedPurchase:
        entry.run.stops.length > 0 ? derivePurchaseBill(entry.run.stops[0]!.pkgName) : {},
      derivedFinal: entry.run.finalPkgName ? deriveFinalOps(entry.run.finalPkgName) : {},
    });
  }
  return result;
});

// 规划中 / 运行中 分页：页签状态（跨面板重挂载保持），当前可见表格。
const chainTab = useTileState<'plan' | 'running'>('chainTab', 'plan');
const chainTabs = computed(() => [
  { id: 'plan' as const, label: '规划中', count: planTables.value.length },
  { id: 'running' as const, label: '运行中', count: runningTables.value.length },
]);
const visibleTables = computed<ChainTableRow[]>(() =>
  chainTab.value === 'plan' ? planTables.value : runningTables.value,
);

// 环线运行记录保留策略：遍历全部 chainRuns（不限于当前选中的船）。
// 完成的环线（含归航卸载）不再自动清理，保留在状态列表显示「完成」；
// 孤立的预留列表（ACT 脚本与触发器已全部删除且非完成态）直接移除，
// 避免导入旧 JSON 后删除全部脚本/触发器时残留空列表。
watchEffect(() => {
  for (const [shipId, run] of Object.entries(userData.chainRuns)) {
    const progress = runProgress(run);
    const hasAnyScript =
      (run.mainPkgName !== undefined &&
        (userData.actionPackages.some(p => p.global.name === run.mainPkgName) ||
          userData.triggers.some(t => t.packageName === run.mainPkgName))) ||
      run.stops.some(
        s =>
          userData.actionPackages.some(p => p.global.name === s.pkgName) ||
          userData.triggers.some(t => t.packageName === s.pkgName),
      ) ||
      (run.finalPkgName !== undefined &&
        (userData.actionPackages.some(p => p.global.name === run.finalPkgName) ||
          userData.triggers.some(t => t.packageName === run.finalPkgName)));
    const finished = progress.finalState === 'done' && progress.done >= progress.total;
    if (!hasAnyScript) {
      // 正常完成的运行保留展示（状态列表显示「完成」）；孤立的预留列表立即移除。
      const completedNewRun =
        run.mainPkgName !== undefined &&
        run.originState === 'done' &&
        run.finalState === 'done' &&
        progress.done >= progress.total;
      if (completedNewRun) {
        continue;
      }
      delete userData.chainRuns[shipId];
      clearFinishedCleanup(shipId);
      continue;
    }
    if (finished) {
      // 完成：保留在状态列表，显示「完成」。
      continue;
    }
    clearFinishedCleanup(shipId);
  }
  // 没有运行记录时清空计划快照，避免残留旧数据影响下次规划。
  if (Object.keys(userData.chainRuns).length === 0) {
    planSnapshot.value = [];
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

// 逆推模式（无计划快照）的载重列：显示船当前实时舱载。
// Ship 本身不含货舱数据，需经 idShipStore 从 storagesStore 取 SHIP_STORE。
function liveLoadText(shipId: string): string {
  const ship = shipsStore.getById(shipId);
  if (!ship) {
    return '';
  }
  const cargo = storagesStore.getById(ship.idShipStore);
  if (!cargo) {
    return '';
  }
  return formatLoadCell(
    { weight: cargo.weightLoad, volume: cargo.volumeLoad },
    { weight: cargo.weightCapacity, volume: cargo.volumeCapacity },
  );
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

// 当前船是否正在飞向 legIndex 对应的目的地（transit 状态）。
// 船当前 Flight 的 destination 与环线该段终点一致时，即为该段在途。
function legInTransit(shipId: string, legIndex: number): boolean {
  const ship = shipsStore.getById(shipId);
  if (!ship?.flightId) {
    return false;
  }
  const flight = flightsStore.getById(ship.flightId);
  if (!flight) {
    return false;
  }
  const destNaturalId = getEntityNaturalIdFromAddress(flight.destination) ?? '';
  const est = flightEstimates.value.get(shipId);
  const leg = est?.legs[legIndex];
  if (!leg) {
    return false;
  }
  if (leg.to.toUpperCase() === destNaturalId.toUpperCase()) {
    return true;
  }
  // 空间站地址被 AddressSelector 规范化为系统地址：飞往空间站（如归航回 HRT）
  // 的航段 leg.to（空间站 naturalId）无法与目的地系统 naturalId 直接匹配，
  // 用空间站所属系统判断。
  const station = stationsStore.getByNaturalId(leg.to);
  if (station) {
    const stationSystem = getSystemLineFromAddress(station.address)?.entity.naturalId;
    return (
      stationSystem !== undefined && stationSystem.toUpperCase() === destNaturalId.toUpperCase()
    );
  }
  return false;
}

// 中文精确时长（≥1 天 天/时/分；<1 天 时/分/秒），与 FTC 面板口径一致。
function formatFlightDuration(ms: number): string {
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

// 各段飞行列文本（模板「飞行」列）：
// - 已完成阶段 → 「已完成」；
// - 在途阶段 → 真实剩余时间 + 真实到达时间（HH:MM 到达）；
// - 其余阶段 → 预估飞行时间（预估到达时间）。
function flightCellText(
  sp: { shipId: string; plan?: ChainPlan; progress?: RunProgress },
  legIndex: number,
): string {
  // 已完成（含归航段）。
  const p = sp.progress;
  if (p !== undefined) {
    const n = sp.plan?.stops.length ?? p.stops.length;
    const done = legIndex < n ? p.stops[legIndex]?.state === 'done' : p.finalState === 'done';
    if (done) {
      return ' 已完成';
    }
  }
  // 在途：真实剩余时间与真实到达时间。
  // 仅执行中的环线（有 progress）显示在途——规划中的环线即使船当前恰好在飞，
  // 那是另一个环线的真实飞行，混入会把预估时间覆盖成错误的时间。
  if (sp.progress !== undefined && legInTransit(sp.shipId, legIndex)) {
    const ship = shipsStore.getById(sp.shipId);
    const flight = ship?.flightId ? flightsStore.getById(ship.flightId) : undefined;
    if (flight) {
      const remainMs = Math.max(flight.arrival.timestamp - gameNow(), 0);
      return ` 剩余 ${formatFlightDuration(remainMs)}（${arrivalClockText(flight.arrival.timestamp)}到达）`;
    }
  }
  // 预估：飞行时间（预计到达时间）。
  const leg = flightLegFor(sp.shipId, legIndex);
  if (!leg) {
    return '';
  }
  if (!leg.ok) {
    return leg.error ? `（${leg.error}）` : '';
  }
  return ` · ${formatFlightDuration(leg.hours * 3600000)}（${arrivalClockText(leg.arriveAtMs)}到达）`;
}

// 环线总飞行时长文本。
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
    <div :class="[C.ComExOrdersPanel.filter, $style.filterBar]">
      <SelectInput v-model="groupSelect" :options="groupOptions" :width="220" />
      <div :class="$style.separator" />
      <RadioItem v-model="chainAutoLaunch" horizontal>自动发船</RadioItem>
      <RadioItem v-model="chainAutoTrigger" horizontal>自动执行</RadioItem>
      <RadioItem v-model="chainAutoRecover" horizontal>自动恢复</RadioItem>
      <div :class="$style.separator" />
      <PrunButton dark @click="onStatusCheckClick">状态检查</PrunButton>
      <div :class="$style.separator" />
      <PrunButton dark :disabled="chainSyncState.syncing" @click="onChainSyncClick($event)"
        >云端同步</PrunButton
      >
      <span :class="$style.syncState" :title="chainSyncState.error ?? ''">{{ syncStateText }}</span>
      <div :class="$style.spacer" />
      <Tooltip v-if="executeTooltip" position="top" :tooltip="executeTooltip" no-icon>
        <PrunButton primary :disabled="!hasStops" @click="execute">执行环线</PrunButton>
      </Tooltip>
      <PrunButton v-else primary :disabled="!hasStops" @click="execute">执行环线</PrunButton>
    </div>

    <!-- 分组内基地勾选 -->
    <div
      v-if="chainGroup && groupBases.length > 0"
      :class="[C.ComExOrdersPanel.filter, $style.filterBar]">
      <span :class="$style.barLabel">基地</span>
      <RadioItem
        v-for="base in groupBases"
        :key="base.naturalId"
        :model-value="selectedBaseIds.includes(base.naturalId)"
        horizontal
        @update:model-value="selected => setBaseSelected(base.naturalId, selected)">
        {{ base.planetName || base.naturalId }}
      </RadioItem>
      <div :class="$style.separator" />
      <PrunButton dark @click="selectAllBases">全选</PrunButton>
      <PrunButton dark @click="clearAllBases">清空</PrunButton>
    </div>

    <!-- 分配船只（多选） -->
    <div
      v-if="selectedBases.length > 0 && eligibleShips.length > 0"
      :class="[C.ComExOrdersPanel.filter, $style.filterBar]">
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

    <div v-if="executeNotice" :class="$style.notice">{{ executeNotice }}</div>
    <div v-if="statusCheckNotice" :class="$style.notice">{{ statusCheckNotice }}</div>
    <div v-if="syncNotice" :class="$style.notice">{{ syncNotice }}</div>

    <!-- 规划中 / 运行中 分页：有运行中环线时仍可规划其他环线，两页独立查看。 -->
    <div v-if="activeRuns.length > 0 || shipPlans.length > 0" :class="$style.content">
      <div :class="C.Tabs.component">
        <div :class="C.Tabs.tabs">
          <div v-for="t in chainTabs" :key="t.id" :class="C.Tabs.header" @click="chainTab = t.id">
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

      <div v-for="sp in visibleTables" :key="sp.shipId" :class="$style.shipPlan">
        <div :class="$style.shipHeader">
          <span>
            {{ sp.ship ? shipLabel(sp.ship) : (sp.shipName ?? '') }}
            <template v-if="sp.progress">
              <span v-if="isRunFinished(sp)" :class="$style.finished">（已完成）</span>
              <span v-else :class="$style.running">（运行中）</span>
            </template>
            <template v-else>（{{ sp.ship?.exchangeCode ?? '' }}）</template>
          </span>
          <PrunButton v-if="sp.progress" dark @click="onClearShipPlanClick($event, sp)"
            >清理计划</PrunButton
          >
        </div>
        <div :class="$style.route">
          <span :class="$style.routeLabel">航线：</span>
          <span :class="$style.routeOrigin">{{
            sp.plan?.originNaturalId ?? sp.progress?.originNaturalId
          }}</span>
          <template
            v-for="stop in sp.plan?.stops ?? sp.progress?.stops ?? []"
            :key="stop.naturalId">
            <span :class="$style.routeArrow">→</span>
            <span :class="$style.routeNode">{{ stop.planetName }}</span>
          </template>
          <span :class="$style.routeArrow">→</span>
          <span :class="$style.routeOrigin">{{
            sp.plan?.originNaturalId ?? sp.progress?.originNaturalId
          }}</span>
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
              <td :class="$style.narrowCol">
                <span
                  v-if="sp.progress?.originState"
                  :class="[$style.marker, $style[markClassKey(sp.progress.originState)]]"
                  >{{ stopMarker(sp.progress.originState) }}</span
                >
                0
              </td>
              <td :class="$style.narrowCol">
                <span :class="$style.routeOrigin">{{
                  sp.plan?.originNaturalId ?? sp.progress?.originNaturalId
                }}</span>
              </td>
              <td :class="$style.matCell">
                <template v-if="sp.plan">
                  <div>
                    <span :class="$style.opsLabel">采购</span>
                    [{{ formatMaterials(sp.plan.purchaseBill) || '无' }}]
                  </div>
                  <div>
                    <span :class="$style.opsLabel">取货</span>
                    [{{ formatMaterials(spaceStationTake(sp.plan)) || '无' }}]
                  </div>
                </template>
                <template v-else-if="sp.derivedPurchase">
                  <div>
                    <span :class="$style.opsLabel">采购</span>
                    [{{ formatMaterials(sp.derivedPurchase) || '无' }}]
                  </div>
                </template>
                <span v-else>—</span>
              </td>
              <td :class="$style.matCell">出发</td>
              <td :class="$style.narrowCol">
                <template v-if="sp.plan">
                  {{ formatLoadCell(sp.plan.loadOnDeparture, sp.plan.capacity) }}
                </template>
                <template v-else-if="liveLoadText(sp.shipId)">
                  实时 {{ liveLoadText(sp.shipId) }}
                </template>
                <span v-else>—</span>
              </td>
            </tr>
            <tr
              v-for="(stop, i) in sp.plan?.stops ?? sp.progress?.stops ?? []"
              :key="stop.naturalId">
              <td :class="$style.narrowCol">
                <span
                  v-if="sp.progress?.stops[i]"
                  :class="[$style.marker, $style[markClassKey(sp.progress.stops[i].state)]]">
                  {{ stopMarker(sp.progress.stops[i].state) }}
                </span>
                {{ i + 1 }}
              </td>
              <td :class="$style.narrowCol">{{ stop.planetName }}</td>
              <td :class="$style.matCell">
                <template v-if="sp.plan">
                  <div>
                    <span :class="$style.opsLabel">卸货</span>
                    [{{ formatUnloadAt(sp.plan.stops[i]) || '无' }}]
                  </div>
                  <div>
                    <span :class="$style.opsLabel">取货</span>
                    [{{ formatLoad(sp.plan.stops[i]) || '无' }}]
                  </div>
                  <span v-if="sp.plan.stops[i].clipped" :class="$style.opsWarn">（限载缩减）</span>
                </template>
                <template v-else-if="sp.derivedStops">
                  <div>
                    <span :class="$style.opsLabel">卸货</span>
                    [{{ formatMaterials(sp.derivedStops[i].unload) || '无' }}]
                  </div>
                  <div>
                    <span :class="$style.opsLabel">取货</span>
                    [{{ formatMaterials(sp.derivedStops[i].load) || '无' }}]
                  </div>
                </template>
                <span v-else>—</span>
              </td>
              <td :class="$style.matCell">
                <template v-if="sp.plan">
                  → {{ sp.plan.stops[i]?.planetName ?? sp.plan.originNaturalId
                  }}{{ flightCellText(sp, i) }}
                </template>
                <template v-else-if="sp.progress">
                  → {{ sp.progress.stops[i]?.planetName ?? sp.progress.originNaturalId
                  }}{{ flightCellText(sp, i) }}
                </template>
                <span v-else>—</span>
              </td>
              <td :class="$style.narrowCol">
                <template v-if="sp.plan">
                  <div>{{
                    formatLoadCell(sp.plan.stops[i].loadOnDeparture, sp.plan.capacity)
                  }}</div>
                  <div :class="$style.loadSub">{{ formatLoadDelta(sp.plan.stops[i]) }}</div>
                </template>
                <template v-else-if="liveLoadText(sp.shipId)">
                  实时 {{ liveLoadText(sp.shipId) }}
                </template>
                <span v-else>—</span>
              </td>
            </tr>
            <tr>
              <td :class="$style.narrowCol">
                <span
                  v-if="sp.progress?.finalState"
                  :class="[$style.marker, $style[markClassKey(sp.progress.finalState)]]"
                  >{{ stopMarker(sp.progress.finalState) }}</span
                >
                {{ (sp.plan?.stops.length ?? sp.progress?.stops.length ?? 0) + 1 }}
              </td>
              <td :class="$style.narrowCol">
                <span :class="$style.routeOrigin">{{
                  sp.plan?.originNaturalId ?? sp.progress?.originNaturalId
                }}</span>
              </td>
              <td :class="$style.matCell">
                <template v-if="sp.plan">
                  <div>
                    <span :class="$style.opsLabel">卸货</span>
                    [{{ formatMaterials(sp.plan.finalUnload) || '无' }}]
                  </div>
                </template>
                <template v-else-if="sp.derivedFinal">
                  <div>
                    <span :class="$style.opsLabel">卸货</span>
                    [{{ formatMaterials(sp.derivedFinal) || '无' }}]
                  </div>
                </template>
                <span v-else>—</span>
              </td>
              <td :class="$style.matCell">
                <template v-if="sp.plan">
                  → {{ sp.plan.originNaturalId }}{{ flightCellText(sp, sp.plan.stops.length) }}
                </template>
                <template v-else-if="sp.progress">
                  → {{ sp.progress.originNaturalId
                  }}{{ flightCellText(sp, sp.progress.stops.length) }}
                </template>
                <span v-else>归航</span>
              </td>
              <td :class="$style.narrowCol">
                <template v-if="sp.plan">
                  {{ formatLoadCell({ weight: 0, volume: 0 }, sp.plan.capacity) }}
                </template>
                <template v-else-if="liveLoadText(sp.shipId)">
                  实时 {{ liveLoadText(sp.shipId) }}
                </template>
                <span v-else>—</span>
              </td>
            </tr>
          </tbody>
        </table>

        <!-- 执行中且无计划快照（旧版本环线 / 逆推模式）时仅显示飞行时长汇总。
             完整装船/采购/舱容等汇总依赖 sp.plan，留给有快照的表格行展示。 -->
        <div v-if="!sp.plan && sp.progress" :class="$style.summary">
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">飞行时长：</span>
            <span>
              <template v-if="flightTimesLoading">计算中…</template>
              <template v-else>{{ flightTotalText(sp.shipId) || '--' }}</template>
            </span>
          </div>
        </div>
        <div v-if="sp.plan" :class="$style.summary">
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">飞行时长：</span>
            <span>
              <template v-if="flightTimesLoading">计算中…</template>
              <template v-else>{{ flightTotalText(sp.shipId) || '--' }}</template>
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

      <div v-if="chainTab === 'plan' && unusedShipCount > 0" :class="$style.notice">
        已忽略 {{ unusedShipCount }} 艘未参与分配的船。
      </div>
      <div v-if="visibleTables.length === 0" :class="$style.hint">
        {{
          chainTab === 'plan'
            ? '当前没有可执行的规划。请在上方选择分组、基地与船只后点击「执行环线」。'
            : '当前没有运行中的环线。'
        }}
      </div>
    </div>

    <template v-else>
      <div v-if="!chainGroup" :class="$style.hint">
        选择一个产业链分组（在 BSN 面板为基地标注分组），分组内的基地将作为环线站点。
      </div>
      <div v-else-if="groupBases.length === 0" :class="$style.hint">
        该分组下没有基地。请在 BSN 面板的「供应链分组」列为基地录入此分组名。
      </div>
      <div v-else-if="selectedBases.length === 0" :class="$style.hint">请勾选参与环线的基地。</div>
      <div v-else-if="eligibleShips.length === 0" :class="$style.hint">
        没有停靠 CX 且有仓库/货舱的可用船只。
      </div>
      <div v-else-if="selectedShips.length === 0" :class="$style.hint">请分配至少一艘船。</div>
      <LoadingSpinner v-else-if="loading" />
    </template>
  </div>
</template>

<style module>
.layout {
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  width: 100%;
  min-height: 0;
  flex: 1 1 auto;
  overflow: auto;
}

.filterBar {
  flex-wrap: wrap;
}

.filterBar :global(.SelectInput__container) {
  margin: 0;
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

.syncState {
  color: #8a9aa8;
  font-size: 11px;
  white-space: nowrap;
  align-self: center;
  margin-left: 0.25rem;
}

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

.content {
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
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

.routeNode {
  color: rgb(171, 198, 128);
}

.routeOrigin {
  color: rgb(63, 162, 222);
}

.routeArrow {
  color: #8a9aa8;
}

.table {
  border-collapse: collapse;
  width: 100%;
  /* 固定列宽：所有船的进度表保持同一列宽，避免按内容自适应导致宽度不一致。 */
  table-layout: fixed;
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
  /* 固定列宽后允许换行，避免超长星球名/载重文本溢出。 */
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
  font-size: 10px;
}

.loadSub {
  font-size: 10px;
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
  color: #e8a33d;
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

.finished {
  color: #5cb85c;
  font-size: 11px;
  margin-left: 0.5rem;
}

.running {
  color: #f0ad4e;
  font-size: 11px;
  margin-left: 0.5rem;
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
