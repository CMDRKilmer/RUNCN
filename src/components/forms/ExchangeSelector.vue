<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';

const { options } = defineProps<{ options: string[] }>();
const model = defineModel<string>();
</script>

<template>
  <div :class="$style.row">
    <PrunButton
      v-for="opt in options"
      :key="opt"
      :primary="model === opt"
      :dark="model !== opt"
      @click="model = opt">
      {{ opt }}
    </PrunButton>
  </div>
</template>

<style module>
.row {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
</style>
