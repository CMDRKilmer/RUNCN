<script setup lang="ts">
import { useXitParameters } from '@src/hooks/use-xit-parameters';
import { useTile } from '@src/hooks/use-tile';
import ExecuteActionPackage from '@src/features/XIT/ACT/ExecuteActionPackage.vue';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getEntityNameFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { configurableValue } from '@src/features/XIT/ACT/shared-types';

// Join all parameters in case a naturalId was split on underscores by the XIT router.
const parameters = useXitParameters();
const naturalId = parameters.join(' ');

const tile = useTile();

onMounted(async () => {
  await nextTick();
  const windowEl = tile.frame.closest(`.${C.Window.window}`) as HTMLElement | null;
  const bodyEl = windowEl ? (_$(windowEl, C.Window.body) as HTMLElement | null) : null;
  if (!bodyEl) {
    return;
  }
  let overflow = 0;
  for (const el of tile.anchor.querySelectorAll('*')) {
    const htmlEl = el as HTMLElement;
    overflow = Math.max(overflow, htmlEl.scrollHeight - htmlEl.clientHeight);
  }
  if (overflow > 0) {
    bodyEl.style.height = `${bodyEl.offsetHeight + overflow}px`;
  }
});

const site = computed(() => sitesStore.getByPlanetNaturalIdOrName(naturalId));
const planetName = computed(() =>
  site.value ? getEntityNameFromAddress(site.value.address) : undefined,
);

const pkg = computed(
  () =>
    ({
      global: { name: `Repair: ${planetName.value ?? naturalId}` },
      groups: [
        {
          type: 'Repair' as UserData.MaterialGroupType,
          name: 'Repair',
          planet: planetName.value,
          days: configurableValue,
          advanceDays: configurableValue,
        },
      ],
      actions: [
        {
          type: 'CX Buy' as UserData.ActionType,
          name: 'CX Buy',
          group: 'Repair',
          exchange: configurableValue,
          useCXInv: true,
          skippable: true,
        },
        {
          type: 'MTRA' as UserData.ActionType,
          name: 'MTRA',
          group: 'Repair',
          origin: configurableValue,
          dest: configurableValue,
        },
      ],
    }) as UserData.ActionPackageData,
);
</script>

<template>
  <div v-if="!planetName">Planet "{{ naturalId }}" not found.</div>
  <ExecuteActionPackage v-else :pkg="pkg" />
</template>
