<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import QuickRefuelDialog from './QuickRefuelDialog.vue';
import { showTileOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { createFragmentApp } from '@src/utils/vue-fragment-app';

const props = defineProps<{
  dark?: boolean;
  direct?: boolean;
  id?: string | null;
  inline?: boolean;
  label?: string;
  registration?: string;
  tile: PrunTile;
}>();

const registration = computed(
  () => props.registration ?? shipsStore.getById(props.id)?.registration,
);
const label = computed(() => props.label ?? '一键加油');
const isRunning = ref(false);

function runDirectRefuel() {
  if (!registration.value || isRunning.value) {
    return;
  }

  isRunning.value = true;
  const container = document.createElement('div');
  container.style.display = 'none';
  document.body.appendChild(container);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    isRunning.value = false;
    fragmentApp.unmount();
    container.remove();
  };
  const fragmentApp = createFragmentApp(QuickRefuelDialog, {
    onDone: cleanup,
    registration: registration.value,
    silent: true,
    tile: props.tile,
  });
  fragmentApp.appendTo(container);
}

function onClick(ev: Event) {
  if (!registration.value || isRunning.value) {
    return;
  }

  if (props.direct) {
    runDirectRefuel();
    return;
  }

  showTileOverlay(ev, QuickRefuelDialog, { registration: registration.value, tile: props.tile });
}
</script>

<template>
  <PrunButton
    v-if="registration"
    :disabled="isRunning"
    :dark="dark"
    :inline="inline"
    :primary="!dark"
    @click="onClick">
    {{ label }}
  </PrunButton>
</template>
