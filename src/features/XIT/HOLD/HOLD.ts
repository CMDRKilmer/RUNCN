import HOLD from '@src/features/XIT/HOLD/HOLD.vue';

xit.add({
  command: 'HOLD',
  name: '持股与股息',
  description: '展示公司持股明细与股息收入历史。',
  contextItems: () => [{ cmd: 'XIT FIN' }, { cmd: 'XIT LOAN' }],
  component: () => HOLD,
});
