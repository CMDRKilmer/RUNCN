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
          <svg :class="$style.iconSvg" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path
              d="M5 1a1 1 0 0 0-1 1v2H3a1 1 0 0 0-1 1v6.5L1 11.5a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-1l-1.013-1.013A1.5 1.5 0 0 1 7.5 8.5V7l-.79-.79A1.5 1.5 0 0 1 6 4.96V3a1 1 0 0 0-1-1zm9 0a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1v3.5a1.5 1.5 0 0 1-3 0V8.5a3 3 0 0 0-1-2.22V3.5a2.5 2.5 0 0 1 5 0V8a.5.5 0 0 0 1 0V3a3 3 0 0 0-3-3zM4 3h2v1H4zm0 2h2v1H4zm0 3h2v1H4z" />
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
  background-color: #c0392b;
  font-size: 14px;
  padding-top: 3px;
}

.iconSvg {
  width: 14px;
  height: 14px;
  display: block;
  color: white;
}

.disabled {
  opacity: 0.5;
  cursor: wait;
}
</style>
