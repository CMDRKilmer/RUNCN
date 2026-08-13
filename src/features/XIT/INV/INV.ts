import INV from './INV.vue';

xit.add({
  command: 'INV',
  name: '库存列表',
  description: '列出全部库存并提供货舱条与按类型筛选。',
  component: () => INV,
  bufferSize: [620, 400],
});
