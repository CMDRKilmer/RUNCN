<script setup lang="ts">
// 基地别名后缀组件：在行星名后渲染「（别名）」。
// 传入 siteId 或 naturalId 均可解析（优先 siteId）。
// userData.baseAliases 是响应式对象，改名后自动更新。

import { getBaseAlias } from '@src/core/base-aliases';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';

const { siteId, naturalId } = defineProps<{
  siteId?: string;
  naturalId?: string;
}>();

const alias = computed(() => {
  if (siteId) {
    return getBaseAlias(siteId);
  }
  if (naturalId) {
    const site = sitesStore.getByPlanetNaturalId(naturalId);
    if (site) {
      return getBaseAlias(site.siteId);
    }
  }
  return undefined;
});
</script>

<template>
  <span v-if="alias" :class="$style.alias">（{{ alias }}）</span>
</template>

<style module>
.alias {
  color: #888;
  margin-left: 4px;
}
</style>
