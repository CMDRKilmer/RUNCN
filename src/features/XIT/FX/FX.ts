import FX from '@src/features/XIT/FX/FX.vue';

xit.add({
  command: ['FX', 'FOREX'],
  name: '换汇',
  description: '通过两笔 CMK 合同实现币种互转（BUY CMK + SELL CMK，按序创建并自动填表）。',
  contextItems: () => [{ cmd: 'XIT CONTD' }, { cmd: 'CONTD' }],
  component: () => FX,
  bufferSize: [560, 320],
});
