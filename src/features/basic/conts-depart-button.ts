import { contractsStore } from '@src/infrastructure/prun-api/data/contracts';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { getDepartTargets, openSfcAndFill, type DepartTarget } from '@src/core/contract-shipment';
import { attachFloatingTooltip } from '@src/utils/floating-tooltip';
import { watch } from 'vue';
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
//
// 判定与 SFC 操作共用 @src/core/contract-shipment（XIT CONTSS、CONT 详情同一套）。
const BUTTON_ATTR = 'data-rp-conts-depart';

// 按钮每次对齐时把最新的判定结果存这里，点击时直接取，避免闭包里的旧快照。
const latestTargets = new WeakMap<HTMLButtonElement, DepartTarget>();
const busyButtons = new WeakSet<HTMLButtonElement>();

function createButton(nativeButton: HTMLButtonElement) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `${C.Button.btn} ${C.Button.primary}`;
  button.setAttribute(BUTTON_ATTR, '');
  button.textContent = '起飞';
  // 和原生「查看」按钮贴在一起，补一点间距（表格单元格不是 flex，没有 gap）。
  button.style.marginRight = '4px';
  button.addEventListener('click', () => {
    void depart(button);
  });
  nativeButton.parentElement?.insertBefore(button, nativeButton);
  // 表格最后一列贴着磁贴右缘，游戏自带的 data-tooltip 会被裁掉，用 body 浮层。
  // 节点断开即收起同样交给 floating-tooltip 处理。
  attachFloatingTooltip(button, () => latestTargets.get(button)?.hint ?? '');
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
  if (button.textContent !== target.label) {
    button.textContent = target.label;
  }
  setGreyed(button, !target.ready || busyButtons.has(button));
}

function syncRow(row: HTMLTableRowElement) {
  const contractCell = row.cells.item(0);
  const actionCell = row.cells.item(row.cells.length - 1);
  if (contractCell === null || actionCell === null) {
    return;
  }
  const localId = contractCell.textContent?.trim();
  const contract = localId ? contractsStore.getByLocalId(localId) : undefined;
  const targets = contract ? getDepartTargets(contract) : [];

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

async function depart(button: HTMLButtonElement) {
  const target = latestTargets.get(button);
  if (!target || !target.ready || busyButtons.has(button)) {
    return;
  }
  busyButtons.add(button);
  setGreyed(button, true);
  try {
    const result = await openSfcAndFill(target);
    if (!result.ok && result.message) {
      // 只把原因并进**当前**条目：等待期间货可能已经换船，对齐逻辑更新过
      // latestTargets；拿点击时的 target 覆盖回去，会让 finally 重新启用一个
      // 指向旧船的 SFC 按钮（两艘船都 ready 时文字不变，也不会再触发修复）。
      const current = latestTargets.get(button) ?? target;
      latestTargets.set(button, { ...current, hint: result.message });
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
  // 所以再盯一层合同 / 库存 / 飞船 store；磁贴关掉时随之解绑。
  // 装货完成等变化体现在 storage / ship store，而非合同 store：取货合同先于
  // STORAGE_CHANGE 到达时「ready:false」的目标会被缓存，装货完成后按钮仍灰着。
  const stop = watch(
    [contractsStore.all, storagesStore.all, shipsStore.all],
    () => syncTile(tile),
    { flush: 'post' },
  );
  // 同 CONT 详情：anchor 被复用，摘掉它本身不会触发以它为根的 observer，
  // 必须显式 disconnect，否则切回来一次就多留一个观察者。
  onNodeDisconnected(tile.anchor, () => {
    observer.disconnect();
    stop();
  });
  syncTile(tile);
}

function init() {
  tiles.observe('CONTS', onTileReady);
}

features.add(
  import.meta.url,
  init,
  'CONTS：指令列加「起飞」按钮，取货完成后打开该船 SFC 并填入卸货地。',
);
