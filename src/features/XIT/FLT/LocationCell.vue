<script setup lang="ts">
import { computed } from 'vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import {
  getEntityNaturalIdFromAddress,
  getLocationLineFromAddress,
  isStationLine,
} from '@src/infrastructure/prun-api/data/addresses';

const props = withDefaults(
  defineProps<{
    shipId: string;
    mode?: 'location' | 'destination';
  }>(),
  { mode: 'destination' },
);

const ship = computed(() => shipsStore.getById(props.shipId));
const flight = computed(() => flightsStore.getById(ship.value?.flightId));

// In destination mode, only the active flight's destination counts.
// A parked/stationary ship has no destination — falling back to the ship's
// current address caused parked ships to show their location as the "destination".
const address = computed(() =>
  props.mode === 'location' ? (ship.value?.address ?? undefined) : flight.value?.destination,
);

const posData = computed(() => {
  const target = address.value;
  const location = getLocationLineFromAddress(target);
  const naturalId = getEntityNaturalIdFromAddress(target) ?? '';
  const isStation = isStationLine(location);
  const isOrbit = target?.lines?.some(line => line.type === 'ORBIT') ?? false;
  const prefix = isStation ? 'STNS' : 'PLI';
  let name: string;
  if (isStation) {
    name = naturalId;
  } else if (!naturalId) {
    name = '';
  } else {
    name = `${naturalId} ${isOrbit ? '(环绕轨道)' : '(着陆)'}`;
  }
  return {
    name,
    command: naturalId ? `${prefix} ${naturalId}` : '',
  };
});
</script>

<template>
  <span v-if="posData.command" :class="[C.Link.link]" @click.stop="showBuffer(posData.command)">
    {{ posData.name }}
  </span>
</template>
