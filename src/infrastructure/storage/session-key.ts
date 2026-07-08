// Session-scoped AES key for the page-side secret store.
//
// The key is generated once per extension session and lives in
// chrome.storage.session (Chrome MV3) or an in-memory fallback. It
// never touches disk. The key is used by the content script to wrap
// API keys before posting them to the page script, so the postMessage
// channel never carries plaintext keys at rest.

const SESSION_KEY_ID = 'rp-session-key';
let sessionKey: CryptoKey | null = null;

export interface SessionKeyEnvelope {
  v: number;
  k: string; // base64 raw 256-bit AES key
}

const SESSION_KEY_VERSION = 1;

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i] as number);
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    out[i] = s.charCodeAt(i);
  }
  return out;
}

function getSessionStorage(): chrome.storage.SessionStorageArea | null {
  const candidate = (chrome.storage as { session?: chrome.storage.SessionStorageArea }).session;
  return candidate ?? null;
}

export async function loadSessionKey(): Promise<CryptoKey> {
  if (sessionKey !== null) {
    return sessionKey;
  }
  const storage = getSessionStorage();
  let material: Uint8Array | null = null;
  if (storage !== null) {
    const stored = await storage.get(SESSION_KEY_ID);
    const envelope = stored[SESSION_KEY_ID];
    if (isEnvelope(envelope)) {
      material = base64ToBytes(envelope.k);
    }
  }
  if (material === null) {
    material = randomBytes(32);
    if (storage !== null) {
      await storage.set({
        [SESSION_KEY_ID]: { v: SESSION_KEY_VERSION, k: bytesToBase64(material) },
      });
    }
  }
  sessionKey = await crypto.subtle.importKey(
    'raw',
    material as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
  return sessionKey;
}

export interface EncryptedString {
  v: number;
  iv: string;
  ct: string;
}

const ENCRYPTED_STRING_VERSION = 1;

export async function encryptWithSessionKey(plaintext: string): Promise<EncryptedString> {
  const key = await loadSessionKey();
  const iv = randomBytes(12);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  return {
    v: ENCRYPTED_STRING_VERSION,
    iv: bytesToBase64(iv),
    ct: bytesToBase64(ciphertext),
  };
}

export async function decryptWithSessionKey(blob: EncryptedString): Promise<string | null> {
  if (blob.v !== ENCRYPTED_STRING_VERSION) {
    return null;
  }
  if (sessionKey === null) {
    await loadSessionKey();
  }
  if (sessionKey === null) {
    return null;
  }
  try {
    const iv = base64ToBytes(blob.iv);
    const ciphertext = base64ToBytes(blob.ct);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      sessionKey,
      ciphertext as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

export function isEncryptedString(value: unknown): value is EncryptedString {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = (value as { v?: unknown }).v;
  const iv = (value as { iv?: unknown }).iv;
  const ct = (value as { ct?: unknown }).ct;
  return typeof v === 'number' && typeof iv === 'string' && typeof ct === 'string';
}

function isEnvelope(value: unknown): value is SessionKeyEnvelope {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = (value as { v?: unknown }).v;
  const k = (value as { k?: unknown }).k;
  return typeof v === 'number' && typeof k === 'string';
}

// Used by tests / debug code. Do not call from production paths.
export function _resetSessionKeyForTests() {
  sessionKey = null;
}
