import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { getI18nValue } from '@src/infrastructure/prun-ui/i18n';
import Passive from '@src/components/forms/Passive.vue';
import { getPrice } from '@src/infrastructure/fio/cx';
import { fixed0, fixed01, fixed02, formatCurrency } from '@src/utils/format';

function onTileReady(tile: PrunTile) {
  const parameter = tile.parameter;
  const material = materialsStore.getByTicker(parameter);
  const volumeLabelText = getI18nValue('MaterialInformation.label.volume');

  subscribe($$(tile.anchor, C.FormComponent.containerPassive), async container => {
    const label = await $(container, 'label');
    if (label.textContent !== volumeLabelText) {
      return;
    }

    const price = computed(() => {
      const price = getPrice(material?.ticker);
      if (price === undefined) {
        return '--';
      }
      let format = fixed02;
      if (price >= 100) {
        format = fixed0;
      } else if (price >= 10) {
        format = fixed01;
      }

      return formatCurrency(price, format);
    });

    createFragmentApp(() => (
      <Passive label="Refined PrUn Price">
        <span>{price.value}</span>
      </Passive>
    )).after(container);
  });
}

function init() {
  tiles.observe('MAT', onTileReady);
}

features.add(import.meta.url, init, 'MAT：添加"Refined PrUn 价格"行。');
