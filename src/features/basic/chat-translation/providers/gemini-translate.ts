import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';
import { buildTranslationPrompt } from './llm-openai-compat';

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
    const prompt = buildTranslationPrompt(request.targetLanguage);

    let response: Response;
    try {
      response = await fetch(`${url}?key=${encodeURIComponent(providerConfig.apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: prompt }] },
          contents: [{ role: 'user', parts: [{ text: request.text }] }],
          generationConfig: { temperature: 0 },
        }),
      });
    } catch (e) {
      throw new TranslationError(`网络错误：无法连接到 Google Gemini。${formatErr(e)}`);
    }

    if (!response.ok) {
      throw new TranslationError(
        `Google Gemini 返回错误：${response.status} ${response.statusText}`,
      );
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

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
