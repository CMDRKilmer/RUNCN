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
  openNativeRoute,
  openNativeStep,
  openNativeWaypointEditor,
  openRouteList,
  prepareWaypoint,
  saveNativeStep,
  saveNativeWaypointFuel,
} from './native-route-editor';
import { measureNativeRouteFuel } from './native-route-btf';
import {
  DEFAULT_WAYPOINT_FUEL_PERCENT,
  isWaypointFuelPercent,
  type NativeRouteStep,
  type NativeWaypoint,
  type RouteTank,
} from './native-route-plan';
import { stagedDispatch } from './staged';

const { candidate, initialWaypoints } = defineProps<{
  candidate: ShipChainPlan;
  initialWaypoints: NativeWaypoint[];
}>();
const emit = defineEmits<{ close: [] }>();

const tanks = ref<RouteTank[]>([]);
const fuelUsagePercents = ref(initialWaypoints.map(() => DEFAULT_WAYPOINT_FUEL_PERCENT));
const fuelUsageValid = computed(() => fuelUsagePercents.value.every(isWaypointFuelPercent));
const btfStatus = ref<string>();
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
let btfScan: AbortController | undefined;
let disposed = false;
const waitingForNativeStep = ref(false);
const nativeStepLabels = { load: '装载', unload: '卸船', refuel: '加油' };

function cancelNativeStepWait() {
  nativeStepClick?.abort();
}

function stopAutoFill() {
  autoFilling.value = false;
  cancelNativeStepWait();
  btfScan?.abort();
}

onBeforeUnmount(() => {
  disposed = true;
  stopAutoFill();
});

const retryAction = computed(() => {
  const phase = progress.value.phase;
  if (phase === 'scan-fuel') {
    return '重试 BTF 测燃料';
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
      return 'BTF 测燃料';
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
    !fuelUsageValid.value ||
    (error.value !== undefined && retryAction.value === undefined)
  ) {
    return;
  }
  let retrying = error.value !== undefined;
  error.value = undefined;
  canRetryStep.value = false;
  busy.value = true;
  autoFilling.value = automatic;
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
    error.value = err instanceof Error ? err.message : String(err);
    canRetryStep.value = err instanceof NativeStepButtonUnavailable;
  } finally {
    nativeStepClick = undefined;
    autoFilling.value = false;
    busy.value = false;
  }
}

async function advanceOnce(retrying: boolean) {
  const state = progress.value;
  if (state.phase === 'scan-fuel') {
    const controller = new AbortController();
    btfScan = controller;
    btfStatus.value = `正在打开 BTF ${candidate.ship.ship.blueprintNaturalId}`;
    try {
      const results = await measureNativeRouteFuel(
        candidate,
        waypoints.value,
        controller.signal,
        status => {
          btfStatus.value = status;
        },
      );
      if (!controller.signal.aborted) {
        fuelUsagePercents.value = [fuelUsagePercents.value[0]!, ...results];
        progress.value = { phase: 'open' };
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        throw err;
      }
    } finally {
      btfScan = undefined;
      btfStatus.value = undefined;
    }
    return;
  }
  if (state.phase === 'open') {
    progress.value = { phase: 'create', list: await openRouteList(retrying) };
    return;
  }
  if (state.phase === 'create') {
    if (getActiveChainRuns().some(run => run.shipId === candidate.ship.ship.id)) {
      throw new Error('该船仍有旧环线在执行，请在归航后切换。');
    }
    routeId.value = await createNativeRoute(state.list);
    progress.value = { phase: 'open-route' };
    return;
  }
  if (state.phase === 'open-route' && routeId.value !== undefined) {
    tile = await openNativeRoute(routeId.value);
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
    if (!isWaypointFuelPercent(percent)) {
      throw new Error('燃料消耗必须为 1–100% 的整数。');
    }
    if (state.phase === 'waypoint-fuel') {
      const editor = state.editor ?? (await openNativeWaypointEditor(tile, state.target));
      progress.value = { ...state, editor };
      await fillNativeWaypointFuel(tile, editor, percent);
      progress.value = { phase: 'save-waypoint-fuel', target: state.target, editor };
      return;
    }
    await saveNativeWaypointFuel(tile, state.editor, percent);
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
  await showBuffer(routeId.value === undefined ? 'RT' : `RT ${routeId.value}`);
}
</script>

<template>
  <div :class="$style.body">
    <h2>生成原生 RT · {{ candidate.ship.ship.name ?? candidate.ship.ship.registration }}</h2>
    <p>单趟归航。备货和核对燃料后，在原生 RT 手动分配船只。分配即开始执行。</p>
    <div v-if="routeId === undefined" :class="$style.controls">
      <label
        ><input v-model="tanks" type="checkbox" value="STL" :disabled="busy" /> 出发地补满
        STL</label
      >
      <label
        ><input v-model="tanks" type="checkbox" value="FTL" :disabled="busy" /> 出发地补满
        FTL</label
      >
    </div>
    <p>燃料消耗按飞往各航点的航段试飞。创建航线前可以修改百分比。</p>
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
            :aria-label="`${stop.location} 燃料消耗百分比`" />%
        </label>
        <span v-if="stop.steps.length > 0"> · {{ stop.steps.map(describe).join('、') }}</span>
      </li>
    </ol>
    <p v-if="routeId"
      >航线 {{ routeId }} · {{ Math.min(waypointIndex + 1, waypoints.length) }}/{{
        waypoints.length
      }}
      站</p
    >
    <p v-if="!fuelUsageValid" role="alert">各航点的燃料消耗必须为 1–100% 的整数。</p>
    <p v-else-if="error" role="alert">
      {{ error }}
      <template v-if="!retryAction">请打开原生 RT 核对已写入的内容，再手动补齐。</template>
    </p>
    <p v-else-if="btfStatus" role="status">{{ btfStatus }}</p>
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
        data-tooltip="BTF 试飞后连续创建航点、保存燃料消耗并写入装卸步骤。"
        @click="advance(true)"
        >{{ routeId ? '继续自动填写' : '自动填写' }}</PrunButton
      >
      <PrunButton v-if="autoFilling" dark @click="stopAutoFill">停止自动填写</PrunButton>
      <PrunButton v-else-if="btfStatus" dark @click="stopAutoFill">停止 BTF 试飞</PrunButton>
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

.fuelInput {
  width: 5ch;
}
</style>
