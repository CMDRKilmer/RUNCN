// src/infrastructure/org-api/auth.ts
import type { AuthSession, OrgUser } from './types';
import { request } from './client';
import { clearSession, saveSession } from './session';

interface RegisterParams {
  email: string;
  password: string;
  inviteCode: string;
  prunUsername: string;
  companyCode: string;
}

export async function register(params: RegisterParams): Promise<AuthSession> {
  const session = await request<AuthSession>('/auth/register', {
    method: 'POST',
    body: params,
    skipAuth: true,
  });
  saveSession(session);
  return session;
}

interface LoginParams {
  email: string;
  password: string;
}

export async function login(params: LoginParams): Promise<AuthSession> {
  const session = await request<AuthSession>('/auth/login', {
    method: 'POST',
    body: params,
    skipAuth: true,
  });
  saveSession(session);
  return session;
}

export async function logout(): Promise<void> {
  const refreshToken = localStorage.getItem('rprun-org-refresh-token');
  if (refreshToken) {
    try {
      await request('/auth/logout', {
        method: 'POST',
        body: { refreshToken },
      });
    } catch {
      // 即使后端调用失败也清本地（如网络断开）
    }
  }
  clearSession();
}

export async function fetchMe(): Promise<OrgUser> {
  return request<OrgUser>('/auth/me');
}
