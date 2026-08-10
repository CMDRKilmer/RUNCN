<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import { showTileOverlay } from '@src/infrastructure/prun-ui/tile-overlay';
import GeneratePurchaseDraftDialog from './GeneratePurchaseDraftDialog.vue';

const { tile } = defineProps<{ tile: PrunTile }>();

function onClick(event: Event) {
  showTileOverlay(event, GeneratePurchaseDraftDialog, { tile });
}
</script>

<template>
  <PrunButton data-rp-contd-purchase-draft-button dark @click="onClick">采购草案</PrunButton>
</template>
