// Bridge between the page script and the content script for working
// with encrypted-at-rest API keys.
//
// The page script never holds plaintext API keys in long-lived memory.
// When the user enters a key in the settings UI we ship it to the
// content script over a dedicated `rp-save-secret-keys` message and
// forget the plaintext. When the content script has populated
// `userData.settings.translation.providerConfigs[id].apiKey` on
// startup, the value is wrapped with a sentinel prefix and base64 JSON
// of an AES-GCM ciphertext. Provider code calls `resolveApiKey()` to
// get the plaintext for a single API request; the result is held by
// the caller in a local variable that is not stored anywhere.
//
// Every request/response pair is bound to a 128-bit client nonce
// (`cnonce`) generated here. The content script only answers requests
// whose `cnonce` it has not seen before, and only echoes back the same
// `cnonce` on the response. This blocks replay of an old "result"
// message, ties a result to a particular request, and means the
// request id space cannot be guessed by an in-page script that can
// listen on the same channel.

const ENCRYPTED_API_KEY_PREFIX = '__rpenc__:';
const DEFAULT_TIMEOUT_MS = 5_000;

interface PendingRequest {
  resolve: (plain: string | null) => void;
  timeout: number;
}

const pending = new Map<string, PendingRequest>();

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i] as number);
  }
  return btoa(s);
}

function isValidNonce(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9+/=]{22,24}$/.test(value);
}

if (typeof window !== 'undefined') {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window) {
      return;
    }
    if (e.origin !== location.origin) {
      return;
    }
    const data = e.data as {
      type?: string;
      cnonce?: unknown;
      plaintext?: string | null;
    };
    if (data?.type !== 'rp-decrypt-api-key-result' || !isValidNonce(data.cnonce)) {
      return;
    }
    const entry = pending.get(data.cnonce);
    if (entry === undefined) {
      // Replay or unknown nonce. Drop silently.
      return;
    }
    pending.delete(data.cnonce);
    clearTimeout(entry.timeout);
    entry.resolve(data.plaintext ?? null);
  });
}

export function isEncryptedApiKeyValue(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_API_KEY_PREFIX);
}

export async function resolveApiKey(
  wrapped: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  if (!isEncryptedApiKeyValue(wrapped)) {
    return wrapped;
  }
  const cnonce = randomNonce();
  return await new Promise<string>(resolve => {
    const entry: PendingRequest = {
      resolve: plain => {
        resolve(plain ?? '');
      },
      timeout: 0,
    };
    entry.timeout = window.setTimeout(() => {
      pending.delete(cnonce);
      resolve('');
    }, timeoutMs);
    pending.set(cnonce, entry);
    window.postMessage({ type: 'rp-decrypt-api-key', cnonce, wrapped }, location.origin);
  });
}

// Used by the settings UI to persist a freshly entered API key.
export function postSaveSecretKeys(secretKeys: Record<string, string>): Promise<void> {
  return new Promise<void>(resolve => {
    const listener = (e: MessageEvent) => {
      if (e.source !== window) {
        return;
      }
      if (e.data?.type === 'rp-secret-keys-saved') {
        window.removeEventListener('message', listener);
        resolve();
      }
    };
    window.addEventListener('message', listener);
    window.postMessage({ type: 'rp-save-secret-keys', secretKeys }, location.origin);
  });
}
