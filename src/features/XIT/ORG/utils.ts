// src/features/XIT/ORG/utils.ts
import { newContractDraftAndFill } from '@src/features/XIT/CONTGEN/new-and-fill';
import type { TaskContractJson, TaskType } from '@src/infrastructure/org-api/types';

// 合同类型反转规则（架构 §3 + §7.2）：
//
// 老 task（无 listingId，partial claim 时代的子任务）：
//   task.type = publisher 视角的合同 type
//   claimer 接取时 → 反转 BUY/SELL
//
// 新 task（从 listing claim 生成的，task.listingId 存在）：
//   task.type 已经是 claimer 视角（接取者该签的合同 type）
//   不需要反转
//
// SHIP 任务：保持 SHIP；仅由发布者创建（contractCreator = publisher）
export function invertTemplate(
  template: TaskContractJson['template'],
  creatorIsPublisher: boolean,
  taskHasListing = false,
): TaskContractJson['template'] {
  if (template === 'SHIP') {
    return 'SHIP';
  }
  // 新架构：从 listing claim 产生的 task，type 已经是 claimer 视角，不需要反转
  if (taskHasListing) {
    return template;
  }
  // 老架构：BUY/SELL 仅在接取者视角下反转；发布者视角保持原样
  if (creatorIsPublisher) {
    return template;
  }
  return template === 'BUY' ? 'SELL' : 'BUY';
}

// Drives CONTGEN's "create a new contract draft and auto-fill it"
// flow. Same path CONTGEN's "新建合同并填充" button uses: parks
// the JSON, opens/refreshes a CONTD list panel, clicks PrUn's
// native "新建" button, waits for the server-pushed naturalId,
// then switches the panel to the new draft's detailed view. The
// contd-auto-fill feature consumes the workspace key on mount and
// auto-clicks the "填写" button — see contd-auto-fill.ts.
//
// Throws on failure. Callers (TaskDetail) surface the error to
// the user; the rest of the UI is unaffected.
export async function sendTaskToContd(
  contractJson: TaskContractJson,
  taskType: TaskType,
  creatorIsPublisher = false,
  taskHasListing = false,
): Promise<{ newNaturalId: string }> {
  // Apply contract-type inversion rules. `taskType` is reserved
  // for future use (LOAN contracts, etc.); for the current BUY/
  // SELL/SHIP set, contractJson.template is authoritative.
  void taskType;
  // ORG 任务接取后创建的合同名默认加 ORG 前缀，便于在 CONTD/CONTS 里区分
  // 组织任务产生的合同。原 name 缺失时直接使用 "ORG-"。name 不参与
  // 自动关联指纹比对（前端 fingerprint 不含 name），不影响 link-contract。
  const baseName = contractJson.name?.trim();
  const prefixedName = baseName ? `ORG-${baseName}` : 'ORG-';
  const inverted: TaskContractJson = {
    ...contractJson,
    template: invertTemplate(contractJson.template, creatorIsPublisher, taskHasListing),
    name: prefixedName,
  };
  return await newContractDraftAndFill(JSON.stringify(inverted, null, 2));
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
