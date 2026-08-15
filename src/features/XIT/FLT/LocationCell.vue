<script setup lang="ts">
import { computed } from 'vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import BaseAlias from '@src/components/BaseAlias.vue';
import {
  getEntityNaturalIdFromAddress,
  getLocationLineFromAddress,
  getSystemLineFromAddress,
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

// The "location" column shows where the ship is RIGHT NOW: for a ship that's
// actively flying, the SFC tile reports the current segment's origin as the
// current position. Mid-flight legs like JUMP/CHARGE carry an ORBIT-only
// origin (no PLANET/STATION line), so we walk a fallback chain — current
// segment → first segment → flight origin → ship.address — to guarantee the
// column is never blank.
const currentSegment = computed(() =>
  flight.value ? flight.value.segments[flight.value.currentSegmentIndex] : undefined,
);

const firstSegment = computed(() => flight.value?.segments[0]);

// Destination column matches SFC's header "目的地" field — the FINAL flight
// destination (LANDING segment), not the current segment.
const address = computed(() => {
  if (props.mode === 'destination') {
    return flight.value?.destination;
  }
  return (
    currentSegment.value?.origin ??
    firstSegment.value?.origin ??
    flight.value?.origin ??
    ship.value?.address ??
    undefined
  );
});

const posData = computed(() => {
  const target = address.value;
  const location = getLocationLineFromAddress(target);
  const systemLine = getSystemLineFromAddress(target);
  const isStation = isStationLine(location);
  const isOrbit = target?.lines?.some(line => line.type === 'ORBIT') ?? false;

  // Prefer the PLANET/STATION naturalId when available. If the address is
  // orbit-only or system-only (e.g. mid-JUMP), fall back to the SYSTEM
  // naturalId so the column never renders blank.
  let naturalId = getEntityNaturalIdFromAddress(target) ?? '';
  let prefix = isStation ? 'STNS' : 'PLI';
  if (!naturalId) {
    naturalId = systemLine?.entity.naturalId ?? '';
    prefix = 'SYS';
  }

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
    naturalId,
  };
});
</script>

<template>
  <span v-if="posData.command" :class="[C.Link.link]" @click.stop="showBuffer(posData.command)">
    {{ posData.name }}
    <BaseAlias :natural-id="posData.naturalId" />
  </span>
</template>
