<script setup lang="ts">
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';

// display：可选的外显文字。传入后整项只显示这段文字（不再拼 cmd / label），
// 点击仍然打开 cmd 指定的命令；用于把「XIT NX : 快捷买油」这类外显改成
// 纯中文「快捷买油」，同时保持命令本身不变。
const props = defineProps<{ cmd: string; label?: string; display?: string }>();

const commandParts = computed(() => {
  const words = props.cmd.split(' ');
  let command = words.shift();
  if (command === 'XIT') {
    command += ' ' + words.shift();
  }
  return [command, words.join(' ')];
});

const itemClasses = [C.ContextControls.item, C.fonts.fontRegular, C.type.typeSmall];
</script>

<template>
  <!-- 节点结构完全复制自 PrUn，不用在意冗余节点。 -->
  <div :class="itemClasses" @click="() => showBuffer(cmd)">
    <span v-if="display">
      <span :class="C.ContextControls.cmd">{{ display }}</span>
    </span>
    <span v-else>
      <span :class="C.ContextControls.cmd">{{ commandParts[0] }}</span>
      {{ commandParts[1] }}
    </span>
    <span v-if="label && !display" :class="C.ContextControls.label">: {{ label }}</span>
  </div>
</template>
