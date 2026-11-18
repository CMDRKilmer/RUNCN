import { baseStoreMap, resolvePlanetNaturalId } from '@src/core/base-store-map';
import { getScreenVariable } from '@src/core/screen-variables';
import { UI_TILES_CHANGE_COMMAND } from '@src/infrastructure/prun-api/client-messages';
import { dispatchClientPrunMessage } from '@src/infrastructure/prun-api/prun-api-listener';
import { getPrunId } from '@src/infrastructure/prun-ui/attributes';

// 游戏原生 `INV <星球编码>` 在该星球有 2 个以上仓库时会退化成「仓库列表」，
// 而 `INV <仓库 id 前 8 位>` 直接打开那一个仓库的可拖动物品网格——XIT FB 的
// INV 槽就是这么做的。这里把同一条规则搬到全局：任何 INV 磁贴只要参数是
// 自己基地所在的星球，就改写成该基地仓库的 id。
//
// 改写会顶掉游戏自己的 `$BS` 变量绑定（命令换成静态文本后游戏不再更新它），
// 所以跟随由这里接管。跟随状态按磁贴 UUID 记录并持久化：
//   · UUID 是游戏给磁贴分配的稳定标识，切屏幕标签会重建 DOM 但 UUID 不变；
//   · 页面重载后模块状态清空，从 localStorage 恢复，不依赖「命令是否等于当前基地」
//     ——切过基地后命令指向的是旧基地，那种判定会让跟随永久失效。
// 只有玩家手动把命令改成货舱/其它仓库时才撤销跟随。
const SHORT_ID_PATTERN = /^[0-9a-f]{8}$/i;
const FOLLOW_ATTR = 'data-rp-inv-follows-base';
const FOLLOWS_KEY = 'rp-inv-precise-follows-v1';
const SWEEP_INTERVAL_MS = 800;
// 值 = 最近一次确认显示在命令栏里的目标命令，用来识别玩家手动改写。
const followers = new Map<string, string>();

function loadFollowers() {
  try {
    const raw = localStorage.getItem(FOLLOWS_KEY);
    if (raw === null) {
      return;
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.length > 0) {
        followers.set(key, value);
      }
    }
  } catch {
    // 隐私模式或损坏的存档：从空状态开始，不影响其它功能。
  }
}

function saveFollowers() {
  try {
    localStorage.setItem(FOLLOWS_KEY, JSON.stringify(Object.fromEntries(followers)));
  } catch {
    // 存储不可用（隐私模式/配额满）：跟随仍在本会话内工作。
  }
}

// 当前基地以游戏原生 `$BS` 输入框为准：点 FLEET 星球时，若正好有地址框处于
// 打开状态，PlanetRow 的 onPlanetClick 会走 selectAddress 分支直接返回，不调用
// writeScreenVariable —— 此时插件 store 停留在旧值，只有原生输入框被更新。
// 反过来在没有原生变量栏的屏幕（总览/财务等）原生输入框读不到，才退回插件 store
// （它由 writeScreenVariable 写入，跨屏幕持久）。两种来源都必须支持，缺一就会
// 在某些操作顺序下跟随失效。
function baseValue(): string {
  const input = document.querySelector<HTMLInputElement>(
    '[class*="ScreenVariableControls__bar"] input',
  );
  const native = input?.value.trim() ?? '';
  if (native.length > 0) {
    return native;
  }
  const stored = getScreenVariable('BS');
  return stored === undefined ? '' : stored.trim();
}

/** 仓库短 id → 星球编码：页面初次运行时命令已是仓库 id，靠它判断这块磁贴属于哪颗星球。 */
function planetOfStore(short: string): string | undefined {
  for (const [planet, id] of Object.entries(baseStoreMap.value)) {
    if (id === short) {
      return planet;
    }
  }
  return undefined;
}

/** 磁贴参数指向哪颗自己的基地星球：星球编码或仓库 id 都认。 */
function ownerOf(parameter: string): string | undefined {
  const value = parameter.trim().toLowerCase();
  return SHORT_ID_PATTERN.test(value) ? planetOfStore(value) : resolvePlanetNaturalId(parameter);
}

/** 跟随基地的磁贴该显示什么：优先该基地自己的仓库，没有就退回星球命令。 */
function followTarget(raw: string): string {
  const planet = resolvePlanetNaturalId(raw);
  const short = planet === undefined ? undefined : baseStoreMap.value[planet];
  return short === undefined ? `INV ${raw.trim()}` : `INV ${short}`;
}

/** 游戏用 hidden 类标记「不该显示的窗口」（showBuffer 的 autoClose 临时缓冲）。 */
function isHiddenWindow(win: HTMLElement): boolean {
  for (const className of win.classList) {
    if (className.includes('hidden')) {
      return true;
    }
  }
  return false;
}

function sweep() {
  // 后台标签页不做无意义的巡检：切回来立刻会跑一轮。
  if (document.visibilityState === 'hidden') {
    return;
  }
  const rawBase = baseValue();
  const base = rawBase.length === 0 ? undefined : resolvePlanetNaturalId(rawBase);
  const commandElements = document.querySelectorAll<HTMLElement>('[class*="TileFrame__cmd"]');
  let changed = false;
  for (const element of commandElements) {
    const text = (element.textContent ?? '').trim();
    const [head, ...rest] = text.split(/\s+/);
    if (head === undefined || head.toUpperCase() !== 'INV') {
      continue;
    }
    const tileElement = element.closest<HTMLElement>('[class*="Tile__tile"]');
    if (tileElement === null) {
      continue;
    }
    // 隐藏缓冲窗口（showBuffer 的 autoClose 询价窗口、XIT FB 借用的槽位窗口）
    // 由各自的维护方管理命令，这里不能插手，否则会互相覆盖。
    const win = tileElement.closest<HTMLElement>('[class*="Window__window"]');
    if (win !== null && isHiddenWindow(win)) {
      continue;
    }
    const tileId = getPrunId(tileElement);
    if (tileId === null) {
      continue;
    }
    const parameter = rest.join(' ');
    const value = parameter.trim().toLowerCase();
    const owner = ownerOf(parameter);
    const expected = rawBase.length === 0 ? undefined : followTarget(rawBase);

    // 跟随状态以 UUID 为准。DOM 属性只作诊断展示，不参与判定：
    // 切屏幕标签时 DOM 会重建，写在元素上的属性会随之丢失。
    let follows = followers.has(tileId);
    if (follows && owner === undefined) {
      // 命令变成货舱、交易所等我们从不改写的形态：玩家手动改了，撤销跟随。
      // 注意不能只凭「命令暂时不等于预期」撤销——切基地后游戏重渲染命令有延迟，
      // 单帧不匹配就撤销会让跟随「时好时坏」。
      followers.delete(tileId);
      changed = true;
      follows = false;
    } else if (!follows) {
      // 首次认定：`INV <当前基地>`（含游戏变量解析出的 `INV $BS`）改写成精准仓库，
      // 并登记为跟随磁贴。其它基地的固定仓库不受影响。
      if (owner !== undefined && base !== undefined && owner === base && expected !== undefined) {
        followers.set(tileId, expected);
        changed = true;
        follows = true;
      }
    }
    if (follows) {
      tileElement.setAttribute(FOLLOW_ATTR, 'true');
    } else {
      tileElement.removeAttribute(FOLLOW_ATTR);
    }

    let target: string | undefined;
    if (follows) {
      // 目标完全由当前 `$BS` 决定：切到别的基地就跟着换仓库，没有该基地的仓库
      // 就退回 `INV <星球>` 交给游戏的仓库列表。
      target = expected;
    } else if (!SHORT_ID_PATTERN.test(value) && owner !== undefined) {
      // 非跟随磁贴：星球编码 → 精准仓库 id。已经是仓库 id 的保持原样。
      const short = baseStoreMap.value[owner];
      if (short !== undefined) {
        target = `INV ${short}`;
      }
    }

    // 每轮独立重算，命中就不下发：即使上一轮的消息被游戏忽略，下一轮会自动重试。
    if (target === undefined || target === text) {
      continue;
    }
    dispatchClientPrunMessage(UI_TILES_CHANGE_COMMAND(tileId, target));
  }
  if (changed) {
    saveFollowers();
  }
}

function init() {
  loadFollowers();
  sweep();
  setInterval(sweep, SWEEP_INTERVAL_MS);
}

features.add(import.meta.url, init, 'INV：把基地星球编码改写成精确的仓库 id，直接打开该仓库。');
