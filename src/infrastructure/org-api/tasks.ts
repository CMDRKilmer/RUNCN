// src/infrastructure/org-api/tasks.ts
import type {
  ListTasksResult,
  OrgTask,
  PollScope,
  ReleaseTaskResult,
  TaskContractJson,
  TaskType,
} from './types';
import type { ContractFingerprint, ContractMatchResult } from './contract-link';
import { HttpError, request } from './client';
import { notifyTaskClaimed, notifyTaskUpdated } from './task-activity';

export interface ListTasksParams {
  scope: PollScope;
  type?: TaskType;
  publisherUsername?: string;
  claimerUsername?: string;
  location?: string;
  since?: string; // ISO 8601，仅返回 updatedAt > since 的任务
  limit?: number;
  cursor?: string;
}

export async function listTasks(params: ListTasksParams): Promise<ListTasksResult> {
  const search = new URLSearchParams();
  search.set('scope', params.scope);
  if (params.type) search.set('type', params.type);
  if (params.publisherUsername) search.set('publisherUsername', params.publisherUsername);
  if (params.claimerUsername) search.set('claimerUsername', params.claimerUsername);
  if (params.location) search.set('location', params.location);
  if (params.since) search.set('since', params.since);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.cursor) search.set('cursor', params.cursor);
  return request<ListTasksResult>(`/tasks?${search.toString()}`);
}

export async function getTask(taskId: string): Promise<OrgTask> {
  return request<OrgTask>(`/tasks/${taskId}`);
}

export interface CreateTaskParams {
  type: TaskType;
  contractJson: TaskContractJson;
  expiresAt?: string;
}

export async function createTask(params: CreateTaskParams): Promise<OrgTask> {
  return request<OrgTask>('/tasks', {
    method: 'POST',
    body: params,
  });
}

export interface PatchTaskParams {
  contractJson?: TaskContractJson;
  expiresAt?: string;
}

export async function patchTask(taskId: string, params: PatchTaskParams): Promise<OrgTask> {
  return request<OrgTask>(`/tasks/${taskId}`, {
    method: 'PATCH',
    body: params,
  });
}

// 老架构 claimTask 已删除——接取走 listings.claimListing（listings.ts）。
//   MarketView / TradeOverlay 调 listListings 后由用户点接取 → 弹出 TradeOverlay
//   → 调 listingsApi.claimListing(listingId, amount) → 通知 notifyTaskClaimed。

export async function releaseTask(taskId: string): Promise<ReleaseTaskResult> {
  // 完整接取 → { task }
  // 部分接取子任务 → { task: 父任务, parentTaskId, restoredAmount }
  const result = await request<ReleaseTaskResult>(`/tasks/${taskId}/release`, { method: 'POST' });
  // release → 任务回 PUBLISHED（AWAITING_CONTRACT → PUBLISHED），但仍然可能被人接取。
  // 这里不做 terminal 通知；让 polling 的自然刷新 + 后续接取来管。
  // 如果 release 是 partial 子任务，result.task 是父任务，状态回 PUBLISHED，更不在活跃集。
  notifyTaskUpdated(result.task);
  return result;
}

export async function cancelTask(taskId: string, reason?: string): Promise<OrgTask> {
  const task = await request<OrgTask>(`/tasks/${taskId}/cancel`, {
    method: 'POST',
    body: reason !== undefined ? { reason } : undefined,
  });
  notifyTaskUpdated(task);
  return task;
}

// 重新发布：CANCELLED → PUBLISHED。仅 publisher 可重新发布自己取消的任务。
// 返回更新后的任务，状态回到 PUBLISHED。
export async function republishTask(taskId: string): Promise<OrgTask> {
  return request<OrgTask>(`/tasks/${taskId}/republish`, { method: 'POST' });
}

// 物理删除任务。仅发布者可删除自己发布的任务（后端 service 校验）。
// 返回删除前的快照，便于前端展示"已删除 ... 任务"之类的 toast。
//
// 错误兜底：DELETE 端点若未在 Worker 上部署（Hono root notFound 返回 404），
// 与"任务已被物理删除/不存在"同样表现为 404。前端统一抛 friendlyMessage，
// 避免 UI 上只看到冷冰冰的英文 "Not found"。
export async function deleteTask(taskId: string): Promise<OrgTask> {
  try {
    return await request<OrgTask>(`/tasks/${taskId}`, {
      method: 'DELETE',
    });
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      // 区分任务不存在 / 已删 与端点未部署：
      //  - Hono root notFound 的 message 是 "Not found"（root 兜底路由）
      //  - service 抛的 notFound('Task not found') message 是 "Task not found"
      // 端点未部署时,request 收到的 err.message 通常就是 "Not found"。
      const friendly = err.message.toLowerCase().includes('task')
        ? '任务不存在或已被删除'
        : 'Worker 尚未部署删除接口，请确认 wrangler deploy 已运行到含 DELETE 路由的 commit';
      throw new HttpError(
        404,
        err.message.toLowerCase().includes('task') ? 'TASK_NOT_FOUND' : 'DELETE_ENDPOINT_MISSING',
        friendly,
      );
    }
    throw err;
  }
}

export interface LinkContractParams {
  contractId: string;
  contractCreator: 'publisher' | 'claimer';
}

export async function linkContract(taskId: string, params: LinkContractParams): Promise<OrgTask> {
  const task = await request<OrgTask>(`/tasks/${taskId}/link-contract`, {
    method: 'POST',
    body: params,
  });
  // 关联合同后任务进 IN_PROGRESS：保持活跃（sync contract status 仍需关注）。
  notifyTaskClaimed(task);
  return task;
}

export interface MatchContractParams {
  contractId: string;
  fingerprint: ContractFingerprint;
  // true → 后端在匹配成功后直接调 link-contract；false → 仅返回比对结果
  autoLink?: boolean;
}

// 自动关联合同权威匹配端点。前端轮询 PrUn contractsStore 命中指纹后，
// 调用本端点由后端以 task.contractJson 为 source of truth 二次确认。
// 始终返回 200 + ContractMatchResult（matched + 可选 reason/task）。
// 业务错误（NOT_TASK_PARTY / INVALID_TRANSITION / CONTRACT_ALREADY_LINKED
// 等）由后端 errorHandler 翻译为 4xx，由前端 request 抛 HttpError。
export async function matchContract(
  taskId: string,
  params: MatchContractParams,
): Promise<ContractMatchResult & { task?: OrgTask }> {
  return request<ContractMatchResult & { task?: OrgTask }>(`/tasks/${taskId}/match-contract`, {
    method: 'POST',
    body: params,
  });
}

export async function syncContractStatus(taskId: string, contractStatus: string): Promise<OrgTask> {
  const task = await request<OrgTask>(`/tasks/${taskId}/sync-status`, {
    method: 'POST',
    body: { contractStatus },
  });
  // sync 后端会把任务推到 COMPLETED/CANCELLED 等终态；通知模块按 status 决定是否 unregister。
  notifyTaskUpdated(task);
  return task;
}
