<script setup lang="ts">
import NativeRouteDialog from './NativeRouteDialog.vue';
import { stagedNativeRoute } from './native-route-staged';

// 恢复窗口时，由玩家决定是否继续写入。
function onStarted() {
  if (stagedNativeRoute.value !== undefined) {
    stagedNativeRoute.value = { ...stagedNativeRoute.value, autoStart: false };
  }
}
</script>

<template>
  <div v-if="stagedNativeRoute === undefined" :class="$style.hint">
    暂无待创建的原生 RT。请打开 XIT FLEET，在「规划中」点「生成原生 RT」。
  </div>
  <NativeRouteDialog
    v-else
    :key="stagedNativeRoute.sessionId"
    :candidate="stagedNativeRoute.candidate"
    :initial-waypoints="stagedNativeRoute.waypoints"
    :chain-name="stagedNativeRoute.chainName"
    :checked-route="stagedNativeRoute.checkedRoute"
    :auto-start="stagedNativeRoute.autoStart === true"
    :loop-plan="stagedNativeRoute.loop"
    @started="onStarted"
    @close="stagedNativeRoute = undefined" />
</template>

<style module>
.hint {
  padding: 12px;
}
</style>
