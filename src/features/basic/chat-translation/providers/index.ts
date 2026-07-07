import type { TranslationProvider } from '../types';
import { microsoftTranslateProvider } from './microsoft-translate';
import { googleTranslateProvider } from './google-translate';
import { deepTranslateProvider } from './deep-translate';
import { huggingfaceTranslateProvider } from './huggingface-translate';
import { customHttpTranslateProvider } from './custom-http-translate';

const PROVIDERS: Record<UserData.TranslationProviderId, TranslationProvider> = {
  MICROSOFT: microsoftTranslateProvider,
  GOOGLE: googleTranslateProvider,
  DEEP: deepTranslateProvider,
  HUGGINGFACE: huggingfaceTranslateProvider,
  CUSTOM: customHttpTranslateProvider,
};

export const ALL_PROVIDERS: TranslationProvider[] = [
  microsoftTranslateProvider,
  googleTranslateProvider,
  deepTranslateProvider,
  huggingfaceTranslateProvider,
  customHttpTranslateProvider,
];

export function getProvider(id: UserData.TranslationProviderId): TranslationProvider {
  return PROVIDERS[id];
}
