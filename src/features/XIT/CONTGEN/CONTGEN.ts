import CONTGEN from '@src/features/XIT/CONTGEN/CONTGEN.vue';

xit.add({
  command: ['CONTGEN', 'CGEN'],
  name: '合同 JSON 生成器',
  description: '通过表单填写合同条件，生成可粘贴到 CONTD 自动填充面板的 JSON。',
  contextItems: () => [{ cmd: 'XIT CONTD' }, { cmd: 'CONTD' }],
  component: () => CONTGEN,
  bufferSize: [700, 600],
});
