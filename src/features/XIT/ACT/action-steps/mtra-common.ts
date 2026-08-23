import { C } from '@src/infrastructure/prun-ui/prun-css';
import { changeInputValue, clickElement, focusElement } from '@src/utils/dom';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { closePrunWindow } from '@src/infrastructure/prun-ui/utils/close-prun-window';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { Logger } from '@src/features/XIT/ACT/runner/logger';
import { fixed0 } from '@src/utils/format';

export const MTRA_TIMEOUT = 1700;
export const MTRA_MAX_RETRIES = 3;

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MTRA_TIMEOUT')), ms);
    promise.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface MtraWindow {
  window: HTMLElement;
  tile: PrunTile;
  /** 置 true 后窗口自动关闭（autoClose 模式下窗口全程隐藏）。 */
  closeWhen: Ref<boolean>;
}

/** 打开一个新的（强制不复用、隐藏的）MTRA 窗口，返回窗口与对应的 tile。 */
export async function openMtraWindow(command: string): Promise<MtraWindow> {
  const closeWhen = shallowRef(false);
  const win = await withTimeout(
    showBuffer(command, { force: true, autoSubmit: true, autoClose: true, closeWhen }),
    MTRA_TIMEOUT,
  );
  // tile 激活通过 MutationObserver 异步进行，短暂重试避免偶发查找失败。
  let tile: PrunTile | undefined;
  for (let attempt = 0; attempt < 10 && !tile; attempt++) {
    const body = _$(win, C.Window.body);
    const tileEl = body ? _$(body, C.Tile.tile) : undefined;
    tile = tileEl ? tiles.findByContainer(tileEl.parentElement)[0] : undefined;
    if (!tile) {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  if (!tile) {
    closePrunWindow(win);
    throw new Error('MTRA_WINDOW_NO_TILE');
  }
  return { window: win as HTMLElement, tile, closeWhen };
}

export function closeMtraWindows(windows: MtraWindow[]) {
  for (const win of windows) {
    // 先翻转 ref 让 autoClose 模式自动关窗；closePrunWindow 兜底
    //（覆盖 processWindow 提前返回、closeWhenDone 未启动的窗口）。
    win.closeWhen.value = true;
    closePrunWindow(win.window);
  }
}

/** 检查目标仓是否能容纳一个单位的该材料。否则 MTRA 将无法使用。 */
export function canFit(to: PrunApi.Store, material: PrunApi.Material) {
  const epsilon = 0.000001;
  const canFitWeight = to.weightCapacity - to.weightLoad - material.weight + epsilon >= 0;
  const canFitVolume = to.volumeCapacity - to.volumeLoad - material.volume + epsilon >= 0;
  return canFitWeight && canFitVolume;
}

interface MtraSetupState {
  suggestionsContainer: HTMLElement;
  suggestionsList: Element;
}

/** 在 MTRA 缓冲区中键入 ticker 并等待建议列表出现（带超时）。 */
async function setupMtraBuffer(tile: PrunTile, ticker: string) {
  await clickElement(tile.anchor as HTMLElement);
  window.getSelection()?.removeAllRanges();

  const container = await withTimeout($(tile.anchor, C.MaterialSelector.container), MTRA_TIMEOUT);
  const input = (await withTimeout($(container, 'input'), MTRA_TIMEOUT)) as HTMLInputElement;
  const suggestionsContainer = await withTimeout(
    $(container, C.MaterialSelector.suggestionsContainer),
    MTRA_TIMEOUT,
  );

  let suggestionsList: Element | undefined;
  for (let attempt = 0; attempt < 15; attempt++) {
    await clickElement(input);
    focusElement(input);
    input.focus();
    changeInputValue(input, ticker);
    window.getSelection()?.removeAllRanges();
    // 自适应等待：直到建议列表渲染出该 ticker 的条目（每 25ms 检查，单次最多 150ms），
    // 比固定 150ms 睡眠更快；以条目出现而非列表容器出现为完成信号，避免读到旧条目。
    for (let i = 0; i < 6; i++) {
      const list = _$(container, C.MaterialSelector.suggestionsList);
      if (
        list &&
        _$$(list, C.MaterialSelector.suggestionEntry).some(
          x => _$(x, C.ColoredIcon.label)?.textContent === ticker,
        )
      ) {
        suggestionsList = list;
        break;
      }
      await new Promise(r => setTimeout(r, 25));
    }
    if (suggestionsList) {
      break;
    }
  }
  if (!suggestionsList) {
    throw new Error('MTRA_NO_SUGGESTIONS');
  }

  return { container, input, suggestionsContainer, suggestionsList } as MtraSetupState;
}

/** 等待数量滑块（rc-slider-mark-text）异步渲染后返回最大可转移量。 */
export async function waitSliderMaxAmount(tile: PrunTile): Promise<number> {
  // 数量滑块的刻度在选择材料后异步渲染。clickElement 只 await sleep(0)，
  // 刻度可能尚未挂载，此时 _$$(...) 返回空数组，Math.max(...[]) = -Infinity，
  // 会把 "-Infinity" 写入数量输入框并提交。因此带超时重试等待刻度，并过滤掉非有限值。
  let sliderNumbers: number[] = [];
  for (let attempt = 0; attempt < 15; attempt++) {
    sliderNumbers = _$$(tile.anchor, 'rc-slider-mark-text')
      .map(x => Number(x.textContent ?? 0))
      .filter(n => Number.isFinite(n));
    if (sliderNumbers.length > 0) {
      break;
    }
    // 25ms 轮询（刻度通常在一个渲染周期内出现），比固定 100ms 快得多。
    await new Promise(r => setTimeout(r, 25));
  }
  return sliderNumbers.length > 0 ? Math.max(...sliderNumbers) : 0;
}

function findAmountInput(tile: PrunTile) {
  return _$$(tile.anchor, 'input')[1] as HTMLInputElement | undefined;
}

export type MtraPrepareError =
  'MTRA_TIMEOUT' | 'MTRA_NO_SUGGESTIONS' | 'MTRA_SLIDER_EMPTY' | 'MTRA_NO_AMOUNT_INPUT';

export interface MtraPreparation {
  maxAmount: number;
  amountInput: HTMLInputElement;
  transferButton: HTMLElement;
}

/**
 * 完整准备一个 MTRA 窗口：键入 ticker、选择材料、等待滑块、找到数量输入框与转移按钮。
 * 键入阶段带超时重试；返回错误码而非抛出，由调用方决定跳过或失败。
 */
export async function prepareMtraWindow(
  tile: PrunTile,
  ticker: string,
  onRetry?: (retry: number) => void,
): Promise<MtraPreparation | MtraPrepareError> {
  let state: MtraSetupState | undefined;
  for (let retry = 0; retry < MTRA_MAX_RETRIES; retry++) {
    try {
      state = await setupMtraBuffer(tile, ticker);
      break;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg === 'MTRA_TIMEOUT' || msg === 'MTRA_NO_SUGGESTIONS') {
        onRetry?.(retry);
        continue;
      }
      throw e;
    }
  }
  if (!state) {
    return 'MTRA_TIMEOUT';
  }

  const { suggestionsContainer, suggestionsList } = state;
  suggestionsContainer.style.display = 'none';
  const match = _$$(suggestionsList, C.MaterialSelector.suggestionEntry).find(
    x => _$(x, C.ColoredIcon.label)?.textContent === ticker,
  );
  if (!match) {
    suggestionsContainer.style.display = '';
    return 'MTRA_NO_SUGGESTIONS';
  }

  await clickElement(match);
  suggestionsContainer.style.display = '';

  const maxAmount = await waitSliderMaxAmount(tile);
  if (maxAmount === 0) {
    return 'MTRA_SLIDER_EMPTY';
  }
  const amountInput = findAmountInput(tile);
  if (!amountInput) {
    return 'MTRA_NO_AMOUNT_INPUT';
  }
  const transferButton = await $(tile.anchor, C.Button.btn);
  return { maxAmount, amountInput, transferButton };
}

/** 按滑块上限钳制转移量；超出时记 warning，无可转移量时返回 0。 */
export function clampTransferAmount(
  amount: number,
  maxAmount: number,
  ticker: string,
  log: Logger,
): number {
  if (amount > maxAmount) {
    const leftover = amount - maxAmount;
    log.warning(
      `${fixed0(leftover)} ${ticker} 未转移 ` + `（已转移 ${fixed0(maxAmount)}/${fixed0(amount)}）`,
    );
    if (maxAmount === 0) {
      return 0;
    }
  }
  return Math.min(amount, maxAmount);
}

/** 目标仓中某材料当前数量的响应式读取（computed）。 */
export function getDestAmount(toId: string, ticker: string) {
  return computed(() => {
    const store = storagesStore.getById(toId);
    return (
      store?.items
        .map(x => x.quantity ?? undefined)
        .filter(x => x !== undefined)
        .find(x => x.material.ticker === ticker)?.amount ?? 0
    );
  });
}
