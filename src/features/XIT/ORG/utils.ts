// src/features/XIT/ORG/utils.ts
import { getTileState } from '@src/store/user-data-tiles';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import type { TaskContractJson, TaskType } from '@src/infrastructure/org-api/types';

// 复用 CONTGEN.vue 第 200-211 行 sendToContd 的转交路径：
// 写入 'contgen-output' workspace + 调用 showBuffer('CONTD')
// CONTD 面板在下次挂载时读取 workspace.json 自动填充

// 合同类型反转规则（架构 §3 + §7.2）：
// BUY 任务由接取者创建 SELL 合同（接取者卖物料给发布者）
// SELL 任务由接取者创建 BUY 合同（接取者从发布者买物料）
// SHIP 任务保持 SHIP（仅由发布者创建，contractCreator = publisher）
export function invertTemplate(
  template: TaskContractJson['template'],
  creatorIsPublisher: boolean,
): TaskContractJson['template'] {
  if (template === 'SHIP') {
    return 'SHIP';
  }
  // BUY/SELL 仅在接取者视角下反转；发布者视角保持原样
  if (creatorIsPublisher) {
    return template;
  }
  return template === 'BUY' ? 'SELL' : 'BUY';
}

export function sendTaskToContd(
  contractJson: TaskContractJson,
  taskType: TaskType,
  creatorIsPublisher = false,
): void {
  // 应用合同类型反转规则
  const inverted: TaskContractJson = {
    ...contractJson,
    template: invertTemplate(contractJson.template, creatorIsPublisher),
  };
  const workspace = getTileState<{ json: string }>('contgen-output');
  workspace.json = JSON.stringify(inverted, null, 2);
  void showBuffer('CONTD', { force: true });
}

// 状态颜色 helper（与 TaskCard.vue statusColor 一致，供其他视图复用）
export function statusColor(status: string): string {
  switch (status) {
    case 'PUBLISHED':
      return 'var(--text-muted)';
    case 'AWAITING_CONTRACT':
      return 'var(--text-warning, #f0ad4e)';
    case 'IN_PROGRESS':
      return 'var(--accent)';
    case 'COMPLETED':
      return 'var(--text-positive, #5cb85c)';
    case 'CANCELLED':
      return 'var(--text-negative, #d9534f)';
    default:
      return 'var(--text-muted)';
  }
}
