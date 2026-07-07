<script setup lang="ts">
import CopyButton from '@src/components/CopyButton.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { userData } from '@src/store/user-data';
import { getLanguageLabel } from './languages';

const { translatedText, detectedSourceLanguage } = defineProps<{
  translatedText: string;
  detectedSourceLanguage?: string;
}>();

const emit = defineEmits<{ (e: 'restore'): void }>();

const settings = computed(() => userData.settings.translation);

const label = computed(() => {
  const target = getLanguageLabel(settings.value.targetLanguage);
  const source = detectedSourceLanguage ? getLanguageLabel(detectedSourceLanguage) : null;
  return source ? `[已翻译：${source} → ${target}]` : `[已翻译：${target}]`;
});

const DEFAULT_FONT_SIZE = 14;
const DEFAULT_BACKGROUND = '#2a2a2a';

const containerStyle = computed(() => ({
  fontSize: `${DEFAULT_FONT_SIZE}px`,
  backgroundColor: DEFAULT_BACKGROUND,
}));
</script>

<template>
  <div :class="$style.result" :style="containerStyle">
    <div :class="$style.label">{{ label }}</div>
    <div :class="$style.text">{{ translatedText }}</div>
    <div :class="$style.actions">
      <CopyButton :copy-fn="() => translatedText" />
      <PrunButton dark inline @click="emit('restore')">还原</PrunButton>
    </div>
  </div>
</template>

<style module>
.result {
  margin-top: 4px;
  padding: 6px 8px;
  border-left: 3px solid #6db3f0;
  border-radius: 2px;
  color: #d6d6d6;
  word-break: break-word;
}

.label {
  font-size: 11px;
  color: #8ab6e0;
  margin-bottom: 4px;
}

.text {
  white-space: pre-wrap;
}

.actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
</style>
