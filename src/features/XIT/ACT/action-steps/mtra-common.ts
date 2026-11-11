import { C } from '@src/infrastructure/prun-ui/prun-css';
import { changeInputValue, clickElement, focusElement } from '@src/utils/dom';
import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { closePrunWindow } from '@src/infrastructure/prun-ui/utils/close-prun-window';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getMaterialName } from '@src/infrastructure/prun-ui/i18n';
import { Logger } from '@src/features/XIT/ACT/runner/logger';
import { fixed0 } from '@src/utils/format';
import { sleep } from '@src/utils/sleep';

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

const SUGGESTIONS_CONTAINER_SELECTOR = '[class*="suggestionsContainer"]';
const SUGGESTIONS_LIST_SELECTOR =
  '[role="listbox"], [class*="suggestionsList"], [class*="suggestionsContainer"]';

function waitForElement<T>(find: () => T | undefined, timeout: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const attempt = () => {
      const value = find();
      if (value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error('MTRA_TIMEOUT'));
        return;
      }
      setTimeout(attempt, 25);
    };
    attempt();
  });
}

/**
 * 材料输入框。不使用具体 CSS 类名定位：游戏更新会重排选择器（下拉列表被移出
 * 窗口以避开裁剪），按 aria-autocomplete / combobox 特征查找更稳定。
 */
async function waitForMaterialInput(anchor: HTMLElement) {
  try {
    return await waitForElement(() => {
      const container =
        anchor.querySelector<HTMLElement>('[class*="MaterialSelector__container"]') ?? undefined;
      return (
        container?.querySelector<HTMLInputElement>('input') ??
        anchor.querySelector<HTMLInputElement>(
          'input[aria-autocomplete], [role="combobox"] input, input[role="combobox"]',
        ) ??
        anchor.querySelector<HTMLInputElement>('input') ??
        undefined
      );
    }, MTRA_TIMEOUT);
  } catch {
    throw new Error('MTRA_NO_INPUT');
  }
}

/** react-autosuggest 可能把建议列表渲染到窗口外的 portal，因此从文档级查找。 */
function suggestionListCandidates(input: HTMLInputElement) {
  const combobox = input.closest('[role="combobox"]');
  const controlsId = combobox?.getAttribute('aria-controls') ?? input.getAttribute('aria-controls');
  const controlled = controlsId ? document.getElementById(controlsId) : null;
  const candidates = Array.from(document.querySelectorAll(SUGGESTIONS_LIST_SELECTOR));
  return controlled ? [controlled as Element, ...candidates] : candidates;
}

function normalizeSuggestionText(text: string) {
  return text.replace(/\s+/g, ' ').trim().toUpperCase();
}

function suggestionText(entry: Element) {
  const label = entry.querySelector('[class*="ColoredIcon__label"]');
  return normalizeSuggestionText(label?.textContent ?? entry.textContent ?? '');
}

function containsToken(text: string, token: string) {
  const index = text.indexOf(token);
  if (index < 0) {
    return false;
  }
  const isWordChar = (char: string | undefined) => char !== undefined && /[A-Z0-9]/.test(char);
  return !isWordChar(text[index - 1]) && !isWordChar(text[index + token.length]);
}

/** 命中顺序：精确 ticker → `<TICKER> 名称` → 文本含 ticker 记号 → 本地化名称。 */
function findSuggestionEntry(list: Element, ticker: string) {
  const entries = Array.from(
    list.querySelectorAll('[class*="suggestionEntry"], li, [role="option"]'),
  );
  if (entries.length === 0) {
    return undefined;
  }
  const material = materialsStore.getByTicker(ticker);
  const localizedName = material ? getMaterialName(material) : undefined;
  const localized = localizedName ? normalizeSuggestionText(localizedName) : undefined;
  const tk = normalizeSuggestionText(ticker);
  const texts = entries.map(x => ({ entry: x, text: suggestionText(x) }));
  return (
    texts.find(x => x.text === tk)?.entry ??
    texts.find(x => x.text.split(' ')[0] === tk)?.entry ??
    texts.find(x => containsToken(x.text, tk))?.entry ??
    (localized
      ? (texts.find(x => x.text === localized)?.entry ??
        texts.find(x => x.text.includes(localized))?.entry)
      : undefined)
  );
}

function findSuggestionsList(input: HTMLInputElement, ticker: string) {
  return suggestionListCandidates(input).find(x => findSuggestionEntry(x, ticker) !== undefined);
}

interface MtraSetupState {
  input: HTMLInputElement;
  suggestionsContainer: HTMLElement | undefined;
  suggestionsList: Element;
}

/** 在 MTRA 缓冲区中键入 ticker 并等待建议列表出现（带超时）。 */
async function setupMtraBuffer(anchor: HTMLElement, ticker: string): Promise<MtraSetupState> {
  await clickElement(anchor);
  window.getSelection()?.removeAllRanges();

  const input = await waitForMaterialInput(anchor);

  let suggestionsList: Element | undefined;
  for (let attempt = 0; attempt < 15 && !suggestionsList; attempt++) {
    await clickElement(input);
    focusElement(input);
    input.focus();
    changeInputValue(input, ticker);
    window.getSelection()?.removeAllRanges();
    // 自适应等待：直到建议列表渲染出该 ticker 的条目（每 25ms 检查，单次最多 150ms），
    // 比固定 150ms 睡眠更快；以条目出现而非列表容器出现为完成信号，避免读到旧条目。
    for (let i = 0; i < 6; i++) {
      suggestionsList = findSuggestionsList(input, ticker);
      if (suggestionsList) {
        break;
      }
      await sleep(25);
    }
  }
  if (!suggestionsList) {
    const hasList = document.querySelector(SUGGESTIONS_LIST_SELECTOR) !== null;
    throw new Error(hasList ? 'MTRA_NO_SUGGESTIONS' : 'MTRA_TIMEOUT');
  }

  const suggestionsContainer =
    suggestionsList.closest<HTMLElement>(SUGGESTIONS_CONTAINER_SELECTOR) ?? undefined;
  return { input, suggestionsContainer, suggestionsList };
}

/** 等待数量滑块（rc-slider-mark-text）异步渲染后返回最大可转移量。 */
export async function waitSliderMaxAmount(anchor: HTMLElement): Promise<number> {
  // 数量滑块的刻度在选择材料后异步渲染。clickElement 只 await sleep(0)，
  // 刻度可能尚未挂载，此时 _$$(...) 返回空数组，Math.max(...[]) = -Infinity，
  // 会把 "-Infinity" 写入数量输入框并提交。因此带超时重试等待刻度，并过滤掉非有限值。
  let sliderNumbers: number[] = [];
  for (let attempt = 0; attempt < 15; attempt++) {
    sliderNumbers = _$$(anchor, 'rc-slider-mark-text')
      .map(x => Number(x.textContent ?? 0))
      .filter(n => Number.isFinite(n));
    if (sliderNumbers.length > 0) {
      break;
    }
    // 25ms 轮询（刻度通常在一个渲染周期内出现），比固定 100ms 快得多。
    await sleep(25);
  }
  return sliderNumbers.length > 0 ? Math.max(...sliderNumbers) : 0;
}

function findAmountInput(anchor: HTMLElement, materialInput: HTMLInputElement) {
  const inputs = _$$(anchor, 'input') as HTMLInputElement[];
  const isMaterialLike = (x: HTMLInputElement) =>
    x === materialInput ||
    x.getAttribute('aria-autocomplete') !== null ||
    x.getAttribute('role') === 'combobox' ||
    x.closest('[role="combobox"]') !== null;
  return (
    inputs.find(x => !isMaterialLike(x) && (x.type === 'text' || x.type === 'number')) ??
    inputs.find(x => !isMaterialLike(x))
  );
}

export type MtraPrepareError =
  | 'MTRA_TIMEOUT'
  | 'MTRA_NO_INPUT'
  | 'MTRA_NO_SUGGESTIONS'
  | 'MTRA_SLIDER_EMPTY'
  | 'MTRA_NO_AMOUNT_INPUT'
  | 'MTRA_SELECT_FAILED';

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
  anchor: HTMLElement,
  ticker: string,
  onRetry?: (retry: number) => void,
): Promise<MtraPreparation | MtraPrepareError> {
  let state: MtraSetupState | undefined;
  let lastError: MtraPrepareError = 'MTRA_TIMEOUT';
  for (let retry = 0; retry < MTRA_MAX_RETRIES; retry++) {
    try {
      state = await setupMtraBuffer(anchor, ticker);
      break;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (msg === 'MTRA_TIMEOUT' || msg === 'MTRA_NO_INPUT' || msg === 'MTRA_NO_SUGGESTIONS') {
        lastError = msg;
        onRetry?.(retry);
        continue;
      }
      throw e;
    }
  }
  if (!state) {
    return lastError;
  }

  const { input, suggestionsContainer, suggestionsList } = state;
  const entry = findSuggestionEntry(suggestionsList, ticker);
  if (!entry) {
    return 'MTRA_NO_SUGGESTIONS';
  }
  if (
    !(await selectSuggestion(input, suggestionsList, entry as HTMLElement, suggestionsContainer))
  ) {
    return 'MTRA_SELECT_FAILED';
  }

  const maxAmount = await waitSliderMaxAmount(anchor);
  if (maxAmount === 0) {
    return 'MTRA_SLIDER_EMPTY';
  }
  const amountInput = findAmountInput(anchor, input);
  if (!amountInput) {
    return 'MTRA_NO_AMOUNT_INPUT';
  }
  const transferButton = await $(anchor, C.Button.btn);
  return { maxAmount, amountInput, transferButton };
}

/**
 * 选中建议条目。react-autowhatever 只认原生 click（完整鼠标序列会只高亮不选中），
 * 因此先原生 click，未提交再退回 clickElement；以列表卸载或输入值被替换为提交信号。
 */
async function selectSuggestion(
  input: HTMLInputElement,
  list: Element,
  entry: HTMLElement,
  suggestionsContainer: HTMLElement | undefined,
) {
  const typedValue = input.value;
  const committed = () => !list.isConnected || input.value !== typedValue;
  if (suggestionsContainer) {
    suggestionsContainer.style.display = 'none';
  }
  try {
    entry.click();
    for (let i = 0; i < 8; i++) {
      if (committed()) {
        return true;
      }
      await sleep(25);
    }
    await clickElement(entry);
    for (let i = 0; i < 8; i++) {
      if (committed()) {
        return true;
      }
      await sleep(25);
    }
    return false;
  } finally {
    if (suggestionsContainer) {
      suggestionsContainer.style.display = '';
    }
  }
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
