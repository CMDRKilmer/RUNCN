// src/infrastructure/org-api/auto-link.ts
// 自动关联合同方案 C：前端轮询反查 contractsStore。
// 设计文档：AUTO_LINK_CONTRACT.md
//
// 工作流：
//   1. TaskDetail.vue 调 startAutoLink(task) → 启动 30 秒间隔轮询。
//      ORG.vue 调 startGlobalAutoLink() → 对所有 AWAITING_CONTRACT 任务
//      统一轮询（ORG 任务接取后默认开启：接取者无需打开 TaskDetail 也能
//      让匹配上的合同自动 link）。
//   2. 每轮扫描 contractsStore.all，对每个 OPEN/CLOSED 合同跑 matchContractJson。
//   3. 命中后调 onMatch 回调：
//      - TaskDetail 显示 5 秒倒计时确认弹窗，等待用户确认。
//      - 全局模式直接 5 秒后自动 link（用户没在看 TaskDetail）。
//   4. 倒计时结束 / 用户确认 → 调 link-contract；取消 → 记录 contractId 已见过，下轮跳过。
//   5. 任务关闭或用户停止 → stopAutoLink(taskId) 清理 interval。
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import type { OrgTask, TaskContractJson } from './types';
import { contractToFingerprint, matchContractJson } from './contract-link';
import { listTasks } from './tasks';
import { HttpError } from './client';

const POLL_INTERVAL_MS = 5_000;

export interface AutoLinkMatch {
  contractId: string;
  contract: PrunApi.Contract;
  // 给 UI 展示的指纹摘要
  fingerprintSummary: string;
  // 匹配时使用的模板：等于 task 原始模板说明发布者视角（不反转），否则为接取者视角
  matchedTemplate: TaskContractJson['template'];
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
// 用户主动 dismiss 过的任务 id：startAutoLink 时跳过、globalTick 也不重启。
// 模块级单例，与 sessions 平行。
const dismissedTaskIds = new Set<string>();

// 应用反转规则（与 utils.invertTemplate 保持一致）：
//   老 task（无 listingId，partial claim 时代的子任务）：
//     task.type = publisher 视角的合同 type
//     claimer 接取时 → 反转 BUY/SELL
//   新 task（listingId 存在，从 listing claim 产生）：
//     task.type 已经是 claimer 视角（接取者该签的合同 type）
//     不需要反转
//   SHIP 不反转（仅 publisher 创建）

// 时间窗预筛：合同 date 必须在 task 关键时间点附近，避免 link 到很老 / 未来的合同。
// 规则：
//   - 合同 date >= task.claimed_at - 1h（玩家接取前 1 小时内签的也允许，
//     避免接取时同时签合同的边缘时序）
//   - 合同 date <= task.claimed_at + 7 天（任务 deadline 期限内）
// partner.name 严格 username 比对不可靠（PrUn partner.name 是公司名 "Quantum
// Pulse Inc"，不是 username "kolo"），所以**关掉** partner 校验，依赖
// 时间窗 + 严格 fingerprint + 单合同/单 task 的 UNIQUE 约束兜底。
function contractInTimeWindow(contract: PrunApi.Contract, task: OrgTask): boolean {
  // contract.date 是 PrUn DateTime { timestamp: number }；task 时间是 ISO 字符串
  const contractMs = contract.date?.timestamp;
  const taskClaimed = task.claimedAt ?? task.createdAt;
  if (typeof contractMs !== 'number' || !taskClaimed) return true;
  const claimedMs = new Date(taskClaimed).getTime();
  if (Number.isNaN(claimedMs)) return true;
  // 提前 1 小时（玩家可能同时接取+签合同）
  if (contractMs < claimedMs - 60 * 60 * 1000) return false;
  if (contractMs > claimedMs + 7 * 24 * 60 * 60 * 1000) return false;
  return true;
}

function effectiveTaskTemplate(task: OrgTask): TaskContractJson['template'] {
  const tmpl = task.contractJson.template;
  if (tmpl === 'SHIP') return 'SHIP';
  // 新架构：从 listing claim 生成的 task，type 已经是 claimer 视角，不需要反转
  if (task.listingId) {
    return tmpl;
  }
  // 老架构：BUY/SELL 仅在接取者视角下反转；发布者视角保持原样
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
  if (!all) {
    return null;
  }
  // 尝试三个 template：
  //   - task contractJson 原 template（claimer 视角：新架构下与实际合同一致）
  //   - 反转后 template（publisher 视角兼容老 task）
  //   - SHIP（独立兜底）
  // PrUn 玩家合同在 CONTS 列表里 wire contractType 通常为 null（accept 后
  // 服务端清空），仅凭 contract.contractType 区分 BUY/SELL 不可靠——
  // 见 contract-link.ts:inferContractTemplate 注释。
  // 实际匹配由 fingerprint 严格比对决定，多试一个 template 只是为了兼容
  // 老架构的反转语义。
  const invertedTemplate = effectiveTaskTemplate(session.task);
  const originalTemplate = session.task.contractJson.template;
  const orderedTemplates: TaskContractJson['template'][] = [];
  if (originalTemplate === 'SHIP' || invertedTemplate === 'SHIP') {
    orderedTemplates.push('SHIP');
  }
  if (originalTemplate !== 'SHIP') orderedTemplates.push(originalTemplate);
  if (invertedTemplate !== originalTemplate && invertedTemplate !== 'SHIP') {
    orderedTemplates.push(invertedTemplate);
  }
  // 去重
  const templatesToTry = Array.from(new Set(orderedTemplates));

  for (const contract of all) {
    if (session.dismissedContractIds.has(contract.id)) continue;
    // 接受任意合同状态。场景：ORG 接取后创建反向合同（status=OPEN），
    // 对方可能在我方 sync-status 到达前抢先接受 → status 转 CLOSED。
    // 若按 OPEN 过滤，错过这一窗口后就永远关联不上。
    // 终态合同（CANCELLED / FULFILLED / TERMINATED 等）被 link 后由后端
    // sync-status 立即把任务推到对应终态，行为可接受。
    // 时间窗预筛：避免 link 到历史 fingerprint 相同的旧合同。
    // 严格 partner 校验因 PrUn partner.name 是公司名（"Quantum Pulse Inc"）
    // 而非 username（"kolo"）无法生效；改用时间窗 + 严格 fingerprint + 单
    // 合同/单 task 的 UNIQUE 约束兜底。
    if (!contractInTimeWindow(contract, session.task)) {
      continue;
    }
    for (const tmpl of templatesToTry) {
      const taskJsonForMatch: TaskContractJson = {
        ...session.task.contractJson,
        template: tmpl,
      };
      const result = matchContractJson(taskJsonForMatch, contract);
      if (!result.matched) continue;
      console.log(
        '[auto-link] matched task=',
        session.task.id,
        'contract=',
        contract.id,
        'template=',
        tmpl,
      );
      return {
        contractId: contract.id,
        contract,
        fingerprintSummary: fingerprintSummary(session.task.contractJson),
        matchedTemplate: tmpl,
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
        console.log('[auto-link] backend rejected match, reason:', verifyResult.reason);
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
        // 根据匹配模板推断合同创建方：
        //   老 task（无 listingId）：
        //     - 原始模板=发布者视角（合同应是 publisher 签的）
        //     - 反转模板=接取者视角（合同应是 claimer 签的）
        //   新 task（listingId 存在）：
        //     - contractJson.template 已经是 claimer 视角
        //     - matchedTemplate 永远等于 contractJson.template（effectiveTaskTemplate 不反转）
        //     - 因此合同创建方恒为 claimer
        let matchedCreator: 'publisher' | 'claimer';
        if (task.listingId) {
          // 新架构：合同必须是 claimer 签的
          matchedCreator = 'claimer';
        } else {
          matchedCreator =
            match.matchedTemplate === session.task.contractJson.template ? 'publisher' : 'claimer';
        }
        const updated = await tasksApi.linkContract(task.id, {
          contractId: match.contractId,
          contractCreator: matchedCreator,
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

// ============== 全局 auto-link：ORG.vue 启动 ==============
// ORG 任务接取后默认开启自动关联：ORG 面板 mount 时启动全局轮询，
// 对当前用户所有 AWAITING_CONTRACT + 无 contractId 的任务统一注册
// startAutoLink session。每个任务独立生命周期：
//  - 命中合同：5 秒后自动 link（无 UI 弹窗；调用方通过 onLinked 收到通知）
//  - 状态切换：auto-link 内部 self-stop
//  - ORG 面板 unmount：stopGlobalAutoLink 调 stopAutoLink 清理所有 session。
//
// 设计权衡：全局模式无 TaskDetail 弹窗，命中即自动 link。
// 误关联风险由后端 match-contract 二次确认兜底（callbacks.onMatch 流程
// 已包含后端权威比对），同 TaskDetail 路径一致。
//
// 用户主动关闭：调用 dismissAutoLink(taskId)，后续全局 tick 跳过。
// dismissedTaskIds 在新 session 起始为空（模块级 Set 不持久化），
// 用户重连 / 登出重登会自动「重置」——无需显式 reset 接口。
export interface GlobalAutoLinkCallbacks {
  onLinked?: (task: OrgTask) => void;
  // 合同 status 变化触发 sync 后的回调（如 FULFILLED → 任务 COMPLETED）。
  // 用于让 UI 提示「合同已完成」之类的通知。
  onStatusSynced?: (task: OrgTask) => void;
  onError?: (err: Error) => void;
}

const GLOBAL_POLL_INTERVAL_MS = 5_000;

let globalInterval: ReturnType<typeof setInterval> | null = null;
let globalCallbacks: GlobalAutoLinkCallbacks = {};
let globalRunning = false;
// 当前用户作为 publisher 或 claimer 持有的"活跃任务"集合。
// globalTick interval 仅在非空时跑；空时停止。
// 与 polling.ts 的 activeTaskIds 是两个独立集合（auto-link 范围更广：
// 含 publisher 的 IN_PROGRESS，用于 syncLinkedContractStatus 把已 link
// 合同的 AWAITING/IN_PROGRESS 推到 COMPLETED）。
const activeLinkedTaskIds = new Set<string>();

// 注册一个"需要 auto-link 关注"的任务。
// 规则：作为 claimer 持有（用于合同自动关联 + sync）或作为 publisher 持有
// 且 contractId 非空（用于 sync contract status → COMPLETED）。
// 接取成功 / 关联合同后调此；任务推完 COMPLETED/CANCELLED 时调 unregisterActiveTask。
export function registerActiveTask(taskId: string): void {
  if (activeLinkedTaskIds.has(taskId)) return;
  activeLinkedTaskIds.add(taskId);
  ensureGlobalAutoLinkRunning();
}

export function unregisterActiveTask(taskId: string): void {
  if (!activeLinkedTaskIds.delete(taskId)) return;
  if (activeLinkedTaskIds.size === 0) {
    stopGlobalAutoLink();
  }
}

async function globalTick(): Promise<void> {
  if (globalRunning) return;
  globalRunning = true;
  try {
    // 按需轮询：活跃任务集合为空时不做任何 listTasks 请求。
    // 注册入口：listings.claimListing / linkContract → notifyTaskClaimed → registerActiveTask。
    // 移除入口：notifyTaskUpdated 收到终态任务后 unregisterActiveTask；
    // 当 set 空时 unregister 内部 stopGlobalAutoLink 把 interval 也停了。
    if (activeLinkedTaskIds.size === 0) {
      return;
    }
    // 同时扫两个 scope：
    //   - claimed: 玩家作为接取者持有的任务（含完整接取 + partial claim 子任务 publisher 也是接取者）
    //   - published: 玩家作为发布者持有的任务（partial claim 子任务 publisher = 接取者，
    //     不在这里；但完整接取的任务可能想被发布者也能看到 sync 状态变化）
    // 实际：syncLinkedContractStatus 走的是"我有权限 sync 这条任务的合同"逻辑。
    // 后端 syncTaskFromContract 校验 publisher_id === userId || claimer_id === userId，
    // 所以我们必须把玩家作为 publisher 或 claimer 的任务都拿到。
    const [claimed, published] = await Promise.all([
      listTasks({ scope: 'claimed', limit: 100 }),
      listTasks({ scope: 'published', limit: 100 }),
    ]);
    // 用 Set 去重（父子任务的边界场景几乎不重叠，但理论上可能）
    const seen = new Set<string>();
    const allTasks: OrgTask[] = [];
    for (const task of [...claimed.items, ...published.items]) {
      if (seen.has(task.id)) continue;
      seen.add(task.id);
      allTasks.push(task);
    }
    for (const task of allTasks) {
      if (task.status === 'AWAITING_CONTRACT' && !task.contractId) {
        // 已有 session 跳过；dismissed 跳过
        if (sessions.has(task.id)) continue;
        if (dismissedTaskIds.has(task.id)) continue;
        startAutoLink(task, {
          // 全局模式无 UI 弹窗：onMatch 直接 resolve(true)，
          // 让 startAutoLink 内部走「倒计时结束 → link-contract」流程。
          onMatch: () => new Promise<boolean>(resolve => setTimeout(() => resolve(true), 5000)),
          onLinked: updated => {
            globalCallbacks.onLinked?.(updated);
          },
          onError: err => {
            globalCallbacks.onError?.(err);
          },
          onStateChange: () => {
            // 全局模式无需对外暴露状态变化（TaskDetail 已通过 isAutoLinkRunning 自己判断）
          },
        });
        continue;
      }
      // 已关联合同的任务：扫描 contractsStore 检查合同 status 变化，
      // 触发 syncContractStatus 把任务状态推进到 COMPLETED / CANCELLED。
      if (
        task.contractId &&
        (task.status === 'IN_PROGRESS' || task.status === 'AWAITING_CONTRACT')
      ) {
        await syncLinkedContractStatus(task);
      }
    }
  } catch (err) {
    // 401/403 → session 已失效，停止全局轮询避免持续发送无效请求。
    // session 清理 + AuthOverlay 显示由 onUnauthorizedCallback（ORG.vue）负责。
    if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
      console.warn('[auto-link] Auth expired, stopping global auto-link');
      stopGlobalAutoLink();
      return; // 跳过 globalCallbacks.onError，避免触发冗余错误提示
    }
    globalCallbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
  } finally {
    globalRunning = false;
  }
}

// 已 link 任务：检查其合同在 PrUn contractsStore 里的状态。
// 状态变化时调后端 sync-status 端点，状态映射由后端 CONTRACT_STATUS_TO_TASK 处理。
async function syncLinkedContractStatus(task: OrgTask): Promise<void> {
  const all = contractsStore.all.value;
  if (!all) return;
  // task.contractId 是 PrUn 玩家可见的合同短码（U787KK6）= Contract.localId。
  // Contract.id 是 FQID（base32 ulid），与 localId 不同；entity store 的 getById 用 id
  // 做 key 找不 shortId。所以直接遍历 all 数组按 localId 等值匹配。
  const id = task.contractId;
  const contract = all.find(c => c.localId === id) ?? all.find(c => c.id === id);
  if (!contract) return;
  // 后端 CONTRACT_STATUS_TO_TASK:
  //   CLOSED → IN_PROGRESS, FULFILLED → COMPLETED,
  //   CANCELLED/BREACHED/TERMINATED → CANCELLED
  // OPEN/PARTIALLY_FULFILLED/REJECTED/DEADLINE_EXCEEDED 不映射（保持 IN_PROGRESS）
  const mappableStatuses = new Set(['CLOSED', 'FULFILLED', 'CANCELLED', 'BREACHED', 'TERMINATED']);
  if (!mappableStatuses.has(contract.status)) return;
  // 早退：如果任务状态已经是合同状态的终态映射（如 COMPLETED），不再调 sync-status。
  if (task.status === 'COMPLETED' || task.status === 'CANCELLED') return;
  try {
    const tasksApi = await import('./tasks');
    const updated = await tasksApi.syncContractStatus(task.id, contract.status);
    globalCallbacks.onStatusSynced?.(updated);
  } catch (err) {
    globalCallbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
  }
}

// 仅在有活跃任务时起 interval。
function ensureGlobalAutoLinkRunning(): void {
  if (globalInterval || activeLinkedTaskIds.size === 0) return;
  startInterval();
}

// 实际创建 interval + 立即跑一次；不检查 activeLinkedTaskIds 大小
// （由 ensureGlobalAutoLinkRunning 守门）。
function startInterval(): void {
  if (globalInterval) return;
  // 启动时如果 contractsStore 还没 fetched，主动触发一次 CONTS 缓存窗口拉取
  // （autoClose=true 不让窗口停留）。PrUn server 收到 CONTS 命令后会推
  // CONTRACTS_CONTRACTS 消息，把所有合同加入 contractsStore.all，
  // scanOnce 才能找到刚被 KAMISAMA223 用 CONTD 创建的合同。
  if (!contractsStore.fetched.value) {
    void import('@src/infrastructure/prun-ui/buffers').then(m =>
      m.showBuffer('CONTS', { autoSubmit: true, autoClose: true }),
    );
  }
  // 立即跑一次，再起 interval
  void globalTick();
  globalInterval = setInterval(() => {
    void globalTick();
  }, GLOBAL_POLL_INTERVAL_MS);
}

// startGlobalAutoLink 保留以兼容旧调用方（ORG.vue mount）。
// 但 interval 现在仅在有活跃任务时才真正起。
export function startGlobalAutoLink(callbacks: GlobalAutoLinkCallbacks = {}): void {
  globalCallbacks = callbacks;
  ensureGlobalAutoLinkRunning();
}

export function stopGlobalAutoLink(): void {
  if (globalInterval) {
    clearInterval(globalInterval);
    globalInterval = null;
  }
  // 同时清理所有 sessions（包括全局注册的；TaskDetail 的本地 session
  // 若用户正在看 TaskDetail，onBeforeUnmount 也会显式 stopAutoLink 兜底）
  for (const taskId of Array.from(sessions.keys())) {
    stopAutoLink(taskId);
  }
  // 清空活跃任务集合：登出 / 强制停止时不要让 set 残留，
  // 避免下次重新注册前"看似有活跃任务但 interval 已停"的脏状态。
  activeLinkedTaskIds.clear();
}

// 用户主动关闭某个任务的自动关联（TaskDetail 上的"关闭自动关联"按钮）：
// stopAutoLink 清理当前 session；dismissedTaskIds 防止全局 tick 重启。
// 任务状态切到 IN_PROGRESS / 已 link / CANCELLED 后从集合里移除。
export function dismissAutoLink(taskId: string): void {
  stopAutoLink(taskId);
  dismissedTaskIds.add(taskId);
}
