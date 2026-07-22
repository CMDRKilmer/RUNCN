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

// 数字千分位格式化（不附加货币单位）。
// 复用 INT 4 位小数 + 去尾零，避免 0.1+0.2=0.30000000000000004 露馅。
export function formatNumber(value: number | undefined): string {
  if (value === undefined || value === null || Number.isNaN(value)) return '—';
  const fixed = Number(Math.round(Number(value + 'e4')) + 'e-4');
  const [intPart, decPart] = fixed.toString().split('.');
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart ? `${withThousands}.${decPart}` : withThousands;
}

// "数字 + 货币" 拼接（"1,234 AIC"）。
// 注意：不复用 CONTS/utils.ts.formatAmount，因为那里把 amount === 0 映射成 '-'，
// 在任务价/单价场景里 0 是合法值（例如发布者尚未定价）。
export function formatAmountWithCurrency(value: number | undefined, currency: string): string {
  return currency ? `${formatNumber(value)} ${currency}` : formatNumber(value);
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

// 状态中文标签：把后端 enum 转成用户友好的中文。
// 状态机语义（架构 §3）：
//   PUBLISHED                          → 待接取（已发布，等待其他人接取）
//   AWAITING_CONTRACT + 无 contractId   → 待关联合同（已接取，待创建并关联 PrUn 合同）
//   AWAITING_CONTRACT + 有 contractId   → 待对方接签（合同已关联，等待对方 accept 触发 CLOSED）
//   IN_PROGRESS                        → 进行中（合同已关联，正在执行）
//   COMPLETED                          → 已完成
//   CANCELLED                          → 已取消
export function statusLabel(status: string, contractId?: string | null): string {
  switch (status) {
    case 'PUBLISHED':
      return '待接取';
    case 'AWAITING_CONTRACT':
      return contractId ? '待对方接签' : '待关联合同';
    case 'IN_PROGRESS':
      return '进行中';
    case 'COMPLETED':
      return '已完成';
    case 'CANCELLED':
      return '已取消';
    default:
      return status;
  }
}
