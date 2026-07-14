import LMA from '@src/features/XIT/LMA/LMA.vue';

xit.add({
  command: ['LMA'],
  name: '本地广告',
  description: '汇总展示自己在挂的本地市场广告及到期预警。',
  contextItems: () => [{ cmd: 'XIT ORDS' }, { cmd: 'LM' }],
  component: () => LMA,
});
