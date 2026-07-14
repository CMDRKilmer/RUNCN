import ORDS from '@src/features/XIT/ORDS/ORDS.vue';

xit.add({
  command: ['ORDS'],
  name: '未成交订单',
  description: '汇总展示当前在挂的 CX 与 FX 订单及锁定价值。',
  contextItems: () => [{ cmd: 'XIT CXTS' }, { cmd: 'XIT FXTS' }, { cmd: 'CXOB' }],
  component: () => ORDS,
});
