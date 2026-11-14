import FX from '@src/features/XIT/FX/FX.vue';

xit.add({
  command: ['FX', 'FOREX'],
  // 带参数时（`FX NCC`，右下角余额点进来的那种）标题带上方向，方便同时开四块。
  name: parameters => (parameters.length === 0 ? '换汇' : `换汇 ${parameters.join('→')}`),
  description: '通过两笔 CMK 合同实现币种互转（BUY CMK + SELL CMK，按序创建并自动填表）。',
  contextItems: () => [{ cmd: 'XIT CONTD' }, { cmd: 'CONTD' }],
  component: () => FX,
  bufferSize: [560, 320],
});
