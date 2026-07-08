import { TranslationError } from './types';

// Maximum characters of input text we forward to any provider. Anything
// larger is rejected up front so a runaway selection (or a malicious
// chat message) cannot drain LLM token budgets or blow up memory.
export const MAX_TRANSLATION_INPUT_LENGTH = 2000;

// Timeout for outbound translation requests. Without this a stalled
// network leaves the user looking at a permanent loading spinner.
export const TRANSLATION_REQUEST_TIMEOUT_MS = 30_000;

// Builds a user-safe error message for an HTTP status code. We never
// include the raw fetch error text, the response body, or any header
// that may contain the API key.
export function errorForStatus(providerName: string, status: number): TranslationError {
  const name = providerName;
  if (status === 401) {
    return new TranslationError(`${name} 鉴权失败（401）：API 密钥无效或已过期。`, false);
  }
  if (status === 403) {
    return new TranslationError(`${name} 访问被拒（403）：API 密钥无访问权限。`, false);
  }
  if (status === 429) {
    return new TranslationError(`${name} 达到速率限制，请稍后重试。`);
  }
  if (status >= 500) {
    return new TranslationError(`${name} 服务暂时不可用，请稍后重试。`);
  }
  // Other 4xx (e.g. 400, 404, 422) are typically caused by a bad
  // request, not a transient failure, so retrying is unlikely to help.
  return new TranslationError(`${name} 请求失败（${status}）。`, false);
}

export function errorForNetwork(providerName: string): TranslationError {
  // Do NOT include the raw TypeError message: it can mention the URL,
  // cookies, CORS state and other details we do not want surfaced.
  return new TranslationError(`网络错误：无法连接到 ${providerName}。`);
}

export function errorForTimeout(providerName: string): TranslationError {
  return new TranslationError(`${providerName} 响应超时，请稍后重试。`);
}

// Wraps fetch() with a hard timeout so a hung connection cannot stall
// the UI. Returns a normal Response on success, throws a sanitized
// TranslationError on timeout / network failure / abort.
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  providerName: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSLATION_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw errorForTimeout(providerName);
    }
    throw errorForNetwork(providerName);
  } finally {
    clearTimeout(timer);
  }
}
