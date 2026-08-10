<script setup lang="ts">
import { computed } from 'vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { getShipStatusIcon, stationaryShipStatusIcon } from '@src/core/ship-status-icons';
import {
  getEntityNameFromAddress,
  getLocationLineFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';

const props = defineProps<{
  shipId: string;
}>();

const ship = computed(() => shipsStore.getById(props.shipId));
const flight = computed(() => flightsStore.getById(ship.value?.flightId));

const statusIcon = computed(() => {
  if (!ship.value) {
    return '';
  }
  if (!flight.value) {
    return stationaryShipStatusIcon;
  }
  const segment = flight.value.segments[flight.value.currentSegmentIndex];
  return segment != null ? getShipStatusIcon(segment.type) : stationaryShipStatusIcon;
});

const posData = computed(() => {
  const address = flight.value?.destination ?? ship.value?.address ?? undefined;
  const location = getLocationLineFromAddress(address);
  const prefix = location?.type === 'STATION' ? 'STNS' : 'PLI';
  return {
    name: getEntityNameFromAddress(address) ?? address?.lines[0]?.entity?.naturalId ?? '',
    command: `${prefix} ${location?.entity.naturalId}`,
  };
});
</script>

<template>
  <div :class="$style.container">
    <span
      :class="$style.link"
      data-tooltip="打开飞行控制"
      data-tooltip-position="right"
      @click.stop="showBuffer(`SFC ${ship?.registration}`)"
      >{{ statusIcon }}</span
    >
    <span :class="[C.Link.link, $style.link]" @click.stop="showBuffer(posData.command)">
      {{ posData.name }}
    </span>
  </div>
</template>

<style module>
.container {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.link {
  color: #3fa2de;
  cursor: pointer;
}
</style>
