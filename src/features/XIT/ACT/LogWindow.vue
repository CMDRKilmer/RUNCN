<script setup lang="ts">
import { objectId } from '@src/utils/object-id';
import { LogTag } from '@src/features/XIT/ACT/runner/logger';

const { messages, scrolling } = defineProps<{
  messages: { tag: LogTag; message: string }[];
  scrolling: boolean;
}>();

const $style = useCssModule();

const logElement = useTemplateRef('log');

watch(
  () => messages,
  () => {
    if (messages.length === 0 || !scrolling) {
      return;
    }
    if (logElement.value) {
      nextTick(() =>
        logElement.value?.scrollTo({ top: logElement.value.scrollHeight, behavior: 'smooth' }),
      );
    }
  },
  { deep: true },
);

function getTagClass(tag: LogTag) {
  switch (tag) {
    case 'ACTION':
    case 'SUCCESS':
      return $style.success;
    case 'WARNING':
    case 'SKIP':
      return $style.warning;
    case 'ERROR':
    case 'CANCEL':
      return $style.failure;
    case 'SUMMARY':
      return $style.summary;
  }
  return undefined;
}

// 将日志消息拆分为文本段；超过 10% 的涨跌幅百分比以红/绿色显示。
const deviationRegex = /([+-])([\d.]+)%/g;
const deviationThresholdPct = 10;

function parseMessage(message: string) {
  const segments: { text: string; class?: string }[] = [];
  let lastIndex = 0;
  for (const match of message.matchAll(deviationRegex)) {
    const start = match.index ?? 0;
    const sign = match[1];
    const value = parseFloat(match[2]);
    if (Number.isNaN(value) || Math.abs(value) <= deviationThresholdPct) {
      continue;
    }
    if (start > lastIndex) {
      segments.push({ text: message.slice(lastIndex, start) });
    }
    const deviationClass = sign === '+' ? $style.priceHigh : $style.priceLow;
    segments.push({
      text: `${sign}${match[2]}%`,
      class: `${$style.deviation} ${deviationClass}`,
    });
    lastIndex = start + match[0].length;
  }
  if (lastIndex < message.length) {
    segments.push({ text: message.slice(lastIndex) });
  }
  return segments;
}

const parsedMessages = computed(() => messages.map(m => parseMessage(m.message)));
</script>

<template>
  <div ref="log" :class="[$style.log, C.fonts.fontRegular]">
    <div v-for="(message, idx) in messages" :key="objectId(message)">
      <b v-if="message.tag" :class="getTagClass(message.tag)">{{ message.tag }}: </b>
      <template v-for="(segment, i) in parsedMessages[idx]" :key="i">
        <span :class="segment.class">{{ segment.text }}</span>
      </template>
    </div>
  </div>
</template>

<style module>
.log {
  margin-top: 5px;
  margin-left: 4px;
  overflow-y: scroll;
  font-size: 11px;
  line-height: 1.5;
  background-color: #23282b;
  color: #bbbbbb;
  border: 1px solid #2b485a;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    width: 0;
  }

  &:focus {
    outline: none;
  }
}

.success {
  color: #5cb85c;
}

.failure {
  color: #d9534f;
}

.warning {
  color: #f7a600;
}

.deviation {
  font-weight: 700;
}

.priceHigh {
  color: rgb(217, 83, 79);
}

.priceLow {
  color: rgb(92, 184, 92);
}
</style>
