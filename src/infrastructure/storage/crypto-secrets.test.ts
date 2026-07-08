import { describe, expect, it } from 'vitest';
import { decryptSecrets, encryptSecrets, isEncryptedSecretBlob } from './crypto-secrets';

describe('crypto-secrets', () => {
  const extensionId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('round-trips a plaintext string', async () => {
    const blob = await encryptSecrets(extensionId, 'hello world');
    const out = await decryptSecrets(extensionId, blob);
    expect(out).toBe('hello world');
  });

  it('produces different ciphertext for the same plaintext', async () => {
    const a = await encryptSecrets(extensionId, 'same input');
    const b = await encryptSecrets(extensionId, 'same input');
    expect(a.ct).not.toBe(b.ct);
  });

  it('rejects ciphertext encrypted with a different extension id', async () => {
    const blob = await encryptSecrets(extensionId, 'secret');
    const out = await decryptSecrets('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', blob);
    expect(out).toBeNull();
  });

  it('handles empty plaintext', async () => {
    const blob = await encryptSecrets(extensionId, '');
    const out = await decryptSecrets(extensionId, blob);
    expect(out).toBe('');
  });

  it('rejects an unknown version', async () => {
    const out = await decryptSecrets(extensionId, { v: 99, ct: 'AAAA' });
    expect(out).toBeNull();
  });

  it('rejects a corrupted ciphertext', async () => {
    const blob = await encryptSecrets(extensionId, 'hello');
    // Truncate the ciphertext to a shorter length so the AES-GCM
    // authentication tag cannot be verified.
    const corrupted = { v: blob.v, ct: blob.ct.slice(0, blob.ct.length - 4) };
    const out = await decryptSecrets(extensionId, corrupted);
    expect(out).toBeNull();
  });

  it('isEncryptedSecretBlob recognises valid blobs', () => {
    expect(isEncryptedSecretBlob({ v: 1, ct: 'xxx' })).toBe(true);
    expect(isEncryptedSecretBlob({ v: '1', ct: 'xxx' })).toBe(false);
    expect(isEncryptedSecretBlob(null)).toBe(false);
    expect(isEncryptedSecretBlob({})).toBe(false);
    expect(isEncryptedSecretBlob({ v: 1 })).toBe(false);
  });
});
