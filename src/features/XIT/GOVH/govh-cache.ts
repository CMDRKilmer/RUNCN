// XIT GOVH 会话级快照缓存：同一标签页内切回面板 / 刷新页面直接复用本地读数。
//
// 只缓存 govh-dom 从游戏原生 POPR / POPI / POPID 窗口读到的纯数据；
// 不缓存价格（价格走 cxobStore 实时订单簿），不写用户云同步，不发任何外部请求。
// 「刷新数据」按钮强制绕过并覆写缓存；TTL 到点自动重读，避免长期展示过期存量。

import type { GovhSnapshot } from './govh-dom';

const PREFIX = 'rprun.govh.snapshot.v1.';
const TTL = 5 * 60 * 1000;

export interface CachedGovhSnapshot {
  snapshot: GovhSnapshot;
  savedAt: number;
}

function keyOf(planet: string): string {
  return PREFIX + planet.trim().toUpperCase();
}

export function readCachedSnapshot(planet: string): CachedGovhSnapshot | undefined {
  try {
    const key = keyOf(planet);
    const raw = sessionStorage.getItem(key);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as CachedGovhSnapshot | null;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.savedAt !== 'number' ||
      parsed.snapshot === null ||
      parsed.snapshot === undefined ||
      parsed.snapshot.planet?.toLowerCase() !== planet.trim().toLowerCase()
    ) {
      return undefined;
    }
    if (Date.now() - parsed.savedAt > TTL) {
      sessionStorage.removeItem(key);
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeCachedSnapshot(planet: string, snapshot: GovhSnapshot): void {
  try {
    sessionStorage.setItem(
      keyOf(planet),
      JSON.stringify({ snapshot, savedAt: Date.now() } as CachedGovhSnapshot),
    );
  } catch {
    // 隐私模式 / 配额不足时静默降级为每次重读，不影响功能。
  }
}
