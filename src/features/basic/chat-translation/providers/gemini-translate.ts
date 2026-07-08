import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';
import { buildTranslationPrompt } from './llm-openai-compat';
import { errorForStatus, fetchWithTimeout } from '../security';

const DEFAULT_URL_TEMPLATE =
  'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent';
const DEFAULT_MODEL = 'gemini-2.5-flash';

export const geminiTranslateProvider: TranslationProvider = {
  id: 'GEMINI',
  name: 'Google Gemini',
  requiresApiKey: true,
  defaultUrl: DEFAULT_URL_TEMPLATE,
  defaultModel: DEFAULT_MODEL,

  async translate(
    request: TranslationRequest,
    settings: UserData.TranslationSettings,
  ): Promise<TranslationResult> {
    const providerConfig = settings.providerConfigs.GEMINI ?? {
      apiKey: '',
      apiUrl: '',
      apiModel: '',
    };
    if (!providerConfig.apiKey) {
      throw new TranslationError('未配置 Google Gemini API 密钥。', false);
    }
    const model = providerConfig.apiModel || DEFAULT_MODEL;
    const urlTemplate = providerConfig.apiUrl || DEFAULT_URL_TEMPLATE;
    const url = urlTemplate.replace('{model}', model).replace(/\/+$/, '');
    // Reject non-HTTPS overrides so the x-goog-api-key header cannot be sniffed.
    if (!url.startsWith('https://')) {
      throw new TranslationError('Google Gemini API 地址必须使用 HTTPS 协议。', false);
    }
    const prompt = buildTranslationPrompt(request.targetLanguage);

    const response = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': providerConfig.apiKey,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: prompt }] },
          contents: [{ role: 'user', parts: [{ text: request.text }] }],
          generationConfig: { temperature: 0 },
        }),
      },
      'Google Gemini',
    );

    if (!response.ok) {
      throw errorForStatus('Google Gemini', response.status);
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') {
      throw new TranslationError('Google Gemini 未返回可识别的翻译结果。');
    }
    const translatedText = text.trim();
    if (translatedText.length === 0) {
      throw new TranslationError('Google Gemini 返回了空结果。');
    }
    return { translatedText };
  },
};
