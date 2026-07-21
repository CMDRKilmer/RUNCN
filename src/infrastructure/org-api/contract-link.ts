// src/infrastructure/org-api/contract-link.ts
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import type { OrgTask, PrunContractStatus } from './types';
import { syncContractStatus } from './tasks';

// 已上报过的状态记录，避免重复上报（同一状态多次触发只发一次）
const reportedStatuses = new Map<string, Set<string>>();

// 合同状态 → 是否触发任务状态转移（架构 §7.3 修正后）
// CLOSED → IN_PROGRESS, FULFILLED → COMPLETED, CANCELLED/TERMINATED/BREACHED/REJECTED/DEADLINE_EXCEEDED → CANCELLED
const TRANSITION_STATUSES: ReadonlySet<PrunContractStatus> = new Set([
  'CLOSED',
  'FULFILLED',
  'CANCELLED',
  'TERMINATED',
  'BREACHED',
  'REJECTED',
  'DEADLINE_EXCEEDED',
]);

// 监听任务关联合同的状态变化，自动上报 Worker
// 调用方在 watchEffect 内调用以获得响应性
export function watchContractStatus(task: OrgTask): void {
  if (!task.contractId) {
    return;
  }
  if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
    return;
  }
  const contract = contractsStore.getById(task.contractId);
  if (!contract) {
    return;
  }
  const status = contract.status as PrunContractStatus;
  if (!TRANSITION_STATUSES.has(status)) {
    return;
  }
  const reported = reportedStatuses.get(task.id) ?? new Set<string>();
  if (reported.has(status)) {
    return;
  }
  reported.add(status);
  reportedStatuses.set(task.id, reported);
  // fire-and-forget；Worker 内会再做幂等校验
  void syncContractStatus(task.id, status).catch(err => {
    console.warn(`[ORG] syncContractStatus failed for task ${task.id}:`, err);
    // 失败时移除记录，允许下次重试
    reported.delete(status);
  });
}

// 任务详情页关闭时清理记录（避免内存泄漏）
export function clearReportedStatus(taskId: string): void {
  reportedStatuses.delete(taskId);
}
