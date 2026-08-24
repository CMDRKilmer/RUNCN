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
import { billTotals, type DispatchShip } from '@src/features/XIT/FLEET/utils';
import { getBaseGroups } from '@src/core/base-groups';
import { useTileState } from '@src/store/user-data-tiles';
import { userData } from '@src/store/user-data';
import { stagedDispatch, dispatchFinished } from '@src/features/XIT/FLEET/staged';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { queueTriggerRun, getPackageFinished } from '@src/features/XIT/ACT/trigger-queue';
import { watchUntil } from '@src/utils/watch';
import { createId } from '@src/store/create-id';
import { stripDeletedActions } from '@src/features/XIT/ACT/utils';
import { downloadJson } from '@src/utils/json-file';
import { showTileOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import ImportTriggerConfig from '@src/features/XIT/TRIGGER/ImportTriggerConfig.vue';
import { triggerEngine } from '@src/features/basic/automation-triggers/trigger-engine';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import {
  getEntityNameFromAddress,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { fixed0, formatCurrency } from '@src/utils/format';
import { getPrice } from '@src/infrastructure/fio/cx';

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

const executeNotice = ref<string | undefined>(undefined);

// 执行时的计划快照：环线执行中船离港后 shipPlans 为空，
// 用快照保持「与规划一致」的表格显示，仅在序列叠加进度图标。
const planSnapshot = ref<ShipChainPlan[]>([]);

function execute() {
  const plans = shipPlans.value;
  if (plans.length === 0) {
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
    // 记录环线运行进度（以船为键）。
    userData.chainRuns[ship.ship.id] = {
      shipId: ship.ship.id,
      shipName: ship.ship.name ?? ship.ship.registration,
      startedAt: Date.now(),
      originNaturalId: shipPlan.originNaturalId,
      stops: shipPlan.stops.map((stop, i) => ({
        naturalId: stop.naturalId,
        planetName: stop.planetName,
        pkgName: actionPlan.stopPkgs[i]!.pkg.global.name,
      })),
      finalPkgName: actionPlan.finalPkg?.pkg.global.name,
    };
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
  planSnapshot.value = [...plans];

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

// ── 环线触发器配置导入/导出 ─────────────────────────────────
// 环线相关 = 本面板生成的到港触发器与其操作包（主包/站点包/归航包）。
// 命名约定与 buildChainActionPackages / sanitizeActName 一致：
//   主包       `Chain ${船名}`
//   站点包     `${站点} Loop ${船名}`（旧版 `${站点} 环线 ${船名}`）
//   归航包     `Chain Return ${船名}`（旧版 `环线归航 ${船名}`）
function isChainPackageName(name: string): boolean {
  return (
    name.startsWith('Chain ') ||
    name.startsWith('环线归航 ') ||
    name.includes(' Loop ') ||
    name.includes(' 环线 ')
  );
}

function isChainTrigger(t: UserData.TriggerData): boolean {
  return t.event.type === 'FLIGHT_ENDED' && isChainPackageName(t.packageName);
}

// 导出环线配置：所有环线触发器 + 环线相关操作包（自包含，便于分享/备份）。
function onExportChainConfigClick() {
  const triggers = userData.triggers.filter(isChainTrigger);
  const packageNames = new Set(
    userData.actionPackages.filter(p => isChainPackageName(p.global.name)).map(p => p.global.name),
  );
  for (const t of triggers) {
    packageNames.add(t.packageName);
  }
  const actionPackages = userData.actionPackages.filter(p => packageNames.has(p.global.name));
  downloadJson({ version: 1, triggers, actionPackages }, `chain-config-${Date.now()}.json`, {
    pretty: true,
  });
}

// 事件为扁平对象，按键排序归一化后序列化，避免键序差异导致同一触发器签名不同。
function canonicalEvent(event: UserData.TriggerEventData) {
  return Object.fromEntries(Object.entries(event).sort(([a], [b]) => a.localeCompare(b)));
}

// 导入环线配置：操作包按名称覆盖或新增；触发器追加（按名称+操作包+事件+模式去重）。
function onImportChainConfigClick(e: Event) {
  showTileOverlay(e, ImportTriggerConfig, {
    onImport: config => {
      for (const pkg of config.actionPackages) {
        stripDeletedActions(pkg);
        const index = userData.actionPackages.findIndex(x => x.global.name === pkg.global.name);
        if (index >= 0) {
          userData.actionPackages[index] = pkg;
        } else {
          userData.actionPackages.push(pkg);
        }
      }
      const signature = (t: UserData.TriggerData) =>
        JSON.stringify([t.name, t.packageName, canonicalEvent(t.event), t.mode]);
      const existing = new Set(userData.triggers.map(signature));
      for (const trigger of config.triggers) {
        if (existing.has(signature(trigger))) {
          continue;
        }
        userData.triggers.push({ ...trigger, id: createId() });
        existing.add(signature(trigger));
      }
      triggerEngine.start();
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
      planetName: site ? getEntityNameFromAddress(site.address) : (naturalId ?? t.packageName),
      pkgName: t.packageName,
    };
  });
  const finalTrigger = userData.triggers.find(
    t =>
      t.event.type === 'FLIGHT_ENDED' &&
      (t.packageName === `Chain Return ${shipName}` || t.packageName === `环线归航 ${shipName}`),
  );
  return {
    shipId: ship.id,
    shipName: ship.name ?? ship.registration,
    startedAt: stopTriggers[0]!.createdAt,
    // 归航触发器以出发地为 planet，取它作为出发地标记。
    originNaturalId:
      finalTrigger && finalTrigger.event.type === 'FLIGHT_ENDED' ? finalTrigger.event.planet : '',
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

// 出发行采购：从主包（Chain 船名）的「购买」组还原。
// 主包名由站点包名反推（取最后一个「 Loop 」之后的部分作为船名）。
function derivePurchaseBill(stopPkgName: string): Record<string, number> {
  const idx = stopPkgName.lastIndexOf(' Loop ');
  if (idx < 0) {
    return {};
  }
  const shipName = stopPkgName.slice(idx + ' Loop '.length);
  const mainPkg = userData.actionPackages.find(p => p.global.name === `Chain ${shipName}`);
  return mainPkg?.groups.find(g => g.name.startsWith('购买 '))?.materials ?? {};
}

type StopState = 'done' | 'arrived' | 'transit' | 'pending';

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
}

// 单船各站状态：与执行前一致，沿「origin → 各站 → origin」给出每站进度。
function runProgress(run: UserData.ChainRun): RunProgress {
  const ship = shipsStore.getById(run.shipId);
  const flight = ship?.flightId ? flightsStore.getById(ship.flightId) : undefined;
  const flightDest = flight ? getEntityNaturalIdFromAddress(flight.destination) : undefined;
  const dockedAt = ship?.address ? getEntityNaturalIdFromAddress(ship.address) : undefined;
  const stops = run.stops.map(stop => {
    const pkgExists = userData.actionPackages.some(p => p.global.name === stop.pkgName);
    const fired = (userData.triggers.find(t => t.packageName === stop.pkgName)?.runCount ?? 0) > 0;
    let state: StopState;
    if (!pkgExists) {
      state = 'done';
    } else if (fired || dockedAt === stop.naturalId) {
      state = 'arrived';
    } else if (flightDest === stop.naturalId) {
      state = 'transit';
    } else {
      state = 'pending';
    }
    return { naturalId: stop.naturalId, planetName: stop.planetName, state };
  });
  return {
    originNaturalId: run.originNaturalId,
    stops,
    done: stops.filter(s => s.state === 'done').length,
    total: stops.length,
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

// 规划区 / 进度区统一表格数据：
// - 规划模式：实时计划（无进度）。
// - 环线执行中：显示执行前的计划快照，仅在「序」列叠加进度图标；
//   无快照（页面刷新 / 旧版本环线）时退化为仅显示站点与进度。
const tables = computed<
  {
    shipId: string;
    ship?: DispatchShip;
    shipName?: string;
    plan?: ChainPlan;
    progress?: RunProgress;
    // 无快照时的逆推操作（页面刷新 / 旧版本环线）。
    derivedStops?: { unload: Record<string, number>; load: Record<string, number> }[];
    derivedPurchase?: Record<string, number>;
    derivedFinal?: Record<string, number>;
  }[]
>(() => {
  if (activeRuns.value.length === 0) {
    return shipPlans.value.map(sp => ({
      shipId: sp.ship.ship.id,
      ship: sp.ship,
      plan: sp.plan,
      progress: undefined,
    }));
  }
  if (planSnapshot.value.length > 0) {
    return planSnapshot.value.map(sp => ({
      shipId: sp.ship.ship.id,
      ship: sp.ship,
      plan: sp.plan,
      progress: progressByShip.value.get(sp.ship.ship.id),
    }));
  }
  return activeRuns.value.map(entry => ({
    shipId: entry.shipId,
    shipName: entry.run.shipName,
    progress: entry.progress,
    derivedStops: entry.run.stops.map(stop => deriveStopOps(stop.pkgName)),
    derivedPurchase:
      entry.run.stops.length > 0 ? derivePurchaseBill(entry.run.stops[0]!.pkgName) : {},
    derivedFinal: entry.run.finalPkgName ? deriveFinalOps(entry.run.finalPkgName) : {},
  }));
});

// 环线完成后清理运行记录：遍历全部 chainRuns（不限于当前选中的船），
// 站点与归航包都完成后移除。
watchEffect(() => {
  for (const [shipId, run] of Object.entries(userData.chainRuns)) {
    const progress = runProgress(run);
    if (progress.done >= progress.total) {
      const finalDone =
        run.finalPkgName === undefined ||
        !userData.actionPackages.some(p => p.global.name === run.finalPkgName);
      if (finalDone) {
        delete userData.chainRuns[shipId];
      }
    }
  }
  // 所有环线执行完成后清空计划快照，避免残留旧数据影响下次规划。
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

function nextStopName(stops: ChainStopPlan[], i: number): string {
  return stops[i + 1]?.planetName ?? '出发地';
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
</script>

<template>
  <div :class="$style.layout">
    <div :class="[C.ComExOrdersPanel.filter, $style.filterBar]">
      <SelectInput v-model="groupSelect" :options="groupOptions" :width="220" />
      <div :class="$style.separator" />
      <RadioItem v-model="chainAutoLaunch" horizontal>自动发船</RadioItem>
      <RadioItem v-model="chainAutoTrigger" horizontal>自动执行</RadioItem>
      <div :class="$style.separator" />
      <PrunButton dark @click="onExportChainConfigClick">导出配置</PrunButton>
      <PrunButton dark @click="onImportChainConfigClick">导入配置</PrunButton>
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

    <!-- 规划 / 进度统一表格：环线执行中显示执行前的计划快照（格式与规划一致），
         仅在「序」列叠加进度图标；等所有船归航后自动恢复实时规划。 -->
    <div v-if="activeRuns.length > 0 || shipPlans.length > 0" :class="$style.content">
      <div v-for="sp in tables" :key="sp.shipId" :class="$style.shipPlan">
        <div :class="$style.shipHeader"
          >{{ sp.ship ? shipLabel(sp.ship) : (sp.shipName ?? '') }}（{{
            sp.ship?.exchangeCode ?? ''
          }}）</div
        >
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
                  v-if="sp.progress?.stops[0] && sp.progress.stops[0].state !== 'pending'"
                  :class="[$style.marker, $style.markTransit]"
                  >✈</span
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
                  <div v-if="Object.keys(sp.plan.originPickup).length > 0">
                    <span :class="$style.opsLabel">取货</span>
                    [{{ formatMaterials(sp.plan.originPickup) }}]
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
              <td :class="$style.matCell">
                <template v-if="sp.plan">
                  → {{ sp.plan.stops[0]?.planetName ?? sp.plan.originNaturalId }}
                </template>
                <template v-else-if="sp.progress">
                  → {{ sp.progress.stops[0]?.planetName ?? sp.progress.originNaturalId }}
                </template>
                <span v-else>—</span>
              </td>
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
                <template v-if="sp.plan"> → {{ nextStopName(sp.plan.stops, i) }} </template>
                <template v-else-if="sp.progress">
                  → {{ sp.progress.stops[i + 1]?.planetName ?? sp.progress.originNaturalId }}
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
                  v-if="sp.progress && sp.progress.done >= sp.progress.total"
                  :class="[$style.marker, $style.markDone]"
                  >✓</span
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
              <td :class="$style.matCell">归航</td>
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

        <div v-if="sp.plan" :class="$style.summary">
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

      <div v-if="unusedShipCount > 0" :class="$style.notice">
        已忽略 {{ unusedShipCount }} 艘未参与分配的船。
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
  white-space: nowrap;
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
  font-weight: 600;
  color: rgb(63, 162, 222);
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
