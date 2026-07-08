import { userData } from '@src/store/user-data';
import { getProvider } from './providers';
import { TranslationError, type TranslationRequest, type TranslationResult } from './types';
import { MAX_TRANSLATION_INPUT_LENGTH } from './security';
import { isEncryptedApiKeyValue, resolveApiKey } from '@src/infrastructure/storage/api-key-gateway';

export async function translate(request: TranslationRequest): Promise<TranslationResult> {
  const rawText = request.text.trim();
  if (rawText.length === 0) {
    throw new TranslationError('没有可翻译的文本。', false);
  }
  // Silently cap oversized input to MAX_TRANSLATION_INPUT_LENGTH so we
  // never blow up an LLM token budget or hit a per-request character
  // limit on a paid provider. The caller is told via `truncated`.
  const truncated = rawText.length > MAX_TRANSLATION_INPUT_LENGTH;
  const text = truncated ? rawText.slice(0, MAX_TRANSLATION_INPUT_LENGTH) : rawText;
  const settings = userData.settings.translation;
  if (!settings.enabled) {
    throw new TranslationError('翻译功能已禁用。请在 XIT SET 翻译设置中启用。', false);
  }
  const provider = getProvider(settings.provider);
  const target = request.targetLanguage ?? settings.targetLanguage;
  // Build a shallow-cloned settings object with the active provider's
  // apiKey replaced by plaintext. The plaintext is held only in this
  // local variable for the duration of the outbound HTTP request.
  const providerConfig = settings.providerConfigs[settings.provider];
  const wrappedKey = providerConfig?.apiKey ?? '';
  const plaintextKey = isEncryptedApiKeyValue(wrappedKey)
    ? await resolveApiKey(wrappedKey)
    : wrappedKey;
  const runtimeSettings = {
    ...settings,
    providerConfigs: {
      ...settings.providerConfigs,
      [settings.provider]: {
        ...(providerConfig ?? { apiKey: '', apiUrl: '', apiModel: '' }),
        apiKey: plaintextKey,
      },
    },
  };
  const result = await provider.translate({ text, targetLanguage: target }, runtimeSettings);
  return { ...result, truncated };
}
