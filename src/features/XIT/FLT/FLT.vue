<script setup lang="ts">
import { computed, ref } from 'vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { getInvStore } from '@src/core/store-id';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';

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

type FlightRow = {
  ship: PrunApi.Ship;
  stlFuelRatio: number | undefined;
  ftlFuelRatio: number | undefined;
  cargoSizeText: string;
  isFtlCapable: boolean;
  statusIcon: string;
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

    return {
      ship,
      stlFuelRatio,
      ftlFuelRatio,
      cargoSizeText: getCargoSizeText(inventory),
      isFtlCapable,
      statusIcon,
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
        <div :class="[$style.bodyCell]">
          <span
            :class="[
              C.Link.link,
              { [$style.warnCondition]: x.ship.condition >= 0.8 && x.ship.condition <= 0.83 },
              { [$style.lowCondition]: x.ship.condition < 0.8 },
            ]"
            @click="showBuffer(`SHP ${x.ship.registration}`)">
            {{ x.ship.name || x.ship.registration }}
          </span>
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
