// AES-GCM helpers for encrypting the secret-keys blob in chrome.storage.
//
// We derive the AES key from chrome.runtime.id (a per-extension constant)
// using PBKDF2 over a fixed application salt. This is not a fortress:
// anyone with code execution inside the extension can call
// chrome.runtime.id and re-derive the same key. The threat we mitigate
// is *passive* exfiltration of the on-disk storage blob (for example a
// backup, a stolen profile copy, or a debug page that prints the raw
// storage contents).
//
// Format on disk: { v: 1, ct: <base64(iv|ciphertext)> }. We prepend a
// version byte so a future migration can ship a new scheme without
// losing existing data.

const VERSION = 1;
const PBKDF2_ITERATIONS = 100_000;
const SALT = 'refined-prun-translation-secrets-v1';

let cachedKey: CryptoKey | null = null;
let cachedKeyFor: string | null = null;

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

async function getKey(extensionId: string): Promise<CryptoKey> {
  if (cachedKey !== null && cachedKeyFor === extensionId) {
    return cachedKey;
  }
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey('raw', enc.encode(extensionId), 'PBKDF2', false, [
    'deriveKey',
  ]);
  const key = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode(SALT),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  cachedKey = key;
  cachedKeyFor = extensionId;
  return key;
}

export interface EncryptedSecretBlob {
  v: number;
  ct: string;
}

export async function encryptSecrets(
  extensionId: string,
  plaintext: string,
): Promise<EncryptedSecretBlob> {
  const key = await getKey(extensionId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)),
  );
  const combined = new Uint8Array(iv.length + ciphertext.length);
  combined.set(iv, 0);
  combined.set(ciphertext, iv.length);
  return { v: VERSION, ct: bytesToBase64(combined) };
}

export async function decryptSecrets(
  extensionId: string,
  blob: EncryptedSecretBlob,
): Promise<string | null> {
  if (blob.v !== VERSION) {
    return null;
  }
  try {
    const key = await getKey(extensionId);
    const combined = base64ToBytes(blob.ct);
    if (combined.length <= 12) {
      return null;
    }
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(plaintext);
  } catch {
    // Wrong key, corrupted blob, or version mismatch. Callers fall
    // back to treating the slot as empty.
    return null;
  }
}

export function isEncryptedSecretBlob(value: unknown): value is EncryptedSecretBlob {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const v = (value as { v?: unknown }).v;
  const ct = (value as { ct?: unknown }).ct;
  return typeof v === 'number' && typeof ct === 'string';
}
