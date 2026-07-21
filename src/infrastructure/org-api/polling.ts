// src/infrastructure/org-api/polling.ts
import type { OrgTask, OrgUser, TaskStatus } from './types';
import { listTasks } from './tasks';
import { fetchMe } from './auth';
import { updateUser } from './session';

const POLL_INTERVAL_MS = 30_000;
const ROLE_REFRESH_INTERVAL_MS = 60_000; // 每分钟刷新一次 role

export interface PollCallbacks {
  // 任务状态变化时触发（用于面板内 Badge + PrUn NOTS 通知）
  onTaskStatusChanged: (task: OrgTask, oldStatus: TaskStatus, newStatus: TaskStatus) => void;
  // 新任务出现时触发
  onNewTask: (task: OrgTask) => void;
  // role 变化时触发（用于刷新 UI 权限）
  onRoleChanged: (oldRole: string, newRole: string) => void;
  // 拉取错误时触发（用于显示错误提示）
  onError: (err: unknown) => void;
}

// 本地缓存：taskId → lastSeenStatus，用于检测变化
const taskStatusCache = new Map<string, TaskStatus>();
let lastPollAt: string | null = null;
let lastRoleRefreshAt = 0;
let currentUser: OrgUser | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let running = false;

export function setCurrentUser(user: OrgUser | null): void {
  currentUser = user;
}

async function pollOnce(callbacks: PollCallbacks): Promise<void> {
  if (!currentUser) {
    return;
  }
  // 拉取任务板增量
  try {
    const result = await listTasks({
      scope: 'board',
      since: lastPollAt ?? undefined,
      limit: 100,
    });
    const tasks = result.items;
    for (const task of tasks) {
      const oldStatus = taskStatusCache.get(task.id);
      if (oldStatus === undefined) {
        taskStatusCache.set(task.id, task.status);
        if (lastPollAt !== null) {
          // 非首次拉取的新任务
          callbacks.onNewTask(task);
        }
      } else if (oldStatus !== task.status) {
        taskStatusCache.set(task.id, task.status);
        callbacks.onTaskStatusChanged(task, oldStatus, task.status);
      }
    }
    // 推进游标：空结果回退为当前时间，避免下次重复拉取相同区间。
    lastPollAt = tasks.length > 0 ? tasks[tasks.length - 1].updatedAt : new Date().toISOString();
  } catch (err) {
    callbacks.onError(err);
  }

  // 定期刷新 role（架构 §12.21.4）
  const now = Date.now();
  if (now - lastRoleRefreshAt > ROLE_REFRESH_INTERVAL_MS) {
    lastRoleRefreshAt = now;
    try {
      const me = await fetchMe();
      if (currentUser.role !== me.role) {
        const oldRole = currentUser.role;
        currentUser = me;
        updateUser(me);
        callbacks.onRoleChanged(oldRole, me.role);
      }
    } catch {
      // role 刷新失败不阻塞主轮询
    }
  }
}

export function startPolling(callbacks: PollCallbacks): void {
  if (pollTimer) {
    return;
  }
  // 立即拉取一次
  if (!running) {
    running = true;
    void pollOnce(callbacks).finally(() => {
      running = false;
    });
  }
  pollTimer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    void pollOnce(callbacks).finally(() => {
      running = false;
    });
  }, POLL_INTERVAL_MS);
}

export function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  taskStatusCache.clear();
  lastPollAt = null;
  lastRoleRefreshAt = 0;
}

// 重置缓存（登出/切换用户时调用）
export function resetPollingState(): void {
  stopPolling();
  currentUser = null;
}
