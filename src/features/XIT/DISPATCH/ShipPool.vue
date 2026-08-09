<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import type { DispatchBaseConfig, DispatchShip } from '@src/features/XIT/DISPATCH/utils';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

const { ships, baseConfigs } = defineProps<{
  ships: DispatchShip[];
  baseConfigs: Record<string, DispatchBaseConfig>;
}>();

const assignedShipIds = computed(() => {
  const ids = new Set<string>();
  for (const config of Object.values(baseConfigs)) {
    if (config.ship) {
      ids.add(config.ship);
    }
  }
  return ids;
});

const unassigned = computed(() =>
  ships.filter(x => !assignedShipIds.value.has(x.ship.id)).sort(byShipLabel),
);
const assigned = computed(() =>
  ships.filter(x => assignedShipIds.value.has(x.ship.id)).sort(byShipLabel),
);

function shipLabel(entry: DispatchShip) {
  return entry.ship.name ?? entry.ship.registration;
}

function byShipLabel(a: DispatchShip, b: DispatchShip) {
  return shipLabel(a).localeCompare(shipLabel(b));
}

// Kept for the disabled ship tooltip (see template comment).
// Re-import fixed0/fixed01 from '@src/utils/format' when restoring.
/*
function compactCapacity(x: number) {
  return x >= 1000 ? fixed01(x / 1000) + 'k' : fixed0(x);
}

function freeCapacity(entry: DispatchShip) {
  const store = entry.cargoStore;
  if (!store) {
    return '--';
  }
  const weight = store.weightCapacity - store.weightLoad;
  const volume = store.volumeCapacity - store.volumeLoad;
  return `${compactCapacity(weight)}t/${compactCapacity(volume)}m³`;
}

function shipTooltip(entry: DispatchShip) {
  return freeCapacity(entry);
}
*/

function onDragStart(event: DragEvent, shipId: string) {
  event.dataTransfer?.setData('text/plain', shipId);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'copyMove';
  }
  const button = (event.currentTarget as HTMLElement).querySelector('button');
  if (button && event.dataTransfer) {
    event.dataTransfer.setDragImage(button, button.offsetWidth / 2, button.offsetHeight / 2);
  }
}
</script>

<template>
  <div :class="$style.pool">
    <table :class="$style.table">
      <thead>
        <tr>
          <th>{{ getI18nValue('RP.DISPATCH.poolShips', 'Ships') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="unassigned.length > 0" :class="$style.labelRow">
          <td :class="$style.labelCell">{{
            getI18nValue('RP.DISPATCH.poolUnassigned', 'Unassigned')
          }}</td>
        </tr>
        <tr v-for="entry in unassigned" :key="entry.ship.id" :class="$style.shipRow">
          <td :class="$style.shipCell">
            <!-- Tooltip disabled: it bled into the drag image. Restore with :data-tooltip="shipTooltip(entry)". -->
            <div
              :class="$style.shipWrap"
              draggable="true"
              @dragstart="onDragStart($event, entry.ship.id)">
              <PrunButton primary :class="$style.shipButton">
                {{ shipLabel(entry) }}
              </PrunButton>
            </div>
          </td>
        </tr>
        <tr v-if="assigned.length > 0" :class="$style.labelRow">
          <td :class="$style.labelCell">{{
            getI18nValue('RP.DISPATCH.poolAssigned', 'Assigned')
          }}</td>
        </tr>
        <tr v-for="entry in assigned" :key="entry.ship.id" :class="$style.shipRow">
          <td :class="$style.shipCell">
            <!-- Tooltip disabled: it bled into the drag image. Restore with :data-tooltip="shipTooltip(entry)". -->
            <div
              :class="$style.shipWrap"
              draggable="true"
              @dragstart="onDragStart($event, entry.ship.id)">
              <PrunButton primary :class="$style.shipButton">
                {{ shipLabel(entry) }}
              </PrunButton>
            </div>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style module>
.pool {
  width: max-content;
  min-width: 10ch;
  max-width: 15ch;
  flex: 0 0 auto;
  border-left: 1px solid #2b485a;
  box-sizing: border-box;
}

.table {
  border-collapse: collapse;
  width: 100%;
}

.table thead tr {
  border-bottom: 1px solid #2b485a;
  box-sizing: border-box;
}

.table thead th {
  text-align: center;
}

.shipRow {
  height: 24px;
  box-sizing: border-box;
  border-bottom: 1px solid #2b485a;
}

.shipCell {
  padding: 3px 2px;
  height: 24px;
  box-sizing: border-box;
}

.shipWrap {
  width: 100%;
  height: 100%;
  cursor: grab;
}

.shipButton {
  width: 100%;
  height: 100%;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0 4px;
  font-size: 11px;
  pointer-events: none;
  box-sizing: border-box;
}

.labelRow {
  height: 24px;
  box-sizing: border-box;
  border-bottom: 1px solid #2b485a;
}

.labelCell {
  font-size: 11px;
  color: #888;
  text-align: center;
  padding: 0 4px;
  height: 24px;
  vertical-align: middle;
  box-sizing: border-box;
}
</style>
