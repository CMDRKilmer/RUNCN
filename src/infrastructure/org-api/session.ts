// src/infrastructure/org-api/session.ts
import type { AuthSession, OrgUser } from './types';

const ACCESS_TOKEN_KEY = 'rprun-org-access-token';
const REFRESH_TOKEN_KEY = 'rprun-org-refresh-token';
const USER_KEY = 'rprun-org-user';

// 仅在扩展上下文可用时操作 localStorage
// （扩展 background/content 上下文与页面 localStorage 隔离）

export function loadSession(): AuthSession | null {
  try {
    const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
    const refreshToken = localStorage.getItem(REFRESH_TOKEN_KEY);
    const userJson = localStorage.getItem(USER_KEY);
    if (!accessToken || !refreshToken || !userJson) {
      return null;
    }
    const user = JSON.parse(userJson) as OrgUser;
    return { accessToken, refreshToken, user };
  } catch {
    return null;
  }
}

export function saveSession(session: AuthSession): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, session.accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, session.refreshToken);
  localStorage.setItem(USER_KEY, JSON.stringify(session.user));
}

export function clearSession(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

// 仅更新 user（用于 /auth/me 拉取最新 role 后）
export function updateUser(user: OrgUser): void {
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

// 仅更新 tokens（用于 /auth/refresh 滚动续期）
export function updateTokens(accessToken: string, refreshToken: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}
