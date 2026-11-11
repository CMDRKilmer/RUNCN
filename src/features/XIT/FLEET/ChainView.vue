<script setup lang="ts">
import {
  deriveStopOps,
  deriveFinalOps,
  chainPlanFromRun,
  derivePurchaseBill,
  isRunFinished,
  getActiveChainRuns,
  type RunProgress,
} from './chain-run';
import { executeChainPlans, clearShipChainPlan } from './chain-commands';
import { useChainRecovery } from './use-chain-recovery';
import PrunButton from '@src/components/PrunButton.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import Tooltip from '@src/components/Tooltip.vue';
import BaseAlias from '@src/components/BaseAlias.vue';
import RadioItem from '@src/components/forms/RadioItem.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import { useChainPlanning } from './use-chain-planning';
import { shipLabel, formatFlightDuration } from './chain-format';
import { sanitizeActName } from './chain-identity';
import type { ShipChainPlan } from './chain-allocation';
import type { ChainPlannerBase, ChainPlan, ChainStopPlan } from './chain-types';
import type { ChainFlightLeg } from './chain-flight-time';
import { billTotals, type DispatchShip } from '@src/features/XIT/FLEET/utils';
import { getBaseGroups } from '@src/core/base-groups';
import { useTileState } from '@src/store/user-data-tiles';
import { userData } from '@src/store/user-data';

import { showTileOverlay, showConfirmationOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import ChainSyncDialog from '@src/features/XIT/FLEET/ChainSyncDialog.vue';
import { getFleetRuntime } from './chain-runtime';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { stationsStore } from '@src/infrastructure/prun-api/data/stations';
import {
  getEntityNaturalIdFromAddress,
  getSystemLineFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
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

const activeRuns = computed(() => getActiveChainRuns());

const {
  flightEstimates,
  flightTimesLoading,
  usableChainShips,
  allocStatus,
  timeAlloc,
  shipPlans,
  loading,
  hasStops,
  unusedShipCount,
  allocBanner,
  filteredStopNotices,
} = useChainPlanning({
  ships: () => selectedShips.value,
  bases: () => selectedBases.value,
  runs: () => activeRuns.value,
});

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

const executeNotice = ref<string | undefined>(undefined);
// 状态检查结果提示：环线运行中网页关闭导致到港触发器错过时，提示自动恢复情况。

// 执行时的计划快照：环线执行中船离港后 shipPlans 为空，
// 用快照保持「与规划一致」的表格显示，仅在序列叠加进度图标。
// 快照同时持久化到 chainRuns.plan，页面刷新后仍可显示阶段载重。
const planSnapshot = ref<ShipChainPlan[]>([]);

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
      clearShipChainPlan(sp.shipId, shipName);
      planSnapshot.value = planSnapshot.value.filter(p => p.ship.ship.id !== sp.shipId);
      statusCheckNotice.value = `已清理 ${label} 的环线计划及 ACT 脚本/触发器。`;
      // 删除传播：清掉 chainRuns 后粗粒度 watch 不再标脏该船（它已不在
      // chainRuns 键里），显式标脏以把「空快照」推上云端，清除远端陈旧记录。
    },
    { message: `删除 ${label} 的环线计划及其 ACT 脚本/触发器？`, confirmLabel: '删除' },
  );
}

function execute() {
  const allPlans = shipPlans.value;
  if (allPlans.length === 0) {
    return;
  }
  // 时间均衡分段计算中：此时 shipPlans 还是舱容贪心（未充分利用多船）。
  // 等预估完成自动切换到更快的时间均衡分段后再执行，避免按旧切法生成包。
  if (allocStatus.value === 'computing' && usableChainShips.value.length > 1) {
    executeNotice.value =
      '正在按飞行时长均衡分配船只（预估各船环线时长）… 就绪后会自动切换到更快的时间均衡分段，请稍候再执行。';
    return;
  }
  const result = executeChainPlans(allPlans, {
    autoLaunch: chainAutoLaunch.value,
    autoTrigger: chainAutoTrigger.value,
  });
  if (result.notice !== undefined) {
    executeNotice.value = result.notice;
  }
  if (result.plans.length > 0) {
    planSnapshot.value = [
      ...planSnapshot.value.filter(x => !result.plans.some(p => p.ship.ship.id === x.ship.ship.id)),
      ...result.plans,
    ];
  }
}

const { statusCheckNotice, onStatusCheckClick } = useChainRecovery(() => chainAutoRecover.value);

const { chainSync, syncNotice } = getFleetRuntime();
const chainSyncState = computed(() => chainSync.state);

// 冲突条目的展示名：状态条/悬浮提示指明具体冲突对象（船名）。
function conflictEntryLabel(key: string): string {
  const ship = shipsStore.getById(key);
  if (ship) {
    return ship.name || ship.registration || key;
  }
  return key;
}

const syncConflictNames = computed(() => chainSyncState.value.mergeKeys.map(conflictEntryLabel));

const syncStateText = computed(() => {
  const s = chainSyncState.value;
  if (s.syncing) {
    return '同步中…';
  }
  if (s.error) {
    return '同步失败';
  }
  if (s.conflict) {
    const names = syncConflictNames.value.join('、');
    return names ? `有冲突：${names}` : '有冲突';
  }
  if (s.dirty) {
    return '待同步';
  }
  if (s.lastSyncAt !== null) {
    return `已同步 ${new Date(s.lastSyncAt).toLocaleTimeString()}`;
  }
  return '未同步';
});

// 状态条悬浮提示：冲突时列出具体条目与处理指引。
const syncStateTitle = computed(() => {
  const s = chainSyncState.value;
  if (s.conflict) {
    const names = syncConflictNames.value.join('、');
    return names
      ? `冲突条目：${names}。打开「云端同步」，对该条目点「上传」或「下载」解决。`
      : '存在待处理的同步冲突。打开「云端同步」，对相应条目点「上传」或「下载」解决。';
  }
  return s.error ?? '';
});

// 打开云端同步对比对话框：拉取云端 + 收集本地各活跃船快照，
// 由用户逐项选择覆盖方向（按船）。
async function onChainSyncClick(e: Event) {
  const cmp = await chainSync.prepareComparison();
  if (!cmp) {
    return; // 拉取失败/进行中：错误已写入 chainSyncState。
  }
  showTileOverlay(e, ChainSyncDialog, {
    comparison: cmp,
    // 冲突待处理条目（awaitingMerge 且 dirty）：对话框据此高亮需要处理的条目。
    mergeKeys: chainSync.state.mergeKeys,
    onApply: (target, direction) => {
      if (direction === 'pull') {
        // 用云端覆盖本地（指定船）。带上服务端行时间作为乐观锁基准。
        const doc = cmp.remoteShips.get(target);
        if (doc) {
          chainSync.confirmPull(
            target,
            doc,
            cmp.remoteServerUpdatedAt.get(target) ?? doc.updatedAt,
          );
        }
      } else {
        // 用本地覆盖云端（强制推送该目标）。
        void chainSync.pushNow(true, target);
      }
    },
  });
}

// ── 环线执行进度（多船简化列表） ─────────────────────────────
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

// 空间站 naturalId → 所属系统 naturalId（空间站地址被 AddressSelector 规范化为系统，
// 归航/飞往空间站的航段比较需先解析到系统）。
// 各船环线进度索引（按 shipId）。
const progressByShip = computed(() => {
  const map = new Map<string, RunProgress>();
  for (const entry of activeRuns.value) {
    map.set(entry.shipId, entry.progress);
  }
  return map;
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
      derivedPurchase: derivePurchaseBill(entry.run),
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

// 运行中环线折叠状态：按 shipId 持久化（跨面板重挂载保持），折叠后仅隐藏
// 明细表格/汇总（船头内的航线概览仍显示）。只对运行行生效——规划中卡片始终展开。
const collapsedRuns = useTileState<string[] | undefined>('chainCollapsed', undefined);

function isRunCollapsed(shipId: string) {
  return collapsedRuns.value?.includes(shipId) ?? false;
}

function toggleRunCollapsed(shipId: string) {
  const current = collapsedRuns.value ?? [];
  collapsedRuns.value = current.includes(shipId)
    ? current.filter(x => x !== shipId)
    : [...current, shipId];
}

// 卡片明细区（表格/汇总）是否可见：折叠只作用于「运行中」的环线行
// （其船头箭头可展开/折叠）。规划中的行（无 progress）必须始终展开——
// 否则运行结束残留的折叠标志会让规划卡只剩船名+航线，且规划卡不渲染
// 箭头（箭头仅在 progress 行出现），用户无法展开查看明细。
function isRowBodyVisible(sp: { shipId: string; progress?: unknown }) {
  return !sp.progress || !isRunCollapsed(sp.shipId);
}

// 组件只维护本地快照和折叠状态；运行记录清理由页面服务处理。
watchEffect(() => {
  // 没有运行记录时清空计划快照，避免残留旧数据影响下次规划。
  if (Object.keys(userData.chainRuns).length === 0) {
    planSnapshot.value = [];
  }
  // 清理已无运行记录的船的折叠标志：运行结束（或手动清理计划）后若标志残留，
  // 同船再次规划时会把「规划中」卡片折叠且无箭头可展开（箭头仅在运行行渲染）。
  // 按 activeRuns 保留而非 chainRuns 键——兜底推导的运行行（旧版本/触发器逆推）
  // 不在 chainRuns 中，但其运行卡片同样可折叠，需保留其标志。
  const collapsed = collapsedRuns.value;
  if (collapsed && collapsed.length > 0) {
    const withRuns = new Set(activeRuns.value.map(e => e.shipId));
    const pruned = collapsed.filter(id => withRuns.has(id));
    if (pruned.length !== collapsed.length) {
      collapsedRuns.value = pruned;
    }
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

// 判缺段的固定文案（与 chain-flight-time 落地的 leg.error 一致；成因全文走 data-tooltip）。
const MISSING_STL_RECORD = '缺原生 STL 段记录';

// 「飞行」列的显示态。判定条件与重构前的 flightCellText 逐字一致，只是搬移：
// - done：已完成阶段（含归航段）；
// - transit：在途阶段（正文是真实剩余时间）；
// - estimate：预估阶段（含判缺段、近似段）；
// - none：没有该段的预估数据。
// 正文与悬停说明共用同一判定——否则会出现「正文显示真实剩余时间、悬停却吐出预估
// 成因」的自相矛盾（同格文案对不上）。
function flightCellState(
  sp: { shipId: string; plan?: ChainPlan; progress?: RunProgress },
  legIndex: number,
): 'done' | 'transit' | 'estimate' | 'none' {
  // 已完成（含归航段）。
  const p = sp.progress;
  if (p !== undefined) {
    const n = sp.plan?.stops.length ?? p.stops.length;
    const done = legIndex < n ? p.stops[legIndex]?.state === 'done' : p.finalState === 'done';
    if (done) {
      return 'done';
    }
  }
  // 在途：真实剩余时间与真实到达时间。
  // 仅执行中的环线（有 progress）显示在途——规划中的环线即使船当前恰好在飞，
  // 那是另一个环线的真实飞行，混入会把预估时间覆盖成错误的时间。
  if (sp.progress !== undefined && legInTransit(sp.shipId, legIndex)) {
    return 'transit';
  }
  return flightLegFor(sp.shipId, legIndex) ? 'estimate' : 'none';
}

// 各段飞行列文本（模板「飞行」列）：
// - 已完成阶段 → 「已完成」；
// - 在途阶段 → 真实剩余时间 + 真实到达时间（HH:MM 到达）；
// - 预估阶段（判缺）→ 「--（缺原生 STL 段记录）」，成因全文见 flightCellTitle；
// - 预估阶段（近似段）→ 时长前缀 ≈；
// - 其余阶段 → 预估飞行时间（预估到达时间）。
function flightCellText(
  sp: { shipId: string; plan?: ChainPlan; progress?: RunProgress },
  legIndex: number,
): string {
  const state = flightCellState(sp, legIndex);
  if (state === 'done') {
    return ' 已完成';
  }
  // 在途：真实剩余时间与真实到达时间。
  if (state === 'transit') {
    const ship = shipsStore.getById(sp.shipId);
    const flight = ship?.flightId ? flightsStore.getById(ship.flightId) : undefined;
    if (flight) {
      const remainMs = Math.max(flight.arrival.timestamp - gameNow(), 0);
      return ` 剩余 ${formatFlightDuration(remainMs)}（${arrivalClockText(flight.arrival.timestamp)}到达）`;
    }
  }
  // 预估：飞行时间（预计到达时间）。state === 'none' 时下面的 !leg 直接返回空串。
  const leg = flightLegFor(sp.shipId, legIndex);
  if (!leg) {
    return '';
  }
  if (!leg.ok) {
    // 输入残缺（成因全文见 flightCellTitle）：显式标缺。
    // 写成「--（…）」而不是「0 小时」——否则会被读成「与出发同一时刻到达」。
    if (leg.missingInputs !== undefined && leg.missingInputs.length > 0) {
      return `--（${leg.error ?? MISSING_STL_RECORD}）`;
    }
    return leg.error ? `（${leg.error}）` : '';
  }
  // 近似段（时长按轨道几何公式估算）：前缀 ≈ 标明不是原生前向记录。
  const approx = leg.approximated !== undefined ? '≈' : '';
  return ` · ${approx}${formatFlightDuration(leg.hours * 3600000)}（${arrivalClockText(leg.arriveAtMs)}到达）`;
}

// 「飞行」列的悬停说明（模板 :data-tooltip，两处单元格都绑定）。
// 为什么不用 title：浏览器原生悬停有 ~2 秒延迟、玩家基本看不到，仓库统一用 PrUn 原生的
// data-tooltip 即时提示（见 docs/contributing.md §Tooltips）。
// 为什么无文案必须返回 undefined 而不是 ''：空串会渲染成一个空白 tooltip 框；
// Vue 3 对非布尔属性的 undefined 会直接移除该属性（同 CopyButton.vue 的写法）。
// 为什么必须与显示态一致：只有预估态的正文才是「预估」，才需要补充说明：
// - 判缺段 → fuel-model.missingModelInputs 的成因全文（含可操作指引），不截断、不改写；
// - 近似段 → 说明时长按轨道几何公式估算 + 为何是近似值；
// - 已完成 / 在途 / 无数据 → undefined：正文是真实数据或本就无正文，
//   此时再挂预估成因会与同一行的正文自相矛盾。
function flightCellTitle(
  sp: { shipId: string; plan?: ChainPlan; progress?: RunProgress },
  legIndex: number,
): string | undefined {
  if (flightCellState(sp, legIndex) !== 'estimate') {
    return undefined;
  }
  const leg = flightLegFor(sp.shipId, legIndex);
  if (!leg) {
    return undefined;
  }
  if (!leg.ok) {
    return leg.missingInputs !== undefined && leg.missingInputs.length > 0
      ? leg.missingInputs.join('；')
      : undefined;
  }
  const a = leg.approximated;
  if (a === undefined) {
    return undefined;
  }
  return '本段时长按轨道几何公式估算；弧长为均值圆弧初版，与服务器原生 TRANSIT 弧长存在相位偏差';
}

// 归航段（表格末行）的段序号 = 站点数；末行两个分支（plan / progress）在此合并，
// 使末行单元格可以用一个表达式绑定 data-tooltip。
function finalLegIndex(sp: { plan?: ChainPlan; progress?: RunProgress }): number {
  return sp.plan?.stops.length ?? sp.progress?.stops.length ?? 0;
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
  // 有近似段时必须标注：总时长不是全部来自原生记录。
  const approx = est.approximatedLegs > 0 ? `（含 ${est.approximatedLegs} 段公式估算）` : '';
  return `约 ${formatFlightDuration(est.totalHours * 3600000)}${approx}`;
}
</script>

<template>
  <div :class="$style.layout">
    <div :class="[C.ComExOrdersPanel.filter, $style.filterBar]">
      <SelectInput
        v-model="groupSelect"
        :options="groupOptions"
        :width="220"
        :class="$style.groupSelect" />
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
      <span
        :class="chainSyncState.conflict ? $style.syncStateConflict : $style.syncState"
        :title="syncStateTitle"
        @click="chainSyncState.conflict && onChainSyncClick($event)">
        {{ syncStateText }}
      </span>
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
        {{ base.naturalId }}<BaseAlias :site-id="base.siteId" />
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
    <div
      v-if="activeRuns.length > 0 || shipPlans.length > 0 || filteredStopNotices.length > 0"
      :class="$style.content">
      <div :class="[C.Tabs.component, $style.tabsHeader]">
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

      <div v-for="sp in visibleTables" :key="sp.shipId" :class="$style.shipPlan">
        <div :class="$style.shipHeader">
          <span
            v-if="sp.progress"
            :class="[$style.caret, isRunCollapsed(sp.shipId) ? '' : $style.caretOpen]"
            :title="isRunCollapsed(sp.shipId) ? '展开环线进度' : '折叠环线进度'"
            @click="toggleRunCollapsed(sp.shipId)"
            >▶</span
          >
          <span>
            {{ sp.ship ? shipLabel(sp.ship) : (sp.shipName ?? '') }}
            <template v-if="sp.progress">
              <span v-if="isRunFinished(sp)" :class="$style.finished">（已完成）</span>
              <span v-else :class="$style.running">（运行中）</span>
            </template>
            <template v-else>（{{ sp.ship?.exchangeCode ?? '' }}）</template>
          </span>
          <div
            v-if="(sp.plan?.stops?.length ?? 0) > 0 || (sp.progress?.stops?.length ?? 0) > 0"
            :class="$style.route">
            <span :class="$style.routeLabel">航线：</span>
            <span
              :class="[
                $style.routeOrigin,
                sp.progress?.originState === 'done' ? $style.routeDone : '',
              ]">
              {{ sp.plan?.originNaturalId ?? sp.progress?.originNaturalId }}
            </span>
            <template
              v-for="(stop, i) in sp.plan?.stops ?? sp.progress?.stops ?? []"
              :key="stop.naturalId">
              <span :class="$style.routeArrow">→</span>
              <span
                :class="[
                  $style.routeNode,
                  sp.progress?.stops[i]?.state === 'done' ? $style.routeDone : '',
                ]">
                {{ stop.naturalId || stop.planetName
                }}<BaseAlias v-if="stop.naturalId" :natural-id="stop.naturalId" />
              </span>
            </template>
            <span :class="$style.routeArrow">→</span>
            <span
              :class="[
                $style.routeOrigin,
                sp.progress?.finalState === 'done' ? $style.routeDone : '',
              ]">
              {{ sp.plan?.originNaturalId ?? sp.progress?.originNaturalId }}
            </span>
          </div>
          <PrunButton v-if="sp.progress" dark @click="onClearShipPlanClick($event, sp)"
            >清理计划</PrunButton
          >
        </div>

        <table v-if="isRowBodyVisible(sp)" :class="$style.table">
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
              <td :class="$style.narrowCol">
                {{ stop.naturalId || stop.planetName
                }}<BaseAlias v-if="stop.naturalId" :natural-id="stop.naturalId" />
              </td>
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
              <td
                :class="$style.matCell"
                :data-tooltip="flightCellTitle(sp, i)"
                data-tooltip-position="top">
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
              <td
                :class="$style.matCell"
                :data-tooltip="flightCellTitle(sp, finalLegIndex(sp))"
                data-tooltip-position="top">
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
        <div v-if="isRowBodyVisible(sp) && !sp.plan && sp.progress" :class="$style.summary">
          <div :class="$style.summaryRow">
            <span :class="$style.summaryLabel">飞行时长：</span>
            <span>
              <template v-if="flightTimesLoading">计算中…</template>
              <template v-else>{{ flightTotalText(sp.shipId) || '--' }}</template>
            </span>
          </div>
        </div>
        <div v-if="isRowBodyVisible(sp) && sp.plan" :class="$style.summary">
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
  flex: 1 1 auto;
  min-height: 0;
}

.filterBar {
  flex-wrap: wrap;
}

.filterBar :global(.SelectInput__container) {
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

.syncState {
  color: #8a9aa8;
  font-size: 11px;
  white-space: nowrap;
  align-self: center;
  margin-left: 0.25rem;
}

/* 冲突状态：高亮 + 可点击打开「云端同步」对话框处理。 */
.syncStateConflict {
  color: #f0a35e;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  align-self: center;
  margin-left: 0.25rem;
  cursor: pointer;
  text-decoration: underline dotted;
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

.caret {
  display: inline-block;
  cursor: pointer;
  user-select: none;
  color: #8a9aa8;
  font-size: 12px;
  transform: scale(0.8);
  transition: transform 0.1s ease-out;
}

.caretOpen {
  transform: scale(0.8) rotate(90deg);
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
