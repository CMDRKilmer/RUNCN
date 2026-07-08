import {
  decryptSecrets,
  encryptSecrets,
  isEncryptedSecretBlob,
} from './infrastructure/storage/crypto-secrets';
import { encryptWithSessionKey, loadSessionKey } from './infrastructure/storage/session-key';

// Sentinel the page script can recognise as an encrypted value rather
// than a real API key. The real encrypted payload follows after the
// prefix. We use a single short prefix so it is unlikely to collide
// with a real key.
const ENCRYPTED_API_KEY_PREFIX = '__rpenc__:';

// 16 bytes of base64-encoded randomness from crypto.getRandomValues is
// 22-24 chars. We use a permissive regex to validate without locking
// the exact encoding (a real 16-byte random base64 cannot collide
// with anything predictable).
const CNONCE_PATTERN = /^[A-Za-z0-9+/=]{22,24}$/;
const REPLAY_WINDOW_MS = 30_000;
const seenCnonces = new Set<string>();

function isValidCnonce(value: unknown): value is string {
  return typeof value === 'string' && CNONCE_PATTERN.test(value);
}

async function startup() {
  if (document.documentElement.classList.contains('refined-prun')) {
    // This message will trigger a reload for pre-24.12.18 builds.
    window.postMessage({ type: 'rp-reload-page' }, '*');
    return;
  }
  const userData = loadUserData();
  await waitDocumentReady();
  const container = document.createElement('refined-prun');
  document.documentElement.appendChild(container);
  const now = Date.now();
  const css = document.createElement('link');
  css.href = chrome.runtime.getURL('refined-prun.css') + '?' + now;
  css.rel = 'stylesheet';
  css.id = 'refined-prun-css';
  await new Promise(resolve => {
    css.onload = resolve;
    container.appendChild(css);
  });
  // This serialization is needed because accessing css.sheet in Firefox from the page script
  // will throw a CORS error.
  const rules: { [id: string]: string } = {};
  const sheet = css.sheet!;
  for (let i = 0; i < sheet.cssRules.length; i++) {
    const rule = sheet.cssRules.item(i);
    if (!rule) {
      continue;
    }
    rules[(rule as CSSStyleRule).selectorText] = rule.cssText;
  }
  css.textContent = JSON.stringify(rules);
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('refined-prun.js') + '?' + now;
  script.type = 'module';
  script.id = 'refined-prun-js';
  const config: RefinedPrunConfig = {
    userData: await userData,
    version: chrome.runtime.getManifest().version,
    url: {
      manifest: chrome.runtime.getURL('manifest.json'),
      allplanets: chrome.runtime.getURL('json/fallback-fio-responses/allplanets.json'),
    },
  };
  script.textContent = JSON.stringify(config);
  container.appendChild(script);
}

async function loadUserData() {
  const userDataKey = 'rp-user-data';
  const secretKeysKey = 'rp-secret-keys';
  const extensionId = chrome.runtime.id;
  // Load (or create) the session key once for this tab. It lives only
  // in chrome.storage.session and is wiped when the extension session
  // ends. The page script never sees the raw key material.
  await loadSessionKey();

  window.addEventListener('message', async (e: MessageEvent) => {
    if (e.source !== window) {
      return;
    }
    // Reject messages from any other origin. The page script posts with
    // targetOrigin=location.origin, so a mismatch indicates an injected
    // frame or spoofed sender we should not trust.
    if (e.origin !== location.origin) {
      return;
    }
    if (e.data.type === 'rp-save-user-data') {
      // The userData payload already has its apiKey fields blanked by
      // the page script (see saveUserData). We just persist it.
      const { userData } = e.data as { userData: unknown };
      await chrome.storage.local.set({ [userDataKey]: userData });
      window.postMessage({ type: 'rp-user-data-saved' }, location.origin);
      return;
    }
    if (e.data.type === 'rp-save-secret-keys') {
      // Page script posts each apiKey in a dedicated, separate message.
      // The content script encrypts the bundle and persists it under
      // its own storage key. Plaintext never leaves this boundary.
      const { secretKeys } = e.data as { secretKeys: Record<string, string> };
      const sanitized: Record<string, string> = {};
      if (typeof secretKeys === 'object' && secretKeys !== null) {
        for (const id of Object.keys(secretKeys)) {
          const value = secretKeys[id];
          if (typeof value === 'string' && value.length > 0) {
            sanitized[id] = value;
          }
        }
      }
      const encrypted = await encryptSecrets(extensionId, JSON.stringify(sanitized));
      await chrome.storage.local.set({ [secretKeysKey]: encrypted });
      window.postMessage({ type: 'rp-secret-keys-saved' }, location.origin);
      return;
    }
    if (e.data.type === 'rp-decrypt-api-key') {
      // Provider code on the page needs the plaintext apiKey for a
      // single outbound request. It posts the wrapped key along with a
      // 128-bit client nonce (`cnonce`); the response must echo the
      // same nonce. We track seen nonces for a short window so an
      // attacker cannot replay a previous "result" message.
      const { cnonce, wrapped } = e.data as { cnonce: string; wrapped: string };
      let plaintext: string | null = null;
      try {
        if (
          typeof wrapped === 'string' &&
          wrapped.startsWith(ENCRYPTED_API_KEY_PREFIX) &&
          isValidCnonce(cnonce)
        ) {
          if (seenCnonces.has(cnonce)) {
            // Replay: ignore the second request entirely.
            return;
          }
          seenCnonces.add(cnonce);
          setTimeout(() => seenCnonces.delete(cnonce), REPLAY_WINDOW_MS);
          const payload = JSON.parse(wrapped.slice(ENCRYPTED_API_KEY_PREFIX.length)) as unknown;
          if (payload && typeof payload === 'object' && 'v' in payload) {
            const { decryptWithSessionKey } = await import('./infrastructure/storage/session-key');
            plaintext = await decryptWithSessionKey(
              payload as { v: number; iv: string; ct: string },
            );
          }
        }
      } catch {
        plaintext = null;
      }
      window.postMessage({ type: 'rp-decrypt-api-key-result', cnonce, plaintext }, location.origin);
      return;
    }
  });

  const stored = await chrome.storage.local.get([userDataKey, secretKeysKey]);
  const userData = stored[userDataKey];
  const storedSecrets = stored[secretKeysKey];
  const secretKeys: Record<string, string> = {};
  if (isEncryptedSecretBlob(storedSecrets)) {
    const json = await decryptSecrets(extensionId, storedSecrets);
    if (json !== null) {
      try {
        const parsed = JSON.parse(json) as Record<string, string>;
        for (const id of Object.keys(parsed)) {
          const value = parsed[id];
          if (typeof value === 'string' && value.length > 0) {
            secretKeys[id] = value;
          }
        }
      } catch {
        // Treat as empty if JSON is corrupt.
      }
    }
  }
  if (userData !== undefined && typeof userData === 'object') {
    const data = userData as { settings?: { translation?: { providerConfigs?: unknown } } };
    const configs = data?.settings?.translation?.providerConfigs as
      | Record<string, { apiKey?: string }>
      | undefined;
    if (configs !== undefined) {
      for (const id of Object.keys(configs)) {
        const config = configs[id];
        if (typeof config === 'object' && config !== null) {
          const realKey = secretKeys[id] ?? '';
          if (realKey.length > 0) {
            const encrypted = await encryptWithSessionKey(realKey);
            config.apiKey = ENCRYPTED_API_KEY_PREFIX + JSON.stringify(encrypted);
          } else {
            config.apiKey = '';
          }
        }
      }
    }
  }
  return userData;
}

async function waitDocumentReady() {
  while (document.head === null || document.body === null) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

void startup();
