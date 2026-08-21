import TRIGGER from '@src/features/XIT/TRIGGER/TRIGGER.vue';

xit.add({
  command: ['TRIGGER', 'TRIGGERS'],
  name: '自动触发器',
  description: '监控游戏事件（到港/物资告急/生产完成/建筑状况/定时）并自动执行操作包。',
  component: () => TRIGGER,
  bufferSize: [820, 420],
});
