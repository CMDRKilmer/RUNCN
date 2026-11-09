<script setup lang="ts">
import ExecuteActionPackage from '@src/features/XIT/ACT/ExecuteActionPackage.vue';
import { stagedDispatch } from '@src/features/XIT/FLEET/staged';

// stagedDispatch.pkg 是新对象时（Plan/Chain 模式任一执行覆盖），
// ExecuteActionPackage 内部的 ActionRunner/watch 不会自动重建。
// 用 :key 强制重挂载，确保新主包被实际渲染、可预览、可执行。
// key 必须随对象**身份**变化：直接把 pkg 对象交给 :key，Vue 会把它字符串化成
// "[object Object]"，每个包都得到同一个 key，等于没有 key（重挂载从未发生）。
const pkgKey = ref(0);
watch(
  () => stagedDispatch.value?.pkg,
  () => {
    pkgKey.value += 1;
  },
);
</script>

<template>
  <div v-if="!stagedDispatch">暂无暂存内容。请打开 XIT FLEET 并点击执行。</div>
  <div v-else-if="stagedDispatch.pkgs" :class="$style.list">
    <ExecuteActionPackage v-for="p in stagedDispatch.pkgs" :key="p.global.name" :pkg="p" />
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
