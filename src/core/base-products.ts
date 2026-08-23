// 基地产物列表工具：siteId → ticker 数组。
//
// 用途：XIT FLEET 产业链环线模式读取每基地的「最终产物」列表，
//      决定哪些 ticker 应该被提取回出发地。未设置时 chain-planner 回落到
//      burn 推断（output > 0 且无下游边）。

import { userData } from '@src/store/user-data';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';

/** 获取某基地设置的产物 ticker 列表，未设置时返回 undefined。 */
export function getBaseProducts(siteId: string): string[] | undefined {
  return userData.baseProducts[siteId];
}

/**
 * 设置基地产物列表。会自动：
 * - 去除空白、空项；
 * - 转为大写、过滤未在 materialsStore 中找到的 ticker；
 * - 去重；
 * - 空数组会清除条目（防止遗留空值）。
 */
export function setBaseProducts(siteId: string, products: string[]) {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of products) {
    const ticker = raw.trim().toUpperCase();
    if (ticker.length === 0) {
      continue;
    }
    if (!materialsStore.getByTicker(ticker)) {
      continue;
    }
    if (seen.has(ticker)) {
      continue;
    }
    seen.add(ticker);
    cleaned.push(ticker);
  }
  if (cleaned.length === 0) {
    clearBaseProducts(siteId);
    return;
  }
  userData.baseProducts[siteId] = cleaned;
}

/** 清除基地产物列表。 */
export function clearBaseProducts(siteId: string) {
  delete userData.baseProducts[siteId];
}

/** 把 ticker 数组格式化为逗号分隔字符串（用于 UI 显示）。 */
export function formatBaseProducts(products: string[] | undefined): string {
  return products?.join(', ') ?? '';
}
