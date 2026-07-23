// src/infrastructure/org-api/auto-link.ts
// 自动关联合同方案 C：前端轮询反查 contractsStore。
// 设计文档：AUTO_LINK_CONTRACT.md
//
// 工作流：
//   1. TaskDetail.vue 调 startAutoLink(task) → 启动 30 秒间隔轮询。
//   2. 每轮扫描 contractsStore.all，对每个 OPEN/CLOSED 合同跑 matchContractJson。
//   3. 命中后调 onMatch 回调（TaskDetail 显示 5 秒倒计时确认弹窗）。
//   4. 倒计时结束 / 用户确认 → 调 link-contract；取消 → 记录 contractId 已见过，下轮跳过。
//   5. 任务关闭或用户停止 → stopAutoLink(taskId) 清理 interval。
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import type { OrgTask, TaskContractJson } from './types';
import { contractToFingerprint, matchContractJson } from './contract-link';

const POLL_INTERVAL_MS = 30_000;

export interface AutoLinkMatch {
  contractId: string;
  contract: PrunApi.Contract;
  // 给 UI 展示的指纹摘要
  fingerprintSummary: string;
}

export interface AutoLinkCallbacks {
  // 命中指纹时回调，UI 显示确认弹窗。
  // 返回 Promise<boolean>：true 立即关联，false 取消且 24h 内不再提示同一合同。
  onMatch: (match: AutoLinkMatch) => Promise<boolean>;
  // 关联成功回调，UI 提示"已自动关联合同 XXX"。
  onLinked: (task: OrgTask) => void;
  // 关联失败回调（一般是 401/网络），UI 展示错误。
  onError: (err: Error) => void;
  // 启动/停止状态变化回调（"运行中/已停止"）
  onStateChange?: (state: 'running' | 'stopped') => void;
}

interface AutoLinkSession {
  task: OrgTask;
  callbacks: AutoLinkCallbacks;
  interval: ReturnType<typeof setInterval>;
  // 已确认跳过（用户取消）的合同 ID，避免重复打扰
  dismissedContractIds: Set<string>;
}

// taskId → session
const sessions = new Map<string, AutoLinkSession>();

// 应用反转规则（与 utils.invertTemplate 保持一致）：
//   task BUY + creator=claimer → 合同应是 SELL（接取者卖给发布者）
//   task SELL + creator=claimer → 合同应是 BUY（接取者从发布者买）
//   SHIP 不反转（仅 publisher 创建）
function effectiveTaskTemplate(task: OrgTask): TaskContractJson['template'] {
  const tmpl = task.contractJson.template;
  if (tmpl === 'SHIP') return 'SHIP';
  // 任务侧没存 creator 字段；从 contractCreator 推断
  const creatorIsPublisher = task.contractCreator === 'publisher';
  if (creatorIsPublisher) return tmpl;
  return tmpl === 'BUY' ? 'SELL' : 'BUY';
}

// 投影"用于在 UI 上展示的指纹摘要"（按文档 §"指纹匹配规则"罗列字段）
function fingerprintSummary(json: TaskContractJson): string {
  const items = json.items.map(i => `${i.amount}×${i.commodity}`).join(', ');
  const loc = json.location ? ` @${json.location}` : '';
  const path = json.origin && json.destination ? ` ${json.origin}→${json.destination}` : '';
  return `${json.template}/${json.currency}/${items}${loc}${path}`;
}

function scanOnce(session: AutoLinkSession): AutoLinkMatch | null {
  const all = contractsStore.all.value;
  if (!all) return null;
  // 用反转后的 template 做匹配（合同侧投影时已按 PrUn 实际类型判定）
  const taskJsonForMatch: TaskContractJson = {
    ...session.task.contractJson,
    template: effectiveTaskTemplate(session.task),
  };
  for (const contract of all) {
    if (session.dismissedContractIds.has(contract.id)) continue;
    // 跳过已被关联到其他任务上的合同（避免双重占用）
    // 注：这里无 task→contract 反查表，简化处理为"只看 status 是 OPEN 或刚 CLOSED"
    if (
      contract.status !== 'OPEN' &&
      contract.status !== 'CLOSED' &&
      contract.status !== 'PARTIALLY_FULFILLED'
    )
      continue;
    const result = matchContractJson(taskJsonForMatch, contract);
    if (result.matched) {
      return {
        contractId: contract.id,
        contract,
        fingerprintSummary: fingerprintSummary(session.task.contractJson),
      };
    }
  }
  return null;
}

export function startAutoLink(task: OrgTask, callbacks: AutoLinkCallbacks): void {
  if (sessions.has(task.id)) {
    return;
  }
  const session: AutoLinkSession = {
    task,
    callbacks,
    dismissedContractIds: new Set(),
    interval: null!,
  };

  async function tick() {
    // 任务状态变更后停止轮询
    if (task.status !== 'AWAITING_CONTRACT' || task.contractId) {
      stopAutoLink(task.id);
      return;
    }
    try {
      const match = scanOnce(session);
      if (!match) return;
      // 找到候选 → 暂停 interval，等待用户确认（避免扫到多个候选时反复弹窗）
      clearInterval(session.interval);
      session.interval = null!;
      // 后端权威比对：把投影 fingerprint 上报 /tasks/:id/match-contract，
      // 后端以 task.contractJson 为 source of truth 二次确认。命中 → 显示
      // 确认弹窗；未命中 → 记录该合同 ID 已见过，下轮跳过（前端指纹规则
      // 与后端不一致时也能拒绝误关联，AUTO_LINK_CONTRACT.md §"误关联兜底"）。
      const tasksApi = await import('./tasks');
      const verifyResult = await tasksApi.matchContract(task.id, {
        contractId: match.contractId,
        fingerprint: contractToFingerprint(match.contract),
        autoLink: false,
      });
      if (!verifyResult.matched) {
        session.dismissedContractIds.add(match.contractId);
        const stillRunningAfterVerify = sessions.has(task.id);
        const hasIntervalAfterVerify = session.interval != null;
        if (stillRunningAfterVerify && !hasIntervalAfterVerify) {
          session.interval = setInterval(tick, POLL_INTERVAL_MS);
        }
        return;
      }
      const confirmed = await callbacks.onMatch(match);
      if (confirmed) {
        // 通过 linkContract 关联（动态 import 避免循环）
        const updated = await tasksApi.linkContract(task.id, {
          contractId: match.contractId,
          contractCreator: task.contractCreator ?? 'claimer',
        });
        callbacks.onLinked(updated);
        stopAutoLink(task.id);
      } else {
        session.dismissedContractIds.add(match.contractId);
        // 恢复轮询（如果用户没在期间 stopAutoLink）
        const stillRunning = sessions.has(task.id);
        const hasInterval = session.interval != null;
        if (stillRunning && !hasInterval) {
          session.interval = setInterval(tick, POLL_INTERVAL_MS);
        }
      }
    } catch (err) {
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  session.interval = setInterval(tick, POLL_INTERVAL_MS);
  sessions.set(task.id, session);
  callbacks.onStateChange?.('running');
}

export function stopAutoLink(taskId: string): void {
  const session = sessions.get(taskId);
  if (!session) return;
  const interval = session.interval;
  if (interval != null) clearInterval(interval);
  sessions.delete(taskId);
  session.callbacks.onStateChange?.('stopped');
}

export function isAutoLinkRunning(taskId: string): boolean {
  return sessions.has(taskId);
}
