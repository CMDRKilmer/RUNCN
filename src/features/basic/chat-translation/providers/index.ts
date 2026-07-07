import type { TranslationProvider } from '../types';
import { libreTranslateProvider } from './libre-translate';
import { googleTranslateProvider } from './google-translate';
import { deepTranslateProvider } from './deep-translate';

const PROVIDERS: Record<UserData.TranslationProviderId, TranslationProvider> = {
  LIBRE: libreTranslateProvider,
  GOOGLE: googleTranslateProvider,
  DEEP: deepTranslateProvider,
};

export const ALL_PROVIDERS: TranslationProvider[] = [
  libreTranslateProvider,
  googleTranslateProvider,
  deepTranslateProvider,
];

export function getProvider(id: UserData.TranslationProviderId): TranslationProvider {
  return PROVIDERS[id];
}
