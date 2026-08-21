import TRIGGER from '@src/features/XIT/TRIGGER/TRIGGER.vue';

xit.add({
  command: ['TRIGGER', 'TRIGGERS'],
  name: '自动触发器',
  description:
    '内置自动化（自动加油/NX 自动补油）与事件触发器（到港/物资告急/生产完成/建筑状况/定时）统一管理。',
  component: () => TRIGGER,
  bufferSize: [820, 420],
});
