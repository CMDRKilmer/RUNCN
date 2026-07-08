import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';
import { buildTranslationPrompt } from './llm-openai-compat';

const DEFAULT_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-3-5-haiku-latest';

export const anthropicTranslateProvider: TranslationProvider = {
  id: 'ANTHROPIC',
  name: 'Anthropic Claude',
  requiresApiKey: true,
  defaultUrl: DEFAULT_URL,
  defaultModel: DEFAULT_MODEL,

  async translate(
    request: TranslationRequest,
    settings: UserData.TranslationSettings,
  ): Promise<TranslationResult> {
    const providerConfig = settings.providerConfigs.ANTHROPIC ?? {
      apiKey: '',
      apiUrl: '',
      apiModel: '',
    };
    if (!providerConfig.apiKey) {
      throw new TranslationError('未配置 Anthropic API 密钥。', false);
    }
    const url = (providerConfig.apiUrl || DEFAULT_URL).replace(/\/+$/, '');
    const model = providerConfig.apiModel || DEFAULT_MODEL;
    const prompt = buildTranslationPrompt(request.targetLanguage);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'x-api-key': providerConfig.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system: prompt,
          messages: [{ role: 'user', content: request.text }],
        }),
      });
    } catch (e) {
      throw new TranslationError(`网络错误：无法连接到 Anthropic。${formatErr(e)}`);
    }

    if (!response.ok) {
      throw new TranslationError(`Anthropic 返回错误：${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const textBlock = data.content?.find(x => x.type === 'text');
    if (typeof textBlock?.text !== 'string') {
      throw new TranslationError('Anthropic 未返回可识别的翻译结果。');
    }
    const translatedText = textBlock.text.trim();
    if (translatedText.length === 0) {
      throw new TranslationError('Anthropic 返回了空结果。');
    }
    return { translatedText };
  },
};

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
