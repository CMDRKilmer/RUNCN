import IND from './IND.vue';

xit.add({
  command: 'IND',
  name: '产业分析',
  description: '盘点全部自有基地的原料缺口与 CoGC 行业，合并试算新基地的多种原料。',
  bufferSize: [850, 620],
  component: () => IND,
});
