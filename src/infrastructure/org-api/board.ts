// src/infrastructure/org-api/board.ts
import type { AuditLog, InviteCode, OrgUser } from './types';
import { request } from './client';

export interface GenerateInviteCodesParams {
  count: number;
  createdBy: string;
}

export async function generateInviteCodes(
  params: GenerateInviteCodesParams,
): Promise<InviteCode[]> {
  return request<InviteCode[]>('/board/invite-codes', {
    method: 'POST',
    body: params,
  });
}

export async function listInviteCodes(): Promise<InviteCode[]> {
  return request<InviteCode[]>('/board/invite-codes');
}

export async function revokeInviteCode(id: string): Promise<InviteCode> {
  return request<InviteCode>(`/board/invite-codes/${id}/revoke`, { method: 'POST' });
}

export async function listUsers(): Promise<OrgUser[]> {
  return request<OrgUser[]>('/board/users');
}

export interface ReportUserParams {
  prunUsername: string;
  companyCode: string;
  displayName?: string;
}

export async function reportUser(params: ReportUserParams): Promise<void> {
  return request<void>('/board/users/report', {
    method: 'POST',
    body: params,
    skipAuth: true,
  });
}

export async function promoteUser(userId: string): Promise<OrgUser> {
  return request<OrgUser>(`/board/users/${userId}/promote`, { method: 'POST' });
}

export async function demoteUser(userId: string): Promise<OrgUser> {
  return request<OrgUser>(`/board/users/${userId}/demote`, { method: 'POST' });
}

export interface OrgStats {
  userCount: number;
  taskCount: number;
  boardCount: number;
  collaboratorCount: number;
  nonOrgUserCount: number;
  tasksByStatus: Record<string, number>;
}

export async function fetchStats(): Promise<OrgStats> {
  return request<OrgStats>('/board/stats');
}

export interface ListAuditLogsParams {
  limit?: number;
  cursor?: string;
  action?: string;
  actorId?: string;
}

export interface ListAuditLogsResult {
  items: AuditLog[];
  nextCursor: string | null;
}

export async function listAuditLogs(
  params: ListAuditLogsParams = {},
): Promise<ListAuditLogsResult> {
  const search = new URLSearchParams();
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  if (params.action) search.set('action', params.action);
  if (params.actorId) search.set('actorId', params.actorId);
  return request<ListAuditLogsResult>(`/board/audit-logs?${search.toString()}`);
}
