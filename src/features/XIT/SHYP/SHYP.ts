import SHYP from '@src/features/XIT/SHYP/SHYP.vue';

xit.add({
  command: ['SHYP'],
  name: '造船进度',
  description: '追踪船厂所有造船项目的进度、ETA 与材料投入。',
  contextItems: () => [{ cmd: 'XIT FLEET' }, { cmd: 'XIT SHPT' }, { cmd: 'SHY' }],
  component: () => SHYP,
});
