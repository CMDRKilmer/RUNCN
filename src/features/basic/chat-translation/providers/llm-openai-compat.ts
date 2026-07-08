import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';
import { getLanguageLabel } from '../languages';

export interface LlmProviderConfig {
  readonly id: UserData.TranslationProviderId;
  readonly name: string;
  readonly defaultUrl: string;
  readonly defaultModel: string;
}

// Builds the shared translation prompt. Exported for Anthropic/Gemini providers.
export function buildTranslationPrompt(targetLanguage: string): string {
  return `请将以下文本翻译成${getLanguageLabel(targetLanguage)}，只返回翻译结果，不要添加任何解释、注释或额外内容。`;
}

export function createOpenAiCompatProvider(config: LlmProviderConfig): TranslationProvider {
  return {
    id: config.id,
    name: config.name,
    requiresApiKey: true,
    defaultUrl: config.defaultUrl,
    defaultModel: config.defaultModel,

    async translate(
      request: TranslationRequest,
      settings: UserData.TranslationSettings,
    ): Promise<TranslationResult> {
      const providerConfig = settings.providerConfigs[config.id] ?? {
        apiKey: '',
        apiUrl: '',
        apiModel: '',
      };
      if (!providerConfig.apiKey) {
        throw new TranslationError(`未配置 ${config.name} API 密钥。`, false);
      }
      const url = (providerConfig.apiUrl || config.defaultUrl).replace(/\/+$/, '');
      const model = providerConfig.apiModel || config.defaultModel;
      const prompt = buildTranslationPrompt(request.targetLanguage);

      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${providerConfig.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            messages: [
              { role: 'system', content: prompt },
              { role: 'user', content: request.text },
            ],
          }),
        });
      } catch (e) {
        throw new TranslationError(`网络错误：无法连接到 ${config.name}。${formatErr(e)}`);
      }

      if (!response.ok) {
        throw new TranslationError(
          `${config.name} 返回错误：${response.status} ${response.statusText}`,
        );
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new TranslationError(`${config.name} 未返回可识别的翻译结果。`);
      }
      const translatedText = content.trim();
      if (translatedText.length === 0) {
        throw new TranslationError(`${config.name} 返回了空结果。`);
      }
      return { translatedText };
    },
  };
}

function formatErr(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
