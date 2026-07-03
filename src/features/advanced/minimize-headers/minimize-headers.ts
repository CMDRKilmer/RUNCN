import MinimizeRow from './MinimizeRow.vue';
import { streamHtmlCollection } from '@src/utils/stream-html-collection';
import { computedTileState } from '@src/store/user-data-tiles';
import { getTileState } from './tile-state';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

const MINIMIZE_ATTR = 'data-rp-minimize-row';

function onTileReady(tile: PrunTile) {
  const isMinimized = computedTileState(getTileState(tile), 'minimizeHeader', true);
  let minimizeRowCreated = false;

  subscribe(streamHtmlCollection(tile.anchor, tile.anchor.children), async child => {
    const header = await $(child, C.FormComponent.containerPassive);
    setHeaders(tile, isMinimized.value);

    if (!minimizeRowCreated) {
      minimizeRowCreated = true;
      createFragmentApp(
        MinimizeRow,
        reactive({
          isMinimized,
          onClick: () => {
            isMinimized.value = !isMinimized.value;
            setHeaders(tile, isMinimized.value);
          },
        }),
      ).before(header);
      const minimizeEl = header.previousElementSibling;
      if (minimizeEl) {
        minimizeEl.setAttribute(MINIMIZE_ATTR, '');
      }
    }
  });
}

function setHeaders(tile: PrunTile, isMinimized: boolean) {
  for (const header of _$$(tile.anchor, C.FormComponent.containerPassive)) {
    if (header.hasAttribute(MINIMIZE_ATTR)) {
      continue;
    }
    const label = _$(header, C.FormComponent.label);
    if (label?.textContent === 'Minimize' || label?.textContent === '最小化') {
      continue;
    }
    if (matchesLocalization(label, 'Contract.termination', 'Termination request')) {
      const value = _$(header, C.FormComponent.input);
      if (value?.textContent !== '--') {
        continue;
      }
    }
    if (matchesLocalization(label, 'Contribution.stores', 'Inventory')) {
      continue;
    }
    header.style.display = isMinimized ? 'none' : 'flex';
  }
}

function matchesLocalization(element: Element | undefined, key: string, defaultValue: string) {
  const text = getI18nValue(key, defaultValue);
  return element?.textContent === text;
}

function init() {
  tiles.observe(['CX', 'CONT', 'LM', 'SYSI', 'POPID'], onTileReady);
}

features.add(import.meta.url, init, '最小化 CX、CONT、LM 和 SYSI 中的标题栏。');
