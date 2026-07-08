import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the api-key-gateway so we can control decryption without
// spinning up the real postMessage roundtrip.
vi.mock('@src/infrastructure/storage/api-key-gateway', () => ({
  isEncryptedApiKeyValue: (value: unknown) =>
    typeof value === 'string' && value.startsWith('__rpenc__:'),
  resolveApiKey: vi.fn(async (wrapped: string) => {
    return wrapped.slice('__rpenc__:'.length);
  }),
}));

// Mock the user-data store with a plain mutable object so we don't
// need Vue's `reactive` runtime in the test environment.
const { userData } = vi.hoisted(() => ({
  userData: {
    settings: {
      translation: {
        enabled: true as boolean,
        provider: 'MICROSOFT' as UserData.TranslationProviderId,
        targetLanguage: 'zh',
        inputTargetLanguage: 'zh',
        providerConfigs: {} as Record<
          UserData.TranslationProviderId,
          UserData.TranslationProviderConfig
        >,
      },
    },
  },
}));

vi.mock('@src/store/user-data', () => ({ userData }));

// Shared fake provider so tests can inspect what translate() passed
// to it without spinning up a real network call.
const { fakeProvider } = vi.hoisted(() => {
  const fake = {
    id: 'MICROSOFT' as UserData.TranslationProviderId,
    name: 'Fake',
    requiresApiKey: false,
    translate: vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (req: TranslationRequest, settings: UserData.TranslationSettings) =>
        ({ translatedText: 'ok' }) satisfies TranslationResult,
    ),
  };
  return { fakeProvider: fake };
});

vi.mock('./providers', () => ({ getProvider: () => fakeProvider }));

import { translate } from './translate';
import { TranslationError } from './types';
import { MAX_TRANSLATION_INPUT_LENGTH } from './security';
import type { TranslationRequest, TranslationResult } from './types';

function resetProviderConfig() {
  userData.settings.translation.providerConfigs = {} as Record<
    UserData.TranslationProviderId,
    UserData.TranslationProviderConfig
  >;
  // Pre-populate MICROSOFT so the runtime settings object has a slot
  // to clone; tests can then mutate it directly.
  userData.settings.translation.providerConfigs.MICROSOFT = {
    apiKey: '',
    apiUrl: '',
    apiModel: '',
  };
}

describe('translate', () => {
  beforeEach(() => {
    userData.settings.translation.enabled = true;
    userData.settings.translation.provider = 'MICROSOFT' as UserData.TranslationProviderId;
    userData.settings.translation.targetLanguage = 'zh';
    userData.settings.translation.inputTargetLanguage = 'zh';
    resetProviderConfig();
    fakeProvider.translate.mockClear();
    fakeProvider.translate.mockResolvedValue({ translatedText: 'ok' } satisfies TranslationResult);
  });

  it('rejects empty input', async () => {
    await expect(translate({ text: '   ', targetLanguage: 'zh' })).rejects.toBeInstanceOf(
      TranslationError,
    );
  });

  it('rejects when the feature is disabled', async () => {
    userData.settings.translation.enabled = false;
    await expect(translate({ text: 'hi', targetLanguage: 'zh' })).rejects.toThrow(/禁用/);
  });

  it('reports truncation for oversized input', async () => {
    const huge = 'a'.repeat(MAX_TRANSLATION_INPUT_LENGTH + 50);
    const result = await translate({ text: huge, targetLanguage: 'zh' });
    expect(result.truncated).toBe(true);
    const call = fakeProvider.translate.mock.calls[0]!;
    const sent = call[0] as TranslationRequest;
    expect(sent.text.length).toBe(MAX_TRANSLATION_INPUT_LENGTH);
  });

  it('passes apiKey plaintext to the provider runtime settings', async () => {
    const config = userData.settings.translation.providerConfigs.MICROSOFT;
    if (config !== undefined) {
      config.apiKey = 'plain-secret';
    }
    await translate({ text: 'hi', targetLanguage: 'zh' });
    const call = fakeProvider.translate.mock.calls[0]!;
    const sentSettings = call[1] as UserData.TranslationSettings;
    expect(sentSettings.providerConfigs.MICROSOFT?.apiKey).toBe('plain-secret');
  });

  it('decrypts wrapped apiKey values before passing to the provider', async () => {
    const config = userData.settings.translation.providerConfigs.MICROSOFT;
    if (config !== undefined) {
      config.apiKey = '__rpenc__:real-key-from-storage';
    }
    await translate({ text: 'hi', targetLanguage: 'zh' });
    const call = fakeProvider.translate.mock.calls[0]!;
    const sentSettings = call[1] as UserData.TranslationSettings;
    expect(sentSettings.providerConfigs.MICROSOFT?.apiKey).toBe('real-key-from-storage');
  });

  it('does not mutate the live userData (apiKey remains wrapped in store)', async () => {
    const config = userData.settings.translation.providerConfigs.MICROSOFT;
    if (config !== undefined) {
      config.apiKey = '__rpenc__:real-key';
    }
    await translate({ text: 'hi', targetLanguage: 'zh' });
    expect(userData.settings.translation.providerConfigs.MICROSOFT?.apiKey).toBe(
      '__rpenc__:real-key',
    );
    const call = fakeProvider.translate.mock.calls[0]!;
    const sentSettings = call[1] as UserData.TranslationSettings;
    expect(sentSettings).not.toBe(userData.settings.translation);
  });

  it('uses targetLanguage override from request when provided', async () => {
    userData.settings.translation.targetLanguage = 'zh';
    await translate({ text: 'hi', targetLanguage: 'en' });
    const call = fakeProvider.translate.mock.calls[0]!;
    const sent = call[0] as TranslationRequest;
    expect(sent.targetLanguage).toBe('en');
  });
});
