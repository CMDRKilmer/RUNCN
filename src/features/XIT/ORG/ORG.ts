import ORG from '@src/features/XIT/ORG/ORG.vue';

xit.add({
  command: 'ORG',
  name: '组织',
  description: '组织任务管理面板：发布/接取/合同联动/董事会管理。',
  component: () => ORG,
  bufferSize: [800, 600],
});
