import REPD from '@src/features/XIT/REPD/REPD.vue';

xit.add({
  command: ['REPD', 'RDU'],
  name: '维修到期',
  description: '按基地列出维修到期状态、账单与每日等待成本，数据全部取自游戏客户端。',
  bufferSize: [900, 520],
  component: () => REPD,
});
