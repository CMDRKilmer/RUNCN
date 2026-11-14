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
  watchScreensMenuLayout(list);
}

// 「界面」悬浮列表默认一条一行，界面一多就顶出屏幕。改成多列：列宽固定，
// 行数封顶，超出的往右排。列数受视口宽高双重约束，避免右边界出屏。
const MENU_COLUMN_WIDTH = 192;
const MENU_COLUMN_GAP = 10;
const MENU_ROW_HEIGHT = 20;
const MENU_MAX_ROWS = 12;

function layoutScreensMenu(list: HTMLElement) {
  const count = list.children.length;
  const rect = list.getBoundingClientRect();
  // 列表隐藏时（display:none）没有布局信息，等它显示时 ResizeObserver 会再触发。
  if (count === 0 || rect.width < 1 || rect.height < 1) {
    return;
  }
  const availableWidth = window.innerWidth - rect.left - 8 + MENU_COLUMN_GAP;
  const maxColumns = Math.max(
    1,
    Math.floor(availableWidth / (MENU_COLUMN_WIDTH + MENU_COLUMN_GAP)),
  );
  const availableHeight = window.innerHeight - rect.top - 8;
  const targetRows = Math.max(
    1,
    Math.min(MENU_MAX_ROWS, Math.floor(availableHeight / MENU_ROW_HEIGHT)),
  );
  const columns = Math.max(1, Math.min(maxColumns, Math.ceil(count / targetRows)));
  const rows = Math.ceil(count / columns);
  const width = columns * MENU_COLUMN_WIDTH + (columns - 1) * MENU_COLUMN_GAP;
  const height = rows * MENU_ROW_HEIGHT;

  const style = list.style;
  const next = {
    columnCount: String(columns),
    width: `${width}px`,
    height: `${Math.min(height, availableHeight)}px`,
  };
  if (
    style.columnCount === next.columnCount &&
    style.width === next.width &&
    style.height === next.height
  ) {
    return;
  }
  style.columnCount = next.columnCount;
  style.width = next.width;
  style.height = next.height;
}

function watchScreensMenuLayout(list: HTMLElement) {
  watchEffectWhileNodeAlive(list, onCleanup => {
    // 显隐靠 display 切换，尺寸从 0 变成有值时触发重新计算。
    const observer = new ResizeObserver(() => layoutScreensMenu(list));
    observer.observe(list);
    const onResize = () => layoutScreensMenu(list);
    window.addEventListener('resize', onResize);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener('resize', onResize);
    });
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
  applyCssRule(`.${C.Head.container}`, $style.head);
  applyCssRule(`.${C.ScreenControls.container}`, $style.screenControls);
  applyCssRule(`.${C.Head.container} [class*='HeadItem__container']`, $style.headItems);
  applyCssRule(`.${C.ScreenControls.screens}`, $style.screensMenu);
}

features.add(import.meta.url, init, '为用户屏幕添加标签栏。');
