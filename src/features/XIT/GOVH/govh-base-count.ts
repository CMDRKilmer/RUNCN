// 整星基地总数：本地口径，来自星球聊天频道「<星球> Global Site Owners」的用户列表。
//
// 为什么需要它：安全 / 健康两项的基础供给是「每座基地 +50」，而且是**整个星球共享**
// （同星球所有公司的基地都算）。本地 sitesStore 只有本公司的站点，共享星球上会把
// 基础供给算少一个数量级，导致多买安全 / 健康物料（PR #60 审查 P2）。
//
// 为什么不用 FIO：`/infrastructure/<星球>` 那份数据实测不可信——VH-192b 报 44 座、
// AW-844a 报 34 座，而两个星球的频道会员分别是 4 人和 2 人（用户已确认 VH-192b
// 确实是 4 座）。整星基地数一律以游戏本地频道为准，GOVH 不连任何外部网站。
//
// 口径：PrUn 一家公司在同一星球只能有一座基地，所以「频道会员数 = 基地数」。
// 读不到（频道不存在 / 未加入 / 窗口超时）返回 undefined，由调用方回退到自有基地数
// 并在面板上标明口径。

import { computed, ref } from 'vue';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { sleep } from '@src/utils/sleep';

const READ_TIMEOUT = 12000;
// 整星基地数服务于安全 / 健康的基础供给（每座 +50），而这两项是**按人口报告周期
// 结算**的：周期内新建成 / 拆除基地不会立刻反映到满足度上，要等下一次报告。
// 所以缓存跟着人口报告周期走——同一周期内复用，跨周期重读，与 POPR 缓存同一个
// 失效时刻（`rprun.govh.popr.v1.<星球>` 的 endsAt）。
// 读不到周期信息时退回 24 小时兜底，避免退化成每次开窗。
// 表头始终标注「整星 N 座基地（自有 M）」，口径可见；「刷新数据」会强制重读。
const FALLBACK_TTL_MS = 24 * 60 * 60 * 1000;
const STORAGE_PREFIX = 'rprun.govh.base-count.v1.';
const POPR_CACHE_PREFIX = 'rprun.govh.popr.v1.';

// 该星球当前人口报告周期的结束时刻（由 POPR 缓存写入）。
function reportCycleEndsAt(planet: string): number | undefined {
  try {
    const raw = localStorage.getItem(POPR_CACHE_PREFIX + planet.toUpperCase());
    if (raw === null) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as { endsAt?: unknown } | null;
    return typeof parsed?.endsAt === 'number' ? parsed.endsAt : undefined;
  } catch {
    return undefined;
  }
}

function readCached(planet: string): number | undefined {
  const code = planet.trim().toLowerCase();
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + code);
    if (raw === null) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as {
      count?: unknown;
      at?: unknown;
      cycleEndsAt?: unknown;
    } | null;
    if (
      parsed === null ||
      typeof parsed.count !== 'number' ||
      typeof parsed.at !== 'number' ||
      parsed.count <= 0
    ) {
      return undefined;
    }
    const cycle = reportCycleEndsAt(planet);
    if (cycle !== undefined) {
      // 与人口报告周期绑定：换了周期或已过期就重读，避免用上一期的基地数。
      const sameCycle = parsed.cycleEndsAt === cycle;
      if (!sameCycle || Date.now() >= cycle) {
        return undefined;
      }
      return parsed.count;
    }
    if (Date.now() - parsed.at > FALLBACK_TTL_MS) {
      localStorage.removeItem(STORAGE_PREFIX + code);
      return undefined;
    }
    return parsed.count;
  } catch {
    // 隐私模式 / 配额不足 / 脏数据：当作没有缓存，走实时读取。
    return undefined;
  }
}

function writeCached(planet: string, count: number): void {
  const code = planet.trim().toLowerCase();
  try {
    localStorage.setItem(
      STORAGE_PREFIX + code,
      JSON.stringify({
        count,
        at: Date.now(),
        cycleEndsAt: reportCycleEndsAt(planet),
      }),
    );
  } catch {
    // 写不进去就每次重读，不影响功能。
  }
}

export interface PlanetBaseCount {
  // 整星基地总数（含其他公司的基地）。
  total: number;
  // 数据来源标记，面板要如实标注，不能让人以为是本地实时值。
  source: 'channel';
}

// 读某星球的整星基地数。force=true 时跳过缓存。
export async function readPlanetBaseCount(
  planet: string,
  force = false,
): Promise<PlanetBaseCount | undefined> {
  const code = planet.trim().toLowerCase();
  if (code === '') {
    return undefined;
  }
  if (!force) {
    const cached = readCached(planet);
    if (cached !== undefined) {
      return { total: cached, source: 'channel' };
    }
  }
  const count = await countChannelMembers(code);
  if (count === undefined || count <= 0) {
    return undefined;
  }
  writeCached(planet, count);
  return { total: count, source: 'channel' };
}

// 开 hidden 的 COMG 窗口 → 打开「用户列表」→ 数会员 → 还原开关 → 关窗。
// 「用户列表」是持久化的聊天 UI 偏好，只在自己打开过时才关回去，不改玩家布局。
async function countChannelMembers(code: string): Promise<number | undefined> {
  const ready = ref(false);
  const window = await Promise.race([
    showBuffer(`COMG pl-${code}`, {
      force: true,
      autoClose: true,
      closeWhen: computed(() => ready.value),
    }),
    sleep(READ_TIMEOUT).then(() => undefined),
  ]);
  let toggled = false;
  try {
    if (!window) {
      return undefined;
    }
    const deadline = Date.now() + READ_TIMEOUT;
    while (Date.now() < deadline) {
      const toggle = userListToggle(window);
      if (toggle) {
        // 已经是打开状态就别点，免得反把玩家的列表关掉。
        if (!isToggleOn(toggle)) {
          toggle.click();
          toggled = true;
        }
        const count = countUsers(window);
        if (count > 0) {
          return count;
        }
      }
      await sleep(200);
    }
    return undefined;
  } finally {
    // 还原「用户列表」开关：只在自己点开过的情况下关回去。
    if (toggled && window) {
      const toggle = userListToggle(window);
      if (toggle && isToggleOn(toggle)) {
        toggle.click();
        await sleep(150);
      }
    }
    ready.value = true;
    if (window) {
      for (let i = 0; i < 30 && window.isConnected; i++) {
        await sleep(50);
      }
      // 与 govh-dom 的读取一致：等窗口 DOM 断开后再让出一点时间给游戏收敛，
      // 否则紧跟着开的 POPID 窗口容易抢到正在关闭的壳。
      await sleep(250);
    }
  }
}

// 聊天窗口右上角的第一个开关就是「用户列表」（静音 / 隐藏加入 / 隐藏删除 在其后）。
function userListToggle(window: HTMLElement): HTMLElement | undefined {
  const controls = window.querySelector('[class*="Channel__controls"]');
  const first = controls?.querySelector('[class*="SelectButton__container"]');
  return (
    (first?.querySelector('[class*="RadioItem__container"]') as HTMLElement | null) ?? undefined
  );
}

function isToggleOn(toggle: HTMLElement): boolean {
  return toggle.querySelector('[class*="RadioItem__active"]') !== null;
}

// 会员行是 <span class="UserList__userActive… UserList__user…">，在线 / 离线各一个
// UserList__list，两个列表一起数。表头（用户（在线）/（离线））不是会员行。
function countUsers(window: HTMLElement): number {
  return window.querySelectorAll('[class*="UserList__user"]').length;
}
