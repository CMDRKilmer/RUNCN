import { act } from '@src/features/XIT/ACT/act-registry';
import { fixed0, fixed01, fixed02 } from '@src/utils/format';
import { changeInputValue, clickElement } from '@src/util';
import { fillAmount } from '@src/features/XIT/ACT/actions/cx-buy/utils';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { watchWhile } from '@src/utils/watch';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { watchEffect } from 'vue';
import { AssertFn } from '@src/features/XIT/ACT/shared-types';
import { cxStore } from '@src/infrastructure/fio/cx';

interface Data {
  exchange: string;
  ticker: string;
  amount: number;
  priceLimit: number;
  buyPartial: boolean;
  allowUnfilled: boolean;
  skipMissing?: boolean;
}

function getHistoricalComparison(ticker: string, exchange: string): string | undefined {
  if (!cxStore.fetched) {
    return undefined;
  }
  const info = cxStore.prices.get(exchange)?.get(ticker);
  if (!info) {
    return undefined;
  }
  const vwap7D = info.VWAP7D ?? null;
  const vwap30D = info.VWAP30D ?? null;
  if (vwap7D === null && vwap30D === null) {
    return undefined;
  }

  // Calculate the effective price the buy would execute at (priceLimit if set, else best ask).
  const effective = info.Ask ?? null;
  const deviation7D = computeDeviation(effective, vwap7D);
  const deviation30D = computeDeviation(effective, vwap30D);

  const parts: string[] = [];
  if (vwap7D !== null) {
    parts.push(`7D均价 ${fixed02(vwap7D)}${deviation7D ? ` (${deviation7D})` : ''}`);
  }
  if (vwap30D !== null) {
    parts.push(`30D均价 ${fixed02(vwap30D)}${deviation30D ? ` (${deviation30D})` : ''}`);
  }
  return parts.join(' | ');
}

function computeDeviation(current: number | null, average: number | null) {
  if (current === null || average === null) {
    return undefined;
  }
  if (average === 0) {
    return undefined;
  }
  const d = (current - average) / average;
  if (Math.abs(d) < 0.0005) {
    return undefined;
  }
  const sign = d > 0 ? '+' : '';
  return `${sign}${fixed01(d * 100)}%`;
}

export const CXPO_BUY = act.addActionStep<Data>({
  type: 'CXPO_BUY',
  preProcessData: data => ({ ...data, ticker: data.ticker.toUpperCase() }),
  description: data => {
    const { ticker, exchange } = data;
    const cxTicker = `${ticker}.${exchange}`;
    const filled = fillAmount(cxTicker, data.amount, data.priceLimit);
    const amount = filled?.amount ?? data.amount;
    const priceLimit = filled?.priceLimit ?? data.priceLimit;
    const allowUnfilled = data.allowUnfilled ?? false;
    const willFillCompletely = filled && filled.amount === data.amount;

    if (!willFillCompletely && allowUnfilled) {
      let description = `在 ${exchange} 上投标 ${fixed0(data.amount)} ${ticker}`;
      if (isFinite(priceLimit)) {
        description += `，价格 ${fixed02(data.priceLimit)}`;
        description += `（总费用 ${fixed0(data.amount * data.priceLimit)}）`;
      }
      const comparison = getHistoricalComparison(ticker, exchange);
      if (comparison) {
        description += ` [${comparison}]`;
      }
      return description;
    }

    let description = `在 ${exchange} 上购买 ${fixed0(amount)} ${ticker}`;
    if (isFinite(priceLimit)) {
      description += `，价格限制 ${fixed02(priceLimit)}`;
    }
    if (filled) {
      description += `（总费用 ${fixed0(filled.cost)}）`;
    } else {
      description += '（暂无价格数据）';
    }
    const comparison = getHistoricalComparison(ticker, exchange);
    if (comparison) {
      description += ` [${comparison}]`;
    }
    return description;
  },
  cost: data => {
    const cxTicker = `${data.ticker}.${data.exchange}`;
    return fillAmount(cxTicker, data.amount, data.priceLimit)?.cost;
  },
  weight: data => {
    const material = materialsStore.getByTicker(data.ticker);
    return material ? material.weight * data.amount : undefined;
  },
  volume: data => {
    const material = materialsStore.getByTicker(data.ticker);
    return material ? material.volume * data.amount : undefined;
  },
  execute: async ctx => {
    const { data, log, setStatus, requestTile, waitAct, waitActionFeedback, complete, skip, fail } =
      ctx;
    const assert: AssertFn = ctx.assert;
    const { amount, ticker, exchange, priceLimit } = data;
    const cxTicker = `${ticker}.${exchange}`;
    const cxWarehouse = computed(() => {
      const naturalId = exchangesStore.getNaturalIdFromCode(exchange);
      const warehouse = warehousesStore.getByEntityNaturalId(naturalId);
      return storagesStore.getById(warehouse?.storeId);
    });
    assert(cxWarehouse.value, `CX warehouse not found for ${exchange}`);

    if (amount <= 0) {
      log.warning(`${ticker} 未购买（目标数量为 0）`);
      skip();
      return;
    }

    const material = materialsStore.getByTicker(ticker);
    assert(material, `Unknown material ${ticker}`);

    const canFitWeight =
      material.weight * amount <= cxWarehouse.value.weightCapacity - cxWarehouse.value.weightLoad;
    const canFitVolume =
      material.volume * amount <= cxWarehouse.value.volumeCapacity - cxWarehouse.value.volumeLoad;
    assert(
      canFitWeight && canFitVolume,
      `Cannot not buy ${fixed0(amount)} ${ticker} (will not fit in the warehouse)`,
    );

    const tile = await requestTile(`CXPO ${cxTicker}`);
    if (!tile) {
      return;
    }

    setStatus('正在设置 CXPO 缓冲区...');

    const buyButton = await $(tile.anchor, C.Button.success);
    const form = await $(tile.anchor, C.ComExPlaceOrderForm.form);
    const inputs = _$$(form, 'input');
    const quantityInput = inputs[0];
    assert(quantityInput !== undefined, 'Missing quantity input');
    const priceInput = inputs[1];
    assert(priceInput !== undefined, 'Missing price input');

    let shouldUnwatch = false;
    const unwatch = watchEffect(() => {
      if (shouldUnwatch) {
        unwatch();
        return;
      }

      const filled = fillAmount(cxTicker, amount, priceLimit);

      if (!filled) {
        // 订单簿数据尚未加载，等待响应式更新后重试。
        setStatus(`等待 ${cxTicker} 订单簿数据加载...`);
        return;
      }

      if (filled.amount < amount && !data.allowUnfilled) {
        if (data.skipMissing) {
          log.warning(`${exchange} 上没有足够的材料购买 ${fixed0(amount)} ${ticker}，跳过该操作`);
          shouldUnwatch = true;
          skip();
          return;
        }
        if (!data.buyPartial) {
          let message = `${exchange} 上没有足够的材料购买 ${fixed0(amount)} ${ticker}`;
          if (isFinite(priceLimit)) {
            message += ` with price limit ${fixed02(priceLimit)}/u`;
          }
          shouldUnwatch = true;
          fail(message);
          return;
        }

        const leftover = amount - filled.amount;
        let message =
          `${fixed0(leftover)} ${ticker} 将不会在 ${exchange} 上购买 ` +
          `（${fixed0(filled.amount)}/${fixed0(amount)} 可用`;
        if (isFinite(priceLimit)) {
          message += ` with price limit ${fixed02(priceLimit)}/u`;
        }
        message += ')';
        log.warning(message);
        if (filled.amount === 0) {
          shouldUnwatch = true;
          skip();
          return;
        }
      }

      if (data.allowUnfilled) {
        changeInputValue(quantityInput, data.amount.toString());
        changeInputValue(priceInput, fixed02(data.priceLimit));
      } else {
        changeInputValue(quantityInput, filled.amount.toString());
        changeInputValue(priceInput, fixed02(filled.priceLimit));
      }

      // 在点击买入按钮之前缓存描述，因为
      // 点击后订单簿数据会发生变化。
      ctx.cacheDescription();
      window.getSelection()?.removeAllRanges();
    });

    await waitAct();
    unwatch();

    const warehouseAmount = computed(() => {
      return (
        cxWarehouse.value?.items
          .map(x => x.quantity ?? undefined)
          .filter(x => x !== undefined)
          .find(x => x.material.ticker === ticker)?.amount ?? 0
      );
    });
    const currentAmount = warehouseAmount.value;
    const amountToFill = fillAmount(cxTicker, amount, priceLimit)?.amount ?? 0;
    const shouldWaitForUpdate = amountToFill > 0;

    await clickElement(buyButton);
    await waitActionFeedback(tile);

    if (shouldWaitForUpdate) {
      setStatus('等待存储更新...');
      await watchWhile(() => warehouseAmount.value === currentAmount);
    } else {
      setStatus('买单已创建');
    }

    complete();
  },
});
