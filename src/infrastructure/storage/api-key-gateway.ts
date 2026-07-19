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
// Every request/response pair is exchanged over a dedicated
// `MessageChannel`. The page side creates the channel, transfers one
// port to the content script, and listens on the other port. Messages
// on a port are delivered only to the other end of that channel, so
// plaintext API keys never appear on the broadcast `window.postMessage`
// channel and cannot be read by passive same-origin listeners.

const ENCRYPTED_API_KEY_PREFIX = '__rpenc__:';
const DEFAULT_TIMEOUT_MS = 5_000;

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

  return await new Promise<string>(resolve => {
    let settled = false;
    const channel = new MessageChannel();
    const finish = (value: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(''), timeoutMs);
    channel.port1.onmessage = (e: MessageEvent) => {
      const data = e.data as { plaintext?: string | null };
      finish(data.plaintext ?? '');
    };
    // Transfer port2 so only the content script can reply on it. The
    // response is delivered to port1 only, never broadcast on window.
    window.postMessage({ type: 'rp-decrypt-api-key', wrapped }, location.origin, [channel.port2]);
  });
}

// Used by the settings UI to persist a freshly entered API key.
export function postSaveSecretKeys(secretKeys: Record<string, string>): Promise<void> {
  return new Promise<void>(resolve => {
    let settled = false;
    const channel = new MessageChannel();
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      channel.port1.close();
      resolve();
    };
    const timer = window.setTimeout(finish, DEFAULT_TIMEOUT_MS);
    channel.port1.onmessage = finish;
    // Transfer port2 so the plaintext keys are delivered only to the
    // content script's port, never broadcast on window.
    window.postMessage({ type: 'rp-save-secret-keys', secretKeys }, location.origin, [
      channel.port2,
    ]);
  });
}
