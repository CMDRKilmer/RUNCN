import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';

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

// 船表分栏数。
const COLUMNS = 3;

function readMatchOnly(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMatchOnly(value: boolean) {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    // 隐私模式等无法写入时静默失败，不影响本次会话的显示效果。
  }
}

// React fiber 的最小形状：只需要沿 return 链向上找渲染时透传的 props。
// 只声明用得到的字段，避免用 any 破坏类型检查。
type FiberLike = {
  memoizedProps?: {
    waypoint?: { destination?: PrunApi.Address };
    destination?: PrunApi.Address;
  };
  return?: FiberLike | null;
};

// 从 DOM 元素的 React fiber 链里挖出第一个 waypoint 的 destination（结构化 address）。
// RT 界面把路径点目的地渲染成「Hortus Station (Hortus)」文本，但 naturalId（HRT）
// 只存在于 fiber 的 waypoint.destination 上，故从 fiber 读取。
function findFirstWaypointAddress(waypoints: HTMLElement): PrunApi.Address | undefined {
  const destEl = waypoints.querySelector('[class*="Waypoint__destination"]');
  if (!destEl) {
    return undefined;
  }
  const fiberKey = Object.keys(destEl).find(k => k.startsWith('__reactFiber$'));
  if (!fiberKey) {
    return undefined;
  }
  let fiber = (destEl as unknown as Record<string, FiberLike | undefined>)[fiberKey];
  for (let i = 0; i < 12 && fiber; i++) {
    const candidate =
      fiber.memoizedProps?.waypoint?.destination ?? fiber.memoizedProps?.destination;
    if (candidate !== undefined && Array.isArray(candidate.lines)) {
      return candidate;
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
  if (!tbody || !theadRow || visible.length === 0) {
    return;
  }
  const isHead = (el: Element) => el.classList.contains(COLHEAD);
  const heads = Array.from(tbody.children).filter(isHead);
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
  const shipHeader = headers.find(h => h.textContent?.trim() === '船只分配');
  const routeHeader = headers.find(h => h.textContent?.trim() === '航线');
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
  const rows = table.querySelectorAll<HTMLTableRowElement>(`tbody tr:not(.${COLHEAD})`);
  rows.forEach(tr => {
    const cells = tr.querySelectorAll('td');
    const route = cells[1]?.textContent?.trim() ?? '';
    const name = cells[0]?.textContent?.trim() ?? '';
    const ship = shipsStore.getByName(name);
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
    if (tr.classList.contains(MATCH_ROW)) {
      // 可分配：确保复原为可点击状态（重绘复用节点时不残留禁用态）。
      if (btn.classList.contains(DISABLED_BTN)) {
        btn.disabled = false;
        btn.classList.remove(DISABLED_BTN);
      }
      return;
    }
    if (btn.textContent?.trim() === '分配') {
      btn.disabled = true;
      btn.classList.add(DISABLED_BTN);
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

function onTileReady(tile: PrunTile) {
  markTile(tile);
  // 船只分配表会随分配/取消分配、数据加载重绘，重绘后重新分类行、补回开关、重排表头。
  // 用 rAF 做帧级节流：markTile 的所有操作都是幂等的（已正确就不动 DOM），
  // 因此「变更 -> 再跑一次 -> 无变更」会自然收敛，不需要可能吞掉更新的重入标志。
  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      markTile(tile);
    });
  });
  observer.observe(tile.anchor, { childList: true, subtree: true });
}

function init() {
  tiles.observe('RT', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'RT：船只分配移到航线上方并按三栏（各带表头）列示；可开关只显示停在起点待命的空闲船只（选择会记住）；不在起点的船只分配按钮置灰。',
);
