import PrunButton from '@src/components/PrunButton.vue';
import { shipsStore } from '@src/infrastructure/prun-api/data/ships';
import { getEntityNaturalIdFromAddress } from '@src/infrastructure/prun-api/data/addresses';
import { selectAddress } from '@src/infrastructure/prun-ui/utils/select-address';
import $style from './sfc-exchange-destinations.module.css';

// 四大交易所空间站，按游戏交易所代码（AI1、CI1、IC1、NC1）顺序排列
const exchangeStationIds = ['ANT', 'BEN', 'HRT', 'MOR'];

function onTileReady(tile: PrunTile) {
  // 飞船停靠时地址解析为站点自然 ID（如 "ANT"），所在站的按钮置灰；飞行中无地址，全部可点
  const location = computed(() =>
    getEntityNaturalIdFromAddress(
      shipsStore.getByRegistration(tile.parameter)?.address ?? undefined,
    ),
  );

  subscribe($$(tile.anchor, C.AddressSelector.container), container => {
    createFragmentApp(() => (
      <div class={$style.buttons}>
        {exchangeStationIds.map(naturalId => (
          <PrunButton
            key={naturalId}
            dark
            inline
            disabled={location.value === naturalId}
            class={$style.button}
            onClick={() => selectAddress(container, naturalId)}>
            {naturalId}
          </PrunButton>
        ))}
      </div>
    )).appendTo(container);
  });
}

function init() {
  tiles.observe('SFC', onTileReady);
  applyCssRule('SFC', `.${C.AddressSelector.container}`, $style.container);
  applyCssRule('SFC', `.${C.AddressSelector.input}`, $style.input);
}

features.add(import.meta.url, init, 'SFC：目的地输入框旁添加四大交易所快捷按钮。');
