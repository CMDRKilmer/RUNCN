import { act } from '@src/features/XIT/ACT/act-registry';
import Edit from '@src/features/XIT/ACT/actions/cx-sell/Edit.vue';
import { CXPO_SELL } from '@src/features/XIT/ACT/action-steps/CXPO_SELL';
import { AssertFn } from '@src/features/XIT/ACT/shared-types';

act.addAction({
  type: 'CX Sell',
  description: action => {
    if (!action.ticker || !action.exchange) {
      return '--';
    }
    const modeLabel = action.sellMode === 'FILL' ? '填单卖出' : '挂单卖出';
    return `${modeLabel} ${action.amount ?? 0} ${action.ticker} @ ${action.exchange}`;
  },
  editComponent: Edit,
  generateSteps: async ctx => {
    const { data, emitStep } = ctx;
    const assert: AssertFn = ctx.assert;
    assert(data.ticker, '缺少物品代码');
    assert(data.exchange, '缺少交易所');

    const amount = data.amount ?? 0;
    if (amount <= 0) {
      ctx.log.error(`${data.ticker} 售卖数量为 0`);
      return;
    }

    emitStep(
      CXPO_SELL({
        exchange: data.exchange,
        ticker: data.ticker,
        amount,
        sellMode: data.sellMode ?? 'LIMIT',
        rank: data.rank ?? 1,
        skipMissing: ctx.globalOptions?.skipMissingMaterials,
        parallelGroup: 'cx-sell',
      }),
    );
  },
});
