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
// 基地增减很慢；同一星球 10 分钟内复用上次结果，避免每点一次「刷新数据」都开窗。
const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { count: number; at: number }>();

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
    const hit = cache.get(code);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      return { total: hit.count, source: 'channel' };
    }
  }
  const count = await countChannelMembers(code);
  if (count === undefined || count <= 0) {
    return undefined;
  }
  cache.set(code, { count, at: Date.now() });
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
