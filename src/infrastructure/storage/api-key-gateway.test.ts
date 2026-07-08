import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.stubGlobal / globals must be set up before the module under test
// is loaded. vi.hoisted ensures the setup runs at the top of the
// test file, before any import.
const { mock } = vi.hoisted(() => {
  class MockWindow {
    static listeners: Array<(e: MessageEvent) => void> = [];
    static posted: Array<{ type: string; payload: unknown; origin: string }> = [];
    static origin = 'https://apex.prosperousuniverse.com';
    static self: object | null = null;

    addEventListener(type: string, listener: (e: MessageEvent) => void) {
      if (type === 'message') {
        MockWindow.listeners.push(listener);
      }
    }
    removeEventListener(type: string, listener: (e: MessageEvent) => void) {
      if (type === 'message') {
        MockWindow.listeners = MockWindow.listeners.filter(l => l !== listener);
      }
    }
    postMessage(payload: unknown, origin: string) {
      MockWindow.posted.push({ type: 'unknown', payload, origin });
    }

    static dispatch(payload: unknown, sourceOverride: object | null = null) {
      const e = {
        data: payload,
        source: sourceOverride === null ? MockWindow.self : sourceOverride,
        origin: MockWindow.origin,
      } as unknown as MessageEvent;
      for (const l of MockWindow.listeners) {
        l(e);
      }
    }

    static setSelf(self: object) {
      MockWindow.self = self;
    }
  }

  const mw = new MockWindow();
  (mw as unknown as { __rp_self: boolean }).__rp_self = true;
  (mw as unknown as { setTimeout: typeof setTimeout }).setTimeout = setTimeout;
  (mw as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = clearTimeout;
  MockWindow.setSelf(mw);
  vi.stubGlobal('window', mw);
  vi.stubGlobal('location', { origin: MockWindow.origin });
  return { mockWindow: mw, mock: MockWindow };
});

import { isEncryptedApiKeyValue, resolveApiKey } from './api-key-gateway';

const MockWindow = mock;

describe('api-key-gateway', () => {
  beforeEach(() => {
    // Clear posted messages but keep the gateway's own listener
    // installed on MockWindow.listeners.
    MockWindow.posted = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes plaintext values through unchanged', async () => {
    const out = await resolveApiKey('plaintext-key');
    expect(out).toBe('plaintext-key');
  });

  it('isEncryptedApiKeyValue detects the sentinel prefix', () => {
    expect(isEncryptedApiKeyValue('__rpenc__:xyz')).toBe(true);
    expect(isEncryptedApiKeyValue('not-encrypted')).toBe(false);
    expect(isEncryptedApiKeyValue(null)).toBe(false);
    expect(isEncryptedApiKeyValue(undefined)).toBe(false);
    expect(isEncryptedApiKeyValue(42)).toBe(false);
  });

  it('posts a decrypt request with a 128-bit cnonce for wrapped keys', async () => {
    const pending = resolveApiKey('__rpenc__:payload');
    // Give the post a microtask to settle.
    await Promise.resolve();
    expect(MockWindow.posted.length).toBe(1);
    const { type, payload, origin } = MockWindow.posted[0]!;
    expect(type).toBe('unknown');
    expect(origin).toBe(MockWindow.origin);
    const data = payload as { type: string; cnonce: string; wrapped: string };
    expect(data.type).toBe('rp-decrypt-api-key');
    expect(data.cnonce.length).toBeGreaterThanOrEqual(22);
    expect(data.cnonce.length).toBeLessThanOrEqual(24);
    expect(data.wrapped).toBe('__rpenc__:payload');

    // Simulate a content script reply.
    console.log(
      'PRE-DISPATCH listeners:',
      MockWindow.listeners.length,
      'posted:',
      MockWindow.posted.length,
    );
    MockWindow.dispatch({
      type: 'rp-decrypt-api-key-result',
      cnonce: data.cnonce,
      plaintext: 'secret',
    });
    console.log('POST-DISPATCH listeners:', MockWindow.listeners.length);
    const out = await pending;
    expect(out).toBe('secret');
  });

  it('rejects replies with mismatched cnonce', async () => {
    const pending = resolveApiKey('__rpenc__:payload');
    await Promise.resolve();
    const data = MockWindow.posted[0]!.payload as { cnonce: string };
    // Reply with a wrong cnonce.
    MockWindow.dispatch({
      type: 'rp-decrypt-api-key-result',
      cnonce: 'wrong-cnonce-here-xx',
      plaintext: 'leaked',
    });
    // Drive the loop one more time to make sure nothing accepted it.
    await new Promise(r => setTimeout(r, 5));
    expect(pending).toBeInstanceOf(Promise);

    // Now reply with the right cnonce.
    MockWindow.dispatch({
      type: 'rp-decrypt-api-key-result',
      cnonce: data.cnonce,
      plaintext: 'real',
    });
    const out = await pending;
    expect(out).toBe('real');
  });

  it('ignores replies with malformed cnonce', async () => {
    const pending = resolveApiKey('__rpenc__:payload');
    await Promise.resolve();
    const data = MockWindow.posted[0]!.payload as { cnonce: string };

    MockWindow.dispatch({
      type: 'rp-decrypt-api-key-result',
      cnonce: '<script>alert(1)</script>',
      plaintext: 'evil',
    });
    // Should still be pending; send a real one.
    MockWindow.dispatch({
      type: 'rp-decrypt-api-key-result',
      cnonce: data.cnonce,
      plaintext: 'ok',
    });
    const out = await pending;
    expect(out).toBe('ok');
  });

  it('ignores messages from a different window source', async () => {
    const pending = resolveApiKey('__rpenc__:payload');
    await Promise.resolve();
    const data = MockWindow.posted[0]!.payload as { cnonce: string };

    // Mark the source as a different window.
    MockWindow.dispatch(
      { type: 'rp-decrypt-api-key-result', cnonce: data.cnonce, plaintext: 'fake' },
      { __rp_other: true },
    );
    MockWindow.dispatch({
      type: 'rp-decrypt-api-key-result',
      cnonce: data.cnonce,
      plaintext: 'real',
    });
    const out = await pending;
    expect(out).toBe('real');
  });

  it('times out and resolves to empty string', async () => {
    const pending = resolveApiKey('__rpenc__:payload', 30);
    // Wait long enough for the timeout to fire.
    const out = await pending;
    expect(out).toBe('');
  });

  it('ignores non-result messages on the channel', async () => {
    const pending = resolveApiKey('__rpenc__:payload');
    await Promise.resolve();
    const data = MockWindow.posted[0]!.payload as { cnonce: string };

    // Random noise on the same channel should be ignored.
    MockWindow.dispatch({ type: 'something-else', payload: 1 });
    MockWindow.dispatch({
      type: 'rp-decrypt-api-key-result',
      cnonce: data.cnonce,
      plaintext: 'ok',
    });
    const out = await pending;
    expect(out).toBe('ok');
  });
});
