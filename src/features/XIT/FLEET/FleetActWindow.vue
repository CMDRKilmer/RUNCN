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
  <ExecuteActionPackage v-else :key="pkgKey" :pkg="stagedDispatch.pkg" />
</template>
