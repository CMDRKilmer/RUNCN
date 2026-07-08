import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';

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

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': providerConfig.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new TranslationError('网络错误：无法连接到 Google 翻译服务。');
    }
    if (!response.ok) {
      throw new TranslationError(`Google 翻译错误：${response.status} ${response.statusText}`);
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
