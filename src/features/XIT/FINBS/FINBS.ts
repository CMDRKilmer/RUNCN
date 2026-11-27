import FINBS from '@src/features/XIT/FINBS/FINBS.vue';

xit.add({
  command: ['FINBS'],
  name: '资产负债表',
  description: '显示资产和负债的资产负债表。',
  contextItems: () => [
    { cmd: 'XIT FIN' },
    { cmd: 'XIT FINIS' },
    { cmd: 'XIT FINPR' },
    { cmd: 'XIT FINCH' },
    { cmd: 'XIT SET FIN' },
  ],
  component: () => FINBS,
});
