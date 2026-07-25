// src/infrastructure/org-api/task-activity.ts
// 集中管理 auto-link 的"活跃任务"集合（按需启停 globalTick interval）。
//
// 活跃任务定义：
//   - 作为 claimer 持有：状态 ∈ {AWAITING_CONTRACT, IN_PROGRESS}
//     → 用于合同自动关联 + 状态同步
//   - 作为 publisher 持有：状态 ∈ {AWAITING_CONTRACT, IN_PROGRESS}
//     且已关联合同（contractId 非空）→ 用于 sync contract status → COMPLETED
//
// 终态判定：COMPLETED / CANCELLED。终态后从 set 移除；set 空时 interval 停。
//
// 调用入口：
//   - claimTask 成功后 → notifyTaskClaimed(task)
//   - linkContract / matchContract 自动关联成功后 → notifyTaskClaimed(task)
//   - 任意"任务可能进入终态"的写操作后 → notifyTaskUpdated(task)

import type { OrgTask, TaskStatus } from './types';
import { registerActiveTask, unregisterActiveTask } from './auto-link';

const TERMINAL_STATUSES = new Set<TaskStatus>(['COMPLETED', 'CANCELLED']);

function needsActivity(task: OrgTask): boolean {
  if (TERMINAL_STATUSES.has(task.status)) return false;
  return task.status === 'AWAITING_CONTRACT' || task.status === 'IN_PROGRESS';
}

// claimTask 成功 / 自动 link 成功后调用：把任务加入活跃集合。
export function notifyTaskClaimed(task: OrgTask): void {
  if (!needsActivity(task)) return;
  registerActiveTask(task.id);
}

// 任何写操作后（release / cancel / sync-status 等）调用：检查终态。
export function notifyTaskUpdated(task: OrgTask): void {
  if (TERMINAL_STATUSES.has(task.status)) {
    unregisterActiveTask(task.id);
    return;
  }
  if (needsActivity(task)) {
    registerActiveTask(task.id);
  }
}
