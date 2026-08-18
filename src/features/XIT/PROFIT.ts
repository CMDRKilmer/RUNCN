import PROFIT from '@src/features/XIT/PROFIT.vue';

xit.add({
  command: 'PROFIT',
  name: '配方利润',
  description: '扫描全部产线配方，按 CX 实时价格计算利润率，找出最赚钱的产线。',
  component: () => PROFIT,
});
