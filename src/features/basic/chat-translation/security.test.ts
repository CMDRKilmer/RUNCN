import { describe, expect, it } from 'vitest';
import {
  errorForNetwork,
  errorForStatus,
  errorForTimeout,
  MAX_TRANSLATION_INPUT_LENGTH,
  TRANSLATION_REQUEST_TIMEOUT_MS,
} from './security';
import { TranslationError } from './types';

describe('security helpers', () => {
  it('exports a positive input cap and timeout', () => {
    expect(MAX_TRANSLATION_INPUT_LENGTH).toBeGreaterThan(0);
    expect(MAX_TRANSLATION_INPUT_LENGTH).toBeLessThanOrEqual(100_000);
    expect(TRANSLATION_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });

  describe('errorForStatus', () => {
    it('handles 401 as not-retryable auth error', () => {
      const err = errorForStatus('OpenAI', 401);
      expect(err).toBeInstanceOf(TranslationError);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('OpenAI');
      expect(err.message).toContain('401');
    });

    it('handles 403 as not-retryable permission error', () => {
      const err = errorForStatus('OpenAI', 403);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain('403');
    });

    it('handles 429 as retryable rate limit error', () => {
      const err = errorForStatus('OpenAI', 429);
      expect(err.retryable).toBe(true);
      expect(err.message).toContain('速率');
    });

    it('handles 5xx as retryable server error', () => {
      const err = errorForStatus('OpenAI', 502);
      expect(err.retryable).toBe(true);
      expect(err.message).toContain('服务');
    });

    it('handles other 4xx as generic not-retryable', () => {
      const err = errorForStatus('OpenAI', 418);
      expect(err.retryable).toBe(false);
    });

    it('does not leak response.statusText or response body', () => {
      const err = errorForStatus('OpenAI', 401);
      expect(err.message).not.toContain('Unauthorized');
      expect(err.message).not.toContain('Bearer');
      expect(err.message).not.toContain('api');
    });
  });

  it('errorForNetwork returns a sanitized message', () => {
    const err = errorForNetwork('HuggingFace');
    expect(err).toBeInstanceOf(TranslationError);
    expect(err.message).toContain('HuggingFace');
    // Must not contain raw fetch error markers.
    expect(err.message).not.toMatch(/Failed to fetch/i);
    expect(err.message).not.toMatch(/TypeError/i);
    expect(err.message).not.toMatch(/cross-origin/i);
  });

  it('errorForTimeout is retryable and names the provider', () => {
    const err = errorForTimeout('Custom');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('Custom');
    expect(err.message).toContain('超时');
  });
});
