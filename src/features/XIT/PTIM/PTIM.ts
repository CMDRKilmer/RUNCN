import PTIM from '@src/features/XIT/PTIM/PTIM.vue';

xit.add({
  command: ['PTIM'],
  name: '生产时间线',
  description: '按完成时间排序展示所有产线订单的产出时间线。',
  contextItems: () => [{ cmd: 'XIT PROD' }, { cmd: 'XIT PWARN' }, { cmd: 'PROD' }],
  component: () => PTIM,
});
