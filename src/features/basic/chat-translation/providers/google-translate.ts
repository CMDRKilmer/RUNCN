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
    if (!settings.apiKey) {
      throw new TranslationError('未配置 Google API 密钥。', false);
    }
    const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(settings.apiKey)}`;
    const body = {
      q: request.text,
      target: request.targetLanguage,
      format: 'text',
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new TranslationError(`网络错误：${formatErr(e)}`);
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

function formatErr(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}
