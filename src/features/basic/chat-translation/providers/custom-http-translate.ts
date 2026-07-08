import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';

export const customHttpTranslateProvider: TranslationProvider = {
  id: 'CUSTOM',
  name: '自定义 HTTP 翻译接口',
  requiresApiKey: false,

  async translate(
    request: TranslationRequest,
    settings: UserData.TranslationSettings,
  ): Promise<TranslationResult> {
    const providerConfig = settings.providerConfigs.CUSTOM ?? {
      apiKey: '',
      apiUrl: '',
      apiModel: '',
    };
    const url = (providerConfig.apiUrl || '').replace(/\/+$/, '');
    if (!url) {
      throw new TranslationError('未配置自定义翻译 API 地址。', false);
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (providerConfig.apiKey) headers['Authorization'] = `Bearer ${providerConfig.apiKey}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ q: request.text, target: request.targetLanguage }),
      });
    } catch (e) {
      throw new TranslationError(`网络错误：无法连接到自定义翻译服务。${formatErr(e)}`);
    }

    if (!response.ok) {
      throw new TranslationError(
        `自定义翻译服务返回错误：${response.status} ${response.statusText}`,
      );
    }

    const data = await response.json();
    // Try common response shapes
    if (data.translatedText && typeof data.translatedText === 'string') {
      return { translatedText: data.translatedText };
    }
    if (data.translation && typeof data.translation === 'string') {
      return { translatedText: data.translation };
    }
    if (Array.isArray(data) && data[0] && typeof data[0].text === 'string') {
      return { translatedText: data[0].text };
    }
    if (typeof data === 'string') {
      return { translatedText: data };
    }

    throw new TranslationError('自定义翻译服务未返回可识别的翻译结果。');
  },
};

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
