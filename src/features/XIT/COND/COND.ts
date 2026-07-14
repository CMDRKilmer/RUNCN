import COND from '@src/features/XIT/COND/COND.vue';

xit.add({
  command: ['COND'],
  name: '建筑状况',
  description: '预测可维修建筑的状况衰减，提前预警触底时间。',
  contextItems: () => [{ cmd: 'XIT PROD' }, { cmd: 'REP' }, { cmd: 'BBL' }],
  component: () => COND,
});
