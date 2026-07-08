import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The session-key module reaches for `chrome.storage.session` at
// import time. We provide a minimal stub so the module loads in
// node-based vitest.
const storageStore = new Map<string, unknown>();
const sessionStorage = {
  get: vi.fn(async (key: string) => ({ [key]: storageStore.get(key) })),
  set: vi.fn(async (values: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(values)) {
      storageStore.set(k, v);
    }
  }),
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).chrome = {
  storage: { session: sessionStorage },
};

import {
  _resetSessionKeyForTests,
  decryptWithSessionKey,
  encryptWithSessionKey,
  isEncryptedString,
} from './session-key';

describe('session-key', () => {
  beforeEach(() => {
    storageStore.clear();
    _resetSessionKeyForTests();
  });

  afterEach(() => {
    _resetSessionKeyForTests();
  });

  it('round-trips a string', async () => {
    const blob = await encryptWithSessionKey('plaintext');
    const out = await decryptWithSessionKey(blob);
    expect(out).toBe('plaintext');
  });

  it('produces different ciphertext for the same plaintext', async () => {
    const a = await encryptWithSessionKey('same');
    const b = await encryptWithSessionKey('same');
    expect(a.ct).not.toBe(b.ct);
    expect(a.iv).not.toBe(b.iv);
  });

  it('uses the persisted session key from chrome.storage.session', async () => {
    await encryptWithSessionKey('one');
    // The key should now be persisted in storage.
    expect(sessionStorage.set).toHaveBeenCalled();
    // Reset cached key and call again - it should still work because
    // the persisted key is reloaded.
    _resetSessionKeyForTests();
    const blob = await encryptWithSessionKey('two');
    const out = await decryptWithSessionKey(blob);
    expect(out).toBe('two');
  });

  it('rejects an unknown version', async () => {
    const out = await decryptWithSessionKey({ v: 99, iv: 'AAAA', ct: 'AAAA' });
    expect(out).toBeNull();
  });

  it('rejects a corrupted ciphertext', async () => {
    const blob = await encryptWithSessionKey('x');
    const out = await decryptWithSessionKey({ v: blob.v, iv: blob.iv, ct: blob.ct + 'A' });
    expect(out).toBeNull();
  });

  it('isEncryptedString recognises valid blobs', () => {
    expect(isEncryptedString({ v: 1, iv: 'a', ct: 'b' })).toBe(true);
    expect(isEncryptedString({ v: 1, iv: 1, ct: 'b' })).toBe(false);
    expect(isEncryptedString({ v: 1, ct: 'b' })).toBe(false);
    expect(isEncryptedString(null)).toBe(false);
  });
});
