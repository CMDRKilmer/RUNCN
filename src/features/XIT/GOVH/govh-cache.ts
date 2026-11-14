// XIT GOVH 会话级快照缓存：同一标签页内切回面板 / 刷新页面直接复用本地读数。
//
// 只缓存 govh-dom 从游戏原生 POPR / POPI / POPID 窗口读到的纯数据；
// 不缓存价格（价格走 cxobStore 实时订单簿），不写用户云同步，不发任何外部请求。
// 「刷新数据」按钮强制绕过并覆写缓存；缓存到「五分钟 TTL」与「本期人口报告结束」
// 两者中更早的时刻失效，避免把上一期的人口 / 满足度带进新周期（PR #60 审查 P2）。

import { parseReportAge, reportCacheRemainingMs } from './govh-report-age';
import type { GovhSnapshot } from './govh-dom';

const PREFIX = 'rprun.govh.snapshot.v1.';
const TTL = 5 * 60 * 1000;

export interface CachedGovhSnapshot {
  snapshot: GovhSnapshot;
  savedAt: number;
  // 失效时刻 = min(savedAt + TTL, 本期人口报告结束时刻)。
  endsAt: number;
  // 整星基地数（COMG 用户列表），随快照一起恢复。
  planetBaseCount?: number;
}

function keyOf(planet: string): string {
  return PREFIX + planet.trim().toUpperCase();
}

// 报告标签解析不出、或本期马上结束时不写缓存，保持每次重读。
function expiryOf(snapshot: GovhSnapshot, savedAt: number): number | undefined {
  const age = parseReportAge(snapshot.reportLabel);
  if (age === undefined) {
    return undefined;
  }
  const remaining = reportCacheRemainingMs(age);
  if (remaining <= 0) {
    return undefined;
  }
  return Math.min(savedAt + TTL, savedAt + remaining);
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
      typeof parsed.endsAt !== 'number' ||
      (parsed.planetBaseCount !== undefined && typeof parsed.planetBaseCount !== 'number') ||
      parsed.snapshot === null ||
      parsed.snapshot === undefined ||
      parsed.snapshot.planet?.toLowerCase() !== planet.trim().toLowerCase()
    ) {
      sessionStorage.removeItem(key);
      return undefined;
    }
    if (Date.now() >= parsed.endsAt || Date.now() - parsed.savedAt > TTL) {
      sessionStorage.removeItem(key);
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeCachedSnapshot(
  planet: string,
  snapshot: GovhSnapshot,
  planetBaseCount?: number,
): void {
  const savedAt = Date.now();
  const endsAt = expiryOf(snapshot, savedAt);
  if (endsAt === undefined) {
    return;
  }
  try {
    sessionStorage.setItem(
      keyOf(planet),
      JSON.stringify({ snapshot, savedAt, endsAt, planetBaseCount } as CachedGovhSnapshot),
    );
  } catch {
    // 隐私模式 / 配额不足时静默降级为每次重读，不影响功能。
  }
}

// COMG 基地数晚于快照异步返回；只补这一个字段，不重置 savedAt / endsAt。
export function writeCachedBaseCount(planet: string, count: number | undefined): void {
  if (count === undefined) {
    // 读取失败时保留缓存里已有的数值，别把正确值清成「未知」。
    return;
  }
  const cached = readCachedSnapshot(planet);
  if (cached === undefined) {
    return;
  }
  try {
    sessionStorage.setItem(
      keyOf(planet),
      JSON.stringify({ ...cached, planetBaseCount: count } as CachedGovhSnapshot),
    );
  } catch {
    // 缓存不可写时忽略，面板仍会回退自有基地数。
  }
}
