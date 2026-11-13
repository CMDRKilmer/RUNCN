// XIT REPD → XIT CBUY 的临时维修比价清单。
// 只放在模块内存里：不写入 userData.cart（XIT CART 购物车）、不落盘、不新增外部价格源。
// 与「XIT CBUY <星球编码>」（BURN 消耗品比价）并列，作为 CBUY 的第三种清单来源。
//
// items 一律传「完整维修账单」：不扣基地库存、不扣交易所仓库库存。
// 所有抵扣统一由 XIT CBUY 自己算（见 cbuy-inventory.ts），这样比价数量、
// ACT 购买量与 MTRA 转移量都出自同一份原始数据，不会出现上游扣一遍、
// CBUY 再扣一遍的重复扣减。

// 命令参数用固定字面量而不是基地编码：清单本身带 naturalId，参数只负责选模式，
// 也避免把 REPD 当成星球名去 sitesStore 里查。
import { shallowRef } from 'vue';

export const REPD_QUOTE_PARAM = 'REPD';

export interface RepairQuoteItem {
  ticker: string;
  name: string;
  amount: number;
}

export interface RepairQuote {
  siteId: string;
  naturalId: string;
  items: RepairQuoteItem[];
}

// 必须是响应式 ref：CBUY 窗口会被 showBuffer 复用，若用普通模块变量，
// 组件内的 computed 读一次后就永久缓存，第二次点「比价」仍显示上一份清单。
export const repairQuoteRef = shallowRef<RepairQuote | undefined>(undefined);

export function setRepairQuote(quote: RepairQuote) {
  repairQuoteRef.value = quote;
}

export function getRepairQuote(): RepairQuote | undefined {
  return repairQuoteRef.value;
}
