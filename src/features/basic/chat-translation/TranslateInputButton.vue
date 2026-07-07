<script setup lang="ts">
import fa from '@src/utils/font-awesome.module.css';
import PrunButton from '@src/components/PrunButton.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { changeInputValue } from '@src/util';
import { userData } from '@src/store/user-data';
import { getLanguageLabel } from './languages';
import { translate } from './translate';
import { TranslationError } from './types';

const { input } = defineProps<{ input: HTMLInputElement }>();

type State = 'idle' | 'loading' | 'done' | 'error';
const state = ref<State>('idle');
const errorMsg = ref('');
const originalCache = ref<string | null>(null);

const enabled = computed(() => userData.settings.translation.enabled);
const targetLabel = computed(() => getLanguageLabel(userData.settings.translation.targetLanguage));
const tooltip = computed(() => `翻译输入为${targetLabel.value}`);

async function onClick() {
  if (state.value === 'loading') {
    return;
  }
  const value = input.value.trim();
  if (value.length === 0) {
    state.value = 'error';
    errorMsg.value = '输入框为空。';
    return;
  }
  state.value = 'loading';
  errorMsg.value = '';
  try {
    // Cache the original the first time we translate in this session.
    if (originalCache.value === null) {
      originalCache.value = input.value;
    }
    const result = await translate({
      text: value,
      targetLanguage: userData.settings.translation.targetLanguage,
    });
    changeInputValue(input, result.translatedText);
    state.value = 'done';
  } catch (e) {
    errorMsg.value = e instanceof TranslationError ? e.message : String(e);
    state.value = 'error';
  }
}

function onRestore() {
  if (originalCache.value !== null) {
    changeInputValue(input, originalCache.value);
    originalCache.value = null;
  }
  state.value = 'idle';
  errorMsg.value = '';
}
</script>

<template>
  <span v-if="enabled" :class="$style.root">
    <button
      type="button"
      :class="[C.Button.btn, C.Button.inline, $style.button]"
      :data-tooltip="tooltip"
      data-tooltip-position="top"
      :disabled="state === 'loading'"
      @click="onClick">
      <span :class="fa.solid">\uf1ab</span>
      <span v-if="state === 'loading'"><LoadingSpinner /></span>
      <span v-else>翻译输入</span>
    </button>
    <PrunButton v-if="state === 'done' && originalCache !== null" dark inline @click="onRestore">
      恢复原始输入
    </PrunButton>
    <PrunButton v-if="state === 'error'" dark inline @click="onClick">重试</PrunButton>
    <span v-if="state === 'error'" :class="$style.error">{{ errorMsg }}</span>
  </span>
</template>

<style module>
.root {
  display: inline-flex;
  align-items: center;
  gap: 6px;
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
