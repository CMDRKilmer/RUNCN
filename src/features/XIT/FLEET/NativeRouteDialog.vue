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
import { socketDeleteRoute, writeNativeRouteBySocket } from './native-route-socket';
import {
  DEFAULT_WAYPOINT_FUEL_PERCENT,
  isWaypointPercent,
  type NativeRouteStep,
  type NativeWaypoint,
  type RouteTank,
} from './native-route-plan';
import { stagedDispatch } from './staged';

// 清理上一次未完成航线失败时抛出：绝不能继续写新航线，否则旧航线会变成无人认领的残留。
class PartialRouteCleanupError extends Error {}

const {
  candidate,
  initialWaypoints,
  chainName = '',
  autoStart = false,
} = defineProps<{
  candidate: ShipChainPlan;
  initialWaypoints: NativeWaypoint[];
  // 产业链名称：写入原生 RT 的航线名，同时记录到 FLEET 展示。
  chainName?: string;
  // 首次打开向导时直接跑燃料计算与写入（FLEET「生成原生 RT」默认开启）。
  autoStart?: boolean;
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
      if (fuel !== basis.fuel || reactor !== basis.reactor) {
        legHours.value[index] = undefined;
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
    waypoints: waypoints.value.map((waypoint, index) => {
      const reactor = reactorUsagePercents.value[index];
      return {
        location: waypoint.location,
        fuelPercent: fuelUsagePercents.value[index] ?? DEFAULT_WAYPOINT_FUEL_PERCENT,
        reactorPercent: reactor === undefined || reactor === '' ? undefined : reactor,
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
    checkLoop();
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
    <p>单趟归航。备货和核对燃料后，在原生 RT 手动分配船只。分配即开始执行。</p>
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
      >燃料消耗与反应堆使用量按飞往各航点的航段计算：优先用 FTC 模型；缺服务器原生记录的航段改用 BTF
      试飞。创建航线前可以修改百分比。</p
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
      <template v-if="repeats === false">循环已关闭。请核对备货和飞行参数，再分配飞船。</template>
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
      <PrunButton v-if="progress.phase === 'done' && repeats !== false" dark @click="checkLoop">
        复查循环设置
      </PrunButton>
      <PrunButton v-if="hasPurchase" dark :disabled="busy" @click="openPurchase"
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
