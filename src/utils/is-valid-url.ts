const SAFE_SCHEMES = new Set(['http:', 'https:']);

export function isValidUrl(url?: string | null) {
  if (!url) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return SAFE_SCHEMES.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function isSafeUrl(url: string, hostname: string) {
  try {
    const parsed = new URL(url);
    return SAFE_SCHEMES.has(parsed.protocol) && parsed.hostname === hostname;
  } catch {
    return false;
  }
}
