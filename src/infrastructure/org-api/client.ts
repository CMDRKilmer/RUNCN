// src/infrastructure/org-api/client.ts
import type { ApiError, AuthSession } from './types';
import { clearSession, getAccessToken, getRefreshToken, loadSession, saveSession } from './session';

// API base URL（架构 §12.15 VITE_ORG_API_BASE）
const API_BASE = import.meta.env.VITE_ORG_API_BASE || 'http://localhost:8787';

// 全局未登录回调（被 ORG.vue 注册，触发 AuthOverlay 显示）
let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorizedCallback(cb: () => void): void {
  onUnauthorized = cb;
}

// 刷新锁：防止并发 401 同时刷新
let refreshPromise: Promise<AuthSession | null> | null = null;
// session 已过期标志：防止 refreshSession 被多次调用时重复触发 onUnauthorized / clearSession
let sessionExpired = false;

// 主动预刷新阈值：access token 剩余有效期不足此秒数时，
// 在原请求发出前先 refresh，避免以过期 token 发出 401 请求。
const REFRESH_AHEAD_SECONDS = 60;

// 解析 JWT 的 exp（Unix 秒）。非 JWT 或不含 exp 时返回 null。
// 不做签名校验——后端会在 401 时兜底；这里只用来决策"是否要提前 refresh"。
function getAccessTokenExp(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    // base64url → base64
    const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const json = atob(padded);
    const obj = JSON.parse(json) as { exp?: unknown };
    return typeof obj.exp === 'number' ? obj.exp : null;
  } catch {
    return null;
  }
}

async function refreshSession(): Promise<AuthSession | null> {
  if (sessionExpired) {
    return null;
  }
  if (refreshPromise) {
    return refreshPromise;
  }
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
    sessionExpired = true;
    clearSession();
    onUnauthorized?.();
    return null;
  }
  refreshPromise = (async () => {
    try {
      const res = await fetch(`${API_BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) {
        sessionExpired = true;
        clearSession();
        onUnauthorized?.();
        return null;
      }
      const session = (await res.json()) as AuthSession;
      saveSession(session);
      sessionExpired = false;
      return session;
    } catch {
      sessionExpired = true;
      clearSession();
      onUnauthorized?.();
      return null;
    } finally {
      refreshPromise = null;
    }
  })();
  return refreshPromise;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  // 跳过鉴权（用于 /auth/register /auth/login /auth/refresh）
  skipAuth?: boolean;
  // 跳过 JSON Content-Type（用于 FormData 等，本计划暂未使用）
  rawBody?: boolean;
}

const doFetch = (
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string | null },
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  return fetch(url, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body ?? undefined,
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
};

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (!options.rawBody && options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  // 预刷新：access token 剩余有效期不足阈值时先 refresh，
  // 避免原请求以过期 token 发出 401（浏览器 DevTools 会把 4xx 标红，无法抑制）。
  // 非 JWT / 无 exp / refresh 也失败 → 静默回退到原 401 refresh 逻辑。
  if (!options.skipAuth) {
    const token = getAccessToken();
    if (token) {
      const exp = getAccessTokenExp(token);
      if (exp !== null && exp - Math.floor(Date.now() / 1000) < REFRESH_AHEAD_SECONDS) {
        const newSession = await refreshSession();
        if (newSession) {
          headers['Authorization'] = `Bearer ${newSession.accessToken}`;
        } else {
          headers['Authorization'] = `Bearer ${token}`;
        }
      } else {
        headers['Authorization'] = `Bearer ${token}`;
      }
    }
  }

  const body =
    options.body !== undefined
      ? options.rawBody
        ? (options.body as string)
        : JSON.stringify(options.body)
      : null;

  let res = await doFetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body,
  });

  // 网络抖动重试（最多 2 次，指数退避 500ms / 1500ms）。4xx 不重试（除 401）。
  for (let attempt = 0; attempt < 2 && !res.ok && res.status >= 500; attempt++) {
    await new Promise(r => setTimeout(r, 500 * Math.pow(3, attempt)));
    res = await doFetch(`${API_BASE}${path}`, { method: options.method ?? 'GET', headers, body });
  }

  // 401 自动刷新一次
  if (res.status === 401 && !options.skipAuth) {
    const newSession = await refreshSession();
    if (newSession) {
      headers['Authorization'] = `Bearer ${newSession.accessToken}`;
      res = await doFetch(`${API_BASE}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body,
      });
    }
  }

  if (!res.ok) {
    let code = `HTTP_${res.status}`;
    let message = res.statusText;
    try {
      const err = (await res.json()) as ApiError;
      code = err.error?.code ?? code;
      message = err.error?.message ?? message;
    } catch {
      // 响应非 JSON，使用默认
    }
    throw new HttpError(res.status, code, message);
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

// 启动时加载已存会话（用于 ORG.vue 判断是否需要显示 AuthOverlay）
export function getStoredSession(): AuthSession | null {
  return loadSession();
}

// 重置 session 过期标志（login/register 成功后调用，确保后续 401 能正常触发刷新）
export function resetSessionExpiredFlag(): void {
  sessionExpired = false;
}
