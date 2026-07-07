# Chat AI Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicitly-triggered AI translation feature to the game's native chat windows (COMG/COMP/COMU), covering per-message translation, chat-input translation, a full settings page, and a pluggable multi-provider translation backend.

**Architecture:** One cohesive basic feature `chat-translation` under `src/features/basic/`. The feature observes COMG/COMP/COMU tiles, appends a "翻译" button to each rendered message and a "翻译输入" button to the channel controls. A provider abstraction (`providers/`) backs a single `translate()` entry point so new translation services can be added without touching UI. All user-facing settings live in a new `TRANSLATE` tab inside `XIT SET`, persisted via `userData.settings.translation`. Translation is strictly user-triggered (no auto-translation), satisfying the project's server-communication ToS rule.

**Tech Stack:** TypeScript, Vue 3 (`<script setup>`), CSS Modules, native `fetch`, `chrome.storage.local` (via existing `userData`), Font Awesome icons (already bundled).

---

## Verification Approach (IMPORTANT — read before executing)

This project has **no test framework** (no vitest/jest in `package.json`; `scripts` are `compile`, `lint`, `build`, `dev`). Adding a test runner is out of scope and against the project's grain. Therefore TDD here means:

- **Type verification:** `pnpm run compile` (runs `tsc --noEmit`) — must pass with no errors.
- **Style verification:** `pnpm run lint` (runs eslint) — must pass with no errors.
- **Runtime verification:** manual in-game testing (load the dev build, open `COMG <channel>`, exercise the buttons) where a task touches UI.

Every task ends with `pnpm run compile && pnpm run lint` and a commit. UI tasks add a manual verification note. Do not invent a `pnpm test` command — it does not exist.

## Project Conventions To Follow (from `docs/contributing.md` + `docs/feature-patterns.md`)

- Always braces; invert conditions early; `for..of` not `.forEach`; single-param lambdas use `x`.
- `subscribe` callbacks param-named after the `C.X.className` selector.
- Use `C.Component.class` (auto-imported), never hardcoded hashed class names.
- `data-tooltip` (instant, PrUn-style), never `title`.
- `applyCssRule` called in feature `init()`; CSS Modules imported as `$style`.
- Reuse existing components: `PrunButton`, `Tooltip`, `CopyButton`, `SectionHeader`, `Active`, `SelectInput`, `TextInput`, `NumberInput`, `Commands`, `LoadingSpinner`.
- `createFragmentApp(Component, reactive({...})).appendTo(element)` for mounting Vue into game DOM; auto-unmounts on disconnect.
- `changeInputValue(input, value)` from `@src/util` for React-controlled inputs (the chat input is React-controlled).
- Comments on their own line, capitalised, full stop.
- Zero CSS values omit `px`.

## File Structure

**New files:**
- `src/features/basic/chat-translation/types.ts` — shared translation types (provider interface, request/result, settings).
- `src/features/basic/chat-translation/languages.ts` — supported language list (12 languages).
- `src/features/basic/chat-translation/providers/index.ts` — provider registry + `getProvider()` factory.
- `src/features/basic/chat-translation/providers/libre-translate.ts` — LibreTranslate provider (free / self-hosted).
- `src/features/basic/chat-translation/providers/google-translate.ts` — Google Cloud Translation provider (paid).
- `src/features/basic/chat-translation/providers/deep-translate.ts` — DeepL provider (paid).
- `src/features/basic/chat-translation/translate.ts` — single `translate()` entry point: routes to provider, guards empty text, wraps errors.
- `src/features/basic/chat-translation/TranslationResult.vue` — translated-text display block (label + copy + restore).
- `src/features/basic/chat-translation/TranslateMessageButton.vue` — per-message "翻译" button (globe icon) with spinner / error+retry.
- `src/features/basic/chat-translation/TranslateInputButton.vue` — "翻译输入" button for the channel input, with original-text cache + restore.
- `src/features/basic/chat-translation/chat-translation.ts` — feature entry: `tiles.observe(['COMG','COMP','COMU'])`, wires both buttons.
- `src/features/XIT/SET/TRANSLATE.vue` — translation settings page.

**Modified files:**
- `src/store/user-data.types.d.ts` — add `TranslationProviderId` + `TranslationSettings`.
- `src/store/user-data.ts` — add `settings.translation` to `initialUserData`.
- `src/store/user-data-migrations.ts` — add migration at the top of the list.
- `src/features/XIT/SET/SET.vue` — add `TRANSLATE` tab.
- `src/features/basic/index.ts` — import the new feature (alphabetical: after `chat-images`).

---

### Task 1: Data model — types, defaults, migration

**Files:**
- Modify: `src/store/user-data.types.d.ts` (append inside `namespace UserData`)
- Modify: `src/store/user-data.ts:6-59` (the `settings` object in `initialUserData`)
- Modify: `src/store/user-data-migrations.ts:18` (top of `migrations` array)

- [ ] **Step 1: Add the translation types to `user-data.types.d.ts`**

Append inside the `declare namespace UserData { ... }` block (after the `BasePlan` interface, before the closing brace):

```typescript
  type TranslationProviderId = 'LIBRE' | 'GOOGLE' | 'DEEP';

  interface TranslationSettings {
    enabled: boolean;
    provider: TranslationProviderId;
    targetLanguage: string;
    apiKey: string;
    apiUrl: string;
    fontSize: number;
    backgroundColor: string;
  }
```

- [ ] **Step 2: Add defaults to `initialUserData` in `src/store/user-data.ts`**

Inside the `settings: { ... }` object, after the `mutedDesktopNotifications: [] as string[],` line, add:

```typescript
    translation: {
      enabled: true,
      provider: 'LIBRE',
      targetLanguage: 'zh',
      apiKey: '',
      apiUrl: 'https://translate.argosopentech.com',
      fontSize: 14,
      backgroundColor: '#2a2a2a',
    } as UserData.TranslationSettings,
```

- [ ] **Step 3: Add the migration at the TOP of `migrations` in `src/store/user-data-migrations.ts`**

Insert as the first entry of the `migrations: MigrationEntry[] = [` array (before the `'03.04.2026 Rename default cart name'` entry):

```typescript
  [
    '07.07.2026 Add translation settings',
    userData => {
      if (!userData.settings.translation) {
        userData.settings.translation = {
          enabled: true,
          provider: 'LIBRE',
          targetLanguage: 'zh',
          apiKey: '',
          apiUrl: 'https://translate.argosopentech.com',
          fontSize: 14,
          backgroundColor: '#2a2a2a',
        };
      }
    },
  ],
```

- [ ] **Step 4: Verify type-check and lint pass**

Run: `pnpm run compile && pnpm run lint`
Expected: both exit 0, no errors.

- [ ] **Step 5: Commit**

```bash
git add src/store/user-data.types.d.ts src/store/user-data.ts src/store/user-data-migrations.ts
git commit -m "feat(translation): add translation settings data model and migration"
```

---

### Task 2: Supported languages list

**Files:**
- Create: `src/features/basic/chat-translation/languages.ts`

- [ ] **Step 1: Create the languages module**

```typescript
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
```

- [ ] **Step 2: Verify**

Run: `pnpm run compile && pnpm run lint`
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/features/basic/chat-translation/languages.ts
git commit -m "feat(translation): add supported languages list"
```

---

### Task 3: Translation types and provider interface

**Files:**
- Create: `src/features/basic/chat-translation/types.ts`

- [ ] **Step 1: Create the shared types module**

```typescript
import type { UserData } from '@src/store/user-data.types';

export interface TranslationRequest {
  text: string;
  targetLanguage: string;
}

export interface TranslationResult {
  translatedText: string;
  detectedSourceLanguage?: string;
}

export interface TranslationProvider {
  readonly id: UserData.TranslationProviderId;
  readonly name: string;
  readonly requiresApiKey: boolean;
  translate(request: TranslationRequest, settings: UserData.TranslationSettings): Promise<TranslationResult>;
}

export class TranslationError extends Error {
  constructor(message: string, readonly retryable: boolean = true) {
    super(message);
    this.name = 'TranslationError';
  }
}
```

- [ ] **Step 2: Verify**

Run: `pnpm run compile && pnpm run lint`
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/features/basic/chat-translation/types.ts
git commit -m "feat(translation): add provider interface and shared types"
```

---

### Task 4: LibreTranslate provider (free / self-hosted)

**Files:**
- Create: `src/features/basic/chat-translation/providers/libre-translate.ts`

- [ ] **Step 1: Create the LibreTranslate provider**

LibreTranslate public/self-hosted API: `POST {apiUrl}/translate` with JSON `{ q, source: 'auto', target, format: 'text', api_key? }`. Response: `{ translatedText: string }`.

```typescript
import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';

export const libreTranslateProvider: TranslationProvider = {
  id: 'LIBRE',
  name: 'LibreTranslate (免费)',
  requiresApiKey: false,

  async translate(
    request: TranslationRequest,
    settings: UserData.TranslationSettings,
  ): Promise<TranslationResult> {
    const baseUrl = (settings.apiUrl || 'https://translate.argosopentech.com').replace(/\/+$/, '');
    const url = `${baseUrl}/translate`;
    const body = {
      q: request.text,
      source: 'auto',
      target: request.targetLanguage,
      format: 'text',
    };
    // Public instances accept an optional api_key for self-hosted rate-limit relief.
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (settings.apiKey) {
      (body as { api_key?: string }).api_key = settings.apiKey;
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new TranslationError(`网络错误：无法连接到翻译服务。${formatErr(e)}`);
    }
    if (!response.ok) {
      throw new TranslationError(`翻译服务返回错误：${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as { translatedText?: string };
    if (!data.translatedText) {
      throw new TranslationError('翻译服务未返回有效结果。');
    }
    return { translatedText: data.translatedText };
  },
};

function formatErr(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}
```

- [ ] **Step 2: Verify**

Run: `pnpm run compile && pnpm run lint`
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/features/basic/chat-translation/providers/libre-translate.ts
git commit -m "feat(translation): add LibreTranslate provider"
```

---

### Task 5: Google Translate + DeepL providers and the registry

**Files:**
- Create: `src/features/basic/chat-translation/providers/google-translate.ts`
- Create: `src/features/basic/chat-translation/providers/deep-translate.ts`
- Create: `src/features/basic/chat-translation/providers/index.ts`

- [ ] **Step 1: Create the Google Cloud Translation provider**

Google Cloud Translation v2: `POST https://translation.googleapis.com/language/translate/v2?key={apiKey}` with JSON `{ q, target, format: 'text' }`. Response: `{ data: { translations: [{ translatedText, detectedSourceLanguage? }] } }`.

```typescript
import type { TranslationProvider, TranslationRequest, TranslationResult } from '../types';
import { TranslationError } from '../types';

export const googleTranslateProvider: TranslationProvider = {
  id: 'GOOGLE',
  name: 'Google Translate (API)',
  requiresApiKey: true,

  async translate(
    request: TranslationRequest,
    settings: UserData.TranslationSettings,
  ): Promise<TranslationResult> {
    if (!settings.apiKey) {
      throw new TranslationError('未配置 Google API 密钥。', false);
    }
    const url = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(settings.apiKey)}`;
    const body = {
      q: request.text,
      target: request.targetLanguage,
      format: 'text',
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new TranslationError(`网络错误：${formatErr(e)}`);
    }
    if (!response.ok) {
      throw new TranslationError(`Google 翻译错误：${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as {
      data?: { translations?: { translatedText?: string; detectedSourceLanguage?: string }[] };
    };
    const translation = data.data?.translations?.[0];
    if (!translation?.translatedText) {
      throw new TranslationError('Google 翻译未返回有效结果。');
    }
    return {
      translatedText: translation.translatedText,
      detectedSourceLanguage: translation.detectedSourceLanguage,
    };
  },
};

function formatErr(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}
```

- [ ] **Step 2: Create the DeepL provider**

DeepL: `POST https://api-free.deepl.com/v2/translate` (free key) or `https://api.deepl.com/v2/translate` (pro key). DeepL target codes are uppercase (`ZH`, `EN`). Form-encoded body `auth_key=...&text=...&target_lang=...`. Response: `{ translations: [{ text, detected_source_language }] }`. A free key ends in `:fx` per DeepL's convention; use it to pick the host.

```typescript
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
    if (!settings.apiKey) {
      throw new TranslationError('未配置 DeepL API 密钥。', false);
    }
    // Free keys end with ':fx' and must use the free host.
    const host = settings.apiKey.endsWith(':fx')
      ? 'https://api-free.deepl.com'
      : 'https://api.deepl.com';
    const url = `${host}/v2/translate`;
    const params = new URLSearchParams();
    params.set('auth_key', settings.apiKey);
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
      throw new TranslationError(`网络错误：${formatErr(e)}`);
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

function formatErr(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}
```

- [ ] **Step 3: Create the provider registry**

```typescript
import type { TranslationProvider } from '../types';
import type { UserData } from '@src/store/user-data.types';
import { libreTranslateProvider } from './libre-translate';
import { googleTranslateProvider } from './google-translate';
import { deepTranslateProvider } from './deep-translate';

const PROVIDERS: Record<UserData.TranslationProviderId, TranslationProvider> = {
  LIBRE: libreTranslateProvider,
  GOOGLE: googleTranslateProvider,
  DEEP: deepTranslateProvider,
};

export const ALL_PROVIDERS: TranslationProvider[] = [
  libreTranslateProvider,
  googleTranslateProvider,
  deepTranslateProvider,
];

export function getProvider(id: UserData.TranslationProviderId): TranslationProvider {
  return PROVIDERS[id];
}
```

- [ ] **Step 4: Verify**

Run: `pnpm run compile && pnpm run lint`
Expected: both exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/features/basic/chat-translation/providers/google-translate.ts src/features/basic/chat-translation/providers/deep-translate.ts src/features/basic/chat-translation/providers/index.ts
git commit -m "feat(translation): add Google, DeepL providers and provider registry"
```

---

### Task 6: Core translate() entry point

**Files:**
- Create: `src/features/basic/chat-translation/translate.ts`

- [ ] **Step 1: Create the translate entry point**

Guards empty text, routes to the configured provider, respects the `enabled` flag, normalises errors to `TranslationError`.

```typescript
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
  return provider.translate(
    { text, targetLanguage: settings.targetLanguage },
    settings,
  );
}
```

- [ ] **Step 2: Verify**

Run: `pnpm run compile && pnpm run lint`
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/features/basic/chat-translation/translate.ts
git commit -m "feat(translation): add translate() entry point with guards"
```

---

### Task 7: TranslationResult.vue component

**Files:**
- Create: `src/features/basic/chat-translation/TranslationResult.vue`

- [ ] **Step 1: Create the result display component**

Shows translated text with a left-border + tinted background, a `[已翻译：{语言}]` label, a copy button, and a "还原" button. Style (font size, background) is driven reactively from `userData.settings.translation`.

```vue
<script setup lang="ts">
import CopyButton from '@src/components/CopyButton.vue';
import PrunButton from '@src/components/PrunButton.vue';
import { userData } from '@src/store/user-data';
import { getLanguageLabel } from './languages';

const { translatedText, detectedSourceLanguage } = defineProps<{
  translatedText: string;
  detectedSourceLanguage?: string;
}>();

const emit = defineEmits<{ (e: 'restore'): void }>();

const settings = computed(() => userData.settings.translation);

const label = computed(() => {
  const target = getLanguageLabel(settings.value.targetLanguage);
  const source = detectedSourceLanguage ? getLanguageLabel(detectedSourceLanguage) : null;
  return source ? `[已翻译：${source} → ${target}]` : `[已翻译：${target}]`;
});

const containerStyle = computed(() => ({
  fontSize: `${settings.value.fontSize}px`,
  backgroundColor: settings.value.backgroundColor,
}));
</script>

<template>
  <div :class="$style.result" :style="containerStyle">
    <div :class="$style.label">{{ label }}</div>
    <div :class="$style.text">{{ translatedText }}</div>
    <div :class="$style.actions">
      <CopyButton :copy-fn="() => translatedText" />
      <PrunButton dark inline @click="emit('restore')">还原</PrunButton>
    </div>
  </div>
</template>

<style module>
.result {
  margin-top: 4px;
  padding: 6px 8px;
  border-left: 3px solid #6db3f0;
  border-radius: 2px;
  color: #d6d6d6;
  word-break: break-word;
}

.label {
  font-size: 11px;
  color: #8ab6e0;
  margin-bottom: 4px;
}

.text {
  white-space: pre-wrap;
}

.actions {
  display: flex;
  gap: 6px;
  margin-top: 6px;
}
</style>
```

- [ ] **Step 2: Verify**

Run: `pnpm run compile && pnpm run lint`
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/features/basic/chat-translation/TranslationResult.vue
git commit -m "feat(translation): add TranslationResult display component"
```

---

### Task 8: TranslateMessageButton.vue component

**Files:**
- Create: `src/features/basic/chat-translation/TranslateMessageButton.vue`

- [ ] **Step 1: Create the per-message translate button**

States: idle → loading → result/error. Globe icon (`\uf0ac`) + "翻译" label. Hover tooltip shows target language. On click: call `translate()`, show `TranslationResult`, or error with retry. "还原" hides the result.

```vue
<script setup lang="ts">
import fa from '@src/utils/font-awesome.module.css';
import PrunButton from '@src/components/PrunButton.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { userData } from '@src/store/user-data';
import { getLanguageLabel } from './languages';
import { translate } from './translate';
import { TranslationError, type TranslationResult as TResult } from './types';
import TranslationResult from './TranslationResult.vue';

const { text } = defineProps<{ text: string }>();

type State = 'idle' | 'loading' | 'done' | 'error';
const state = ref<State>('idle');
const result = ref<TResult | null>(null);
const error = ref<TranslationError | null>(null);

const enabled = computed(() => userData.settings.translation.enabled);
const targetLabel = computed(() => getLanguageLabel(userData.settings.translation.targetLanguage));
const tooltip = computed(() => `翻译成${targetLabel.value}`);

async function onClick() {
  if (state.value === 'loading') {
    return;
  }
  state.value = 'loading';
  error.value = null;
  try {
    result.value = await translate({ text, targetLanguage: userData.settings.translation.targetLanguage });
    state.value = 'done';
  } catch (e) {
    error.value = e instanceof TranslationError ? e : new TranslationError(String(e));
    state.value = 'error';
  }
}

function onRestore() {
  state.value = 'idle';
  result.value = null;
}
</script>

<template>
  <span v-if="enabled" :class="$style.root">
    <button
      v-if="state !== 'done'"
      type="button"
      :class="[C.Button.btn, C.Button.inline, $style.button]"
      :data-tooltip="tooltip"
      data-tooltip-position="top"
      :disabled="state === 'loading'"
      @click="onClick">
      <span :class="fa.solid">\uf0ac</span>
      <span v-if="state === 'loading'"><LoadingSpinner /></span>
      <span v-else>翻译</span>
    </button>
    <template v-if="state === 'error'">
      <span :class="$style.error">{{ error!.message }}</span>
      <PrunButton v-if="error!.retryable" dark inline @click="onClick">重试</PrunButton>
    </template>
    <TranslationResult
      v-if="state === 'done' && result"
      :translated-text="result.translatedText"
      :detected-source-language="result.detectedSourceLanguage"
      @restore="onRestore" />
  </span>
</template>

<style module>
.root {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 6px;
}

.button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.error {
  color: #d9534f;
  font-size: 12px;
}
</style>
```

- [ ] **Step 2: Verify**

Run: `pnpm run compile && pnpm run lint`
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/features/basic/chat-translation/TranslateMessageButton.vue
git commit -m "feat(translation): add per-message TranslateMessageButton"
```

---

### Task 9: TranslateInputButton.vue component

**Files:**
- Create: `src/features/basic/chat-translation/TranslateInputButton.vue`

- [ ] **Step 1: Create the input-translate button**

The chat input is a React-controlled `<input>` inside `C.Channel.prompt`. The feature file passes the input element as a prop. On click: read `input.value`, translate, cache the original, then write the result back via `changeInputValue`. A "恢复原始输入" button restores the cached original.

```vue
<script setup lang="ts">
import fa from '@src/utils/font-awesome.module.css';
import PrunButton from '@src/components/PrunButton.vue';
import LoadingSpinner from '@src/components/LoadingSpinner.vue';
import { changeInputValue } from '@src/util';
import { userData } from '@src/store/user-data';
import { getLanguageLabel } from './languages';
import { translate } from './translate';
import { TranslationError } from './types';

const { input } = defineProps<{ input: HTMLInputElement }>();

type State = 'idle' | 'loading' | 'done' | 'error';
const state = ref<State>('idle');
const errorMsg = ref('');
const originalCache = ref<string | null>(null);

const enabled = computed(() => userData.settings.translation.enabled);
const targetLabel = computed(() => getLanguageLabel(userData.settings.translation.targetLanguage));
const tooltip = computed(() => `翻译输入为${targetLabel.value}`);

async function onClick() {
  if (state.value === 'loading') {
    return;
  }
  const value = input.value.trim();
  if (value.length === 0) {
    state.value = 'error';
    errorMsg.value = '输入框为空。';
    return;
  }
  state.value = 'loading';
  errorMsg.value = '';
  try {
    // Cache the original the first time we translate in this session.
    if (originalCache.value === null) {
      originalCache.value = input.value;
    }
    const result = await translate({ text: value, targetLanguage: userData.settings.translation.targetLanguage });
    changeInputValue(input, result.translatedText);
    state.value = 'done';
  } catch (e) {
    errorMsg.value = e instanceof TranslationError ? e.message : String(e);
    state.value = 'error';
  }
}

function onRestore() {
  if (originalCache.value !== null) {
    changeInputValue(input, originalCache.value);
    originalCache.value = null;
  }
  state.value = 'idle';
  errorMsg.value = '';
}
</script>

<template>
  <span v-if="enabled" :class="$style.root">
    <button
      type="button"
      :class="[C.Button.btn, C.Button.inline, $style.button]"
      :data-tooltip="tooltip"
      data-tooltip-position="top"
      :disabled="state === 'loading'"
      @click="onClick">
      <span :class="fa.solid">\uf1ab</span>
      <span v-if="state === 'loading'"><LoadingSpinner /></span>
      <span v-else>翻译输入</span>
    </button>
    <PrunButton v-if="state === 'done' && originalCache !== null" dark inline @click="onRestore">
      恢复原始输入
    </PrunButton>
    <PrunButton v-if="state === 'error'" dark inline @click="onClick">重试</PrunButton>
    <span v-if="state === 'error'" :class="$style.error">{{ errorMsg }}</span>
  </span>
</template>

<style module>
.root {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}

.error {
  color: #d9534f;
  font-size: 12px;
}
</style>
```

- [ ] **Step 2: Verify**

Run: `pnpm run compile && pnpm run lint`
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/features/basic/chat-translation/TranslateInputButton.vue
git commit -m "feat(translation): add TranslateInputButton with original-text cache"
```

---

### Task 10: Feature entry

**Files:**
- Create: `src/features/basic/chat-translation/chat-translation.ts`
- Modify: `src/features/basic/index.ts` (add import after `./chat-images`)

- [ ] **Step 1: Create the feature entry**

Observes COMG/COMP/COMU. For each message, finds the text node and appends `TranslateMessageButton`. For each channel, finds the input inside `C.Channel.prompt` and appends `TranslateInputButton` to `C.Channel.controls`. The buttons themselves render `v-if="enabled"` (added in Tasks 8/9) so they hide reactively when the feature is disabled in settings — no CSS module needed.

```typescript
import TranslateMessageButton from './TranslateMessageButton.vue';
import TranslateInputButton from './TranslateInputButton.vue';

function onTileReady(tile: PrunTile) {
  // Input translate button: one per channel controls bar.
  subscribe($$(tile.anchor, C.Channel.controls), controls => {
    subscribe($$(tile.anchor, C.Channel.prompt), async prompt => {
      // The chat input is an <input> inside the prompt area.
      const input = await $(prompt, 'input');
      createFragmentApp(
        TranslateInputButton,
        reactive({ input }),
      ).appendTo(controls);
    });
  });

  // Per-message translate button.
  subscribe($$(tile.anchor, C.MessageList.messages), messages => {
    subscribe($$(messages, C.Message.message), message => {
      // Skip system join/left messages — they have no translatable text.
      const system = _$(message, C.Message.system);
      if (system) {
        return;
      }
      const textEl = _$(message, C.Message.text);
      if (!textEl) {
        return;
      }
      const text = textEl.textContent ?? '';
      if (text.length === 0) {
        return;
      }
      createFragmentApp(
        TranslateMessageButton,
        reactive({ text }),
      ).appendTo(textEl.parentElement!);
    });
  });
}

function init() {
  tiles.observe(['COMG', 'COMP', 'COMU'], onTileReady);
}

features.add(
  import.meta.url,
  init,
  'COMG/COMP/COMU: 为聊天消息和输入框添加显式触发的 AI 翻译按钮。',
);
```

- [ ] **Step 2: Register the feature in `src/features/basic/index.ts`**

Add the import in alphabetical order — it belongs right after `import './chat-images';` (line 20):

```typescript
import './chat-images';
import './chat-translation/chat-translation';
```

- [ ] **Step 3: Verify**

Run: `pnpm run compile && pnpm run lint`
Expected: both exit 0.

- [ ] **Step 4: Manual runtime check**

Run `pnpm run dev`. Load the extension. Open `COMG <channel>` (or `COMP`/`COMU`). Confirm:
- Each non-system message shows a globe "翻译" button after its text.
- The channel controls bar shows a "翻译输入" button.
- System join/left messages do NOT get a translate button.

- [ ] **Step 5: Commit**

```bash
git add src/features/basic/chat-translation/chat-translation.ts src/features/basic/index.ts
git commit -m "feat(translation): wire translate buttons into COMG/COMP/COMU chat"
```

---

### Task 11: Settings page TRANSLATE.vue

**Files:**
- Create: `src/features/XIT/SET/TRANSLATE.vue`

- [ ] **Step 1: Create the settings page**

Full settings: enable toggle, provider select, target language select, API key, API URL (LibreTranslate only), font size, background color. Uses existing form components. Persists via reactive `userData` (auto-saved by the storage layer).

```vue
<script setup lang="ts">
import SectionHeader from '@src/components/SectionHeader.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';
import NumberInput from '@src/components/forms/NumberInput.vue';
import SelectInput from '@src/components/forms/SelectInput.vue';
import Tooltip from '@src/components/Tooltip.vue';
import { userData } from '@src/store/user-data';
import { saveUserData } from '@src/infrastructure/storage/user-data-serializer';
import { TRANSLATION_LANGUAGES } from '@src/features/basic/chat-translation/languages';
import { ALL_PROVIDERS } from '@src/features/basic/chat-translation/providers';

const settings = computed(() => userData.settings.translation);

const providerOptions = ALL_PROVIDERS.map(p => ({ label: p.name, value: p.id }));

const languageOptions = TRANSLATION_LANGUAGES.map(l => ({ label: l.label, value: l.code }));

const currentProvider = computed(() => ALL_PROVIDERS.find(p => p.id === settings.value.provider));
const showApiKey = computed(() => currentProvider.value?.requiresApiKey ?? false);
const showApiUrl = computed(() => settings.value.provider === 'LIBRE');

async function onChange() {
  await saveUserData();
}
</script>

<template>
  <SectionHeader>翻译设置</SectionHeader>
  <form>
    <Active label="启用翻译功能" tooltip="关闭后所有翻译按钮将隐藏。">
      <input type="checkbox" v-model="settings.enabled" @change="onChange" />
    </Active>
    <Active label="翻译服务" tooltip="选择翻译服务提供商。LibreTranslate 为免费/自建服务。">
      <SelectInput v-model="settings.provider" :options="providerOptions" @update:model-value="onChange" />
    </Active>
    <Active label="目标语言" tooltip="所有翻译结果的目标语言。你的选择会被记住。">
      <SelectInput v-model="settings.targetLanguage" :options="languageOptions" @update:model-value="onChange" />
    </Active>
    <Active
      v-if="showApiUrl"
      label="LibreTranslate 地址"
      tooltip="自建或公共 LibreTranslate 实例地址。留空使用默认公共实例。">
      <TextInput v-model="settings.apiUrl" @keyup.enter="onChange" @focusout="onChange" />
    </Active>
    <Active
      v-if="showApiKey"
      label="API 密钥"
      tooltip="所选翻译服务所需的 API 密钥。密钥保存在本地，不会上传。">
      <TextInput v-model="settings.apiKey" @keyup.enter="onChange" @focusout="onChange" />
    </Active>
    <Active label="结果字体大小" tooltip="翻译结果显示区域的字体大小（像素）。">
      <NumberInput v-model="settings.fontSize" @update:model-value="onChange" />
    </Active>
    <Active label="结果背景颜色" tooltip="翻译结果显示区域的背景颜色（CSS 颜色值）。">
      <TextInput v-model="settings.backgroundColor" @keyup.enter="onChange" @focusout="onChange" />
    </Active>
  </form>
  <SectionHeader>
    说明
    <Tooltip :class="$style.tooltip" tooltip="所有翻译均为显式触发，不会自动翻译任何内容。" />
  </SectionHeader>
  <div :class="$style.note">
    翻译功能仅在用户点击翻译按钮时调用翻译服务，不会自动发送任何聊天内容。
    API 密钥保存在本地浏览器存储中。
  </div>
</template>

<style module>
.tooltip {
  float: revert;
  font-size: 12px;
  margin-top: -4px;
}

.note {
  padding: 6px 8px;
  color: #999;
  font-size: 12px;
  line-height: 1.5;
}
</style>
```

- [ ] **Step 2: Verify**

Run: `pnpm run compile && pnpm run lint`
Expected: both exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/features/XIT/SET/TRANSLATE.vue
git commit -m "feat(translation): add TRANSLATE settings page"
```

---

### Task 12: Register the TRANSLATE tab in SET.vue

**Files:**
- Modify: `src/features/XIT/SET/SET.vue`

- [ ] **Step 1: Add the import and tab**

In `src/features/XIT/SET/SET.vue`, add the import after the `BFR` import (line 7):

```typescript
import TRANSLATE from '@src/features/XIT/SET/TRANSLATE.vue';
```

Add the tab to the `tabs` array (after the `BFR` entry, before the closing `];`):

```typescript
  {
    id: 'TRANSLATE',
    label: '翻译',
    component: TRANSLATE,
  },
```

Because `SET.vue` already computes `activeTab = tabs.find(x => x.id === parameter?.toUpperCase()) ?? tabs[0]`, `XIT SET TRANSLATE` will open this tab directly.

- [ ] **Step 2: Verify**

Run: `pnpm run compile && pnpm run lint`
Expected: both exit 0.

- [ ] **Step 3: Manual runtime check**

Run `pnpm run dev`. Open `XIT SET`. Confirm a "翻译" tab appears; click it and confirm all settings render. Open `XIT SET TRANSLATE` and confirm it lands on the tab directly.

- [ ] **Step 4: Commit**

```bash
git add src/features/XIT/SET/SET.vue
git commit -m "feat(translation): register TRANSLATE tab in XIT SET"
```

---

### Task 13: End-to-end integration verification

**Files:** none (verification only)

- [ ] **Step 1: Full type + lint pass**

Run: `pnpm run compile && pnpm run lint`
Expected: both exit 0.

- [ ] **Step 2: Manual end-to-end test (default LibreTranslate)**

Run `pnpm run dev`. Load the extension, then:

1. Open `XIT SET TRANSLATE`. Confirm defaults: enabled, LibreTranslate, target 中文.
2. Open `COMG <channel>` with existing messages.
3. Click "翻译" on a message. Confirm: spinner shows, then translated text appears below with `[已翻译：…]` label, left-border + tinted background.
4. Click "还原" — translation hides, button returns.
5. Click "翻译" on an empty/whitespace message is impossible (button only renders on non-empty text); confirm no crash on system messages.
6. Type English text in the chat input, click "翻译输入". Confirm the input is replaced with Chinese; click "恢复原始输入" — original English returns.
7. Disable the feature in settings (`XIT SET TRANSLATE` → uncheck 启用翻译功能). Confirm the "翻译" and "翻译输入" buttons disappear from any open chat tile reactively (no reload needed). Re-enable and confirm they reappear.

- [ ] **Step 3: Manual error-handling test**

In `XIT SET TRANSLATE`, switch provider to `GOOGLE` but leave API key blank. Click a message's "翻译". Confirm a friendly error "未配置 Google API 密钥。" with no retry button (non-retryable). Switch back to `LIBRE`.

- [ ] **Step 4: Final commit (only if any fixups were made)**

If the manual checks surfaced fixups, stage and commit them:

```bash
git add -p
git commit -m "fix(translation): address end-to-end test findings"
```

If no changes were needed, skip this step.

---

## Self-Review Notes

**Spec coverage:**
- 对话翻译（按钮、目标语言、原文下方显示、还原）→ Tasks 7, 8, 10. ✓
- 输入翻译（输入框右侧按钮、替换输入、原始缓存、恢复）→ Tasks 9, 10. ✓
- 显式触发（无自动翻译、悬停提示、加载指示器）→ Tasks 8, 9, 10 (loading spinner + tooltips); right-click menu explicitly deferred per user decision. ✓
- 翻译设置（目标语言 ≥10、提供商、API 密钥、显示样式、方向记忆）→ Tasks 1, 2, 11, 12. Direction memory = persisted `targetLanguage` (noted in tooltip). ✓
- 交互设计（视觉一致、语言标识、错误+重试、复制、响应式）→ Tasks 7, 8, 9 (reuses PrunButton/CopyButton, `[已翻译：…]` label, retry buttons, copy button). Mobile responsiveness: buttons use inline PrunButton classes; the game UI itself is desktop-first per `docs/game/ui-concepts.md`, so no separate mobile layout is added. ✓
- 技术集成（无缝集成、不阻塞主线程、错误处理、可扩展）→ `translate()` is async (non-blocking), `TranslationError` wraps all failures, provider registry makes new providers a single-file addition. ✓
- 质量（响应 <100ms、结果 <2s、无错位、清晰反馈）→ buttons are synchronous mount (<100ms); translation latency depends on provider network; layout uses existing inline button classes so no shift. ✓

**Placeholders:** none. Every code step contains full, copy-pasteable code.

**Type consistency:** `TranslationProviderId`, `TranslationSettings`, `TranslationProvider`, `TranslationRequest`, `TranslationResult`, `TranslationError` are defined once in Task 1 (settings) and Task 3 (provider types) and used consistently. `getProvider`, `ALL_PROVIDERS`, `translate`, `getLanguageLabel`, `TRANSLATION_LANGUAGES` are referenced with matching signatures across tasks.

**One concern flagged (not blocking):** `docs/contributing.md` says new features taking vertical space may need a Discord poll (~75% yes). This feature adds a button to every chat message. Recommend running a Discord poll before merging — noted here, not a code task.
