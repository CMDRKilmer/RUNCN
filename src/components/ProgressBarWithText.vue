<script setup lang="ts">
import { computed } from 'vue';
import { getProgressClass } from '@src/features/XIT/CONTS/utils';

const props = defineProps<{
  current: number;
  total: number;
  showText?: boolean;
}>();

const progress = computed(() => {
  if (props.total === 0) {
    return 0;
  }
  return Math.round((props.current / props.total) * 100);
});

const progressClass = computed(() => getProgressClass(progress.value));

const displayText = computed(() => `${props.current}/${props.total}`);
</script>

<template>
  <div :class="$style.container">
    <div :class="$style.progressBar">
      <div
        :class="[$style.progressFill, $style[progressClass]]"
        :style="{ width: progress + '%' }"></div>
    </div>
    <span v-if="showText" :class="$style.progressText">{{ displayText }}</span>
  </div>
</template>

<style module>
.container {
  display: flex;
  align-items: center;
  gap: 6px;
}

.progressBar {
  flex: 1;
  height: 6px;
  background: rgba(255, 255, 255, 0.1);
  border-radius: 3px;
  min-width: 40px;
}

.progressFill {
  height: 100%;
  border-radius: 3px;
  background: var(--rp-color-green);
  transition: width 0.3s ease;
}

.progressFill.active {
  background: var(--rp-color-orange);
}

.progressFill.pending {
  background: var(--rp-color-text);
}

.progressText {
  font-size: 11px;
  white-space: nowrap;
}
</style>
