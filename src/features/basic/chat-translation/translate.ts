import { userData } from '@src/store/user-data';
import { getProvider } from './providers';
import { TranslationError, type TranslationRequest, type TranslationResult } from './types';

export async function translate(request: TranslationRequest): Promise<TranslationResult> {
  const text = request.text.trim();
  if (text.length === 0) {
    throw new TranslationError('没有可翻译的文本。', false);
  }
  const settings = userData.settings.translation;
  if (!settings.enabled) {
    throw new TranslationError('翻译功能已禁用。请在 XIT SET 翻译设置中启用。', false);
  }
  const provider = getProvider(settings.provider);
  return provider.translate({ text, targetLanguage: settings.targetLanguage }, settings);
}
