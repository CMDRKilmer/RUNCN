<script setup lang="ts">
import PrunLink from '@src/components/PrunLink.vue';
</script>

<template>
  <div :class="$style.hint">
    原生航线向导已并入 FLEET。打开 <PrunLink inline command="XIT FLEET" />，在「产业链环线」的
    「规划中」点「生成原生 RT」。
  </div>
</template>

<style module>
.hint {
  padding: 12px;
}
</style>
