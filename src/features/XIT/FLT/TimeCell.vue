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
          <svg
            :class="$style.iconSvg"
            viewBox="0 0 16 16"
            fill="currentColor"
            fill-rule="evenodd"
            aria-hidden="true">
            <path
              d="M1 2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v8a2 2 0 0 1 2 2v.5a.5.5 0 0 0 1 0V8h-.5a.5.5 0 0 1-.5-.5V4.375a.5.5 0 0 1 .5-.5h1.495c-.011-.476-.053-.894-.201-1.222a.97.97 0 0 0-.394-.458c-.184-.11-.464-.195-.9-.195a.5.5 0 0 1 0-1q.846-.002 1.412.336c.383.228.634.551.794.907.295.655.294 1.465.294 2.081V7.5a.5.5 0 0 1-.5.5H15v3.275a1.5 1.5 0 0 1-1.393 1.496q-.144.018-.293.025a.5.5 0 0 1-.5-.5V10.5a1.5 1.5 0 0 0-1.5-1.5V11a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm7 7V3H2v6zm0 1H2v1a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-1zM2 1a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V2a1 1 0 0 0-1-1H2z" />
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
