import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';

function mapLang(code: string): string {
  // Map simple codes to Azure Translator codes where necessary
  switch (code) {
    case 'zh':
      return 'zh-Hans';
    case 'zh-TW':
      return 'zh-Hant';
    default:
      return code;
  }
}

export const microsoftTranslateProvider: TranslationProvider = {
  id: 'MICROSOFT',
  name: 'Microsoft Translator (Azure)',
  requiresApiKey: true,

  async translate(
    request: TranslationRequest,
    settings: UserData.TranslationSettings,
  ): Promise<TranslationResult> {
    const providerConfig = settings.providerConfigs.MICROSOFT ?? {
      apiKey: '',
      apiUrl: '',
      apiModel: '',
    };
    const preset = settings.apiPreset || 'AZURE_GLOBAL';
    let baseUrl = '';
    if (preset === 'CUSTOM') {
      baseUrl = (providerConfig.apiUrl || '').replace(/\/+$/, '');
      if (!baseUrl) {
        throw new TranslationError('自定义 API 地址为空。', false);
      }
    } else if (preset === 'AZURE_CHINA') {
      baseUrl = 'https://api.cognitive.chinacloudapi.cn';
    } else {
      baseUrl = 'https://api.cognitive.microsofttranslator.com';
    }

    const to = mapLang(request.targetLanguage);
    const url = `${baseUrl}/translate?api-version=3.0&to=${encodeURIComponent(to)}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Ocp-Apim-Subscription-Key': providerConfig.apiKey,
    };
    if (settings.apiRegion) {
      headers['Ocp-Apim-Subscription-Region'] = settings.apiRegion;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify([{ Text: request.text }]),
      });
    } catch (e) {
      throw new TranslationError(`网络错误：无法连接到翻译服务。${formatErr(e)}`);
    }

    if (!response.ok) {
      throw new TranslationError(`翻译服务返回错误：${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as Array<{
      translations?: Array<{ text?: string; to?: string }>;
      detectedLanguage?: { language?: string };
    }>;

    // Response shape validation
    if (
      !Array.isArray(data) ||
      data.length === 0 ||
      !Array.isArray(data[0].translations) ||
      data[0].translations.length === 0 ||
      typeof data[0].translations[0].text !== 'string'
    ) {
      throw new TranslationError('翻译服务未返回有效结果。');
    }

    return {
      translatedText: data[0].translations[0].text,
      detectedSourceLanguage: data[0].detectedLanguage?.language,
    };
  },
};

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
