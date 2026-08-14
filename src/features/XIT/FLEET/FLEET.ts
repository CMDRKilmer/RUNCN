import FLEET from '@src/features/XIT/FLEET/FLEET.vue';

xit.add({
  command: ['FLEET', 'BS', 'STO', 'INV', 'STORAGE'],
  name: '基地管理',
  description: '基地综合管理面板:舰队补给规划、仓储分析、库存总览。',
  component: () => FLEET,
  bufferSize: [800, 500],
});
