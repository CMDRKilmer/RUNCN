import $style from './screen-tab-bar.module.css';
import TabBar from './TabBar.vue';
import { userData } from '@src/store/user-data';
import removeArrayElement from '@src/utils/remove-array-element';
import { watchEffectWhileNodeAlive } from '@src/utils/watch';
import { syncState } from '@src/features/basic/screen-tab-bar/sync';

function onListReady(list: HTMLElement) {
  subscribe($$(list, C.ScreenControls.screen), onScreenItemReady);
  watchEffect(() => {
    syncState();
    sortScreenList(list);
  });
}

function sortScreenList(list: HTMLElement) {
  const screens = _$$(list, C.ScreenControls.screen).map(screen => {
    const name = _$(screen, C.ScreenControls.name) as HTMLAnchorElement;
    const id = extractScreenId(name.href);
    const index = id ? userData.tabs.order.indexOf(id) : -1;
    return {
      el: screen,
      index,
    };
  });
  screens.sort((a, b) => a.index - b.index);
  for (const screen of screens) {
    list.appendChild(screen.el);
  }
  const undo = _$(list, C.ScreenControls.undo);
  if (undo) {
    list.appendChild(undo);
  }
}

async function onScreenItemReady(item: HTMLElement) {
  const name = (await $(item, C.ScreenControls.name)) as HTMLAnchorElement;
  const id = extractScreenId(name.href)!;
  if (id === undefined) {
    return;
  }
  const copy = await $(item, C.ScreenControls.copy);
  const hidden = computed(() => userData.tabs.hidden.includes(id));

  watchEffectWhileNodeAlive(name, () => {
    if (hidden.value) {
      name.classList.add($style.hiddenName);
    } else {
      name.classList.remove($style.hiddenName);
    }
  });

  function onClick(e: Event) {
    if (hidden.value) {
      removeArrayElement(userData.tabs.hidden, id);
    } else {
      userData.tabs.hidden.push(id);
    }
    e.stopPropagation();
    e.preventDefault();
  }

  // 与 BLU「隐藏」/ FLT「产出装船」统一：文字恒为「隐藏」，状态靠
  // aria-pressed + data-rp-selected（反色实底）表达，不再写 hide / shw。
  // 原本是 div 而非 button，补 role/aria-label 让状态对读屏软件可感知。
  createFragmentApp(() => (
    <div
      data-rp-ui="screen-hide-toggle"
      data-rp-selected={hidden.value ? 'on' : 'off'}
      role="button"
      aria-label="在标签栏隐藏此屏幕"
      aria-pressed={hidden.value}
      class={[C.ScreenControls.delete, C.type.typeSmall, $style.hideButton]}
      onClick={onClick}>
      隐藏
    </div>
  )).before(copy);
}

function extractScreenId(url?: string) {
  return url?.match(/screen=([\w-]+)/)?.[1] ?? undefined;
}

function init() {
  subscribe($$(document, C.ScreenControls.container), container => {
    createFragmentApp(TabBar).appendTo(container);
  });
  subscribe($$(document, C.ScreenControls.screens), onListReady);
  applyCssRule(`.${C.Head.contextAndScreens}`, $style.contextAndScreens);
  applyCssRule(`.${C.ScreenControls.container}`, $style.screenControls);
}

features.add(import.meta.url, init, '为用户屏幕添加标签栏。');
