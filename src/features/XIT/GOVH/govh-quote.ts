// XIT GOVH → XIT CBUY 的临时基建补给比价清单。
// 与 REPD 的 repair-quote 同构：只放模块内存，不写 userData.cart、不落盘、不加外部价格源。
// 作为 XIT CBUY 的第四种清单来源（CART / <星球>BURN / REPD / GOVH）。
//
// items 传「完整补给需求」：GOVH 求解出的每个选中 (building, material) 的
// 满仓待补量（POPID 两格填满），按 ticker 合并。仓库抵扣统一交给 XIT CBUY 计算，
// 避免出现上游扣一遍、CBUY 再扣一遍的重复扣减。

import { shallowRef } from 'vue';

export const GOVH_QUOTE_PARAM = 'GOVH';

export interface GovhQuoteItem {
  ticker: string;
  name: string;
  amount: number;
}

export interface GovhQuote {
  planet: string;
  target: number;
  items: GovhQuoteItem[];
}

// 必须是响应式 ref：CBUY 窗口会被 showBuffer 复用，普通模块变量会被 computed 永久缓存。
export const govhQuoteRef = shallowRef<GovhQuote | undefined>(undefined);

export function setGovhQuote(quote: GovhQuote) {
  govhQuoteRef.value = quote;
}

export function getGovhQuote(): GovhQuote | undefined {
  return govhQuoteRef.value;
}
