import { sleep } from '@src/utils/sleep';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

const MAX_CONFIRM_ITERATIONS = 50;
const CONFIRM_DELAY_MS = 250;

const CONFIRM_ALL_SELECTOR = 'button[data-rprun-confirm-all]';

const clickedDoneButtons = new WeakSet<HTMLButtonElement>();
const clickedDismissElements = new WeakSet<HTMLElement>();

function init() {
  tiles.observe('CONT', onTileReady);
}

function onTileReady(tile: PrunTile) {
  // 订阅 tile 内新增的按钮：每次 React 渲染出新的原生按钮都尝试插入。
  // 相比订阅单个类名（只在元素首次出现时触发一次），这能容忍
  // 按钮渲染时机不确定的情况。
  subscribe($$(tile.anchor, 'button'), () => {
    insertConfirmAllButton(tile);
  });
}

function insertConfirmAllButton(tile: PrunTile) {
  if (tile.anchor.querySelector(CONFIRM_ALL_SELECTOR) !== null) {
    return;
  }
  const reference = findTerminateButton(tile.anchor) ?? findDoneButton(tile.anchor);
  if (reference === undefined) {
    return;
  }
  const button = document.createElement('button');
  button.className = `${C.Button.btn} ${C.Button.primary}`;
  button.dataset.rprunConfirmAll = '';
  button.textContent = getI18nValue('Contract.ConfirmAll', '全部确认');
  reference.parentElement!.insertBefore(button, reference);
  button.addEventListener('click', () => {
    void confirmAllConditions(tile, button);
  });
}

function findTerminateButton(root: HTMLElement) {
  return _$$(root, 'button').find(b =>
    /^请求终止|^终止|^terminat|^cancel|^取消/i.test(b.textContent ?? ''),
  );
}

function findDoneButton(root: HTMLElement) {
  return _$$(root, 'button').find(
    b => /^完成/.test(b.textContent ?? '') && !b.disabled && !clickedDoneButtons.has(b),
  );
}

function findSuccessToast(root: HTMLElement) {
  // 「操作成功！（点击以清除）」toast：查找不含子元素的叶子节点。
  return _$$(root, 'div').find(
    el => /操作成功/.test(el.textContent ?? '') && el.children.length === 0,
  );
}

async function confirmAllConditions(tile: PrunTile, button: HTMLButtonElement) {
  if (button.disabled) {
    return;
  }
  button.disabled = true;
  try {
    for (let i = 0; i < MAX_CONFIRM_ITERATIONS; i++) {
      // 先清除操作成功 toast（点击 toast 本身），解锁下一个完成按钮。
      const toast = findSuccessToast(tile.anchor);
      if (toast !== undefined) {
        await dismissToast(toast);
        continue;
      }
      // 再点击下一个可用的完成按钮。
      const doneButton = findDoneButton(tile.anchor);
      if (doneButton === undefined) {
        break;
      }
      if (import.meta.env.DEV) {
        console.log('[cont-confirm-all] completing condition:', doneButton.textContent);
      }
      clickedDoneButtons.add(doneButton);
      doneButton.click();
      await sleep(CONFIRM_DELAY_MS);
    }
  } finally {
    button.disabled = false;
  }
}

async function dismissToast(toast: HTMLElement) {
  // React 的点击处理器可能在 toast 的祖先元素上，而叶子 div 点击无效。
  // 从叶子向上逐级点击，直到 toast 消失；已点击过的元素不再重复点击。
  let target: HTMLElement | null = toast;
  while (target !== null && clickedDismissElements.has(target)) {
    target = target.parentElement;
  }
  if (target === null) {
    return;
  }
  if (import.meta.env.DEV) {
    console.log('[cont-confirm-all] dismissing toast:', target.textContent);
  }
  clickedDismissElements.add(target);
  target.click();
  await sleep(CONFIRM_DELAY_MS);
}

features.add(import.meta.url, init, 'CONT: 一键确认全部合同条款并接受。');
