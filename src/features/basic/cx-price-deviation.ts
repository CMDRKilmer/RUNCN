import $style from './cx-price-deviation.module.css';
import { cxStore } from '@src/infrastructure/fio/cx';
import { watchEffectWhileNodeAlive } from '@src/utils/watch';
import { fixed01 } from '@src/utils/format';

function onTileReady(tile: PrunTile) {
  const exchange = tile.parameter;
  if (!exchange) {
    return;
  }

  subscribe($$(tile.anchor, 'tr'), async row => {
    if (_$(row, 'td') === undefined) {
      return;
    }

    const label = await $(row, C.ColoredIcon.label);
    const ticker = label.textContent;
    if (!ticker) {
      return;
    }

    const current = await $(row, C.BrokerList.current);
    const change = await $(row, C.BrokerList.change);

    watchEffectWhileNodeAlive(row, () => {
      current.classList.remove($style.priceHigh, $style.priceLow);

      if (!cxStore.fetched) {
        change.textContent = '--(--)';
        return;
      }

      const info = cxStore.prices.get(exchange)?.get(ticker);
      const dev = deviation(info?.PriceAverage, info?.VWAP7D);

      if (dev === undefined) {
        change.textContent = '--(--)';
        return;
      }

      if (dev > 0) {
        current.classList.add($style.priceHigh);
        change.textContent = `▲${formatPercent(dev)}`;
      } else {
        current.classList.add($style.priceLow);
        change.textContent = `▼${formatPercent(dev)}`;
      }
    });
  });
}

function deviation(current?: number | null, average?: number | null) {
  if (current === undefined || current === null) {
    return undefined;
  }
  if (average === undefined || average === null) {
    return undefined;
  }
  if (average === 0) {
    return undefined;
  }
  return (current - average) / average;
}

function formatPercent(d: number) {
  return `${fixed01(d * 100)}%`;
}

function init() {
  tiles.observe('CX', onTileReady);
}

features.add(import.meta.url, init, 'CX：在商品价格旁显示相对 7D 均价的偏离颜色。');
