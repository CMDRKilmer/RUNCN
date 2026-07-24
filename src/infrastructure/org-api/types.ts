// src/infrastructure/org-api/types.ts

// 用户角色（架构 §12.21）
export type UserRole = 'BOARD' | 'COLLABORATOR' | 'NON_ORG';

// 任务类型（架构 §4.1）
export type TaskType = 'BUY' | 'SELL' | 'SHIP' | 'LOAN';

// 任务状态（架构 §3 状态机）
export type TaskStatus =
  'PUBLISHED' | 'AWAITING_CONTRACT' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED';

// 合同创建方（架构 §3 状态机说明）
export type ContractCreator = 'publisher' | 'claimer';

// 用户（架构 §4.1）
export interface OrgUser {
  id: string;
  email: string;
  prunUsername: string;
  companyCode: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt?: string;
}

// 合同 JSON（与 CONTGEN.vue 第 13-39 行 ContractJson 对齐）
export interface TaskContractItem {
  commodity: string;
  amount: number;
  price?: number;
}

export interface TaskContractJson {
  template: 'BUY' | 'SELL' | 'SHIP'; // LOAN 暂不支持，留待后期
  currency: string;
  name?: string;
  location?: string;
  origin?: string;
  destination?: string;
  price?: number;
  // 运费：与 price 平级，独立于"货物总价"。
  shipping?: number;
  deadline?: number;
  items: TaskContractItem[];
}

// 任务（架构 §4.1）
export interface OrgTask {
  id: string;
  type: TaskType;
  contractJson: TaskContractJson;
  status: TaskStatus;
  publisherId: string;
  publisherUsername: string;
  publisherCompanyCode: string;
  claimerId?: string;
  claimerUsername?: string;
  claimerCompanyCode?: string;
  contractId?: string;
  contractCreator?: ContractCreator;
  // 部分接取（partial claim）：子任务的 parentTaskId 指回原任务。
  // 原任务的 parentTaskId 始终为 undefined。
  parentTaskId?: string;
  expiresAt?: string;
  createdAt: string;
  publishedAt?: string;
  claimedAt?: string;
  inProgressAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  updatedAt: string;
}

// claim 端点返回结构：
//   完整接取 → { task }
//   裁剪接取（partial） → { task: parent, childTask: reverseTask }
export interface ClaimTaskResult {
  task: OrgTask;
  childTask?: OrgTask;
}

// release 端点返回结构：
//   完整接取任务 release → { task: 原任务 }
//   部分接取子任务 release → { task: 父任务（amount 已加回）, parentTaskId, restoredAmount }
export interface ReleaseTaskResult {
  task: OrgTask;
  parentTaskId?: string;
  restoredAmount?: number;
}

// 任务备注（架构 §4.1）
export interface TaskNote {
  id: string;
  taskId: string;
  authorId: string;
  authorUsername: string;
  content: string;
  createdAt: string;
}

// 邀请码（架构 §12.4 invite_codes 表）
export interface InviteCode {
  id: string;
  code: string;
  createdBy: string;
  createdAt: string;
  usedByUserId?: string;
  usedAt?: string;
  revokedAt?: string;
}

// 审计日志（架构 §12.4 audit_logs 表）
export interface AuditLog {
  id: string;
  actorType: 'user' | 'admin' | 'system';
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

// 认证响应（架构 §12.8）
export interface AuthSession {
  accessToken: string;
  refreshToken: string;
  user: OrgUser;
}

// API 错误响应（架构 §12.9 错误格式）
export interface ApiError {
  error: {
    code: string;
    message: string;
  };
}

// 任务列表分页响应（后端 /tasks 返回 { items, nextCursor }）
export interface ListTasksResult {
  items: OrgTask[];
  nextCursor: string | null;
}

// 轮询游标（必须与后端 /tasks scope 枚举一致：board | published | claimed）
// UI Tab 键（如 'shipping' / 'market'）与 API scope 解耦，
// TaskList 内把 'shipping' 翻译成 { scope: 'board', type: 'SHIP' }。
export type PollScope = 'board' | 'published' | 'claimed';

// PrUn 合同状态枚举（与 src/infrastructure/prun-api/data/contracts.types.d.ts 对齐）
export type PrunContractStatus =
  | 'OPEN'
  | 'CLOSED'
  | 'CANCELLED'
  | 'FULFILLED'
  | 'PARTIALLY_FULFILLED'
  | 'REJECTED'
  | 'DEADLINE_EXCEEDED'
  | 'BREACHED'
  | 'TERMINATED';
