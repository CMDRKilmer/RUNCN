import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';

export const deepTranslateProvider: TranslationProvider = {
  id: 'DEEP',
  name: 'DeepL (API)',
  requiresApiKey: true,

  async translate(
    request: TranslationRequest,
    settings: UserData.TranslationSettings,
  ): Promise<TranslationResult> {
    const providerConfig = settings.providerConfigs.DEEP ?? {
      apiKey: '',
      apiUrl: '',
      apiModel: '',
    };
    if (!providerConfig.apiKey) {
      throw new TranslationError('未配置 DeepL API 密钥。', false);
    }
    // Free keys end with ':fx' and must use the free host.
    const host = providerConfig.apiKey.endsWith(':fx')
      ? 'https://api-free.deepl.com'
      : 'https://api.deepl.com';
    const url = `${host}/v2/translate`;
    const params = new URLSearchParams();
    params.set('auth_key', providerConfig.apiKey);
    params.set('text', request.text);
    params.set('target_lang', request.targetLanguage.toUpperCase());

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
    } catch (e) {
      throw new TranslationError('网络错误：无法连接到 DeepL 服务。');
    }
    if (!response.ok) {
      throw new TranslationError(`DeepL 错误：${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as {
      translations?: { text?: string; detected_source_language?: string }[];
    };
    const translation = data.translations?.[0];
    if (!translation?.text) {
      throw new TranslationError('DeepL 未返回有效结果。');
    }
    return {
      translatedText: translation.text,
      detectedSourceLanguage: translation.detected_source_language,
    };
  },
};
