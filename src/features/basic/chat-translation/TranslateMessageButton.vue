<script setup lang="ts">
import fa from '@src/utils/font-awesome.module.css';
import PrunButton from '@src/components/PrunButton.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { userData } from '@src/store/user-data';
import { getLanguageLabel } from './languages';
import { translate } from './translate';
import { TranslationError, type TranslationResult as TResult } from './types';
import TranslationResult from './TranslationResult.vue';

const { text } = defineProps<{ text: string }>();

type State = 'idle' | 'loading' | 'done' | 'error';
const state = ref<State>('idle');
const result = ref<TResult | null>(null);
const error = ref<TranslationError | null>(null);

const enabled = computed(() => userData.settings.translation.enabled);
const targetLabel = computed(() => getLanguageLabel(userData.settings.translation.targetLanguage));
const tooltip = computed(() => `翻译成${targetLabel.value}`);

async function onClick() {
  if (state.value === 'loading') {
    return;
  }
  state.value = 'loading';
  error.value = null;
  try {
    result.value = await translate({
      text,
      targetLanguage: userData.settings.translation.targetLanguage,
    });
    state.value = 'done';
  } catch (e) {
    error.value = e instanceof TranslationError ? e : new TranslationError(String(e));
    state.value = 'error';
  }
}

function onRestore() {
  state.value = 'idle';
  result.value = null;
}
</script>

<template>
  <span v-if="enabled" :class="$style.root">
    <button
      v-if="state !== 'done'"
      type="button"
      :class="[C.Button.btn, C.Button.inline, $style.button]"
      :data-tooltip="tooltip"
      data-tooltip-position="top"
      :disabled="state === 'loading'"
      @click="onClick">
      <span :class="fa.solid">\uf0ac</span>
      <span v-if="state === 'loading'"><LoadingSpinner /></span>
      <span v-else>翻译</span>
    </button>
    <template v-if="state === 'error'">
      <span :class="$style.error">{{ error!.message }}</span>
      <PrunButton v-if="error!.retryable" dark inline @click="onClick">重试</PrunButton>
    </template>
    <TranslationResult
      v-if="state === 'done' && result"
      :translated-text="result.translatedText"
      :detected-source-language="result.detectedSourceLanguage"
      @restore="onRestore" />
  </span>
</template>

<style module>
.root {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 6px;
}

.button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.error {
  color: #d9534f;
  font-size: 12px;
}
</style>
