import FTC from './FTC.vue';

xit.add({
  command: ['FTC'],
  name: '飞行计算器',
  description:
    '飞船未起飞时扫描燃料消耗/反应堆使用量组合，按服务器精确飞行计划比较多段路线时长、燃料、损伤与性价比。',
  component: () => FTC,
  bufferSize: [760, 560],
});
