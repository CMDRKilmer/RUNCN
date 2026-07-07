<script setup lang="ts">
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import Tooltip from '@src/components/Tooltip.vue';
import { userData } from '@src/store/user-data';
import { saveUserData } from '@src/infrastructure/storage/user-data-serializer';
import { TRANSLATION_LANGUAGES } from '@src/features/basic/chat-translation/languages';
import { ALL_PROVIDERS } from '@src/features/basic/chat-translation/providers';

const settings = computed(() => userData.settings.translation);

const providerOptions = ALL_PROVIDERS.map(p => ({ label: p.name, value: p.id }));

const languageOptions = TRANSLATION_LANGUAGES.map(l => ({ label: l.label, value: l.code }));

const currentProvider = computed(() => ALL_PROVIDERS.find(p => p.id === settings.value.provider));
const showApiKey = computed(() => currentProvider.value?.requiresApiKey ?? false);
const showApiUrl = computed(() => settings.value.provider === 'LIBRE');

async function onChange() {
  await saveUserData();
}
</script>

<template>
  <SectionHeader>翻译设置</SectionHeader>
  <form>
    <Active label="启用翻译功能" tooltip="关闭后所有翻译按钮将隐藏。">
      <input type="checkbox" v-model="settings.enabled" @change="onChange" />
    </Active>
    <Active label="翻译服务" tooltip="选择翻译服务提供商。LibreTranslate 为免费/自建服务。">
      <SelectInput
        v-model="settings.provider"
        :options="providerOptions"
        @update:model-value="onChange" />
    </Active>
    <Active label="目标语言" tooltip="所有翻译结果的目标语言。你的选择会被记住。">
      <SelectInput
        v-model="settings.targetLanguage"
        :options="languageOptions"
        @update:model-value="onChange" />
    </Active>
    <Active
      v-if="showApiUrl"
      label="LibreTranslate 地址"
      tooltip="自建或公共 LibreTranslate 实例地址。留空使用默认公共实例。">
      <TextInput v-model="settings.apiUrl" @keyup.enter="onChange" @focusout="onChange" />
    </Active>
    <Active
      v-if="showApiKey"
      label="API 密钥"
      tooltip="所选翻译服务所需的 API 密钥。密钥保存在本地，不会上传。">
      <TextInput v-model="settings.apiKey" @keyup.enter="onChange" @focusout="onChange" />
    </Active>
    <Active label="结果字体大小" tooltip="翻译结果显示区域的字体大小（像素）。">
      <NumberInput v-model="settings.fontSize" @update:model-value="onChange" />
    </Active>
    <Active label="结果背景颜色" tooltip="翻译结果显示区域的背景颜色（CSS 颜色值）。">
      <TextInput v-model="settings.backgroundColor" @keyup.enter="onChange" @focusout="onChange" />
    </Active>
  </form>
  <SectionHeader>
    说明
    <Tooltip :class="$style.tooltip" tooltip="所有翻译均为显式触发，不会自动翻译任何内容。" />
  </SectionHeader>
  <div :class="$style.note">
    翻译功能仅在用户点击翻译按钮时调用翻译服务，不会自动发送任何聊天内容。 API
    密钥保存在本地浏览器存储中。
  </div>
</template>

<style module>
.tooltip {
  float: revert;
  font-size: 12px;
  margin-top: -4px;
}

.note {
  padding: 6px 8px;
  color: #999;
  font-size: 12px;
  line-height: 1.5;
}
</style>
