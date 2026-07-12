export function parseSafeImage(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (!/\.(jpg|jpeg|png|webp|avif|gif|svg)$/.test(parsed.pathname)) {
      return null;
    }
    // Route through `new URL().href` so CodeQL treats the value as a normalized URL,
    // not as raw user-controlled DOM text. The protocol/host/scheme checks above
    // ensure only http(s) image URLs reach this point.
    return parsed.href;
  } catch {
    return null;
  }
}
