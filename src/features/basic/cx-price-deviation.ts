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

      // 从 current 列（游戏当前显示的实时价格）获取价格
      const askText = current.textContent;

      const match = askText.match(/^([\d,]+(?:\.\d+)?)/);
      if (!match) {
        change.textContent = '--(--)';
        return;
      }

      const ask = parseFloat(match[1].replace(/,/g, ''));
      if (isNaN(ask)) {
        change.textContent = '--(--)';
        return;
      }

      const vwap7d = cxStore.prices.get(exchange)?.get(ticker)?.VWAP7D;
      if (vwap7d === undefined || vwap7d === null) {
        change.textContent = '--(--)';
        return;
      }

      const dev = deviation(ask, vwap7d);

      if (dev === undefined) {
        change.textContent = '--(--)';
        return;
      }

      if (dev === 0) {
        change.textContent = `${formatPrice(vwap7d)}`;
        return;
      }

      if (dev > 0) {
        current.classList.add($style.priceHigh);
      } else {
        current.classList.add($style.priceLow);
      }
      const arrow = dev > 0 ? '▲' : '▼';
      change.textContent = `${arrow}${formatPercent(dev)} / ${formatPrice(vwap7d)}`;
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

function formatPrice(p: number) {
  return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function init() {
  tiles.observe('CX', onTileReady);
}

features.add(import.meta.url, init, 'CX：在商品价格旁显示相对 7D 均价的偏离颜色。');
