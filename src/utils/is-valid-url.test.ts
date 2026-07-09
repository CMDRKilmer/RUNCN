import { describe, expect, test } from 'vitest';
import { isSafeUrl, isValidUrl } from './is-valid-url';

describe('isValidUrl', () => {
  test.each([
    [undefined, false],
    [null, false],
    ['', false],
    ['not a url', false],
    ['https://example.com', true],
  ])('isValidUrl(%s) === %s', (input, expected) => {
    expect(isValidUrl(input)).toBe(expected);
  });
});

describe('isSafeUrl', () => {
  const allowedHost = 'apex.prosperousuniverse.com';

  test('accepts http(s) url on exact hostname', () => {
    expect(isSafeUrl('https://apex.prosperousuniverse.com/foo.js', allowedHost)).toBe(true);
    expect(isSafeUrl('http://apex.prosperousuniverse.com/foo.js', allowedHost)).toBe(true);
  });

  test('rejects hostname suffix / contains tricks', () => {
    expect(isSafeUrl('https://evil-apex.prosperousuniverse.com/foo.js', allowedHost)).toBe(false);
    expect(
      isSafeUrl('https://evilexample.com/apex.prosperousuniverse.com/foo.js', allowedHost),
    ).toBe(false);
    expect(isSafeUrl('https://evil.com?x=apex.prosperousuniverse.com', allowedHost)).toBe(false);
  });

  test.each([
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
  ])('rejects unsafe scheme %s', url => {
    expect(isSafeUrl(url, allowedHost)).toBe(false);
  });

  test('rejects garbage', () => {
    expect(isSafeUrl('not a url', allowedHost)).toBe(false);
    expect(isSafeUrl('', allowedHost)).toBe(false);
  });
});
