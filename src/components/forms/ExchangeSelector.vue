<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';

const { options, deselectable } = defineProps<{ options: string[]; deselectable?: boolean }>();
const model = defineModel<string>();

function onClick(opt: string) {
  // deselectable 时再次点击已选中的选项取消选择
  if (deselectable && model.value === opt) {
    model.value = undefined;
  } else {
    model.value = opt;
  }
}
</script>

<template>
  <div :class="$style.row">
    <PrunButton
      v-for="opt in options"
      :key="opt"
      :primary="model === opt"
      :dark="model !== opt"
      @click="onClick(opt)">
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
