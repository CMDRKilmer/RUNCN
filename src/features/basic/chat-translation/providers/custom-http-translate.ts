import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';
import { errorForStatus, fetchWithTimeout } from '../security';

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
    if (!url.startsWith('https://')) {
      throw new TranslationError('自定义翻译 API 地址必须使用 HTTPS 协议。', false);
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (providerConfig.apiKey) headers['Authorization'] = `Bearer ${providerConfig.apiKey}`;

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ q: request.text, target: request.targetLanguage }),
      },
      '自定义翻译服务',
    );

    if (!response.ok) {
      throw errorForStatus('自定义翻译服务', response.status);
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
