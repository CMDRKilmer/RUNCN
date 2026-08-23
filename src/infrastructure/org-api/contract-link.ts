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
//
// 范围：只处理玩家间合同（contractType ∈ BUY/SELL/SHIP/LOAN）。派系/AI 合同
// （MATERIALS / INFRASTRUCTURE / ...）不在自动关联范围内——本系统只匹配玩家合同。
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
  // 交易对方 PrUn 用户名（不含后缀）。task 侧 publisher/claimer 用户名
  // 必须与合同 partner.name 匹配——避免不同玩家签相同 fingerprint
  // 误匹配（"BUY 1 RAT @ 1 ICA @ HRT" 任何两个买家都长这样）。
  // partnerName 缺失时跳过 partner 校验（兼容老合同/草稿）。
  partnerName?: string;
  // 交易对方 PrUn 公司代码（"QPL"）。后端用此字段与
  // task.publisher_company_code / claimer_company_code 比对。
  // 与 partnerName 互补：company code 稳定，partner.name 是公司全名
  // ("Quantum Pulse Inc") 不便比对。
  partnerCode?: string;
}

export interface ContractMatchResult {
  matched: boolean;
  reason?: string;
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
  if (!address || address.lines.length === 0) {
    return undefined;
  }
  // 取最后一行（通常是站点）的 naturalId；如果不存在则取倒数第二行（星系）
  for (let i = address.lines.length - 1; i >= 0; i--) {
    const line = address.lines[i];
    if ('entity' in line && line.entity?.naturalId) {
      return line.entity.naturalId;
    }
  }
  return undefined;
}

// PrUn wire contractType 取值（玩家间合同枚举）：
//   'BUY' | 'SELL' | 'SHIP' | 'LOAN'
// 派系合同（'MATERIALS' / 'INFRASTRUCTURE' / ...）不在本系统自动关联范围内。
const PLAYER_CONTRACT_TYPES = new Set(['BUY', 'SELL', 'SHIP', 'LOAN']);

// 从 conditions + 合同元信息推断玩家合同 template。
// PrUn 玩家合同（CUSTOMER 视角）在创建时 wire contractType = 'BUY' / 'SELL' /
// 'SHIP'，但经过服务端 contract.accept / counter-sign 等操作后，
// PrUn 把 contractType 字段重置为 null。
// 经验：仅靠 conditions 无法区分 BUY vs SELL（PAYMENT + 物品两边都长这样）。
// 因此 default 'BUY'，并把 wireType=null 的合同视为 BUY——auto-link
// 通过 effectiveTaskTemplate 反转规则（task listingId 存在时跳过反转）
// 决定 task 侧要试哪个 template：只有 BUY 任务能匹配 wire=null 的合同。
// 副作用：SELL 任务的合同在 wire=null 时无法命中——见 §"SELL 任务关联"
function inferContractTemplate(contract: PrunApi.Contract): TaskContractJson['template'] {
  const wireType = contract.contractType as string | null | undefined;
  // 派系合同（含 'MATERIALS' / 'INFRASTRUCTURE' / 'EXPLORATION' / 'FOOD' /
  // 'SHIPPING' / 'WORKFORCE' 等）以 wire 为准——它们不是 ORG 任务范围。
  if (wireType && !PLAYER_CONTRACT_TYPES.has(wireType)) {
    return '' as TaskContractJson['template'];
  }
  // wireType 落在玩家枚举里直接用（CONTD 刚创建时 wire 仍存在）。
  if (wireType && PLAYER_CONTRACT_TYPES.has(wireType)) {
    return wireType as TaskContractJson['template'];
  }
  // wireType 为 null（CONTS 玩家合同常见状态）→ 从合同元信息推断。
  // PrUn 在 accept 后清除 contractType，但 Contract.party 仍标识持有方身份：
  //   CUSTOMER = 持有方是"发起方 / 收货方"（玩家合同里恒为 buyer 视角）
  //   PROVIDER = 持有方是"提供方 / 收钱方"（玩家合同里恒为 seller 视角）
  // 玩家合同在我方持有时视角规则：
  //   - 我发起的 BUY（pay & receive goods）        → 我是 CUSTOMER
  //   - 我发起的 SELL（receive money & deliver goods）→ 我是 PROVIDER
  //   - 我接签别人 BUY（我 deliver）               → 我是 PROVIDER
  //   - 我接签别人 SELL（我 pay & receive）         → 我是 CUSTOMER
  // PrUn 玩家合同永远从 CUSTOMER 视角创建 + wire contractType 指明方向；
  // accept 后 wire=null，但 contract.name 通常带 "BUY"/"SELL"/"SHIP" 前缀。
  // name 是 PrUn contract.create 时的输入透传，CONTD 流程由前端控制——
  // ORG sendTaskToContd 透传 contractJson.template 作为 name 时也是 OK 的，
  // 但 CONTD 流程下 name 被 PrUn 自己格式化（如 "BUY 100 RATS @ HRT"）。
  const hasPickup = contract.conditions.some(
    c => c.type === 'PICKUP' || c.type === 'PICKUP_SHIPMENT',
  );
  if (hasPickup) {
    return 'SHIP';
  }
  // name fallback：PrUn contract.create 输出的 name 通常带 "BUY"/"SELL" 前缀。
  const namePrefix = (contract.name ?? '').trim().split(/\s+/)[0]?.toUpperCase();
  if (namePrefix && PLAYER_CONTRACT_TYPES.has(namePrefix)) {
    return namePrefix as TaskContractJson['template'];
  }
  // 最后兜底：wire=null + 无 pickup + name 无前缀 → BUY。
  // SELL 任务匹配会失败，但 BUY 任务能命中——覆盖 95% 场景。
  return 'BUY';
}

// 把 PrUnApi.Contract 投影为指纹
// 导出供前端调用以联调后端 match-contract 端点：
// auto-link 在确认弹窗前先把 contract 转 fingerprint 上报，
// 后端以 task.contractJson 为权威源严格比对，避免不同客户端分叉。
export function contractToFingerprint(contract: PrunApi.Contract): ContractFingerprint {
  // contractType：用 inferContractTemplate 替代直接读 wire 字段。
  // 玩家合同经过 accept / counter-sign 后 PrUn 会把 contractType 重置为
  // null（仅靠 wire 字段会误判为非玩家合同），从 conditions 推断更可靠。
  const tmpl = inferContractTemplate(contract);

  // currency：玩家对方 partner.currency?.code 经常为空（PrUn 玩家合同
  // 不在 partner 上填 currency 字段），回退到 conditions[i].amount.currency
  // （PAYMENT 条件必带 currency）。
  let currency = contract.partner.currency?.code ?? '';
  if (!currency) {
    for (const cond of contract.conditions) {
      if (cond.amount?.currency) {
        currency = cond.amount.currency;
        break;
      }
    }
  }

  const fp: ContractFingerprint = {
    template: tmpl,
    currency,
    items: conditionsToItems(contract.conditions),
    // partner.name 形如 "kolo (QPL)" / "Quantum Pulse Inc"；
    // 提取首段作为 username（括号前的部分），task 侧匹配时按
    // publisherUsername / claimerUsername 包含子串判定。
    partnerName: (contract.partner.name ?? '').split(/\s*\(/)[0]?.trim() || undefined,
    // partner.code 是稳定的公司代码（"QPL"）。后端用此字段与
    // task.publisher_company_code / claimer_company_code 比对，
    // 避免 partner.name 是公司全名无法比对的问题。
    partnerCode: contract.partner.code ?? undefined,
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
      if (i.price !== undefined) {
        item.price = i.price;
      }
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
  if (priced.length === 0) {
    return undefined;
  }
  return priced.reduce((sum, i) => sum + i.price! * i.amount, 0);
}

const PRICE_TOLERANCE = 0.005; // ±0.5%

// 价格在容差内视为相等
function priceEquals(a: number | undefined, b: number | undefined): boolean {
  if (a == null && b == null) {
    return true;
  }
  if (a == null || b == null) {
    return false;
  }
  if (a === 0 && b === 0) {
    return true;
  }
  const max = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / max <= PRICE_TOLERANCE;
}

// items 集合相等（commodity 全等，amount 严格，price 容差）
function itemsEqual(a: ContractFingerprint['items'], b: ContractFingerprint['items']): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const sortedA = [...a].sort((x, y) => x.commodity.localeCompare(y.commodity));
  const sortedB = [...b].sort((x, y) => x.commodity.localeCompare(y.commodity));
  for (let i = 0; i < sortedA.length; i++) {
    const ia = sortedA[i];
    const ib = sortedB[i];
    const commodityMatch = ia.commodity === ib.commodity;
    if (!commodityMatch) {
      return false;
    }
    const amountMatch = ia.amount === ib.amount;
    if (!amountMatch) {
      return false;
    }
    const pricesMatch: boolean = priceEquals(ia.price, ib.price);
    if (!pricesMatch) {
      return false;
    }
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
