import { act } from '@src/features/XIT/ACT/act-registry';
import { serializeStorage } from '@src/features/XIT/ACT/actions/utils';
import { fixed0 } from '@src/utils/format';
import { changeInputValue, clickElement, focusElement } from '@src/util';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { watchWhile } from '@src/utils/watch';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { AssertFn } from '@src/features/XIT/ACT/shared-types';

interface Data {
  from: string;
  to: string;
  ticker: string;
  amount: number;
}

const MTRA_TIMEOUT = 1700;
const MTRA_MAX_RETRIES = 3;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MTRA_TIMEOUT')), ms);
    promise.then(
      v => {
        clearTimeout(timer);
        resolve(v);
      },
      e => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function setupMtraBuffer(tile: PrunTile, ticker: string) {
  await clickElement(tile.anchor as HTMLElement);
  window.getSelection()?.removeAllRanges();

  const container = await withTimeout($(tile.anchor, C.MaterialSelector.container), MTRA_TIMEOUT);
  const input = (await withTimeout($(container, 'input'), MTRA_TIMEOUT)) as HTMLInputElement;
  const suggestionsContainer = await withTimeout(
    $(container, C.MaterialSelector.suggestionsContainer),
    MTRA_TIMEOUT,
  );

  let suggestionsList: Element | undefined;
  for (let attempt = 0; attempt < 15; attempt++) {
    await clickElement(input);
    focusElement(input);
    input.focus();
    changeInputValue(input, ticker);
    window.getSelection()?.removeAllRanges();
    await new Promise(r => setTimeout(r, 150));
    suggestionsList = _$(container, C.MaterialSelector.suggestionsList);
    if (suggestionsList) {
      break;
    }
  }
  if (!suggestionsList) {
    throw new Error('MTRA_NO_SUGGESTIONS');
  }

  return { container, input, suggestionsContainer, suggestionsList };
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
    const epsilon = 0.000001;
    const canFitWeight = to.weightCapacity - to.weightLoad - material.weight + epsilon >= 0;
    const canFitVolume = to.volumeCapacity - to.volumeLoad - material.volume + epsilon >= 0;
    if (!canFitWeight || !canFitVolume) {
      log.warning(`${ticker} 未转移（没有空间）`);
      skip();
      return;
    }

    const mtraCommand = `MTRA from-${from.id.substring(0, 8)} to-${to.id.substring(0, 8)}`;

    // 带超时重试的 MTRA 缓冲区设置
    let mtraResult: Awaited<ReturnType<typeof setupMtraBuffer>> | undefined;
    let tile: PrunTile | undefined;
    for (let retry = 0; retry < MTRA_MAX_RETRIES; retry++) {
      tile = await requestTile(mtraCommand);
      if (!tile) {
        return;
      }
      setStatus(
        retry === 0
          ? '正在设置 MTRA 缓冲区...'
          : `正在重试设置 MTRA 缓冲区（${retry + 1}/${MTRA_MAX_RETRIES}）...`,
      );
      try {
        mtraResult = await setupMtraBuffer(tile, ticker);
        break;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : '';
        if (msg === 'MTRA_TIMEOUT' || msg === 'MTRA_NO_SUGGESTIONS') {
          log.warning(`MTRA 缓冲区设置超时，正在重试...（${retry + 1}/${MTRA_MAX_RETRIES}）`);
          continue;
        }
        throw e;
      }
    }

    if (!mtraResult || !tile) {
      fail('MTRA 缓冲区设置超时，已重试 3 次');
      return;
    }

    const { suggestionsContainer, suggestionsList } = mtraResult;

    suggestionsContainer.style.display = 'none';
    const match = _$$(suggestionsList, C.MaterialSelector.suggestionEntry).find(
      x => _$(x, C.ColoredIcon.label)?.textContent === ticker,
    );

    if (!match) {
      suggestionsContainer.style.display = '';
      fail(`在材料选择器中未找到 ${ticker}`);
      return;
    }

    await clickElement(match);
    suggestionsContainer.style.display = '';

    // 数量滑块的刻度（rc-slider-mark-text）在选择材料后异步渲染。clickElement
    // 只 await sleep(0)，刻度可能尚未挂载，此时 _$$(...) 返回空数组，
    // Math.max(...[]) = -Infinity，会把 "-Infinity" 写入数量输入框并提交。
    // 因此带超时重试等待刻度，并过滤掉非有限值（NaN）。
    let sliderNumbers: number[] = [];
    for (let attempt = 0; attempt < 15; attempt++) {
      sliderNumbers = _$$(tile.anchor, 'rc-slider-mark-text')
        .map(x => Number(x.textContent ?? 0))
        .filter(n => Number.isFinite(n));
      if (sliderNumbers.length > 0) {
        break;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    if (sliderNumbers.length === 0) {
      fail(`${ticker} MTRA 数量滑块未加载，无法确定最大可转移量`);
      return;
    }
    const maxAmount = Math.max(...sliderNumbers);
    const allInputs = _$$(tile.anchor, 'input');
    const amountInput = allInputs[1];
    assert(amountInput !== undefined, 'Amount input not found');
    if (amount > maxAmount) {
      const leftover = amount - maxAmount;
      log.warning(
        `${fixed0(leftover)} ${ticker} 未转移 ` +
          `（已转移 ${fixed0(maxAmount)}/${fixed0(amount)}）`,
      );
      if (maxAmount === 0) {
        skip();
        return;
      }
    }
    changeInputValue(amountInput, Math.min(amount, maxAmount).toString());
    window.getSelection()?.removeAllRanges();

    const transferButton = await $(tile.anchor, C.Button.btn);

    await waitAct();
    const destinationAmount = computed(() => {
      const store = storagesStore.getById(data.to);
      return (
        store?.items
          .map(x => x.quantity ?? undefined)
          .filter(x => x !== undefined)
          .find(x => x.material.ticker === ticker)?.amount ?? 0
      );
    });
    const currentAmount = destinationAmount.value;
    await clickElement(transferButton);
    await waitActionFeedback(tile);
    setStatus('等待存储更新...');
    await watchWhile(() => destinationAmount.value === currentAmount);

    complete();
  },
});
