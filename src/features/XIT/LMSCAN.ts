import LMSCAN from '@src/features/XIT/LMSCAN.vue';

xit.add({
  command: 'LMSCAN',
  name: 'LM 价差扫描',
  description: '对比本地市场广告与 CX 交易所价格，发现搬运/倒卖机会。',
  component: () => LMSCAN,
});
