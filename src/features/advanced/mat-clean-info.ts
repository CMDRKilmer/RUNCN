import css from '@src/utils/css-utils.module.css';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';

function onTileReady(tile: PrunTile) {
  subscribe($$(tile.anchor, C.FormComponent.containerPassive), async container => {
    const label = await $(container, 'label');
    hideField(container, label, 'MaterialInformation.ticker');
    hideField(container, label, 'MaterialInformation.resource');
  });
}

function hideField(container: HTMLElement, label: HTMLElement, localizedKey: string) {
  const localizedValue = getI18nValue(localizedKey);
  if (label?.textContent === localizedValue) {
    container.classList.add(css.hidden);
  }
}

function init() {
  tiles.observe('MAT', onTileReady);
}

features.add(import.meta.url, init, 'MAT：隐藏"代码"和"自然资源"字段。');
