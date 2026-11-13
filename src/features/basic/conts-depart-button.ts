import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import {
  getDestinationFullName,
  getEntityNaturalIdFromAddress,
} from '@src/infrastructure/prun-api/data/addresses';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { selectAddress } from '@src/infrastructure/prun-ui/utils/select-address';
import { sleep } from '@src/utils/sleep';
import onNodeDisconnected from '@src/utils/on-node-disconnected';

// CONTS（合同列表）：给「货运合同」的指令列加一个「起飞」按钮。
//
// 判定口径（用户明确要求）：
//  * 只有货运合同才出现 —— 也就是存在一条我方负责、且带 shipmentItemId 的
//    DELIVERY_SHIPMENT。别的合同（材料交付 DELIVERY、COMEX 取货、派系贡献…）
//    即便有「取货条款」也没有 DELIVERY_SHIPMENT，自然不会命中。
//  * 全部取货条款 PICKUP_SHIPMENT 都是 FULFILLED 之后按钮才「亮」；未装完货
//    时按钮灰着（悬停会说明原因），避免误点。
//  * 点亮的按钮打开装货那条船的航行控制，并把目的地自动填成合同卸货地址，
//    但绝不提交飞行 —— 燃料与滑块仍由玩家在 SFC 里确认。
const BUTTON_ATTR = 'data-rp-conts-depart';
const BUTTON_TEXT = '起飞';
const SFC_WAIT_TIMEOUT_MS = 8000;

// 只处理进行中的合同：已取消 / 已终止 / 已完成的合同不提供起飞入口。
const ACTIVE_STATUSES = new Set<PrunApi.ContractStatus>([
  'CLOSED',
  'PARTIALLY_FULFILLED',
  'DEADLINE_EXCEEDED',
]);

interface DepartTarget {
  /** 条件 id：同一合同可能有多条交付条款，用它给按钮做标识。 */
  key: string;
  registration: string | undefined;
  destinationId: string;
  destinationLabel: string;
  ready: boolean;
  hint: string;
}

// 按钮每次对齐时把最新的判定结果存这里，点击时直接取，避免闭包里的旧快照。
const latestTargets = new WeakMap<HTMLButtonElement, DepartTarget>();
const busyButtons = new WeakSet<HTMLButtonElement>();

function findShipForShipment(shipmentItemId: string) {
  // 船上的货物列表才是权威依据：这批货在谁的货舱里，就由谁起飞。
  for (const store of storagesStore.all.value ?? []) {
    if (store.type !== 'SHIP_STORE') {
      continue;
    }
    const carried = store.items.some(x => x.type === 'SHIPMENT' && x.id === shipmentItemId);
    if (!carried) {
      continue;
    }
    const ship = shipsStore.all.value?.find(x => x.idShipStore === store.id);
    if (ship) {
      return ship;
    }
  }
  return undefined;
}

function getTargets(contract: PrunApi.Contract) {
  const targets: DepartTarget[] = [];
  if (!ACTIVE_STATUSES.has(contract.status)) {
    return targets;
  }
  // 取货条款全部完成才允许起飞。
  const pickupsDone = contract.conditions
    .filter(x => x.type === 'PICKUP_SHIPMENT')
    .every(x => x.status === 'FULFILLED');

  for (const condition of contract.conditions) {
    if (condition.type !== 'DELIVERY_SHIPMENT') {
      continue;
    }
    // 只认我方负责交付的那条：对方交付的条款轮不到我们起飞。
    if (condition.party !== contract.party) {
      continue;
    }
    if (condition.status === 'FULFILLED') {
      continue;
    }
    const shipmentItemId = condition.shipmentItemId;
    const destination = condition.destination;
    if (!shipmentItemId || !destination) {
      continue;
    }
    const destinationId = getEntityNaturalIdFromAddress(destination);
    if (!destinationId) {
      continue;
    }
    const destinationLabel = getDestinationFullName(destination) ?? destinationId;
    const ship = findShipForShipment(shipmentItemId);
    const registration = ship?.registration;

    let hint: string;
    if (!pickupsDone) {
      hint = `还有取货条款未完成，装完货后才能起飞（目的地 ${destinationLabel}）`;
    } else if (registration === undefined) {
      hint = `没找到载着这批货的飞船，请确认货物已装上船（目的地 ${destinationLabel}）`;
    } else {
      hint = `${registration} → ${destinationLabel}：打开航行控制并把目的地填好`;
    }

    targets.push({
      key: condition.id,
      registration,
      destinationId,
      destinationLabel,
      ready: pickupsDone && registration !== undefined,
      hint,
    });
  }
  return targets;
}

function createButton(nativeButton: HTMLButtonElement) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${C.Button.btn} ${C.Button.primary}`;
  button.setAttribute(BUTTON_ATTR, '');
  button.textContent = BUTTON_TEXT;
  // 和原生「查看」按钮贴在一起，补一点间距（表格单元格不是 flex，没有 gap）。
  button.style.marginRight = '4px';
  button.addEventListener('click', () => {
    void depart(button);
  });
  nativeButton.parentElement?.insertBefore(button, nativeButton);
  return button;
}

// 未就绪时用「看起来禁用」而不是原生 disabled：原生 disabled 按钮收不到
// 悬停，游戏的气泡提示也就没法解释为什么还不能起飞。
function setGreyed(button: HTMLButtonElement, greyed: boolean) {
  if (button.classList.contains(C.Button.disabled) !== greyed) {
    button.classList.toggle(C.Button.disabled, greyed);
  }
  if (button.getAttribute('aria-disabled') !== String(greyed)) {
    button.setAttribute('aria-disabled', String(greyed));
  }
}

function updateButton(button: HTMLButtonElement, target: DepartTarget) {
  latestTargets.set(button, target);
  if (button.getAttribute(BUTTON_ATTR) !== target.key) {
    button.setAttribute(BUTTON_ATTR, target.key);
  }
  setGreyed(button, !target.ready || busyButtons.has(button));
  if (button.getAttribute('data-tooltip') !== target.hint) {
    button.setAttribute('data-tooltip', target.hint);
    button.setAttribute('data-tooltip-position', 'left');
  }
}

function syncRow(row: HTMLTableRowElement) {
  const contractCell = row.cells.item(0);
  const actionCell = row.cells.item(row.cells.length - 1);
  if (contractCell === null || actionCell === null) {
    return;
  }
  const localId = contractCell.textContent?.trim();
  const contract = localId ? contractsStore.getByLocalId(localId) : undefined;
  const targets = contract ? getTargets(contract) : [];

  // 先清掉不再成立按钮（条款完成、合同结束、行被复用成别的合同）。
  for (const existing of [...actionCell.querySelectorAll<HTMLButtonElement>(`[${BUTTON_ATTR}]`)]) {
    const key = existing.getAttribute(BUTTON_ATTR);
    if (!targets.some(x => x.key === key)) {
      existing.remove();
    }
  }
  if (targets.length === 0) {
    return;
  }

  const nativeButton = actionCell.querySelector<HTMLButtonElement>(`button:not([${BUTTON_ATTR}])`);
  if (!nativeButton) {
    return;
  }

  for (const target of targets) {
    let button = actionCell.querySelector<HTMLButtonElement>(`[${BUTTON_ATTR}="${target.key}"]`);
    if (!button) {
      button = createButton(nativeButton);
    }
    updateButton(button, target);
  }
}

function syncTile(tile: PrunTile) {
  for (const tbody of _$$(tile.anchor, 'tbody') as HTMLTableSectionElement[]) {
    for (const row of Array.from(tbody.rows)) {
      syncRow(row);
    }
  }
}

async function waitForAddressContainer(root: Element) {
  const deadline = Date.now() + SFC_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const container = _$(root, C.AddressSelector.container);
    if (container) {
      return container;
    }
    await sleep(120);
  }
  return undefined;
}

function setHint(button: HTMLButtonElement, hint: string) {
  button.setAttribute('data-tooltip', hint);
  button.setAttribute('data-tooltip-position', 'left');
}

async function depart(button: HTMLButtonElement) {
  const target = latestTargets.get(button);
  if (!target || !target.ready || busyButtons.has(button)) {
    return;
  }
  const registration = target.registration;
  if (registration === undefined) {
    return;
  }

  busyButtons.add(button);
  setGreyed(button, true);
  try {
    // 复用/新开 SFC 窗口；目的地随后填入，绝不自动提交飞行。
    const window = await showBuffer(`SFC ${registration}`);
    const container = await waitForAddressContainer(window);
    if (!container) {
      setHint(button, '航行控制已打开，但没找到目的地输入框，请手动选择');
      return;
    }
    const ok = await selectAddress(container, target.destinationId);
    if (!ok) {
      setHint(button, `自动填「${target.destinationLabel}」失败，请在航行控制里手动选择`);
    }
  } finally {
    busyButtons.delete(button);
    updateButton(button, latestTargets.get(button) ?? target);
  }
}

function onTileReady(tile: PrunTile) {
  // 合同状态、条件进度都由 React 重渲染，行也可能被复用；任何 DOM 变化都
  // 重新对齐一次（幂等，没有需要改的地方就不会再产生 DOM 写入）。
  const observer = new MutationObserver(() => {
    if (!tile.anchor.isConnected) {
      observer.disconnect();
      return;
    }
    syncTile(tile);
  });
  observer.observe(tile.anchor, { childList: true, subtree: true, characterData: true });
  // 条款进度变化未必反映到列表可见文本上（例如刚装完货，状态列还是「部分完成」），
  // 所以再盯一层合同 store；磁贴关掉时随之解绑。
  // 装货完成等变化体现在 storage / ship store，而非合同 store：取货合同先于
  // STORAGE_CHANGE 到达时「ready:false」的目标会被缓存，装货完成后按钮仍灰着。
  // 盯住 storage 与 ship 依赖，装完货即时重算「ready」，按钮随之点亮
  // （PR #60 审查 #224）。
  const stop = watch(
    [contractsStore.all, storagesStore.all, shipsStore.all],
    () => syncTile(tile),
    { flush: 'post' },
  );
  onNodeDisconnected(tile.anchor, stop);
  syncTile(tile);
}

function init() {
  tiles.observe('CONTS', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'CONTS：货运合同的指令列加「起飞」按钮，全部取货条款完成后亮起，点开装货那条船的航行控制并自动填入卸货目的地（不自动起飞）。',
);
