import { showBuffer } from '@src/infrastructure/prun-ui/buffers';
import { selectAddress } from '@src/infrastructure/prun-ui/utils/select-address';
import {
  findFormSlider,
  getSliderValue,
  setSliderValue,
  sliderValueFromPercent,
} from '@src/infrastructure/prun-ui/utils/set-slider-value';
import { changeInputValue, changeSelectIndex, clickElement } from '@src/utils/dom';
import { sleep } from '@src/utils/sleep';
import { isWaypointPercent, type NativeRouteStep } from './native-route-plan';

const routeIdPattern = /^RT-[A-Z0-9]+-\d+$/i;
const chineseLabels: Record<string, readonly string[]> = {
  'CREATE ROUTE': ['创建航线'],
  'ADD WAYPOINT': ['添加路径点', '添加航点'],
  'ENTER LOCATION': ['输入目标位置', '输入地点', '输入位置'],
  LOAD: ['装货', '装载'],
  UNLOAD: ['卸船', '卸货', '卸载'],
  REFUEL: ['加油', '补充燃料'],
  EDIT: ['编辑'],
  'EDIT STEP': ['编辑步骤'],
  'EDIT LOAD STEP': ['编辑装货步骤', '编辑装载步骤'],
  'EDIT UNLOAD STEP': ['编辑卸船步骤', '编辑卸货步骤', '编辑卸载步骤'],
  'EDIT REFUEL STEP': ['编辑加油步骤', '编辑补充燃料步骤'],
  'EDIT WAYPOINT': ['编辑路径点', '编辑航点'],
  'FUEL USAGE': ['燃料消耗'],
  'REACTOR USAGE': ['反应堆使用量'],
  SAVE: ['保存'],
  LOOP: ['循环'],
  MINIMUM: ['至少', '最小', '最小值', '最低'],
  MAXIMUM: ['至多', '最大', '最大值', '最高'],
  'MINIMUM UNITS': ['最少单位数', '最小单位', '最少单位', '最小数量', '最小 单位', '最少 单位'],
  'MAXIMUM UNITS': ['最大单位数', '最大单位', '最多单位', '最大数量', '最大 单位', '最多 单位'],
  UNITS: ['单位', '数量'],
  CAPACITY: ['最大容量', '容量'],
  'STL TANK': ['STL 油箱', 'STL 燃料箱'],
  'FTL TANK': ['FTL 油箱', 'FTL 燃料箱'],
  'LOCAL STORE': ['本地仓库', '当地仓库', '本地储存'],
};

type RtTile = Pick<PrunTile, 'anchor' | 'frame'> & { window: Element };

async function waitForRt<T>(read: () => T | undefined, message: string): Promise<T> {
  const deadline = Date.now() + 8000;
  do {
    const result = read();
    if (result !== undefined) {
      return result;
    }
    // 20ms 轮询：原生 RT 的更新多数是服务器往返（数百 ms），再快也只是空转；
    // 但比 50ms 少等一档，长航线累计可观。
    await sleep(20);
  } while (Date.now() < deadline);
  throw new Error(message);
}

// 自动填写期间把原生窗口移出视线（transform 不影响布局，也不影响
// getBoundingClientRect —— 滑块写入仍按矩形坐标计算）。停止/结束时恢复。
// 用属性 + `!important` 样式表而不是内联 style：游戏窗口重排时会重写内联 style，
// 内联写法会被冲掉。
const PARK_ATTRIBUTE = 'data-rprun-parked';
let parkStyle: HTMLStyleElement | undefined;

export function parkWindow(window: Element) {
  if (!(window instanceof HTMLElement)) {
    return;
  }
  if (parkStyle === undefined) {
    parkStyle = document.createElement('style');
    parkStyle.textContent = `[${PARK_ATTRIBUTE}] { transform: translate(-200vw, -200vh) !important; }`;
    document.head.appendChild(parkStyle);
  }
  window.setAttribute(PARK_ATTRIBUTE, '');
}

export function unparkWindow(window: Element) {
  if (window instanceof HTMLElement) {
    window.removeAttribute(PARK_ATTRIBUTE);
  }
}

function normalizeLabel(text: string | null | undefined) {
  return (text ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
}

function labelVariants(name: string) {
  const normalized = normalizeLabel(name);
  return [normalized, ...(chineseLabels[normalized] ?? [])];
}

function matchesLabel(text: string | null | undefined, name: string) {
  return labelVariants(name).includes(normalizeLabel(text));
}

function matchesControl(element: Element, name: string) {
  return [
    element.getAttribute('aria-label'),
    element.getAttribute('title'),
    element.textContent,
  ].some(x => matchesLabel(x, name));
}

function label(element: Element) {
  return normalizeLabel(
    element.getAttribute('aria-label') ?? element.getAttribute('title') ?? element.textContent,
  );
}

function controls(root: Element) {
  return Array.from(
    root.querySelectorAll<HTMLElement>(`button, a, [role="button"], .${C.Button.btn}`),
  );
}

function innermostControls(matches: HTMLElement[]) {
  return matches.filter(x => !matches.some(other => x !== other && x.contains(other)));
}

function control(root: Element, name: string, visibleOnly = true) {
  const matches = controls(root).filter(
    x => matchesControl(x, name) && (!visibleOnly || x.getClientRects().length > 0),
  );
  // A styled wrapper and its inner button can represent the same control.
  const leaves = innermostControls(matches);
  return leaves.length === 1 ? leaves[0] : undefined;
}

function enabled(element: HTMLElement) {
  return (
    !element.matches(':disabled, [aria-disabled="true"]') &&
    !element.classList.contains(C.Button.disabled)
  );
}

async function clickControl(root: Element, name: string) {
  const button = control(root, name);
  if (button === undefined || !enabled(button)) {
    throw new Error(`找不到可用的 RT 控件 ${name}。`);
  }
  await clickElement(button);
}

function routeIds(root: Element) {
  const ids = Array.from(root.querySelectorAll('*'), x =>
    (x.textContent ?? '').trim().toUpperCase(),
  );
  return new Set(ids.filter(x => routeIdPattern.test(x)));
}

function liveCommand(frame: Element) {
  return normalizeLabel(_$(frame, C.TileFrame.cmd)?.textContent);
}

function findRtTile(window: Element, command: string): RtTile | undefined {
  for (const frame of _$$(window, C.TileFrame.frame)) {
    const anchor = _$(frame, C.TileFrame.anchor);
    if (
      frame instanceof HTMLDivElement &&
      anchor instanceof HTMLDivElement &&
      liveCommand(frame) === command
    ) {
      return { frame, anchor, window };
    }
  }
  return undefined;
}

async function waitForRtTile(window: Element, command: string, button: string) {
  let lastTile: RtTile | undefined;
  try {
    return await waitForRt(() => {
      lastTile = findRtTile(window, command);
      return lastTile !== undefined && control(lastTile.frame, button) !== undefined
        ? lastTile
        : undefined;
    }, `原生 ${command} 窗口未就绪。`);
  } catch (err) {
    const warning = _$(window, C.Tile.warning)?.textContent?.trim();
    if (warning) {
      throw new Error(`原生 ${command}：${warning}`);
    }
    if (lastTile === undefined) {
      throw err;
    }
    const labels = [
      ...new Set(
        controls(lastTile.frame)
          .filter(x => x.getClientRects().length > 0)
          .map(label)
          .filter(x => x !== ''),
      ),
    ].slice(0, 8);
    throw new Error(
      `原生 ${command} 已打开，但无法定位 ${labelVariants(button).join(' / ')}。可见控件：${labels.join('、') || '无'}。`,
    );
  }
}

export function nativeRouteRepeats(tile: RtTile) {
  const toggle = _$$(tile.frame, C.RadioItem.container).find(x =>
    matchesLabel(x.textContent, 'LOOP'),
  );
  const indicator = toggle === undefined ? undefined : _$(toggle, C.RadioItem.indicator);
  if (indicator !== undefined) {
    return indicator.classList.contains(C.RadioItem.active);
  }
  const accessible = Array.from(tile.frame.querySelectorAll('[role="switch"]')).find(x =>
    matchesControl(x, 'LOOP'),
  );
  const checked = accessible?.getAttribute('aria-checked');
  return checked === 'true' ? true : checked === 'false' ? false : undefined;
}

export async function openRouteList(reopen = false) {
  const window = await showBuffer('RT', { force: reopen });
  return await waitForRtTile(window, 'RT', 'CREATE ROUTE');
}

export async function createNativeRoute(list: RtTile) {
  if (findRtTile(list.window, 'RT')?.frame !== list.frame) {
    throw new Error('原生 RT 列表已关闭或切换。');
  }
  const before = routeIds(list.anchor);
  await clickControl(list.frame, 'CREATE ROUTE');
  return await waitForRt(() => {
    for (const frame of _$$(list.window, C.TileFrame.frame)) {
      const id = liveCommand(frame).match(/^RT (\S+)$/)?.[1];
      if (id !== undefined && routeIdPattern.test(id) && !before.has(id)) {
        return id;
      }
    }
    const currentList = findRtTile(list.window, 'RT');
    const added =
      currentList === undefined
        ? []
        : [...routeIds(currentList.anchor)].filter(x => !before.has(x));
    return added.length === 1 ? added[0] : undefined;
  }, '未能确认新航线 ID，请在原生 RT 列表核对。');
}

export async function openNativeRoute(id: string) {
  const command = `RT ${id}`;
  const window = await showBuffer(command);
  const tile = await waitForRtTile(window, command, 'ADD WAYPOINT');
  await dismissSuccess(tile);
  return tile;
}

export function isNativeRouteOpen(tile: RtTile, id: string) {
  return findRtTile(tile.window, `RT ${id}`)?.anchor === tile.anchor;
}

// 航线名（产业链名称）。游戏没有单独的改名按钮：点标题区会切换成输入框，
// 没有输入框出现时返回 false，由调用方提示玩家手动改名。
export async function nameNativeRoute(tile: RtTile, name: string) {
  const target = name.trim();
  if (target === '') {
    return false;
  }
  const header = _$(tile.anchor, '[class*="Route__name"]');
  if (header === undefined) {
    return false;
  }
  if (normalizeLabel(header.textContent) === normalizeLabel(target)) {
    return true;
  }
  await clickElement(header instanceof HTMLElement ? header : undefined);
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    const input = Array.from(tile.anchor.querySelectorAll('input')).find(
      x => x.getClientRects().length > 0 && x.type !== 'search',
    );
    if (input !== undefined) {
      changeInputValue(input, target);
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
      input.blur();
      await dismissSuccess(tile);
      return normalizeLabel(header.textContent) === normalizeLabel(target);
    }
    await sleep(20);
  }
  return false;
}

export async function prepareWaypoint(tile: RtTile, location: string) {
  const fields = _$$(tile.anchor, C.AddressSelector.input).filter(
    (x): x is HTMLInputElement => x instanceof HTMLInputElement && x.getClientRects().length > 0,
  );
  const named = fields.filter(x => matchesLabel(x.placeholder, 'ENTER LOCATION'));
  const input = named.length === 1 ? named[0] : fields.length === 1 ? fields[0] : undefined;
  const container = input?.closest(`.${C.AddressSelector.container}`);
  if (input === undefined || container == null) {
    throw new Error('找不到 RT 的地址选择器。');
  }
  if (input.value !== '') {
    changeInputValue(input, '');
    await sleep(0);
  }
  if (!(await selectAddress(container, location, { allowPartial: false }))) {
    throw new Error(`无法确认航点 ${location}。`);
  }
  const button = await waitForRt(() => {
    const button = control(tile.frame, 'ADD WAYPOINT');
    return button !== undefined && enabled(button) && !button.classList.contains(C.Button.neutral)
      ? button
      : undefined;
  }, `航点 ${location} 尚未就绪。`);
  return { input, value: input.value, button };
}

function matchesAddress(element: Element, names: string[]) {
  const text = element instanceof HTMLElement ? element.innerText : (element.textContent ?? '');
  return names.some(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Z0-9])${escaped}([^A-Z0-9]|$)`, 'i').test(text);
  });
}

function waypointDestinations(anchor: Element, names: string[]) {
  return _$$(anchor, C.Waypoint.destination).filter(x => matchesAddress(x, names));
}

export async function addWaypoint(
  tile: RtTile,
  prepared: Awaited<ReturnType<typeof prepareWaypoint>>,
  names: string[],
) {
  if (
    !prepared.input.isConnected ||
    prepared.input.value !== prepared.value ||
    control(tile.frame, 'ADD WAYPOINT') !== prepared.button ||
    !enabled(prepared.button)
  ) {
    throw new Error('航点选择已变化，请在原生 RT 核对。');
  }
  const occurrence = waypointDestinations(tile.anchor, names).length;
  await clickElement(prepared.button);
  const find = () => {
    const destinations = waypointDestinations(tile.anchor, names);
    return destinations.length === occurrence + 1 ? destinations[occurrence] : undefined;
  };
  await waitForRt(find, `未能确认航点 ${names[0]} 已添加。`);
  await dismissSuccess(tile);
  return find;
}

function stepEdits(root: Element) {
  const matches = controls(root).filter(
    x => matchesControl(x, 'EDIT') || matchesControl(x, 'EDIT STEP'),
  );
  return innermostControls(matches);
}

function findStepButton(waypoint: Awaited<ReturnType<typeof addWaypoint>>, command: string) {
  const row = waypoint()?.closest(`.${C.Waypoint.waypoint}`);
  const toolbar = row == null ? undefined : _$(row, C.Waypoint.commandsSteps);
  if (toolbar === undefined) {
    return undefined;
  }
  const button = control(toolbar, command) ?? control(toolbar, command, false);
  return button !== undefined && enabled(button) ? button : undefined;
}

export class NativeStepButtonUnavailable extends Error {}

function waitForNativeStepButton(
  tile: RtTile,
  find: () => HTMLElement | undefined,
  signal: AbortSignal,
  command: string,
) {
  return new Promise<HTMLElement | undefined>((resolve, reject) => {
    if (signal.aborted) {
      resolve(undefined);
      return;
    }
    const stop = () => finish(undefined);
    const observer = new MutationObserver(check);
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new NativeStepButtonUnavailable(
          `找不到当前航点的 ${labelVariants(command).join(' / ')} 按钮。`,
        ),
      );
    }, 8000);
    function check() {
      const button = find();
      if (button !== undefined) {
        finish(button);
      }
    }
    function cleanup() {
      clearTimeout(timeout);
      observer.disconnect();
      signal.removeEventListener('abort', stop);
    }
    function finish(button: HTMLElement | undefined) {
      cleanup();
      resolve(button);
    }
    signal.addEventListener('abort', stop, { once: true });
    observer.observe(tile.anchor, { childList: true, subtree: true, attributes: true });
    check();
  });
}

export async function addNativeStep(
  tile: RtTile,
  waypoint: Awaited<ReturnType<typeof addWaypoint>>,
  step: NativeRouteStep,
  options: { signal: AbortSignal; onWaiting: (waiting: boolean) => void },
) {
  const command = step.kind.toUpperCase();
  const routeCommand = liveCommand(tile.frame);
  const find = () =>
    tile.anchor.isConnected && liveCommand(tile.frame) === routeCommand
      ? findStepButton(waypoint, command)
      : undefined;
  let button = find();
  if (button === undefined) {
    const address = waypoint();
    address?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    address?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    options.onWaiting(true);
    try {
      button = await waitForNativeStepButton(tile, find, options.signal, command);
    } finally {
      options.onWaiting(false);
    }
  }
  if (options.signal.aborted || button === undefined || button !== find()) {
    return undefined;
  }
  const before = new Set(stepEdits(tile.anchor));
  button.click();
  return await waitForRt(() => {
    const edits = stepEdits(tile.anchor);
    const added = edits.filter(x => !before.has(x));
    return edits.length === before.size + 1 && added.length === 1 ? added[0] : undefined;
  }, `未能确认新增的 ${command} 步骤，请在原生 RT 核对。`);
}

function editorFor(tile: RtTile, step: NativeRouteStep) {
  return editorWithTitle(tile, `EDIT ${step.kind.toUpperCase()} STEP`);
}

function editorWithTitle(tile: RtTile, title: string) {
  const heading = Array.from(tile.anchor.querySelectorAll('*'))
    .filter(x => matchesLabel(x.textContent, title))
    .at(-1);
  let editor = heading?.parentElement;
  while (editor !== undefined && editor !== null && editor !== tile.anchor) {
    if (control(editor, 'SAVE') !== undefined) {
      return editor;
    }
    editor = editor.parentElement;
  }
  return undefined;
}

const waypointEditorTitle = 'EDIT WAYPOINT';

export async function openNativeWaypointEditor(
  tile: RtTile,
  target: Awaited<ReturnType<typeof addWaypoint>>,
) {
  const row = target()?.closest(`.${C.Waypoint.waypoint}`);
  const edit = row == null ? undefined : control(row, waypointEditorTitle, false);
  if (
    edit === undefined ||
    !enabled(edit) ||
    editorWithTitle(tile, waypointEditorTitle) !== undefined
  ) {
    throw new Error('找不到当前航点的编辑按钮，或已有航点编辑器打开。');
  }
  edit.click();
  return await waitForRt(
    () => editorWithTitle(tile, waypointEditorTitle),
    '原生航点编辑器未打开。',
  );
}

function waypointFuelSlider(editor: HTMLElement) {
  return findFormSlider(editor, labelVariants('FUEL USAGE'));
}

// 反应堆使用量滑块只在部分航点编辑器里出现（系内/纯网关航段不适用时游戏可能不渲染），
// 找不到就只写燃料消耗。
function waypointReactorSlider(editor: HTMLElement) {
  return findFormSlider(editor, labelVariants('REACTOR USAGE'));
}

export async function fillNativeWaypointFuel(
  tile: RtTile,
  editor: HTMLElement,
  percent: number,
  reactorPercent?: number,
) {
  if (editorWithTitle(tile, waypointEditorTitle) !== editor || !isWaypointPercent(percent)) {
    throw new Error('航点编辑器已变化，或燃料消耗超出 1–100%。');
  }
  if (reactorPercent !== undefined && !isWaypointPercent(reactorPercent)) {
    throw new Error('反应堆使用量必须为 1–100% 的整数。');
  }
  const slider = await waitForRt(() => waypointFuelSlider(editor), '找不到航点的燃料消耗滑块。');
  const fuelTarget = sliderValueFromPercent(slider, percent);
  if (
    getSliderValue(slider) !== fuelTarget &&
    !(await setSliderValue(slider, fuelTarget, { exactMaximum: true }))
  ) {
    throw new Error(`燃料消耗未能设置为 ${percent}%。`);
  }
  if (reactorPercent === undefined) {
    return;
  }
  const reactor = await waitForRt(
    () => waypointReactorSlider(editor),
    '找不到航点的反应堆使用量滑块。',
  );
  const target = sliderValueFromPercent(reactor, reactorPercent);
  if (
    getSliderValue(reactor) !== target &&
    !(await setSliderValue(reactor, target, { exactMaximum: true }))
  ) {
    throw new Error(`反应堆使用量未能设置为 ${reactorPercent}%。`);
  }
}

export async function saveNativeWaypointFuel(
  tile: RtTile,
  editor: HTMLElement,
  percent: number,
  reactorPercent?: number,
) {
  const slider = waypointFuelSlider(editor);
  const fuelCurrent = slider === undefined ? undefined : getSliderValue(slider);
  if (
    slider === undefined ||
    fuelCurrent === undefined ||
    Math.abs(fuelCurrent - sliderValueFromPercent(slider, percent)) >= 0.01
  ) {
    throw new Error(`保存前的燃料消耗与计划的 ${percent}% 不一致。`);
  }
  if (reactorPercent !== undefined) {
    const reactor = waypointReactorSlider(editor);
    const current = reactor === undefined ? undefined : getSliderValue(reactor);
    if (
      reactor === undefined ||
      current === undefined ||
      Math.abs(current - sliderValueFromPercent(reactor, reactorPercent)) >= 0.01
    ) {
      throw new Error(`保存前的反应堆使用量与计划的 ${reactorPercent}% 不一致。`);
    }
  }
  await saveNativeEditor(tile, editor, () => editorWithTitle(tile, waypointEditorTitle));
}

export async function openNativeStep(tile: RtTile, edit: HTMLElement, step: NativeRouteStep) {
  if (!tile.anchor.contains(edit) || editorFor(tile, step) !== undefined) {
    throw new Error('新增步骤已变化，请在原生 RT 核对。');
  }
  await clickElement(edit);
  return await waitForRt(() => editorFor(tile, step), '原生步骤编辑器未打开。');
}

export async function fillNativeStep(tile: RtTile, editor: HTMLElement, step: NativeRouteStep) {
  if (editorFor(tile, step) !== editor) {
    throw new Error('原生步骤编辑器已变化。');
  }
  if (step.kind === 'refuel') {
    await chooseOption(editor, `${step.tank} tank`);
    await chooseOption(editor, 'local store');
    await setLimit(editor, 'Minimum', 'capacity');
    await setLimit(editor, 'Maximum', 'capacity');
  } else {
    await selectMaterial(editor, step.ticker);
    // Set maximum first so a quantity above the native default stays valid.
    await setLimit(editor, 'Maximum', step.amount);
    await setLimit(editor, 'Minimum', step.amount);
  }
}

export async function saveNativeStep(tile: RtTile, editor: HTMLElement, step: NativeRouteStep) {
  await saveNativeEditor(tile, editor, () => editorFor(tile, step));
}

async function saveNativeEditor(
  tile: RtTile,
  editor: HTMLElement,
  find: () => HTMLElement | undefined,
) {
  if (find() !== editor) {
    throw new Error('原生编辑器已变化。');
  }
  await clickControl(editor, 'SAVE');
  await waitForRt(
    () => (find() === undefined ? true : undefined),
    '原生编辑器未关闭，请核对保存结果。',
  );
  await dismissSuccess(tile);
}

async function dismissSuccess(tile: RtTile) {
  // 服务器反馈是异步的：成功提示会一直停留到被点掉，失败提示常驻。
  // 旧实现固定 sleep(150) 再轮询「处理中是否消失」，每个动作白等一档；
  // 这里直接等成功/失败出现，并给「本次根本没有反馈」的情形留一段短防抖。
  const deadline = Date.now() + 8000;
  let idleSince: number | undefined;
  while (Date.now() < deadline) {
    const error = _$(tile.frame, C.ActionFeedback.error);
    if (error !== undefined) {
      throw new Error(error.textContent?.trim() || '游戏拒绝了 RT 写入。');
    }
    const success = _$(tile.frame, C.ActionFeedback.success);
    const progress = _$(tile.frame, C.ActionFeedback.progress);
    if (success !== undefined && progress === undefined) {
      await clickElement(success);
      return;
    }
    if (success === undefined && progress === undefined) {
      idleSince ??= Date.now();
      if (Date.now() - idleSince >= 250) {
        return;
      }
    } else {
      idleSince = undefined;
    }
    await sleep(20);
  }
  throw new Error('原生 RT 仍在处理上一次操作，请核对结果。');
}

async function chooseOption(editor: HTMLElement, option: string) {
  for (const select of editor.querySelectorAll('select')) {
    const index = Array.from(select.options).findIndex(x => matchesLabel(x.text, option));
    if (index >= 0) {
      changeSelectIndex(select, index);
      return;
    }
  }
  await clickExactText(editor, option);
}

async function clickExactText(root: Element, text: string) {
  const match = Array.from(root.querySelectorAll<HTMLElement>('*'))
    .filter(x => matchesLabel(x.textContent, text) && x.getClientRects().length > 0)
    .at(-1);
  if (match === undefined) {
    throw new Error(`找不到 ${text} 选项。`);
  }
  await clickElement(match);
}

async function setLimit(editor: HTMLElement, heading: string, amount: number | 'capacity') {
  const unitsLabels = labelVariants(`${heading} units`);
  const headingElement = Array.from(editor.querySelectorAll('*'))
    .filter(x => matchesLabel(x.textContent, heading))
    .at(-1);
  let mode = headingElement?.parentElement;
  while (mode !== undefined && mode !== null && matchesLabel(mode.textContent, heading)) {
    mode = mode.parentElement;
  }
  if (mode == null || mode === editor) {
    throw new Error(`找不到 ${heading} 设置。`);
  }
  const readAmount = () => {
    const matches = Array.from(editor.querySelectorAll<HTMLInputElement>('input')).filter(input => {
      if (
        input.getClientRects().length === 0 ||
        !input.matches('[type="number"], [type="text"], :not([type])')
      ) {
        return false;
      }
      let row = input.parentElement;
      while (row !== null && row !== editor) {
        const text = normalizeLabel(row.textContent);
        if (
          unitsLabels.some(unitsLabel => text === unitsLabel || text.startsWith(`${unitsLabel} `))
        ) {
          return true;
        }
        row = row.parentElement;
      }
      return false;
    });
    if (matches.length > 1) {
      throw new Error(`${heading} 数量输入框不唯一。`);
    }
    return matches[0];
  };
  if (amount === 'capacity') {
    if (readAmount() !== undefined) {
      await clickExactText(mode, 'capacity');
      await waitForRt(
        () => (readAmount() === undefined ? true : undefined),
        `${heading} 没有切换到容量。`,
      );
    }
    return;
  }
  if (readAmount() === undefined) {
    await clickExactText(mode, 'units');
  }
  const input = await waitForRt(readAmount, `找不到 ${heading} 数量输入框。`);
  changeInputValue(input, String(amount));
  if (Number(input.value) !== amount) {
    throw new Error(`${heading} 数量未写入。`);
  }
}

async function selectMaterial(editor: HTMLElement, ticker: string) {
  const container =
    _$(editor, C.MaterialSelector.container) ?? _$(editor, C.AddressSelector.container);
  const input = container?.querySelector('input');
  if (input == null) {
    throw new Error('找不到 RT 材料选择器。');
  }
  input.focus();
  await sleep(50);
  if (input.value !== '') {
    changeInputValue(input, '');
    await sleep(0);
  }
  changeInputValue(input, ticker);
  const option = await waitForRt(() => {
    const portal = document.getElementById('autosuggest-portal');
    const candidates = [
      ..._$$(editor, C.MaterialSelector.suggestionEntry),
      ...(portal === null
        ? []
        : [
            ..._$$(portal, C.MaterialSelector.suggestionEntry),
            ..._$$(portal, C.AddressSelector.suggestionContent),
          ]),
    ];
    return candidates.find(
      x =>
        x.getClientRects().length > 0 &&
        (_$(x, C.ColoredIcon.label)?.textContent ?? x.textContent)
          ?.trim()
          .toUpperCase()
          .split(/[^A-Z0-9]/)[0] === ticker,
    );
  }, `找不到材料 ${ticker}。`);
  option.click();
  await waitForRt(
    () => (!option.isConnected || option.getClientRects().length === 0 ? true : undefined),
    `未能确认材料 ${ticker} 已选中。`,
  );
}
