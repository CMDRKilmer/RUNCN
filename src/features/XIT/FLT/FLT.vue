<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import {
  executionIndicatorStatus,
  requestRouteExecutions,
  routeExecutionsStore,
} from '@src/infrastructure/prun-api/data/route-executions';
import { getInvStore } from '@src/core/store-id';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { shipConditionLevel } from '@src/utils/ship-condition';

// Status arrow icons (inlined from deleted ship-status-icons.ts). Arrow per
// flight segment type; stationary (⦁) when docked or no active flight.
const stationaryIcon = '\u23E5';
const statusIconMap: Record<string, string> = {
  TAKE_OFF: '\u2191',
  DEPARTURE: '\u2197',
  TRANSIT: '\u27F6',
  CHARGE: '\u00B1',
  JUMP: '\u27BE',
  FLOAT: '\u2191',
  APPROACH: '\u2198',
  LANDING: '\u2193',
  LOCK: '\u27F4',
  DECAY: '\u27F4',
  JUMP_GATEWAY: '\u27F4',
};
function segStatusIcon(segType: string) {
  return statusIconMap[segType] ?? '?';
}
import LocationCell from './LocationCell.vue';
import TimeCell from './TimeCell.vue';
import FleetCargoBar from './FleetCargoBar.vue';
import { fixed0 } from '@src/utils/format';

type RouteStatus = 'ok' | 'warning' | 'error';

type FlightRow = {
  ship: PrunApi.Ship;
  stlFuelRatio: number | undefined;
  ftlFuelRatio: number | undefined;
  cargoSizeText: string;
  isFtlCapable: boolean;
  statusIcon: string;
  // 已分配航线时才有值：**严格取自游戏原生航线执行状态**（RTE 航点前指示器同源）。
  // 数据来自 SHIP_ROUTES_EXECUTION(S)：execution.state → 与原生同一张开关表。
  // 未收到执行数据时为 undefined（显示为「未同步」中性圆点）。
  routeStatus: RouteStatus | undefined;
};

const rawRows = computed<FlightRow[] | undefined>(() => {
  const ships = shipsStore.all.value;
  if (!ships) {
    return undefined;
  }

  return ships.map(ship => {
    const inventory = getInvStore(ship.idShipStore);
    const stlStore = storagesStore.getById(ship.idStlFuelStore);
    const ftlStore = storagesStore.getById(ship.idFtlFuelStore);
    const stlFuelRatio = getFuelRatio(stlStore);
    const ftlFuelRatio = getFuelRatio(ftlStore);

    const isFtlCapable = (ftlStore?.weightCapacity ?? 0) > 0;
    const flight = flightsStore.getById(ship.flightId);
    const segment = flight?.segments[flight.currentSegmentIndex];
    const statusIcon = segment ? segStatusIcon(segment.type) : stationaryIcon;

    // 严格同步：颜色直接来自游戏原生航线执行状态。
    const execution = routeExecutionsStore.getById(ship.id);
    const routeStatus =
      execution !== undefined ? executionIndicatorStatus(execution.state) : undefined;

    return {
      ship,
      stlFuelRatio,
      ftlFuelRatio,
      cargoSizeText: getCargoSizeText(inventory),
      isFtlCapable,
      statusIcon,
      routeStatus,
    };
  });
});

const rows = computed(() => {
  const source = rawRows.value;
  if (!source) {
    return undefined;
  }
  return [...source].sort((a, b) =>
    (a.ship.name || a.ship.registration).localeCompare(b.ship.name || b.ship.registration),
  );
});

// 燃料列（油条）显示开关。
const showFuel = ref(true);

// 缺油自动加油已迁移至全局 feature（src/features/basic/auto-refuel.ts）。
// 此处仅负责 FLT 总览表的展示。

function getCargoSizeText(inventory: PrunApi.Store | undefined) {
  if (!inventory) {
    return '--/--';
  }

  return `${toCompactK(inventory.weightCapacity)}/${toCompactK(inventory.volumeCapacity)}`;
}

function toCompactK(value: number) {
  if (value >= 1000) {
    return `${Math.round(value / 1000)}k`;
  }
  return fixed0(value);
}

function getFuelRatio(store: PrunApi.Store | undefined) {
  const capacity = store?.weightCapacity;
  if (store == null || capacity == null || capacity <= 0) {
    return undefined;
  }

  return store.weightLoad / capacity;
}

function onFuel(registration: string) {
  showBuffer(`SHPF ${registration}`);
}

function routeStatusTooltip(status: RouteStatus | undefined) {
  if (status === 'warning') {
    return '航线节点：警告（等待任务 / 步骤受阻）';
  }
  if (status === 'error') {
    return '航线节点：异常（受阻或无法执行）';
  }
  if (status === 'ok') {
    return '航线节点：正常（点击打开 RTE）';
  }
  return '未同步原生状态（点击打开 RTE 加载）';
}

// 点击指示器打开该船的航线执行窗口：RTE 的参数是**船注册号（应答代码）**，
// 例如 `RTE AVI-06HW8`；不是航线号。注册号为空时退回 RTE 列表。
function openRoute(row: FlightRow) {
  const registration = row.ship.registration;
  void showBuffer(registration !== '' ? `RTE ${registration}` : 'RTE');
}

// 打开面板即自动同步一次原生航线执行状态，不必等点击：直接发
// SHIP_ROUTES_GET_EXECUTIONS 请求（响应由被动订阅的 store 收下）。
// socket/上下文没就绪时按 1.5s 间隔重试，最多约 15s。
function syncRouteExecutions(attempt: number) {
  if (routeExecutionsStore.fetched.value) {
    return;
  }
  if (requestRouteExecutions()) {
    return;
  }
  if (attempt < 10) {
    setTimeout(() => syncRouteExecutions(attempt + 1), 1500);
  }
}

onMounted(() => {
  syncRouteExecutions(0);
});
</script>

<template>
  <LoadingSpinner v-if="!rows" />
  <div v-else :class="$style.content">
    <div :class="$style.tableContainerFill">
      <!-- Header row -->
      <div :class="$style.headerRow">
        <div :class="[$style.headerCell]">舰名</div>
        <div :class="[$style.headerCell, $style.cargoCombinedCell]">货物</div>
        <div :class="[$style.headerCell, $style.colLocation]">位置</div>
        <div :class="[$style.headerCell, $style.colTime]">ETA</div>
        <div :class="[$style.headerCell, $style.colFuel]" @click="showFuel = !showFuel">燃料</div>
      </div>

      <!-- Body rows -->
      <div v-for="x in rows" :key="x.ship.id" :class="$style.row">
        <div :class="[$style.bodyCell, $style.nameCell]">
          <span
            :class="[
              C.Link.link,
              { [$style.nameBox]: x.ship.assignedRoute != null && x.ship.assignedRoute !== '' },
              { [$style.warnCondition]: shipConditionLevel(x.ship.condition) === 'warn' },
              { [$style.lowCondition]: shipConditionLevel(x.ship.condition) === 'danger' },
            ]"
            @click="showBuffer(`SHP ${x.ship.registration}`)">
            {{ x.ship.name || x.ship.registration }}
          </span>
          <span
            v-if="x.ship.assignedRoute != null && x.ship.assignedRoute !== ''"
            :class="[$style.routeDot, $style[x.routeStatus ?? 'unknown']]"
            :data-tooltip="routeStatusTooltip(x.routeStatus)"
            @click="openRoute(x)"></span>
        </div>

        <div :class="[$style.bodyCell, $style.cargoCombinedCell]">
          <FleetCargoBar :ship-id="x.ship.id" tall />
          <div
            :class="[C.ShipStore.pointer, C.ShipStore.store, $style.cargoCombinedSize]"
            @click="showBuffer(`SHPI ${x.ship.registration}`)">
            {{ x.cargoSizeText }}
          </div>
        </div>

        <div :class="[$style.bodyCell, $style.colLocation]">
          <span :class="$style.statusArrow">{{ x.statusIcon }}</span>
          <LocationCell :ship-id="x.ship.id" :mode="x.ship.flightId ? 'destination' : 'location'" />
        </div>

        <div :class="[$style.bodyCell, $style.colTime]">
          <TimeCell :ship-id="x.ship.id" />
        </div>

        <div :class="[$style.bodyCell, $style.colFuel]">
          <div
            v-show="showFuel"
            :class="[C.ShipFuel.container, C.ShipFuel.pointer]"
            @click="onFuel(x.ship.registration)">
            <div :class="C.ProgressBar.container">
              <progress
                :class="[C.ProgressBar.primary, C.ProgressBar.progress, $style.fuelBar]"
                :value="x.stlFuelRatio ?? 0"
                max="1" />
            </div>
            <div :class="C.ProgressBar.container">
              <progress
                :class="[
                  C.ProgressBar.secondary,
                  C.ProgressBar.progress,
                  !x.isFtlCapable ? C.ProgressBar.warning : undefined,
                  $style.fuelBar,
                ]"
                :value="x.ftlFuelRatio ?? 0"
                max="1" />
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style module>
.content {
  padding-left: 6px;
}

.tableContainerFill {
  display: grid;
  width: 100%;
  border-bottom: 1px solid #2b485a;
  container-type: inline-size;
  grid-template-columns:
    minmax(80px, auto) minmax(60px, auto) minmax(110px, auto) minmax(80px, 1fr)
    minmax(50px, auto);
}

.headerRow {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  border-bottom: 1px solid #2b485a;
  font-weight: normal;
}

.row {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: subgrid;
  font-size: 11px;
  line-height: 1.1;
  font-family: 'Droid Sans', sans-serif;
}

/* Header and body cell base styles. */
.headerCell,
.bodyCell {
  display: flex;
  align-items: center;
}

/* Align header text to the top so a tall body cell (e.g. cargo bar with size
   label) does not push the header label down inside an oversized row. */
.headerCell {
  align-items: flex-start;
  padding: 5px 8px 2px;
  font-weight: normal;
}

.bodyCell {
  padding: 4px 6px;
  border-left: 1px solid #2b485a;
}

.bodyCell:first-child {
  border-left: none;
}

.headerCell:first-child {
  border-left: none;
}

.cargoCombinedCell {
  flex-direction: column;
}

/* Body-only padding: the cargo column packs a cargo bar plus a size label
   stacked vertically, so it needs tighter, bottom-zero padding. The header
   keeps its own standard padding so its label baseline matches the other
   headers. */
.bodyCell.cargoCombinedCell {
  padding: 2px;
  padding-bottom: 0;
}

.cargoCombinedSize {
  margin-top: 2px;
}

.colLocation {
  min-width: 110px;
}

.colFuel {
  cursor: pointer;
}

.statusArrow {
  margin-right: 4px;
  color: #3fa2de;
}

/* 已分配航线的舰名：虚线框 + 右侧航线节点状态圆点。
   虚线框与圆点都是 flex 子项，靠 .bodyCell 的 align-items:center 与舰名文字垂直居中。
   颜色优先取主题语义 token（有主题时自动跟随），无主题时用兜底色保证可见。 */
.nameCell {
  gap: 4px;
}

.nameBox {
  display: inline-flex;
  align-items: center;
  border: 1px dashed var(--rp-skin-border-strong, currentColor);
  border-radius: 6px;
  /* 左右各 4px 内边距 + 1px 边框，靠 -5px 左边距抵消，使框内文字与未加框行
     的舰名左缘对齐（避免加框后文字整体右移）；整体更紧凑。 */
  padding: 0 4px;
  margin-left: -5px;
  line-height: 1.4;
}

.routeDot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex: 0 0 auto;
  cursor: pointer;
}

.routeDot.ok {
  background: var(--rp-skin-success, #4fae6a);
  box-shadow: 0 0 5px 1px var(--rp-skin-success, #4fae6a);
}

.routeDot.warning {
  background: var(--rp-skin-warning, #d9a13b);
  box-shadow: 0 0 5px 1px var(--rp-skin-warning, #d9a13b);
}

.routeDot.error {
  background: var(--rp-skin-danger, #d9534f);
  box-shadow: 0 0 5px 1px var(--rp-skin-danger, #d9534f);
}

/* 还没收到原生执行数据时的中性指示（空心圈）：不伪造颜色，点击可打开 RTE 触发加载。 */
.routeDot.unknown {
  background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--rp-skin-muted, #7b8b96);
}

/* 耐久 80%~83% 时舰名变黄警示。 */
.warnCondition {
  color: #f0ad4e;
}

/* 耐久低于 80% 时舰名变红告警。 */
.lowCondition {
  color: #d9534f;
}

/* TimeCell right-aligns its own content, so the header has to follow suit in every
   layout or it drifts to the left edge of the column. */
.colTime {
  border-left: none;
  justify-content: flex-end;
  text-align: right;
}

.colSize {
  justify-content: center;
}

.row:nth-child(even) > .bodyCell {
  background-color: rgba(255, 255, 255, 0.02);
}

.row:hover > .bodyCell {
  background-color: rgba(255, 255, 255, 0.06);
}
</style>
