// src/infrastructure/org-api/permissions.ts
import type { OrgTask, OrgUser } from './types';

// 注意（架构 §12.21.2）：这些 helper 仅用于 UI 显示控制
// 任何敏感操作的实际权限校验都在 Worker 内（boardOnly 中间件 + cancelTask 内 role 校验）

export function isBoard(user: OrgUser | null | undefined): boolean {
  return user?.role === 'BOARD';
}

export function canCancelAny(user: OrgUser | null | undefined): boolean {
  return isBoard(user);
}

export function canCancelTask(user: OrgUser | null | undefined, task: OrgTask): boolean {
  if (!user) {
    return false;
  }
  // 发布者可取消自己任务；BOARD 可取消任何任务
  return task.publisherId === user.id || isBoard(user);
}

export function canSeeBoardPanel(user: OrgUser | null | undefined): boolean {
  return isBoard(user);
}

// BOARD 可升降级他人，但不能降级自己
export function canPromoteDemote(user: OrgUser | null | undefined, targetUserId: string): boolean {
  return isBoard(user) && user!.id !== targetUserId;
}

// 是否显示"取消他人任务"按钮（仅 BOARD 且非自己任务）
export function shouldShowBoardCancel(user: OrgUser | null | undefined, task: OrgTask): boolean {
  return isBoard(user) && task.publisherId !== user?.id;
}
