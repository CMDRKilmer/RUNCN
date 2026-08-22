import { act } from '@src/features/XIT/ACT/act-registry';
import Edit from '@src/features/XIT/ACT/actions/depart/Edit.vue';
import { DEPART } from '@src/features/XIT/ACT/action-steps/DEPART';

act.addAction({
  type: 'DEPART',
  description: data => {
    if (!data.registration) {
      return '自动出发';
    }
    return `自动出发 ${data.registration}`;
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
    emitStep(DEPART({ registration }));
  },
});
