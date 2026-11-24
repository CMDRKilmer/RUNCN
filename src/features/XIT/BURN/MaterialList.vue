<script setup lang="ts">
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import MaterialRow from '@src/features/XIT/BURN/MaterialRow.vue';
import type { BurnReportSection } from '@src/features/XIT/BURN/utils';
import { sortMaterials } from '@src/core/sort-materials';

const { burn } = defineProps<{ burn: BurnReportSection }>();

const materials = computed(() => Object.keys(burn.burn).map(materialsStore.getByTicker));
const sorted = computed(() => sortMaterials(materials.value.filter(x => x !== undefined)));
</script>

<template>
  <MaterialRow
    v-for="material in sorted"
    :key="material.id"
    :burn="burn.burn[material.ticker]"
    :material="material"
    :natural-id="burn.naturalId" />
</template>
