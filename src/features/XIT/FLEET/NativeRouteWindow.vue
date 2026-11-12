<script setup lang="ts">
import NativeRouteDialog from './NativeRouteDialog.vue';
import { stagedNativeRoute } from './native-route-staged';
</script>

<template>
  <div v-if="stagedNativeRoute === undefined" :class="$style.hint">
    暂无待创建的原生 RT。请打开 XIT FLEET，选择产业链分组并点「生成原生 RT」。
  </div>
  <NativeRouteDialog
    v-else
    :key="stagedNativeRoute.candidate.ship.ship.id"
    :candidate="stagedNativeRoute.candidate"
    :initial-waypoints="stagedNativeRoute.waypoints"
    :chain-name="stagedNativeRoute.chainName"
    @close="stagedNativeRoute = undefined" />
</template>

<style module>
.hint {
  padding: 12px;
}
</style>
