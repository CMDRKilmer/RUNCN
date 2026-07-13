<script setup lang="ts">
import ProductionRow from './ProductionRow.vue';
import { PlanetProduction } from '@src/core/production';
import { useTileState } from './tile-state';
import { matchesProductionFilter, isLowEfficiency } from './utils';

const { production, headers } = defineProps<{ production: PlanetProduction; headers?: boolean }>();

const displayProduction = useTileState('production');
const queue = useTileState('queue');
const inactive = useTileState('inactive');
const notQueued = useTileState('notQueued');
const lowEff = useTileState('lowEff');

const filteredProduction = computed(() => {
  return production.production
    .toSorted((a, b) => b.capacity - a.capacity)
    .filter(x => {
      if (
        !matchesProductionFilter(x, {
          production: displayProduction.value,
          inactive: inactive.value,
          queue: queue.value,
          notQueued: notQueued.value,
        })
      ) {
        return false;
      }
      if (lowEff.value && !isLowEfficiency(x)) {
        return false;
      }
      return true;
    });
});
</script>

<template>
  <ProductionRow
    v-for="line in filteredProduction"
    :key="line.id"
    :production-line="line"
    :headers="headers" />
</template>
