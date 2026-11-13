import { changeInputValue, clickElement } from '@src/utils/dom';
import { sleep } from '@src/utils/sleep';
import css from '@src/utils/css-utils.module.css';
import onNodeDisconnected from '@src/utils/on-node-disconnected';
import { getPrunId } from '@src/infrastructure/prun-ui/attributes';
import { watchUntil } from '@src/utils/watch';
import { isEmpty } from 'ts-extras';
import { dispatchClientPrunMessage } from '@src/infrastructure/prun-api/prun-api-listener';
import { clamp } from '@src/utils/clamp';
import {
  UI_TILES_CHANGE_COMMAND,
  UI_WINDOWS_REQUEST_FOCUS,
  UI_WINDOWS_UPDATE_SIZE,
} from '@src/infrastructure/prun-api/client-messages';
import { onNodeTreeMutation } from '@src/utils/on-node-tree-mutation';

let isBusy = false;
const pendingResolvers: (() => void)[] = [];

interface ShowBufferOptions {
  force?: boolean;
  // 插到等待队列最前面。仍是同一时间只创建一个窗口（seenWindows 检测不能并发），
  // 只是不再排在后面那一串请求之后。给 FB 这类「面板自己的原生磁贴」用。
  priority?: boolean;
  autoSubmit?: boolean;
  autoClose?: boolean;
  closeWhen?: Ref<boolean>;
}

export async function showBuffer(command: string, options?: ShowBufferOptions) {
  const parts = command.split(' ');
  correctXitArgs(parts);
  command = parts.join(' ');
  if (!options?.force) {
    const existing = tiles.find(command).find(x => !x.docked);
    if (existing) {
      // 显式收窄成 HTMLDivElement：这是窗口根节点，调用方（GOVH 等）要拿它当
      // HTMLElement 解析。原来 closest() 的 Element 类型会让所有 await showBuffer
      // 的调用点都退化成 Element。
      const window = existing.frame.closest(`.${C.Window.window}`)! as HTMLDivElement;
      const command = UI_WINDOWS_REQUEST_FOCUS(existing.id);
      if (dispatchClientPrunMessage(command)) {
        return window;
      }
      const header = _$(window, C.Window.header);
      void clickElement(header);
      return window;
    }
  }
  await acquireSlot(options?.priority);
  const create = await $(document.documentElement, C.Dock.create);

  try {
    const windows = document.getElementsByClassName(C.Window.window);
    const seenWindows = new Set(Array.from(windows));
    const newWindow = await new Promise<HTMLDivElement>(resolve => {
      onNodeTreeMutation(document, () => {
        for (let i = 0; i < windows.length; i++) {
          if (!seenWindows.has(windows[i])) {
            resolve(windows[i] as HTMLDivElement);
            return true;
          }
        }
        return false;
      });
      create.click();
    });
    await processWindow(newWindow, command, options);
    return newWindow;
  } finally {
    releaseSlot();
  }
}

async function acquireSlot(priority = false) {
  if (!isBusy) {
    isBusy = true;
    return;
  }

  // 刷新时 FLEET/PROD 会为每个基地触发 requestBS()，一口气排十几个
  // showBuffer('BS <星球>', { autoClose: true })。普通 FIFO 会把 FB 面板自己
  // 的 BS/SHPI 磁贴排到最后，右下角空好几秒。priority 只改变排队顺序，
  // 串行创建窗口的约束不变，避免两个调用抢到同一个新窗口。
  await new Promise<void>(resolve => {
    if (priority) {
      pendingResolvers.unshift(resolve);
    } else {
      pendingResolvers.push(resolve);
    }
  });
}

function releaseSlot() {
  if (isEmpty(pendingResolvers)) {
    isBusy = false;
  } else {
    setTimeout(pendingResolvers.shift()!, 0);
  }
}

async function processWindow(window: HTMLDivElement, command: string, options?: ShowBufferOptions) {
  const input = _$(window, C.PanelSelector.input) as HTMLInputElement;
  const form = input.form;
  if (!form?.isConnected) {
    return;
  }
  if (!(options?.autoSubmit ?? true)) {
    changeInputValue(input, command);
    return;
  }
  window.classList.add(css.hidden);
  const tile = _$(window, C.Tile.tile);
  const id = getPrunId(tile!);
  if (options?.autoClose) {
    const dockLabel = id?.padStart(2, '0');
    const dockTab = _$$(document, C.Dock.buffer).find(
      x => _$(x, C.Dock.title)?.textContent === dockLabel,
    );
    if (dockTab) {
      dockTab.classList.add(css.hidden);
    }
  }
  // 新建窗口的磁贴偶尔还没拿到 id。此时注入 UI_TILES_CHANGE_COMMAND 会让游戏
  // 用 undefined 作为窗口键，底栏多出一个标题为 NaN 的坏按钮（点开是空白窗口）。
  // 没有 id 就退回游戏原生的表单提交，不要发这条消息。
  const applied = id ? dispatchClientPrunMessage(UI_TILES_CHANGE_COMMAND(id, command)) : false;
  if (!applied) {
    changeInputValue(input, command);
    await sleep(0);
    form.requestSubmit();
  }
  const selector = await $(window, C.Tile.selector);
  await Promise.any([
    new Promise<void>(resolve => onNodeDisconnected(input, resolve)),
    $(selector, C.Tile.warning),
  ]);
  if (!options?.autoClose) {
    window.classList.remove(css.hidden);
    return;
  }
  void closeWhenDone(window, options);
}

async function closeWhenDone(window: HTMLDivElement, options?: ShowBufferOptions) {
  await sleep(0);
  const closeWhen = options?.closeWhen;
  if (closeWhen) {
    await watchUntil(closeWhen);
  }
  const buttons = _$$(window, C.Window.button);
  const closeButton = buttons.find(x => x.textContent === 'x');
  if (closeButton) {
    closeButton?.click();
  }
  await new Promise<void>(resolve => onNodeDisconnected(window, resolve));
}

export function correctXitArgs(parts: string[]) {
  if (parts[0].toUpperCase() !== 'XIT') {
    return;
  }

  const args = parts.slice(1);
  if (args.length < 5 && args.every(x => x.length > 1)) {
    return;
  }

  parts.splice(1);
  parts.push(args.filter(x => x).join('_'));
}

export function setBufferSize(id: string, width: number, height: number) {
  dispatchClientPrunMessage(
    UI_WINDOWS_UPDATE_SIZE(
      id,
      clamp(width, 100, document.body.clientWidth - 50),
      clamp(height, 50, document.body.clientHeight - 50),
    ),
  );
}
