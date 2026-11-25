import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { getDepartTargets, openSfcAndFill, type DepartTarget } from '@src/core/contract-shipment';
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
const BUTTON_TEXT = '起飞';

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
  button.textContent = BUTTON_TEXT;
  // 单元格里可能已经有原生「完成」按钮，补一点左边距。
  button.style.marginLeft = '4px';
  button.addEventListener('click', () => {
    void depart(button);
  });
  cell.appendChild(button);
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
      button.setAttribute('data-tooltip', result.message);
      button.setAttribute('data-tooltip-position', 'top');
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
  setGreyed(button, !target.ready || busyButtons.has(button));
  if (button.getAttribute('data-tooltip') !== target.hint) {
    button.setAttribute('data-tooltip', target.hint);
    button.setAttribute('data-tooltip-position', 'top');
  }
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
  onNodeDisconnected(tile.anchor, stop);
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
