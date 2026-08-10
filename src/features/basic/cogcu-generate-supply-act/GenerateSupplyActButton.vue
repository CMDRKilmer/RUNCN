<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import GenerateSupplyActDialog from './GenerateSupplyActDialog.vue';
import { showTileOverlay } from '@src/infrastructure/prun-ui/tile-overlay';

const { planet } = defineProps<{ planet?: string }>();

function onClick(ev: Event) {
  showTileOverlay(ev, GenerateSupplyActDialog, { planet });
}
</script>

<template>
  <PrunButton primary @click="onClick">生成补给ACT</PrunButton>
</template>
