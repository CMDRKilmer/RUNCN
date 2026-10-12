import { act } from '@src/features/XIT/ACT/act-registry';
import Edit from '@src/features/XIT/ACT/actions/verify-ship-cargo/Edit.vue';
import { VERIFY_SHIP_CARGO } from '@src/features/XIT/ACT/action-steps/VERIFY_SHIP_CARGO';

act.addAction({
  type: 'Verify Ship Cargo',
  description: data => {
    if (!data.registration) {
      return '--';
    }
    const tickers = Object.keys(data.verifyRemaining ?? {});
    return tickers.length > 0
      ? `验证 ${data.registration} 货舱清空：${tickers.join('、')}`
      : `验证 ${data.registration} 货舱`;
  },
  editComponent: Edit,
  generateSteps: async ctx => {
    const { data, log, fail, emitStep } = ctx;
    const registration = data.registration;
    if (!registration) {
      log.error('未指定飞船注册号');
      fail();
      return;
    }
    emitStep(VERIFY_SHIP_CARGO({ registration, verifyRemaining: data.verifyRemaining }));
  },
});
