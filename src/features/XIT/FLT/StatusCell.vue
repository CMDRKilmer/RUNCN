<script setup lang="ts">
import { computed } from 'vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { getShipStatusLabel } from '@src/core/ship-status-icons';

const props = defineProps<{
  shipId: string;
}>();

const ship = computed(() => shipsStore.getById(props.shipId));
const flight = computed(() => flightsStore.getById(ship.value?.flightId));

const statusText = computed(() => {
  if (!ship.value) {
    return '';
  }
  if (!flight.value) {
    return '静止';
  }
  const segment = flight.value.segments[flight.value.currentSegmentIndex];
  return segment != null ? getShipStatusLabel(segment.type) : '静止';
});
</script>

<template>
  <span
    :class="$style.link"
    data-tooltip="打开飞行控制"
    data-tooltip-position="right"
    @click.stop="showBuffer(`SFC ${ship?.registration}`)"
    >{{ statusText }}</span
  >
</template>

<style module>
.link {
  color: #3fa2de;
  cursor: pointer;
}
</style>
