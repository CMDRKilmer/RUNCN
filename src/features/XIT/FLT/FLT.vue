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
import coloredValue from '@src/infrastructure/prun-ui/css/colored-value.module.css';

type FlightRow = {
  ship: PrunApi.Ship;
  stlFuelRatio: number | undefined;
  ftlFuelRatio: number | undefined;
  conditionText: string;
  conditionClass: string;
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

    const conditionPercentage = ship.condition * 100;
    const isFtlCapable = (ftlStore?.weightCapacity ?? 0) > 0;

    return {
      ship,
      stlFuelRatio,
      ftlFuelRatio,
      conditionText: `${Math.round(conditionPercentage)}%`,
      conditionClass: getConditionClass(conditionPercentage),
      cargoSizeText: getCargoSizeText(inventory),
      isFtlCapable,
    };
  });
});

const rows = computed(() => rawRows.value);

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

function getConditionClass(condition: number) {
  if (Math.round(condition) <= 79) {
    return C.ColoredValue.negative;
  }
  if (Math.round(condition) <= 81) {
    return coloredValue.warning;
  }
  return C.ColoredValue.positive;
}
</script>

<template>
  <LoadingSpinner v-if="!rows" />
  <div v-else :class="$style.content">
    <div :class="$style.tableContainerFill">
      <!-- Header row -->
      <div :class="$style.headerRow">
        <div :class="[$style.headerCell]">舰名</div>
        <div :class="[$style.headerCell, $style.cargoCombinedCell]">容量货物</div>
        <div :class="[$style.headerCell, $style.colStatus]">状态</div>
        <div :class="[$style.headerCell, $style.colLocation]">位置</div>
        <div :class="[$style.headerCell, $style.colTime]">ETA</div>
        <div :class="[$style.headerCell, $style.colRepair]">维修</div>
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
          <LocationCell :ship-id="x.ship.id" />
        </div>

        <div :class="[$style.bodyCell, $style.colTime]">
          <TimeCell :ship-id="x.ship.id" />
        </div>

        <div :class="[$style.bodyCell, $style.colRepair]">
          <span
            :class="[x.conditionClass, C.Link.link]"
            @click="showBuffer(`SHP ${x.ship.registration}`)">
            {{ x.conditionText }}
          </span>
        </div>

        <div :class="[$style.bodyCell, $style.colFuel]">
          <div
            :class="[C.ShipFuel.container, C.ShipFuel.pointer, $style.fuelBars]"
            @click="onFuel(x.ship.registration)">
            <div :class="C.ProgressBar.container">
              <progress
                :class="[C.ProgressBar.primary, C.ProgressBar.progress]"
                :value="x.stlFuelRatio ?? 0"
                max="1" />
            </div>
            <div :class="C.ProgressBar.container">
              <progress
                :class="[
                  C.ProgressBar.secondary,
                  C.ProgressBar.progress,
                  !x.isFtlCapable ? C.ProgressBar.warning : undefined,
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
    minmax(80px, 1fr) minmax(50px, auto) minmax(50px, auto);
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

.headerCell {
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
  padding: 2px;
  padding-bottom: 0;
}

.cargoCombinedSize {
  margin-top: 2px;
}

.colRepair {
  justify-content: center;
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
</style>
