import DISPATCH from '@src/features/XIT/DISPATCH/DISPATCH.vue';

xit.add({
  command: ['DISPATCH', 'BS', 'STO', 'INV', 'STORAGE'],
  name: 'DISPATCH',
  description: '基地综合管理面板:舰队补给规划、仓储分析、库存总览。',
  component: () => DISPATCH,
  bufferSize: [800, 500],
});