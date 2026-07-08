import type { TranslationProvider } from '../types';
import { microsoftTranslateProvider } from './microsoft-translate';
import { googleTranslateProvider } from './google-translate';
import { deepTranslateProvider } from './deep-translate';
import { huggingfaceTranslateProvider } from './huggingface-translate';
import { customHttpTranslateProvider } from './custom-http-translate';
import {
  deepseekProvider,
  minimaxProvider,
  zhipuProvider,
  qwenProvider,
  moonshotProvider,
  ernieProvider,
  hunyuanProvider,
  lingyiProvider,
  stepfunProvider,
  openaiLlmProvider,
} from './llm-providers';
import { anthropicTranslateProvider } from './anthropic-translate';
import { geminiTranslateProvider } from './gemini-translate';

const PROVIDERS: Record<UserData.TranslationProviderId, TranslationProvider> = {
  MICROSOFT: microsoftTranslateProvider,
  GOOGLE: googleTranslateProvider,
  DEEP: deepTranslateProvider,
  HUGGINGFACE: huggingfaceTranslateProvider,
  CUSTOM: customHttpTranslateProvider,
  DEEPSEEK: deepseekProvider,
  MINIMAX: minimaxProvider,
  ZHIPU: zhipuProvider,
  QWEN: qwenProvider,
  MOONSHOT: moonshotProvider,
  ERNIE: ernieProvider,
  HUNYUAN: hunyuanProvider,
  LINGYI: lingyiProvider,
  STEPFUN: stepfunProvider,
  OPENAI_LLM: openaiLlmProvider,
  ANTHROPIC: anthropicTranslateProvider,
  GEMINI: geminiTranslateProvider,
};

export const ALL_PROVIDERS: TranslationProvider[] = [
  microsoftTranslateProvider,
  googleTranslateProvider,
  deepTranslateProvider,
  huggingfaceTranslateProvider,
  customHttpTranslateProvider,
  deepseekProvider,
  minimaxProvider,
  zhipuProvider,
  qwenProvider,
  moonshotProvider,
  ernieProvider,
  hunyuanProvider,
  lingyiProvider,
  stepfunProvider,
  openaiLlmProvider,
  anthropicTranslateProvider,
  geminiTranslateProvider,
];

export function getProvider(id: UserData.TranslationProviderId): TranslationProvider {
  return PROVIDERS[id];
}
