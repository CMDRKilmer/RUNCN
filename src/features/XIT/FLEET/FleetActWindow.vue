<script setup lang="ts">
import ExecuteActionPackage from '@src/features/XIT/ACT/ExecuteActionPackage.vue';
import { stagedDispatch } from '@src/features/XIT/FLEET/staged';

// 新暂存批次替换时重建执行实例，避免沿用前一批的 runner/config。
const pkgKey = ref(0);
watch(
  () => stagedDispatch.value,
  () => {
    pkgKey.value += 1;
  },
);
</script>

<template>
  <div v-if="!stagedDispatch">暂无暂存内容。请打开 XIT FLEET 并点击执行。</div>
  <div v-else-if="stagedDispatch.pkgs" :class="$style.list">
    <ExecuteActionPackage
      v-for="p in stagedDispatch.pkgs"
      :key="`${pkgKey}:${p.global.name}`"
      :pkg="p" />
  </div>
  <ExecuteActionPackage v-else :key="pkgKey" :pkg="stagedDispatch.pkg!" />
</template>

<style module>
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
