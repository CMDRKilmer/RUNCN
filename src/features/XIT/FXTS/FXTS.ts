import FXTS from '@src/features/XIT/FXTS/FXTS.vue';

xit.add({
  command: ['FXTS'],
  name: '外汇交易记录',
  description: '您的所有外汇交易记录列表。',
  component: () => FXTS,
});
