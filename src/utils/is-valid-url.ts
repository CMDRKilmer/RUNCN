export function isValidUrl(url?: string | null) {
  if (!url) {
    return false;
  }
  try {
    return Boolean(new URL(url));
  } catch {
    return false;
  }
}

const SAFE_SCHEMES = new Set(['http:', 'https:']);

export function isSafeUrl(url: string, hostname: string) {
  try {
    const parsed = new URL(url);
    return SAFE_SCHEMES.has(parsed.protocol) && parsed.hostname === hostname;
  } catch {
    return false;
  }
}
