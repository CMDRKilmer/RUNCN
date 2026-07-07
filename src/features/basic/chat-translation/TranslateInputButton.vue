<script setup lang="ts">
import fa from '@src/utils/font-awesome.module.css';
import PrunButton from '@src/components/PrunButton.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import Tooltip from '@src/components/Tooltip.vue';
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
const targetLabel = computed(() =>
  getLanguageLabel(
    userData.settings.translation.inputTargetLanguage ||
      userData.settings.translation.targetLanguage,
  ),
);
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
      targetLanguage:
        userData.settings.translation.inputTargetLanguage ||
        userData.settings.translation.targetLanguage,
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

// 将按钮内嵌到输入框：在挂载时调整父容器和输入框内边距，卸载时恢复
let parentOriginalPosition: string | null = null;
let inputOriginalPaddingRight: string | null = null;
onMounted(() => {
  const parent = input.parentElement;
  if (!parent) return;
  const style = window.getComputedStyle(parent);
  if (style.position === 'static') {
    parentOriginalPosition = parent.style.position || null;
    parent.style.position = 'relative';
  }
  const inpStyle = window.getComputedStyle(input);
  inputOriginalPaddingRight = input.style.paddingRight || null;
  const extra = 42; // 留出按钮宽度
  const current = parseFloat(inpStyle.paddingRight || '0');
  input.style.paddingRight = `${current + extra}px`;
});

onUnmounted(() => {
  const parent = input.parentElement;
  if (parent && parentOriginalPosition !== null) {
    parent.style.position = parentOriginalPosition;
  }
  if (inputOriginalPaddingRight !== null) {
    input.style.paddingRight = inputOriginalPaddingRight;
  }
});
</script>

<template>
  <span v-if="enabled" :class="[$style.root, $style.inInput]">
    <PrunButton
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

.inInput {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 2;
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
