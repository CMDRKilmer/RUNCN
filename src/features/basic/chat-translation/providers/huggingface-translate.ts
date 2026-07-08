import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';
import { errorForStatus, fetchWithTimeout } from '../security';

export const huggingfaceTranslateProvider: TranslationProvider = {
  id: 'HUGGINGFACE',
  name: 'Hugging Face Inference API',
  requiresApiKey: true,

  async translate(
    request: TranslationRequest,
    settings: UserData.TranslationSettings,
  ): Promise<TranslationResult> {
    const providerConfig = settings.providerConfigs.HUGGINGFACE ?? {
      apiKey: '',
      apiUrl: '',
      apiModel: '',
    };
    // Expect providerConfig.apiUrl to be a full model endpoint, e.g.
    // https://api-inference.huggingface.co/models/Helsinki-NLP/opus-mt-en-zh
    const url = (providerConfig.apiUrl || '').replace(/\/+$/, '');
    if (!url) {
      throw new TranslationError('未配置 Hugging Face 模型 API 地址。', false);
    }
    if (!url.startsWith('https://')) {
      throw new TranslationError('Hugging Face API 地址必须使用 HTTPS 协议。', false);
    }
    if (!providerConfig.apiKey) {
      throw new TranslationError('未配置 Hugging Face API 密钥。', false);
    }

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${providerConfig.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inputs: request.text }),
      },
      'Hugging Face',
    );

    if (!response.ok) {
      throw errorForStatus('Hugging Face', response.status);
    }

    const data = await response.json();
    // Possible responses: [{ generated_text: '...' }] or [{ translation_text: '...' }] or { translations: [...] } or plain string
    if (Array.isArray(data) && data[0] && typeof data[0].generated_text === 'string') {
      return { translatedText: data[0].generated_text };
    }
    if (Array.isArray(data) && data[0] && typeof data[0].translation_text === 'string') {
      return { translatedText: data[0].translation_text };
    }
    if (isTranslationResponse(data)) {
      const firstTranslation = data.translations[0];
      if (firstTranslation !== undefined && firstTranslation !== null) {
        return { translatedText: firstTranslation.text };
      }
    }
    if (typeof data === 'string') {
      return { translatedText: data };
    }

    throw new TranslationError('Hugging Face 未返回可识别的翻译结果。');
  },
};

function isTranslationResponse(value: unknown): value is { translations: Array<{ text: string }> } {
  if (value === null || typeof value !== 'object' || !('translations' in value)) {
    return false;
  }

  const translations = (value as Record<string, unknown>).translations;
  if (!Array.isArray(translations) || translations.length === 0) {
    return false;
  }

  const firstTranslation = translations[0];
  return (
    typeof firstTranslation === 'object' &&
    firstTranslation !== null &&
    'text' in firstTranslation &&
    typeof (firstTranslation as Record<string, unknown>).text === 'string'
  );
}
