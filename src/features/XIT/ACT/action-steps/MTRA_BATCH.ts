import { act } from '@src/features/XIT/ACT/act-registry';
import { serializeStorage } from '@src/features/XIT/ACT/actions/utils';
import { fixed0 } from '@src/utils/format';
import { changeInputValue, clickElement } from '@src/utils/dom';
import { materialsStore } from '@src/infrastructure/prun-api/data/materials';
import { storagesStore } from '@src/infrastructure/prun-api/data/storage';
import { watchWhile } from '@src/utils/watch';
import { waitActionFeedback } from '@src/features/XIT/ACT/runner/step-machine';
import { AssertFn } from '@src/features/XIT/ACT/shared-types';
import {
  canFit,
  clampTransferAmount,
  closeMtraWindows,
  getDestAmount,
  MTRA_MAX_RETRIES,
  MtraPreparation,
  MtraWindow,
  openMtraWindow,
  prepareMtraWindow,
} from '@src/features/XIT/ACT/action-steps/mtra-common';

interface Data {
  from: string;
  to: string;
  materials: { ticker: string; amount: number }[];
}

interface PreparedTransfer extends MtraPreparation {
  ticker: string;
  amount: number;
  window: MtraWindow;
}

function aggregate(data: Data, pick: (material: PrunApi.Material) => number) {
  let total = 0;
  for (const m of data.materials) {
    const material = materialsStore.getByTicker(m.ticker);
    if (!material) {
      return undefined;
    }
    total += pick(material) * m.amount;
  }
  return total;
}

function prepErrorText(error: string, ticker: string): string {
  switch (error) {
    case 'MTRA_TIMEOUT':
      return '缓冲区设置超时，已重试 3 次';
    case 'MTRA_NO_SUGGESTIONS':
      return `在材料选择器中未找到 ${ticker}`;
    case 'MTRA_SLIDER_EMPTY':
      return '数量滑块未加载，无法确定最大可转移量';
    case 'MTRA_NO_AMOUNT_INPUT':
      return '未找到数量输入框';
    default:
      return error;
  }
}

export const MTRA_BATCH = act.addActionStep<Data>({
  type: 'MTRA_BATCH',
  preProcessData: data => ({
    ...data,
    materials: data.materials.map(x => ({ ...x, ticker: x.ticker.toUpperCase() })),
  }),
  description: data => {
    const from = storagesStore.getById(data.from);
    const to = storagesStore.getById(data.to);
    const fromName = from ? serializeStorage(from) : 'NOT FOUND';
    const toName = to ? serializeStorage(to) : 'NOT FOUND';
    return `转移组 [${data.materials.length} 项] 从 ${fromName} 到 ${toName}`;
  },
  weight: data => aggregate(data, m => m.weight),
  volume: data => aggregate(data, m => m.volume),
  execute: async ctx => {
    const { data, log, setStatus, waitAct, complete, fail } = ctx;
    const assert: AssertFn = ctx.assert;
    const { from, to, materials } = data;
    const fromStore = storagesStore.getById(from);
    assert(fromStore, 'Origin inventory not found');
    const toStore = storagesStore.getById(to);
    assert(toStore, 'Destination inventory not found');

    // 执行期预筛：未知材料 / 出发仓不存在 / 数量为 0 / 无空间 → 跳过并记录
    const items: { ticker: string; amount: number }[] = [];
    for (const m of materials) {
      const material = materialsStore.getByTicker(m.ticker);
      if (!material) {
        log.warning(`${m.ticker} 未转移（未知材料）`);
        continue;
      }
      if (!fromStore.items.find(x => x.quantity?.material.ticker === m.ticker)) {
        log.warning(`${m.ticker} 未转移（出发点中不存在）`);
        continue;
      }
      if (m.amount <= 0) {
        log.warning(`${m.ticker} 未转移（目标数量为 0）`);
        continue;
      }
      if (!canFit(toStore, material)) {
        log.warning(`${m.ticker} 未转移（没有空间）`);
        continue;
      }
      items.push({ ticker: m.ticker, amount: m.amount });
    }
    if (items.length === 0) {
      log.warning('没有可转移的材料');
      await complete();
      return;
    }
    ctx.cacheDescription();

    const mtraCommand = `MTRA from-${fromStore.id.substring(0, 8)} to-${toStore.id.substring(0, 8)}`;
    const windows: MtraWindow[] = [];
    let completed = 0;
    try {
      // 每个转移目标开一个窗口，全部并行执行
      setStatus(`正在打开 ${items.length} 个 MTRA 窗口...`);
      for (let i = 0; i < items.length; i++) {
        try {
          windows.push(await openMtraWindow(mtraCommand));
        } catch (e: unknown) {
          log.error(`MTRA 窗口打开失败：${e instanceof Error ? e.message : e}`);
          fail('无法打开 MTRA 窗口');
          return;
        }
      }
      if (ctx.isCancelled()) {
        return;
      }

      // 阶段 1：串行准备（游戏一次只能开一个材料选择器 listbox）
      const prepared: PreparedTransfer[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const win = windows[i];
        setStatus(`正在设置 ${item.ticker}（${i + 1}/${items.length}）...`);
        const prep = await prepareMtraWindow(win.tile, item.ticker, retry => {
          log.warning(`MTRA 缓冲区设置超时，正在重试...（${retry + 1}/${MTRA_MAX_RETRIES}）`);
        });
        if (typeof prep === 'string') {
          log.warning(`${item.ticker} 未转移（${prepErrorText(prep, item.ticker)}）`);
          continue;
        }
        const effectiveAmount = clampTransferAmount(item.amount, prep.maxAmount, item.ticker, log);
        if (effectiveAmount === 0) {
          continue;
        }
        changeInputValue(prep.amountInput, effectiveAmount.toString());
        window.getSelection()?.removeAllRanges();
        prepared.push({ ...prep, ticker: item.ticker, amount: effectiveAmount, window: win });
      }
      if (prepared.length === 0) {
        log.warning('没有可转移的材料');
        await complete();
        return;
      }

      // 阶段 2：一次确认后并行提交转移，各自等待反馈与存储更新
      await waitAct(`转移 ${prepared.map(x => `${x.ticker} ${fixed0(x.amount)}`).join('、')}`);
      await Promise.all(
        prepared.map(async p => {
          const destinationAmount = getDestAmount(to, p.ticker);
          const currentAmount = destinationAmount.value;
          await clickElement(p.transferButton);
          const error = await waitActionFeedback(p.window.tile);
          if (error) {
            log.warning(`${p.ticker} 转移失败：${error}`);
            return;
          }
          setStatus('等待存储更新...');
          await watchWhile(() => destinationAmount.value === currentAmount);
          log.success(`已转移 ${fixed0(p.amount)} ${p.ticker}`);
          completed++;
        }),
      );
      setStatus(`已完成 ${completed}/${items.length} 项`);

      if (!ctx.isCancelled()) {
        await complete();
      }
    } finally {
      closeMtraWindows(windows);
    }
  },
});
