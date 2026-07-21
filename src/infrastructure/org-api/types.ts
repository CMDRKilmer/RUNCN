// src/infrastructure/org-api/types.ts

// 用户角色（架构 §12.21）
export type UserRole = 'BOARD' | 'COLLABORATOR';

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
  expiresAt?: string;
  createdAt: string;
  publishedAt?: string;
  claimedAt?: string;
  inProgressAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  updatedAt: string;
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

// 轮询游标
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
