import $style from './screen-layout-lock.module.css';
import { userData } from '@src/store/user-data';
import removeArrayElement from '@src/utils/remove-array-element';
import { watchEffectWhileNodeAlive } from '@src/utils/watch';
import { screensStore } from '@src/infrastructure/prun-api/data/screens';

function onListReady(list: HTMLElement) {
  subscribe($$(list, C.ScreenControls.screen), onScreenItemReady);
}

async function onScreenItemReady(item: HTMLElement) {
  const name = (await $(item, C.ScreenControls.name)) as HTMLAnchorElement;
  const id = extractScreenId(name.href)!;
  if (id === undefined) {
    return;
  }
  const copy = await $(item, C.ScreenControls.copy);
  const locked = computed(() => userData.tabs.locked.includes(id));

  function onClick(e: Event) {
    if (locked.value) {
      removeArrayElement(userData.tabs.locked, id);
    } else {
      userData.tabs.locked.push(id);
    }
    e.stopPropagation();
    e.preventDefault();
  }

  // 与 BLU「隐藏」/ FLT「产出装船」统一：文字恒为「锁定」，状态靠
  // aria-pressed + data-rp-selected（反色实底）表达，不再写 lock / unlk。
  // 原本是 div 而非 button，补 role/aria-label 让状态对读屏软件可感知。
  createFragmentApp(() => (
    <div
      data-rp-ui="screen-lock-toggle"
      data-rp-selected={locked.value ? 'on' : 'off'}
      role="button"
      aria-label="锁定屏幕布局"
      aria-pressed={locked.value}
      class={[C.ScreenControls.delete, C.type.typeSmall, $style.lockButton]}
      onClick={onClick}>
      锁定
    </div>
  )).before(copy);
}

function extractScreenId(url?: string) {
  return url?.match(/screen=([\w-]+)/)?.[1] ?? undefined;
}

function onFrameReady(frame: HTMLElement) {
  watchEffectWhileNodeAlive(frame, () => {
    frame.classList.toggle(
      $style.lockedScreen,
      userData.tabs.locked.includes(screensStore.current.value?.id ?? ''),
    );
  });
}

const tileControlsSymbols = ['–', '|', 'x', ':'];

async function onControlsReady(controls: HTMLElement) {
  subscribe($$(controls, C.TileControls.control), control => {
    if (tileControlsSymbols.includes(control.textContent!)) {
      control.classList.add($style.tileControl);
    }
  });
}

function init() {
  subscribe($$(document, C.ScreenControls.screens), onListReady);
  subscribe($$(document, C.Frame.main), onFrameReady);
  subscribe($$(document, C.TileControls.controls), onControlsReady);
  applyCssRule(`.${C.TileDivider.handle}`, $style.handle);
}

features.add(import.meta.url, init, '添加屏幕锁定功能。');
