import { act } from '@src/features/XIT/ACT/act-registry';
import { fixed0, fixed02, fixed02ng } from '@src/utils/format';
import { changeInputValue, clickElement } from '@src/utils/dom';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { exchangesStore } from '@src/infrastructure/prun-api/data/exchanges';
import { warehousesStore } from '@src/infrastructure/prun-api/data/warehouses';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { cxobStore } from '@src/infrastructure/prun-api/data/cxob';
import { isFiniteOrder, getSellLimitPrice } from '@src/core/orders';
import { companyStore } from '@src/infrastructure/prun-api/data/company';
import { watchWhile } from '@src/utils/watch';
import { sleep } from '@src/utils/sleep';
import { AssertFn } from '@src/features/XIT/ACT/shared-types';

interface Data {
  exchange: string;
  ticker: string;
  amount: number;
  /** LIMIT=挂单售卖（压至卖价第 rank 名）；FILL=填单售卖（按买一价立即成交）。 */
  sellMode: 'LIMIT' | 'FILL';
  /** 挂单排名（1=卖价第一名，默认 1）：压过第 rank 名卖价一档。 */
  rank?: number;
  /** 并行组标识：自动模式下同一组的连续步骤并发执行（多窗口并发售卖）。 */
  parallelGroup?: string;
  /** 「跳过不足材料」全局选项：仓库持有量不足时跳过而非失败。 */
  skipMissing?: boolean;
}

interface SellPriceInfo {
  price: number;
  /** 按当前订单簿可立即成交的数量（FILL 模式有意义；MM 单视为无限）。 */
  fillable: number;
  proceeds: number;
}

// 从实时订单簿计算卖出价与可立即成交数量。
function getSellPriceInfo(
  cxTicker: string,
  amount: number,
  sellMode: 'LIMIT' | 'FILL',
  rank = 1,
): SellPriceInfo | undefined {
  const orderBook = cxobStore.getByTicker(cxTicker);
  if (!orderBook) {
    return undefined;
  }

  if (sellMode === 'FILL') {
    const bids = orderBook.buyingOrders.slice().sort((a, b) => b.limit.amount - a.limit.amount);
    const best = bids.at(0);
    if (!best) {
      return undefined;
    }
    const price = best.limit.amount;
    let fillable = 0;
    for (const order of bids) {
      if (order.limit.amount < price) {
        break;
      }
      fillable += isFiniteOrder(order) ? order.amount : Infinity;
    }
    return { price, fillable, proceeds: price * amount };
  }

  // 挂单：压过（排除自己后）第 rank 名卖价一档，成为卖价第 rank 名。
  const asks = orderBook.sellingOrders.slice().sort((a, b) => a.limit.amount - b.limit.amount);
  const price = getSellLimitPrice(asks, rank, companyStore.value?.id);
  if (price === undefined) {
    return undefined;
  }
  return { price, fillable: 0, proceeds: price * amount };
}

function warehouseAmountOf(storage: PrunApi.Store | undefined, ticker: string) {
  return (
    storage?.items
      .map(x => x.quantity ?? undefined)
      .filter(x => x !== undefined)
      .find(x => x.material.ticker === ticker)?.amount ?? 0
  );
}

export const CXPO_SELL = act.addActionStep<Data>({
  type: 'CXPO_SELL',
  preProcessData: data => ({ ...data, ticker: data.ticker.toUpperCase() }),
  description: data => {
    const { ticker, exchange, amount, sellMode } = data;
    const rank = data.rank ?? 1;
    const modeLabel = sellMode === 'FILL' ? '填单卖出' : '挂单卖出';
    const info = getSellPriceInfo(`${ticker}.${exchange}`, amount, sellMode, rank);
    if (!info) {
      return `在 ${exchange} 上${modeLabel} ${fixed0(amount)} ${ticker}（暂无价格数据）`;
    }
    let description =
      sellMode === 'FILL'
        ? `在 ${exchange} 上填单卖出 ${fixed0(amount)} ${ticker}，价格 ${fixed02(info.price)}`
        : `在 ${exchange} 上挂单卖出 ${fixed0(amount)} ${ticker}，压至卖价第 ${rank} 名（${fixed02(info.price)}）`;
    if (sellMode === 'FILL' && info.fillable < amount) {
      description += `（预计入账 ${fixed0(info.proceeds)}，部分将按该价挂单）`;
    } else {
      description += `（预计入账 ${fixed0(info.proceeds)}）`;
    }
    return description;
  },
  execute: async ctx => {
    const { data, log, setStatus, requestTile, waitAct, waitActionFeedback, complete, skip, fail } =
      ctx;
    const assert: AssertFn = ctx.assert;
    const { amount, ticker, exchange, sellMode } = data;
    const cxTicker = `${ticker}.${exchange}`;
    const cxWarehouse = computed(() => {
      const naturalId = exchangesStore.getNaturalIdFromCode(exchange);
      const warehouse = warehousesStore.getByEntityNaturalId(naturalId);
      return storagesStore.getById(warehouse?.storeId);
    });
    assert(cxWarehouse.value, `CX warehouse not found for ${exchange}`);

    if (amount <= 0) {
      log.warning(`${ticker} 未售卖（目标数量为 0）`);
      skip();
      return;
    }

    const material = materialsStore.getByTicker(ticker);
    assert(material, `Unknown material ${ticker}`);

    // 卖出量不能超过 CX 仓库持有量。
    const held = warehouseAmountOf(cxWarehouse.value, ticker);
    if (held < amount) {
      if (data.skipMissing) {
        log.warning(`${ticker} 仓库中只有 ${fixed0(held)}，跳过该操作`);
        skip();
        return;
      }
      fail(`${ticker} 仓库中只有 ${fixed0(held)}，无法卖出 ${fixed0(amount)}`);
      return;
    }

    const tile = await requestTile(`CXPO ${cxTicker}`);
    if (!tile) {
      return;
    }

    setStatus('正在设置 CXPO 缓冲区...');

    const form = await $(tile.anchor, C.ComExPlaceOrderForm.form);
    const inputs = _$$(form, 'input');
    const quantityInput = inputs[0];
    assert(quantityInput !== undefined, 'Missing quantity input');
    const priceInput = inputs[1];
    assert(priceInput !== undefined, 'Missing price input');

    const unwatch = watchEffect(() => {
      const info = getSellPriceInfo(cxTicker, amount, sellMode, data.rank);

      if (!info) {
        // 订单簿数据尚未加载，等待响应式更新后重试。
        setStatus(`等待 ${cxTicker} 订单簿数据加载...`);
        return;
      }

      if (sellMode === 'FILL' && info.fillable < amount) {
        log.warning(
          `${ticker} 买一量不足：${fixed0(info.fillable)} 将立即成交，` +
            `剩余 ${fixed0(amount - info.fillable)} 将按 ${fixed02(info.price)} 挂单`,
        );
      }

      changeInputValue(quantityInput, amount.toString());
      changeInputValue(priceInput, fixed02ng(info.price));

      // 在点击卖出按钮之前缓存描述，因为点击后订单簿数据会发生变化。
      ctx.cacheDescription();
      window.getSelection()?.removeAllRanges();
    });

    await waitAct();
    unwatch();

    const info = getSellPriceInfo(cxTicker, amount, sellMode, data.rank);
    if (!info) {
      fail(`${ticker} 无法确定卖出价格`);
      return;
    }

    // 卖出按钮限定在按钮区内查找，避免误点买入按钮（CXOS 同款定位）。
    const buttonsField = form.children.item(12);
    const sellButton = buttonsField ? _$(buttonsField, C.Button.danger) : undefined;
    assert(sellButton, 'Missing sell button');

    // 点击前核对表单值：订单簿更新会触发游戏重渲染，可能把 React 受控输入框重置
    // （数量/价格变回 0 或空）。以重置后的值提交会产生 0 数量订单，导致该 ticker
    // 的 CXPO 页面无法打开（删除订单才能恢复）。写值后沉降 200ms，核对不符则补写。
    // 价格用无千分位分组格式（fixed02ng）——游戏输入框解析不了 "6,400"。
    const quantityText = amount.toString();
    const priceText = fixed02ng(info.price);
    changeInputValue(quantityInput, quantityText);
    changeInputValue(priceInput, priceText);
    await sleep(200);
    if (quantityInput.value !== quantityText || priceInput.value !== priceText) {
      changeInputValue(quantityInput, quantityText);
      changeInputValue(priceInput, priceText);
      await sleep(200);
    }

    await clickElement(sellButton);
    await waitActionFeedback(tile);

    // 填单模式且确实会成交时等待仓库数量下降；挂单模式货物留在仓库，直接完成。
    if (sellMode === 'FILL' && info.fillable > 0) {
      const currentAmount = warehouseAmountOf(cxWarehouse.value, ticker);
      setStatus('等待存储更新...');
      await watchWhile(() => warehouseAmountOf(cxWarehouse.value, ticker) === currentAmount);
    } else {
      setStatus('卖单已挂出');
    }

    complete();
  },
});
