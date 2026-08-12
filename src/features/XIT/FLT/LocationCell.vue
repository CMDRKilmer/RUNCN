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

const props = defineProps<{
  shipId: string;
}>();

const ship = computed(() => shipsStore.getById(props.shipId));
const flight = computed(() => flightsStore.getById(ship.value?.flightId));

const posData = computed(() => {
  const address = flight.value?.destination ?? ship.value?.address ?? undefined;
  const location = getLocationLineFromAddress(address);
  const naturalId = getEntityNaturalIdFromAddress(address) ?? '';
  const isStation = isStationLine(location);
  const isOrbit = address?.lines?.some(line => line.type === 'ORBIT') ?? false;
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
    command: `${prefix} ${naturalId}`,
  };
});
</script>

<template>
  <span :class="[C.Link.link]" @click.stop="showBuffer(posData.command)">
    {{ posData.name }}
  </span>
</template>
