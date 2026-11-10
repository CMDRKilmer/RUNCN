import { act } from '@src/features/XIT/ACT/act-registry';
import Edit from '@src/features/XIT/ACT/actions/cx-buy/Edit.vue';
import { CXPO_BUY } from '@src/features/XIT/ACT/action-steps/CXPO_BUY';
import { fixed0, fixed02 } from '@src/utils/format';
import { fillAmount } from '@src/features/XIT/ACT/actions/cx-buy/utils';
import { AssertFn } from '@src/features/XIT/ACT/shared-types';

act.addAction({
  type: 'CX Buy',
  description: action => {
    if (!action.group || !action.exchange) {
      return '--';
    }

    return '从 ' + action.exchange + ' 购买组 ' + action.group;
  },
  editComponent: Edit,
  generateSteps: async ctx => {
    const { data, state, log, fail, getMaterialGroup, emitStep } = ctx;
    const assert: AssertFn = ctx.assert;
    const allowUnfilled = data.allowUnfilled ?? false;
    const buyPartial = data.buyPartial ?? false;

    const materials = await getMaterialGroup(data.group);
    assert(materials, '无效的材料组');

    const exchange = data.exchange;
    assert(exchange, '缺少交易所');

    // 如果请求了，从 CX 库存中取出材料
    if (data.useCXInv ?? true) {
      const warehouse = state.WAR[exchange];
      for (const [ticker, amount] of Object.entries(materials)) {
        const stock = warehouse[ticker] ?? 0;
        const reserved = data.cxInvReserve?.[ticker] ?? 0;
        const used = Math.min(amount, Math.max(0, stock - reserved));
        warehouse[ticker] = stock - used;
        if (warehouse[ticker] <= 0) {
          delete warehouse[ticker];
        }
        materials[ticker] = amount - used;
        if (materials[ticker] <= 0) {
          delete materials[ticker];
        }
      }
    }

    for (const ticker of Object.keys(materials)) {
      const amount = materials[ticker];
      const priceLimit = data.priceLimits?.[ticker] ?? Infinity;
      if (isNaN(priceLimit)) {
        log.error(ticker + ' 的价格限制不是数字');
        continue;
      }
      // 「允许未满足」会以 priceLimit 为投标价下单，必须有有限的价格限制，
      // 否则会把 fixed02(Infinity) = "∞" 写入价格输入框并提交。
      if (allowUnfilled && !isFinite(priceLimit)) {
        log.error(ticker + ' 启用了「允许未满足」但未设置价格限制，无法确定投标价格');
        continue;
      }

      const cxTicker = `${ticker}.${data.exchange}`;
      const filled = fillAmount(cxTicker, amount, priceLimit);
      let bidAmount = amount;

      if (filled && filled.amount < amount && !allowUnfilled) {
        if (ctx.globalOptions?.skipMissingMaterials) {
          log.warning(`${exchange} 上没有足够的材料购买 ${fixed0(amount)} ${ticker}，执行时将跳过`);
          bidAmount = amount;
        } else if (!buyPartial) {
          let message = `${exchange} 上没有足够的材料购买 ${fixed0(amount)} ${ticker}`;
          if (isFinite(priceLimit)) {
            message += ` with price limit ${fixed02(priceLimit)}/u`;
          }
          fail(message);
          return;
        } else {
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
            continue;
          }

          bidAmount = filled.amount;
        }
      }

      // parallelGroup 让同一动作的连续购买步骤在自动模式下并发执行（多窗口同时购买）
      emitStep(
        CXPO_BUY({
          exchange,
          ticker,
          amount: bidAmount,
          priceLimit: priceLimit,
          buyPartial: buyPartial,
          allowUnfilled: allowUnfilled,
          skipMissing: ctx.globalOptions?.skipMissingMaterials,
          parallelGroup: 'cx-buy',
        }),
      );
    }
  },
});
