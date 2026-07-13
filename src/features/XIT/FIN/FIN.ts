import FIN from '@src/features/XIT/FIN/FIN.vue';

xit.add({
  command: ['FIN'],
  name: '财务概览',
  description: '基本财务概览和库存明细。',
  contextItems: () => [
    { cmd: 'XIT FINBS' },
    { cmd: 'XIT FINPR' },
    { cmd: 'XIT FINCH' },
    { cmd: 'XIT HOLD' },
    { cmd: 'XIT SET FIN' },
  ],
  component: () => FIN,
});
