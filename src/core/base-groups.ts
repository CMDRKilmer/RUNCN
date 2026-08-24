// 基地供应链分组工具：siteId → 分组名数组。
//
// 存储位置：userData.baseGroups（自动同步到 chrome.storage.local）。
// 用途：XIT FLEET 产业链环线按「分组」载入基地，取代按船只分配基地的方式。
// 分组名为自由文本，逗号/空格分隔录入，每个基地可属于任意多个分组。

import { userData } from '@src/store/user-data';

/** 获取某基地的分组名列表，未设置时返回 undefined。 */
export function getBaseGroups(siteId: string): string[] | undefined {
  return userData.baseGroups[siteId];
}

/**
 * 设置基地分组列表。会自动：
 * - 去除空白、空项；
 * - 去重（忽略大小写）；
 * - 空数组会清除条目（防止遗留空值）。
 */
export function setBaseGroups(siteId: string, groups: string[]) {
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of groups) {
    const name = raw.trim();
    if (name.length === 0) {
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    cleaned.push(name);
  }
  if (cleaned.length === 0) {
    clearBaseGroups(siteId);
    return;
  }
  userData.baseGroups[siteId] = cleaned;
}

/** 清除基地分组。 */
export function clearBaseGroups(siteId: string) {
  delete userData.baseGroups[siteId];
}

/** 把分组名数组格式化为逗号分隔字符串（用于 UI 显示）。 */
export function formatBaseGroups(groups: string[] | undefined): string {
  return groups?.join(', ') ?? '';
}
