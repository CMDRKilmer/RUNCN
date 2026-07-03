import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';
import Passive from '@src/components/forms/Passive.vue';

function onTileReady(tile: PrunTile) {
  const basesText = getI18nValue('CompanyPanel.data.bases');
  subscribe($$(tile.anchor, C.FormComponent.containerPassive), async container => {
    const label = await $(container, 'label');
    if (label.textContent !== basesText) {
      return;
    }
    const bases = await $(container, C.StaticInput.static);
    createFragmentApp(() => (
      <Passive label="Base Count">
        <span>{bases.childElementCount}</span>
      </Passive>
    )).before(container);
  });
}

function init() {
  tiles.observe('CO', onTileReady);
}

features.add(import.meta.url, init, 'CO：添加"基地数量"行。');
