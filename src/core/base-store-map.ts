import { computed } from 'vue';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';

// ── 星球编码 → 基地仓库 id 对照表（纯运行时推导，无账号数据）──────
// 游戏原生 `INV <星球编码>` 在该星球有 2 个以上仓库时会退化成「仓库列表」，
// 而 `INV <仓库 id 前 8 位>` 会直接打开那一个仓库的可拖动物品网格。
//
// 规则由游戏引擎保证、与账号无关：每个基地(site)都有一个 type === 'STORE'
// 的仓库，其 addressableId 就是 siteId，id 在基地建成时固定、不随别名变化。
// 所以这里从玩家自己的 SITE_SITES / STORAGE_STORAGES 实时生成对照表：
//   · 换账号、换星球、改别名 —— 自动适配；
//   · 新建基地 —— 服务端推送数据后自动纳入，无需发版、无需配置；
//   · 代码里不含任何星球编码或仓库 id。
const SHORT_ID_LENGTH = 8;

// 开发期逃生口：仅当某个账号出现「同一 site 多个 STORE 且想指定另一个」时才填，
// key 为星球编码（大小写不限），value 为仓库 id 前 8 位。分发时保持为空即可。
export const BASE_STORE_OVERRIDES: Record<string, string> = {};

/** 星球编码（小写）→ 基地仓库 id 前 8 位。随游戏数据实时更新。 */
export const baseStoreMap = computed<Record<string, string>>(() => {
  // all 在对应 STORE 消息到达前是 undefined，此时表为空，调用方会回退到
  // `INV <星球编码>`；数据就绪后 computed 重算，FB 的巡检会自动纠正命令。
  const stores = storagesStore.all.value ?? [];
  const bySite = new Map<string, PrunApi.Store[]>();
  for (const store of stores) {
    if (store.type !== 'STORE') {
      continue;
    }
    const group = bySite.get(store.addressableId);
    if (group) {
      group.push(store);
    } else {
      bySite.set(store.addressableId, [store]);
    }
  }

  const entries: { key: string; short: string }[] = [];
  for (const site of sitesStore.all.value ?? []) {
    const naturalId = getEntityNaturalIdFromAddress(site.address);
    if (!naturalId) {
      continue;
    }
    const group = bySite.get(site.siteId);
    if (group === undefined || group.length === 0) {
      continue;
    }
    // 万一同一 site 出现多个 STORE，按 id 稳定排序取第一个，保证结果确定。
    const chosen =
      group.length === 1 ? group[0] : [...group].sort((a, b) => a.id.localeCompare(b.id))[0];
    entries.push({ key: naturalId.toLowerCase(), short: chosen.id.substring(0, SHORT_ID_LENGTH) });
  }

  // 8 位前缀碰撞时宁可回退到仓库列表，也绝不把 INV 指到别的基地。
  const owner = new Map<string, string>();
  const conflicted = new Set<string>();
  for (const entry of entries) {
    const previous = owner.get(entry.short);
    if (previous !== undefined && previous !== entry.key) {
      conflicted.add(entry.short);
    } else {
      owner.set(entry.short, entry.key);
    }
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(BASE_STORE_OVERRIDES)) {
    result[key.toLowerCase()] = value.toLowerCase();
  }
  for (const entry of entries) {
    if (!conflicted.has(entry.short) && !(entry.key in result)) {
      result[entry.key] = entry.short;
    }
  }
  return result;
});

/** 把任意输入（星球编码 / 名字 / 别名 / 大小写变体 / siteId）归一成星球编码。 */
export function resolvePlanetNaturalId(input?: string | null): string | undefined {
  const value = input?.trim();
  if (!value) {
    return undefined;
  }
  const lower = value.toLowerCase();
  if (lower in baseStoreMap.value) {
    return lower;
  }
  // 借游戏自己的地址索引反查：支持星球名、别名、siteId、大小写差异。
  const site = sitesStore.getByPlanetNaturalIdOrName(value) ?? sitesStore.getById(value);
  const naturalId = getEntityNaturalIdFromAddress(site?.address);
  return naturalId?.toLowerCase();
}

export function getBaseStoreId(input?: string | null): string | undefined {
  const key = resolvePlanetNaturalId(input);
  return key === undefined ? undefined : baseStoreMap.value[key];
}

/** 直接打开该基地仓库内容物的游戏原生命令；数据未就绪时返回 undefined。 */
export function getBaseStoreCommand(input?: string | null): string | undefined {
  const id = getBaseStoreId(input);
  return id ? `INV ${id}` : undefined;
}
