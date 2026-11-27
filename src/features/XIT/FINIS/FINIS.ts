import FINIS from '@src/features/XIT/FINIS/FINIS.vue';

xit.add({
  command: ['FINIS'],
  name: '利润表',
  description: '按科目汇总每期收入与支出，并算出净利润。原生 FINIS 只读，本页是插件自己的口径。',
  contextItems: () => [
    { cmd: 'XIT FIN' },
    { cmd: 'XIT FINBS' },
    { cmd: 'XIT FINPR' },
    { cmd: 'XIT FINCH' },
  ],
  component: () => FINIS,
});
