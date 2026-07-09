<script setup lang="ts">
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
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
const showMicrosoftApiSettings = computed(() => settings.value.provider === 'MICROSOFT');
const showHfSettings = computed(() => settings.value.provider === 'HUGGINGFACE');
const showCustomSettings = computed(() => settings.value.provider === 'CUSTOM');

const LLM_PROVIDER_IDS = new Set<UserData.TranslationProviderId>([
  'DEEPSEEK',
  'MINIMAX',
  'ZHIPU',
  'QWEN',
  'MOONSHOT',
  'ERNIE',
  'HUNYUAN',
  'LINGYI',
  'STEPFUN',
  'OPENAI_LLM',
  'ANTHROPIC',
  'GEMINI',
]);
const showLlmSettings = computed(() => LLM_PROVIDER_IDS.has(settings.value.provider));

const presetOptions = [
  { label: 'Azure (Global)', value: 'AZURE_GLOBAL' },
  { label: 'Azure (China)', value: 'AZURE_CHINA' },
  { label: '自定义', value: 'CUSTOM' },
];

const currentProviderConfig = computed(
  () => settings.value.providerConfigs[settings.value.provider],
);

function ensureAllProviderConfigs() {
  for (const provider of ALL_PROVIDERS) {
    if (settings.value.providerConfigs[provider.id] === undefined) {
      settings.value.providerConfigs[provider.id] = { apiKey: '', apiUrl: '', apiModel: '' };
    }
    const config = settings.value.providerConfigs[provider.id]!;
    if (LLM_PROVIDER_IDS.has(provider.id)) {
      if (!config.apiUrl && provider.defaultUrl) {
        config.apiUrl = provider.defaultUrl;
      }
      if (!config.apiModel && provider.defaultModel) {
        config.apiModel = provider.defaultModel;
      }
    }
  }
}

ensureAllProviderConfigs();

async function onChange() {
  await saveUserData();
}
</script>

<template>
  <SectionHeader>翻译设置</SectionHeader>
  <div v-if="showLlmSettings" :class="$style.llmWarning">
    <strong>⚠ 内容将发送到第三方 LLM 服务</strong>
    <div :class="$style.llmWarningBody">
      你选中的翻译服务（{{
        currentProvider?.name ?? settings.provider
      }}）会将你点击翻译的聊天原文发送到该服务商的服务器以获取翻译结果。
      请勿翻译包含账号密码、支付信息等高度敏感内容。
    </div>
  </div>
  <div v-if="showCustomSettings" :class="$style.llmWarning">
    <strong>⚠ 请仅使用您完全信任的 API 地址</strong>
    <div :class="$style.llmWarningBody"> 自定义接口将以您的身份发送请求。 </div>
  </div>
  <form>
    <Active label="启用翻译功能" tooltip="关闭后所有翻译按钮将隐藏。">
      <input v-model="settings.enabled" type="checkbox" @change="onChange" />
    </Active>
    <Active
      label="翻译服务"
      tooltip="选择翻译服务提供商。Microsoft Translator 需要 Azure 订阅密钥。">
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
    <Active label="输入翻译目标语言" tooltip="仅用于输入框翻译的目标语言（可与上方不同）。">
      <SelectInput
        v-model="settings.inputTargetLanguage"
        :options="languageOptions"
        @update:model-value="onChange" />
    </Active>
    <Active
      v-if="showMicrosoftApiSettings"
      label="API 入口"
      tooltip="选择 Azure 翻译服务入口或使用自定义地址。">
      <SelectInput
        v-model="settings.apiPreset"
        :options="presetOptions"
        @update:model-value="onChange" />
      <TextInput
        v-if="settings.apiPreset === 'CUSTOM'"
        v-model="currentProviderConfig.apiUrl"
        @keyup.enter="onChange"
        @focusout="onChange" />
    </Active>
    <Active
      v-if="showMicrosoftApiSettings"
      label="API 区域"
      tooltip="Azure 资源所在区域（需要时填写，例如 eastasia）。">
      <TextInput v-model="settings.apiRegion" @keyup.enter="onChange" @focusout="onChange" />
    </Active>
    <Active
      v-if="showHfSettings"
      label="Hugging Face API"
      tooltip="填写模型 API 地址（完整 endpoint）。">
      <TextInput
        v-model="currentProviderConfig.apiUrl"
        @keyup.enter="onChange"
        @focusout="onChange" />
    </Active>
    <Active v-if="showCustomSettings" label="自定义 API" tooltip="填写自定义翻译 API 地址。">
      <TextInput
        v-model="currentProviderConfig.apiUrl"
        @keyup.enter="onChange"
        @focusout="onChange" />
    </Active>
    <Active
      v-if="showLlmSettings"
      label="API 地址"
      tooltip="切换服务商时自动填充默认地址，可填写自定义代理或兼容端点。">
      <TextInput
        v-model="currentProviderConfig.apiUrl"
        @keyup.enter="onChange"
        @focusout="onChange" />
    </Active>
    <Active
      v-if="showLlmSettings"
      label="模型"
      tooltip="切换服务商时自动填充默认模型，可填写该服务商支持的其他模型名。">
      <TextInput
        v-model="currentProviderConfig.apiModel"
        @keyup.enter="onChange"
        @focusout="onChange" />
    </Active>
    <Active
      v-if="showApiKey"
      label="API 密钥"
      tooltip="所选翻译服务所需的 API 密钥。密钥保存在本地，不会上传。每个服务商独立保存。">
      <TextInput
        v-model="currentProviderConfig.apiKey"
        type="password"
        @keyup.enter="onChange"
        @focusout="onChange" />
    </Active>
    <Active label="译文颜色" tooltip="译文文本的颜色（CSS 颜色值），默认绿色。">
      <input v-model="settings.translatedColor" type="color" @input="onChange" />
      <span
        :style="{
          display: 'inline-block',
          width: '18px',
          height: '18px',
          'margin-left': '8px',
          'vertical-align': 'middle',
          'border-radius': '3px',
          background: settings.translatedColor,
        }"></span>
    </Active>
    <Active label="显示原文" tooltip="翻译后是否在消息中同时显示原文。">
      <input v-model="settings.showOriginal" type="checkbox" @change="onChange" />
    </Active>
  </form>
  <SectionHeader>
    说明
    <Tooltip :class="$style.tooltip" tooltip="所有翻译均为显式触发，不会自动翻译任何内容。" />
  </SectionHeader>
  <div :class="$style.note">
    翻译功能仅在用户点击翻译按钮时调用翻译服务，不会自动发送任何聊天内容。 API
    接口与密钥在此处填写，密钥保存在本地浏览器存储中。
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

.llmWarning {
  margin: 8px 0;
  padding: 8px 10px;
  border-left: 3px solid #d9822b;
  background: rgba(217, 130, 43, 0.12);
  color: #d9822b;
  font-size: 12px;
  line-height: 1.5;
}

.llmWarningBody {
  margin-top: 4px;
  color: #b3b3b3;
}

.customWarning {
  margin-bottom: 6px;
  padding: 6px 8px;
  border-left: 3px solid #d9822b;
  background: rgba(217, 130, 43, 0.12);
  color: #d9822b;
  font-size: 12px;
  line-height: 1.4;
}
</style>
