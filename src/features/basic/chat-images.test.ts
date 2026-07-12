import { describe, expect, it } from 'vitest';
import { parseSafeImage } from './parse-safe-image';

describe('parseSafeImage', () => {
  it('returns null for null input', () => {
    expect(parseSafeImage(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSafeImage('')).toBeNull();
  });

  it('accepts https url with allowed extension', () => {
    expect(parseSafeImage('https://example.com/photo.jpg')).toBe('https://example.com/photo.jpg');
    expect(parseSafeImage('https://example.com/photo.png')).toBe('https://example.com/photo.png');
    expect(parseSafeImage('https://example.com/photo.webp')).toBe('https://example.com/photo.webp');
    expect(parseSafeImage('https://example.com/photo.gif')).toBe('https://example.com/photo.gif');
    expect(parseSafeImage('https://example.com/photo.svg')).toBe('https://example.com/photo.svg');
    expect(parseSafeImage('https://example.com/photo.avif')).toBe('https://example.com/photo.avif');
    expect(parseSafeImage('https://example.com/photo.jpeg')).toBe('https://example.com/photo.jpeg');
  });

  it('accepts http url with allowed extension', () => {
    expect(parseSafeImage('http://example.com/img.png')).toBe('http://example.com/img.png');
  });

  it('rejects javascript: scheme', () => {
    expect(parseSafeImage('javascript:alert(1)')).toBeNull();
  });

  it('rejects data: scheme', () => {
    expect(parseSafeImage('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects file: scheme', () => {
    expect(parseSafeImage('file:///etc/passwd')).toBeNull();
  });

  it('rejects url with disallowed extension', () => {
    expect(parseSafeImage('https://example.com/file.html')).toBeNull();
    expect(parseSafeImage('https://example.com/file.pdf')).toBeNull();
    expect(parseSafeImage('https://example.com/file.exe')).toBeNull();
  });

  it('rejects url with no file extension', () => {
    expect(parseSafeImage('https://example.com/image')).toBeNull();
  });

  it('rejects malformed url', () => {
    expect(parseSafeImage('not a url at all')).toBeNull();
  });

  it('normalizes url through URL constructor', () => {
    const result = parseSafeImage('https://example.com/path/image.jpg');
    expect(result).toBe(new URL('https://example.com/path/image.jpg').href);
  });
});
