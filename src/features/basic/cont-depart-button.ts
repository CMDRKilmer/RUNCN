import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { getDepartTargets, openSfcAndFill, type DepartTarget } from '@src/core/contract-shipment';
import { attachFloatingTooltip } from '@src/utils/floating-tooltip';
import { watch } from 'vue';
import onNodeDisconnected from '@src/utils/on-node-disconnected';

// CONT（合同详情）：在「取货条款」那一行的指令列加「起飞」按钮。
//
// 为什么挂在取货行：起飞的前提就是「取货条款全部装完」，玩家在详情里正是盯着
// 这几行看进度；判定（取货是否完成、货在谁的船上、目的地是哪）与原生 CONTS
// 列表、XIT CONTSS 共用 @src/core/contract-shipment。
//
// 行 ↔ 条款的对应：条件表第一列是 `#N`，N = condition.index + 1（已实测核对）。
// 只按 index 匹配、匹配不到就跳过，不做文本匹配（站名 / 语言一变就断）。
const BUTTON_ATTR = 'data-rp-cont-depart';

const latestTargets = new WeakMap<HTMLButtonElement, DepartTarget>();
const busyButtons = new WeakSet<HTMLButtonElement>();

function setGreyed(button: HTMLButtonElement, greyed: boolean) {
  if (button.classList.contains(C.Button.disabled) !== greyed) {
    button.classList.toggle(C.Button.disabled, greyed);
  }
  button.setAttribute('aria-disabled', String(greyed));
}

function createButton(cell: HTMLTableCellElement) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${C.Button.btn} ${C.Button.primary}`;
  button.setAttribute(BUTTON_ATTR, '');
  button.textContent = '起飞';
  // 不给按钮加 margin：本行没有原生按钮时（游戏会在装货中隐藏「完成」），
  // 4px 的左边距会让「起飞」比下一行的「完成」向右偏。间隔由 CSS 的
  // `td > button + button` 处理，只在前一个按钮存在时才生效。
  button.addEventListener('click', () => {
    void depart(button);
  });
  // 游戏自带的 data-tooltip 是元素上的绝对定位伪元素，会被磁贴滚动容器裁掉，
  // 这里用 body 上的 fixed 浮层（文案取自当前判定的 hint）。
  cell.appendChild(button);
  // 浮层挂在 body 上：合同更新时 React 直接摘掉按钮、不会发 mouseleave，
  // 「节点断开即收起」由 floating-tooltip 内部统一处理（悬停时登记一次）。
  attachFloatingTooltip(button, () => latestTargets.get(button)?.hint ?? '');
  return button;
}

function removeButton(cell: HTMLTableCellElement) {
  for (const existing of [...cell.querySelectorAll<HTMLButtonElement>(`[${BUTTON_ATTR}]`)]) {
    existing.remove();
  }
}

async function depart(button: HTMLButtonElement) {
  const target = latestTargets.get(button);
  if (!target?.ready || busyButtons.has(button)) {
    return;
  }
  busyButtons.add(button);
  setGreyed(button, true);
  try {
    const result = await openSfcAndFill(target);
    if (!result.ok && result.message) {
      // 失败原因临时顶替 hint，下次对齐时会被覆盖回正常文案。
      // 只改**当前**条目：等待期间货可能已换船，用点击时的 target 覆盖会让
      // finally 把按钮恢复成指向旧船的 SFC。
      const current = latestTargets.get(button) ?? target;
      latestTargets.set(button, { ...current, hint: result.message });
    }
  } finally {
    busyButtons.delete(button);
    const current = latestTargets.get(button) ?? target;
    setGreyed(button, !current.ready);
  }
}

/** 该取货条款对应哪条交付目标：优先用依赖链，退化为「一取一交付」的唯一解。 */
function pickTarget(
  condition: PrunApi.ContractCondition,
  contract: PrunApi.Contract,
  targets: DepartTarget[],
): DepartTarget | undefined {
  if (condition.type !== 'PICKUP_SHIPMENT') {
    return undefined;
  }
  const direct = targets.find(x => x.pickupIds.includes(condition.id));
  if (direct !== undefined) {
    return direct;
  }
  const pickups = contract.conditions.filter(x => x.type === 'PICKUP_SHIPMENT');
  return targets.length === 1 && pickups.length === 1 ? targets[0] : undefined;
}

function syncRow(row: HTMLTableRowElement, contract: PrunApi.Contract, targets: DepartTarget[]) {
  const cell = row.cells.item(row.cells.length - 1);
  const seq = row.cells.item(0)?.textContent?.trim();
  if (cell === null || seq === null || seq === undefined) {
    return;
  }
  const n = Number(seq.replace(/^#/, ''));
  if (!Number.isFinite(n)) {
    return;
  }
  const condition = contract.conditions.find(x => x.index === n - 1);
  if (condition === undefined) {
    removeButton(cell);
    return;
  }
  const target = pickTarget(condition, contract, targets);
  if (target === undefined) {
    removeButton(cell);
    return;
  }

  let button = cell.querySelector<HTMLButtonElement>(`[${BUTTON_ATTR}]`);
  if (!button) {
    button = createButton(cell);
  }
  latestTargets.set(button, target);
  if (button.getAttribute(BUTTON_ATTR) !== condition.id) {
    button.setAttribute(BUTTON_ATTR, condition.id);
  }
  if (button.textContent !== target.label) {
    button.textContent = target.label;
  }
  setGreyed(button, !target.ready || busyButtons.has(button));
}

function syncTile(tile: PrunTile) {
  const localId = tile.parameter;
  const contract = localId ? contractsStore.getByLocalId(localId) : undefined;
  const rows = [...tile.anchor.querySelectorAll('table tbody tr')] as HTMLTableRowElement[];
  if (contract === undefined) {
    for (const row of rows) {
      const cell = row.cells.item(row.cells.length - 1);
      if (cell) {
        removeButton(cell);
      }
    }
    return;
  }
  const targets = getDepartTargets(contract);
  for (const row of rows) {
    syncRow(row, contract, targets);
  }
}

function onTileReady(tile: PrunTile) {
  const observer = new MutationObserver(() => {
    if (!tile.anchor.isConnected) {
      observer.disconnect();
      return;
    }
    syncTile(tile);
  });
  observer.observe(tile.anchor, { childList: true, subtree: true, characterData: true });
  // 装货完成体现在 storage / ship store，条款状态体现在 contracts store；
  // 三者任一变化都重新对齐（幂等，无变化时不写 DOM）。
  const stop = watch(
    [contractsStore.all, storagesStore.all, shipsStore.all],
    () => syncTile(tile),
    { flush: 'post' },
  );
  // 磁贴切走再切回时 frame / anchor 会被复用（tiles.ts 的 retained frame），
  // 游戏只发一次「anchor 被摘掉」的通知；observer 是从 anchor 自身往下的，
  // 摘掉 anchor 本身不会让它收到任何 mutation，`!isConnected` 分支也就永远不成立。
  // 只 stop() 而不 disconnect，旧 observer 会挂在这个复用的 anchor 上继续存活，
  // 于是每次切回来都多一个 observer，之后每次 DOM 变化就跑 N 次 syncTile。
  onNodeDisconnected(tile.anchor, () => {
    observer.disconnect();
    stop();
  });
  syncTile(tile);
}

function init() {
  tiles.observe('CONT', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'CONT：取货条款行加「起飞」，装完货后打开该船 SFC 并填入卸货地。',
);
