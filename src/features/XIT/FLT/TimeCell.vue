<script setup lang="ts">
import { computed, ref } from 'vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { flightsStore } from '@src/infrastructure/prun-api/data/flights';
import { displaytimeBetween, hhmm } from '@src/utils/format';
import { timestampEachMinute } from '@src/utils/dayjs';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { getInvStore } from '@src/core/store-id';
import { useTile } from '@src/hooks/use-tile';
import QuickRefuelDialog from '@src/features/basic/shpf-quick-refuel/QuickRefuelDialog.vue';
import { createFragmentApp } from '@src/utils/vue-fragment-app';

const props = defineProps<{
  shipId: string;
}>();

const ship = computed(() => shipsStore.getById(props.shipId));
const flight = computed(() => flightsStore.getById(ship.value?.flightId));
const inventory = computed(() => getInvStore(ship.value?.idShipStore));
const tile = useTile();

const timeData = computed(() => {
  const arrival = flight.value?.arrival.timestamp;
  if (arrival == null || Number.isNaN(arrival)) {
    return null;
  }
  return {
    relative: displaytimeBetween(timestampEachMinute.value, arrival),
    absolute: hhmm(arrival),
  };
});

const hasItems = computed(() => (inventory.value?.items.length ?? 0) > 0);
const isRefueling = ref(false);

function onRefuel() {
  if (!ship.value || isRefueling.value) {
    return;
  }

  isRefueling.value = true;
  const container = document.createElement('div');
  container.style.display = 'none';
  document.body.appendChild(container);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    isRefueling.value = false;
    fragmentApp.unmount();
    container.remove();
  };
  const fragmentApp = createFragmentApp(QuickRefuelDialog, {
    onDone: cleanup,
    registration: ship.value.registration,
    silent: true,
    tile,
  });
  fragmentApp.appendTo(container);
}
</script>

<template>
  <div :class="$style.container">
    <template v-if="timeData">
      <div :class="$style.timeColumn" @click.stop="showBuffer(`SFC ${ship?.registration}`)">
        <span style="color: #99d5ff">{{ timeData.relative }}</span>
        <span style="color: #888">({{ timeData.absolute }})</span>
      </div>
    </template>
    <template v-else>
      <div :class="$style.actions">
        <span
          :class="[$style.actionBtn, hasItems ? $style.bgOrange : $style.bgBlue]"
          :style="{ paddingRight: '5px' }"
          @click.stop="showBuffer(`SHPI ${ship?.registration}`)">
          {{ hasItems ? '⭱' : '⭳' }}
        </span>
        <span
          :class="[$style.actionBtn, $style.bgGreen]"
          @click.stop="showBuffer(`SFC ${ship?.registration}`)">
          ✈
        </span>
        <span
          :class="[$style.actionBtn, $style.bgFuel, isRefueling && $style.disabled]"
          data-tooltip="加油"
          data-tooltip-position="left"
          @click.stop="onRefuel">
          <svg :class="$style.iconSvg" viewBox="0 0 640 640" fill="currentColor" aria-hidden="true">
            <path
              d="M64 96c0-17.7 14.3-32 32-32l160 0c17.7 0 32 14.3 32 32l0 384c0 17.7-14.3 32-32 32L96 512c-17.7 0-32-14.3-32-32L64 96zm160 64c0-8.8-7.2-16-16-16l-64 0c-8.8 0-16 7.2-16 16l0 32c0 8.8 7.2 16 16 16l64 0c8.8 0 16-7.2 16-16l0-32zm0 128c0-8.8-7.2-16-16-16l-64 0c-8.8 0-16 7.2-16 16l0 32c0 8.8 7.2 16 16 16l64 0c8.8 0 16-7.2 16-16l0-32zm0 128c0-8.8-7.2-16-16-16l-64 0c-8.8 0-16 7.2-16 16l0 32c0 8.8 7.2 16 16 16l64 0c8.8 0 16-7.2 16-16l0-32zM352 128l96 0c35.3 0 64 28.7 64 64l0 176c0 8.8 7.2 16 16 16s16-7.2 16-16l0-176c0-35.3 28.7-64 64-64l0 64c-17.7 0-32 14.3-32 32l0 144c0 44.2-35.8 80-80 80s-80-35.8-80-80l0-176z" />
          </svg>
        </span>
      </div>
    </template>
  </div>
</template>

<style module>
.container {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  text-align: right;
  cursor: pointer;
}

.timeColumn {
  display: flex;
  flex-direction: column;
}

.actions {
  display: flex;
  flex-direction: row;
  gap: 4px;
}

.actionBtn {
  font-size: 15px;
  height: 20px;
  width: 20px;
  padding: 2px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: white;
  line-height: 1;
}

.bgOrange {
  background-color: #f7a600;
}

.bgBlue {
  background-color: #43a4df;
}

.bgGreen {
  background-color: #5cb85c;
}

.bgFuel {
  background-color: #8a6d3b;
  font-size: 14px;
  padding-top: 3px;
}

.iconSvg {
  width: 12px;
  height: 12px;
  display: block;
  color: white;
}

.disabled {
  opacity: 0.5;
  cursor: wait;
}
</style>
