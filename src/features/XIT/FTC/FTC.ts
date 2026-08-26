import FTC from './FTC.vue';

xit.add({
  command: ['FTC'],
  name: '飞行计算器',
  description:
    '按飞船实时性能（质量/加速度/船体条件/FTL最大航速）规划自然与网关航线，扫描燃料消耗/反应堆使用量组合，输出最性价比的燃料方案；附星球与网关数据获取导出。',
  component: () => FTC,
  bufferSize: [760, 560],
});
