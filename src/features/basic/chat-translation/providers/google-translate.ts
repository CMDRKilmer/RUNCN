import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';
import { errorForStatus, fetchWithTimeout } from '../security';

export const googleTranslateProvider: TranslationProvider = {
  id: 'GOOGLE',
  name: 'Google Translate (API)',
  requiresApiKey: true,

  async translate(
    request: TranslationRequest,
    settings: UserData.TranslationSettings,
  ): Promise<TranslationResult> {
    const providerConfig = settings.providerConfigs.GOOGLE ?? {
      apiKey: '',
      apiUrl: '',
      apiModel: '',
    };
    if (!providerConfig.apiKey) {
      throw new TranslationError('未配置 Google API 密钥。', false);
    }
    // Pass the API key via the X-Goog-Api-Key header rather than a URL
    // query param. Query strings leak into browser history, proxy logs,
    // Referer headers and any fetch/XHR monkey-patch on the page.
    const url = 'https://translation.googleapis.com/language/translate/v2';
    const body = {
      q: request.text,
      target: request.targetLanguage,
      format: 'text',
    };

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': providerConfig.apiKey,
        },
        body: JSON.stringify(body),
      },
      'Google Translate',
    );
    if (!response.ok) {
      throw errorForStatus('Google Translate', response.status);
    }
    const data = (await response.json()) as {
      data?: { translations?: { translatedText?: string; detectedSourceLanguage?: string }[] };
    };
    const translation = data.data?.translations?.[0];
    if (!translation?.translatedText) {
      throw new TranslationError('Google 翻译未返回有效结果。');
    }
    return {
      translatedText: translation.translatedText,
      detectedSourceLanguage: translation.detectedSourceLanguage,
    };
  },
};
