import { getPrunId } from '@src/infrastructure/prun-ui/attributes';
import { UI_TILES_CHANGE_COMMAND } from '@src/infrastructure/prun-api/client-messages';
import { dispatchClientPrunMessage } from '@src/infrastructure/prun-api/prun-api-listener';
import { changeInputValue, clickElement } from '@src/util';
import { sleep } from '@src/utils/sleep';
import { setBufferSize, showBuffer } from '@src/infrastructure/prun-ui/buffers';
import css from '@src/utils/css-utils.module.css';

interface TileAllocatorOptions {
  tile: PrunTile;
  onBufferSplit: () => void;
}

/** 静默模式：隐藏窗口（游戏 UI 在 display:none 下照常渲染与更新）。 */
export function hideWindow(window: Element) {
  window.classList.add(css.hidden);
}

/** 直接关闭窗口（不恢复可见）。 */
export function closeWindow(window: Element) {
  if (!window.isConnected) {
    return;
  }
  const buttons = window.getElementsByClassName(C.Window.button);
  const closeBtn = Array.from(buttons).find(x => x.textContent === 'x') as HTMLElement | undefined;
  closeBtn?.click();
}

export class TileAllocator {
  private allocatedTile?: HTMLElement;
  // 自动模式静默打开的独立窗口，执行结束后统一关闭。
  // silent=false 的窗口（如 OPEN_SFC 航行控制面板）保持可见且不跟踪，留给玩家操作。
  private trackedWindows: Element[] = [];

  constructor(options: TileAllocatorOptions) {
    const { tile } = options;
    const isSoloBuffer = tile.container.classList.contains(C.Window.body);
    if (isSoloBuffer) {
      options.onBufferSplit();
      splitBuffer(tile);
    } else {
      this.allocatedTile = getCompanionTile(tile);
    }
  }

  async requestTile(command: string) {
    if (this.allocatedTile?.isConnected) {
      await changeTileCommand(this.allocatedTile, command);
    } else {
      this.allocatedTile = await requestTile(command);
    }
    return tiles.findByContainer(this.allocatedTile?.parentElement)[0];
  }

  // 是否右侧 companion 小窗（仅手动模式使用）
  isCompanion(tile: PrunTile) {
    return this.allocatedTile !== undefined && tile.container === this.allocatedTile;
  }

  // 自动模式用：优先复用已开窗口（含预开窗口），绝不使用 companion 小窗。
  // showBuffer 无 force 时可能命中 companion 所在的窗口，命中则强制开独立窗口。
  // silent=true：隐藏窗口（静默执行），执行结束后由 closeTrackedWindows 统一关闭；
  // silent=false（如 OPEN_SFC）：保持可见，执行完留在屏幕供玩家操作，不跟踪不关闭。
  async requestWindow(command: string, silent = true) {
    const existing = tiles.find(command, true).find(x => !this.isCompanion(x));
    if (existing !== undefined) {
      return existing;
    }
    const window = await showBuffer(command, { force: true, autoSubmit: true });
    await sleep(0);
    if (silent) {
      hideWindow(window);
      this.trackedWindows.push(window);
    }
    const body = _$(window, C.Window.body);
    const tileEl = body ? _$(body, C.Tile.tile) : undefined;
    return tiles.findByContainer(tileEl?.parentElement)[0];
  }

  /** 关闭自动模式打开且尚未关闭的窗口。 */
  closeTrackedWindows() {
    for (const win of this.trackedWindows) {
      closeWindow(win);
    }
    this.trackedWindows = [];
  }
}

function getCompanionTile(tile: PrunTile) {
  const isInNodeChild = tile.container.classList.contains(C.Node.child);
  const isInNode = tile.container.parentElement?.classList.contains(C.Node.node);
  const isInWindow = tile.container.parentElement?.parentElement?.classList.contains(C.Window.body);
  if (!isInNodeChild || !isInNode || !isInWindow) {
    return undefined;
  }

  const node = tile.container.parentElement!;
  const sibling = _$$(node, C.Node.child).find(x => x !== tile.container)!;
  return _$(sibling, C.Tile.tile);
}

async function changeTileCommand(tile: HTMLElement, command: string) {
  const id = getPrunId(tile)!;
  let message = UI_TILES_CHANGE_COMMAND(id, null);
  if (!dispatchClientPrunMessage(message)) {
    const changeButton = _$$(tile, C.TileControls.control).find(x => x.textContent === ':');
    await clickElement(changeButton);
  } else {
    await sleep(0);
  }
  message = UI_TILES_CHANGE_COMMAND(id, command);
  if (!dispatchClientPrunMessage(message)) {
    const input = (await $(tile, C.PanelSelector.input)) as HTMLInputElement;
    changeInputValue(input, command);
    input.form!.requestSubmit();
  }
  await $(tile, C.TileFrame.frame);
}

async function requestTile(command: string) {
  const window = await showBuffer(command, { autoSubmit: true });
  await sleep(0);
  const body = _$(window, C.Window.body);
  return body ? _$(body, C.Tile.tile) : undefined;
}

function splitBuffer(tile: PrunTile) {
  const width = parseInt(tile.container.style.width.replace('px', ''), 10);
  const height = parseInt(tile.container.style.height.replace('px', ''), 10);
  setBufferSize(tile.id, width + 450, height);
  const changeButton = _$$(tile.frame, C.TileControls.control).find(x => x.textContent === '|');
  void clickElement(changeButton);
}
