import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';

export const libreTranslateProvider: TranslationProvider = {
  id: 'LIBRE',
  name: 'LibreTranslate (免费)',
  requiresApiKey: false,

  async translate(
    request: TranslationRequest,
    settings: UserData.TranslationSettings,
  ): Promise<TranslationResult> {
    const baseUrl = (settings.apiUrl || 'https://translate.argosopentech.com').replace(/\/+$/, '');
    const url = `${baseUrl}/translate`;
    const body = {
      q: request.text,
      source: 'auto',
      target: request.targetLanguage,
      format: 'text',
    };
    // Public instances accept an optional api_key for self-hosted rate-limit relief.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey) {
      (body as { api_key?: string }).api_key = settings.apiKey;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new TranslationError(`网络错误：无法连接到翻译服务。${formatErr(e)}`);
    }
    if (!response.ok) {
      throw new TranslationError(`翻译服务返回错误：${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as { translatedText?: string };
    if (!data.translatedText) {
      throw new TranslationError('翻译服务未返回有效结果。');
    }
    return { translatedText: data.translatedText };
  },
};

function formatErr(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}
