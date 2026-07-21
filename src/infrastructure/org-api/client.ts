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

async function refreshSession(): Promise<AuthSession | null> {
  if (refreshPromise) {
    return refreshPromise;
  }
  const refreshToken = getRefreshToken();
  if (!refreshToken) {
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
        clearSession();
        onUnauthorized?.();
        return null;
      }
      const session = (await res.json()) as AuthSession;
      saveSession(session);
      return session;
    } catch {
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
  if (!options.skipAuth) {
    const token = getAccessToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
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
