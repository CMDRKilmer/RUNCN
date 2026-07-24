// src/infrastructure/org-api/contract-link.ts
import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import type { OrgTask, PrunContractStatus, TaskContractJson, TaskContractItem } from './types';
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
//
// 核心原则：通过 conditions 中每个条件的 party 来判断方向，而非仅依赖 contract.party。
// contract.party 是 PrUn 在合同层面对我方角色的概括，但 CONTD（合同草稿）自动创建的
// 合同可能出现 contract.party=PROVIDER 但实际我方是买方的情况。
//
// 判断规则（按条件级别，不按合同级别）：
//   - PAYMENT 条件：condition.party 是付款方
//   - PROVISION/DELIVERY/PICKUP 条件：condition.party 是交货方
//   - 我方付款 + 对方交货 → BUY（我方是买方）
//   - 对方付款 + 我方交货 → SELL（我方是卖方）
//
// 同时保留 contract.party 作为高优先级信号，仅当 conditions 分析结果与 party 不一致时才
// 信任 conditions（因为 conditions 更细粒度、直接反映合同实际内容）。
function conditionsToTemplate(
  conditions: PrunApi.ContractCondition[],
  contractParty?: PrunApi.ContractParty,
): TaskContractJson['template'] {
  // SHIP 模板特征：存在 SHIPMENT 系列条件
  const hasShip = conditions.some(
    c =>
      c.type === 'DELIVERY_SHIPMENT' ||
      c.type === 'PROVISION_SHIPMENT' ||
      c.type === 'PICKUP_SHIPMENT' ||
      c.type === 'FINISH_FLIGHT' ||
      c.type === 'START_FLIGHT',
  );
  if (hasShip) return 'SHIP';

  // 按条件 party 分析：谁付款？谁交货？
  // 找出 PAYMENT 条件和 PROVISION/DELIVERY/PICKUP 条件
  const paymentCond = conditions.find(c => c.type === 'PAYMENT' && c.party);
  const deliveryCond = conditions.find(
    c =>
      (c.type === 'PROVISION' ||
        c.type === 'DELIVERY' ||
        c.type === 'PICKUP' ||
        c.type === 'COMEX_PURCHASE_PICKUP') &&
      c.party,
  );

  // 有 contract.party 时用它做参照系（"我方"的 party 值）
  const myParty = contractParty;

  if (paymentCond && deliveryCond && myParty) {
    // 付款方是我方 → BUY；付款方是对方 → SELL
    const iPay = paymentCond.party === myParty;
    return iPay ? 'BUY' : 'SELL';
  }

  // 只有 contract.party，没有可分析的 conditions → 用 party 推断
  if (myParty === 'CUSTOMER') return 'BUY';
  if (myParty === 'PROVIDER') return 'SELL';

  // 没传 party：无法确定"我方"角色，用 PICKUP 条件兜底
  const hasPickup = conditions.some(c => c.type === 'PICKUP' || c.type === 'COMEX_PURCHASE_PICKUP');
  if (hasPickup) return 'BUY';
  return 'SELL';
}

// 从 conditions 抽取物料清单（commodity ticker, amount, unit price）
// 两遍扫描：先收集 quantity items，再从 PAYMENT 条件获取总价并分配到各 item。
// CONTD 合同的 PAYMENT 和 DELIVERY 是独立条件，金额不在 quantity 条件上。
function conditionsToItems(conditions: PrunApi.ContractCondition[]): ContractFingerprint['items'] {
  const result: ContractFingerprint['items'] = [];
  // 第一遍：收集所有带 quantity 的物料
  for (const c of conditions) {
    const mat = c.quantity?.material;
    if (mat && c.quantity?.amount !== undefined) {
      const item: { commodity: string; amount: number; price?: number } = {
        commodity: mat.ticker,
        amount: c.quantity.amount,
      };
      // 如果当前 condition 自身就带 amount（罕见），直接计算单价
      if (c.amount?.amount !== undefined && c.quantity.amount > 0) {
        item.price = c.amount.amount / c.quantity.amount;
      }
      result.push(item);
    }
  }
  // 第二遍：如果 items 还没单价，从 PAYMENT 条件分摊总价
  const hasPrice = result.some(i => i.price !== undefined);
  if (!hasPrice && result.length > 0) {
    const paymentCond = conditions.find(
      c => c.type === 'PAYMENT' && c.amount?.amount !== undefined,
    );
    if (paymentCond?.amount) {
      const totalAmount = result.reduce((sum, i) => sum + i.amount, 0);
      if (totalAmount > 0) {
        const unitPrice = paymentCond.amount.amount / totalAmount;
        for (const item of result) {
          item.price = unitPrice;
        }
      }
    }
  }
  return result;
}

// 从 Address 抽取 location 字符串：取最后一行 entity.naturalId（站点/星系代码）。
// 任务发布时 location 是用户手填的 naturalId（如 "HRT"），合同侧用 name（"Hortus Station"）
// 会导致指纹 mismtach。统一用 naturalId 对齐。
// 例如 [{ entity: { naturalId: 'VH-331', name: 'Hortus' } }, { entity: { naturalId: 'HRT', name: 'Hortus Station' } }] → "HRT"
function addressToLocation(address: PrunApi.Address | undefined): string | undefined {
  if (!address || address.lines.length === 0) return undefined;
  // 取最后一行（通常是站点）的 naturalId；如果不存在则取倒数第二行（星系）
  for (let i = address.lines.length - 1; i >= 0; i--) {
    const line = address.lines[i];
    if ('entity' in line && line.entity?.naturalId) {
      return line.entity.naturalId;
    }
  }
  return undefined;
}

// PrUn wire 实际 contractType 枚举（远超 BUY/SELL/SHIP）。
// 玩家间普通合同：'BUY' | 'SELL' | 'SHIP' | 'LOAN'
// 派系/AI/政府合同：'MATERIALS' | 'INFRASTRUCTURE' | '...'
// 我们只关心玩家间普通合同（task 只能匹配这些）。
const PLAYER_CONTRACT_TYPES = new Set(['BUY', 'SELL', 'SHIP', 'LOAN']);

// 把 PrUnApi.Contract 投影为指纹
// 导出供前端调用以联调后端 match-contract 端点：
// auto-link 在确认弹窗前先把 contract 转 fingerprint 上报，
// 后端以 task.contractJson 为权威源严格比对，避免不同客户端分叉。
export function contractToFingerprint(contract: PrunApi.Contract): ContractFingerprint {
  // 1) contractType 解析优先级：
  //    a) wire 字段是玩家合同（'BUY' | 'SELL' | 'SHIP' | 'LOAN'）→ 用 wire
  //    b) 派系合同（'MATERIALS' / 'INFRASTRUCTURE' 等）+ wire=null：用 conditions 级别
  //       分析（谁付款、谁交货）反推 BUY/SELL，不再盲信 contract.party。
  //    c) 都缺时：fallback 到 conditions 推断
  const wireType = contract.contractType as string | null | undefined;
  const tmpl: TaskContractJson['template'] =
    wireType && PLAYER_CONTRACT_TYPES.has(wireType)
      ? (wireType as TaskContractJson['template'])
      : conditionsToTemplate(contract.conditions, contract.party);

  // 2) currency 兜底链：
  //    - partner.currency?.code（玩家对方有 currency 字段时最准）
  //    - conditions[PAYMENT].amount.currency（对方是派系无 partner.currency，
  //      货币信息在 conditions 里。amount.currency 是 string 直接是货币 code）
  //    - 空字符串：稍后 matchContractJson 会拒（与 task.currency 比对失败）
  const currency =
    contract.partner.currency?.code ||
    contract.conditions.find(c => c.amount?.currency)?.amount?.currency ||
    '';

  const fp: ContractFingerprint = {
    template: tmpl,
    currency,
    items: conditionsToItems(contract.conditions),
  };
  // location / origin / destination
  // 取第一个有 address 的 condition（PAYMENT 可能排在第一位且无 address）
  const addrCond = contract.conditions.find(c => c.address);
  if (addrCond?.address) {
    fp.location = addressToLocation(addrCond.address);
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
    // 顶层 price 为 undefined 时，从 items 反算总价（BUY/SELL 任务价格在 item 级别）。
    // 合同侧 price 来自 PAYMENT 条件总金额，两侧需要可比。
    price: json.price ?? totalPriceFromItems(json.items),
  };
}

// 从 items 计算总价（sum of price × amount）
function totalPriceFromItems(items: TaskContractItem[]): number | undefined {
  const priced = items.filter(i => i.price !== undefined && i.price > 0);
  if (priced.length === 0) return undefined;
  return priced.reduce((sum, i) => sum + i.price! * i.amount, 0);
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
  // 顶层 price 比对：BUY/SELL 任务价格在 item 级别，task.contractJson.price
  // 可能是 undefined；合同侧 fingerprint.price 来自 PAYMENT 总金额。
  // 当一方缺失时，从各自 items 反算总价使两侧可比。
  // 与后端 utils/contract-match.ts matchContractFingerprint 保持一致。
  const taskPrice = task.price ?? totalPriceFromItems(task.items);
  const conPrice = con.price ?? totalPriceFromItems(con.items);
  if (!priceEquals(taskPrice, conPrice)) {
    return { matched: false, reason: `price mismatch: task=${taskPrice} contract=${conPrice}` };
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
