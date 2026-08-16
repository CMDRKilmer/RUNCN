<script setup lang="ts">
import { computed } from 'vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { getInvStore } from '@src/core/store-id';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import StatusCell from './StatusCell.vue';
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

    return {
      ship,
      stlFuelRatio,
      ftlFuelRatio,
      cargoSizeText: getCargoSizeText(inventory),
      isFtlCapable,
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

// Repair fill color: light purple, red at/below 83% condition.
function repairColor(condition: number) {
  return condition <= 0.83 ? '#d9534f' : '#9b59b6';
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
        <div :class="[$style.headerCell, $style.colStatus]">状态</div>
        <div :class="[$style.headerCell, $style.colLocation]">位置</div>
        <div :class="[$style.headerCell, $style.colLocation]">目的地</div>
        <div :class="[$style.headerCell, $style.colTime]">ETA</div>
        <div :class="[$style.headerCell, $style.colFuel]">燃料</div>
      </div>

      <!-- Body rows -->
      <div v-for="x in rows" :key="x.ship.id" :class="$style.row">
        <div :class="[$style.bodyCell]">
          <span :class="C.Link.link" @click="showBuffer(`SHP ${x.ship.registration}`)">
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

        <div :class="[$style.bodyCell, $style.colStatus]">
          <StatusCell :ship-id="x.ship.id" />
        </div>

        <div :class="[$style.bodyCell, $style.colLocation]">
          <LocationCell :ship-id="x.ship.id" mode="location" />
        </div>

        <div :class="[$style.bodyCell, $style.colLocation]">
          <LocationCell :ship-id="x.ship.id" mode="destination" />
        </div>

        <div :class="[$style.bodyCell, $style.colTime]">
          <TimeCell :ship-id="x.ship.id" />
        </div>

        <div :class="[$style.bodyCell, $style.colFuel]">
          <div
            :class="[C.ShipFuel.container, C.ShipFuel.pointer, $style.fuelBars]"
            @click="onFuel(x.ship.registration)">
            <div :class="C.ProgressBar.container">
              <progress
                :class="[C.ProgressBar.progress, $style.fuelBar, $style.repairBar]"
                :style="{ '--bar-color': repairColor(x.ship.condition) }"
                :value="x.ship.condition"
                max="1"
                @click.stop="showBuffer(`SHP ${x.ship.registration}`)" />
            </div>
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
    minmax(80px, auto) minmax(80px, auto) minmax(80px, auto) minmax(110px, auto)
    minmax(110px, auto) minmax(80px, 1fr) minmax(50px, auto);
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

.colStatus {
  border-right: none;
}

.colLocation {
  min-width: 110px;
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

.fuelBars {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 1px;
  width: 100%;
}

/* Thin, borderless fuel/repair bars. Doubled class selectors raise specificity
   above PrUn's .ProgressBar__progress (height: 9px, border 1px). Fuel bars keep
   PrUn's original primary/secondary colors; only the repair bar supplies its
   fill via the --bar-color custom property. */
.fuelBar.fuelBar {
  height: 4.5px;
  border: none;
}

.repairBar.repairBar::-webkit-progress-value {
  background-color: var(--bar-color);
}

.repairBar.repairBar::-moz-progress-bar {
  background: var(--bar-color);
}
</style>
