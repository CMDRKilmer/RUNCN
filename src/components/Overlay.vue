<script setup lang="ts">
const {
  props = {},
  dismissible = true,
  onClose,
} = defineProps<{
  child: Component;
  onClose: () => void;
  // false = 点内容区外部不关闭。长流程对话框（如原生 RT 自动填写）用：误点会让组件卸载、
  // 正在跑的后台任务被中断。
  dismissible?: boolean;
  props?: object | null;
}>();

function requestClose() {
  if (dismissible) {
    onClose();
  }
}
</script>

<template>
  <div :class="C.Overlay.overlay">
    <div :class="C.Overlay.close" @click="requestClose" />
    <div :class="C.Overlay.children">
      <Component :is="child" v-bind="props" @close="onClose" />
    </div>
    <div :class="C.Overlay.close" @click="requestClose" />
  </div>
</template>
