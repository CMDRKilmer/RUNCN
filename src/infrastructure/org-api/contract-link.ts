// src/infrastructure/org-api/contract-link.ts
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import type { OrgTask, PrunContractStatus, TaskContractJson } from './types';
import { syncContractStatus } from './tasks';

// 已上报过的状态记录，避免重复上报（同一状态多次触发只发一次）
const reportedStatuses = new Map<string, Set<string>>();

// ============== 指纹匹配：自动关联合同方案 ==============
// 设计文档：AUTO_LINK_CONTRACT.md §"指纹匹配规则"
// 目标：把 PrUn 运行时合同（PrunApi.Contract）投影成与 TaskContractJson 等价的"摘要形态"，
// 然后与 task.contractJson 做严格匹配（price 允许 ±0.5% 误差，其余严格相等）。
// 任一字段不匹配 → 不关联（宁缺毋滥）。
// ------------------------------------------------------------

// 投影后的合同摘要形态（与 TaskContractJson 对齐）
// 形状与后端 utils/contract-match.ts 的 ContractFingerprint 完全等价——
// 后端做权威比对时复用此 schema。修改任一处必须同步另一处。
export interface ContractFingerprint {
  template: TaskContractJson['template'];
  currency: string;
  items: Array<{ commodity: string; amount: number; price?: number }>;
  location?: string;
  origin?: string;
  destination?: string;
  price?: number;
}

export interface ContractMatchResult {
  matched: boolean;
  reason?: string;
}

// PrUn 条件类型 → contractJson template 的映射
function conditionsToTemplate(
  conditions: PrunApi.ContractCondition[],
): TaskContractJson['template'] {
  // SHIP 模板特征：存在 DELIVERY 或 DELIVERY_SHIPMENT + PROVISION_SHIPMENT
  const hasShip = conditions.some(
    c =>
      c.type === 'DELIVERY' ||
      c.type === 'DELIVERY_SHIPMENT' ||
      c.type === 'PROVISION_SHIPMENT' ||
      c.type === 'PICKUP_SHIPMENT' ||
      c.type === 'FINISH_FLIGHT' ||
      c.type === 'START_FLIGHT',
  );
  if (hasShip) return 'SHIP';
  // BUY 模板特征：CUSTOMER 收到 PICKUP（= 买方） / SELL 模板特征：PROVIDER 收到 PAYMENT + CUSTOMER 给 PROVISION（= 卖方）
  // 简化判定：若存在 PICKUP（无 SHIPMENT 后缀）→ BUY；否则 SELL
  const hasPickup = conditions.some(c => c.type === 'PICKUP' || c.type === 'COMEX_PURCHASE_PICKUP');
  if (hasPickup) return 'BUY';
  // LOAN 暂不支持，留待后期（架构 §4.1）
  return 'SELL';
}

// 从 conditions 抽取物料清单（commodity ticker, amount, unit price）
function conditionsToItems(conditions: PrunApi.ContractCondition[]): ContractFingerprint['items'] {
  const result: ContractFingerprint['items'] = [];
  for (const c of conditions) {
    // PROVISION / PICKUP / PROVISION_SHIPMENT / PICKUP_SHIPMENT 带 quantity（含 material.ticker / amount）
    const mat = c.quantity?.material;
    if (mat && c.quantity?.amount !== undefined) {
      const item: { commodity: string; amount: number; price?: number } = {
        commodity: mat.ticker,
        amount: c.quantity.amount,
      };
      // 单价：BUY/SELL 时 PAYMENT 条件 amount / quantity.amount
      if (c.amount?.amount !== undefined && c.quantity.amount > 0) {
        item.price = c.amount.amount / c.quantity.amount;
      }
      result.push(item);
    }
  }
  return result;
}

// 从 Address 抽取 location 字符串：拼接前两行 entity.name
// 例如 [{ entity: { name: 'Moria' } }, { entity: { name: 'Benten' } }] → "Moria, Benten"
function addressToLocation(address: PrunApi.Address | undefined): string | undefined {
  if (!address || address.lines.length === 0) return undefined;
  const names = address.lines
    .map(line => ('entity' in line ? line.entity?.name : undefined))
    .filter((n): n is string => Boolean(n));
  return names.length > 0 ? names.join(', ') : undefined;
}

// 把 PrUnApi.Contract 投影为指纹
// 导出供前端调用以联调后端 match-contract 端点：
// auto-link 在确认弹窗前先把 contract 转 fingerprint 上报，
// 后端以 task.contractJson 为权威源严格比对，避免不同客户端分叉。
export function contractToFingerprint(contract: PrunApi.Contract): ContractFingerprint {
  const fp: ContractFingerprint = {
    template: conditionsToTemplate(contract.conditions),
    currency: contract.partner.currency?.code ?? '',
    items: conditionsToItems(contract.conditions),
  };
  // location / origin / destination
  if (contract.conditions[0]?.address) {
    fp.location = addressToLocation(contract.conditions[0].address);
  }
  const delivery = contract.conditions.find(
    c => c.type === 'DELIVERY' || c.type === 'DELIVERY_SHIPMENT',
  );
  const pickup = contract.conditions.find(c => c.type === 'PICKUP' || c.type === 'PICKUP_SHIPMENT');
  if (delivery?.destination) {
    fp.destination = addressToLocation(delivery.destination);
  }
  if (pickup?.address) {
    fp.origin = addressToLocation(pickup.address);
  }
  // price：取第一个非空 amount（合同总价 / 运费）
  const total = contract.conditions.find(c => c.amount?.amount !== undefined);
  if (total?.amount?.amount !== undefined) {
    fp.price = total.amount.amount;
  }
  return fp;
}

// 把 TaskContractJson 投影为指纹（保留原结构便于比对）
function taskJsonToFingerprint(json: TaskContractJson): ContractFingerprint {
  return {
    template: json.template,
    currency: json.currency,
    items: json.items.map(i => {
      const item: { commodity: string; amount: number; price?: number } = {
        commodity: i.commodity,
        amount: i.amount,
      };
      if (i.price !== undefined) item.price = i.price;
      return item;
    }),
    location: json.location,
    origin: json.origin,
    destination: json.destination,
    price: json.price,
  };
}

const PRICE_TOLERANCE = 0.005; // ±0.5%

// 价格在容差内视为相等
function priceEquals(a: number | undefined, b: number | undefined): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  if (a === 0 && b === 0) return true;
  const max = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / max <= PRICE_TOLERANCE;
}

// items 集合相等（commodity 全等，amount 严格，price 容差）
function itemsEqual(a: ContractFingerprint['items'], b: ContractFingerprint['items']): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort((x, y) => x.commodity.localeCompare(y.commodity));
  const sortedB = [...b].sort((x, y) => x.commodity.localeCompare(y.commodity));
  for (let i = 0; i < sortedA.length; i++) {
    const ia = sortedA[i];
    const ib = sortedB[i];
    const commodityMatch = ia.commodity === ib.commodity;
    if (!commodityMatch) return false;
    const amountMatch = ia.amount === ib.amount;
    if (!amountMatch) return false;
    const pricesMatch: boolean = priceEquals(ia.price, ib.price);
    if (!pricesMatch) return false;
  }
  return true;
}

// 严格比对（template 反转规则已在任务侧 invertTemplate 处理，这里只比对最终值）
export function matchContractJson(
  taskJson: TaskContractJson,
  contract: PrunApi.Contract,
): ContractMatchResult {
  const task = taskJsonToFingerprint(taskJson);
  const con = contractToFingerprint(contract);

  if (task.template !== con.template) {
    return {
      matched: false,
      reason: `template mismatch: task=${task.template} contract=${con.template}`,
    };
  }
  if (task.currency !== con.currency) {
    return {
      matched: false,
      reason: `currency mismatch: task=${task.currency} contract=${con.currency}`,
    };
  }
  if (!itemsEqual(task.items, con.items)) {
    return { matched: false, reason: 'items mismatch' };
  }
  if (!priceEquals(task.price, con.price)) {
    return { matched: false, reason: `price mismatch: task=${task.price} contract=${con.price}` };
  }
  // location / origin+destination 严格相等（双方都缺失或相等才算匹配）
  const locA = task.location ?? '';
  const locB = con.location ?? '';
  if (locA !== locB) {
    return { matched: false, reason: `location mismatch: task=${locA} contract=${locB}` };
  }
  const originA = task.origin ?? '';
  const originB = con.origin ?? '';
  if (originA !== originB) {
    return { matched: false, reason: `origin mismatch: task=${originA} contract=${originB}` };
  }
  const destA = task.destination ?? '';
  const destB = con.destination ?? '';
  if (destA !== destB) {
    return { matched: false, reason: `destination mismatch: task=${destA} contract=${destB}` };
  }
  return { matched: true };
}

// 合同状态 → 是否触发任务状态转移（架构 §7.3 修正后）
// CLOSED → IN_PROGRESS, FULFILLED → COMPLETED, CANCELLED/TERMINATED/BREACHED/REJECTED/DEADLINE_EXCEEDED → CANCELLED
const TRANSITION_STATUSES: ReadonlySet<PrunContractStatus> = new Set([
  'CLOSED',
  'FULFILLED',
  'CANCELLED',
  'TERMINATED',
  'BREACHED',
  'REJECTED',
  'DEADLINE_EXCEEDED',
]);

// 监听任务关联合同的状态变化，自动上报 Worker
// 调用方在 watchEffect 内调用以获得响应性
export function watchContractStatus(task: OrgTask): void {
  if (!task.contractId) {
    return;
  }
  if (task.status === 'COMPLETED' || task.status === 'CANCELLED') {
    return;
  }
  const contract = contractsStore.getById(task.contractId);
  if (!contract) {
    return;
  }
  const status = contract.status as PrunContractStatus;
  if (!TRANSITION_STATUSES.has(status)) {
    return;
  }
  const reported = reportedStatuses.get(task.id) ?? new Set<string>();
  if (reported.has(status)) {
    return;
  }
  reported.add(status);
  reportedStatuses.set(task.id, reported);
  // fire-and-forget；Worker 内会再做幂等校验
  void syncContractStatus(task.id, status).catch(err => {
    console.warn(`[ORG] syncContractStatus failed for task ${task.id}:`, err);
    // 失败时移除记录，允许下次重试
    reported.delete(status);
  });
}

// 任务详情页关闭时清理记录（避免内存泄漏）
export function clearReportedStatus(taskId: string): void {
  reportedStatuses.delete(taskId);
}
