<script setup lang="ts">
import fa from '@src/utils/font-awesome.module.css';
import PrunButton from '@src/components/PrunButton.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import Tooltip from '@src/components/Tooltip.vue';
import { userData } from '@src/store/user-data';
import { getLanguageLabel } from './languages';
import { translate } from './translate';
import { TranslationError } from './types';

const { text, textElement } = defineProps<{ text: string; textElement: HTMLElement }>();

type State = 'idle' | 'loading' | 'done' | 'error';
const state = ref<State>('idle');
const error = ref<TranslationError | null>(null);
const originalText = ref(text);
const translatedText = ref('');
const truncated = ref(false);
let translatedNode: HTMLElement | null = null;
let originalNode: HTMLElement | null = null;

const enabled = computed(() => userData.settings.translation.enabled);
const showOriginal = computed(() => userData.settings.translation.showOriginal);
const targetLabel = computed(() => getLanguageLabel(userData.settings.translation.targetLanguage));
const tooltip = computed(() => `翻译成${targetLabel.value}`);

function clearRenderedNodes() {
  if (translatedNode) {
    translatedNode.remove();
    translatedNode = null;
  }
  if (originalNode) {
    originalNode.remove();
    originalNode = null;
  }
}

function renderTranslatedText(nextText: string) {
  translatedText.value = nextText;
  if (!showOriginal.value) {
    clearRenderedNodes();
    textElement.textContent = nextText;
    textElement.style.color = userData.settings.translation.translatedColor || '';
    return;
  }

  const parent = textElement;
  clearRenderedNodes();
  parent.textContent = '';

  const t = document.createElement('div');
  t.style.whiteSpace = 'pre-wrap';
  t.textContent = nextText;
  t.style.color = userData.settings.translation.translatedColor || '';

  const o = document.createElement('div');
  o.style.marginTop = '6px';
  o.style.fontSize = '12px';
  o.style.opacity = '0.8';
  o.style.whiteSpace = 'pre-wrap';
  o.textContent = `原文：${originalText.value}`;

  parent.appendChild(t);
  parent.appendChild(o);

  translatedNode = t;
  originalNode = o;
}

watch(showOriginal, () => {
  if (state.value === 'done') {
    renderTranslatedText(translatedText.value);
  }
});

async function onClick() {
  if (state.value === 'loading') {
    return;
  }
  state.value = 'loading';
  error.value = null;
  try {
    const result = await translate({
      text,
      targetLanguage: userData.settings.translation.targetLanguage,
    });
    truncated.value = result.truncated === true;
    renderTranslatedText(result.translatedText);
    state.value = 'done';
  } catch (e) {
    // TranslateMessageButton renders error.message into the DOM. If a
    // non-TranslationError reaches us (e.g. a raw TypeError from fetch
    // that mentions URLs/CORS state) we surface a generic message
    // instead so we never leak internal detail into the chat UI.
    error.value =
      e instanceof TranslationError ? e : new TranslationError('翻译失败，请稍后重试。');
    state.value = 'error';
  }
}

function onRestore() {
  textElement.textContent = originalText.value;
  state.value = 'idle';
  error.value = null;
  truncated.value = false;
}
</script>

<template>
  <span v-if="enabled" :class="$style.root">
    <PrunButton
      v-if="state !== 'done'"
      dark
      inline
      :class="$style.button"
      :aria-label="tooltip"
      :disabled="state === 'loading'"
      @click="onClick">
      <span :class="fa.solid">&#xf0ac;</span>
      <span v-if="state === 'loading'"><LoadingSpinner /></span>
    </PrunButton>
    <Tooltip v-if="state !== 'done'" :tooltip="tooltip" position="top" />
    <template v-if="state === 'error'">
      <span :class="$style.error">{{ error!.message }}</span>
      <PrunButton v-if="error!.retryable" dark inline @click="onClick">重试</PrunButton>
    </template>
    <PrunButton v-if="state === 'done'" dark inline @click="onRestore">恢复原文</PrunButton>
    <span v-if="state === 'done' && truncated" :class="$style.warning"
      >⚠ 已截断（仅翻译前 2000 字符）</span
    >
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

.warning {
  color: #d9822b;
  font-size: 11px;
}
</style>
