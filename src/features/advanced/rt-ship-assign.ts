import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import onNodeDisconnected from '@src/utils/on-node-disconnected';

// RT 航线界面（如 RT RT-UJEN-4862）的展示增强，只改 DOM 展示层（class / order / CSS grid），
// 不触碰游戏数据、航线计算或按钮的原始行为：
// 1) 把「船只分配」整块（标题 + 船表）移到「航线」（路径点详情）上方；
// 2) 船表按三栏列示，每栏各自带「名称 / 航线 / 指令」表头；栏数与每栏行数随船数自动收敛
//    （船少时退化为 2 栏、1 栏，不留空栏）；
// 3) 「船只分配」标题旁提供开关：只显示「空闲（航线列为 --）且停靠地点 = 路径点1」
//    的起点待命船只——这类船未被任何航线占用、正停在当前航线起点，可直接分配；
//    开关状态写入 localStorage，刷新或重开界面后保持，直到用户手动取消；
// 4) 未开筛选时，不在起点的船只其「分配」按钮置灰禁用，避免误点；
//    游戏本身不渲染按钮的单路径点航线保持完全空白，不补任何占位内容。

const SHIP_HEADER = 'rp-rt-ship-header';
const SHIP_TABLE = 'rp-rt-ship-table';
const ROUTE_HEADER = 'rp-rt-route-header';
const WAYPOINTS = 'rp-rt-waypoints';
const CONTENT = 'rp-rt-content';
const MATCH_ROW = 'rp-rt-match';
const OTHER_ROW = 'rp-rt-other';
const TOGGLE = 'rp-rt-toggle';
const TOGGLE_CHK = 'rp-rt-toggle-chk';
const MATCH_ONLY = 'rp-rt-match-only';
const COLHEAD = 'rp-rt-colhead';
const DISABLED_BTN = 'rp-rt-disabled-btn';

// 开关状态的持久化键：刷新页面后仍保持上次的选择，直到用户主动取消。
const STORAGE_KEY = 'rp-rt-match-only';

// 会话内偏好内存态，作为 localStorage 的权威来源与兜底：
// - 首次 readMatchOnly 时从 localStorage 初始化一次；
// - 勾选时 writeMatchOnly 同时更新内存态并尝试落盘。
// 这样即使存储写入失败（隐私模式/配额满），markTile 重绘时重读到的仍是用户本次
// 选择，不会用旧值把刚勾上的筛选反转回去。undefined 表示尚未初始化。
let matchOnlyPreference: boolean | undefined;

// 已挂载 RT 磁贴的重绘入口（各自的帧级 schedule）。筛选偏好是模块级共享的，
// 在 A 磁贴改开关后，B 磁贴必须立刻跟着变——否则它会保留相反的勾选/筛选，直到
// 下一次无关的 DOM 或船位置更新才突然增减船行，看起来像船表自己乱跳。
const mountedTiles = new Set<() => void>();

function refreshAllTiles() {
  for (const refresh of mountedTiles) {
    refresh();
  }
}

// 船表分栏数。
const COLUMNS = 3;

function readMatchOnly(): boolean {
  if (matchOnlyPreference === undefined) {
    try {
      matchOnlyPreference = window.localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
      matchOnlyPreference = false;
    }
  }
  return matchOnlyPreference;
}

function writeMatchOnly(value: boolean) {
  // 先更新内存态：即使落盘失败，本次会话的筛选状态也保持不变。
  matchOnlyPreference = value;
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // 隐私模式等无法写入时静默失败，内存态已更新，本次会话仍按用户选择显示。
  }
}

// React 渲染时透传给组件的 props 的最小形状（只声明用得到的字段，不用 any）。
type PropsLike = {
  waypoint?: { destination?: PrunApi.Address };
  destination?: PrunApi.Address;
};

// React fiber 的最小形状：兜底路径要沿 return 链向上找，并能取到 alternate。
type FiberLike = {
  memoizedProps?: PropsLike;
  alternate?: FiberLike | null;
  return?: FiberLike | null;
};

function pickAddress(props: PropsLike | undefined): PrunApi.Address | undefined {
  const candidate = props?.waypoint?.destination ?? props?.destination;
  if (candidate === undefined || !Array.isArray(candidate.lines)) {
    return undefined;
  }
  return candidate;
}

// 这条 address 的某个名字是否出现在屏幕上渲染的文本里（「Hortus Station (Hortus)」）。
// 用来在 current / alternate 两个 fiber 给出不同目的地时，判断哪个才是当前渲染结果。
function addressMatchesText(address: PrunApi.Address, text: string): boolean {
  const names = address.lines
    .map(line => line.entity?.name)
    .filter((name): name is string => name !== undefined && name.length > 0);
  return names.some(name => text.includes(name));
}

// 从一层 fiber 里取 destination。React 复用路径点节点时，DOM 上记的 __reactFiber$
// 可能仍指向挂载时的 fiber，最新 props 落在它的 alternate 上——只看一方会在路径点被
// 原地修改后一直返回旧目的地（起点的船继续被藏/置灰）。两边都有且不一致时，以屏幕上
// 实际渲染出的名字为准。
function chooseAddress(fiber: FiberLike, text: string): PrunApi.Address | undefined {
  const own = pickAddress(fiber.memoizedProps);
  const alt = pickAddress(fiber.alternate?.memoizedProps);
  if (own === undefined) {
    return alt;
  }
  if (alt === undefined || alt === own) {
    return own;
  }
  if (addressMatchesText(own, text)) {
    return own;
  }
  if (addressMatchesText(alt, text)) {
    return alt;
  }
  return alt;
}

// 挖出第一个 waypoint 的 destination（结构化 address）。
// RT 界面把目的地渲染成「Hortus Station (Hortus)」文本，但 naturalId（HRT）只存在于
// address 上，所以必须从 React fiber 里取。
function findFirstWaypointAddress(waypoints: HTMLElement): PrunApi.Address | undefined {
  const destEl = waypoints.querySelector('[class*="Waypoint__destination"]');
  if (!destEl) {
    return undefined;
  }
  const fiberKey = Object.keys(destEl).find(k => k.startsWith('__reactFiber$'));
  if (fiberKey === undefined) {
    return undefined;
  }
  // 空白折叠后再比对，避免换行/多空格导致名字匹配失败。
  const text = (destEl.textContent ?? '').replaceAll(/\s+/g, ' ');
  let fiber = (destEl as unknown as Record<string, FiberLike | undefined>)[fiberKey];
  for (let i = 0; i < 12; i++) {
    if (fiber === undefined || fiber === null) {
      break;
    }
    const found = chooseAddress(fiber, text);
    if (found !== undefined) {
      return found;
    }
    fiber = fiber.return ?? undefined;
  }
  return undefined;
}

// 每栏表头行：克隆原 thead 那一行，分别插到每栏顶部。
// visible 按「当前可见的数据行」传入（勾选过滤时只算匹配行），否则被 display:none
// 隐藏的行不占网格位置，第 2/3 栏表头会掉到左栏下方。
// 用「结构比对」判断是否已正确，避免每次重绘都删建（否则触发 MutationObserver 循环）。
function syncColumnHeaders(
  table: HTMLTableElement,
  visible: HTMLTableRowElement[],
  perColumn: number,
) {
  const tbody = table.querySelector('tbody');
  const theadRow = table.querySelector<HTMLTableRowElement>('thead tr');
  if (!tbody || !theadRow) {
    return;
  }
  const isHead = (el: Element) => el.classList.contains(COLHEAD);
  const heads = Array.from(tbody.children).filter(isHead);
  // 过滤后一个可见行都没有：这里必须把之前克隆的栏表头删掉再返回。
  // 否则 layoutShipTable 已把网格重置成 1 栏 2 行，而残留的 1~2 份克隆表头
  // 还留在 tbody 里，界面上就是重复表头，多出来的那份还会撑出一列。
  if (visible.length === 0) {
    heads.forEach(h => h.remove());
    return;
  }
  // 实际分出的栏数：每栏 perColumn 行时能铺满几栏。
  const columnCount = Math.max(1, Math.min(COLUMNS, Math.ceil(visible.length / perColumn)));
  const anchors: (HTMLTableRowElement | undefined)[] = [];
  for (let i = 0; i < columnCount; i++) {
    anchors.push(i === 0 ? undefined : visible[i * perColumn]);
  }
  const ok =
    heads.length === columnCount &&
    heads[0] === tbody.firstElementChild &&
    anchors.every((anchor, i) => {
      if (i === 0) {
        return true;
      }
      return !!anchor && heads[i]?.nextElementSibling === anchor;
    });
  if (ok) {
    return;
  }
  heads.forEach(h => h.remove());
  const makeHead = () => {
    const head = theadRow.cloneNode(true) as HTMLTableRowElement;
    head.classList.add(COLHEAD);
    return head;
  };
  // 从最后一栏往前插，各自插在该栏首行之前，互不影响。
  for (let i = columnCount - 1; i >= 1; i--) {
    const anchor = anchors[i];
    if (anchor) {
      tbody.insertBefore(makeHead(), anchor);
    }
  }
  tbody.insertBefore(makeHead(), tbody.firstChild);
}

// 按当前筛选状态重算栏数与每栏行数，并摆放各栏表头。
function layoutShipTable(table: HTMLTableElement, rows: HTMLTableRowElement[]) {
  const frame = table.closest<HTMLElement>('[data-rp-rt-ship]');
  const matchOnly = frame?.classList.contains(MATCH_ONLY) ?? false;
  const visible = matchOnly ? rows.filter(tr => tr.classList.contains(MATCH_ROW)) : rows;
  const perColumn = Math.max(1, Math.ceil(visible.length / COLUMNS));
  const columnCount = Math.max(1, Math.min(COLUMNS, Math.ceil(visible.length / perColumn)));
  table.style.setProperty('--rp-rt-rows', String(perColumn + 1));
  table.style.setProperty('--rp-rt-cols', String(columnCount));
  syncColumnHeaders(table, visible, perColumn);
}

function markTile(tile: PrunTile) {
  markTileInner(tile);
}

function markTileInner(tile: PrunTile) {
  const anchor = tile.anchor;
  const frame = tile.frame;
  const headers = Array.from(
    anchor.querySelectorAll<HTMLElement>('[class*="SectionHeader__container"]'),
  );
  // 开关会插进「船只分配」这个标题里，textContent 从此变成「船只分配仅显示起点待命船只」，
  // 若仍用严格等号查找，React 一旦复用该节点，后续每次 markTile 都会在开头 return，
  // 行分类/按钮置灰/表头重排就全部停在旧状态。优先取已打标记的那个，否则用前缀匹配。
  const shipHeader =
    anchor.querySelector<HTMLElement>(`.${SHIP_HEADER}`) ??
    headers.find(h => h.textContent?.trim().startsWith('船只分配'));
  const routeHeader =
    anchor.querySelector<HTMLElement>(`.${ROUTE_HEADER}`) ??
    headers.find(h => h.textContent?.trim() === '航线');
  const table = anchor.querySelector<HTMLTableElement>('table');
  const waypoints = anchor.querySelector<HTMLElement>('[class*="Waypoints__container"]');
  if (!shipHeader || !routeHeader || !table || !waypoints) {
    return;
  }

  frame.setAttribute('data-rp-rt-ship', '');

  // 给需要重排的区块打标记（内容容器 = 各 SectionHeader 的共同父元素）。
  const content = shipHeader.parentElement;
  content?.classList.add(CONTENT);
  shipHeader.classList.add(SHIP_HEADER);
  table.parentElement?.classList.add(SHIP_TABLE);
  routeHeader.classList.add(ROUTE_HEADER);
  waypoints.classList.add(WAYPOINTS);

  // 路径点1的地点 naturalId（如 HRT）。
  const wp1Address = findFirstWaypointAddress(waypoints);
  const wp1NaturalId = getEntityNaturalIdFromAddress(wp1Address);

  // 匹配条件：航线列为 "--"（空闲、未分配航线）且船停靠地点 = 路径点1。
  const allShips = shipsStore.all.value ?? [];
  const rows = table.querySelectorAll<HTMLTableRowElement>(`tbody tr:not(.${COLHEAD})`);
  rows.forEach(tr => {
    const cells = tr.querySelectorAll('td');
    const route = cells[1]?.textContent?.trim() ?? '';
    const name = cells[0]?.textContent?.trim() ?? '';
    // 表格只渲染船名，不暴露 registration/船 id（fiber 上也拿不到 ship 对象）。
    // 而 shipsStore.getByName 是按「大写船名」建索引的：同名或仅大小写不同的船会并成
    // 同一个键，直接查会把 A 船的位置套到 B 船上 —— 可用的被置灰、远处的被当成待命。
    // 所以只有名字唯一时才判定；重名无法区分，宁可不动（保持可点）也不误伤。
    const upperName = name.toUpperCase();
    const sameName = allShips.filter(s => s.name?.toUpperCase() === upperName);
    const ship = sameName.length === 1 ? sameName[0] : undefined;
    const shipNaturalId = ship
      ? getEntityNaturalIdFromAddress(ship.address ?? undefined)
      : undefined;
    const match =
      (route === '' || route === '--') &&
      wp1NaturalId !== undefined &&
      shipNaturalId?.toUpperCase() === wp1NaturalId.toUpperCase();
    tr.classList.toggle(MATCH_ROW, match);
    tr.classList.toggle(OTHER_ROW, !match);
  });
  // 指令列：已分配到其它航线（或不在起点）的行，把游戏给的可点「分配」按钮改成禁用灰；
  // 单路径点航线游戏根本不渲染「分配」按钮，此时保持完全空白，不补任何占位内容。
  // 已分配船只的「执行」按钮属于有效操作，保持原样不动。
  rows.forEach(tr => {
    const cells = tr.querySelectorAll('td');
    // 行结构异常（不足三列）时跳过，避免读到 undefined。
    if (cells.length < 3) {
      return;
    }
    const cell = cells[2];
    const btn = cell.querySelector<HTMLButtonElement>('button');
    if (!btn) {
      return;
    }
    // 清掉本功能加上的置灰（重绘复用节点时不残留禁用态）。
    const clearDisabled = () => {
      if (btn.classList.contains(DISABLED_BTN)) {
        btn.disabled = false;
        btn.classList.remove(DISABLED_BTN);
      }
    };
    if (tr.classList.contains(MATCH_ROW)) {
      // 可分配：确保可点击。
      clearDisabled();
      return;
    }
    if (btn.textContent?.trim() === '分配') {
      // 不在起点的船：禁用「分配」，避免误点。
      btn.disabled = true;
      btn.classList.add(DISABLED_BTN);
    } else {
      // 按钮已不是「分配」（React 复用成「执行」等有效操作）：
      // 此时航线已填充，本行走不到 MATCH_ROW 分支，必须在这里清掉旧的置灰，
      // 否则合法的「执行」按钮会残留 disabled=true 而点不动。
      clearDisabled();
    }
  });

  // 开关状态固化到 localStorage：刷新/重开界面后保持，直到用户主动取消。
  // 必须先应用筛选 class 再排版，否则会按「全部行」分栏，第二栏表头错位。
  if (readMatchOnly()) {
    frame.classList.add(MATCH_ONLY);
  } else {
    frame.classList.remove(MATCH_ONLY);
  }

  // 按当前筛选状态摆放两栏与表头（勾选时只按匹配行分栏）。
  layoutShipTable(table, Array.from(rows));

  // 在「船只分配」标题行内插入可见开关；重渲染后若丢失则按当前状态重建。
  if (!shipHeader.querySelector(`.${TOGGLE}`)) {
    const label = document.createElement('label');
    label.className = TOGGLE;
    label.style.cssText =
      'display:inline-flex;align-items:center;gap:4px;margin-left:10px;font-size:11px;cursor:pointer;font-weight:normal;';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = TOGGLE_CHK;
    chk.style.cssText = 'margin:0;cursor:pointer;';
    chk.checked = frame.classList.contains(MATCH_ONLY);
    chk.addEventListener('change', () => {
      frame.classList.toggle(MATCH_ONLY, chk.checked);
      writeMatchOnly(chk.checked);
      // 偏好是共享的：其它已打开的 RT 磁贴也要立刻按新值重建（各自重读 readMatchOnly，
      // 同步勾选状态并重排船行/表头），而不是等下一次无关重绘才变。
      refreshAllTiles();
      // 过滤会改变可见行数，需重排两栏与表头。
      const currentTable = anchor.querySelector<HTMLTableElement>('table');
      if (currentTable) {
        const currentRows = Array.from(
          currentTable.querySelectorAll<HTMLTableRowElement>(`tbody tr:not(.${COLHEAD})`),
        );
        layoutShipTable(currentTable, currentRows);
      }
    });
    label.appendChild(chk);
    label.appendChild(document.createTextNode('仅显示起点待命船只'));
    shipHeader.appendChild(label);
  } else {
    // 复用已有开关节点时，同步勾选状态与当前 class。
    const chk = shipHeader.querySelector<HTMLInputElement>(`.${TOGGLE_CHK}`);
    if (chk) {
      chk.checked = frame.classList.contains(MATCH_ONLY);
    }
  }
}

// 与「船只是否在起点待命」判定相关的船状态指纹：registration + 船名 + 所在地点 + 是否已分配航线。
// 燃料、货舱等其它字段变化不应触发本功能重绘，避免 SHIP_DATA 高频推送时空转；
// 但 assignedRoute 必须算进来——分配/取消分配会改变「是否空闲」，而船本身停着不动，
// 位置指纹不变，否则这条船要等下一次无关重绘才会重新分类（表现为分配后仍被当成
// 起点待命、或取消后仍被隐藏）。
function shipLocationSignature() {
  return (
    shipsStore.all.value
      ?.map(ship =>
        [
          ship.registration,
          ship.name,
          getEntityNaturalIdFromAddress(ship.address ?? undefined) ?? '',
          ship.assignedRoute ?? '',
        ].join(':'),
      )
      .join('\n') ?? ''
  );
}

function onTileReady(tile: PrunTile) {
  markTile(tile);

  // DOM 重绘与船位置数据变化共用一条帧级节流通道：markTile 的操作都是幂等的
  // （已正确就不动 DOM），「变更 -> 再跑一次 -> 无变更」会自然收敛，
  // 因此一个 scheduled 标志足够，不需要可能吞掉更新的重入标志。
  let scheduled = false;
  const schedule = () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (!tile.frame.isConnected) {
        return;
      }
      markTile(tile);
    });
  };

  // 船只分配表会随分配/取消分配、数据加载重绘，重绘后重新分类行、补回开关、重排表头。
  // 除结构变化（childList）外，还要抓「原地改文本」：React 更新第一个路径点时可能直接
  // 改已有文本节点的内容，既不增删子节点、船数据也没变，只有 characterData 才能捕获，
  // 否则筛选/置灰会一直按旧路径点分类，直到无关的重绘或船移动。
  // 但 characterData 不能在整棵 tile 上无脑触发：RT 界面还有报价、倒计时等高频文本更新，
  // 每次都重排是白费功夫。所以只对「路径点容器内」的文本变化调度，其余结构变化照旧。
  const needsRerun = (record: MutationRecord) => {
    if (record.type !== 'characterData') {
      // 增删节点（重绘、分配变化等）——保持原有行为。
      return true;
    }
    // 文本内容原位变化：路径点目的地会影响「起点待命」判定；船表的航线/指令列同理——
    // 分配或取消分配时 React 会原地改写这两格文本，船本身可能一动不动（位置指纹不变），
    // 只认路径点就会漏掉这类转移，船会保持隐藏/置灰直到下一次无关重绘。
    const el = record.target.parentElement;
    return (
      el !== null &&
      (el.closest('[class*="Waypoints__container"]') !== null ||
        el.closest(`.${SHIP_TABLE}`) !== null)
    );
  };
  const observer = new MutationObserver((records: MutationRecord[]) => {
    if (records.some(needsRerun)) {
      schedule();
    }
  });
  observer.observe(tile.anchor, { childList: true, subtree: true, characterData: true });

  // 未分配船抵达路径点1时，地址经 SHIP_DATA 更新进 store，但船表三列 DOM 可能
  // 完全不变（船名/航线/指令都相同），MutationObserver 抓不到。额外监听船的位置
  // 指纹，变化时同样调度重分类，避免船一直保持隐藏/置灰直到重开界面。
  const stopWatchingShips = watch(shipLocationSignature, schedule);

  // 注册本磁贴的重绘入口，供「在别的 RT 磁贴里改了筛选」时立即跟随。
  mountedTiles.add(schedule);

  // tile 关闭或断开时停掉两条监听，避免 watcher/observer 泄漏与对已卸载节点的写入。
  onNodeDisconnected(tile.frame, () => {
    observer.disconnect();
    stopWatchingShips();
    mountedTiles.delete(schedule);
  });
}

function init() {
  tiles.observe('RT', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'RT：船只分配移到航线上方并按三栏（各带表头）列示；可开关只显示停在起点待命的空闲船只（选择会记住）；不在起点的船只分配按钮置灰。',
);
