export interface TranslationLanguage {
  code: string;
  label: string;
}

// At least 10 common languages, including Chinese, English, Japanese.
export const TRANSLATION_LANGUAGES: readonly TranslationLanguage[] = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: '英文' },
  { code: 'ja', label: '日文' },
  { code: 'ko', label: '韩文' },
  { code: 'fr', label: '法文' },
  { code: 'de', label: '德文' },
  { code: 'es', label: '西班牙文' },
  { code: 'ru', label: '俄文' },
  { code: 'pt', label: '葡萄牙文' },
  { code: 'it', label: '意大利文' },
  { code: 'ar', label: '阿拉伯文' },
  { code: 'hi', label: '印地文' },
];

export function getLanguageLabel(code: string): string {
  return TRANSLATION_LANGUAGES.find(x => x.code === code)?.label ?? code;
}
