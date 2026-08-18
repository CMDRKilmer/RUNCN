// 基地别名工具：站点 siteId → 玩家自定义别名。
//
// 存储位置：userData.baseAliases（自动同步到 chrome.storage.local）。
// 不在迁移里修改 userData——这里只暴露查询/写入 API。

import { userData } from '@src/store/user-data';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';

/** 获取某基地的别名，未设置时返回 undefined。 */
export function getBaseAlias(siteId: string): string | undefined {
  return userData.baseAliases[siteId];
}

/** 设置基地别名。空字符串会清除条目（防止遗留空值）。 */
export function setBaseAlias(siteId: string, alias: string) {
  const trimmed = alias.trim();
  if (trimmed.length === 0) {
    clearBaseAlias(siteId);
    return;
  }
  userData.baseAliases[siteId] = trimmed;
}

/** 清除基地别名。 */
export function clearBaseAlias(siteId: string) {
  delete userData.baseAliases[siteId];
}

/**
 * 把任意字符串解析为行星 naturalId：
 * 1. 先按 naturalId 直接查找（玩家自己输入的）；
 * 2. 再按玩家自定义的别名查找，命中后返回对应基地的行星 naturalId。
 * 命中失败返回 undefined。
 */
export function resolveBaseAliasOrNaturalId(query: string): string | undefined {
  const needle = query.trim();
  if (needle.length === 0) {
    return undefined;
  }

  // 别名优先：玩家定义的名字比默认 naturalId 更短、更易记。
  for (const [siteId, alias] of Object.entries(userData.baseAliases)) {
    if (alias.toLowerCase() !== needle.toLowerCase()) {
      continue;
    }
    const site = sitesStore.getById(siteId);
    const naturalId = getEntityNaturalIdFromAddress(site?.address);
    if (naturalId) {
      return naturalId;
    }
  }

  // 直接按 naturalId 命中。
  const direct = sitesStore.getByPlanetNaturalId(needle);
  if (direct) {
    return getEntityNaturalIdFromAddress(direct.address) ?? needle;
  }

  return undefined;
}
