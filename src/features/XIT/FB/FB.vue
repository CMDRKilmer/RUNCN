<script setup lang="ts">
import { screenVariables } from '@src/core/screen-variables';
import { writeScreenVariable } from '@src/features/basic/screen-variables';
import FLEET from '@src/features/XIT/FLEET/FLEET.vue';
import { getBaseStoreCommand, resolvePlanetNaturalId } from '@src/core/base-store-map';
import { getBaseShipEntries } from '@src/core/base-ship-map';
import { UI_TILES_CHANGE_COMMAND } from '@src/infrastructure/prun-api/client-messages';
import { dispatchClientPrunMessage } from '@src/infrastructure/prun-api/prun-api-listener';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { sitesStore } from '@src/infrastructure/prun-api/data/sites';
import { getPrunId } from '@src/infrastructure/prun-ui/attributes';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { closePrunWindow } from '@src/infrastructure/prun-ui/utils/close-prun-window';
import { useTile } from '@src/hooks/use-tile';

const $style = useCssModule();
const tile = useTile();

// 每一块 XIT FB 磁贴都是一个独立的完整面板：既可以是游戏内标签页里铺满整屏的
// 那块，也可以是在新建缓存窗口里输入 XIT FB 得到的浮动窗口。两者可以同时存在，
// 所以所有 DOM 认领都必须按「本磁贴」隔离。游戏给每块磁贴分配的 data-prun-id
// 跨标签切换保持不变，正好当作用域 id（标签页是 UUID，浮动窗口是数字编号）。
const SCOPE_ATTR = 'data-rp-fb-scope';
const scopeId = ref('');
const isFloating = ref(false);
const rootElement = ref<HTMLElement>();

function fbScope() {
  return scopeId.value;
}

function selfWindow() {
  return (tile.frame?.closest('[class*="Window__window"]') as HTMLElement | null) ?? null;
}

// ── 布局：左 FLEET，中 BS/INV/BURN，右 FLT + 舰船货舱列表 ───────
// BS / INV / XIT BURN / XIT FLT / SHPI 都是游戏内磁贴（仓库网格可拖动、多仓库列表、
// BS 产线/租金、BURN 消耗品剩余天数）。做法是让游戏真的把这些磁贴开出来，
// 再把 DOM 节点搬进槽位。
// 舰船货舱可能有多块（停靠的 + 飞往该基地的在途船），所以右下是一列子槽：
// 每艘船一个独立槽位、一块原生 SHPI 磁贴，多了就在列内滚动。
type StaticSlotKey = 'bs' | 'inv' | 'burn' | 'flt';
type SlotKey = StaticSlotKey | `ship${number}`;
const SHIP_SLOT_COUNT = 8;
const SHIP_SLOT_KEYS: SlotKey[] = Array.from(
  { length: SHIP_SLOT_COUNT },
  (_, i) => `ship${i}` as SlotKey,
);
const SLOT_KEYS: SlotKey[] = ['bs', 'inv', 'burn', 'flt', ...SHIP_SLOT_KEYS];

function shipSlotIndex(key: SlotKey): number | undefined {
  return typeof key === 'string' && key.startsWith('ship') ? Number(key.slice(4)) : undefined;
}

const bsHost = ref<HTMLElement>();
const invHost = ref<HTMLElement>();
const burnHost = ref<HTMLElement>();
const fltHost = ref<HTMLElement>();
const shipHosts = ref<(HTMLElement | undefined)[]>([]);

const staticHosts: Record<StaticSlotKey, Ref<HTMLElement | undefined>> = {
  bs: bsHost,
  inv: invHost,
  burn: burnHost,
  flt: fltHost,
};

// 模板里 v-for 的 ref 回调参数类型由 Vue 决定，这里放宽成 unknown 再做断言。
function setShipHost(index: number, element: unknown) {
  shipHosts.value[index] = (element as HTMLElement | null) ?? undefined;
}

function hostOf(key: SlotKey): HTMLElement | undefined {
  const index = shipSlotIndex(key);
  return index === undefined ? staticHosts[key as StaticSlotKey].value : shipHosts.value[index];
}

// 只认当前账号真实存在的基地。插件会分享给不同玩家：如果对方导入了别人的
// 配置、或配置里残留了已不属于自己的星球编码，这里自动落回自己账号的基地，
// 而不是拿一个无效编码去开窗口。数据未就绪时返回 undefined，巡检会稍后重试。
const selectedNaturalId = computed<string | undefined>(() => {
  const sites = sitesStore.all.value ?? [];
  if (sites.length === 0) {
    return undefined;
  }
  const naturalIds = sites
    .map(site => getEntityNaturalIdFromAddress(site.address))
    .filter((id): id is string => !!id);
  if (naturalIds.length === 0) {
    return undefined;
  }
  // 沿用插件原有的兜底（游戏下发顺序里的第一个基地），避免改变刷新后的落点。
  const fallback = getEntityNaturalIdFromAddress(sites[0].address) ?? naturalIds[0];
  const resolved = resolvePlanetNaturalId(screenVariables.BS);
  const match = resolved ? naturalIds.find(id => id.toLowerCase() === resolved) : undefined;
  return match ?? fallback;
});

// ── FB 内嵌磁贴标题：只保留原先的中文文字 ─────────────────────────
// 不拼接星球编码 / 外显名 / BSN 别名，也不显示命令文本，标题栏只剩
// 「基地」「库存基地」「消耗品报告」「舰队总览」这类原生中文标签。
// 只看 title 自身的文本节点：base-alias-display 追加的
// <span data-base-alias>「 · 别名」不属于「原先的中文文字」，必须忽略，
// 否则中文别名会被误收进标题。
// SHPI 例外：船名要保留全称（如「S-魔符级」），只去掉末尾的应答编码，
// 不能像其它磁贴那样只抽汉字，否则 S- 这类船名前缀会被裁掉。
const CJK_RE = /[\u3400-\u9fff]/g;
// 原生 SHPI 标题形如「S-魔符级（AVI-07FNL）」。括号里只匹配纯大写字母 /
// 数字 / 连字符的应答编码，不会误删船名自带的括号备注（含空格的那种）。
const SHPI_CODE_RE = /\s*[（(][A-Z0-9-]{2,16}[）)]\s*$/i;

function originalChineseOf(title: HTMLElement, isShip: boolean): string {
  let raw = '';
  for (const node of title.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      raw += node.textContent ?? '';
    }
  }
  raw = raw.trim();
  if (isShip) {
    // 只抽汉字会把「S-魔符级」裁成「魔符级」，丢掉 S- 这类船名前缀
    // （签名字符）。这里保留船名全称，仅隐去末尾应答编码；纯英文船名
    // （如 LCB-D（AVI-06CRH））同样保留船名，标题栏不会变空。
    return raw.replace(SHPI_CODE_RE, '').trim() || raw;
  }
  const chinese = raw.match(CJK_RE)?.join('') ?? '';
  // 其余磁贴没有汉字时保留原名，否则标题栏会变空。
  return chinese || raw;
}

function applyChineseTitle(element: HTMLElement) {
  const frame = element.querySelector(`.${C.TileFrame.frame}`) as HTMLElement | null;
  const title = frame ? (_$(frame, C.TileFrame.title) as HTMLElement | undefined) : undefined;
  if (!title) {
    return;
  }
  // 命令文本虽被 CSS display:none 隐藏，textContent 仍可读（collectTiles 也靠它认领），
  // 用它区分 SHPI 船名磁贴：只有它需要保留 S- 这类非汉字前缀。
  const command = frame ? (_$(frame, C.TileFrame.cmd)?.textContent ?? '').trim() : '';
  const wanted = originalChineseOf(title, /^SHPI\b/i.test(command));
  if (title.textContent === wanted) {
    return;
  }
  // 整体替换会顺带清掉别名 span 与游戏原文里的编码/外显名。
  // React 重渲染把原文写回来时，800ms 巡检会再裁一次（幂等）。
  title.textContent = wanted;
}

// 右下角要显示的船：停靠的在前、以该基地为目的地的在途船在后。
// 不读 FLEET「分配」列（那只是出发时的临时指派）。列表为空时所有子槽收起，
// 既不会开空白窗口，也不会把上一艘船的货舱留在屏幕上。
const shipEntries = computed(() => getBaseShipEntries(selectedNaturalId.value));
const shipEntryKey = computed(() =>
  shipEntries.value.map(entry => `${entry.status}:${entry.command}`).join('|'),
);

// 界面带游戏原生变量栏时（例如「基地全览」），子磁贴用 $BS 引用变量，
// 由游戏自己跟随；没有变量栏的 FB 标签页则走下面的「原地改命令」模式。
const variableMode = ref(false);

function hasVariableBar() {
  // 浮动缓存窗口没有屏幕变量栏。全文档查询会被主屏「基地全览」标签的变量栏
  // 误判成 variableMode，导致子磁贴发出在这个窗口里无法解析的 $BS 命令。
  if (isFloating.value) {
    return false;
  }
  return document.querySelector('[class*="ScreenVariableControls__bar"]') !== null;
}

function commandOf(key: SlotKey, naturalId?: string): string | undefined {
  const index = shipSlotIndex(key);
  if (index !== undefined) {
    // 舰船货舱不随 $BS 变量走：每艘船一条 SHPI 命令；该子槽没有船时返回
    // undefined，槽位收起且不会开出空白窗口。
    return shipEntries.value[index]?.command;
  }
  if (key === 'flt') {
    return 'XIT FLT';
  }
  if (variableMode.value) {
    switch (key) {
      case 'bs':
        return 'BS $BS';
      case 'inv':
        return 'INV $BS';
      default:
        return 'XIT BURN $BS';
    }
  }
  if (!naturalId) {
    return undefined;
  }
  switch (key) {
    case 'bs':
      return `BS ${naturalId}`;
    case 'inv':
      // INV <星球编码> 在该星球有多个仓库(基地/租的仓库/停靠飞船货舱)时
      // 只会显示仓库列表；用基地仓库 id 前 8 位才能直接看到内容物。
      return getBaseStoreCommand(naturalId) ?? `INV ${naturalId}`;
    default:
      // 中间栏最下面显示消耗品剩余天数（XIT BURN <星球编码>）。
      return `XIT BURN ${naturalId}`;
  }
}

function matchesSlot(key: SlotKey, command: string) {
  const value = command.trim().toUpperCase();
  if (shipSlotIndex(key) !== undefined) {
    // 前缀匹配而不是按船精确匹配：切基地时同一块磁贴会被原地改命令复用，
    // 精确匹配会把旧船的磁贴判成「缺失」而重复开窗。
    return value.startsWith('SHPI ');
  }
  if (key === 'flt') {
    return value === 'XIT FLT';
  }
  if (key === 'burn') {
    // 旧版本这一槽是 XIT PROD，屏幕布局里保存下来的停靠磁贴仍是 PROD 命令。
    // 一并当成候选，认领后 syncCommand() 会原地把它改成 XIT BURN，
    // 这样刷新后既不会留下孤儿磁贴，也不用重开一个窗口（无闪烁）。
    return value.startsWith('XIT BURN ') || value.startsWith('XIT PROD ');
  }
  return value.startsWith(key === 'bs' ? 'BS ' : 'INV ');
}

// ── 严格认领 ──────────────────────────────────────────────────
// 早期版本按命令前缀全局扫描，把用户自己开的 BS/INV 缓存窗口当成「多余磁贴」
// 藏掉，导致「新缓存窗口闪一下就消失」。现在只认领三类节点：
//   1. 已经搬进 FB 槽位的磁贴；
//   2. 与 FB 磁贴同属一个 MainState__tiles 的停靠磁贴（本屏幕自己的布局）；
//   3. 由本组件 showBuffer 开出来的窗口（记在 ourWindows 里）。
// 任何其它浮动窗口（用户手动开的缓存窗口）一律不碰。
const owned = new Map<SlotKey, HTMLElement>();
const ourWindows = new Set<HTMLElement>();

// 切换游戏内标签时 FB 组件会被 React 卸载并重新挂载，实例内的 Set/Map 全部清零。
// 归属信息写在 DOM 上才能跨实例存活：切回时立刻认领上一个实例留下的窗口，
// 不再重开、也不再把它们复活成盖在面板上的「空白块」。
// 只有本组件 showBuffer / adopt 开过的节点才会被打标记，用户手动开的窗口绝不会被误认。
const OWN_ATTR = 'data-rp-fb-owned';

function fbScreenRoot() {
  const frame = tile.frame as HTMLElement | undefined;
  return (frame?.closest('[class*="MainState__tiles"]') as HTMLElement | null) ?? null;
}

function collectTiles(key: SlotKey): HTMLElement[] {
  const root = fbScreenRoot();
  const found: HTMLElement[] = [];
  // 浮动缓存窗口不在 MainState__tiles 里（挂在 Frame__container 下），所以必须全文档
  // 扫描，再用上面三条归属规则过滤；只查 root 会导致自己刚开的窗口永远认领不到，
  // 进而每轮巡检都补开一个，几秒钟内堆出十几个窗口。
  const frames = document.getElementsByClassName(C.TileFrame.frame);
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i] as HTMLElement;
    const command = (_$(frame, C.TileFrame.cmd)?.textContent ?? '').trim();
    if (!matchesSlot(key, command)) {
      continue;
    }
    const element = frame.parentElement as HTMLElement | null;
    if (!element?.isConnected) {
      continue;
    }
    // 子槽按 data-fb-slot 严格归属：已经搬进某个槽的磁贴只属于那个槽。
    // 多个 XIT FB 面板并存时，还要确认这个槽属于本实例，否则浮动窗口会把
    // 标签页面板（或另一个浮动窗口）的磁贴搬走。
    const slotOwner = element.closest('[data-fb-slot]');
    if (slotOwner) {
      if (
        slotOwner.getAttribute('data-fb-slot') === key &&
        rootElement.value?.contains(slotOwner)
      ) {
        found.push(element);
      }
      continue;
    }
    const shell = element.closest('[class*="Window__window"]') as HTMLElement | null;
    if (shell) {
      // 标记是 DOM 级的，跨 FB 组件实例仍然有效；scope 保证各面板只认领自己
      // 开出来的窗口。没有 scope 的是插件重载前的旧窗口，只交给主屏标签那一份。
      const scope = shell.getAttribute(SCOPE_ATTR);
      const sameScope = scope !== null && scope === fbScope();
      const legacy = scope === null && !isFloating.value && shell.hasAttribute(OWN_ATTR);
      if (ourWindows.has(shell) || sameScope || legacy) {
        found.push(element);
      }
      continue;
    }
    if (root?.contains(element)) {
      found.push(element);
    }
  }
  return found;
}

// ── 搬迁 ──────────────────────────────────────────────────────
interface Moved {
  element: HTMLElement;
  parent: Node | null;
  next: Node | null;
  styleAttr: string | null;
}

const moved = new Map<SlotKey, Moved>();
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const hiddenShells = new Set<HTMLElement>();
const touchedStyles: { element: HTMLElement; attr: string | null }[] = [];

// ── 底栏 dock 项 ──────────────────────────────────────────────
// FB 自己 showBuffer 开出来的窗口会在底栏留下一个数字按钮。用户要的是底栏只有
// 「一键关闭 / 新建缓存窗口」，所以只隐藏本组件窗口对应的 dock 项；用户手动开的
// 缓存窗口必须照常显示。另外标题为 NaN / undefined 的是没有 id 的坏窗口记录
// （点开只会得到空白块），一并隐藏。
const dockIds = new Map<string, HTMLElement>();
const dockStyles = new Map<HTMLElement, string | null>();

function normalizeDockId(text: string) {
  return /^\d+$/.test(text) ? String(Number(text)) : text;
}

function setDockHidden(element: HTMLElement, hidden: boolean) {
  if (hidden) {
    if (!dockStyles.has(element)) {
      dockStyles.set(element, element.getAttribute('style'));
    }
    element.style.setProperty('display', 'none', 'important');
    return;
  }
  if (!dockStyles.has(element)) {
    return;
  }
  const attr = dockStyles.get(element);
  if (attr == null) {
    element.removeAttribute('style');
  } else {
    element.setAttribute('style', attr);
  }
  dockStyles.delete(element);
}

function syncDockItems() {
  const ours = new Set<string>();
  for (const [id, shell] of dockIds) {
    if (shell.isConnected) {
      ours.add(normalizeDockId(id));
    }
  }
  // 组件重新挂载后 dockIds 是空的，直接从带标记的窗口 DOM 恢复编号。
  for (const element of document.querySelectorAll(`[${OWN_ATTR}]`)) {
    if (!element.matches('[class*="Window__window"]')) {
      continue;
    }
    const scope = element.getAttribute(SCOPE_ATTR);
    if (scope !== null && scope !== fbScope()) {
      continue;
    }
    const windowTile = _$(element as HTMLElement, C.Tile.tile) as HTMLElement | undefined;
    const id = windowTile ? getPrunId(windowTile) : undefined;
    if (id) {
      ours.add(normalizeDockId(id));
    }
  }
  const items = document.getElementsByClassName(C.Dock.buffer);
  const seen = new Set<HTMLElement>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as HTMLElement;
    seen.add(item);
    const title = (_$(item, C.Dock.title)?.textContent ?? '').trim();
    const broken = title === 'NaN' || title === 'undefined';
    setDockHidden(item, broken || (title !== '' && ours.has(normalizeDockId(title))));
  }
  // React 重建 dock 节点后，把旧节点从记录里清掉，避免样式残留。
  for (const element of Array.from(dockStyles.keys())) {
    if (!seen.has(element)) {
      setDockHidden(element, false);
    }
  }
}

const FILL_STYLES: [string, string][] = [
  ['position', 'relative'],
  ['left', 'auto'],
  ['top', 'auto'],
  ['right', 'auto'],
  ['bottom', 'auto'],
  ['width', '100%'],
  ['height', '100%'],
  ['min-height', '0'],
];

// 主 INV 槽：游戏 ScrollView__view 的 -15px 负 margin（紧凑模式已清零）让内容
// 区始终比磁贴底边低约 16px，而 Tile__tile 自带 overflow:hidden，最后一行物料
// 因此被磁贴裁掉——槽位再留白也救不了，因为裁切发生在磁贴上，不在槽位上。
// 槽位用等量 padding-bottom 腾出这 16px 可视范围，磁贴高度再补回 16px，
// 内容才真正落在磁贴内。两处必须保持同值，见 .slot.mainInvSlot 的样式注释。
const INV_TILE_EXTRA_PX = 16;

function rememberStyle(element: HTMLElement) {
  if (!touchedStyles.some(x => x.element === element)) {
    touchedStyles.push({ element, attr: element.getAttribute('style') });
  }
}

function adopt(key: SlotKey, element: HTMLElement) {
  const host = hostOf(key);
  if (!host) {
    return;
  }
  if (element.parentElement !== host) {
    const previous = moved.get(key);
    if (previous && previous.element !== element) {
      restoreOne(previous);
      moved.delete(key);
    }
    const shell = element.parentElement?.closest('[class*="Window__window"]') as HTMLElement | null;
    const shellScope = shell?.getAttribute(SCOPE_ATTR) ?? null;
    const shellIsOurs =
      !!shell &&
      (ourWindows.has(shell) ||
        (shellScope !== null && shellScope === fbScope()) ||
        (shellScope === null && !isFloating.value && shell.hasAttribute(OWN_ATTR)));
    if (shell && shellIsOurs) {
      shell.setAttribute(OWN_ATTR, key);
      shell.setAttribute(SCOPE_ATTR, fbScope());
      ourWindows.add(shell);
    }
    const record: Moved = {
      element,
      parent: element.parentElement,
      next: element.nextSibling,
      styleAttr: element.getAttribute('style'),
    };
    // 标记磁贴本身：切标签后组件重建，靠它把同一个原生磁贴重新认领回来。
    element.setAttribute(OWN_ATTR, key);
    for (const [property, value] of FILL_STYLES) {
      element.style.setProperty(property, value, 'important');
    }
    try {
      host.appendChild(element);
    } catch {
      return;
    }
    moved.set(key, record);
    // 只隐藏我们自己开出来的窗口，用户窗口绝不碰。
    if (shell && shellIsOurs && shell.isConnected) {
      rememberStyle(shell);
      shell.style.setProperty('display', 'none', 'important');
      hiddenShells.add(shell);
    }
  } else {
    element.style.removeProperty('display');
  }
  // 每次认领都校准高度：React 重建磁贴 inline style 后节点可能仍在同一槽位，
  // 只靠搬移分支里的 FILL_STYLES 会漏掉这种情况。
  element.style.setProperty(
    'height',
    key === 'inv' ? `calc(100% + ${INV_TILE_EXTRA_PX}px)` : '100%',
    'important',
  );
  // 槽位里只留一块可见：改命令后游戏可能生成新节点，两块叠一起会变成白块。
  for (const child of Array.from(host.children)) {
    if (child !== element) {
      (child as HTMLElement).style.setProperty('display', 'none', 'important');
    }
  }
}

function restoreOne(record: Moved) {
  if (record.styleAttr === null) {
    record.element.removeAttribute('style');
  } else {
    record.element.setAttribute('style', record.styleAttr);
  }
  const parent = record.parent as HTMLElement | null;
  if (parent?.isConnected) {
    const next = record.next && parent.contains(record.next) ? record.next : null;
    parent.insertBefore(record.element, next);
  }
}

// ── 隐藏 FB 磁贴自带的标题条与窗口按钮 ────────────────────────
let hiddenHeader: HTMLElement | undefined;
let hiddenControls: HTMLElement | undefined;

function hideTileChrome() {
  const header = _$(tile.frame, C.TileFrame.header) as HTMLElement | undefined;
  if (header && header.style.display !== 'none') {
    header.style.setProperty('display', 'none', 'important');
    hiddenHeader = header;
  }
  const controls = _$(tile.frame, C.TileFrame.controls) as HTMLElement | undefined;
  if (controls && controls.style.display !== 'none') {
    controls.style.setProperty('display', 'none', 'important');
    hiddenControls = controls;
  }
}

// ── 让 FB 自己铺满整页 ────────────────────────────────────────
// 停靠布局是一棵 Node 树：把 FB 祖先链上的兄弟节点藏掉、让这条链 flex 撑开，
// FB 就占满整个标签页。所有改动都记了原始 style，退出时还原。
const LAYOUT_ROOTS = ['MainState__tiles', 'Node__child'];

function expandSelf() {
  const tileElement = tile.frame?.parentElement as HTMLElement | null;
  const leaf = tileElement?.parentElement;
  if (!tileElement || !leaf || !LAYOUT_ROOTS.some(x => leaf.className.includes(x))) {
    return;
  }
  const chain: HTMLElement[] = [];
  let node: HTMLElement | null = leaf;
  for (let i = 0; i < 4 && node; i++) {
    if (node.className.includes('MainState__tiles')) {
      break;
    }
    chain.push(node);
    node = node.parentElement;
  }
  for (const element of chain) {
    const parent = element.parentElement;
    if (!parent) {
      continue;
    }
    rememberStyle(element);
    const siblings = Array.from(parent.children) as HTMLElement[];
    for (const sibling of siblings) {
      if (sibling === element || sibling.className.includes('TileDivider')) {
        continue;
      }
      rememberStyle(sibling);
      sibling.style.setProperty('display', 'none', 'important');
    }
    element.style.setProperty('flex', '1 1 auto', 'important');
    element.style.setProperty('width', 'auto', 'important');
    element.style.setProperty('max-width', 'none', 'important');
  }
}

function commandTextOf(element: HTMLElement) {
  const frame = element.querySelector(`.${C.TileFrame.frame}`);
  return frame ? (_$(frame as HTMLElement, C.TileFrame.cmd)?.textContent ?? '').trim() : '';
}

// ── 补齐缺失的磁贴 ────────────────────────────────────────────
// showBuffer 在创建过程中会给窗口加 hidden class，返回前的最后一个动作才移除。
// 我们的 await 续体是同一个微任务链，紧接着把它设成 display:none，浏览器还没
// 来得及绘制，所以不会出现「闪一下」。
const opening = new Set<SlotKey>();
const openAttempts = new Map<string, number>();
const OPEN_ATTEMPT_LIMIT = 2;

async function openMissing(key: SlotKey) {
  if (opening.has(key)) {
    return;
  }
  // 多个舰船子槽会同时判缺失；并发 showBuffer 容易互相踩，改成一次只开一个，
  // 成功后 scheduleTick() 会在下一帧继续补下一艘船的窗口。
  if (shipSlotIndex(key) !== undefined && opening.size > 0) {
    return;
  }
  const command = commandOf(key, selectedNaturalId.value);
  if (!command) {
    return;
  }
  const attempts = openAttempts.get(command) ?? 0;
  if (attempts >= OPEN_ATTEMPT_LIMIT) {
    return;
  }
  opening.add(key);
  openAttempts.set(command, attempts + 1);
  try {
    // priority：整页刷新时游戏会为每个基地排队预取 BS 数据，FB 自己的窗口
    // 不能排在那一串后面，否则 BS 槽位空好几秒（切标签不受影响，因为窗口还在）。
    const window = await showBuffer(command, { force: true, priority: true });
    if (!(window instanceof HTMLElement)) {
      return;
    }
    ourWindows.add(window);
    window.setAttribute(OWN_ATTR, key);
    window.setAttribute(SCOPE_ATTR, fbScope());
    // 记录窗口编号，用于同步隐藏它在底栏留下的 dock 按钮。
    const windowTile = _$(window, C.Tile.tile) as HTMLElement | undefined;
    const windowId = windowTile ? getPrunId(windowTile) : undefined;
    if (windowId) {
      dockIds.set(windowId, window);
    }
    rememberStyle(window);
    window.style.setProperty('display', 'none', 'important');
    hiddenShells.add(window);
    const frame = _$(window, C.TileFrame.frame) as HTMLElement | undefined;
    const element = frame?.parentElement as HTMLElement | undefined;
    if (element?.isConnected) {
      element.setAttribute(OWN_ATTR, key);
      owned.set(key, element);
    }
    scheduleTick();
    // dock 项由 React 异步挂载，补一次短延时，避免底栏的按钮闪一下。
    setTimeout(syncDockItems, 100);
  } catch {
    // 开窗失败就下一轮再试，不打断看板。
  } finally {
    opening.delete(key);
  }
}

// ── 原地改命令 ────────────────────────────────────────────────
// 已实测：停靠 UUID 磁贴与本地数字 id 磁贴都吃 UI_TILES_CHANGE_COMMAND，
// 内容是原地重渲染、不新开窗口。所以点基地时只要改命令即可，不需要
// showBuffer 再开一个 BS 窗口（那正是「全部窗口闪一下」的来源）。
const lastCommandAttempt = new Map<string, number>();

function syncCommand(key: SlotKey, element: HTMLElement) {
  const wanted = commandOf(key, selectedNaturalId.value);
  if (!wanted) {
    return;
  }
  if (commandTextOf(element).toUpperCase() === wanted.toUpperCase()) {
    return;
  }
  const id = getPrunId(element);
  if (!id) {
    return;
  }
  const key2 = `${id}|${wanted}`;
  const now = Date.now();
  const last = lastCommandAttempt.get(key2) ?? 0;
  if (now - last < 1000) {
    return;
  }
  lastCommandAttempt.set(key2, now);
  dispatchClientPrunMessage(UI_TILES_CHANGE_COMMAND(id, wanted));
}

const missingSince = new Map<SlotKey, number>();
// 组件刚挂载的头 1.2 秒里，缺失磁贴只等 150ms 就补开，避免切回标签时
// 槽位空着一大段时间。稳定之后仍用 1.5 秒宽限，防止命令栏改写瞬间误开窗口。
let startupUntil = 0;

// 每个 XIT FB 面板各自驱动自己的 tick。早期用「全文档第一个 layout」判主实例，
// 会让同时打开的第二个 XIT FB 窗口整块停摆（所有槽位永远全空）。
function tick() {
  if (!tile.frame?.isConnected || !rootElement.value?.isConnected) {
    return;
  }
  // 铺满整屏、隐藏白条、接管停靠布局只对游戏内标签页有意义；浮动缓存窗口
  // 必须保留自己的标题栏和关闭按钮，否则窗口关不掉。
  if (!isFloating.value) {
    expandSelf();
    hideTileChrome();
  }
  syncDockItems();
  const now = Date.now();
  const claimed = new Set<HTMLElement>();
  for (const key of SLOT_KEYS) {
    const index = shipSlotIndex(key);
    if (index !== undefined && index >= shipEntries.value.length) {
      // 该子槽当前没有对应的船：由模板收起，不补开窗。已认领的磁贴留在槽里，
      // 下次船数变多时原地复用，不重开窗口。
      missingSince.delete(key);
      continue;
    }
    // 每块原生磁贴只能归一个槽，否则多个子槽会把同一块搬来搬去。
    const candidates = collectTiles(key).filter(element => !claimed.has(element));
    if (candidates.length === 0) {
      // 命令栏改写的瞬间会读空，连续缺失一段时间才算真的没开窗。
      const since = missingSince.get(key) ?? now;
      missingSince.set(key, since);
      if (now - since > (now < startupUntil ? 150 : 1500)) {
        void openMissing(key);
      }
      continue;
    }
    missingSince.delete(key);

    // 优先沿用已认领的那块，其次服务器 UUID 磁贴，最后才按命令精确匹配。
    const previous = owned.get(key);
    const wanted = commandOf(key, selectedNaturalId.value)?.toUpperCase();
    const rank = (element: HTMLElement) => {
      const exact = wanted !== undefined && commandTextOf(element).toUpperCase() === wanted;
      const serverTile = UUID_PATTERN.test(element.getAttribute('data-prun-id') ?? '');
      return (element === previous ? 8 : 0) + (serverTile ? 4 : 0) + (exact ? 2 : 0);
    };
    const chosen = [...candidates].sort((a, b) => rank(b) - rank(a))[0];
    owned.set(key, chosen);
    claimed.add(chosen);
    // 变量模式下子磁贴靠游戏的 $BS 自行更新，不需要我们改命令；唯一例外是
    // 旧版本留下的 XIT PROD 磁贴，必须主动改成 XIT BURN $BS 才会换成新组件。
    const currentCommand = commandTextOf(chosen).toUpperCase();
    const legacyProd = key === 'burn' && currentCommand.startsWith('XIT PROD ');
    if (!variableMode.value || legacyProd) {
      syncCommand(key, chosen);
    }
    adopt(key, chosen);
    // 五类磁贴的标题栏一律只留原先的中文文字；SHPI 例外保留船名全称
    // （含 S- 前缀），只隐去末尾应答编码。
    // 末尾命令文本由 refined-prun.css 的 display:none 隐藏（textContent 保留，
    // collectTiles 还要靠它认领磁贴）。
    applyChineseTitle(chosen);
    // 不再隐藏任何「多余」磁贴：其它停靠格已被 expandSelf 藏住，
    // 而用户自己开的浮动窗口必须原样留在屏幕上。
  }
}

let timer: ReturnType<typeof setInterval> | undefined;
let pending = false;

function scheduleTick() {
  if (pending) {
    return;
  }
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    tick();
  });
}

// 变量或舰船数据一变立刻改命令，不等 800ms 巡检，切换手感与游戏原生变量一致。
watch(selectedNaturalId, () => scheduleTick());
watch(shipEntryKey, () => {
  scheduleTick();
  // 第一次切到有船的基地时没有现成 SHPI 磁贴，直接开窗，别等 1.5 秒宽限，
  // 否则右下角会空一大段时间。之后靠 DOM 归属标记复用同一批磁贴。
  if (
    shipEntries.value.length > 0 &&
    !SHIP_SLOT_KEYS.some(key => owned.has(key)) &&
    !SHIP_SLOT_KEYS.some(key => opening.has(key))
  ) {
    void openMissing('ship0');
  }
});

onMounted(() => {
  const tileElement = tile.frame?.parentElement as HTMLElement | undefined;
  scopeId.value = tileElement ? (getPrunId(tileElement) ?? '') : '';
  isFloating.value = selfWindow() !== null;
  variableMode.value = hasVariableBar();
  if (variableMode.value && !screenVariables.BS && selectedNaturalId.value) {
    void writeScreenVariable('BS', selectedNaturalId.value);
  }
  startupUntil = Date.now() + 1200;
  // 首帧同步接管布局。游戏切换标签会卸载并重建 FB 组件，先跑一遍能避免
  // 浏览器先画出「窄磁贴里的错位 FLEET + 标题条 + 空槽位」再重组。
  tick();
  // 磁贴由游戏异步挂载，短延时补一次核对，再进入常规巡检。
  setTimeout(() => {
    tick();
    timer = setInterval(tick, 800);
  }, 160);
});

onUnmounted(() => {
  if (timer) {
    clearInterval(timer);
  }
  hiddenHeader?.style.removeProperty('display');
  hiddenHeader = undefined;
  hiddenControls?.style.removeProperty('display');
  hiddenControls = undefined;
  // 底栏：窗口在标签切换期间保持隐藏，dock 按钮也继续保持隐藏。
  // 新实例会从 DOM 标记恢复编号并重新同步，避免数字按钮闪一下。
  dockIds.clear();
  for (const record of moved.values()) {
    restoreOne(record);
  }
  moved.clear();
  // FB 自己开的窗口保持隐藏并由下一个实例凭 DOM 标记认领。若在这里恢复显示，
  // 切走/切回时就会有一块空白浮动窗口盖在面板上，而且每切一次多累积一个。
  hiddenShells.clear();
  for (const { element, attr } of touchedStyles) {
    if (element.hasAttribute(OWN_ATTR) && element.matches('[class*="Window__window"]')) {
      continue;
    }
    if (attr === null) {
      element.removeAttribute('style');
    } else {
      element.setAttribute('style', attr);
    }
  }
  touchedStyles.length = 0;
  // 浮动缓存窗口被关掉时，把它开出来的子窗口一并关掉，否则会留下一串隐藏
  // 空壳和 dock 记录。切游戏内标签不会卸载浮动窗口，所以只在确认本窗口
  // 已从 DOM 移除时执行；标签页那份照旧保留窗口供切回来复用。
  if (isFloating.value && fbScope()) {
    const scope = fbScope();
    requestAnimationFrame(() => {
      if (selfWindow()?.isConnected) {
        return;
      }
      for (const element of document.querySelectorAll(`[${SCOPE_ATTR}="${scope}"]`)) {
        if (element.matches('[class*="Window__window"]')) {
          closePrunWindow(element);
        }
      }
    });
  }
  ourWindows.clear();
});

// 供调试：控制台里看一下各个槽位抓到了什么。
defineExpose({ tileIds: () => Array.from(moved.keys()) });
</script>

<template>
  <!-- data-rp-fb-panel 是「XIT FB 面板」的稳定作用域标记：全局 CSS 里的
       INV 紧凑排列规则与「紧凑排列」按钮只在带此标记的元素内部生效，
       用户单独打开的 INV / SHPI 窗口保持游戏原版排列与图标大小。 -->
  <div ref="rootElement" :class="$style.layout" data-rp-fb-panel>
    <div :class="$style.fleet">
      <FLEET compact-ship />
    </div>
    <div :class="$style.middle">
      <div ref="bsHost" :class="$style.slot" data-fb-slot="bs" />
      <div ref="invHost" :class="[$style.slot, $style.mainInvSlot]" data-fb-slot="inv" />
      <div ref="burnHost" :class="$style.slot" data-fb-slot="burn" />
    </div>
    <div :class="$style.right">
      <div ref="fltHost" :class="[$style.slot, $style.fltSlot]" data-fb-slot="flt" />
      <div :class="$style.shipList">
        <div
          v-for="i in SHIP_SLOT_COUNT"
          :key="i"
          :ref="element => setShipHost(i - 1, element)"
          :data-fb-slot="`ship${i - 1}`"
          :class="[
            $style.slot,
            $style.shipSlot,
            shipEntries[i - 1]?.status === 'inbound' ? $style.statusInbound : $style.statusDocked,
            { [$style.slotHidden]: !shipEntries[i - 1] },
          ]" />
      </div>
    </div>
  </div>
</template>

<style module>
.layout {
  display: flex;
  gap: 2px;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  padding: 2px;
  background: #111111;
}

.fleet {
  display: flex;
  flex: 1.7 1 0;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.middle {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  min-height: 0;
}

.right {
  display: flex;
  flex: 0.85 1 0;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  min-height: 0;
}

.slot {
  display: flex;
  flex: 1 1 0;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  /* 槽位底色/描边只在自定义主题下存在：原样主题没有 --rp-skin-*，
     旧写法回退近白 #e8edf1，而 BS / BURN 内嵌磁贴自带 6px 外边距、
     比槽位窄 14px，浅底从四周露出来就是一圈白色宽边（INV / FLT 已
     清零外边距、铺满槽位，所以看不到）。改成 transparent 回退，
     并统一清零所有内嵌磁贴的外边距，让四类槽位严格铺满、边界一致。
     值里不写裸色字面量，避免被主题引擎的 CSSOM 扫描二次重映射。 */
  border: 1px solid var(--rp-skin-border-strong, transparent);
  border-radius: 3px;
  background-color: var(--rp-skin-panel, transparent);
  box-sizing: border-box;
}

/* 游戏原生 Tile__tile 有 6px 外边距：不清零的话 BS / BURN 比槽位窄 14px，
   槽位底色就会露成宽边。FLT / 主 INV 槽下面各有专属 margin:0 规则，
   这里统一兜住其余槽位；四条规则同值，不改变已有高度补偿逻辑。 */
.slot [class*='Tile__tile'] {
  margin: 0 !important;
}

/* FLT 最后一行被裁半截的根因（两层原生样式叠加，与滚动条无关）：
   1) Tile__tile 自带 6px 外边距，而 FILL_STYLES 又给它 height:100%，整块磁贴
      下移 6px、底部超出槽位；
   2) ScrollView__view 原生是 inset:0 + margin-right/-bottom:-15px（用来藏原生
      滚动条）。绝对定位下负 margin-bottom 会把 view 高度额外撑高 15px。
   合计约 21px 内容永远落在 .slot 的 overflow:hidden 之外，滚到底也看不到完整
   末行。这里只校正 FLT 槽：外边距归零、负 margin 归零，滚动条交给上面的细条
   规则显示，内容区与槽位严格等高。其它槽（INV/SHPI 图标布局）保持原样。 */
.slot.fltSlot [class*='Tile__tile'] {
  margin: 0 !important;
}

/* INV 主槽刷新后首次加载，最下方一行物料会被窗格裁掉约 12px（切换基地
   重建磁贴后才完整）。根因是游戏 ScrollView__view 的 -15px 负 margin 让内容
   区比磁贴底边低约 16px，而 Tile__tile 自己 overflow:hidden——裁切发生在
   磁贴上，槽位留白救不了。这里给槽位 padding-bottom 腾出 16px 可视范围，
   再由 adopt() 把 INV 磁贴的 inline height 设成 calc(100% + 16px)，
   让磁贴底边追上内容底边，末行才真正落在磁贴内且无需滚动。
   两个 16px 必须同值；只作用于 FB 面板的主 INV 槽，独立 INV 窗口不受影响。 */
.slot.mainInvSlot {
  padding-bottom: 16px;
  box-sizing: border-box;
}

.slot.mainInvSlot [class*='Tile__tile'] {
  margin: 0 !important;
}

.slot.fltSlot [class*='ScrollView__view'] {
  margin-right: 0 !important;
  margin-bottom: 0 !important;
  padding-right: 0 !important;
}

/* FLT 要能一眼看全舰船列表（当前 17 艘约需 600px），舰船货舱只填它下方
   剩下的空位；均分会逼 FLT 出现滚动条。船数不同的账号可改这两个比例。
   写在 .slot 之后并叠加类名，避免被 .slot 的 flex:1 覆盖。 */
.slot.fltSlot {
  flex: 2.5 1 0;
}

/* 舰船货舱列表：一艘船一个子槽，超出高度就在列内滚动（沿用游戏内细滚动条） */
.shipList {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}

/* 只有一艘船时撑满剩余高度；多艘时每块至少 150px，总高超出即滚动 */
.slot.shipSlot {
  flex: 1 0 150px;
  min-height: 150px;
}

/* 磁贴尚未搬进来的那几帧不要把空槽位画成白块；appendChild 后 :empty 自动失效 */
.slot:empty {
  visibility: hidden;
}

/* 该子槽没有对应的船时收起，也不会留下上一艘船的货舱 */
.slotHidden {
  display: none;
}

/* 舰船货舱表头：最前端加状态徽标。用 CSS 伪元素而不是往 DOM 插节点，
   游戏 React 重渲染原生磁贴标题栏时不会被冲掉。在途=橙，停靠=绿。 */
.shipSlot [class*='TileFrame__header'] {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  column-gap: 6px;
  overflow: hidden;
  /* 徽标/船名/命令三者统一行盒高度，中文字面才落在同一条垂直中心线上。
     只靠 align-items:center 对齐盒子是不够的：原生 cmd 行高只有 8px，
     小字的字面重心会明显偏上，看起来就像「没上下居中」。 */
  line-height: 16px;
}

/* 表头压成一行：徽标 + 船名 + 命令文字。命令文字不能再另起一行，
   否则它正好落在徽标正下方、两行挤在一起互相干涉。船名过长时省略，
   命令文字保持完整不换行。 */
.shipSlot [class*='TileFrame__title'],
.shipSlot [class*='TileFrame__cmd'] {
  line-height: 16px;
}

.shipSlot [class*='TileFrame__title'] {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shipSlot [class*='TileFrame__cmd'] {
  flex: 0 0 auto;
  white-space: nowrap;
}

.shipSlot [class*='TileFrame__header']::before {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  /* 与船名/命令同为 16px 行盒，文字用 flex 严格居中，不受字体 ascent 影响 */
  height: 16px;
  box-sizing: border-box;
  padding: 0 5px;
  border: 1px solid currentColor;
  border-radius: 2px;
  font-size: 11px;
  font-weight: bold;
  line-height: 1;
}

.statusInbound [class*='TileFrame__header']::before {
  content: '在途';
  color: #ffa53a;
}

.statusDocked [class*='TileFrame__header']::before {
  content: '停靠';
  color: #6bd07f;
}

/* 内嵌磁贴（BS/INV/BURN/FLT/SHPI）右上角的窗口按钮一并隐藏 */
.layout [class*='TileFrame__controls'] {
  display: none !important;
}

/* 内嵌 INV / SHPI 的图标尺寸不再由 FB 单独缩小：默认必须保持游戏原版 48px。
   紧凑模式下的 32px 图标、42px 格子和竖排分组，统一由 refined-prun.css 中带
   html[data-rp-inv-compact='on'] [data-rp-fb-panel] 双前缀的全局规则提供；
   紧凑排列及其按钮只作用于 XIT FB 面板内部，独立 INV / SHPI 窗口始终是原版。 */

/* ── 主 INV 槽布局 ──────────────────────────────────────────────────
   .slot.mainInvSlot 是 FB 组件自己的局部类，本就只存在于 XIT FB 面板内，
   再显式加 [data-rp-fb-panel] 前缀与 refined-prun.css 的作用域保持一致。
   下面这条高度分配只在紧凑模式下生效：紧凑后内容只需约 160px，按三槽均分
   （292px）会在下方留一大片空白，收掉约 40px 让给 BS / BURN。
   默认（原版排列）保持三槽均分不动。 */
html[data-rp-inv-compact='on'] [data-rp-fb-panel] .slot.mainInvSlot {
  flex: 0.8 1 0;
}

/* 主题注入的 html[data-rp-theme] * { scrollbar-color: ... } 会让 Chromium
   改用标准滚动条（thin ≈ 10px）并忽略 ::-webkit-scrollbar；FB 内嵌磁贴
   的 overflow:scroll 于是画出整条 10px 轨道，看起来比游戏原版粗很多。
   这里把标准属性清回默认（!important 压过主题），让下面 4px 细条生效。 */
.layout * {
  scrollbar-width: auto !important;
  scrollbar-color: auto !important;
}

.layout *::-webkit-scrollbar {
  width: 4px;
  height: 4px;
  background: transparent;
}

.layout *::-webkit-scrollbar-track {
  background: transparent;
}

.layout *::-webkit-scrollbar-thumb {
  background-color: var(--rp-skin-scroll-thumb, #b6c1cb) !important;
  border: 0 !important;
  border-radius: 3px;
}
</style>
