import { act } from '@src/features/XIT/ACT/act-registry';
import { serializeStorage } from '@src/features/XIT/ACT/actions/utils';
import { fixed0 } from '@src/utils/format';
import { changeInputValue, clickElement } from '@src/utils/dom';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { watchWhile } from '@src/utils/watch';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { AssertFn } from '@src/features/XIT/ACT/shared-types';
import {
  canFit,
  clampTransferAmount,
  getDestAmount,
  MTRA_MAX_RETRIES,
  prepareMtraWindow,
} from '@src/features/XIT/ACT/action-steps/mtra-common';

interface Data {
  from: string;
  to: string;
  ticker: string;
  amount: number;
}

export const MTRA_TRANSFER = act.addActionStep<Data>({
  type: 'MTRA_TRANSFER',
  preProcessData: data => ({ ...data, ticker: data.ticker.toUpperCase() }),
  description: data => {
    const from = storagesStore.getById(data.from);
    const to = storagesStore.getById(data.to);
    const fromName = from ? serializeStorage(from) : 'NOT FOUND';
    const toName = to ? serializeStorage(to) : 'NOT FOUND';
    return `从 ${fromName} 转移 ${fixed0(data.amount)} ${data.ticker} 到 ${toName}`;
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
    const { ticker, amount } = data;
    const from = storagesStore.getById(data.from);
    assert(from, 'Origin inventory not found');
    const to = storagesStore.getById(data.to);
    assert(to, 'Destination inventory not found');

    if (!from.items.find(x => x.quantity?.material.ticker === ticker)) {
      log.warning(`${ticker} 未转移（出发点中不存在）`);
      skip();
      return;
    }

    if (amount <= 0) {
      log.warning(`${ticker} 未转移（目标数量为 0）`);
      skip();
      return;
    }

    const material = materialsStore.getByTicker(ticker);
    assert(material, `Unknown material ${ticker}`);

    // 检查是否能容纳一个单位。否则 MTRA 将无法使用。
    if (!canFit(to, material)) {
      log.warning(`${ticker} 未转移（没有空间）`);
      skip();
      return;
    }

    const mtraCommand = `MTRA from-${from.id.substring(0, 8)} to-${to.id.substring(0, 8)}`;

    // 带超时重试的 MTRA 缓冲区设置
    const tile = await requestTile(mtraCommand);
    if (!tile) {
      return;
    }
    setStatus('正在设置 MTRA 缓冲区...');
    const prep = await prepareMtraWindow(tile, ticker, retry => {
      log.warning(`MTRA 缓冲区设置超时，正在重试...（${retry + 1}/${MTRA_MAX_RETRIES}）`);
      setStatus(`正在重试设置 MTRA 缓冲区（${retry + 1}/${MTRA_MAX_RETRIES}）...`);
    });
    if (prep === 'MTRA_TIMEOUT') {
      fail('MTRA 缓冲区设置超时，已重试 3 次');
      return;
    }
    if (prep === 'MTRA_NO_SUGGESTIONS') {
      fail(`在材料选择器中未找到 ${ticker}`);
      return;
    }
    if (prep === 'MTRA_SLIDER_EMPTY') {
      fail(`${ticker} MTRA 数量滑块未加载，无法确定最大可转移量`);
      return;
    }
    if (prep === 'MTRA_NO_AMOUNT_INPUT') {
      fail('Amount input not found');
      return;
    }

    const effectiveAmount = clampTransferAmount(amount, prep.maxAmount, ticker, log);
    if (effectiveAmount === 0) {
      skip();
      return;
    }
    changeInputValue(prep.amountInput, effectiveAmount.toString());
    window.getSelection()?.removeAllRanges();

    const transferButton = prep.transferButton;

    await waitAct();
    const destinationAmount = getDestAmount(data.to, ticker);
    const currentAmount = destinationAmount.value;
    await clickElement(transferButton);
    await waitActionFeedback(tile);
    setStatus('等待存储更新...');
    await watchWhile(() => destinationAmount.value === currentAmount);

    complete();
  },
});
